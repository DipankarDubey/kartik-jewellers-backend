import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';

const random = () => crypto.randomBytes(32).toString('base64url');
export const hashProof = value => crypto.createHash('sha256').update(value).digest('base64url');
const proofPattern = /^[A-Za-z0-9_-]{43}$/;
const issuers = ['https://accounts.google.com', 'accounts.google.com'];
const cookieName = 'kj_google_oauth';
const callbackPath = '/api/savings/login/google/callback';

export function googleConfig() {
  const {GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_BASE_URL} = process.env;
  if (!GOOGLE_CLIENT_ID?.trim() || !GOOGLE_CLIENT_SECRET?.trim() || !PUBLIC_BASE_URL) return null;
  try {
    const base = new URL(PUBLIC_BASE_URL);
    const secure = base.protocol === 'https:';
    if (!secure && (base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname))) return null;
    return {id: GOOGLE_CLIENT_ID.trim(), secret: GOOGLE_CLIENT_SECRET.trim(),
      redirect: new URL(callbackPath, base).href, secure};
  } catch {
    return null;
  }
}

let keyCache = {keys: [], until: 0};

async function googleSigningKey(kid) {
  let key = Date.now() < keyCache.until && keyCache.keys.find(item => item.kid === kid);
  if (!key) {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/certs', {
      redirect: 'error', signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw Error('Google signing keys unavailable');
    const {keys} = await response.json();
    const seconds = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 0);
    keyCache = {keys, until: Date.now() + Math.min(seconds, 3600) * 1000};
    key = keys.find(item => item.kid === kid);
  }
  if (!key || key.kty !== 'RSA') throw Error('Invalid Google signing key');
  return crypto.createPublicKey({key, format: 'jwk'});
}

async function googleProfile(config, code, state) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({code, client_id: config.id, client_secret: config.secret,
      redirect_uri: config.redirect, grant_type: 'authorization_code', code_verifier: state.verifier})
  });
  if (!response.ok) throw Error('Google token exchange failed');
  const {id_token: token} = await response.json();
  const header = jwt.decode(token, {complete: true})?.header;
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string') throw Error('Invalid Google token header');
  const profile = jwt.verify(token, await googleSigningKey(header.kid), {
    algorithms: ['RS256'], audience: config.id, issuer: issuers
  });
  if (profile.aud !== config.id || profile.nonce !== state.nonce ||
      !Number.isFinite(profile.exp) || profile.exp <= Date.now() / 1000 ||
      typeof profile.sub !== 'string' || !profile.sub || profile.sub.length > 255 ||
      profile.email_verified !== true || typeof profile.email !== 'string') throw Error('Invalid Google identity');
  return profile;
}

export function googleLoginRouter({frontendOrigin, limit, issueTicket, redeemTicket}) {
  const router = express.Router();
  const cookieOptions = config => ({path: callbackPath, httpOnly: true, sameSite: 'lax', secure: config.secure});
  router.get('/start', limit, (req, res) => {
    const config = googleConfig();
    if (!config) return res.status(503).json({error: 'Google sign-in is not available yet'});
    const challenge = req.query.challenge;
    if (typeof challenge !== 'string' || !proofPattern.test(challenge)) return res.sendStatus(400);
    const state = {state: random(), nonce: random(), verifier: random(), challenge};
    const cookie = jwt.sign(state, process.env.JWT_SECRET, {algorithm: 'HS256', audience: 'kj-google', expiresIn: '10m'});
    res.cookie(cookieName, cookie, {...cookieOptions(config), maxAge: 10 * 60000});
    const query = new URLSearchParams({client_id: config.id, redirect_uri: config.redirect,
      response_type: 'code', scope: 'openid email profile', state: state.state, nonce: state.nonce,
      code_challenge: hashProof(state.verifier), code_challenge_method: 'S256', prompt: 'select_account'});
    res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + query);
  });

  router.get('/callback', async (req, res) => {
    const result = params => {
      res.set('Referrer-Policy', 'no-referrer');
      res.redirect(new URL('/#/account/login?' + new URLSearchParams(params), frontendOrigin).href);
    };
    const config = googleConfig();
    if (!config) return result({google: 'unavailable'});
    const cookie = req.headers.cookie?.split(/;\s*/).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    try {
      const state = jwt.verify(cookie, process.env.JWT_SECRET, {algorithms: ['HS256'], audience: 'kj-google'});
      if (state.state !== req.query.state || typeof req.query.code !== 'string') return result({google: 'retry'});
      res.clearCookie(cookieName, cookieOptions(config));
      const profile = await googleProfile(config, req.query.code, state);
      const ticket = random();
      if (!await issueTicket(profile, hashProof(ticket), state.challenge)) return result({google: 'email'});
      return result({google: 'complete', ticket});
    } catch {
      return result({google: 'retry'});
    }
  });

  router.post('/complete', limit, async (req, res, next) => {
    const {ticket, verifier} = req.body || {};
    if (typeof ticket !== 'string' || typeof verifier !== 'string' ||
        !proofPattern.test(ticket) || !proofPattern.test(verifier)) return res.sendStatus(400);
    try {
      const token = await redeemTicket(hashProof(ticket), hashProof(verifier));
      if (!token) return res.status(401).json({error: 'Google sign-in expired. Please try again.'});
      res.json({token});
    } catch (err) {
      next(err);
    }
  });
  return router;
}
