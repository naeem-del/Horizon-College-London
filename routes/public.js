const router = require('express').Router();
const { db } = require('../db');
const { flash } = require('../middleware');
const { sendMail } = require('../mailer');

const courseSelect = `SELECT c.*, ab.name AS body_name, ab.slug AS body_slug, ab.logo AS body_logo
  FROM courses c LEFT JOIN awarding_bodies ab ON ab.id = c.awarding_body_id`;

router.get('/', (req, res) => {
  const featured = db.prepare(`${courseSelect} WHERE c.published=1 AND c.featured=1 ORDER BY c.created_at DESC LIMIT 6`).all();
  const bodies = db.prepare(`SELECT ab.*, (SELECT COUNT(*) FROM courses c WHERE c.awarding_body_id=ab.id AND c.published=1) AS course_count
    FROM awarding_bodies ab ORDER BY ab.name`).all();
  const counts = {
    courses: db.prepare('SELECT COUNT(*) c FROM courses WHERE published=1').get().c,
    bodies: bodies.length,
  };
  res.render('public/home', { title: 'Build skills. Gain qualifications.', featured, bodies, counts });
});

router.get('/courses', (req, res) => {
  const { q = '', body = '', level = '' } = req.query;
  const where = ['c.published=1'];
  const params = {};
  if (q) { where.push('(c.title LIKE @q OR c.summary LIKE @q)'); params.q = `%${q}%`; }
  if (body) { where.push('ab.slug=@body'); params.body = body; }
  if (level) { where.push('c.level=@level'); params.level = level; }
  const courses = db.prepare(`${courseSelect} WHERE ${where.join(' AND ')} ORDER BY c.level, c.title`).all(params);
  const bodies = db.prepare('SELECT name, slug FROM awarding_bodies ORDER BY name').all();
  const levels = db.prepare("SELECT DISTINCT level FROM courses WHERE published=1 AND level IS NOT NULL AND level<>'' ORDER BY level").all().map(r => r.level);
  res.render('public/courses', { title: 'Courses', courses, bodies, levels, filters: { q, body, level } });
});

router.get('/courses/:slug', (req, res, next) => {
  const course = db.prepare(`${courseSelect} WHERE c.slug=? AND c.published=1`).get(req.params.slug);
  if (!course) return next();
  const modules = db.prepare('SELECT * FROM modules WHERE course_id=? ORDER BY position, id').all(course.id);
  const lessonCounts = db.prepare(`SELECT m.id, COUNT(l.id) n FROM modules m LEFT JOIN lessons l ON l.module_id=m.id WHERE m.course_id=? GROUP BY m.id`).all(course.id);
  const countMap = Object.fromEntries(lessonCounts.map(r => [r.id, r.n]));
  let enrolment = null;
  if (req.user) enrolment = db.prepare('SELECT * FROM enrolments WHERE user_id=? AND course_id=?').get(req.user.id, course.id);
  const related = db.prepare(`${courseSelect} WHERE c.published=1 AND c.id<>? AND c.awarding_body_id IS ? LIMIT 3`).all(course.id, course.awarding_body_id);
  res.render('public/course', { title: course.title, course, modules, countMap, enrolment, related });
});

router.get('/awarding-bodies', (req, res) => {
  const bodies = db.prepare(`SELECT ab.*, (SELECT COUNT(*) FROM courses c WHERE c.awarding_body_id=ab.id AND c.published=1) AS course_count
    FROM awarding_bodies ab ORDER BY ab.name`).all();
  res.render('public/bodies', { title: 'Awarding bodies', bodies });
});

router.get('/awarding-bodies/:slug', (req, res, next) => {
  const body = db.prepare('SELECT * FROM awarding_bodies WHERE slug=?').get(req.params.slug);
  if (!body) return next();
  const courses = db.prepare(`${courseSelect} WHERE c.published=1 AND c.awarding_body_id=? ORDER BY c.level, c.title`).all(body.id);
  res.render('public/body', { title: body.name, body, courses });
});

// Enrolment form: name, date of birth, postcode, course (+ email and phone so the team can reply)
router.get('/enrol', (req, res) => {
  const courses = db.prepare('SELECT id, title, slug FROM courses WHERE published=1 ORDER BY title').all();
  const selected = courses.find(c => c.slug === req.query.course);
  res.render('public/enrol', { title: 'Enrol', courses, selectedId: selected ? selected.id : '', values: {}, errors: [] });
});

router.post('/enrol', async (req, res) => {
  const v = {
    name: (req.body.name || '').trim(), email: (req.body.email || '').trim(), phone: (req.body.phone || '').trim(),
    dob: req.body.dob || '', postcode: (req.body.postcode || '').trim().toUpperCase(),
    course_id: Number(req.body.course_id) || null, message: (req.body.message || '').trim(),
  };
  const errors = [];
  if (!v.name) errors.push('Enter your full name.');
  if (!v.dob) errors.push('Enter your date of birth.');
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/.test(v.postcode)) errors.push('Enter a valid UK postcode, for example E1 6AN.');
  if (!v.email || !/^\S+@\S+\.\S+$/.test(v.email)) errors.push('Enter an email address so we can reply.');
  const course = v.course_id ? db.prepare('SELECT id,title FROM courses WHERE id=?').get(v.course_id) : null;
  if (!course) errors.push('Choose the course you’re interested in.');
  if (req.body.website) errors.push('Spam check failed.'); // honeypot field

  if (errors.length) {
    const courses = db.prepare('SELECT id, title, slug FROM courses WHERE published=1 ORDER BY title').all();
    return res.status(422).render('public/enrol', { title: 'Enrol', courses, selectedId: v.course_id, values: v, errors });
  }

  db.prepare('INSERT INTO enquiries (name,email,phone,dob,postcode,course_id,message) VALUES (@name,@email,@phone,@dob,@postcode,@course_id,@message)').run(v);
  if (req.user) {
    db.prepare("INSERT OR IGNORE INTO enrolments (user_id,course_id,status) VALUES (?,?,'pending')").run(req.user.id, course.id);
  }
  await sendMail({
    to: process.env.NOTIFY_EMAIL || 'info@horizoncollegelondon.com',
    replyTo: v.email,
    subject: `New enrolment enquiry: ${course.title}`,
    text: `Name: ${v.name}\nDate of birth: ${v.dob}\nPostcode: ${v.postcode}\nEmail: ${v.email}\nPhone: ${v.phone}\nCourse: ${course.title}\n\n${v.message}`,
  });
  res.render('public/enrol-done', { title: 'Enrolment received', name: v.name, course });
});

router.get('/contact', (req, res) => res.render('public/contact', { title: 'Contact' }));
router.post('/contact', async (req, res) => {
  const { name = '', email = '', message = '' } = req.body;
  if (!name.trim() || !email.trim() || !message.trim()) {
    flash(req, 'error', 'Fill in your name, email and message.');
    return res.redirect('/contact');
  }
  db.prepare('INSERT INTO enquiries (name,email,message) VALUES (?,?,?)').run(name.trim(), email.trim(), message.trim());
  await sendMail({ to: process.env.NOTIFY_EMAIL || 'info@horizoncollegelondon.com', replyTo: email, subject: `Website message from ${name}`, text: message });
  flash(req, 'success', 'Message sent. We’ll reply within one working day.');
  res.redirect('/contact');
});

module.exports = router;
