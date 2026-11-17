import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import express from 'express';
import checksum from 'paytmchecksum';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-savings-secret-at-least-thirty-two-characters';
const {savingsRouter} = await import('../src/savings.js');
const {Enrollment, Payment} = await import('../src/savings-models.js');
const {paytmConfig, parsePaise, verifiedPaytmStatus} = await import('../src/paytm.js');

test('amounts stay in exact paise and blank Paytm config disables checkout', () => {
  assert.equal(paytmConfig({PAYTM_MID: '', PAYTM_MERCHANT_KEY: ''}), null);
  assert.equal(parsePaise('2000.05'), 200005);
  for (const value of ['', null, true, '1e3', '2.001', '-1']) assert.equal(parsePaise(value), null);
});

test('server-priced checkout rejects another customer and ignores an amount supplied by the browser', async t => {
  const realFetch = globalThis.fetch;
  Object.assign(process.env, {PAYTM_MID: 'testMerchant', PAYTM_MERCHANT_KEY: '0123456789abcdef',
    PAYTM_WEBSITE: 'WEBSTAGING', PAYTM_ENV: 'staging', PUBLIC_BASE_URL: 'https://api.example.test'});
  const buyer = '0123456789abcdef01234567';
  const other = '0123456789abcdef01234568';
  const sub = '0123456789abcdef01234569';
  const makeToken = (id, role = 'customer') => jwt.sign({sub: id, role}, process.env.JWT_SECRET, {audience: 'kj-savings'});
  t.mock.method(Enrollment, 'findOne', query => ({
    lean: async () => query.account === buyer && query._id === sub ?
      {_id: sub, startMonth: '2020-01', months: 11, amountPaise: 200000} : null
  }));
  t.mock.method(Payment, 'find', () => ({distinct: async () => []}));
  t.mock.method(Payment, 'findOne', () => ({select: () => ({lean: async () => null})}));
  t.mock.method(Payment, 'create', async fields => ({_id: 'payment', ...fields}));
  t.mock.method(Payment, 'updateOne', async () => ({modifiedCount: 1}));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.startsWith('http://127.0.0.1:')) return realFetch(url, options);
    const {body, head} = JSON.parse(options.body);
    assert.equal(checksum.verifySignature(JSON.stringify(body), process.env.PAYTM_MERCHANT_KEY, head.signature), true);
    calls.push(body);
    return Response.json({body: {resultInfo: {resultStatus: 'S'}, txnToken: 'test-token'}});
  });
  const app = express();
  app.use(express.json());
  app.use(savingsRouter({adminAuth: (req, res) => res.sendStatus(401), frontendOrigin:'https://shop.example.test'}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/enrollments/' + sub + '/checkout';
    const pay = token => realFetch(url, {method: 'POST', headers: {'Content-Type':'application/json', Authorization:'Bearer '+token}, body: '{"amount":1}'});
    assert.equal((await pay(makeToken(other))).status, 404);
    assert.equal((await pay(makeToken(buyer, 'admin'))).status, 401);
    const ok = await pay(makeToken(buyer));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).fields.txnToken, 'test-token');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].txnAmount, {value: '2000.00', currency: 'INR'});
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a signed Paytm success must match order, merchant and exact amount', async t => {
  const config = paytmConfig({PAYTM_MID:'testMerchant', PAYTM_MERCHANT_KEY:'0123456789abcdef', PAYTM_WEBSITE:'WEBSTAGING', PAYTM_ENV:'staging', PUBLIC_BASE_URL:'https://api.example.test'});
  const payment = {orderId:'KJ_abc', amountPaise:200000};
  const body = {mid:config.mid, orderId:payment.orderId, txnAmount:'2000.00', txnId:'gateway-txn', resultInfo:{resultStatus:'TXN_SUCCESS'}};
  let useBadSignature = false;
  t.mock.method(globalThis, 'fetch', async () => Response.json({body, head:{
    signature: await checksum.generateSignature(JSON.stringify(body), useBadSignature ? 'abcdef0123456789' : config.key)
  }}));
  assert.equal((await verifiedPaytmStatus(config, payment)).status, 'TXN_SUCCESS');
  body.txnAmount = '1.00';
  await assert.rejects(verifiedPaytmStatus(config, payment), /amount/);
  body.txnAmount = '2000.00'; body.mid = 'otherMerchant';
  await assert.rejects(verifiedPaytmStatus(config, payment), /unexpected order/);
  body.mid = config.mid; useBadSignature = true;
  await assert.rejects(verifiedPaytmStatus(config, payment), /signature/);
});
