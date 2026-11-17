import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {Customer} from './models.js';
import {Account, GoogleTicket, LoginCode, Plan, Enrollment, Payment} from './savings-models.js';
import {paytmConfig, parsePaise, initiatePaytm, verifiedPaytmStatus, verifyCallback} from './paytm.js';

import {googleConfig, googleLoginRouter} from './google-auth.js';

const text = (value, n) => typeof value === 'string' ? value.trim().slice(0, n) : '';
const fail = (res, code, error) => res.status(code).json({error});
const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(err => {
  if (err.code === 11000) return fail(res, 409, 'This record already exists. Refresh and try again.');
  if (err.name === 'CastError') return fail(res, 400, 'Invalid identifier');
  next(err);
});
const emailOf = value => text(value, 255).toLowerCase();
const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digestCode = (email, code) => crypto.createHmac('sha256', process.env.JWT_SECRET)
  .update(`savings-login:${email}:${code}`).digest('hex');
const monthOf = date => new Date(date.getTime() + 330 * 60000).toISOString().slice(0, 7);
const monthValid = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const isValidId = mongoose.isObjectIdOrHexString;
const orderId = () => 'KJ_' + crypto.randomBytes(16).toString('hex');
const paymentFilter = (enrollment, installment) => ({enrollment: enrollment._id, installment});
const checkoutFields = (config, payment, token) => {
  const {mid} = config;
  const {orderId} = payment;
  const query = new URLSearchParams({mid, orderId});
  return {url: config.host + '/theia/api/v1/showPaymentPage?' + query, fields: {mid, orderId, txnToken: token}};
};

function customerAuth(req, res, next) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  try {
    const session = jwt.verify(token, process.env.JWT_SECRET, {algorithms: ['HS256'], audience: 'kj-savings'});
    if (session.role !== 'customer' || !isValidId(session.sub)) return fail(res, 401, 'Sign in again');
    req.accountId = session.sub;
    next();
  } catch {
    return fail(res, 401, 'Sign in again');
  }
}

const sessionFor = account => jwt.sign({sub: account.id, role: 'customer'}, process.env.JWT_SECRET,
  {expiresIn: '4h', algorithm: 'HS256', audience: 'kj-savings'});

async function addToCustomerDirectory(account) {
  const now = new Date();
  const values = {savingsAccount: account._id, emailVerifiedAt: now, lastPortalLoginAt: now};
  if (account.googleLinkedAt) values.googleLinkedAt = account.googleLinkedAt;
  const alreadyLinked = await Customer.findOneAndUpdate({savingsAccount: account._id}, {$set: values});
  if (alreadyLinked) return;
  const existing = await Customer.findOneAndUpdate(
    {email: account.email, savingsAccount: null}, {$set: values}, {sort: {createdAt: 1}}
  );
  if (existing) return;
  await Customer.updateOne({savingsAccount: account._id}, {
    $set: values,
    $setOnInsert: {email: account.email, name: account.name, phone: '', source: 'online', visitedAt: now}
  }, {upsert: true});
}

function installmentMonth(enrollment, installment) {
  const [year, month] = enrollment.startMonth.split('-').map(Number);
  return new Date(Date.UTC(year, month + installment - 2, 1)).toISOString().slice(0, 7);
}

function customerPayments(rows) {
  return rows.map(({_id, enrollment, installment, amountPaise, channel, status, paidAt, createdAt, reference}) => ({
    _id, enrollment, installment, amountPaise, channel, status, paidAt, createdAt, reference
  }));
}

async function reconcile(config, payment) {
  if (!payment || payment.status !== 'pending') return payment;
  const result = await verifiedPaytmStatus(config, payment);
  const filter = {_id: payment._id, orderId: payment.orderId, status: 'pending'};
  if (result.status === 'TXN_SUCCESS') {
    const gatewayDate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(result.txnDate || '')
      ? new Date(result.txnDate.replace(' ', 'T') + '+05:30') : null;
    const paidAt = gatewayDate && !Number.isNaN(+gatewayDate) ? gatewayDate : new Date();
    await Payment.updateOne(filter, {
      $set: {status: 'paid', gatewayTxn: result.txnId, paidAt, paidMonth: monthOf(paidAt)},
      $unset: {checkoutToken: 1}
    });
  } else if ((result.status === 'TXN_FAILURE' && !['334', '335', '501'].includes(String(result.code))) ||
      (result.status === 'NO_RECORD_FOUND' && Date.now() - +payment.startedAt > 60 * 60000)) {
    await Payment.updateOne(filter, {$set: {status: 'failed'}, $unset: {checkoutToken: 1}});
  }
  return Payment.findById(payment._id).select('+checkoutToken').lean();
}

async function nextInstallment(enrollment) {
  const paid = new Set(await Payment.find({enrollment: enrollment._id, status: 'paid'}).distinct('installment'));
  for (let installment = 1; installment <= enrollment.months; installment++) {
    if (!paid.has(installment)) return installment;
  }
  return null;
}

export function savingsRouter({adminAuth, mailTransport, frontendOrigin}) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const codeLimit = rateLimit({windowMs: 15 * 60000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false});
  router.get('/login/options', (req, res) => res.json({google: Boolean(googleConfig())}));
  router.use('/login/google', googleLoginRouter({
    frontendOrigin, limit: codeLimit,
    async issueTicket(profile, digest, challenge) {
      const email = emailOf(profile.email);
      if (!emailValid.test(email) || email.length > 254) return false;
      const authoritative = email.endsWith('@gmail.com') ||
        (typeof profile.hd === 'string' && profile.hd.toLowerCase() === email.split('@')[1]);
      if (!authoritative && !await Account.exists({googleSubject: profile.sub})) return false;
      await GoogleTicket.create({digest, challenge, subject: profile.sub, email, authoritative,
        name: text(profile.name, 120) || email.split('@')[0].slice(0, 120), expiresAt: new Date(Date.now() + 5 * 60000)});
      return true;
    },
    async redeemTicket(digest, challenge) {
      const ticket = await GoogleTicket.findOneAndDelete({digest, challenge, expiresAt: {$gt: new Date()}});
      if (!ticket) return null;
      const now = new Date();
      let account = await Account.findOneAndUpdate({googleSubject: ticket.subject}, {$set: {lastLoginAt: now}}, {new: true});
      if (!account && ticket.authoritative) {
        try {
          account = await Account.findOneAndUpdate({email: ticket.email, googleSubject: {$exists: false}}, {
            $set: {lastLoginAt: now, googleLinkedAt: now, googleSubject: ticket.subject},
            $setOnInsert: {email: ticket.email, name: ticket.name}
          }, {new: true, upsert: true});
        } catch (err) {
          if (err.code !== 11000) throw err;
          account = await Account.findOne({googleSubject: ticket.subject});
        }
      }
      if (!account) return null;
      await addToCustomerDirectory(account);
      return sessionFor(account);
    }
  }));
  router.get('/availability', (req, res) => res.json({paytm: Boolean(paytmConfig())}));
  router.post('/login/request', codeLimit, route(async (req, res) => {
    const email = emailOf(req.body?.email);
    const name = text(req.body?.name, 120);
    if (!emailValid.test(email) || email.length > 254) return fail(res, 400, 'Enter a valid email address');
    let transport;
    try { transport = mailTransport(); } catch { return fail(res, 503, 'Email sign-in is not configured'); }
    const now = new Date();
    const code = String(crypto.randomInt(100000, 1000000));
    const digest = digestCode(email, code);
    try {
      await LoginCode.findOneAndUpdate(
        {email, $or: [{updatedAt: {$lte: new Date(Date.now() - 60000)}}, {updatedAt: {$exists: false}}]},
        {$set: {email, name, digest, attempts: 5, expiresAt: new Date(+now + 10 * 60000)}},
        {upsert: true}
      );
    } catch (err) {
      if (err.code === 11000) return fail(res, 429, 'Wait one minute before requesting another code');
      throw err;
    }
    try {
      await transport.sendMail({
        from: process.env.SMTP_FROM, to: email,
        subject: 'Your Karthik Jewellers sign-in code',
        text: `Your sign-in code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`
      });
    } catch {
      await LoginCode.deleteOne({email, digest});
      return fail(res, 503, 'Could not send the sign-in code. Please try again later.');
    }
    res.json({message: 'Check your email for a six-digit code.'});
  }));

  router.post('/login/verify', codeLimit, route(async (req, res) => {
    const email = emailOf(req.body?.email);
    const code = text(req.body?.code, 6);
    if (!emailValid.test(email) || !/^\d{6}$/.test(code) || req.body.code.trim().length !== 6) {
      return fail(res, 400, 'Enter the email address and six-digit code');
    }
    const filter = {email, expiresAt: {$gt: new Date()}, attempts: {$gt: 0}};
    const challenge = await LoginCode.findOneAndDelete({...filter, digest: digestCode(email, code)});
    if (!challenge) {
      await LoginCode.updateOne(filter, {$inc: {attempts: -1}});
      return fail(res, 401, 'The code is invalid, expired, or has no attempts left');
    }
    const account = await Account.findOneAndUpdate({email}, {
      $set: {lastLoginAt: new Date()},
      $setOnInsert: {name: challenge.name || email.split('@')[0].slice(0, 120), email}
    }, {new: true, upsert: true});
    await addToCustomerDirectory(account);
    res.json({token: sessionFor(account)});
  }));

  router.put('/account/profile', customerAuth, route(async (req, res) => {
    const {name: inputName, phone: inputPhone, marketingConsent} = req.body || {};
    const name = text(inputName, 120);
    const phone = typeof inputPhone === 'string' ? inputPhone.trim().replace(/[ ()-]/g, '') : null;
    if (!name || phone === null || (phone && !/^\+?[0-9]{7,15}$/.test(phone)) || typeof marketingConsent !== 'boolean') {
      return fail(res, 400, 'Enter a name and a valid optional phone number');
    }
    const customer = await Customer.findOne({savingsAccount: req.accountId});
    if (!customer) return fail(res, 401, 'Sign in again');
    if (phone !== customer.phone) customer.whatsappConsent = false;
    if (marketingConsent && (!customer.marketingConsent || customer.unsubscribed || !customer.unsubscribeToken)) {
      customer.unsubscribeToken ||= crypto.randomBytes(24).toString('hex');
      customer.emailMarketingOptInAt = new Date();
      customer.unsubscribed = false;
    }
    customer.set({name, phone, marketingConsent});
    await customer.save();
    const account = await Account.findByIdAndUpdate(req.accountId, {$set: {name}});
    if (!account) return fail(res, 401, 'Sign in again');
    res.json({name, phone, marketingConsent});
  }));

  router.get('/account', customerAuth, route(async (req, res) => {
    const account = await Account.findById(req.accountId).select('name email').lean();
    if (!account) return fail(res, 401, 'Sign in again');
    const contact = await Customer.findOne({savingsAccount: req.accountId}).select('name phone marketingConsent unsubscribed').lean();
    if (contact) {
      account.name = contact.name || account.name;
      account.phone = contact.phone || '';
      account.marketingConsent = Boolean(contact.marketingConsent && !contact.unsubscribed);
    }
    const [plans, enrollments] = await Promise.all([
      Plan.find({active: true}).sort({createdAt: -1}).lean(),
      Enrollment.find({account: req.accountId}).sort({createdAt: -1}).lean()
    ]);
    const payments = await Payment.find({enrollment: {$in: enrollments.map(e => e._id)}})
      .sort({createdAt: -1}).lean();
    const todayMonth = monthOf(new Date());
    const data = enrollments.map(e => {
      const paid = new Set(payments.filter(p => String(p.enrollment) === String(e._id) && p.status === 'paid').map(p => p.installment));
      let next = 1;
      while (next <= e.months && paid.has(next)) next++;
      return {...e, paidCount: paid.size, nextInstallment: next <= e.months ? next : null,
        dueMonth: next <= e.months ? installmentMonth(e, next) : null};
    });
    res.json({account, plans, enrollments: data, payments: customerPayments(payments),
      paytm: Boolean(paytmConfig()), todayMonth});
  }));

  router.post('/enrollments', customerAuth, route(async (req, res) => {
    const plan = await Plan.findOne({_id: req.body?.planId, active: true}).lean();
    if (!plan) return fail(res, 404, 'This plan is unavailable');
    const enrollment = await Enrollment.findOneAndUpdate({account: req.accountId, plan: plan._id}, {
      $setOnInsert: {name: plan.name, amountPaise: plan.amountPaise, months: plan.months,
        bonusMonths: plan.bonusMonths, startMonth: monthOf(new Date())}
    }, {new: true, upsert: true});
    res.status(201).json({_id: enrollment.id});
  }));

  router.post('/enrollments/:id/checkout', customerAuth, route(async (req, res) => {
    const config = paytmConfig();
    if (!config) return fail(res, 503, 'Online payments are not available yet');
    const enrollment = await Enrollment.findOne({_id: req.params.id, account: req.accountId}).lean();
    if (!enrollment) return fail(res, 404, 'Plan enrollment not found');
    const installment = await nextInstallment(enrollment);
    if (!installment || installmentMonth(enrollment, installment) > monthOf(new Date())) {
      return fail(res, 409, 'No installment is due yet');
    }
    // The client supplies only the enrollment ID. The saved plan sets the currency and amount.
    const slot = paymentFilter(enrollment, installment);
    let payment = await Payment.findOne(slot).select('+checkoutToken').lean();
    if (payment?.status === 'pending') {
      payment = await reconcile(config, payment);
      if (payment?.status === 'pending' && payment.checkoutToken && Date.now() - +payment.startedAt < 14 * 60000) {
        return res.json(checkoutFields(config, payment, payment.checkoutToken));
      }
      if (payment?.status !== 'failed') return fail(res, 409, 'Payment is being checked. Refresh its status before retrying.');
    }
    const attempt = {orderId: orderId(), amountPaise: enrollment.amountPaise, channel: 'paytm',
      status: 'pending', startedAt: new Date()};
    payment = payment ? await Payment.findOneAndUpdate({...slot, status: 'failed'},
      {$set: attempt, $unset: {checkoutToken: 1}}, {new: true}) :
      await Payment.create({...slot, ...attempt});
    if (!payment) return fail(res, 409, 'An installment payment is already being processed');
    let token;
    try {
      token = await initiatePaytm(config, payment, req.accountId);
    } catch {
      return fail(res, 502, 'Could not start Paytm checkout. Check payment status before retrying.');
    }
    await Payment.updateOne({_id: payment._id, orderId: payment.orderId, status: 'pending'},
      {$set: {checkoutToken: token}});
    res.json(checkoutFields(config, payment, token));
  }));

  router.post('/payments/:id/check', customerAuth, route(async (req, res) => {
    const payment = await Payment.findById(req.params.id).lean();
    if (!payment || !await Enrollment.exists({_id: payment.enrollment, account: req.accountId})) {
      return fail(res, 404, 'Payment not found');
    }
    const config = paytmConfig();
    if (payment.status !== 'pending' || !config) return res.json({status: payment.status});
    try {
      const updated = await reconcile(config, payment);
      res.json({status: updated.status});
    } catch {
      fail(res, 502, 'Paytm could not confirm this payment yet. Try again later.');
    }
  }));

  router.post('/paytm/callback', express.urlencoded({extended: false, limit: '20kb', parameterLimit: 30}),
    route(async (req, res) => {
      const config = paytmConfig();
      const order = text(req.body?.ORDERID, 50);
      if (!config || !/^KJ_[a-f\d]{32}$/.test(order) || req.body.MID !== config.mid ||
          !verifyCallback(config, req.body)) return fail(res, 400, 'Invalid payment callback');
      const payment = await Payment.findOne({orderId: order, channel: 'paytm'}).lean();
      if (!payment) return fail(res, 404, 'Payment not found');
      try { await reconcile(config, payment); } catch { /* Customer can reconcile later. */ }
      const target = new URL('/', frontendOrigin);
      target.hash = '/account?tab=transactions';
      res.redirect(303, target.href);
    }));

  router.get('/admin/plans', adminAuth, route(async (req, res) => {
    res.json(await Plan.find().sort({createdAt: -1}).lean());
  }));
  router.post('/admin/plans', adminAuth, route(async (req, res) => {
    const name = text(req.body?.name, 120);
    const description = text(req.body?.description, 1000);
    const amountPaise = parsePaise(req.body?.amount);
    const months = Number(req.body?.months);
    const bonusMonths = Number(req.body?.bonusMonths);
    if (!name || !amountPaise || !Number.isInteger(months) || months < 1 || months > 36 ||
        !Number.isInteger(bonusMonths) || bonusMonths < 0 || bonusMonths > 3) {
      return fail(res, 400, 'Enter a name, positive monthly amount, 1–36 paid months and 0–3 bonus months');
    }
    res.status(201).json(await Plan.create({name, description, amountPaise, months, bonusMonths}));
  }));
  router.patch('/admin/plans/:id', adminAuth, route(async (req, res) => {
    if (typeof req.body?.active !== 'boolean') return fail(res, 400, 'Set whether to accept new enrollments');
    const plan = await Plan.findByIdAndUpdate(req.params.id, {$set: {active: req.body.active}}, {new: true});
    if (!plan) return fail(res, 404, 'Plan not found');
    res.json(plan);
  }));

  router.get('/admin/ledger', adminAuth, route(async (req, res) => {
    const month = text(req.query.month, 7) || monthOf(new Date());
    if (!monthValid(month)) return fail(res, 400, 'Select a valid month');
    const id = req.query.account;
    if (id && !isValidId(id)) return fail(res, 400, 'Invalid customer');
    const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
    const filter = id ? {account: id} : {};
    const [total, enrollments] = await Promise.all([
      Enrollment.countDocuments(filter),
      Enrollment.find(filter).sort({createdAt: -1, _id: -1}).skip((page - 1) * 50).limit(50)
        .populate('account', 'name email').lean()
    ]);
    const payments = await Payment.find({enrollment: {$in: enrollments.map(e => e._id)}})
      .sort({installment: 1}).lean();
    const rows = enrollments.map(e => {
      const records = payments.filter(p => String(p.enrollment) === String(e._id));
      const installments = Array.from({length: e.months}, (_, index) => index + 1).map(installment => ({
        installment, month: installmentMonth(e, installment),
        status: records.find(p => p.installment === installment)?.status || 'unpaid'
      }));
      const paid = records.filter(p => p.status === 'paid' && p.paidMonth === month);
      return {...e, installments, paid: customerPayments(paid),
        pending: customerPayments(records.filter(p => p.status === 'pending')),
        monthTotalPaise: paid.reduce((sum, p) => sum + p.amountPaise, 0)};
    });
    res.json({rows, month, page, total, today: today(), paytm: Boolean(paytmConfig())});
  }));

  router.post('/admin/payments/:id/check', adminAuth, route(async (req, res) => {
    const payment = await Payment.findById(req.params.id).lean();
    if (!payment) return fail(res, 404, 'Payment not found');
    const config = paytmConfig();
    if (payment.status !== 'pending' || !config) return res.json({status: payment.status});
    try {
      const updated = await reconcile(config, payment);
      res.json({status: updated.status});
    } catch {
      fail(res, 502, 'Paytm could not confirm this payment yet. Try again later.');
    }
  }));

  router.post('/admin/enrollments/:id/offline', adminAuth, route(async (req, res) => {
    const enrollment = await Enrollment.findById(req.params.id).lean();
    if (!enrollment) return fail(res, 404, 'Plan enrollment not found');
    const installment = Number(req.body?.installment);
    const amountPaise = parsePaise(req.body?.amount);
    const date = text(req.body?.date, 10);
    const reference = text(req.body?.reference, 160);
    const paidAt = new Date(date + 'T12:00:00+05:30');
    if (!Number.isInteger(installment) || installment < 1 || installment > enrollment.months ||
        amountPaise !== enrollment.amountPaise || !/^20\d{2}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(+paidAt) || paidAt.toISOString().slice(0, 10) !== date || date > today() || !reference) {
      return fail(res, 400, 'Select an installment, its full amount, a valid receipt date and a reference');
    }
    const slot = paymentFilter(enrollment, installment);
    const existing = await Payment.findOne(slot).lean();
    if (existing?.status === 'paid' && existing.channel === 'offline' &&
        existing.reference === reference && +existing.paidAt === +paidAt) {
      return res.json(customerPayments([existing])[0]);
    }
    if (existing && existing.status !== 'failed') {
      return fail(res, 409, 'This installment is paid or has a pending Paytm payment');
    }
    const fields = {channel: 'offline', status: 'paid', amountPaise, paidAt, paidMonth: monthOf(paidAt),
      reference, recordedBy: req.admin.sub};
    const payment = existing ? await Payment.findOneAndUpdate({...slot, status: 'failed'}, {
      $set: fields, $unset: {orderId: 1, startedAt: 1, checkoutToken: 1}
    }, {new: true}) : await Payment.create({...slot, ...fields});
    if (!payment) return fail(res, 409, 'The installment changed. Refresh and try again.');
    res.status(201).json(customerPayments([payment])[0]);
  }));
  return router;
}
