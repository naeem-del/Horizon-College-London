const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const { db } = require('../db');

// Attach the logged-in user, flash messages and CSRF token to every view
async function locals(req, res, next) {
  res.locals.user = null;
  if (req.session.userId) {
    res.locals.user = (await db.get('SELECT id,name,email,role,photo FROM users WHERE id=?', req.session.userId)) || null;
    if (!res.locals.user) delete req.session.userId;
  }
  req.user = res.locals.user;
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.path = req.path;
  res.locals.siteName = process.env.SITE_NAME || 'Horizon College London';
  next();
}

function flash(req, type, text) { req.session.flash = { type, text }; }

// Checked after multer so multipart forms work too
function csrf(req, res, next) {
  if (req.method !== 'POST') return next();
  const token = req.body && req.body._csrf;
  if (!token || token !== req.session.csrf) {
    return res.status(403).render('public/error', { title: 'Form expired', message: 'This form has expired. Go back, refresh the page and try again.' });
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) { req.session.returnTo = req.originalUrl; return res.redirect('/login'); }
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) { req.session.returnTo = req.originalUrl; return res.redirect('/login'); }
    if (!roles.includes(req.user.role)) return res.status(403).render('public/error', { title: 'No access', message: 'Your account does not have access to this area.' });
    next();
  };
}

// SCORM packages are still sent to the server and unzipped here (every other file goes straight to storage,
// see storage.js). The zip lands in uploads/scorm and scorm.js unzips it into its own folder.
const uploadScorm = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'uploads', 'scorm'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.zip'),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.fieldname === 'scorm' && path.extname(file.originalname).toLowerCase() === '.zip'),
}).single('scorm');

module.exports = { locals, flash, csrf, requireLogin, requireRole, uploadScorm };
