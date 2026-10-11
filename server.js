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

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.use('/uploads/images', express.static(path.join(__dirname, 'uploads', 'images')));
app.use('/uploads/files', express.static(path.join(__dirname, 'uploads', 'files')));
app.use('/uploads/videos', express.static(path.join(__dirname, 'uploads', 'videos')));
// Evidence uploads are NOT public — they are served through a permission check in routes/portal.js and routes/admin.js

app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(session({
  store: new DbSessionStore(),
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 },
}));
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
