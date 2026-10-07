const nodemailer = require('nodemailer');

let transport = null;
if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// Sends mail if SMTP is configured; otherwise logs it so nothing breaks in development.
// Resolves true only when the message was actually handed to the mail server.
async function sendMail({ to, subject, text, replyTo }) {
  if (!transport) { console.log(`[mail disabled] To: ${to}\nSubject: ${subject}\n${text}\n`); return false; }
  try {
    await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, replyTo });
    return true;
  } catch (e) { console.error('Mail failed:', e.message); return false; }
}
module.exports = { sendMail };
