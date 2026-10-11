const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, slugify, toId } = require('../db');
const { requireRole, flash } = require('../middleware');
const storage = require('../storage');
const links = require('../password-links');
const { waitUntil } = require('@vercel/functions');
const mailer = require('../mailer');
const { dueDate, markText } = require('../helpers');
const learning = require('../learning');
const scorm = require('../scorm');

const adminOnly = requireRole('admin');
router.use(requireRole('admin', 'tutor')); // tutors see dashboard, learners, their own courses and evidence review

// Ids in the URL must be valid whole numbers; anything else is simply "not found"
for (const name of ['id', 'uid']) router.param(name, (req, res, next, v) => (toId(v) ? next() : next('route')));

// Admins can manage every course; tutors only the courses they're assigned to
const isAdmin = req => req.user.role === 'admin';
const teaches = async (req, courseId) => isAdmin(req) || !!(await db.get('SELECT 1 FROM course_staff WHERE course_id=? AND user_id=?', toId(courseId), req.user.id));
const noAccess = res => res.status(403).render('public/error', { title: 'No access', message: 'You’re not assigned to this course. Ask an administrator to add you to it.' });
// SQL condition limiting rows to the current user's courses (c = courses alias)
const myCourses = req => (isAdmin(req) ? '1=1' : `c.id IN (SELECT course_id FROM course_staff WHERE user_id=${Number(req.user.id)})`);

router.use(async (req, res, next) => {
  res.locals.adminCss = true;
  res.locals.badges = await db.get(`SELECT
      (SELECT COUNT(*) FROM enquiries WHERE status='new') AS enquiries,
      (SELECT COUNT(*) FROM enrolments WHERE status='pending') AS enrolments,
      (SELECT COUNT(*) FROM submissions s JOIN lessons l ON l.id=s.lesson_id JOIN modules m ON m.id=l.module_id
        JOIN courses c ON c.id=m.course_id WHERE s.reviewed_at IS NULL AND ${myCourses(req)}) AS submissions`);
  next();
});

// ---------- Direct uploads ----------
// Signs a one-time storage link for a file the browser is about to upload (see public/js/direct-upload.js)
router.post('/uploads/sign', async (req, res) => {
  const rule = storage.UPLOADS[req.body.purpose];
  if (!rule || rule.unzipped || rule.who === 'learner' || (rule.who === 'admin' && !isAdmin(req))) return res.status(403).json({ error: 'You can’t upload this kind of file here.' });
  const problem = storage.refuse(req.body.purpose, req.body.filename, Number(req.body.size));
  if (problem) return res.status(422).json({ error: problem });
  res.json(await storage.signUpload(req.body.purpose, req.body.filename));
});
// Upload links for the files of a SCORM package the browser is unzipping (public/js/scorm-upload.js), up to 100
// per request. The first request gets a new package folder; later ones send it back.
router.post('/uploads/scorm-sign', async (req, res) => {
  let keys;
  try { keys = JSON.parse(req.body.paths || '[]'); } catch { keys = null; }
  if (!Array.isArray(keys) || !keys.length || keys.length > 100) return res.status(422).json({ error: 'Send between 1 and 100 file paths.' });
  const bad = keys.find(k => !scorm.safePath(k));
  if (bad !== undefined) return res.status(422).json({ error: `The package contains a file name that can’t be stored: ${String(bad).slice(0, 120)}. Rename it (letters, numbers, - and _ are safe) and export the package again.` });
  const folder = req.body.folder ? String(req.body.folder) : scorm.newFolder();
  if (!scorm.validFolder(folder)) return res.status(422).json({ error: 'Unknown package upload.' });
  res.json({ folder, urls: await storage.signUploads('scorm', keys.map(k => `${folder}/${k}`)) });
});
// The SCORM package the browser unzipped into storage for this form, or null
const scormUpload = body => (scorm.validFolder(body.scorm_pkg) && scorm.safeHome(body.scorm_home) ? { folder: body.scorm_pkg, home: body.scorm_home } : null);

async function uniqueSlug(table, base, id = 0) {
  let slug = slugify(base) || 'item', n = 2;
  while (await db.get(`SELECT 1 FROM ${table} WHERE slug=? AND id<>?`, slug, id)) slug = `${slugify(base)}-${n++}`;
  return slug;
}
const back = (req, fallback) => req.get('Referer') || fallback;
// Saving at the same moment as someone else can still hit a UNIQUE rule (slug, email, batch code): say so instead of failing
const tryAgain = 'Someone else saved something with the same name or address at the same moment. Please try again.';

// ---------- Dashboard ----------
router.get('/', async (req, res) => {
  const [counts, recentEnquiries, recentSubs] = await Promise.all([
    db.get(`SELECT (SELECT COUNT(*) FROM users WHERE role='student') AS students,
      (SELECT COUNT(*) FROM enrolments WHERE status='active') AS active,
      (SELECT COUNT(*) FROM enrolments WHERE status='pending') AS pending,
      (SELECT COUNT(*) FROM enquiries WHERE status='new') AS enquiries,
      (SELECT COUNT(*) FROM courses) AS courses`),
    db.all('SELECT q.*, c.title course_title FROM enquiries q LEFT JOIN courses c ON c.id=q.course_id ORDER BY q.id DESC LIMIT 6'),
    db.all(`SELECT s.*, u.name student, l.title lesson_title FROM submissions s JOIN users u ON u.id=s.user_id JOIN lessons l ON l.id=s.lesson_id
      JOIN modules m ON m.id=l.module_id JOIN courses c ON c.id=m.course_id
      WHERE s.reviewed_at IS NULL AND ${myCourses(req)} ORDER BY s.id DESC LIMIT 6`),
  ]);
  const stats = { ...counts, toReview: res.locals.badges.submissions };
  res.render('admin/dashboard', { title: 'Dashboard', stats, recentEnquiries, recentSubs });
});

// ---------- Awarding bodies ----------
router.get('/bodies', adminOnly, async (req, res) => {
  const bodies = await db.all('SELECT ab.*, (SELECT COUNT(*) FROM courses c WHERE c.awarding_body_id=ab.id) n FROM awarding_bodies ab ORDER BY name');
  res.render('admin/bodies', { title: 'Awarding bodies', bodies });
});
router.get('/bodies/new', adminOnly, (req, res) => res.render('admin/body-form', { title: 'Add awarding body', body: {} }));
router.get('/bodies/:id/edit', adminOnly, async (req, res, next) => {
  const body = await db.get('SELECT * FROM awarding_bodies WHERE id=?', req.params.id);
  if (!body) return next();
  res.render('admin/body-form', { title: `Edit ${body.name}`, body });
});
router.post('/bodies/save', adminOnly, async (req, res) => {
  const id = toId(req.body.id);
  const name = (req.body.name || '').trim();
  const logo = await storage.receive(req.body, 'logo');
  if (!name) { await removeUpload('images', logo && logo.filename); flash(req, 'error', 'Enter the awarding body’s name.'); return res.redirect(back(req, '/admin/bodies')); }
  const old = id ? await db.get('SELECT logo FROM awarding_bodies WHERE id=?', id) : null;
  const data = { name, slug: await uniqueSlug('awarding_bodies', name, id), website: req.body.website || '', description: req.body.description || '' };
  try {
    if (id) {
      await db.run('UPDATE awarding_bodies SET name=@name, slug=@slug, website=@website, description=@description WHERE id=@id', { ...data, id });
      if (logo) await db.run('UPDATE awarding_bodies SET logo=? WHERE id=?', logo.filename, id);
    } else {
      await db.run('INSERT INTO awarding_bodies (name,slug,website,description,logo) VALUES (@name,@slug,@website,@description,@logo)', { ...data, logo: logo ? logo.filename : null });
    }
  } catch (err) {
    await removeUpload('images', logo && logo.filename);
    if (!db.isUnique(err)) throw err;
    flash(req, 'error', tryAgain); return res.redirect(back(req, '/admin/bodies'));
  }
  if (logo && old) await removeUpload('images', old.logo);
  flash(req, 'success', `${name} saved.`);
  res.redirect('/admin/bodies');
});
router.post('/bodies/:id/delete', adminOnly, async (req, res) => {
  const gone = await db.get('DELETE FROM awarding_bodies WHERE id=? RETURNING logo', req.params.id);
  if (gone) await removeUpload('images', gone.logo);
  flash(req, 'success', 'Awarding body deleted. Its courses are kept without an awarding body.');
  res.redirect('/admin/bodies');
});

// ---------- Courses ----------
router.get('/courses', async (req, res) => {
  const courses = await db.all(`SELECT c.*, ab.name body_name,
      (SELECT COUNT(*) FROM enrolments e WHERE e.course_id=c.id AND e.status IN ('active','pending')) learners,
      (SELECT COUNT(*) FROM lessons l JOIN modules m ON m.id=l.module_id WHERE m.course_id=c.id) lessons,
      (SELECT string_agg(u.name, ', ') FROM course_staff cs JOIN users u ON u.id=cs.user_id WHERE cs.course_id=c.id) staff
    FROM courses c LEFT JOIN awarding_bodies ab ON ab.id=c.awarding_body_id WHERE ${myCourses(req)} ORDER BY c.title`);
  res.render('admin/courses', { title: isAdmin(req) ? 'Courses' : 'My courses', courses });
});
const bodyList = () => db.all('SELECT id,name FROM awarding_bodies ORDER BY name');
router.get('/courses/new', adminOnly, async (req, res) => res.render('admin/course-form', { title: 'Add course', course: { published: 1, framework: 'RQF' }, bodies: await bodyList() }));
router.get('/courses/:id/edit', adminOnly, async (req, res, next) => {
  const course = await db.get('SELECT * FROM courses WHERE id=?', req.params.id);
  if (!course) return next();
  res.render('admin/course-form', { title: `Edit course`, course, bodies: await bodyList() });
});
router.post('/courses/save', adminOnly, async (req, res) => {
  const id = toId(req.body.id);
  const b = req.body;
  const image = await storage.receive(b, 'course-image'), pkg = scormUpload(b);
  const fromScorm = !id && b.mode === 'scorm';
  const reject = async msg => {
    await removeUpload('images', image && image.filename); if (pkg) await scorm.remove(pkg.folder);
    flash(req, 'error', msg); return res.redirect(back(req, '/admin/courses'));
  };
  if (pkg && !fromScorm) await scorm.remove(pkg.folder);
  // "Upload a SCORM package": read its manifest first; the course title comes from the package unless one was typed
  let installed = null;
  if (fromScorm) {
    if (!pkg) return reject('Choose the SCORM package (.zip) to upload.');
    try { installed = await scorm.install(pkg.folder, pkg.home); } catch (err) {
      return reject(`The course wasn’t added: ${err.message}`);
    }
    if (!(b.title || '').trim()) b.title = installed.title || String(b.scorm_name || 'SCORM course').replace(/\.zip$/i, '');
  }
  if (!(b.title || '').trim()) return reject('Enter a course title.');
  const data = {
    title: b.title.trim(), slug: await uniqueSlug('courses', b.slug || b.title, id),
    awarding_body_id: toId(b.awarding_body_id) || null, level: b.level || '', qualification_type: b.qualification_type || '',
    framework: b.framework || '', duration: b.duration || '', study_mode: b.study_mode || '', price: Number(b.price) || 0,
    summary: b.summary || '', description: b.description || '', entry_requirements: b.entry_requirements || '', assessment: b.assessment || '',
    published: b.published ? 1 : 0, featured: b.featured ? 1 : 0, sequential: b.sequential ? 1 : 0,
  };
  let courseId = id;
  const oldImage = id && image ? ((await db.get('SELECT image FROM courses WHERE id=?', id)) || {}).image : null;
  try {
    // The course and (for a package) its modules and lessons are saved together or not at all
    await db.tx(async t => {
      if (id) {
        await t.run(`UPDATE courses SET title=@title, slug=@slug, awarding_body_id=@awarding_body_id, level=@level, qualification_type=@qualification_type,
          framework=@framework, duration=@duration, study_mode=@study_mode, price=@price, summary=@summary, description=@description,
          entry_requirements=@entry_requirements, assessment=@assessment, published=@published, featured=@featured, sequential=@sequential WHERE id=@id`, { ...data, id });
      } else {
        courseId = (await t.get(`INSERT INTO courses (title,slug,awarding_body_id,level,qualification_type,framework,duration,study_mode,price,summary,description,entry_requirements,assessment,published,featured,sequential)
          VALUES (@title,@slug,@awarding_body_id,@level,@qualification_type,@framework,@duration,@study_mode,@price,@summary,@description,@entry_requirements,@assessment,@published,@featured,@sequential) RETURNING id`, data)).id;
      }
      if (image) await t.run('UPDATE courses SET image=? WHERE id=?', image.filename, courseId);
      if (installed) {
        // Each unit in the package becomes a module, and each activity in it a lesson that launches that activity
        for (const [i, u] of installed.units.entries()) {
          const moduleId = (await t.get('INSERT INTO modules (course_id,title,position) VALUES (?,?,?) RETURNING id', courseId, u.title, i + 1)).id;
          for (const [j, l] of u.lessons.entries()) {
            await t.run(`INSERT INTO lessons (module_id,title,kind,content,position,scorm_folder,scorm_launch,scorm_version) VALUES (?,?,'lesson','',?,?,?,?)`,
              moduleId, l.title, j + 1, installed.folder, l.launch, installed.version);
          }
        }
        if (installed.description && !data.summary && !data.description) {
          await t.run('UPDATE courses SET summary=?, description=? WHERE id=?', installed.description.slice(0, 220), installed.description, courseId);
        }
      }
    });
  } catch (err) {
    if (installed) await scorm.remove(installed.folder);
    if (!db.isUnique(err)) { await removeUpload('images', image && image.filename); throw err; }
    return reject(tryAgain);
  }
  await removeUpload('images', oldImage);
  if (installed) {
    const n = installed.units.length;
    flash(req, 'success', `Course added from the SCORM ${installed.version} package: ${n} unit${n === 1 ? '' : 's'} and ${installed.count} lesson${installed.count === 1 ? '' : 's'}, set up from the package. Use Edit to fill in the course details for the website.`);
    return res.redirect(`/admin/courses/${courseId}/content`);
  }
  flash(req, 'success', id ? 'Course saved.' : 'Course added. Now add its modules and lessons.');
  res.redirect(id ? '/admin/courses' : `/admin/courses/${courseId}/content`);
});
router.post('/courses/:id/delete', adminOnly, async (req, res) => {
  // The course's files go too: its cover image and every lesson's resource, video and SCORM package
  const lessons = await db.all('SELECT l.attachment, l.video_file, l.scorm_folder FROM lessons l JOIN modules m ON m.id=l.module_id WHERE m.course_id=?', req.params.id);
  const gone = await db.get('DELETE FROM courses WHERE id=? RETURNING image', req.params.id);
  if (gone) await removeUpload('images', gone.image);
  await removeUpload('files', ...lessons.map(l => l.attachment));
  await removeUpload('videos', ...lessons.map(l => l.video_file));
  for (const folder of new Set(lessons.map(l => l.scorm_folder).filter(Boolean))) await scorm.remove(folder);
  flash(req, 'success', 'Course deleted.');
  res.redirect('/admin/courses');
});

// ---------- Course content (modules & lessons) ----------
router.get('/courses/:id/content', async (req, res, next) => {
  const course = await db.get('SELECT * FROM courses WHERE id=?', req.params.id);
  if (!course) return next();
  if (!(await teaches(req, course.id))) return noAccess(res);
  const [modules, lessons, staff, otherStaff] = await Promise.all([
    db.all('SELECT * FROM modules WHERE course_id=? ORDER BY position, id', course.id),
    db.all(`SELECT l.*, (SELECT COUNT(*) FROM assignment_learners al WHERE al.lesson_id=l.id) picked,
        (SELECT string_agg(b.name, ', ') FROM assignment_batches ab JOIN batches b ON b.id=ab.batch_id WHERE ab.lesson_id=l.id) batch_names
      FROM lessons l JOIN modules m ON m.id=l.module_id WHERE m.course_id=? ORDER BY l.position, l.id`, course.id),
    db.all('SELECT u.id, u.name, u.role, u.photo FROM course_staff cs JOIN users u ON u.id=cs.user_id WHERE cs.course_id=? ORDER BY u.name', course.id),
    isAdmin(req) ? db.all(`SELECT id, name, role FROM users WHERE role<>'student'
      AND id NOT IN (SELECT user_id FROM course_staff WHERE course_id=?) ORDER BY name`, course.id) : [],
  ]);
  for (const m of modules) m.lessons = lessons.filter(l => l.module_id === m.id);
  res.render('admin/content', { title: `Content: ${course.title}`, course, modules, staff, otherStaff, section: 'courses' });
});

// ---------- Course staff ----------
const addStaff = async (courseId, userId) => {
  const [u, c] = await Promise.all([
    db.get("SELECT id FROM users WHERE id=? AND role<>'student'", toId(userId)),
    db.get('SELECT id FROM courses WHERE id=?', toId(courseId)),
  ]);
  if (u && c) await db.run('INSERT INTO course_staff (course_id,user_id) VALUES (?,?) ON CONFLICT DO NOTHING', c.id, u.id);
  return !!(u && c);
};
router.post('/courses/:id/staff', adminOnly, async (req, res) => {
  if (await addStaff(req.params.id, req.body.user_id)) flash(req, 'success', 'Staff member assigned. They can now manage this course’s content and review its evidence.');
  res.redirect(back(req, `/admin/courses/${req.params.id}/content`));
});
router.post('/students/:id/teach', adminOnly, async (req, res) => {
  if (await addStaff(req.body.course_id, req.params.id)) flash(req, 'success', 'Assigned to the course. They can now manage its content and review its evidence.');
  res.redirect(`/admin/students/${req.params.id}`);
});
router.post('/courses/:id/staff/:uid/remove', adminOnly, async (req, res) => {
  await db.run('DELETE FROM course_staff WHERE course_id=? AND user_id=?', req.params.id, req.params.uid);
  flash(req, 'success', 'Staff member removed from the course.');
  res.redirect(back(req, `/admin/courses/${req.params.id}/content`));
});

router.post('/courses/:id/modules', async (req, res) => {
  if (!(await teaches(req, req.params.id))) return noAccess(res);
  const title = (req.body.title || '').trim();
  if (title) {
    await db.run('INSERT INTO modules (course_id,title,position) SELECT ?::int, ?::text, COALESCE(MAX(position),0)+1 FROM modules WHERE course_id=?', req.params.id, title, req.params.id);
  }
  res.redirect(`/admin/courses/${req.params.id}/content`);
});
router.post('/modules/:id', async (req, res) => {
  const m = await db.get('SELECT * FROM modules WHERE id=?', req.params.id);
  if (!m) return res.redirect('/admin/courses');
  if (!(await teaches(req, m.course_id))) return noAccess(res);
  if (req.body.delete) await db.run('DELETE FROM modules WHERE id=?', m.id);
  else if (req.body.move) {
    const dir = req.body.move === 'up' ? '<' : '>';
    const order = req.body.move === 'up' ? 'DESC' : 'ASC';
    await db.tx(async t => {
      const other = await t.get(`SELECT * FROM modules WHERE course_id=? AND position ${dir} ? ORDER BY position ${order} LIMIT 1`, m.course_id, m.position);
      if (other) {
        await t.run('UPDATE modules SET position=? WHERE id=?', other.position, m.id);
        await t.run('UPDATE modules SET position=? WHERE id=?', m.position, other.id);
      }
    });
  } else if ((req.body.title || '').trim()) await db.run('UPDATE modules SET title=? WHERE id=?', req.body.title.trim(), m.id);
  res.redirect(`/admin/courses/${m.course_id}/content`);
});
// Learners who can be set an assignment: everyone enrolled on the course and not cancelled
const courseLearners = courseId => db.all(`SELECT u.id, u.name, u.email, e.status, e.batch_id FROM enrolments e JOIN users u ON u.id=e.user_id
  WHERE e.course_id=? AND e.status<>'cancelled' ORDER BY u.name`, courseId);
const lessonCourse = lessonId => db.get('SELECT m.course_id FROM lessons l JOIN modules m ON m.id=l.module_id WHERE l.id=?', lessonId);
const removeUpload = (folder, ...files) => storage.remove(folder, ...files);
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

async function renderLessonForm(res, module, lesson) {
  const [course, learners, batches, pickedLearners, pickedBatchRows] = await Promise.all([
    db.get('SELECT id, title, slug FROM courses WHERE id=?', module.course_id),
    courseLearners(module.course_id),
    batchList(module.course_id),
    lesson.id ? db.all('SELECT user_id, due_date FROM assignment_learners WHERE lesson_id=?', lesson.id) : [],
    lesson.id ? db.all('SELECT batch_id, due_date FROM assignment_batches WHERE lesson_id=?', lesson.id) : [],
  ]);
  const picked = Object.fromEntries(pickedLearners.map(a => [a.user_id, a.due_date || '']));
  const pickedBatches = Object.fromEntries(pickedBatchRows.map(a => [a.batch_id, a.due_date || '']));
  res.render('admin/lesson-form', { title: lesson.id ? 'Edit lesson' : 'Add lesson', module, lesson, course, learners, picked,
    batches, pickedBatches, section: 'courses' });
}
router.get('/modules/:id/lessons/new', async (req, res, next) => {
  const module = await db.get('SELECT * FROM modules WHERE id=?', req.params.id);
  if (!module) return next();
  if (!(await teaches(req, module.course_id))) return noAccess(res);
  await renderLessonForm(res, module, { kind: req.query.kind === 'assignment' ? 'assignment' : 'lesson', assign_to: 'all' });
});
router.get('/lessons/:id/edit', async (req, res, next) => {
  const lesson = await db.get('SELECT * FROM lessons WHERE id=?', req.params.id);
  if (!lesson) return next();
  const module = await db.get('SELECT * FROM modules WHERE id=?', lesson.module_id);
  if (!(await teaches(req, module.course_id))) return noAccess(res);
  await renderLessonForm(res, module, lesson);
});
router.post('/lessons/save', async (req, res) => {
  const [attachment, video] = await Promise.all([storage.receive(req.body, 'attachment'), storage.receive(req.body, 'video')]);
  const pkg = scormUpload(req.body);
  const discard = () => Promise.all([removeUpload('files', attachment && attachment.filename), removeUpload('videos', video && video.filename), pkg && scorm.remove(pkg.folder)]);
  const id = toId(req.body.id);
  const module = await db.get('SELECT * FROM modules WHERE id=?', toId(req.body.module_id));
  const existing = id ? await db.get('SELECT * FROM lessons WHERE id=?', id) : null;
  if (!module || (id && !existing)) { await discard(); return res.redirect('/admin/courses'); }
  // Both the target module and (when editing) the lesson's current course must be one this user teaches
  if (!(await teaches(req, module.course_id)) || (existing && !(await teaches(req, (await lessonCourse(id)).course_id)))) { await discard(); return noAccess(res); }

  const b = req.body;
  const kind = b.kind === 'assignment' ? 'assignment' : 'lesson';
  // Read the SCORM package's manifest first, so a bad package stops the save before anything changes
  let installed = null;
  if (pkg && kind === 'lesson') {
    try { installed = await scorm.install(pkg.folder, pkg.home); } catch (err) {
      await discard();
      flash(req, 'error', `The SCORM package wasn’t added: ${err.message} Nothing was saved.`);
      return res.redirect(id ? `/admin/lessons/${id}/edit` : `/admin/modules/${module.id}/lessons/new`);
    }
  } else if (pkg) await scorm.remove(pkg.folder);
  if (installed && !(b.title || '').trim()) b.title = installed.title;
  const data = {
    title: (b.title || 'Untitled lesson').trim(), kind, content: b.content || '', video_url: (b.video_url || '').trim(),
    due_date: kind === 'assignment' && isDate(b.due_date) ? b.due_date : null,
    assign_to: kind === 'assignment' && ['selected', 'batches'].includes(b.assign_to) ? b.assign_to : 'all',
    total_marks: kind === 'assignment' && Number(b.total_marks) > 0 ? Math.min(Number(b.total_marks), 10000) : null,
  };
  const [enrolled, batches] = await Promise.all([courseLearners(module.course_id), batchList(module.course_id)]);
  const batchDue = {};
  const dropPackage = installed || ((b.remove_scorm || kind === 'assignment') && existing && existing.scorm_folder);

  // Everything about the lesson is saved together, or not at all
  let lessonId = id;
  try {
    await db.tx(async t => {
      if (id) await t.run('UPDATE lessons SET title=@title, kind=@kind, content=@content, video_url=@video_url, due_date=@due_date, assign_to=@assign_to, total_marks=@total_marks WHERE id=@id', { ...data, id });
      else {
        lessonId = (await t.get(`INSERT INTO lessons (module_id,title,kind,content,video_url,due_date,assign_to,total_marks,position)
          SELECT @module_id::int,@title::text,@kind::text,@content::text,@video_url::text,@due_date::text,@assign_to::text,@total_marks::float8, COALESCE(MAX(position),0)+1 FROM lessons WHERE module_id=@module_id
          RETURNING id`, { ...data, module_id: module.id })).id;
      }
      if (attachment || b.remove_attachment) await t.run('UPDATE lessons SET attachment=? WHERE id=?', attachment ? attachment.filename : null, lessonId);
      // Assignments can't hold a package; replacing or removing one clears learners' saved attempts
      if (dropPackage) {
        await t.run('DELETE FROM scorm_attempts WHERE lesson_id=?', lessonId);
        await t.run('UPDATE lessons SET scorm_folder=?, scorm_launch=?, scorm_version=? WHERE id=?',
          installed ? installed.folder : null, installed ? installed.launch : null, installed ? installed.version : null, lessonId);
      }
      if (video || b.remove_video) await t.run('UPDATE lessons SET video_file=? WHERE id=?', video ? video.filename : null, lessonId);

      // Which learners the assignment is set for, each with an optional individual deadline
      await t.run('DELETE FROM assignment_learners WHERE lesson_id=?', lessonId);
      if (kind === 'assignment' && data.assign_to === 'selected') {
        const chosen = new Set([].concat(b.learners || []).map(Number));
        for (const l of enrolled.filter(l => chosen.has(l.id))) {
          const own = b[`due_${l.id}`];
          await t.run('INSERT INTO assignment_learners (lesson_id,user_id,due_date) VALUES (?,?,?)', lessonId, l.id, isDate(own) ? own : null);
        }
      }
      // Or which batches, each with an optional batch deadline
      await t.run('DELETE FROM assignment_batches WHERE lesson_id=?', lessonId);
      if (kind === 'assignment' && data.assign_to === 'batches') {
        const chosen = new Set([].concat(b.batches || []).map(Number));
        for (const bt of batches.filter(bt => chosen.has(bt.id))) {
          const own = b[`bdue_${bt.id}`];
          batchDue[bt.id] = isDate(own) ? own : null;
          await t.run('INSERT INTO assignment_batches (lesson_id,batch_id,due_date) VALUES (?,?,?)', lessonId, bt.id, batchDue[bt.id]);
        }
      }
    });
  } catch (err) {
    await discard();
    if (installed) await scorm.remove(installed.folder);
    throw err;
  }
  // Old files go only once the new lesson is safely saved
  if (attachment || b.remove_attachment) await removeUpload('files', existing && existing.attachment);
  if (video || b.remove_video) await removeUpload('videos', existing && existing.video_file);
  if (dropPackage) await scorm.remove(existing && existing.scorm_folder);

  let note = kind === 'assignment' ? 'Assignment saved.' : 'Lesson saved.';
  if (data.assign_to === 'batches' && !Object.keys(batchDue).length) note += ' No batch is ticked, so no learner can see it yet.';
  if (installed && installed.count > 1) note += ` This package has ${installed.count} activities; this lesson plays the first one. To get every unit and activity as its own lesson, create a course from the package instead (Courses → Add course → Upload a SCORM package).`;
  if (kind === 'assignment' && b.notify) {
    const course = await db.get('SELECT title, slug FROM courses WHERE id=?', module.course_id);
    const own = Object.fromEntries((await db.all('SELECT user_id, due_date FROM assignment_learners WHERE lesson_id=?', lessonId)).map(a => [a.user_id, a.due_date]));
    const setFor = l => (data.assign_to === 'all' ? true : data.assign_to === 'batches' ? l.batch_id in batchDue : l.id in own);
    const targets = enrolled.filter(l => l.status === 'active' && setFor(l));
    const link = `${links.baseUrl(req)}/portal/courses/${course.slug}/lessons/${lessonId}`;
    const emails = targets.map(l => {
      const due = own[l.id] || batchDue[l.batch_id] || data.due_date;
      return {
        to: l.email, subject: `New assignment: ${data.title}`,
        text: `Hello ${l.name},\n\nA new assignment has been set for you on ${course.title}: ${data.title}.\n\n`
          + (due ? `Deadline: ${dueDate(due)}\n\n` : '') + `Open it here:\n${link}\n\n${process.env.SITE_NAME || 'Horizon College London'}`,
      };
    });
    // Sent after the page has responded (up to 100 per request to Resend), so a big class can't time the save out.
    // On Vercel, waitUntil keeps the function running until they're done. Failures go to the log.
    waitUntil(mailer.sendMany(emails).then(sent => {
      if (mailer.enabled && sent < emails.length) console.error(`Assignment "${data.title}": emailed ${sent} of ${emails.length} learners.`);
    }));
    const n = `${targets.length} learner${targets.length === 1 ? '' : 's'}`;
    if (!targets.length) note += ' No active learners to email yet.';
    else note += mailer.enabled ? ` Emailing ${n} now.` : ` ${n} would be emailed, but email isn’t set up yet (RESEND_API_KEY isn’t set).`;
  }
  flash(req, 'success', note);
  res.redirect(`/admin/courses/${module.course_id}/content`);
});
router.post('/lessons/:id/delete', async (req, res) => {
  const l = await db.get('SELECT l.attachment, l.video_file, l.scorm_folder, m.course_id FROM lessons l JOIN modules m ON m.id=l.module_id WHERE l.id=?', req.params.id);
  if (!l) return res.redirect('/admin/courses');
  if (!(await teaches(req, l.course_id))) return noAccess(res);
  await db.run('DELETE FROM lessons WHERE id=?', req.params.id);
  await removeUpload('files', l.attachment); await removeUpload('videos', l.video_file); await scorm.remove(l.scorm_folder);
  res.redirect(`/admin/courses/${l.course_id}/content`);
});

// ---------- Batches ----------
// A course's learners are split into batches. Joining a batch issues a learner number: the batch code plus the
// learner's place in it ("L4NDBA-B1-007"). Batch codes are unique, so learner numbers are unique across the college.
const loadBatch = id => db.get('SELECT * FROM batches WHERE id=?', toId(id));
const batchList = courseId => db.all(`SELECT b.*, (SELECT COUNT(*) FROM enrolments e WHERE e.batch_id=b.id AND e.status<>'cancelled') size
  FROM batches b WHERE b.course_id=? ORDER BY COALESCE(b.start_date, to_char(b.created_at, 'YYYY-MM-DD')), b.id`, courseId);
const batchCode = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '-');
// Suggested code for a course's next batch: initials of the title's main words, then B1, B2…
async function suggestCode(course) {
  const minor = new Set(['in', 'and', 'of', 'the', 'for', 'to', 'a', 'an', 'with', 'on']);
  const prefix = course.title.split(/[^A-Za-z0-9]+/).filter(w => w && !minor.has(w.toLowerCase())).map(w => w[0]).join('').toUpperCase().slice(0, 8) || `C${course.id}`;
  for (let n = (await db.get('SELECT COUNT(*) n FROM batches WHERE course_id=?', course.id)).n + 1; ; n++) {
    if (!(await db.get('SELECT 1 FROM batches WHERE code=?', `${prefix}-B${n}`))) return `${prefix}-B${n}`;
  }
}
function batchFields(b) {
  const name = String(b.name || '').trim(), code = batchCode(b.code), cap = String(b.capacity || '').trim();
  const capacity = cap === '' ? null : Number(cap);
  const start_date = isDate(b.start_date) ? b.start_date : null, end_date = isDate(b.end_date) ? b.end_date : null;
  if (!name) return { error: 'Enter a name for the batch.' };
  if (code && !/^[A-Z0-9][A-Z0-9-]{0,23}$/.test(code)) return { error: 'Batch codes can only use letters, numbers and dashes (up to 24 characters).' };
  if (capacity !== null && !(Number.isInteger(capacity) && capacity > 0 && capacity <= 100000)) return { error: 'Capacity must be a whole number above 0, or blank for no limit.' };
  if (start_date && end_date && end_date < start_date) return { error: 'The end date is before the start date.' };
  return { name, code, capacity, start_date, end_date };
}
// Moves an enrolment into a batch (or out of every batch when batch is null) and issues its learner number.
// Numbers are never reused: moving batch, or leaving and rejoining, gives a new one. Returns the new number
// ('' when removed from a batch), or false when the batch is full or gone.
async function placeInBatch(enrolment, batch) {
  if (!batch) {
    await db.run('UPDATE enrolments SET batch_id=NULL, learner_number=NULL WHERE id=?', enrolment.id);
    return '';
  }
  if (enrolment.batch_id === batch.id) return enrolment.learner_number;
  return db.tx(async t => {
    // Locking the batch row makes staff placing learners at the same moment take turns,
    // so a number is never issued twice and the capacity can't be overshot
    const b = await t.get('SELECT code, capacity, next_number FROM batches WHERE id=? FOR UPDATE', batch.id);
    if (!b) return false;
    if (b.capacity) {
      const { n } = await t.get("SELECT COUNT(*) n FROM enrolments WHERE batch_id=? AND status<>'cancelled'", batch.id);
      if (n >= b.capacity) return false;
    }
    const number = `${b.code}-${String(b.next_number).padStart(3, '0')}`;
    await t.run('UPDATE batches SET next_number=next_number+1 WHERE id=?', batch.id);
    await t.run('UPDATE enrolments SET batch_id=?, learner_number=? WHERE id=?', batch.id, number, enrolment.id);
    return number;
  });
}

router.get('/courses/:id/batches', async (req, res, next) => {
  const course = await db.get('SELECT id, title, slug FROM courses WHERE id=?', req.params.id);
  if (!course) return next();
  if (!(await teaches(req, course.id))) return noAccess(res);
  const [batches, learners, suggested] = await Promise.all([
    batchList(course.id),
    // Cancelled enrolments only appear while they still hold a place in a batch
    db.all(`SELECT e.id, e.status, e.batch_id, e.learner_number, u.id user_id, u.name, u.email FROM enrolments e JOIN users u ON u.id=e.user_id
      WHERE e.course_id=? AND (e.status<>'cancelled' OR e.batch_id IS NOT NULL) ORDER BY e.learner_number, u.name`, course.id),
    suggestCode(course),
  ]);
  // Each learner's progress counts only what they can see, so batch-only assignments don't hold other batches back
  const progress = await learning.progressForMany(course.id, learners.map(l => l.user_id));
  for (const l of learners) l.progress = progress[l.user_id];
  const average = list => (list.length ? Math.round(list.reduce((n, l) => n + l.progress.pct, 0) / list.length) : null);
  for (const b of batches) { b.learners = learners.filter(l => l.batch_id === b.id); b.avg = average(b.learners.filter(l => l.status !== 'cancelled')); }
  const unbatched = learners.filter(l => !l.batch_id);
  res.render('admin/batches', { title: `Learners: ${course.title}`, course, batches, unbatched, suggested,
    courseAvg: average(learners.filter(l => l.status !== 'cancelled')), section: 'courses' });
});
router.post('/courses/:id/batches', async (req, res, next) => {
  const course = await db.get('SELECT id, title FROM courses WHERE id=?', req.params.id);
  if (!course) return next();
  if (!(await teaches(req, course.id))) return noAccess(res);
  const url = `/admin/courses/${course.id}/batches`;
  const f = batchFields(req.body);
  if (f.error) { flash(req, 'error', f.error); return res.redirect(url); }
  const code = f.code || await suggestCode(course);
  const taken = `The code ${code} is already used by another batch. Choose a different one.`;
  if (await db.get('SELECT 1 FROM batches WHERE code=?', code)) { flash(req, 'error', taken); return res.redirect(url); }
  try {
    await db.run('INSERT INTO batches (course_id,name,code,capacity,start_date,end_date) VALUES (?,?,?,?,?,?)', course.id, f.name, code, f.capacity, f.start_date, f.end_date);
  } catch (err) {
    if (!db.isUnique(err)) throw err;
    flash(req, 'error', taken); return res.redirect(url);
  }
  flash(req, 'success', `${f.name} added. Tick learners below and move them into it to give them learner numbers.`);
  res.redirect(url);
});
router.post('/batches/:id', async (req, res, next) => {
  const batch = await loadBatch(req.params.id);
  if (!batch) return next();
  if (!(await teaches(req, batch.course_id))) return noAccess(res);
  const url = `/admin/courses/${batch.course_id}/batches`;
  if (req.body.delete) {
    // Locked like placeInBatch, so nobody can be moved in while the batch is being deleted
    const deleted = await db.tx(async t => {
      await t.get('SELECT 1 FROM batches WHERE id=? FOR UPDATE', batch.id);
      if ((await t.get('SELECT COUNT(*) n FROM enrolments WHERE batch_id=?', batch.id)).n) return false;
      await t.run('DELETE FROM batches WHERE id=?', batch.id);
      return true;
    });
    if (!deleted) { flash(req, 'error', 'Move this batch’s learners to another batch (or out of batches) before deleting it.'); return res.redirect(url); }
    flash(req, 'success', `${batch.name} deleted.`);
    return res.redirect(url);
  }
  const f = batchFields(req.body);
  if (f.error) { flash(req, 'error', f.error); return res.redirect(url); }
  const code = f.code || batch.code;
  if (code !== batch.code && batch.next_number === 1 && await db.get('SELECT 1 FROM batches WHERE code=?', code)) { flash(req, 'error', `The code ${code} is already used by another batch.`); return res.redirect(url); }
  const active = (await db.get("SELECT COUNT(*) n FROM enrolments WHERE batch_id=? AND status<>'cancelled'", batch.id)).n;
  if (f.capacity && f.capacity < active) { flash(req, 'error', `This batch already has ${active} learners, so its capacity can’t be less than ${active}.`); return res.redirect(url); }
  try {
    // The code is part of every learner number already issued, so it's fixed once the first one is given out
    await db.run(`UPDATE batches SET name=?, code=CASE WHEN next_number > 1 THEN code ELSE ? END, capacity=?, start_date=?, end_date=? WHERE id=?`,
      f.name, code, f.capacity, f.start_date, f.end_date, batch.id);
  } catch (err) {
    if (!db.isUnique(err)) throw err;
    flash(req, 'error', `The code ${code} is already used by another batch.`); return res.redirect(url);
  }
  flash(req, 'success', `${f.name} saved.`);
  res.redirect(url);
});
// Moves the ticked learners into a batch, or out of batches when no batch is chosen
router.post('/courses/:id/batches/assign', async (req, res, next) => {
  const course = await db.get('SELECT id FROM courses WHERE id=?', req.params.id);
  if (!course) return next();
  if (!(await teaches(req, course.id))) return noAccess(res);
  const url = `/admin/courses/${course.id}/batches`;
  const target = req.body.batch_id ? await loadBatch(req.body.batch_id) : null;
  if (req.body.batch_id && (!target || target.course_id !== course.id)) { flash(req, 'error', 'That batch no longer exists.'); return res.redirect(url); }
  const ids = [].concat(req.body.enrolments || []).map(toId).filter(Boolean);
  if (!ids.length) { flash(req, 'error', 'Tick the learners you want to move first.'); return res.redirect(url); }
  // Alphabetical, so learners joining together get numbers in name order
  const rows = await db.all(`SELECT e.* FROM enrolments e JOIN users u ON u.id=e.user_id
    WHERE e.course_id=? AND e.id = ANY(?::int[]) ORDER BY u.name`, course.id, ids);
  let moved = 0, full = 0;
  for (const e of rows) {
    if ((target ? target.id : null) === e.batch_id) continue;
    if ((await placeInBatch(e, target)) === false) full++; else moved++;
  }
  const s = n => (n === 1 ? '' : 's');
  let msg = target ? `${moved} learner${s(moved)} moved to ${target.name} and given learner numbers.` : `${moved} learner${s(moved)} taken out of their batch. Their learner numbers have been withdrawn.`;
  if (full) msg += ` ${full} couldn’t be added because ${target.name} is full (capacity ${target.capacity}).`;
  flash(req, full && !moved ? 'error' : 'success', msg);
  res.redirect(url);
});
// Single learner, from their page
router.post('/enrolments/:id/batch', async (req, res, next) => {
  const e = await db.get('SELECT * FROM enrolments WHERE id=?', req.params.id);
  if (!e) return next();
  if (!(await teaches(req, e.course_id))) return noAccess(res);
  const target = req.body.batch_id ? await loadBatch(req.body.batch_id) : null;
  if (req.body.batch_id && (!target || target.course_id !== e.course_id)) { flash(req, 'error', 'That batch no longer exists.'); return res.redirect(back(req, '/admin/students')); }
  if ((target ? target.id : null) !== e.batch_id) {
    const number = await placeInBatch(e, target);
    if (number === false) flash(req, 'error', `${target.name} is full (capacity ${target.capacity}). Raise its capacity or choose another batch.`);
    else flash(req, 'success', target ? `Moved to ${target.name}. Learner number: ${number}.` : 'Taken out of the batch. Their learner number has been withdrawn.');
  }
  res.redirect(back(req, `/admin/students/${e.user_id}`));
});

// ---------- Learners & staff ----------
// Learners and staff share the users table; they are listed separately by role
const listUrl = role => (role === 'student' ? '/admin/students' : '/admin/staff');
function listAccounts(kind) {
  return async (req, res) => {
    const q = (req.query.q || '').trim();
    const students = await db.all(`SELECT u.*, (SELECT COUNT(*) FROM enrolments e WHERE e.user_id=u.id) courses FROM users u
      WHERE ${kind === 'staff' ? "u.role<>'student'" : "u.role='student'"} AND (@q::text='' OR u.name ILIKE @like OR u.email ILIKE @like)
      ORDER BY u.created_at DESC LIMIT 200`, { q, like: `%${q}%` });
    res.render('admin/students', { title: kind === 'staff' ? 'Staff' : 'Learners', kind, students, q });
  };
}
router.get('/students', listAccounts('learners'));
router.get('/staff', listAccounts('staff'));
// Profile fields shared by the "add" and "edit details" forms
function profileFields(body) {
  const t = k => String(body[k] || '').trim();
  const first_name = t('first_name'), last_name = t('last_name');
  return {
    first_name, last_name,
    name: [first_name, last_name].filter(Boolean).join(' ') || t('name'),
    phone: t('phone'), address: t('address'), postcode: t('postcode').toUpperCase(),
  };
}
const removePhoto = file => removeUpload('images', file);

router.post('/students', adminOnly, async (req, res) => {
  const p = profileFields(req.body), email = (req.body.email || '').trim().toLowerCase();
  const role = ['student', 'tutor', 'admin'].includes(req.body.role) ? req.body.role : 'student';
  const upload = await storage.receive(req.body, 'photo');
  const photo = upload ? upload.filename : null;
  const reject = async msg => { await removePhoto(photo); flash(req, 'error', msg); res.redirect(listUrl(role)); };
  if (!p.name || !/^\S+@\S+\.\S+$/.test(email)) return reject('Enter a name and a valid email.');
  if (await db.get('SELECT 1 FROM users WHERE lower(email)=?', email)) return reject('That email already has an account.');
  // Random unknown password: the new user chooses their own from the emailed link
  let user;
  try {
    user = await db.get('INSERT INTO users (name,first_name,last_name,email,phone,address,postcode,photo,password_hash,role) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *',
      p.name, p.first_name, p.last_name, email, p.phone, p.address, p.postcode, photo, bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 12), role);
  } catch (err) {
    if (db.isUnique(err)) return reject('That email already has an account.');
    throw err;
  }
  const invite = await links.sendInvite(req, user);
  flash(req, invite.sent ? 'success' : 'error', invite.sent
    ? `Account created. An email has been sent to ${email} with a link to set their password.`
    : `Account created, but the email couldn’t be sent (check the Resend settings and logs). Send them this link to set their password, valid for 7 days: ${invite.link}`);
  res.redirect(`/admin/students/${user.id}`);
});
router.get('/students/:id', async (req, res, next) => {
  const student = await db.get('SELECT * FROM users WHERE id=?', req.params.id);
  if (!student) return next();
  const [enrolments, submissions, scormResults, courses, teaching] = await Promise.all([
    db.all(`SELECT e.*, c.title, c.slug, b.name batch_name FROM enrolments e JOIN courses c ON c.id=e.course_id
      LEFT JOIN batches b ON b.id=e.batch_id WHERE e.user_id=? ORDER BY e.created_at DESC`, student.id),
    db.all('SELECT s.*, l.title lesson_title, l.total_marks FROM submissions s JOIN lessons l ON l.id=s.lesson_id WHERE s.user_id=? ORDER BY s.id DESC', student.id),
    db.all(`SELECT a.*, l.title lesson_title, c.title course_title FROM scorm_attempts a JOIN lessons l ON l.id=a.lesson_id
      JOIN modules m ON m.id=l.module_id JOIN courses c ON c.id=m.course_id WHERE a.user_id=? ORDER BY a.updated_at DESC`, student.id),
    db.all('SELECT id,title FROM courses ORDER BY title'),
    db.all('SELECT c.id, c.title FROM course_staff cs JOIN courses c ON c.id=cs.course_id WHERE cs.user_id=? ORDER BY c.title', student.id),
  ]);
  await Promise.all(enrolments.map(async e => {
    e.progress = await learning.progress(student.id, e.course_id);
    e.batches = (await teaches(req, e.course_id)) ? await batchList(e.course_id) : null; // only staff on the course can change the batch
  }));
  res.render('admin/student', { title: student.name, student, enrolments, submissions, scormResults, courses, teaching, section: student.role === 'student' ? 'learners' : 'staff' });
});
router.post('/students/:id/role', adminOnly, async (req, res) => {
  if (Number(req.params.id) === req.user.id) { flash(req, 'error', 'You can’t change your own role.'); return res.redirect(back(req, '/admin/students')); }
  if (['student', 'tutor', 'admin'].includes(req.body.role)) await db.run('UPDATE users SET role=? WHERE id=?', req.body.role, req.params.id);
  flash(req, 'success', 'Role updated.');
  res.redirect(`/admin/students/${req.params.id}`);
});
router.post('/students/:id/details', adminOnly, async (req, res, next) => {
  const upload = await storage.receive(req.body, 'photo');
  const u = await db.get('SELECT * FROM users WHERE id=?', req.params.id);
  if (!u) { await removePhoto(upload && upload.filename); return next(); }
  const p = profileFields(req.body);
  if (!p.name) { await removePhoto(upload && upload.filename); flash(req, 'error', 'Enter a first and last name.'); return res.redirect(`/admin/students/${u.id}`); }
  let photo = u.photo;
  if (upload || req.body.remove_photo) photo = upload ? upload.filename : null;
  await db.run('UPDATE users SET name=?, first_name=?, last_name=?, phone=?, address=?, postcode=?, photo=? WHERE id=?',
    p.name, p.first_name, p.last_name, p.phone, p.address, p.postcode, photo, u.id);
  if (photo !== u.photo) await removePhoto(u.photo);
  flash(req, 'success', 'Details updated.');
  res.redirect(`/admin/students/${u.id}`);
});
router.post('/students/:id/invite', adminOnly, async (req, res, next) => {
  const u = await db.get('SELECT * FROM users WHERE id=?', req.params.id);
  if (!u) return next();
  const invite = await links.sendInvite(req, u);
  flash(req, invite.sent ? 'success' : 'error', invite.sent
    ? `A new set-password link has been emailed to ${u.email}. Any earlier link no longer works.`
    : `The email couldn’t be sent (check the Resend settings and logs). Send them this link instead, valid for 7 days: ${invite.link}`);
  res.redirect(`/admin/students/${u.id}`);
});
router.post('/students/:id/enrol', adminOnly, async (req, res) => {
  const courseId = toId(req.body.course_id);
  if (courseId && await db.get('SELECT 1 FROM courses WHERE id=?', courseId)) {
    await db.run("INSERT INTO enrolments (user_id,course_id,status) VALUES (?,?,'active') ON CONFLICT(user_id,course_id) DO UPDATE SET status='active'", req.params.id, courseId);
    flash(req, 'success', 'Learner enrolled and course opened.');
  }
  res.redirect(`/admin/students/${req.params.id}`);
});
router.post('/students/:id/delete', adminOnly, async (req, res) => {
  if (Number(req.params.id) === req.user.id) { flash(req, 'error', 'You can’t delete your own account.'); return res.redirect('/admin/students'); }
  const gone = await db.get('DELETE FROM users WHERE id=? RETURNING role, photo', req.params.id);
  if (gone) await removePhoto(gone.photo);
  flash(req, 'success', 'Account deleted.');
  res.redirect(listUrl(gone ? gone.role : 'student'));
});

// ---------- Policies ----------
// Admins upload and manage; tutors see the ones meant for staff
router.get('/policies', async (req, res) => {
  const policies = await db.all(`SELECT * FROM policies ${isAdmin(req) ? '' : "WHERE audience IN ('all','staff')"} ORDER BY title`);
  const editing = isAdmin(req) && toId(req.query.edit) ? await db.get('SELECT * FROM policies WHERE id=?', toId(req.query.edit)) : null;
  res.render('admin/policies', { title: 'Policies', policies, editing, section: 'policies' });
});
router.post('/policies/save', adminOnly, async (req, res) => {
  const id = toId(req.body.id);
  const file = await storage.receive(req.body, 'policy');
  const existing = id ? await db.get('SELECT * FROM policies WHERE id=?', id) : null;
  const title = (req.body.title || '').trim();
  const audience = ['all', 'staff', 'learners'].includes(req.body.audience) ? req.body.audience : 'all';
  const reject = async msg => { await removeUpload('policies', file && file.filename); flash(req, 'error', msg); res.redirect(id ? `/admin/policies?edit=${id}` : '/admin/policies'); };
  if (id && !existing) return reject('That policy no longer exists.');
  if (!title) return reject('Enter a title for the policy.');
  if (!file && !existing) return reject('Choose the policy file to upload: PDF or Word, up to 20 MB.');
  if (existing) {
    await db.run('UPDATE policies SET title=?, description=?, audience=?, updated_at=now() WHERE id=?', title, (req.body.description || '').trim(), audience, id);
    if (file) {
      await db.run('UPDATE policies SET file=?, original_name=? WHERE id=?', file.filename, file.originalname, id);
      await removeUpload('policies', existing.file);
    }
  } else {
    await db.run('INSERT INTO policies (title,description,file,original_name,audience) VALUES (?,?,?,?,?)',
      title, (req.body.description || '').trim(), file.filename, file.originalname, audience);
  }
  flash(req, 'success', existing ? 'Policy updated.' : 'Policy added.');
  res.redirect('/admin/policies');
});
router.post('/policies/:id/delete', adminOnly, async (req, res) => {
  const p = await db.get('DELETE FROM policies WHERE id=? RETURNING file', req.params.id);
  if (p) await removeUpload('policies', p.file);
  flash(req, 'success', 'Policy deleted.');
  res.redirect('/admin/policies');
});

// ---------- My account (any staff member) ----------
router.get('/account', (req, res) => {
  res.render('admin/account', { title: 'My account', section: 'account' });
});
router.post('/account', async (req, res) => {
  const me = await db.get('SELECT * FROM users WHERE id=?', req.user.id);
  const { name = '', current = '', password = '', password2 = '' } = req.body;
  if (!name.trim()) { flash(req, 'error', 'Your name can’t be empty.'); return res.redirect('/admin/account'); }
  if (password) {
    if (!bcrypt.compareSync(current, me.password_hash)) { flash(req, 'error', 'Your current password is wrong, so nothing was changed.'); return res.redirect('/admin/account'); }
    if (password.length < 8 || password !== password2) { flash(req, 'error', 'New password not saved: use 8+ characters and type it twice.'); return res.redirect('/admin/account'); }
    await db.run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(password, 12), me.id);
  }
  await db.run('UPDATE users SET name=? WHERE id=?', name.trim(), me.id);
  flash(req, 'success', password ? 'Details and password updated.' : 'Details updated.');
  res.redirect('/admin/account');
});

// ---------- Enrolments ----------
router.get('/enrolments', adminOnly, async (req, res) => {
  const status = ['pending', 'active', 'completed', 'cancelled'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = await db.all(`SELECT e.*, u.name, u.email, c.title, b.name batch_name FROM enrolments e JOIN users u ON u.id=e.user_id JOIN courses c ON c.id=e.course_id
    LEFT JOIN batches b ON b.id=e.batch_id WHERE e.status=? ORDER BY e.created_at DESC`, status);
  res.render('admin/enrolments', { title: 'Enrolments', rows, status });
});
router.post('/enrolments/:id', adminOnly, async (req, res) => {
  if (['pending', 'active', 'completed', 'cancelled'].includes(req.body.status)) await db.run('UPDATE enrolments SET status=? WHERE id=?', req.body.status, req.params.id);
  flash(req, 'success', 'Enrolment updated.');
  res.redirect(back(req, '/admin/enrolments'));
});

// ---------- Enquiries ----------
router.get('/enquiries', adminOnly, async (req, res) => {
  const rows = await db.all(`SELECT q.*, c.title course_title, (SELECT id FROM users u WHERE lower(u.email)=lower(q.email)) user_id
    FROM enquiries q LEFT JOIN courses c ON c.id=q.course_id ORDER BY (q.status='new') DESC, q.id DESC`);
  res.render('admin/enquiries', { title: 'Enquiries', rows });
});
router.post('/enquiries/:id', adminOnly, async (req, res) => {
  const q = await db.get('SELECT * FROM enquiries WHERE id=?', req.params.id);
  if (!q) return res.redirect('/admin/enquiries');
  if (req.body.convert) {
    // Create (or reuse) the learner account and open the course, all in one go
    const temp = crypto.randomBytes(5).toString('hex');
    const result = await db.tx(async t => {
      let user = q.email && await t.get('SELECT * FROM users WHERE lower(email)=lower(?)', q.email);
      let msg = 'Learner enrolled.';
      if (!user) {
        if (!q.email) return null;
        user = await t.get("INSERT INTO users (name,email,phone,dob,postcode,password_hash,role) VALUES (?,?,?,?,?,?,'student') RETURNING id",
          q.name, q.email.toLowerCase(), q.phone, q.dob, q.postcode, bcrypt.hashSync(temp, 12));
        msg = `Account created and learner enrolled. Temporary password: ${temp}`;
      }
      if (q.course_id) await t.run("INSERT INTO enrolments (user_id,course_id,status) VALUES (?,?,'active') ON CONFLICT(user_id,course_id) DO UPDATE SET status='active'", user.id, q.course_id);
      await t.run("UPDATE enquiries SET status='enrolled' WHERE id=?", q.id);
      return { userId: user.id, msg };
    });
    if (!result) { flash(req, 'error', 'This enquiry has no email, so an account can’t be created.'); return res.redirect('/admin/enquiries'); }
    flash(req, 'success', result.msg);
    return res.redirect(`/admin/students/${result.userId}`);
  }
  if (['new', 'contacted', 'enrolled', 'closed'].includes(req.body.status)) await db.run('UPDATE enquiries SET status=? WHERE id=?', req.body.status, q.id);
  res.redirect('/admin/enquiries');
});

// ---------- Evidence review ----------
router.get('/submissions', async (req, res) => {
  const show = req.query.show === 'all' ? 'all' : 'open';
  const rows = await db.all(`SELECT s.*, u.name student, u.id student_id, l.title lesson_title, l.total_marks, c.title course_title, mk.name marker,
      COALESCE(NULLIF(al.due_date,''), NULLIF(ab.due_date,''), NULLIF(l.due_date,'')) due
    FROM submissions s JOIN users u ON u.id=s.user_id JOIN lessons l ON l.id=s.lesson_id JOIN modules m ON m.id=l.module_id JOIN courses c ON c.id=m.course_id
    LEFT JOIN assignment_learners al ON al.lesson_id=l.id AND al.user_id=s.user_id LEFT JOIN users mk ON mk.id=s.marked_by
    LEFT JOIN enrolments en ON en.user_id=s.user_id AND en.course_id=c.id LEFT JOIN assignment_batches ab ON ab.lesson_id=l.id AND ab.batch_id=en.batch_id
    WHERE (@show::text='all' OR s.reviewed_at IS NULL) AND ${myCourses(req)} ORDER BY s.id DESC LIMIT 200`, { show });
  res.render('admin/submissions', { title: 'Evidence review', rows, show });
});
const submissionCourse = id => db.get('SELECT m.course_id FROM submissions s JOIN lessons l ON l.id=s.lesson_id JOIN modules m ON m.id=l.module_id WHERE s.id=?', toId(id));
router.post('/submissions/:id', async (req, res, next) => {
  const sc = await submissionCourse(req.params.id);
  if (!sc) return next();
  if (!(await teaches(req, sc.course_id))) return noAccess(res);
  const locked = () => { flash(req, 'error', 'This work has already been marked and is locked, so nothing was changed.'); res.redirect(back(req, '/admin/submissions')); };
  // Once a mark is saved the submission is locked: the mark, feedback and decision can no longer be changed
  const sub = await db.get('SELECT s.user_id, s.lesson_id, s.mark, l.total_marks FROM submissions s JOIN lessons l ON l.id=s.lesson_id WHERE s.id=?', req.params.id);
  if (sub.mark !== null) return locked();
  const status = ['accepted', 'resubmit'].includes(req.body.status) ? req.body.status : 'submitted';
  // Mark is optional; when given it must be between 0 and the assignment's total
  const total = sub.total_marks;
  const raw = String(req.body.mark ?? '').trim();
  const mark = raw === '' ? null : Number(raw);
  if (mark !== null && (!Number.isFinite(mark) || mark < 0 || (total && mark > total))) {
    flash(req, 'error', total ? `Enter a mark between 0 and ${total}.` : 'Enter a mark of 0 or more.');
    return res.redirect(back(req, '/admin/submissions'));
  }
  const saved = await db.tx(async t => {
    const r = await t.run(`UPDATE submissions SET status=?, feedback=?, mark=?, marked_by=?, marked_at=${mark === null ? 'NULL' : 'now()'},
      reviewed_at=now() WHERE id=? AND mark IS NULL`, status, req.body.feedback || '', mark, mark === null ? null : req.user.id, req.params.id);
    // Someone else marked it a moment ago: change nothing
    if (!r.rowCount) return false;
    // A resubmission reopens the task in the learner's progress
    if (status === 'resubmit') await t.run('DELETE FROM lesson_progress WHERE user_id=? AND lesson_id=?', sub.user_id, sub.lesson_id);
    if (status === 'accepted') await t.run('INSERT INTO lesson_progress (user_id,lesson_id) VALUES (?,?) ON CONFLICT DO NOTHING', sub.user_id, sub.lesson_id);
    return true;
  });
  if (!saved) return locked();
  const markNote = mark === null ? '' : ` Mark saved and locked: ${markText(mark, total)}.`;
  flash(req, 'success', (status === 'accepted' ? 'Evidence accepted.' : 'Feedback sent — learner asked to resubmit.') + markNote);
  res.redirect(back(req, '/admin/submissions'));
});
// Admin-only safety valve for a mark entered by mistake: clears the mark so the work can be marked again
router.post('/submissions/:id/unlock', adminOnly, async (req, res, next) => {
  if (!(await submissionCourse(req.params.id))) return next();
  await db.run('UPDATE submissions SET mark=NULL, marked_by=NULL, marked_at=NULL WHERE id=?', req.params.id);
  flash(req, 'success', 'Mark cleared. This work can now be marked again.');
  res.redirect(back(req, '/admin/submissions'));
});
router.get('/evidence/:id', async (req, res, next) => {
  const s = await db.get('SELECT * FROM submissions WHERE id=?', req.params.id);
  if (!s) return next();
  if (!(await teaches(req, (await submissionCourse(s.id)).course_id))) return noAccess(res);
  const url = await storage.signedUrl('evidence', s.file, 60, s.original_name || s.file);
  if (!url) return res.status(404).render('public/error', { title: 'File not found', message: 'This evidence file is no longer in storage.' });
  res.redirect(url);
});

module.exports = router;
