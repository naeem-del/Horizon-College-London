const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { flash } = require('../middleware');
const links = require('../password-links');

// Login throttle: 8 failed attempts per email per 15 minutes. Kept in the database so every server instance shares it.
const WINDOW = "interval '15 minutes'";
const tooMany = async key => !!(await db.get(`SELECT 1 FROM login_attempts WHERE key=? AND count>=8 AND first_at > now() - ${WINDOW}`, key));
// Counts a failure, starting a fresh 15-minute window when the last one has run out
const fail = key => db.run(`INSERT INTO login_attempts (key,count,first_at) VALUES (?,1,now())
  ON CONFLICT (key) DO UPDATE SET
    count = CASE WHEN login_attempts.first_at <= now() - ${WINDOW} THEN 1 ELSE login_attempts.count + 1 END,
    first_at = CASE WHEN login_attempts.first_at <= now() - ${WINDOW} THEN now() ELSE login_attempts.first_at END`, key);
const clearAttempts = key => db.run('DELETE FROM login_attempts WHERE key=?', key);

function home(user) { return user.role === 'student' ? '/portal' : '/admin'; }

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(home(req.user));
  res.render('auth/login', { title: 'Log in', email: '' });
});

router.post('/login', async (req, res, next) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (await tooMany(email)) {
    flash(req, 'error', 'Too many attempts. Wait 15 minutes and try again.');
    return res.redirect('/login');
  }
  const user = await db.get('SELECT * FROM users WHERE lower(email)=?', email);
  if (!user || !bcrypt.compareSync(req.body.password || '', user.password_hash)) {
    await fail(email);
    return res.status(401).render('auth/login', { title: 'Log in', email, flash: { type: 'error', text: 'That email and password don’t match an account.' } });
  }
  await clearAttempts(email);
  const returnTo = req.session.returnTo;
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.userId = user.id;
    res.redirect(returnTo || home(user));
  });
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/portal');
  res.render('auth/register', { title: 'Create account', values: {}, errors: [] });
});

router.post('/register', async (req, res, next) => {
  const v = { name: (req.body.name || '').trim(), email: (req.body.email || '').trim().toLowerCase(), phone: (req.body.phone || '').trim() };
  const errors = [];
  if (!v.name) errors.push('Enter your full name.');
  if (!/^\S+@\S+\.\S+$/.test(v.email)) errors.push('Enter a valid email address.');
  if ((req.body.password || '').length < 8) errors.push('Use a password of at least 8 characters.');
  if (req.body.password !== req.body.password2) errors.push('The two passwords don’t match.');
  const taken = 'An account with this email already exists. Log in instead.';
  if (await db.get('SELECT 1 FROM users WHERE lower(email)=?', v.email)) errors.push(taken);
  if (errors.length) return res.status(422).render('auth/register', { title: 'Create account', values: v, errors });

  let id;
  try {
    id = (await db.get("INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,'student') RETURNING id",
      v.name, v.email, v.phone, bcrypt.hashSync(req.body.password, 12))).id;
  } catch (err) {
    // Two sign-ups with the same email at the same moment: the second hits the unique index
    if (db.isUnique(err)) return res.status(422).render('auth/register', { title: 'Create account', values: v, errors: [taken] });
    throw err;
  }
  const returnTo = req.session.returnTo;
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.userId = id;
    req.session.flash = { type: 'success', text: 'Account created. Welcome to your student portal.' };
    res.redirect(returnTo || '/portal');
  });
});

// ---------- Forgotten password ----------
router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot', { title: 'Forgotten password', email: '', done: false });
});

router.post('/forgot-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const user = email && await db.get('SELECT * FROM users WHERE lower(email)=?', email);
  // Same response whether or not the account exists, so the form can't be used to discover emails
  if (user && !(await links.recentlySent(user.id, 2))) await links.sendReset(req, user);
  res.render('auth/forgot', { title: 'Forgotten password', email, done: true });
});

// ---------- Set a password from an emailed link ----------
router.get('/set-password/:token', async (req, res) => {
  const user = await links.findUser(req.params.token);
  res.status(user ? 200 : 410).render('auth/set-password', { title: 'Choose a password', who: user, token: req.params.token, errors: [] });
});

router.post('/set-password/:token', async (req, res, next) => {
  const user = await links.findUser(req.params.token);
  if (!user) return res.status(410).render('auth/set-password', { title: 'Choose a password', who: null, token: '', errors: [] });
  const errors = [];
  if ((req.body.password || '').length < 8) errors.push('Use a password of at least 8 characters.');
  if (req.body.password !== req.body.password2) errors.push('The two passwords don’t match.');
  if (errors.length) return res.status(422).render('auth/set-password', { title: 'Choose a password', who: user, token: req.params.token, errors });
  await db.run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(req.body.password, 12), user.id);
  await links.useUp(user.id);
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.userId = user.id;
    req.session.flash = { type: 'success', text: 'Your password is set and you’re logged in.' };
    res.redirect(home(user));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
