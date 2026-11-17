import crypto from 'node:crypto';
import express from 'express';
import mongoose from 'mongoose';
import {Product} from './models.js';
import {Account} from './savings-models.js';
import {Order, Offer} from './order-models.js';
import {customerAuth} from './savings.js';
import {paytmConfig, parsePaise, initiatePaytm, verifiedPaytmStatus, verifyCallback, checkoutFields} from './paytm.js';

const asText = (value, max) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
const offerPattern = /^[A-Z0-9][A-Z0-9-]{2,23}$/;
const fail = (res, status, error) => res.status(status).json({error});
const safe = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const configForOrders = () => paytmConfig(process.env, '/api/orders/paytm/callback');

class InvalidCart extends Error {}

function addressFrom(value) {
  const address = Object.fromEntries([
    ['name', 120], ['phone', 24], ['line1', 220], ['line2', 160], ['city', 100], ['state', 100], ['pin', 6]
  ].map(([key, max]) => [key, asText(value?.[key], max)]));
  address.phone = address.phone.replace(/[ ()-]/g, '');
  if (!address.name || !address.line1 || !address.city || !address.state || !/^[1-9]\d{5}$/.test(address.pin) ||
      !/^(?:\+91)?[6-9]\d{9}$/.test(address.phone)) return null;
  return address;
}

async function priceCart(input) {
  const {items, offerCode: suppliedCode} = input || {};
  if (!Array.isArray(items) || !items.length || items.length > 30) throw new InvalidCart('Add between 1 and 30 designs to your cart.');
  const ids = new Set();
  for (const item of items) {
    if (!mongoose.isObjectIdOrHexString(item?.product) || !Number.isInteger(item.quantity) ||
        item.quantity < 1 || item.quantity > 10 || ids.has(item.product)) {
      throw new InvalidCart('Check the cart quantities and try again.');
    }
    ids.add(item.product);
  }
  const products = await Product.find({_id: {$in: [...ids]}, active: true}).lean();
  const byId = new Map(products.map(p => [String(p._id), p]));
  const lines = items.map(({product, quantity}) => {
    const item = byId.get(product);
    const unitPaise = item && parsePaise(item.price);
    if (!unitPaise) throw new InvalidCart('A design is no longer available for online purchase. Remove it and try again.');
    return {product, quantity, name: item.name, metal: item.metal || 'Gold', unitPaise};
  });
  const subtotalPaise = lines.reduce((sum, line) => sum + line.unitPaise * line.quantity, 0);
  const offerCode = asText(suppliedCode, 24).toUpperCase();
  let discountPaise = 0;
  if (suppliedCode) {
    const offer = offerPattern.test(offerCode) && await Offer.findOne({code: offerCode, active: true}).lean();
    if (!offer) throw new InvalidCart('That offer code is invalid or inactive.');
    discountPaise = Math.floor(subtotalPaise * offer.percent / 100);
  }
  const amountPaise = subtotalPaise - discountPaise;
  if (amountPaise < 100 || amountPaise >= 10000000000) throw new InvalidCart('This total is outside the online checkout range.');
  return {items: lines, subtotalPaise, discountPaise, amountPaise, offerCode};
}

function orderView(order) {
  const {orderId, items, status, address, email, offerCode, subtotalPaise, discountPaise, amountPaise,
    gatewayTxn, paidAt, deliveredAt, createdAt, deliveryEmailState} = order;
  return {orderId, items, status, address, email, offerCode, subtotalPaise, discountPaise, amountPaise,
    gatewayTxn, paidAt, deliveredAt, createdAt, deliveryEmailState};
}

async function reconcile(order, config) {
  if (order.status !== 'pending' || !config) return order;
  const result = await verifiedPaytmStatus(config, order);
  const filter = {_id: order._id, status: 'pending'};
  if (result.status === 'TXN_SUCCESS') {
    await Order.updateOne(filter, {$set: {status: 'paid', gatewayTxn: result.txnId, paidAt: new Date()},
      $unset: {checkoutToken: 1}});
  } else if (result.status === 'TXN_FAILURE' && !['334', '335', '501'].includes(String(result.code)) ||
      result.status === 'NO_RECORD_FOUND' && Date.now() - +order.paymentStartedAt > 60 * 60000) {
    await Order.updateOne(filter, {$set: {status: 'failed'}, $unset: {checkoutToken: 1}});
  }
  return Order.findById(order._id).select('+checkoutToken').lean();
}

export function ordersRouter({adminAuth, mailTransport, frontendOrigin}) {
  const router = express.Router();
  router.use((req, res, next) => {res.set('Cache-Control', 'no-store'); next();});

  router.get('/availability', (req, res) => res.json({paytm: Boolean(configForOrders())}));
  router.post('/quote', customerAuth, safe(async (req, res) => {
    try {res.json(await priceCart(req.body));}
    catch (err) {if (!(err instanceof InvalidCart)) throw err; fail(res, 400, err.message);}
  }));

  router.post('/checkout', customerAuth, safe(async (req, res) => {
    const config = configForOrders();
    if (!config) return fail(res, 503, 'Online checkout is currently unavailable.');
    if (await Order.exists({account: req.accountId, status: 'pending'})) {
      return fail(res, 409, 'An order payment is still pending. Open My orders to resume or check its status.');
    }
    const address = addressFrom(req.body?.address);
    if (!address) return fail(res, 400, 'Enter a complete Indian delivery address and mobile number.');
    const account = await Account.findById(req.accountId).select('email').lean();
    if (!account) return fail(res, 401, 'Sign in again.');
    let quote;
    try { quote = await priceCart(req.body); }
    catch (err) {if (!(err instanceof InvalidCart)) throw err; return fail(res, 400, err.message);}
    if (req.body.expectedAmountPaise !== quote.amountPaise) return fail(res, 409, 'The total changed. Review the updated amount before paying.');
    let order;
    try {
      order = await Order.create({...quote, account: req.accountId, email: account.email, address,
        orderId: 'KJO_' + crypto.randomBytes(14).toString('hex'), status: 'pending', paymentStartedAt: new Date()});
    } catch (err) {
      if (err.code === 11000) return fail(res, 409, 'An order payment is already pending. Check My orders.');
      throw err;
    }
    let token;
    try {token = await initiatePaytm(config, order, req.accountId);}
    catch {return fail(res, 502, 'Paytm could not start checkout. Check the order status before trying again.');}
    await Order.updateOne({_id: order._id, status: 'pending'}, {$set: {checkoutToken: token}});
    res.status(201).json({orderId: order.orderId, checkout: checkoutFields(config, order, token)});
  }));

  router.get('/mine', customerAuth, safe(async (req, res) => {
    const orders = await Order.find({account: req.accountId}).sort({createdAt: -1}).limit(100).lean();
    res.json({orders: orders.map(orderView), paytm: Boolean(configForOrders())});
  }));

  async function refreshPayment(req, res, owner) {
    let order = await Order.findOne({orderId: req.params.id, ...owner}).select('+checkoutToken').lean();
    if (!order) return fail(res, 404, 'Order not found.');
    const config = configForOrders();
    try {order = await reconcile(order, config);}
    catch {return fail(res, 502, 'Paytm could not confirm the payment yet.');}
    res.json({order: orderView(order), checkout: owner.account && config && order.status === 'pending' &&
      order.checkoutToken && Date.now() - +order.paymentStartedAt < 14 * 60000
      ? checkoutFields(config, order, order.checkoutToken) : null});
  }
  router.post('/mine/:id/check', customerAuth, safe((req, res) => refreshPayment(req, res, {account: req.accountId})));

  router.post('/paytm/callback', express.urlencoded({extended: false, limit: '20kb', parameterLimit: 30}),
    safe(async (req, res) => {
      const config = configForOrders();
      const id = req.body?.ORDERID;
      if (!config || typeof id !== 'string' || !/^KJO_[a-f0-9]{28}$/.test(id) || !verifyCallback(config, req.body)) {
        return fail(res, 400, 'Invalid payment callback.');
      }
      const order = await Order.findOne({orderId: id}).lean();
      if (!order) return fail(res, 404, 'Order not found.');
      try {await reconcile(order, config);} catch { /* Order history can recheck the signed status. */ }
      res.redirect(303, new URL('/#/orders?' + new URLSearchParams({order: id}), frontendOrigin).href);
    }));

  router.get('/admin/orders', adminAuth, safe(async (req, res) => {
    const statuses = ['pending', 'paid', 'delivered', 'failed'];
    if (req.query.status && !statuses.includes(req.query.status)) return fail(res, 400, 'Invalid order status.');
    const filter = req.query.status ? {status: req.query.status} : {};
    const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({createdAt: -1, _id: -1}).skip((page - 1) * 30).limit(30).lean(),
      Order.countDocuments(filter)
    ]);
    res.json({orders: orders.map(orderView), total, page});
  }));
  router.post('/admin/orders/:id/check', adminAuth, safe((req, res) => refreshPayment(req, res, {})));
  router.post('/admin/orders/:id/deliver', adminAuth, safe(async (req, res) => {
    const orderId = req.params.id;
    const now = new Date();
    await Order.updateOne({orderId, status: 'paid'}, {$set: {status: 'delivered', deliveredAt: now, deliveredBy: req.admin.sub}});
    const claim = await Order.findOneAndUpdate({orderId, status: 'delivered', $or: [
      {deliveryEmailState: {$exists: false}}, {deliveryEmailState: 'failed'},
      {deliveryEmailState: 'sending', deliveryEmailAttemptAt: {$lt: new Date(+now - 5 * 60000)}}
    ]}, {$set: {deliveryEmailState: 'sending', deliveryEmailAttemptAt: now}}, {new: true});
    if (!claim) {
      const order = await Order.findOne({orderId}).lean();
      if (!order) return fail(res, 404, 'Order not found.');
      if (order.status !== 'delivered') return fail(res, 409, 'Only a paid order can be marked delivered.');
      return res.json({order: orderView(order)});
    }
    const filter = {_id: claim._id, deliveryEmailState: 'sending', deliveryEmailAttemptAt: now};
    try {
      const transport = mailTransport();
      await transport.sendMail({from: process.env.SMTP_FROM, to: claim.email,
        subject: 'Your Karthik Jewellers order was delivered',
        text: `Hi ${claim.address.name},\n\nYour Karthik Jewellers order ${orderId} has been marked delivered.\n\nThank you for shopping with us.`});
    } catch {
      await Order.updateOne(filter, {$set: {deliveryEmailState: 'failed'}});
      return res.json({order: {...orderView(claim), deliveryEmailState: 'failed'}});
    }
    await Order.updateOne(filter, {$set: {deliveryEmailState: 'sent', deliveryEmailSentAt: new Date()}});
    res.json({order: {...orderView(claim), deliveryEmailState: 'sent'}});
  }));

  router.get('/admin/offers', adminAuth, safe(async (req, res) => {
    res.json(await Offer.find().sort({createdAt: -1}).limit(100).lean());
  }));
  router.post('/admin/offers', adminAuth, safe(async (req, res) => {
    const code = asText(req.body?.code, 24).toUpperCase();
    const percent = req.body?.percent;
    if (!offerPattern.test(code) || !Number.isInteger(percent) || percent < 1 || percent > 95) {
      return fail(res, 400, 'Use a code of 3–24 letters, digits or hyphens and a whole discount from 1% to 95%.');
    }
    res.status(201).json(await Offer.create({code, percent}));
  }));
  router.patch('/admin/offers/:id', adminAuth, safe(async (req, res) => {
    if (typeof req.body?.active !== 'boolean') return fail(res, 400, 'Choose an offer status.');
    const offer = await Offer.findByIdAndUpdate(req.params.id, {$set: {active: req.body.active}}, {new: true});
    if (!offer) return fail(res, 404, 'Offer not found.');
    res.json(offer);
  }));
  return router;
}
