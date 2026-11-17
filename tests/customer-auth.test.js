import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {addCustomerWithLogin, customerCredentialsRouter} from '../src/customer-auth.js';
import {Account, LoginCode} from '../src/savings-models.js';
import {Customer} from '../src/models.js';

test('legacy customers keep their account and admin invitations require a permanent password', async t => {
  process.env.JWT_SECRET = 'test-customer-authentication-secret-that-is-long-enough';
  const legacyId = '0123456789abcdef01234561';
  const newId = '0123456789abcdef01234562';
  const accounts = [{_id: legacyId, email:'legacy@example.test', name:'Legacy customer'}];
  const directory = new Map();
  const messages = [];
  let challenge;
  let mailFails = false;
  const lookup = filter => accounts.find(account => ['_id','email','mobile','inviteState'].every(key =>
    !(key in filter) || filter[key] === account[key]) &&
    (!filter.passwordHash || (typeof filter.passwordHash === 'string'
      ? account.passwordHash === filter.passwordHash : !account.passwordHash)));
  function update(account, changes) {
    if (!account) return null;
    Object.assign(account, changes.$set);
    for (const key of Object.keys(changes.$unset || {})) delete account[key];
    return account;
  }
  t.mock.method(Account, 'findOne', filter => ({select: async () => lookup(filter)}));
  t.mock.method(Account, 'findOneAndUpdate', async (filter, changes) => update(lookup(filter), changes));
  t.mock.method(Account, 'updateOne', async (filter, changes) => update(lookup(filter), changes));
  t.mock.method(Account, 'create', async data => {
    const account = {_id:newId, ...data};
    accounts.push(account);
    return account;
  });
  t.mock.method(Customer, 'findOne', () => ({sort:()=>({select:()=>({lean:async()=>null})})}));
  t.mock.method(Customer, 'findOneAndUpdate', async (filter, update, options) => {
    if (!options.upsert && !directory.has(String(filter.savingsAccount))) return null;
    const entry = {...directory.get(String(filter.savingsAccount)), ...update.$setOnInsert, ...update.$set};
    directory.set(String(filter.savingsAccount), entry);
    return entry;
  });
  t.mock.method(LoginCode, 'findOneAndUpdate', async (_, update) => {challenge = update.$set;});
  t.mock.method(LoginCode, 'findOneAndDelete', async filter => {
    if (challenge?.digest !== filter.digest) return null;
    const found = challenge;
    challenge = undefined;
    return found;
  });
  t.mock.method(LoginCode, 'updateOne', async () => {});
  const mailTransport = () => ({sendMail: async message => {
    if (mailFails) throw Error('Simulated email failure');
    messages.push(message);
  }});
  const app = express();
  app.use(express.json(), customerCredentialsRouter({mailTransport}));
  app.post('/admin/customers', addCustomerWithLogin({mailTransport, frontendOrigin:'https://shop.example.test'}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const send = (path, body) => fetch('http://127.0.0.1:' + server.address().port + path, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  });
  const session = token => jwt.verify(token, process.env.JWT_SECRET, {audience:'kj-savings'});
  try {
    const legacy = {mode:'register', name:'New submission', email:'legacy@example.test', mobile:'+91 98765 43210'};
    assert.equal((await send('/password/request', {...legacy,email:''})).status, 400);
    assert.equal((await send('/password/request', legacy)).status, 200);
    const code = messages[0].text.match(/\b\d{6}\b/)[0];
    const chosen = 'a customer-chosen password';
    const setup = await send('/password/complete', {...legacy,code,password:chosen});
    assert.equal(setup.status,200);
    const original = session((await setup.json()).token);
    assert.equal(original.sub,legacyId);
    assert.equal(directory.get(legacyId).phone,'9876543210');
    assert.equal((await send('/password/complete', {...legacy,code,password:chosen})).status,401);
    assert.equal((await send('/login/password', {mobile:'9876543210',password:chosen})).status,200);
    await send('/password/request', {...legacy,mode:'reset'});
    const reset = await send('/password/complete', {...legacy,mode:'reset',code:messages.at(-1).text.match(/\b\d{6}\b/)[0],password:'new confirmed password'});
    assert.notEqual(session((await reset.json()).token).version, original.version);
    assert.equal((await send('/login/password', {mobile:legacy.mobile,password:chosen})).status,401);

    const admin = {name:'New customer', email:'new@example.test', phone:'9988776655'};
    assert.equal((await send('/admin/customers', {...admin,email:undefined})).status, 400);
    assert.equal((await send('/admin/customers', {...admin,phone:'invalid'})).status, 400);
    mailFails = true;
    assert.equal((await (await send('/admin/customers', admin)).json()).inviteEmail,'failed');
    mailFails = false;
    const invitation = await send('/admin/customers', admin);
    assert.equal(invitation.status,201);
    assert.equal((await invitation.json()).inviteEmail,'sent');
    assert.match(messages.at(-1).text, /Username: 9988776655/);
    const temporary = messages.at(-1).text.match(/Temporary password: (\S+)/)[1];
    assert.notEqual(accounts[1].passwordHash, temporary);
    assert.equal(await bcrypt.compare(temporary, accounts[1].passwordHash), true);
    const login = {mobile:admin.phone,password:temporary};
    assert.deepEqual(await (await send('/login/password', login)).json(), {changeRequired:true});
    assert.equal((await send('/admin/customers', admin)).status,409);
    const replacement = await send('/login/password', {...login,newPassword:'new permanent password'});
    assert.equal(replacement.status,200);
    assert.equal(session((await replacement.json()).token).sub,newId);
    assert.equal((await send('/login/password', login)).status,401);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
