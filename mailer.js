// Email goes out through Resend (https://resend.com), which suits a serverless host: one HTTPS request per send
// (or per 100 emails with sendMany), no mail-server connection to keep open. Without RESEND_API_KEY, messages are
// written to the log instead, so nothing breaks in development.
const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const TIMEOUT = 15000;

// ---------- Branded HTML version of each email ----------
// Callers write plain text; it is turned into the college's email layout here, so every email shares one look.
// Paragraphs are separated by blank lines, a line that is only a link becomes a button, and a paragraph made of
// "Label: value" lines (e.g. an enquiry's details) becomes a table. The plain text is sent alongside it.
const NAVY = '#14213D', GOLD = '#F2A93B', INK = '#1F2A44', SLATE = '#5B6478', MIST = '#F4F6FA', LINE = '#DDE2EC';
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const site = () => (process.env.SITE_URL || 'https://www.horizoncollegelondon.com').replace(/\/$/, '');
const URL_RE = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g;

// Button text for a link, from where it goes
function buttonLabel(url) {
  if (/\/set-password\//.test(url)) return 'Choose your password';
  if (/\/lessons\/\d+/.test(url)) return 'Open the assignment';
  if (/\/login\b/.test(url)) return 'Log in';
  if (/\/admin\b/.test(url)) return 'Open the admin area';
  return 'Open link';
}
const linkify = s => esc(s).replace(URL_RE, u => `<a href="${u}" style="color:${NAVY};text-decoration:underline">${u}</a>`);

function button(url) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:8px;background:${GOLD}">`
    + `<a href="${esc(url)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:700;color:${NAVY};text-decoration:none;border-radius:8px">${buttonLabel(url)}</a>`
    + `</td></tr></table>`
    + `<p style="margin:0 0 24px;font-family:${FONT};font-size:12px;line-height:1.5;color:${SLATE}">If the button doesn’t work, copy this address into your browser:<br>`
    + `<a href="${esc(url)}" style="color:${SLATE};word-break:break-all">${esc(url)}</a></p>`;
}

function detailsTable(lines) {
  const rows = lines.map(l => {
    const i = l.indexOf(':');
    return `<tr><td style="padding:10px 14px;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${SLATE};white-space:nowrap;vertical-align:top">${esc(l.slice(0, i))}</td>`
      + `<td style="padding:10px 14px;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${INK};font-weight:600">${linkify(l.slice(i + 1).trim()) || '&ndash;'}</td></tr>`;
  }).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;border:1px solid ${LINE};border-radius:8px;border-collapse:separate;background:${MIST}">${rows}</table>`;
}

const para = html => `<p style="margin:0 0 18px;font-family:${FONT};font-size:16px;line-height:1.6;color:${INK}">${html}</p>`;

function toHtml(subject, text) {
  const blocks = String(text || '').trim().split(/\n\s*\n/);
  // A last paragraph that is just the college's name is the sign-off
  const name = process.env.SITE_NAME || 'Horizon College London';
  const signOff = blocks.length > 1 && blocks[blocks.length - 1].trim() === name ? blocks.pop().trim() : '';
  const body = blocks.map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 1 && lines.every(l => /^[A-Z][\w ]{0,30}:/.test(l))) return detailsTable(lines);
    let html = '', words = [];
    for (const line of lines) {
      if (/^https?:\/\/\S+$/.test(line)) {
        if (words.length) { html += para(words.map(linkify).join('<br>')); words = []; }
        html += button(line);
      } else words.push(line);
    }
    return html + (words.length ? para(words.map(linkify).join('<br>')) : '');
  }).join('');
  const preview = esc(String(text || '').split('\n').find(l => l.trim() && !/^Hello\b/.test(l)) || subject).slice(0, 140);

  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${MIST}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preview}</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${MIST}"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px">
    <tr><td style="background:${NAVY};border-radius:12px 12px 0 0;padding:26px 32px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;padding-right:14px"><img src="${site()}/images/logo.png" width="56" height="56" alt="" style="display:block;border:0;background:#fff;border-radius:50%"></td>
        <td style="vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:21px;line-height:1.2;color:#ffffff">Horizon College<br><span style="font-family:${FONT};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${GOLD}">London</span></td>
      </tr></table>
    </td></tr>
    <tr><td style="height:4px;background:${GOLD};font-size:0;line-height:0">&nbsp;</td></tr>
    <tr><td style="background:#ffffff;padding:36px 32px 12px">
      <h1 style="margin:0 0 22px;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:400;line-height:1.3;color:${NAVY}">${esc(subject)}</h1>
      ${body}
      ${signOff ? `<p style="margin:8px 0 24px;font-family:${FONT};font-size:16px;line-height:1.6;color:${INK}">Kind regards,<br><strong style="color:${NAVY}">${esc(signOff)}</strong></p>` : ''}
    </td></tr>
    <tr><td style="background:#ffffff;border-radius:0 0 12px 12px;border-top:1px solid ${LINE};padding:20px 32px 26px;font-family:${FONT};font-size:12px;line-height:1.6;color:${SLATE}">
      ${name} · Career-focused education and regulated qualifications<br>
      <a href="${site()}" style="color:${SLATE}">${site().replace(/^https?:\/\//, '')}</a> · <a href="mailto:info@horizoncollegelondon.com" style="color:${SLATE}">info@horizoncollegelondon.com</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

// Every message: from MAIL_FROM, and replies go to REPLY_TO (e.g. the team inbox) unless the caller names someone.
// Sent as both the branded HTML and the plain text (for mail apps that don't show HTML).
function message({ to, subject, text, html, replyTo }) {
  const reply = replyTo || process.env.REPLY_TO;
  return {
    from: process.env.MAIL_FROM || 'Horizon College London <noreply@horizoncollegelondon.com>',
    to: [to], subject, text, html: html || toHtml(subject, text), ...(reply ? { replyTo: reply } : {}),
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

module.exports = { sendMail, sendMany, toHtml, enabled: !!resend };
