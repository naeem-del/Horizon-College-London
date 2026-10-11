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

function makeUpload(folder, allowed) {
  return multer({
    storage: multer.diskStorage({
      destination: path.join(__dirname, '..', 'uploads', folder),
      filename: (req, file, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + path.extname(file.originalname).toLowerCase()),
    }),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, allowed.includes(path.extname(file.originalname).toLowerCase())),
  });
}
const uploadImage = makeUpload('images', ['.jpg', '.jpeg', '.png', '.webp', '.svg']);
const uploadEvidence = makeUpload('evidence', ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.xlsx', '.pptx', '.mp4', '.zip']);
const uploadFile = makeUpload('files', ['.pdf', '.doc', '.docx', '.xlsx', '.pptx', '.zip']);
const uploadPhoto = makeUpload('images', ['.jpg', '.jpeg', '.png', '.webp']);
const uploadPolicy = makeUpload('policies', ['.pdf', '.doc', '.docx']);

// Lesson form: a downloadable resource, a video file and/or a SCORM package, each with its own folder and file types
// (SCORM zips land in uploads/scorm and are unzipped into their own folder by scorm.js)
const lessonTypes = { attachment: ['files', ['.pdf', '.doc', '.docx', '.xlsx', '.pptx', '.zip']], video: ['videos', ['.mp4', '.webm', '.mov']], scorm: ['scorm', ['.zip']] };
const uploadLesson = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads', lessonTypes[file.fieldname][0])),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!lessonTypes[file.fieldname] && lessonTypes[file.fieldname][1].includes(path.extname(file.originalname).toLowerCase())),
}).fields([{ name: 'attachment', maxCount: 1 }, { name: 'video', maxCount: 1 }, { name: 'scorm', maxCount: 1 }]);

// Course form: a cover image and, when the course is created from a SCORM package, the package zip
const courseTypes = { image: ['images', ['.jpg', '.jpeg', '.png', '.webp', '.svg']], scorm: ['scorm', ['.zip']] };
const uploadCourse = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads', courseTypes[file.fieldname][0])),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!courseTypes[file.fieldname] && courseTypes[file.fieldname][1].includes(path.extname(file.originalname).toLowerCase())),
}).fields([{ name: 'image', maxCount: 1 }, { name: 'scorm', maxCount: 1 }]);

module.exports = { locals, flash, csrf, requireLogin, requireRole, uploadImage, uploadEvidence, uploadFile, uploadPhoto, uploadLesson, uploadPolicy, uploadCourse };
