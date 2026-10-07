const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireLogin, flash, csrf, uploadEvidence } = require('../middleware');
const learning = require('../learning');
const scorm = require('../scorm');

router.use(requireLogin);

const isStaff = req => req.user.role !== 'student';
const progress = (req, courseId) => learning.progress(req.user.id, courseId, isStaff(req));
const outline = (req, courseId) => learning.outline(req.user.id, courseId, isStaff(req));

function loadCourseForLearner(req, slug) {
  const course = db.prepare(`SELECT c.*, ab.name body_name FROM courses c LEFT JOIN awarding_bodies ab ON ab.id=c.awarding_body_id WHERE c.slug=?`).get(slug);
  if (!course) return {};
  const staff = req.user.role !== 'student';
  const enrolment = db.prepare('SELECT * FROM enrolments WHERE user_id=? AND course_id=?').get(req.user.id, course.id);
  const allowed = staff || (enrolment && ['active', 'completed'].includes(enrolment.status));
  return { course, enrolment, allowed };
}

router.get('/', (req, res) => {
  const enrolments = db.prepare(`SELECT e.*, c.title, c.slug, c.level, c.image, ab.name body_name FROM enrolments e
    JOIN courses c ON c.id=e.course_id LEFT JOIN awarding_bodies ab ON ab.id=c.awarding_body_id
    WHERE e.user_id=? ORDER BY e.created_at DESC`).all(req.user.id);
  // Assignments still to hand in, soonest deadline first
  const deadlines = [];
  for (const e of enrolments) {
    e.progress = progress(req, e.course_id);
    if (!['active', 'completed'].includes(e.status)) continue;
    for (const l of learning.visibleLessons(req.user.id, e.course_id)) {
      if (l.due && !['submitted', 'accepted'].includes(l.sub_status)) deadlines.push({ ...l, course_title: e.title, course_slug: e.slug });
    }
  }
  deadlines.sort((a, b) => a.due.localeCompare(b.due));
  const feedback = db.prepare(`SELECT s.*, l.title lesson_title, l.total_marks, c.title course_title, c.slug course_slug FROM submissions s
    JOIN lessons l ON l.id=s.lesson_id JOIN modules m ON m.id=l.module_id JOIN courses c ON c.id=m.course_id
    WHERE s.user_id=? AND s.reviewed_at IS NOT NULL ORDER BY s.reviewed_at DESC LIMIT 5`).all(req.user.id);
  res.render('portal/dashboard', { title: 'My learning', enrolments, feedback, deadlines });
});

router.get('/courses/:slug', (req, res, next) => {
  const { course, enrolment, allowed } = loadCourseForLearner(req, req.params.slug);
  if (!course) return next();
  if (!allowed) {
    flash(req, 'info', enrolment ? 'Your enrolment is being reviewed. We’ll email you when your course opens.' : 'Enrol on this course to access its lessons.');
    return res.redirect(enrolment ? '/portal' : `/courses/${course.slug}`);
  }
  const { modules, flat } = outline(req, course.id);
  const next_ = flat.find(l => !l.done) || flat[0];
  res.render('portal/course', { title: course.title, course, modules, prog: progress(req, course.id), nextLesson: next_ });
});

router.get('/courses/:slug/lessons/:id', (req, res, next) => {
  const { course, allowed } = loadCourseForLearner(req, req.params.slug);
  if (!course) return next();
  if (!allowed) return res.redirect(`/courses/${course.slug}`);
  const { modules, flat } = outline(req, course.id);
  const idx = flat.findIndex(l => l.id === Number(req.params.id));
  if (idx === -1) return next();
  const lesson = flat[idx];
  const submissions = db.prepare('SELECT * FROM submissions WHERE user_id=? AND lesson_id=? ORDER BY id DESC').all(req.user.id, lesson.id);
  let scormData = null;
  if (lesson.scorm_folder) {
    const attempt = db.prepare('SELECT cmi FROM scorm_attempts WHERE user_id=? AND lesson_id=?').get(req.user.id, lesson.id);
    const me = db.prepare('SELECT name, first_name, last_name FROM users WHERE id=?').get(req.user.id);
    scormData = {
      version: lesson.scorm_version, saved: attempt ? JSON.parse(attempt.cmi) : {},
      learner: { id: String(req.user.id), name: me.last_name ? `${me.last_name}, ${me.first_name || ''}`.trim() : me.name },
      commitUrl: `/portal/scorm/${lesson.id}/commit`, csrf: req.session.csrf, done: !!lesson.done,
      // Where a SCORM 2004 package's own Next / Previous buttons (adl.nav.request) take the learner
      nextUrl: flat[idx + 1] ? `/portal/courses/${course.slug}/lessons/${flat[idx + 1].id}` : '',
      prevUrl: flat[idx - 1] ? `/portal/courses/${course.slug}/lessons/${flat[idx - 1].id}` : '',
      exitUrl: `/portal/courses/${course.slug}`,
    };
  }
  res.render('portal/lesson', {
    title: lesson.title, course, modules, lesson, submissions, scormData,
    prev: flat[idx - 1], next: flat[idx + 1], prog: progress(req, course.id),
  });
});

// Records a lesson as done and completes the enrolment once every lesson is done
function markDone(req, courseId, lessonId) {
  db.prepare('INSERT OR IGNORE INTO lesson_progress (user_id,lesson_id) VALUES (?,?)').run(req.user.id, lessonId);
  const p = progress(req, courseId);
  if (p.total && p.done === p.total) {
    db.prepare("UPDATE enrolments SET status='completed' WHERE user_id=? AND course_id=? AND status='active'").run(req.user.id, courseId);
  }
}

router.post('/courses/:slug/lessons/:id/complete', (req, res, next) => {
  const { course, allowed } = loadCourseForLearner(req, req.params.slug);
  if (!course || !allowed) return next();
  const { flat } = outline(req, course.id);
  const idx = flat.findIndex(l => l.id === Number(req.params.id));
  if (idx === -1) return next();
  // SCORM lessons are completed by the package itself, not by the button
  if (flat[idx].scorm_folder) return res.redirect(`/portal/courses/${course.slug}/lessons/${flat[idx].id}`);
  if (req.body.undo) db.prepare('DELETE FROM lesson_progress WHERE user_id=? AND lesson_id=?').run(req.user.id, flat[idx].id);
  else markDone(req, course.id, flat[idx].id);
  const nextL = flat[idx + 1];
  res.redirect(!req.body.undo && nextL ? `/portal/courses/${course.slug}/lessons/${nextL.id}` : `/portal/courses/${course.slug}/lessons/${flat[idx].id}`);
});

// Multer has already saved the file by the time we know the upload isn't allowed, so remove it
const discardUpload = req => { if (req.file) fs.unlink(req.file.path, () => {}); };
router.post('/courses/:slug/lessons/:id/submit', uploadEvidence.single('file'), csrf, (req, res, next) => {
  const { course, allowed } = loadCourseForLearner(req, req.params.slug);
  if (!course || !allowed) { discardUpload(req); return next(); }
  const lesson = outline(req, course.id).flat.find(l => l.id === Number(req.params.id) && l.kind === 'assignment');
  if (!lesson) { discardUpload(req); return next(); }
  if (!req.file) {
    flash(req, 'error', 'Choose a file to upload. Accepted: PDF, Word, Excel, PowerPoint, images, MP4 or ZIP, up to 20 MB.');
    return res.redirect(req.originalUrl.replace(/\/submit$/, ''));
  }
  db.prepare('INSERT INTO submissions (user_id,lesson_id,file,original_name,note) VALUES (?,?,?,?,?)')
    .run(req.user.id, lesson.id, req.file.filename, req.file.originalname, (req.body.note || '').trim());
  db.prepare('INSERT OR IGNORE INTO lesson_progress (user_id,lesson_id) VALUES (?,?)').run(req.user.id, lesson.id);
  flash(req, 'success', 'Evidence uploaded. Your assessor will review it and leave feedback here.');
  res.redirect(`/portal/courses/${course.slug}/lessons/${lesson.id}`);
});

// ---------- SCORM ----------
// A SCORM lesson the user may open: staff, or a learner with an active/completed enrolment on its course
function scormLesson(req) {
  const l = db.prepare(`SELECT l.id, l.scorm_folder, l.scorm_version, c.slug FROM lessons l JOIN modules m ON m.id=l.module_id
    JOIN courses c ON c.id=m.course_id WHERE l.id=? AND l.kind='lesson' AND l.scorm_folder IS NOT NULL`).get(req.params.id);
  return l && loadCourseForLearner(req, l.slug).allowed ? l : null;
}

// Package files are served from our own site (not /uploads) so the package can reach the player's SCORM API
router.get('/scorm/:id/content/*file', (req, res, next) => {
  const l = scormLesson(req);
  if (!l) return next();
  res.sendFile([].concat(req.params.file).join('/'), { root: path.join(scorm.ROOT, l.scorm_folder) }, err => {
    if (err && !res.headersSent) res.status(err.status || 404).end();
  });
});

// The player posts the package's whole data model here on commit, finish and when the page closes
router.post('/scorm/:id/commit', (req, res) => {
  const l = scormLesson(req);
  if (!l) return res.status(404).json({ ok: false });
  let cmi;
  try { cmi = JSON.parse(req.body.data || '{}'); } catch { return res.status(400).json({ ok: false }); }
  if (!cmi || typeof cmi !== 'object' || Array.isArray(cmi)) return res.status(400).json({ ok: false });
  const clean = {};
  for (const [k, v] of Object.entries(cmi)) if (/^(cmi|adl)\./.test(k) && k.length < 256) clean[k] = String(v).slice(0, 65536);
  const sum = scorm.summarise(l.scorm_version, clean);
  db.prepare(`INSERT INTO scorm_attempts (user_id,lesson_id,cmi,status,score,total_time,updated_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(user_id,lesson_id) DO UPDATE SET cmi=excluded.cmi, status=excluded.status, score=excluded.score, total_time=excluded.total_time, updated_at=CURRENT_TIMESTAMP`)
    .run(req.user.id, l.id, JSON.stringify(clean), sum.status, sum.score, sum.time);
  const courseId = db.prepare('SELECT m.course_id FROM lessons l JOIN modules m ON m.id=l.module_id WHERE l.id=?').get(l.id).course_id;
  if (sum.complete) markDone(req, courseId, l.id);
  res.json({ ok: true, complete: sum.complete, status: sum.status });
});

// Evidence files are private: owner or staff only
router.get('/evidence/:id', (req, res, next) => {
  const s = db.prepare('SELECT * FROM submissions WHERE id=?').get(req.params.id);
  if (!s || (s.user_id !== req.user.id && req.user.role === 'student')) return next();
  res.download(path.join(__dirname, '..', 'uploads', 'evidence', s.file), s.original_name, err => {
    if (err && !res.headersSent) res.status(404).render('public/error', { title: 'File not found', message: 'This evidence file is no longer on the server.' });
  });
});

// ---------- Policies ----------
const policyAudiences = req => (req.user.role === 'student' ? ['all', 'learners'] : req.user.role === 'admin' ? ['all', 'staff', 'learners'] : ['all', 'staff']);
router.get('/policies', (req, res) => {
  const aud = policyAudiences(req);
  const policies = db.prepare(`SELECT * FROM policies WHERE audience IN (${aud.map(() => '?').join(',')}) ORDER BY title`).all(...aud);
  res.render('portal/policies', { title: 'Policies', policies });
});
// PDFs open in the browser; Word files download
router.get('/policies/:id/file', (req, res, next) => {
  const p = db.prepare('SELECT * FROM policies WHERE id=?').get(req.params.id);
  if (!p || !policyAudiences(req).includes(p.audience)) return next();
  const file = path.join(__dirname, '..', 'uploads', 'policies', p.file);
  const name = p.original_name || `${p.title}${path.extname(p.file)}`;
  const done = err => { if (err && !res.headersSent) res.status(404).render('public/error', { title: 'File not found', message: 'This policy file is no longer on the server.' }); };
  if (path.extname(p.file) === '.pdf') {
    res.setHeader('Content-Disposition', `inline; filename="${name.replace(/[^\w.\- ]/g, '_')}"`);
    return res.sendFile(file, done);
  }
  res.download(file, name, done);
});

router.get('/profile', (req, res) => {
  const me = db.prepare('SELECT id,name,email,phone,dob,postcode FROM users WHERE id=?').get(req.user.id);
  res.render('portal/profile', { title: 'My details', me });
});

router.post('/profile', (req, res) => {
  const { name = '', phone = '', dob = '', postcode = '', password = '', password2 = '' } = req.body;
  if (!name.trim()) { flash(req, 'error', 'Your name can’t be empty.'); return res.redirect('/portal/profile'); }
  db.prepare('UPDATE users SET name=?, phone=?, dob=?, postcode=? WHERE id=?').run(name.trim(), phone.trim(), dob, postcode.trim().toUpperCase(), req.user.id);
  if (password) {
    if (password.length < 8 || password !== password2) { flash(req, 'error', 'Details saved, but the password wasn’t changed: use 8+ characters and type it twice.'); return res.redirect('/portal/profile'); }
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 12), req.user.id);
  }
  flash(req, 'success', 'Details saved.');
  res.redirect('/portal/profile');
});

module.exports = router;
