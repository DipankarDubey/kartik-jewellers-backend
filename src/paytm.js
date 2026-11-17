import checksum from 'paytmchecksum';

export function paytmConfig(env = process.env, callbackPath = '/api/savings/paytm/callback') {
  const mid = env.PAYTM_MID?.trim();
  const key = env.PAYTM_MERCHANT_KEY?.trim();
  const website = env.PAYTM_WEBSITE?.trim();
  const mode = env.PAYTM_ENV?.trim();
  const publicUrl = env.PUBLIC_BASE_URL?.trim();
  if (!mid || !key || !website || !['staging', 'production'].includes(mode) ||
      !publicUrl?.startsWith('https://')) return null;
  return {
    mid, key, website,
    host: mode === 'production' ? 'https://secure.paytmpayments.com' : 'https://securestage.paytmpayments.com',
    callbackUrl: new URL(callbackPath, publicUrl).href
  };
}

export function parsePaise(value) {
  if (!['number', 'string'].includes(typeof value)) return null;
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(String(value));
  return match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')) : null;
}

async function paytmRequest(config, path, body) {
  const signature = await checksum.generateSignature(JSON.stringify(body), config.key);
  const response = await fetch(config.host + path, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({body, head: {signature}}),
    redirect: 'error', signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw Error('Paytm is temporarily unavailable');
  return response.json();
}

export async function initiatePaytm(config, payment, accountId) {
  const {mid, website, callbackUrl} = config;
  const {orderId, amountPaise} = payment;
  const query = new URLSearchParams({mid, orderId});
  const result = await paytmRequest(config, '/theia/api/v1/initiateTransaction?' + query, {
    requestType: 'Payment', mid, websiteName: website, orderId, callbackUrl,
    txnAmount: {value: (amountPaise / 100).toFixed(2), currency: 'INR'},
    userInfo: {custId: String(accountId)}
  });
  if (!result.body?.txnToken || result.body.resultInfo?.resultStatus !== 'S') {
    throw Error('Paytm could not start checkout');
  }
  return result.body.txnToken;
}

export async function verifiedPaytmStatus(config, payment) {
  const {body, head} = await paytmRequest(config, '/v3/order/status', {
    mid: config.mid, orderId: payment.orderId
  });
  if (!body || !head?.signature ||
      !checksum.verifySignature(JSON.stringify(body), config.key, head.signature)) {
    throw Error('Paytm status signature failed validation');
  }
  const status = body.resultInfo?.resultStatus;
  if (String(body.orderId) !== payment.orderId || body.mid !== config.mid) {
    // Missing identifiers on an error response are never evidence of payment.
    if (status === 'NO_RECORD_FOUND') return {status, code: body.resultInfo?.resultCode};
    throw Error('Paytm returned an unexpected order');
  }
  if (status === 'TXN_SUCCESS' &&
      (parsePaise(body.txnAmount) !== payment.amountPaise || !body.txnId ||
       (body.currency && body.currency !== 'INR'))) {
    throw Error('Paytm amount or transaction ID did not match');
  }
  return {status, code: body.resultInfo?.resultCode, txnId: body.txnId, txnDate: body.txnDate};
}

export function verifyCallback(config, data) {
  const {CHECKSUMHASH, ...fields} = data;
  return typeof CHECKSUMHASH === 'string' && checksum.verifySignature(fields, config.key, CHECKSUMHASH);
}

export function checkoutFields(config, payment, token) {
  const {mid} = config;
  const {orderId} = payment;
  const query = new URLSearchParams({mid, orderId});
  return {url: config.host + '/theia/api/v1/showPaymentPage?' + query, fields: {mid, orderId, txnToken: token}};
}
