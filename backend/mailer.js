/**
 * Minimal outbound email helper.
 *
 * Uses SMTP via nodemailer when SMTP_HOST (+ optional auth) is configured.
 * If nodemailer isn't installed or SMTP isn't configured, it degrades safely:
 * the message is logged server-side and `delivered:false` is returned. Callers
 * MUST NOT change their response based on delivery success (avoids leaking
 * whether an account/email exists).
 */
'use strict';

let _transport = null;
let _resolved = false;

function getTransport() {
  if (_resolved) return _transport;
  _resolved = true;

  const host = String(process.env.SMTP_HOST || '').trim();
  if (!host) {
    _transport = null;
    return _transport;
  }

  try {
    // Lazy require so the app runs without nodemailer installed.
    // eslint-disable-next-line global-require
    const nodemailer = require('nodemailer');
    _transport = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' }
        : undefined,
    });
  } catch (e) {
    console.warn('[mailer] SMTP_HOST set but nodemailer is not installed; emails will be logged only. Run: npm i nodemailer');
    _transport = null;
  }
  return _transport;
}

/**
 * @param {{to:string, subject:string, text?:string, html?:string}} msg
 * @returns {Promise<{delivered:boolean}>}
 */
async function sendMail(msg) {
  const to = String((msg && msg.to) || '').trim();
  const subject = String((msg && msg.subject) || '').trim();
  const fromAddress =
    String(process.env.EMAIL_FROM || process.env.SMTP_USER || '').trim() ||
    'no-reply@event-explorer.local';
  const fromName = String(process.env.EMAIL_FROM_NAME || '').trim();
  const from = fromName ? `${fromName} <${fromAddress}>` : fromAddress;

  const transport = getTransport();
  if (!transport) {
    console.log(
      '[mailer] (no SMTP configured) would send email\n  to: ' +
        to +
        '\n  subject: ' +
        subject +
        '\n  body: ' +
        String((msg && msg.text) || '').slice(0, 500),
    );
    return { delivered: false };
  }

  await transport.sendMail({
    from,
    to,
    subject,
    text: msg && msg.text ? String(msg.text) : undefined,
    html: msg && msg.html ? String(msg.html) : undefined,
  });
  return { delivered: true };
}

module.exports = { sendMail };
