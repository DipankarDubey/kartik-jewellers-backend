import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomBytes} from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import {googleLoginRouter, hashProof} from '../src/google-auth.js';

test('Google callback checks browser state, signed identity and single-use proof', async t => {
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret',
    PUBLIC_BASE_URL: 'https://api.example.test', JWT_SECRET: 'test-secret-that-is-over-thirty-two-characters'
  });
  const {publicKey, privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const kid = 'test-key';
  const verifier = randomBytes(32).toString('base64url');
  let authorization;
  let saved;
  const http = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return Response.json({keys: [{...publicKey.export({format: 'jwk'}), kid}]});
    }
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(hashProof(options.body.get('code_verifier')), authorization.searchParams.get('code_challenge'));
    const profile = {nonce: authorization.searchParams.get('nonce'), email: 'customer@gmail.com', email_verified: true};
    const token = jwt.sign(profile, privateKey, {
      algorithm: 'RS256', keyid: kid, issuer: 'https://accounts.google.com',
      audience: process.env.GOOGLE_CLIENT_ID, subject: 'google-id', expiresIn: '5m'
    });
    return Response.json({id_token: token});
  });
  const app = express();
  app.use(express.json());
  app.use('/api/savings/login/google', googleLoginRouter({
    frontendOrigin: 'https://shop.example.test', limit: (_, __, next) => next(),
    async issueTicket(profile, digest, proof) {
      assert.equal(profile.email, 'customer@gmail.com');
      saved = {digest, proof};
      return true;
    },
    async redeemTicket(digest, proof) {
      if (saved?.digest !== digest || saved?.proof !== proof) return null;
      saved = undefined;
      return 'customer-session';
    }
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port + '/api/savings/login/google';
  try {
    const start = await http(origin + '/start?challenge=' + hashProof(verifier), {redirect: 'manual'});
    const cookie = start.headers.get('set-cookie').split(';')[0];
    authorization = new URL(start.headers.get('location'));
    const callback = async state => http(origin + '/callback?' + new URLSearchParams({state, code: 'test-code'}), {
      headers: {Cookie: cookie}, redirect: 'manual'
    });
    assert.match((await callback('wrong')).headers.get('location'), /google=retry/);
    const result = await callback(authorization.searchParams.get('state'));
    const data = new URLSearchParams(new URL(result.headers.get('location')).hash.split('?')[1]);
    assert.equal(data.get('google'), 'complete');
    const complete = proof => http(origin + '/complete', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ticket: data.get('ticket'), verifier: proof})
    });
    assert.equal((await complete(randomBytes(32).toString('base64url'))).status, 401);
    assert.equal((await (await complete(verifier)).json()).token, 'customer-session');
    assert.equal((await complete(verifier)).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
