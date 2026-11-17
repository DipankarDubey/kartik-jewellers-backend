import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import {Account, LoginCode} from './savings-models.js';
import {Customer} from './models.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const fail = (res, status, error) => res.status(status).json({error});
const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(err => {
  if (err.code === 11000) return fail(res, 409, 'This mobile number or email is already registered.');
  next(err);
});
const seconds = 1000;
const minute = 60 * seconds;
const bcryptRounds = 11;
const dummyHash = bcrypt.hashSync('unusable-customer-password', bcryptRounds);
const signInMessage = 'Enter a valid mobile number and password.';
const setupMessage = 'If these details can be used, a verification code will arrive by email.';

export function mobileNumber(value) {
  const digits = typeof value === 'string' && value.length <= 30 ? value.trim().replace(/[ ().-]/g, '') : '';
  return /^(?:\+?91)?([6-9]\d{9})$/.exec(digits)?.[1] || '';
}

function emailAddress(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.length <= 254 && emailPattern.test(email) ? email : '';
}

const acceptablePassword = value => typeof value === 'string' && value.length >= 12 &&
  Buffer.byteLength(value, 'utf8') <= 72;
const hashCode = (email, mobile, mode, code) => crypto.createHmac('sha256', process.env.JWT_SECRET)
  .update(JSON.stringify(['customer-password', email, mobile, mode, code])).digest('hex');
const version = () => crypto.randomBytes(16).toString('hex');
const sessionFor = account => jwt.sign({sub: String(account._id), role: 'customer', version: account.authVersion}, process.env.JWT_SECRET,
  {expiresIn: '4h', algorithm: 'HS256', audience: 'kj-savings'});

async function syncDirectory(account, fields = {}, protectConsent = false) {
  const values = {savingsAccount: account._id, email: account.email, phone: account.mobile, ...fields};
  if (account.passwordEmailVerifiedAt) values.emailVerifiedAt = account.passwordEmailVerifiedAt;
  if (account.lastLoginAt) values.lastPortalLoginAt = account.lastLoginAt;
  if (protectConsent) {
    const previous = await Customer.findOne({$or: [{savingsAccount: account._id}, {email: account.email, savingsAccount: null}]})
      .sort({createdAt: 1}).select('phone').lean();
    if (previous && mobileNumber(previous.phone) !== account.mobile) values.whatsappConsent = false;
  }
  const changed = await Customer.findOneAndUpdate(
    {savingsAccount: account._id}, {$set: values}, {new: true}
  );
  if (changed) return changed;
  if (account.passwordEmailVerifiedAt || fields.source === 'store') {
    const linked = await Customer.findOneAndUpdate(
      {email: account.email, savingsAccount: null}, {$set: values}, {new: true, sort: {createdAt: 1}}
    );
    if (linked) return linked;
  }
  const insert = {name: account.name, source: 'online', visitedAt: new Date(), unsubscribeToken: crypto.randomBytes(24).toString('hex')};
  for (const key of Object.keys(values)) delete insert[key];
  return Customer.findOneAndUpdate({savingsAccount: account._id}, {
    $set: values, $setOnInsert: insert
  }, {new: true, upsert: true});
}

function matchesPurpose(account, mobile, mode) {
  if (mode === 'register') return !account?.passwordHash && (!account?.mobile || account.mobile === mobile);
  return Boolean(account?.passwordHash && account.mobile === mobile);
}

export function customerCredentialsRouter({mailTransport}) {
  const router = express.Router();
  const limit = rateLimit({windowMs: 15 * minute, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false});

  router.post('/register', limit, route(async (req, res) => {
    const {name: rawName, mobile: rawMobile, email: rawEmail, password} = req.body || {};
    const name = clean(rawName, 120);
    const mobile = mobileNumber(rawMobile);
    const email = emailAddress(rawEmail);
    if (!name || !mobile || !email) return fail(res, 400, 'Enter your name, Indian mobile number and email.');
    if (!acceptablePassword(password)) {
      return fail(res, 400, 'Use a password with at least 12 characters and no more than 72 UTF-8 bytes.');
    }
    const existing = await Account.findOne({email}).select('+passwordHash');
    if (!matchesPurpose(existing, mobile, 'register') || await Account.exists({mobile, email: {$ne: email}})) {
      return fail(res, 409, 'This mobile number or email is already registered. Sign in or reset your password.');
    }
    if (existing) return res.json({verificationRequired: true});

    const account = await Account.create({name, email, mobile, passwordHash: await bcrypt.hash(password, bcryptRounds),
      authVersion: version(), lastLoginAt: new Date()});
    await syncDirectory(account);
    res.status(201).json({token: sessionFor(account)});
  }));

  router.post('/login/password', limit, route(async (req, res) => {
    const {mobile: rawMobile, password, newPassword} = req.body || {};
    const mobile = mobileNumber(rawMobile);
    if (!mobile || !acceptablePassword(password)) return fail(res, 401, signInMessage);
    const account = await Account.findOne({mobile}).select('+passwordHash');
    const matches = await bcrypt.compare(password, account?.passwordHash || dummyHash);
    if (!matches || !account?.passwordHash) return fail(res, 401, signInMessage);
    const now = new Date();
    const fields = {lastLoginAt: now};
    const update = {$set: fields};
    if (account.temporaryPasswordUntil) {
      if (+account.temporaryPasswordUntil <= +now) return fail(res, 401, 'Your temporary password expired. Use Reset password to set a new one.');
      if (newPassword === undefined) return res.json({changeRequired: true});
      if (!acceptablePassword(newPassword) || newPassword === password) {
        return fail(res, 400, 'Choose a different password with at least 12 characters and no more than 72 UTF-8 bytes.');
      }
      fields.passwordHash = await bcrypt.hash(newPassword, bcryptRounds);
      fields.passwordEmailVerifiedAt = now;
      fields.authVersion = version();
      update.$unset = {temporaryPasswordUntil: 1, inviteState: 1, inviteAttemptAt: 1};
    }
    const saved = await Account.findOneAndUpdate({_id: account._id, passwordHash: account.passwordHash}, update, {new: true});
    if (!saved) return fail(res, 409, 'Sign-in details changed. Please try again.');
    await syncDirectory(saved);
    res.json({token: sessionFor(saved)});
  }));

  router.post('/password/request', limit, route(async (req, res) => {
    const {mode, name: rawName, mobile: rawMobile, email: rawEmail} = req.body || {};
    const name = clean(rawName, 120);
    const mobile = mobileNumber(rawMobile);
    const email = emailAddress(rawEmail);
    if (!['register', 'reset'].includes(mode) || !mobile || !email || (mode === 'register' && !name)) {
      return fail(res, 400, 'Enter a valid Indian mobile number, email and any required name.');
    }
    const account = await Account.findOne({email}).select('+passwordHash');
    if (!matchesPurpose(account, mobile, mode)) return res.json({message: setupMessage});
    let transport;
    try {transport = mailTransport();} catch {
      const purpose = mode === 'register' ? 'This email belongs to an existing account. Contact the showroom to restore access.' :
        'Password reset email is unavailable. Contact the showroom for help.';
      return fail(res, 503, purpose);
    }
    const now = Date.now();
    const code = String(crypto.randomInt(100000, 1000000));
    const digest = hashCode(email, mobile, mode, code);
    try {
      await LoginCode.findOneAndUpdate({email, $or: [{updatedAt: {$lte: new Date(now - minute)}}, {updatedAt: {$exists: false}}]},
        {$set: {email, mobile, mode, name, digest, attempts: 5, expiresAt: new Date(now + 10 * minute)}}, {upsert: true});
    } catch (err) {
      if (err.code === 11000) return res.json({message: setupMessage});
      throw err;
    }
    try {
      await transport.sendMail({from: process.env.SMTP_FROM, to: email, subject: 'Your Karthik Jewellers password verification code',
        text: `Your verification code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`});
    } catch {
      await LoginCode.deleteOne({email, digest});
      return fail(res, 503, 'Could not send the verification code. Try again later.');
    }
    res.json({message: setupMessage});
  }));

  router.post('/password/complete', limit, route(async (req, res) => {
    const {mode, mobile: rawMobile, email: rawEmail, code, password} = req.body || {};
    const mobile = mobileNumber(rawMobile);
    const email = emailAddress(rawEmail);
    if (!['register', 'reset'].includes(mode) || !mobile || !email ||
        typeof code !== 'string' || !/^\d{6}$/.test(code) || !acceptablePassword(password)) {
      return fail(res, 400, 'Enter your verification code and a password with at least 12 characters and no more than 72 UTF-8 bytes.');
    }
    const filter = {email, mobile, mode, expiresAt: {$gt: new Date()}, attempts: {$gt: 0}};
    const challenge = await LoginCode.findOneAndDelete({...filter, digest: hashCode(email, mobile, mode, code)});
    if (!challenge) {
      await LoginCode.updateOne(filter, {$inc: {attempts: -1}});
      return fail(res, 401, 'The verification code is invalid or has expired.');
    }
    const existing = await Account.findOne({email}).select('+passwordHash');
    if (!matchesPurpose(existing, mobile, mode)) return fail(res, 409, 'These details have changed. Start again.');
    const now = new Date();
    const values = {mobile, passwordHash: await bcrypt.hash(password, bcryptRounds), passwordEmailVerifiedAt: now, lastLoginAt: now, authVersion: version()};
    const account = existing ? await Account.findOneAndUpdate({
      _id: existing._id,
      passwordHash: existing.passwordHash || {$exists: false}
    }, {$set: values, $unset: {temporaryPasswordUntil: 1, inviteState: 1, inviteAttemptAt: 1}}, {new: true})
      : await Account.create({...values, email, name: challenge.name});
    if (!account) return fail(res, 409, 'These details have changed. Start again.');
    await syncDirectory(account, {}, mode === 'register');
    res.json({token: sessionFor(account)});
  }));
  return router;
}

export function addCustomerWithLogin({mailTransport, frontendOrigin}) {
  return route(async (req, res) => {
    const data = req.body || {};
    const name = clean(data.name, 120);
    const mobile = mobileNumber(data.phone);
    const email = emailAddress(data.email);
    const visitedAt = data.visitedAt ? new Date(data.visitedAt) : new Date();
    if (!name || !mobile || !email || Number.isNaN(+visitedAt)) {
      return fail(res, 400, 'Name, a valid Indian mobile number, email and visit date are required.');
    }
    const existing = await Account.findOne({email}).select('+passwordHash');
    if (existing?.mobile && existing.mobile !== mobile) return fail(res, 409, 'This email belongs to a different customer login.');
    if (existing?.passwordHash && !['failed', 'sending'].includes(existing.inviteState)) {
      return fail(res, 409, 'A customer login already exists for this email. The customer can reset their own password.');
    }
    if (existing?.inviteState === 'sending' && Date.now() - +existing.inviteAttemptAt < 2 * minute) {
      return fail(res, 409, 'A welcome email is already being processed. Try again in two minutes.');
    }
    const temporary = crypto.randomBytes(24).toString('base64url');
    const now = new Date();
    const passwordHash = await bcrypt.hash(temporary, bcryptRounds);
    const credentials = {mobile, passwordHash, authVersion: version(), temporaryPasswordUntil: new Date(+now + 48 * 60 * minute),
      inviteState: 'sending', inviteAttemptAt: now};
    const account = existing ? await Account.findOneAndUpdate({
      _id: existing._id,
      passwordHash: existing.passwordHash || {$exists: false}
    }, {$set: credentials}, {new: true}) : await Account.create({...credentials, email, name});
    if (!account) return fail(res, 409, 'This customer changed during the request. Try again.');
    let customer;
    let inviteEmail = 'failed';
    const claim = {_id: account._id, passwordHash, inviteState: 'sending'};
    try {
      customer = await syncDirectory(account, {name, source: 'store', visitedAt,
        interestedIn: clean(data.interestedIn, 100), notes: clean(data.notes, 2000),
        marketingConsent: data.marketingConsent === true, whatsappConsent: data.whatsappConsent === true});
      try {
        await mailTransport().sendMail({from: process.env.SMTP_FROM, to: email,
          subject: 'Your Karthik Jewellers customer account',
          text: `Hello ${name},\n\nYour customer account is ready.\n\nUsername: ${mobile}\nTemporary password: ${temporary}\n\nSign in at ${new URL('/#/account/login', frontendOrigin).href}. Replace this password at first sign-in. It expires in 48 hours.`});
        inviteEmail = 'sent';
      } catch { /* The admin can retry with the same customer details. */ }
    } finally {
      await Account.updateOne(claim, {$set: {inviteState: inviteEmail}});
    }
    res.status(201).json({customer, inviteEmail});
  });
}
