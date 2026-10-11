const router = require('express').Router();
const path = require('path');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireLogin, flash } = require('../middleware');
const storage = require('../storage');
const learning = require('../learning');
const scorm = require('../scorm');

router.use(requireLogin);

const isStaff = req => req.user.role !== 'student';
const progress = (req, courseId) => learning.progress(req.user.id, courseId, isStaff(req));
const outline = (req, courseId) => learning.outline(req.user.id, courseId, isStaff(req));
// Progress from an outline already loaded for the page, saving a second query
const progressOf = flat => {
  const done = flat.filter(l => l.done).length;
  return { total: flat.length, done, pct: flat.length ? Math.round((done / flat.length) * 100) : 0 };
};

// Sends a learner who tries to open a locked module back to the course page, saying which module to finish first
function refuseLocked(req, res, course, lesson) {
  flash(req, 'info', `“${lesson.title}” opens once you’ve finished the module “${lesson.blockedBy}”.`);
  return res.redirect(`/portal/courses/${course.slug}`);
}

async function loadCourseForLearner(req, slug) {
  const course = await db.get('SELECT c.*, ab.name body_name FROM courses c LEFT JOIN awarding_bodies ab ON ab.id=c.awarding_body_id WHERE c.slug=?', slug);
  if (!course) return {};
  const staff = req.user.role !== 'student';
  const enrolment = await db.get('SELECT * FROM enrolments WHERE user_id=? AND course_id=?', req.user.id, course.id);
  const allowed = staff || (enrolment && ['active', 'completed'].includes(enrolment.status));
  return { course, enrolment, allowed };
}

router.get('/', async (req, res) => {
  const [enrolments, feedback] = await Promise.all([
    db.all(`SELECT e.*, c.title, c.slug, c.level, c.image, ab.name body_name FROM enrolments e
      JOIN courses c ON c.id=e.course_id LEFT JOIN awarding_bodies ab ON ab.id=c.awarding_body_id
      WHERE e.user_id=? ORDER BY e.created_at DESC`, req.user.id),
    db.all(`SELECT s.*, l.title lesson_title, l.total_marks, c.title course_title, c.slug course_slug FROM submissions s
      JOIN lessons l ON l.id=s.lesson_id JOIN modules m ON m.id=l.module_id JOIN courses c ON c.id=m.course_id
      WHERE s.user_id=? AND s.reviewed_at IS NOT NULL ORDER BY s.reviewed_at DESC LIMIT 5`, req.user.id),
  ]);
  // Assignments still to hand in, soonest deadline first
  const deadlines = [];
  await Promise.all(enrolments.map(async e => {
    const lessons = await learning.visibleLessons(req.user.id, e.course_id);
    e.progress = isStaff(req) ? await progress(req, e.course_id) : progressOf(lessons);
    if (!['active', 'completed'].includes(e.status)) return;
    for (const l of lessons) {
      if (l.due && !['submitted', 'accepted'].includes(l.sub_status)) deadlines.push({ ...l, course_title: e.title, course_slug: e.slug });
    }
  }));
  deadlines.sort((a, b) => a.due.localeCompare(b.due));
  res.render('portal/dashboard', { title: 'My learning', enrolments, feedback, deadlines });
});

router.get('/courses/:slug', async (req, res, next) => {
  const { course, enrolment, allowed } = await loadCourseForLearner(req, req.params.slug);
  if (!course) return next();
  if (!allowed) {
    flash(req, 'info', enrolment ? 'Your enrolment is being reviewed. We’ll email you when your course opens.' : 'Enrol on this course to access its lessons.');
    return res.redirect(enrolment ? '/portal' : `/courses/${course.slug}`);
  }
  const { modules, flat } = await outline(req, course.id);
  const next_ = flat.find(l => !l.done) || flat[0];
  res.render('portal/course', { title: course.title, course, enrolment, modules, prog: progressOf(flat), nextLesson: next_ });
});

router.get('/courses/:slug/lessons/:id', async (req, res, next) => {
  const { course, allowed } = await loadCourseForLearner(req, req.params.slug);
  if (!course) return next();
  if (!allowed) return res.redirect(`/courses/${course.slug}`);
  const { modules, flat } = await outline(req, course.id);
  const idx = flat.findIndex(l => l.id === Number(req.params.id));
  if (idx === -1) return next();
  const lesson = flat[idx];
  if (lesson.locked) return refuseLocked(req, res, course, lesson);
  const submissions = await db.all('SELECT * FROM submissions WHERE user_id=? AND lesson_id=? ORDER BY id DESC', req.user.id, lesson.id);
  let scormData = null;
  if (lesson.scorm_folder) {
    const [attempt, me] = await Promise.all([
      db.get('SELECT cmi FROM scorm_attempts WHERE user_id=? AND lesson_id=?', req.user.id, lesson.id),
      db.get('SELECT name, first_name, last_name FROM users WHERE id=?', req.user.id),
    ]);
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
    prev: flat[idx - 1], next: flat[idx + 1], prog: progressOf(flat),
  });
});

// Records a lesson as done and completes the enrolment once every lesson is done
async function markDone(req, courseId, lessonId) {
  await db.run('INSERT INTO lesson_progress (user_id,lesson_id) VALUES (?,?) ON CONFLICT DO NOTHING', req.user.id, lessonId);
  const p = await progress(req, courseId);
  if (p.total && p.done === p.total) {
    await db.run("UPDATE enrolments SET status='completed' WHERE user_id=? AND course_id=? AND status='active'", req.user.id, courseId);
  }
}

router.post('/courses/:slug/lessons/:id/complete', async (req, res, next) => {
  const { course, allowed } = await loadCourseForLearner(req, req.params.slug);
  if (!course || !allowed) return next();
  const { flat } = await outline(req, course.id);
  const idx = flat.findIndex(l => l.id === Number(req.params.id));
  if (idx === -1) return next();
  if (flat[idx].locked) return refuseLocked(req, res, course, flat[idx]);
  // SCORM lessons are completed by the package itself, not by the button
  if (flat[idx].scorm_folder) return res.redirect(`/portal/courses/${course.slug}/lessons/${flat[idx].id}`);
  if (req.body.undo) await db.run('DELETE FROM lesson_progress WHERE user_id=? AND lesson_id=?', req.user.id, flat[idx].id);
  else await markDone(req, course.id, flat[idx].id);
  // Look again: finishing this lesson may have just opened the next module
  const nextL = (await outline(req, course.id)).flat[idx + 1];
  res.redirect(!req.body.undo && nextL && !nextL.locked ? `/portal/courses/${course.slug}/lessons/${nextL.id}` : `/portal/courses/${course.slug}/lessons/${flat[idx].id}`);
});

// The assignment a learner may hand evidence in for: on their course, set for them, and in a module that's open
async function evidenceTask(req) {
  const { course, allowed } = await loadCourseForLearner(req, req.params.slug);
  if (!course || !allowed) return {};
  const lesson = (await outline(req, course.id)).flat.find(l => l.id === Number(req.params.id) && l.kind === 'assignment');
  return { course, lesson };
}

// Signs a one-time storage link for the evidence file the browser is about to upload (see public/js/direct-upload.js)
router.post('/courses/:slug/lessons/:id/upload-url', async (req, res) => {
  const { lesson } = await evidenceTask(req);
  if (!lesson || lesson.locked || req.body.purpose !== 'evidence') return res.status(403).json({ error: 'You can’t upload evidence for this task.' });
  const problem = storage.refuse('evidence', req.body.filename, Number(req.body.size));
  if (problem) return res.status(422).json({ error: problem });
  res.json(await storage.signUpload('evidence', req.body.filename));
});

router.post('/courses/:slug/lessons/:id/submit', async (req, res, next) => {
  const file = await storage.receive(req.body, 'evidence');
  // The file is already in storage by the time we know the hand-in isn't allowed, so remove it
  const discard = () => storage.remove('evidence', file && file.filename);
  const { course, lesson } = await evidenceTask(req);
  if (!lesson) { await discard(); return next(); }
  if (lesson.locked) { await discard(); return refuseLocked(req, res, course, lesson); }
  if (!file) {
    flash(req, 'error', 'Choose a file to upload. Accepted: PDF, Word, Excel, PowerPoint, images, MP4 or ZIP, up to 20 MB.');
    return res.redirect(req.originalUrl.replace(/\/submit$/, ''));
  }
  await db.tx(async t => {
    await t.run('INSERT INTO submissions (user_id,lesson_id,file,original_name,note) VALUES (?,?,?,?,?)',
      req.user.id, lesson.id, file.filename, file.originalname, (req.body.note || '').trim());
    await t.run('INSERT INTO lesson_progress (user_id,lesson_id) VALUES (?,?) ON CONFLICT DO NOTHING', req.user.id, lesson.id);
  });
  flash(req, 'success', 'Evidence uploaded. Your assessor will review it and leave feedback here.');
  res.redirect(`/portal/courses/${course.slug}/lessons/${lesson.id}`);
});

// ---------- SCORM ----------
// A SCORM lesson the user may open: staff, or a learner with an active/completed enrolment on its course whose module is open
async function scormLesson(req) {
  const l = await db.get(`SELECT l.id, l.scorm_folder, l.scorm_version, c.id course_id, c.slug FROM lessons l JOIN modules m ON m.id=l.module_id
    JOIN courses c ON c.id=m.course_id WHERE l.id=? AND l.kind='lesson' AND l.scorm_folder IS NOT NULL`, Number(req.params.id) || 0);
  if (!l) return null;
  const { course, allowed } = await loadCourseForLearner(req, l.slug);
  if (!allowed) return null;
  const own = (await outline(req, course.id)).flat.find(x => x.id === l.id);
  return own && !own.locked ? l : null;
}

// Package files are served from our own site (not /uploads) so the package can reach the player's SCORM API
router.get('/scorm/:id/content/*file', async (req, res, next) => {
  const l = await scormLesson(req);
  if (!l) return next();
  res.sendFile([].concat(req.params.file).join('/'), { root: path.join(scorm.ROOT, l.scorm_folder) }, err => {
    if (err && !res.headersSent) res.status(err.status || 404).end();
  });
});

// The player posts the package's whole data model here on commit, finish and when the page closes
router.post('/scorm/:id/commit', async (req, res) => {
  const l = await scormLesson(req);
  if (!l) return res.status(404).json({ ok: false });
  let cmi;
  try { cmi = JSON.parse(req.body.data || '{}'); } catch { return res.status(400).json({ ok: false }); }
  if (!cmi || typeof cmi !== 'object' || Array.isArray(cmi)) return res.status(400).json({ ok: false });
  const clean = {};
  for (const [k, v] of Object.entries(cmi)) if (/^(cmi|adl)\./.test(k) && k.length < 256) clean[k] = String(v).slice(0, 65536);
  const sum = scorm.summarise(l.scorm_version, clean);
  await db.run(`INSERT INTO scorm_attempts (user_id,lesson_id,cmi,status,score,total_time,updated_at) VALUES (?,?,?,?,?,?,now())
    ON CONFLICT(user_id,lesson_id) DO UPDATE SET cmi=excluded.cmi, status=excluded.status, score=excluded.score, total_time=excluded.total_time, updated_at=now()`,
  req.user.id, l.id, JSON.stringify(clean), sum.status, sum.score, sum.time);
  if (sum.complete) await markDone(req, l.course_id, l.id);
  res.json({ ok: true, complete: sum.complete, status: sum.status });
});

// Evidence files are private: owner or staff only
router.get('/evidence/:id', async (req, res, next) => {
  const s = await db.get('SELECT * FROM submissions WHERE id=?', Number(req.params.id) || 0);
  if (!s || (s.user_id !== req.user.id && req.user.role === 'student')) return next();
  const url = await storage.signedUrl('evidence', s.file, 60, s.original_name || s.file);
  if (!url) return res.status(404).render('public/error', { title: 'File not found', message: 'This evidence file is no longer in storage.' });
  res.redirect(url);
});

// ---------- Policies ----------
const policyAudiences = req => (req.user.role === 'student' ? ['all', 'learners'] : req.user.role === 'admin' ? ['all', 'staff', 'learners'] : ['all', 'staff']);
router.get('/policies', async (req, res) => {
  const policies = await db.all('SELECT * FROM policies WHERE audience = ANY(?) ORDER BY title', [policyAudiences(req)]);
  res.render('portal/policies', { title: 'Policies', policies });
});
// PDFs open in the browser; Word files download
router.get('/policies/:id/file', async (req, res, next) => {
  const p = await db.get('SELECT * FROM policies WHERE id=?', Number(req.params.id) || 0);
  if (!p || !policyAudiences(req).includes(p.audience)) return next();
  const name = p.original_name || `${p.title}${path.extname(p.file)}`;
  // A short-lived link: PDFs open in the browser, Word files download under their original name
  const url = await storage.signedUrl('policies', p.file, 300, path.extname(p.file) === '.pdf' ? undefined : name);
  if (!url) return res.status(404).render('public/error', { title: 'File not found', message: 'This policy file is no longer in storage.' });
  res.redirect(url);
});

router.get('/profile', async (req, res) => {
  const me = await db.get('SELECT id,name,email,phone,dob,postcode FROM users WHERE id=?', req.user.id);
  res.render('portal/profile', { title: 'My details', me });
});

router.post('/profile', async (req, res) => {
  const { name = '', phone = '', dob = '', postcode = '', password = '', password2 = '' } = req.body;
  if (!name.trim()) { flash(req, 'error', 'Your name can’t be empty.'); return res.redirect('/portal/profile'); }
  await db.run('UPDATE users SET name=?, phone=?, dob=?, postcode=? WHERE id=?', name.trim(), phone.trim(), dob, postcode.trim().toUpperCase(), req.user.id);
  if (password) {
    if (password.length < 8 || password !== password2) { flash(req, 'error', 'Details saved, but the password wasn’t changed: use 8+ characters and type it twice.'); return res.redirect('/portal/profile'); }
    await db.run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(password, 12), req.user.id);
  }
  flash(req, 'success', 'Details saved.');
  res.redirect('/portal/profile');
});

module.exports = router;
