const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { flash } = require('../middleware');
const links = require('../password-links');

// Simple in-memory login throttle: 8 failed attempts per email per 15 minutes
const attempts = new Map();
function tooMany(key) {
  const a = attempts.get(key);
  if (!a) return false;
  if (Date.now() - a.first > 15 * 60 * 1000) { attempts.delete(key); return false; }
  return a.count >= 8;
}
function fail(key) {
  const a = attempts.get(key) || { count: 0, first: Date.now() };
  a.count++; attempts.set(key, a);
}

function home(user) { return user.role === 'student' ? '/portal' : '/admin'; }

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(home(req.user));
  res.render('auth/login', { title: 'Log in', email: '' });
});

router.post('/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (tooMany(email)) {
    flash(req, 'error', 'Too many attempts. Wait 15 minutes and try again.');
    return res.redirect('/login');
  }
  const user = db.prepare('SELECT * FROM users WHERE lower(email)=?').get(email);
  if (!user || !bcrypt.compareSync(req.body.password || '', user.password_hash)) {
    fail(email);
    return res.status(401).render('auth/login', { title: 'Log in', email, flash: { type: 'error', text: 'That email and password don’t match an account.' } });
  }
  attempts.delete(email);
  const returnTo = req.session.returnTo;
  req.session.regenerate(err => {
    if (err) throw err;
    req.session.userId = user.id;
    res.redirect(returnTo || home(user));
  });
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/portal');
  res.render('auth/register', { title: 'Create account', values: {}, errors: [] });
});

router.post('/register', (req, res) => {
  const v = { name: (req.body.name || '').trim(), email: (req.body.email || '').trim().toLowerCase(), phone: (req.body.phone || '').trim() };
  const errors = [];
  if (!v.name) errors.push('Enter your full name.');
  if (!/^\S+@\S+\.\S+$/.test(v.email)) errors.push('Enter a valid email address.');
  if ((req.body.password || '').length < 8) errors.push('Use a password of at least 8 characters.');
  if (req.body.password !== req.body.password2) errors.push('The two passwords don’t match.');
  if (db.prepare('SELECT 1 FROM users WHERE lower(email)=?').get(v.email)) errors.push('An account with this email already exists. Log in instead.');
  if (errors.length) return res.status(422).render('auth/register', { title: 'Create account', values: v, errors });

  const id = db.prepare("INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,'student')")
    .run(v.name, v.email, v.phone, bcrypt.hashSync(req.body.password, 12)).lastInsertRowid;
  const returnTo = req.session.returnTo;
  req.session.regenerate(() => {
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
  const user = email && db.prepare('SELECT * FROM users WHERE lower(email)=?').get(email);
  // Same response whether or not the account exists, so the form can't be used to discover emails
  if (user && !links.recentlySent(user.id, 2)) await links.sendReset(req, user);
  res.render('auth/forgot', { title: 'Forgotten password', email, done: true });
});

// ---------- Set a password from an emailed link ----------
router.get('/set-password/:token', (req, res) => {
  const user = links.findUser(req.params.token);
  res.status(user ? 200 : 410).render('auth/set-password', { title: 'Choose a password', who: user, token: req.params.token, errors: [] });
});

router.post('/set-password/:token', (req, res) => {
  const user = links.findUser(req.params.token);
  if (!user) return res.status(410).render('auth/set-password', { title: 'Choose a password', who: null, token: '', errors: [] });
  const errors = [];
  if ((req.body.password || '').length < 8) errors.push('Use a password of at least 8 characters.');
  if (req.body.password !== req.body.password2) errors.push('The two passwords don’t match.');
  if (errors.length) return res.status(422).render('auth/set-password', { title: 'Choose a password', who: user, token: req.params.token, errors });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(req.body.password, 12), user.id);
  links.useUp(user.id);
  req.session.regenerate(err => {
    if (err) throw err;
    req.session.userId = user.id;
    req.session.flash = { type: 'success', text: 'Your password is set and you’re logged in.' };
    res.redirect(home(user));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
