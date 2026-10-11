// Email goes out through Resend (https://resend.com), which suits a serverless host: one HTTPS request per send
// (or per 100 emails with sendMany), no mail-server connection to keep open. Without RESEND_API_KEY, messages are
// written to the log instead, so nothing breaks in development.
const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const TIMEOUT = 15000;

// Every message: from MAIL_FROM, and replies go to REPLY_TO (e.g. the team inbox) unless the caller names someone
function message({ to, subject, text, replyTo }) {
  const reply = replyTo || process.env.REPLY_TO;
  return {
    from: process.env.MAIL_FROM || 'Horizon College London <noreply@horizoncollegelondon.com>',
    to: [to], subject, text, ...(reply ? { replyTo: reply } : {}),
  };
}

// Give up on a slow request instead of holding up the page
const withTimeout = promise => Promise.race([
  promise,
  new Promise(resolve => setTimeout(() => resolve({ error: { message: `no answer from Resend within ${TIMEOUT / 1000}s` } }), TIMEOUT).unref()),
]);

// Sends one email. Resolves true only when Resend accepted it.
async function sendMail(msg) {
  if (!resend) { console.log(`[mail disabled] To: ${msg.to}\nSubject: ${msg.subject}\n${msg.text}\n`); return false; }
  try {
    const { error } = await withTimeout(resend.emails.send(message(msg)));
    if (error) { console.error(`Mail to ${msg.to} failed: ${error.message}`); return false; }
    return true;
  } catch (e) { console.error(`Mail to ${msg.to} failed: ${e.message}`); return false; }
}

// Sends many emails (e.g. a new assignment to a whole class) 100 per request. Resolves to how many were accepted.
async function sendMany(msgs) {
  if (!resend) { for (const m of msgs) await sendMail(m); return 0; }
  let sent = 0;
  for (let i = 0; i < msgs.length; i += 100) {
    const chunk = msgs.slice(i, i + 100);
    try {
      const { error } = await withTimeout(resend.batch.send(chunk.map(message)));
      if (error) console.error(`Batch of ${chunk.length} emails failed: ${error.message}`);
      else sent += chunk.length;
    } catch (e) { console.error(`Batch of ${chunk.length} emails failed: ${e.message}`); }
  }
  return sent;
}

module.exports = { sendMail, sendMany, enabled: !!resend };
