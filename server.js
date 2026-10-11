require('dotenv').config({ quiet: true });
const express = require('express');
const session = require('express-session');
const path = require('path');
const DbSessionStore = require('./session-store');
const { locals, csrf } = require('./middleware');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
Object.assign(app.locals, require('./helpers'));
// Upload size limit in MB for a form field, for help text such as "up to 50 MB"
const { UPLOADS } = require('./storage');
app.locals.uploadMB = purpose => Math.round(UPLOADS[purpose].max / (1024 * 1024));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
// Uploaded files live in Supabase Storage (storage.js): public ones are linked directly, while evidence and policies
// are only handed out as short-lived links after a permission check in routes/portal.js and routes/admin.js

app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(session({
  store: new DbSessionStore(),
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 },
}));
// Store the session before redirecting. express-session otherwise sends the redirect while its save to the database
// is still in flight, so the browser's next request can arrive first and lose the login or the flash message.
app.use((req, res, next) => {
  const redirect = res.redirect.bind(res);
  res.redirect = (...args) => (req.session ? req.session.save(err => (err ? next(err) : redirect(...args))) : redirect(...args));
  next();
});
app.use(locals);
// CSRF for normal forms; multipart (file upload) routes run csrf after multer
app.use((req, res, next) => (req.is('multipart/form-data') ? next() : csrf(req, res, next)));

app.use('/', require('./routes/public'));
app.use('/', require('./routes/auth'));
app.use('/portal', require('./routes/portal'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('public/error', { title: 'Page not found', message: 'We couldn’t find that page. It may have moved — try the course list.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('public/error', { title: 'Something went wrong', message: 'The server hit an error. Please try again in a moment.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Horizon College site running on http://localhost:${port}`));
