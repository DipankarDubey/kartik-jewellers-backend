import nodemailer from 'nodemailer';

export function mailTransport(env = process.env) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const fromAddress = env.RESEND_FROM?.trim() || env.SMTP_FROM;
  if (apiKey && fromAddress) {
    return {
      async sendMail({to, subject, text, html, replyTo, attachments, messageId}) {
        const body = {from: fromAddress, to: Array.isArray(to) ? to : [to], subject, text, html};
        if (replyTo) body.reply_to = replyTo;
        if (attachments?.length) body.attachments = attachments.map(({filename, href}) => ({filename, path: href}));
        const headers = {Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json'};
        if (messageId) headers['Idempotency-Key'] = messageId;
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw Error('Email provider rejected the message');
        return response.json();
      }
    };
  }
  if (!env.SMTP_HOST || !env.SMTP_FROM) throw Error('SMTP_NOT_CONFIGURED');
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true',
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000,
    auth: env.SMTP_USER ? {user: env.SMTP_USER, pass: env.SMTP_PASSWORD} : undefined
  });
  return transport;
}
