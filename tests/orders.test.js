import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import {ordersRouter} from '../src/orders.js';
import {Product} from '../src/models.js';
import {Account} from '../src/savings-models.js';
import {Offer, Order} from '../src/order-models.js';

test('checkout uses stored prices and offer, restricts ownership, and emails a paid delivery once', async t => {
  Object.assign(process.env, {
    JWT_SECRET: 'local-orders-test-signing-key-over-32-characters', PAYTM_MID: 'merchant',
    PAYTM_MERCHANT_KEY: '0123456789abcdef', PAYTM_WEBSITE: 'WEBSTAGING', PAYTM_ENV: 'staging',
    PUBLIC_BASE_URL: 'https://shop-api.example.test'
  });
  const buyer = '0123456789abcdef01234567';
  const other = '0123456789abcdef01234568';
  const product = '0123456789abcdef01234569';
  const session = id => jwt.sign({sub: id, role:'customer'}, process.env.JWT_SECRET, {audience:'kj-savings'});
  let order;
  const sent = [];
  const gateway = [];
  const query = value => ({select: () => query(value), lean: async () => value});
  t.mock.method(Product, 'find', filter => {
    assert.deepEqual(filter, {_id: {$in:[product]}, active:true});
    return query([{_id:product, name:'Silver Necklace', metal:'Silver', price:2000.50}]);
  });
  t.mock.method(Offer, 'findOne', filter => query(filter.code === 'WELCOME10' && filter.active ? {percent:10} : null));
  t.mock.method(Account, 'findById', id => query(id === buyer ? {email:'buyer@example.test'} : null));
  t.mock.method(Order, 'exists', async () => order?.status === 'pending');
  t.mock.method(Order, 'create', async data => (order = {_id:'order', ...data}));
  t.mock.method(Order, 'findOne', filter => query(filter.orderId === order?.orderId &&
    (!filter.account || filter.account === order.account) ? order : null));
  t.mock.method(Order, 'updateOne', async (filter, update) => {
    if (filter.status && filter.status !== order?.status) return {modifiedCount:0};
    if (filter.orderId && filter.orderId !== order?.orderId) return {modifiedCount:0};
    Object.assign(order, update.$set);
    return {modifiedCount:1};
  });
  t.mock.method(Order, 'findOneAndUpdate', async (filter, update) => {
    if (filter.orderId !== order?.orderId || order.status !== filter.status || order.deliveryEmailState === 'sent') return null;
    return Object.assign(order, update.$set);
  });
  const http = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /^https:\/\/securestage\.paytmpayments\.com\//);
    gateway.push(JSON.parse(options.body).body);
    return Response.json({body:{resultInfo:{resultStatus:'S'},txnToken:'token'}});
  });
  const app = express();
  app.use(express.json(), ordersRouter({
    frontendOrigin:'https://shop.example.test',
    adminAuth(req,res,next) {
      if (req.headers.authorization !== 'Bearer mock-admin') return res.sendStatus(401);
      req.admin = {sub:other}; next();
    },
    mailTransport: () => ({sendMail: async message => {sent.push(message);}})
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = (path, body, token = session(buyer)) => http('http://127.0.0.1:' + server.address().port + path, {
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ' + token},body:JSON.stringify(body)
  });
  try {
    const cart = {items:[{product,quantity:2,unitPaise:100}],offerCode:'welcome10',amountPaise:100,
      address:{name:'Buyer',phone:'9876543210',line1:'Shop Road',city:'Sangli',state:'Maharashtra',pin:'416416'}};
    assert.equal((await request('/quote', {...cart, offerCode:'wrong'})).status, 400);
    const quote = await (await request('/quote', cart)).json();
    assert.equal(quote.amountPaise, 360090);
    assert.equal((await request('/checkout', {...cart, expectedAmountPaise:100})).status, 409);
    assert.equal(gateway.length, 0);
    assert.equal((await request('/checkout', {...cart, expectedAmountPaise:quote.amountPaise})).status, 201);
    assert.deepEqual(gateway[0].txnAmount,{value:'3600.90',currency:'INR'});
    assert.match(gateway[0].callbackUrl, /\/api\/orders\/paytm\/callback$/);
    assert.equal((await request('/checkout', {...cart, expectedAmountPaise:quote.amountPaise})).status, 409);
    assert.equal((await request('/mine/' + order.orderId + '/check', {}, session(other))).status, 404);
    const deliver = '/admin/orders/' + order.orderId + '/deliver';
    assert.equal((await request(deliver, {})).status, 401);
    assert.equal((await request(deliver, {}, 'mock-admin')).status, 409);
    assert.equal(sent.length, 0);
    order.status = 'paid';
    const delivered = await (await request(deliver, {}, 'mock-admin')).json();
    assert.equal(delivered.order.status, 'delivered');
    assert.equal(delivered.order.deliveryEmailState, 'sent');
    assert.equal(sent[0].to, 'buyer@example.test');
    assert.equal((await request(deliver, {}, 'mock-admin')).status, 200);
    assert.equal(sent.length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
