// Outgoing e-mail over the organisation's SMTP server (SMTP_* settings in .env). Every message is
// recorded in email_log; without SMTP settings it is logged as 'not_configured' instead of sent.
const nodemailer = require('nodemailer');
const pool = require('./db');

let transport = null;
const configured = () => !!process.env.SMTP_HOST;

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  }
  return transport;
}

// Sends one message and logs the outcome. Never throws: returns the logged status.
async function send({ to, subject, text, kind, entity, entityId }) {
  let status = 'not_configured'; let error = null;
  if (configured()) {
    try {
      await getTransport().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
      status = 'sent';
    } catch (e) {
      status = 'failed'; error = String(e.message || e).slice(0, 500);
    }
  }
  await pool.query('INSERT INTO email_log (to_email, subject, body, kind, entity, entity_id, status, error) VALUES (?,?,?,?,?,?,?,?)',
    [to, subject, text, kind, entity || null, entityId == null ? null : String(entityId), status, error]);
  return status;
}

module.exports = { send, configured };
