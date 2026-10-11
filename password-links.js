// One-time links for setting a password: used for staff/learner invitations and "forgotten password"
const crypto = require('crypto');
const { db } = require('./db');
const { sendMail } = require('./mailer');

const hash = t => crypto.createHash('sha256').update(t).digest('hex');
const HOUR = 60 * 60 * 1000;

// Issues a fresh link and cancels any earlier ones for the same account
async function createToken(userId, hours) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.tx(async t => {
    await t.run('DELETE FROM password_tokens WHERE user_id=?', userId);
    await t.run('INSERT INTO password_tokens (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)',
      hash(token), userId, Date.now() + hours * HOUR, Date.now());
  });
  return token;
}

async function findUser(token) {
  const row = await db.get('SELECT user_id, expires_at FROM password_tokens WHERE token_hash=?', hash(String(token || '')));
  if (!row || row.expires_at < Date.now()) return null;
  return (await db.get('SELECT * FROM users WHERE id=?', row.user_id)) || null;
}

async function useUp(userId) { await db.run('DELETE FROM password_tokens WHERE user_id=?', userId); }

async function recentlySent(userId, minutes) {
  return !!(await db.get('SELECT 1 FROM password_tokens WHERE user_id=? AND created_at>?', userId, Date.now() - minutes * 60 * 1000));
}

const baseUrl = req => (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const site = () => process.env.SITE_NAME || 'Horizon College London';
const roleName = r => ({ admin: 'administrator', tutor: 'tutor / assessor', student: 'learner' }[r] || r);

// Returns { sent, link } so the caller can show the link if email isn't configured
async function sendInvite(req, user) {
  const link = `${baseUrl(req)}/set-password/${await createToken(user.id, 24 * 7)}`;
  const sent = await sendMail({
    to: user.email,
    subject: `Your ${site()} account`,
    text: `Hello ${user.name},\n\nAn account has been created for you at ${site()} as a ${roleName(user.role)}.\n\n`
      + `Choose your password using this link (valid for 7 days):\n${link}\n\n`
      + `Then log in at ${baseUrl(req)}/login with this email address (${user.email}).\n\n`
      + `If you weren't expecting this, you can ignore this email.\n\n${site()}`,
  });
  return { sent, link };
}

async function sendReset(req, user) {
  const link = `${baseUrl(req)}/set-password/${await createToken(user.id, 1)}`;
  const sent = await sendMail({
    to: user.email,
    subject: `Reset your ${site()} password`,
    text: `Hello ${user.name},\n\nWe received a request to reset your password. Choose a new one using this link (valid for 1 hour):\n${link}\n\n`
      + `If you didn't ask for this, ignore this email and your password will stay the same.\n\n${site()}`,
  });
  return { sent, link };
}

module.exports = { findUser, useUp, recentlySent, sendInvite, sendReset, baseUrl };
