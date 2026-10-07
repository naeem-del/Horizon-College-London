const router = require('express').Router();
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, slugify } = require('../db');
const fs = require('fs');
const { requireRole, flash, csrf, uploadImage, uploadPhoto, uploadLesson, uploadPolicy, uploadCourse } = require('../middleware');
const links = require('../password-links');
const { sendMail } = require('../mailer');
const { dueDate, markText } = require('../helpers');
const learning = require('../learning');
const scorm = require('../scorm');

const adminOnly = requireRole('admin');
router.use(requireRole('admin', 'tutor')); // tutors see dashboard, learners, their own courses and evidence review

// Admins can manage every course; tutors only the courses they're assigned to
const isAdmin = req => req.user.role === 'admin';
const teaches = (req, courseId) => isAdmin(req) || !!db.prepare('SELECT 1 FROM course_staff WHERE course_id=? AND user_id=?').get(courseId, req.user.id);
const noAccess = res => res.status(403).render('public/error', { title: 'No access', message: 'You’re not assigned to this course. Ask an administrator to add you to it.' });
// SQL condition limiting rows to the current user's courses (c = courses alias)
const myCourses = req => (isAdmin(req) ? '1=1' : `c.id IN (SELECT course_id FROM course_staff WHERE user_id=${Number(req.user.id)})`);

router.use((req, res, next) => {
  res.locals.adminCss = true;
  res.locals.badges = {
    enquiries: db.prepare("SELECT COUNT(*) n FROM enquiries WHERE status='new'").get().n,
    enrolments: db.prepare("SELECT COUNT(*) n FROM enrolments WHERE status='pending'").get().n,
    submissions: db.prepare(`SELECT COUNT(*) n FROM submissions s JOIN lessons l ON l.id=s.lesson_id JOIN modules m ON m.id=l.module_id
      JOIN courses c ON c.id=m.course_id WHERE s.reviewed_at IS NULL AND ${myCourses(req)}`).get().n,
  };
  next();
});

function uniqueSlug(table, base, id = 0) {
  let slug = slugify(base) || 'item', n = 2;
  while (db.prepare(`SELECT 1 FROM ${table} WHERE slug=? AND id<>?`).get(slug, id)) slug = `${slugify(base)}-${n++}`;
  return slug;
}
const back = (req, fallback) => req.get('Referer') || fallback;

// ---------- Dashboard ----------
router.get('/', (req, res) => {
  const stats = {
    students: db.prepare("SELECT COUNT(*) n FROM users WHERE role='student'").get().n,
    active: db.prepare("SELECT COUNT(*) n FROM enrolments WHERE status='active'").get().n,
    pending: db.prepare("SELECT COUNT(*) n FROM enrolments WHERE status='pending'").get().n,
    enquiries: db.prepare("SELECT COUNT(*) n FROM enquiries WHERE status='new'").get().n,
    toReview: res.locals.badges.submissions,
    courses: db.prepare('SELECT COUNT(*) n FROM courses').get().n,
  };
  const recentEnquiries = db.prepare(`SELECT q.*, c.title course_title FROM enquiries q LEFT JOIN courses c ON c.id=q.course_id ORDER BY q.id DESC LIMIT 6`).all();
  const recentSubs = db.prepare(`SELECT s.*, u.name student, l.title lesson_title FROM submissions s JOIN users u ON u.id=s.user_id JOIN lessons l ON l.id=s.lesson_id
    JOIN modules m ON m.id=l.module_id JOIN courses c ON c.id=m.course_id
    WHERE s.reviewed_at IS NULL AND ${myCourses(req)} ORDER BY s.id DESC LIMIT 6`).all();
  res.render('admin/dashboard', { title: 'Dashboard', stats, recentEnquiries, recentSubs });
});

// ---------- Awarding bodies ----------
router.get('/bodies', adminOnly, (req, res) => {
  const bodies = db.prepare('SELECT ab.*, (SELECT COUNT(*) FROM courses c WHERE c.awarding_body_id=ab.id) n FROM awarding_bodies ab ORDER BY name').all();
  res.render('admin/bodies', { title: 'Awarding bodies', bodies });
});
router.get('/bodies/new', adminOnly, (req, res) => res.render('admin/body-form', { title: 'Add awarding body', body: {} }));
router.get('/bodies/:id/edit', adminOnly, (req, res, next) => {
  const body = db.prepare('SELECT * FROM awarding_bodies WHERE id=?').get(req.params.id);
  if (!body) return next();
  res.render('admin/body-form', { title: `Edit ${body.name}`, body });
});
router.post('/bodies/save', adminOnly, uploadImage.single('logo'), csrf, (req, res) => {
  const id = Number(req.body.id) || 0;
  const name = (req.body.name || '').trim();
  if (!name) { flash(req, 'error', 'Enter the awarding body’s name.'); return res.redirect(back(req, '/admin/bodies')); }
  const data = { name, slug: uniqueSlug('awarding_bodies', name, id), website: req.body.website || '', description: req.body.description || '' };
  if (id) {
    db.prepare('UPDATE awarding_bodies SET name=@name, slug=@slug, website=@website, description=@description WHERE id=@id').run({ ...data, id });
    if (req.file) db.prepare('UPDATE awarding_bodies SET logo=? WHERE id=?').run(req.file.filename, id);
  } else {
    db.prepare('INSERT INTO awarding_bodies (name,slug,website,description,logo) VALUES (@name,@slug,@website,@description,@logo)').run({ ...data, logo: req.file ? req.file.filename : null });
  }
  flash(req, 'success', `${name} saved.`);
  res.redirect('/admin/bodies');
});
router.post('/bodies/:id/delete', adminOnly, (req, res) => {
  db.prepare('DELETE FROM awarding_bodies WHERE id=?').run(req.params.id);
  flash(req, 'success', 'Awarding body deleted. Its courses are kept without an awarding body.');
  res.redirect('/admin/bodies');
});

// ---------- Courses ----------
router.get('/courses', (req, res) => {
  const courses = db.prepare(`SELECT c.*, ab.name body_name,
      (SELECT COUNT(*) FROM enrolments e WHERE e.course_id=c.id AND e.status IN ('active','pending')) learners,
      (SELECT COUNT(*) FROM lessons l JOIN modules m ON m.id=l.module_id WHERE m.course_id=c.id) lessons,
      (SELECT GROUP_CONCAT(u.name, ', ') FROM course_staff cs JOIN users u ON u.id=cs.user_id WHERE cs.course_id=c.id) staff
    FROM courses c LEFT JOIN awarding_bodies ab ON ab.id=c.awarding_body_id WHERE ${myCourses(req)} ORDER BY c.title`).all();
  res.render('admin/courses', { title: isAdmin(req) ? 'Courses' : 'My courses', courses });
});
const bodyList = () => db.prepare('SELECT id,name FROM awarding_bodies ORDER BY name').all();
router.get('/courses/new', adminOnly, (req, res) => res.render('admin/course-form', { title: 'Add course', course: { published: 1, framework: 'RQF' }, bodies: bodyList() }));
router.get('/courses/:id/edit', adminOnly, (req, res, next) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!course) return next();
  res.render('admin/course-form', { title: `Edit course`, course, bodies: bodyList() });
});
router.post('/courses/save', adminOnly, uploadCourse, csrf, (req, res) => {
  const id = Number(req.body.id) || 0;
  const b = req.body;
  const image = req.files && req.files.image && req.files.image[0], pkg = req.files && req.files.scorm && req.files.scorm[0];
  const fromScorm = !id && b.mode === 'scorm';
  const reject = msg => {
    removeUpload('images', image && image.filename); removeUpload('scorm', pkg && pkg.filename);
    flash(req, 'error', msg); return res.redirect(back(req, '/admin/courses'));
  };
  if (pkg && !fromScorm) removeUpload('scorm', pkg.filename);
  // "Upload a SCORM package": unzip it first; the course title comes from the package unless one was typed
  let installed = null;
  if (fromScorm) {
    if (!pkg) return reject('Choose the SCORM package (.zip) to upload.');
    try { installed = scorm.install(pkg.path); } catch (err) {
      removeUpload('images', image && image.filename);
      flash(req, 'error', `The course wasn’t added: ${err.message}`); return res.redirect(back(req, '/admin/courses'));
    }
    if (!(b.title || '').trim()) b.title = installed.title || path.basename(pkg.originalname, path.extname(pkg.originalname));
  }
  if (!(b.title || '').trim()) return reject('Enter a course title.');
  const data = {
    title: b.title.trim(), slug: uniqueSlug('courses', b.slug || b.title, id),
    awarding_body_id: Number(b.awarding_body_id) || null, level: b.level || '', qualification_type: b.qualification_type || '',
    framework: b.framework || '', duration: b.duration || '', study_mode: b.study_mode || '', price: Number(b.price) || 0,
    summary: b.summary || '', description: b.description || '', entry_requirements: b.entry_requirements || '', assessment: b.assessment || '',
    published: b.published ? 1 : 0, featured: b.featured ? 1 : 0,
  };
  let courseId = id;
  if (id) {
    db.prepare(`UPDATE courses SET title=@title, slug=@slug, awarding_body_id=@awarding_body_id, level=@level, qualification_type=@qualification_type,
      framework=@framework, duration=@duration, study_mode=@study_mode, price=@price, summary=@summary, description=@description,
      entry_requirements=@entry_requirements, assessment=@assessment, published=@published, featured=@featured WHERE id=@id`).run({ ...data, id });
  } else {
    courseId = db.prepare(`INSERT INTO courses (title,slug,awarding_body_id,level,qualification_type,framework,duration,study_mode,price,summary,description,entry_requirements,assessment,published,featured)
      VALUES (@title,@slug,@awarding_body_id,@level,@qualification_type,@framework,@duration,@study_mode,@price,@summary,@description,@entry_requirements,@assessment,@published,@featured)`).run(data).lastInsertRowid;
  }
  if (image) db.prepare('UPDATE courses SET image=? WHERE id=?').run(image.filename, courseId);
  if (installed) {
    // Each unit in the package becomes a module, and each activity in it a lesson that launches that activity
    const addModule = db.prepare('INSERT INTO modules (course_id,title,position) VALUES (?,?,?)');
    const addLesson = db.prepare(`INSERT INTO lessons (module_id,title,kind,content,position,scorm_folder,scorm_launch,scorm_version) VALUES (?,?,'lesson','',?,?,?,?)`);
    installed.units.forEach((u, i) => {
      const moduleId = addModule.run(courseId, u.title, i + 1).lastInsertRowid;
      u.lessons.forEach((l, j) => addLesson.run(moduleId, l.title, j + 1, installed.folder, l.launch, installed.version));
    });
    if (installed.description && !data.summary && !data.description) {
      db.prepare('UPDATE courses SET summary=?, description=? WHERE id=?').run(installed.description.slice(0, 220), installed.description, courseId);
    }
    const n = installed.units.length;
    flash(req, 'success', `Course added from the SCORM ${installed.version} package: ${n} unit${n === 1 ? '' : 's'} and ${installed.count} lesson${installed.count === 1 ? '' : 's'}, set up from the package. Use Edit to fill in the course details for the website.`);
    return res.redirect(`/admin/courses/${courseId}/content`);
  }
  flash(req, 'success', id ? 'Course saved.' : 'Course added. Now add its modules and lessons.');
  res.redirect(id ? '/admin/courses' : `/admin/courses/${courseId}/content`);
});
router.post('/courses/:id/delete', adminOnly, (req, res) => {
  const packages = db.prepare('SELECT l.scorm_folder FROM lessons l JOIN modules m ON m.id=l.module_id WHERE m.course_id=? AND l.scorm_folder IS NOT NULL').all(req.params.id);
  db.prepare('DELETE FROM courses WHERE id=?').run(req.params.id);
  for (const p of packages) scorm.remove(p.scorm_folder);
  flash(req, 'success', 'Course deleted.');
  res.redirect('/admin/courses');
});

// ---------- Course content (modules & lessons) ----------
router.get('/courses/:id/content', (req, res, next) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!course) return next();
  if (!teaches(req, course.id)) return noAccess(res);
  const modules = db.prepare('SELECT * FROM modules WHERE course_id=? ORDER BY position, id').all(course.id);
  const lessons = db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM assignment_learners al WHERE al.lesson_id=l.id) picked
    FROM lessons l JOIN modules m ON m.id=l.module_id WHERE m.course_id=? ORDER BY l.position, l.id`).all(course.id);
  for (const m of modules) m.lessons = lessons.filter(l => l.module_id === m.id);
  const staff = db.prepare('SELECT u.id, u.name, u.role, u.photo FROM course_staff cs JOIN users u ON u.id=cs.user_id WHERE cs.course_id=? ORDER BY u.name').all(course.id);
  const otherStaff = isAdmin(req) ? db.prepare(`SELECT id, name, role FROM users WHERE role<>'student'
    AND id NOT IN (SELECT user_id FROM course_staff WHERE course_id=?) ORDER BY name`).all(course.id) : [];
  res.render('admin/content', { title: `Content: ${course.title}`, course, modules, staff, otherStaff, section: 'courses' });
});

// ---------- Course staff ----------
router.post('/courses/:id/staff', adminOnly, (req, res) => {
  const u = db.prepare("SELECT id FROM users WHERE id=? AND role<>'student'").get(req.body.user_id);
  const c = db.prepare('SELECT id FROM courses WHERE id=?').get(req.params.id);
  if (u && c) {
    db.prepare('INSERT OR IGNORE INTO course_staff (course_id,user_id) VALUES (?,?)').run(c.id, u.id);
    flash(req, 'success', 'Staff member assigned. They can now manage this course’s content and review its evidence.');
  }
  res.redirect(back(req, `/admin/courses/${req.params.id}/content`));
});
router.post('/students/:id/teach', adminOnly, (req, res) => {
  const u = db.prepare("SELECT id FROM users WHERE id=? AND role<>'student'").get(req.params.id);
  const c = db.prepare('SELECT id FROM courses WHERE id=?').get(req.body.course_id);
  if (u && c) {
    db.prepare('INSERT OR IGNORE INTO course_staff (course_id,user_id) VALUES (?,?)').run(c.id, u.id);
    flash(req, 'success', 'Assigned to the course. They can now manage its content and review its evidence.');
  }
  res.redirect(`/admin/students/${req.params.id}`);
});
router.post('/courses/:id/staff/:uid/remove', adminOnly, (req, res) => {
  db.prepare('DELETE FROM course_staff WHERE course_id=? AND user_id=?').run(req.params.id, req.params.uid);
  flash(req, 'success', 'Staff member removed from the course.');
  res.redirect(back(req, `/admin/courses/${req.params.id}/content`));
});

router.post('/courses/:id/modules', (req, res) => {
  if (!teaches(req, req.params.id)) return noAccess(res);
  const title = (req.body.title || '').trim();
  if (title) {
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM modules WHERE course_id=?').get(req.params.id).p;
    db.prepare('INSERT INTO modules (course_id,title,position) VALUES (?,?,?)').run(req.params.id, title, pos);
  }
  res.redirect(`/admin/courses/${req.params.id}/content`);
});
router.post('/modules/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM modules WHERE id=?').get(req.params.id);
  if (!m) return res.redirect('/admin/courses');
  if (!teaches(req, m.course_id)) return noAccess(res);
  if (req.body.delete) db.prepare('DELETE FROM modules WHERE id=?').run(m.id);
  else if (req.body.move) {
    const dir = req.body.move === 'up' ? '<' : '>';
    const order = req.body.move === 'up' ? 'DESC' : 'ASC';
    const other = db.prepare(`SELECT * FROM modules WHERE course_id=? AND position ${dir} ? ORDER BY position ${order} LIMIT 1`).get(m.course_id, m.position);
    if (other) { db.prepare('UPDATE modules SET position=? WHERE id=?').run(other.position, m.id); db.prepare('UPDATE modules SET position=? WHERE id=?').run(m.position, other.id); }
  } else if ((req.body.title || '').trim()) db.prepare('UPDATE modules SET title=? WHERE id=?').run(req.body.title.trim(), m.id);
  res.redirect(`/admin/courses/${m.course_id}/content`);
});
// Learners who can be set an assignment: everyone enrolled on the course and not cancelled
const courseLearners = courseId => db.prepare(`SELECT u.id, u.name, u.email, e.status FROM enrolments e JOIN users u ON u.id=e.user_id
  WHERE e.course_id=? AND e.status<>'cancelled' ORDER BY u.name`).all(courseId);
const lessonCourse = lessonId => db.prepare('SELECT m.course_id FROM lessons l JOIN modules m ON m.id=l.module_id WHERE l.id=?').get(lessonId);
const removeUpload = (folder, file) => { if (file) fs.unlink(path.join(__dirname, '..', 'uploads', folder, path.basename(file)), () => {}); };
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

function renderLessonForm(res, module, lesson) {
  const course = db.prepare('SELECT id, title, slug FROM courses WHERE id=?').get(module.course_id);
  const picked = {};
  if (lesson.id) for (const a of db.prepare('SELECT user_id, due_date FROM assignment_learners WHERE lesson_id=?').all(lesson.id)) picked[a.user_id] = a.due_date || '';
  res.render('admin/lesson-form', { title: lesson.id ? 'Edit lesson' : 'Add lesson', module, lesson, course, learners: courseLearners(module.course_id), picked, section: 'courses' });
}
router.get('/modules/:id/lessons/new', (req, res, next) => {
  const module = db.prepare('SELECT * FROM modules WHERE id=?').get(req.params.id);
  if (!module) return next();
  if (!teaches(req, module.course_id)) return noAccess(res);
  renderLessonForm(res, module, { kind: req.query.kind === 'assignment' ? 'assignment' : 'lesson', assign_to: 'all' });
});
router.get('/lessons/:id/edit', (req, res, next) => {
  const lesson = db.prepare('SELECT * FROM lessons WHERE id=?').get(req.params.id);
  if (!lesson) return next();
  const module = db.prepare('SELECT * FROM modules WHERE id=?').get(lesson.module_id);
  if (!teaches(req, module.course_id)) return noAccess(res);
  renderLessonForm(res, module, lesson);
});
router.post('/lessons/save', uploadLesson, csrf, async (req, res) => {
  const files = req.files || {};
  const attachment = files.attachment && files.attachment[0], video = files.video && files.video[0], pkg = files.scorm && files.scorm[0];
  const discard = () => { removeUpload('files', attachment && attachment.filename); removeUpload('videos', video && video.filename); removeUpload('scorm', pkg && pkg.filename); };
  const id = Number(req.body.id) || 0;
  const module = db.prepare('SELECT * FROM modules WHERE id=?').get(req.body.module_id);
  const existing = id ? db.prepare('SELECT * FROM lessons WHERE id=?').get(id) : null;
  if (!module || (id && !existing)) { discard(); return res.redirect('/admin/courses'); }
  // Both the target module and (when editing) the lesson's current course must be one this user teaches
  if (!teaches(req, module.course_id) || (existing && !teaches(req, lessonCourse(id).course_id))) { discard(); return noAccess(res); }

  const b = req.body;
  const kind = b.kind === 'assignment' ? 'assignment' : 'lesson';
  // Unzip the SCORM package first, so a bad package stops the save before anything changes
  let installed = null;
  if (pkg && kind === 'lesson') {
    try { installed = scorm.install(pkg.path); } catch (err) {
      removeUpload('files', attachment && attachment.filename); removeUpload('videos', video && video.filename);
      flash(req, 'error', `The SCORM package wasn’t added: ${err.message} Nothing was saved.`);
      return res.redirect(id ? `/admin/lessons/${id}/edit` : `/admin/modules/${module.id}/lessons/new`);
    }
  } else if (pkg) removeUpload('scorm', pkg.filename);
  if (installed && !(b.title || '').trim()) b.title = installed.title;
  const data = {
    title: (b.title || 'Untitled lesson').trim(), kind, content: b.content || '', video_url: (b.video_url || '').trim(),
    due_date: kind === 'assignment' && isDate(b.due_date) ? b.due_date : null,
    assign_to: kind === 'assignment' && b.assign_to === 'selected' ? 'selected' : 'all',
    total_marks: kind === 'assignment' && Number(b.total_marks) > 0 ? Math.min(Number(b.total_marks), 10000) : null,
  };
  let lessonId = id;
  if (id) db.prepare('UPDATE lessons SET title=@title, kind=@kind, content=@content, video_url=@video_url, due_date=@due_date, assign_to=@assign_to, total_marks=@total_marks WHERE id=@id').run({ ...data, id });
  else {
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM lessons WHERE module_id=?').get(module.id).p;
    lessonId = db.prepare(`INSERT INTO lessons (module_id,title,kind,content,video_url,due_date,assign_to,total_marks,position)
      VALUES (@module_id,@title,@kind,@content,@video_url,@due_date,@assign_to,@total_marks,@position)`).run({ ...data, module_id: module.id, position: pos }).lastInsertRowid;
  }
  if (attachment || b.remove_attachment) { removeUpload('files', existing && existing.attachment); db.prepare('UPDATE lessons SET attachment=? WHERE id=?').run(attachment ? attachment.filename : null, lessonId); }
  // Assignments can't hold a package; replacing or removing one deletes the old files and learners' saved attempts
  if (installed || ((b.remove_scorm || kind === 'assignment') && existing && existing.scorm_folder)) {
    db.prepare('DELETE FROM scorm_attempts WHERE lesson_id=?').run(lessonId);
    db.prepare('UPDATE lessons SET scorm_folder=?, scorm_launch=?, scorm_version=? WHERE id=?')
      .run(installed ? installed.folder : null, installed ? installed.launch : null, installed ? installed.version : null, lessonId);
    scorm.remove(existing && existing.scorm_folder);
  }
  if (video || b.remove_video) { removeUpload('videos', existing && existing.video_file); db.prepare('UPDATE lessons SET video_file=? WHERE id=?').run(video ? video.filename : null, lessonId); }

  // Which learners the assignment is set for, each with an optional individual deadline
  db.prepare('DELETE FROM assignment_learners WHERE lesson_id=?').run(lessonId);
  const enrolled = courseLearners(module.course_id);
  if (kind === 'assignment' && data.assign_to === 'selected') {
    const chosen = new Set([].concat(b.learners || []).map(Number));
    for (const l of enrolled.filter(l => chosen.has(l.id))) {
      const own = b[`due_${l.id}`];
      db.prepare('INSERT INTO assignment_learners (lesson_id,user_id,due_date) VALUES (?,?,?)').run(lessonId, l.id, isDate(own) ? own : null);
    }
  }

  let note = kind === 'assignment' ? 'Assignment saved.' : 'Lesson saved.';
  if (installed && installed.count > 1) note += ` This package has ${installed.count} activities; this lesson plays the first one. To get every unit and activity as its own lesson, create a course from the package instead (Courses → Add course → Upload a SCORM package).`;
  if (kind === 'assignment' && b.notify) {
    const course = db.prepare('SELECT title, slug FROM courses WHERE id=?').get(module.course_id);
    const own = Object.fromEntries(db.prepare('SELECT user_id, due_date FROM assignment_learners WHERE lesson_id=?').all(lessonId).map(a => [a.user_id, a.due_date]));
    const targets = enrolled.filter(l => l.status === 'active' && (data.assign_to === 'all' || l.id in own));
    const link = `${links.baseUrl(req)}/portal/courses/${course.slug}/lessons/${lessonId}`;
    const results = await Promise.all(targets.map(l => {
      const due = own[l.id] || data.due_date;
      return sendMail({
        to: l.email, subject: `New assignment: ${data.title}`,
        text: `Hello ${l.name},\n\nA new assignment has been set for you on ${course.title}: ${data.title}.\n\n`
          + (due ? `Deadline: ${dueDate(due)}\n\n` : '') + `Open it here:\n${link}\n\n${process.env.SITE_NAME || 'Horizon College London'}`,
      });
    }));
    const sent = results.filter(Boolean).length;
    note += targets.length ? ` Emailed ${sent} of ${targets.length} learner${targets.length === 1 ? '' : 's'}${sent < targets.length ? ' (check the SMTP settings)' : ''}.` : ' No active learners to email yet.';
  }
  flash(req, 'success', note);
  res.redirect(`/admin/courses/${module.course_id}/content`);
});
router.post('/lessons/:id/delete', (req, res) => {
  const l = db.prepare('SELECT l.attachment, l.video_file, l.scorm_folder, m.course_id FROM lessons l JOIN modules m ON m.id=l.module_id WHERE l.id=?').get(req.params.id);
  if (!l) return res.redirect('/admin/courses');
  if (!teaches(req, l.course_id)) return noAccess(res);
  db.prepare('DELETE FROM lessons WHERE id=?').run(req.params.id);
  removeUpload('files', l.attachment); removeUpload('videos', l.video_file); scorm.remove(l.scorm_folder);
  res.redirect(`/admin/courses/${l.course_id}/content`);
});

// ---------- Learners & staff ----------
// Learners and staff share the users table; they are listed separately by role
const listUrl = role => (role === 'student' ? '/admin/students' : '/admin/staff');
function listAccounts(kind) {
  return (req, res) => {
    const q = (req.query.q || '').trim();
    const students = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM enrolments e WHERE e.user_id=u.id) courses FROM users u
      WHERE ${kind === 'staff' ? "u.role<>'student'" : "u.role='student'"} AND (@q='' OR u.name LIKE @like OR u.email LIKE @like)
      ORDER BY u.created_at DESC LIMIT 200`).all({ q, like: `%${q}%` });
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
const removePhoto = file => { if (file) fs.unlink(path.join(__dirname, '..', 'uploads', 'images', file), () => {}); };

router.post('/students', adminOnly, uploadPhoto.single('photo'), csrf, async (req, res) => {
  const p = profileFields(req.body), email = (req.body.email || '').trim().toLowerCase();
  const role = ['student', 'tutor', 'admin'].includes(req.body.role) ? req.body.role : 'student';
  const photo = req.file ? req.file.filename : null;
  const reject = msg => { removePhoto(photo); flash(req, 'error', msg); res.redirect(listUrl(role)); };
  if (!p.name || !/^\S+@\S+\.\S+$/.test(email)) return reject('Enter a name and a valid email.');
  if (db.prepare('SELECT 1 FROM users WHERE lower(email)=?').get(email)) return reject('That email already has an account.');
  // Random unknown password: the new user chooses their own from the emailed link
  const id = db.prepare('INSERT INTO users (name,first_name,last_name,email,phone,address,postcode,photo,password_hash,role) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(p.name, p.first_name, p.last_name, email, p.phone, p.address, p.postcode, photo, bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 12), role).lastInsertRowid;
  const invite = await links.sendInvite(req, db.prepare('SELECT * FROM users WHERE id=?').get(id));
  flash(req, invite.sent ? 'success' : 'error', invite.sent
    ? `Account created. An email has been sent to ${email} with a link to set their password.`
    : `Account created, but the email couldn’t be sent (check the SMTP settings). Send them this link to set their password, valid for 7 days: ${invite.link}`);
  res.redirect(`/admin/students/${id}`);
});
router.get('/students/:id', (req, res, next) => {
  const student = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!student) return next();
  const enrolments = db.prepare(`SELECT e.*, c.title, c.slug FROM enrolments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=? ORDER BY e.created_at DESC`).all(student.id);
  for (const e of enrolments) e.pct = learning.progress(student.id, e.course_id).pct;
  const submissions = db.prepare(`SELECT s.*, l.title lesson_title, l.total_marks FROM submissions s JOIN lessons l ON l.id=s.lesson_id WHERE s.user_id=? ORDER BY s.id DESC`).all(student.id);
  const scormResults = db.prepare(`SELECT a.*, l.title lesson_title, c.title course_title FROM scorm_attempts a JOIN lessons l ON l.id=a.lesson_id
    JOIN modules m ON m.id=l.module_id JOIN courses c ON c.id=m.course_id WHERE a.user_id=? ORDER BY a.updated_at DESC`).all(student.id);
  const courses = db.prepare('SELECT id,title FROM courses ORDER BY title').all();
  const teaching = db.prepare('SELECT c.id, c.title FROM course_staff cs JOIN courses c ON c.id=cs.course_id WHERE cs.user_id=? ORDER BY c.title').all(student.id);
  res.render('admin/student', { title: student.name, student, enrolments, submissions, scormResults, courses, teaching, section: student.role === 'student' ? 'learners' : 'staff' });
});
router.post('/students/:id/role', adminOnly, (req, res) => {
  if (Number(req.params.id) === req.user.id) { flash(req, 'error', 'You can’t change your own role.'); return res.redirect(back(req, '/admin/students')); }
  if (['student', 'tutor', 'admin'].includes(req.body.role)) db.prepare('UPDATE users SET role=? WHERE id=?').run(req.body.role, req.params.id);
  flash(req, 'success', 'Role updated.');
  res.redirect(`/admin/students/${req.params.id}`);
});
router.post('/students/:id/details', adminOnly, uploadPhoto.single('photo'), csrf, (req, res, next) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) { removePhoto(req.file && req.file.filename); return next(); }
  const p = profileFields(req.body);
  if (!p.name) { removePhoto(req.file && req.file.filename); flash(req, 'error', 'Enter a first and last name.'); return res.redirect(`/admin/students/${u.id}`); }
  let photo = u.photo;
  if (req.file || req.body.remove_photo) { removePhoto(u.photo); photo = req.file ? req.file.filename : null; }
  db.prepare('UPDATE users SET name=?, first_name=?, last_name=?, phone=?, address=?, postcode=?, photo=? WHERE id=?')
    .run(p.name, p.first_name, p.last_name, p.phone, p.address, p.postcode, photo, u.id);
  flash(req, 'success', 'Details updated.');
  res.redirect(`/admin/students/${u.id}`);
});
router.post('/students/:id/invite', adminOnly, async (req, res, next) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return next();
  const invite = await links.sendInvite(req, u);
  flash(req, invite.sent ? 'success' : 'error', invite.sent
    ? `A new set-password link has been emailed to ${u.email}. Any earlier link no longer works.`
    : `The email couldn’t be sent (check the SMTP settings). Send them this link instead, valid for 7 days: ${invite.link}`);
  res.redirect(`/admin/students/${u.id}`);
});
router.post('/students/:id/enrol', adminOnly, (req, res) => {
  db.prepare("INSERT INTO enrolments (user_id,course_id,status) VALUES (?,?,'active') ON CONFLICT(user_id,course_id) DO UPDATE SET status='active'").run(req.params.id, req.body.course_id);
  flash(req, 'success', 'Learner enrolled and course opened.');
  res.redirect(`/admin/students/${req.params.id}`);
});
router.post('/students/:id/delete', adminOnly, (req, res) => {
  if (Number(req.params.id) === req.user.id) { flash(req, 'error', 'You can’t delete your own account.'); return res.redirect('/admin/students'); }
  const gone = db.prepare('SELECT role, photo FROM users WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  if (gone) removePhoto(gone.photo);
  flash(req, 'success', 'Account deleted.');
  res.redirect(listUrl(gone ? gone.role : 'student'));
});

// ---------- Policies ----------
// Admins upload and manage; tutors see the ones meant for staff
router.get('/policies', (req, res) => {
  const policies = db.prepare(`SELECT * FROM policies ${isAdmin(req) ? '' : "WHERE audience IN ('all','staff')"} ORDER BY title`).all();
  const editing = isAdmin(req) && req.query.edit ? db.prepare('SELECT * FROM policies WHERE id=?').get(req.query.edit) : null;
  res.render('admin/policies', { title: 'Policies', policies, editing, section: 'policies' });
});
router.post('/policies/save', adminOnly, uploadPolicy.single('file'), csrf, (req, res) => {
  const id = Number(req.body.id) || 0;
  const existing = id ? db.prepare('SELECT * FROM policies WHERE id=?').get(id) : null;
  const title = (req.body.title || '').trim();
  const audience = ['all', 'staff', 'learners'].includes(req.body.audience) ? req.body.audience : 'all';
  const reject = msg => { removeUpload('policies', req.file && req.file.filename); flash(req, 'error', msg); res.redirect(id ? `/admin/policies?edit=${id}` : '/admin/policies'); };
  if (id && !existing) return reject('That policy no longer exists.');
  if (!title) return reject('Enter a title for the policy.');
  if (!req.file && !existing) return reject('Choose the policy file to upload: PDF or Word, up to 20 MB.');
  if (existing) {
    db.prepare('UPDATE policies SET title=?, description=?, audience=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(title, (req.body.description || '').trim(), audience, id);
    if (req.file) {
      removeUpload('policies', existing.file);
      db.prepare('UPDATE policies SET file=?, original_name=? WHERE id=?').run(req.file.filename, req.file.originalname, id);
    }
  } else {
    db.prepare('INSERT INTO policies (title,description,file,original_name,audience) VALUES (?,?,?,?,?)')
      .run(title, (req.body.description || '').trim(), req.file.filename, req.file.originalname, audience);
  }
  flash(req, 'success', existing ? 'Policy updated.' : 'Policy added.');
  res.redirect('/admin/policies');
});
router.post('/policies/:id/delete', adminOnly, (req, res) => {
  const p = db.prepare('SELECT file FROM policies WHERE id=?').get(req.params.id);
  if (p) { db.prepare('DELETE FROM policies WHERE id=?').run(req.params.id); removeUpload('policies', p.file); }
  flash(req, 'success', 'Policy deleted.');
  res.redirect('/admin/policies');
});

// ---------- My account (any staff member) ----------
router.get('/account', (req, res) => {
  res.render('admin/account', { title: 'My account', section: 'account' });
});
router.post('/account', (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const { name = '', current = '', password = '', password2 = '' } = req.body;
  if (!name.trim()) { flash(req, 'error', 'Your name can’t be empty.'); return res.redirect('/admin/account'); }
  if (password) {
    if (!bcrypt.compareSync(current, me.password_hash)) { flash(req, 'error', 'Your current password is wrong, so nothing was changed.'); return res.redirect('/admin/account'); }
    if (password.length < 8 || password !== password2) { flash(req, 'error', 'New password not saved: use 8+ characters and type it twice.'); return res.redirect('/admin/account'); }
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 12), me.id);
  }
  db.prepare('UPDATE users SET name=? WHERE id=?').run(name.trim(), me.id);
  flash(req, 'success', password ? 'Details and password updated.' : 'Details updated.');
  res.redirect('/admin/account');
});

// ---------- Enrolments ----------
router.get('/enrolments', adminOnly, (req, res) => {
  const status = ['pending', 'active', 'completed', 'cancelled'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = db.prepare(`SELECT e.*, u.name, u.email, c.title FROM enrolments e JOIN users u ON u.id=e.user_id JOIN courses c ON c.id=e.course_id
    WHERE e.status=? ORDER BY e.created_at DESC`).all(status);
  res.render('admin/enrolments', { title: 'Enrolments', rows, status });
});
router.post('/enrolments/:id', adminOnly, (req, res) => {
  if (['pending', 'active', 'completed', 'cancelled'].includes(req.body.status)) db.prepare('UPDATE enrolments SET status=? WHERE id=?').run(req.body.status, req.params.id);
  flash(req, 'success', 'Enrolment updated.');
  res.redirect(back(req, '/admin/enrolments'));
});

// ---------- Enquiries ----------
router.get('/enquiries', adminOnly, (req, res) => {
  const rows = db.prepare(`SELECT q.*, c.title course_title, (SELECT id FROM users u WHERE lower(u.email)=lower(q.email)) user_id
    FROM enquiries q LEFT JOIN courses c ON c.id=q.course_id ORDER BY (q.status='new') DESC, q.id DESC`).all();
  res.render('admin/enquiries', { title: 'Enquiries', rows });
});
router.post('/enquiries/:id', adminOnly, (req, res) => {
  const q = db.prepare('SELECT * FROM enquiries WHERE id=?').get(req.params.id);
  if (!q) return res.redirect('/admin/enquiries');
  if (req.body.convert) {
    // Create (or reuse) the learner account and open the course
    let user = q.email && db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(q.email);
    let msg = 'Learner enrolled.';
    if (!user) {
      if (!q.email) { flash(req, 'error', 'This enquiry has no email, so an account can’t be created.'); return res.redirect('/admin/enquiries'); }
      const temp = crypto.randomBytes(5).toString('hex');
      const id = db.prepare("INSERT INTO users (name,email,phone,dob,postcode,password_hash,role) VALUES (?,?,?,?,?,?,'student')")
        .run(q.name, q.email.toLowerCase(), q.phone, q.dob, q.postcode, bcrypt.hashSync(temp, 12)).lastInsertRowid;
      user = { id };
      msg = `Account created and learner enrolled. Temporary password: ${temp}`;
    }
    if (q.course_id) db.prepare("INSERT INTO enrolments (user_id,course_id,status) VALUES (?,?,'active') ON CONFLICT(user_id,course_id) DO UPDATE SET status='active'").run(user.id, q.course_id);
    db.prepare("UPDATE enquiries SET status='enrolled' WHERE id=?").run(q.id);
    flash(req, 'success', msg);
    return res.redirect(`/admin/students/${user.id}`);
  }
  if (['new', 'contacted', 'enrolled', 'closed'].includes(req.body.status)) db.prepare('UPDATE enquiries SET status=? WHERE id=?').run(req.body.status, q.id);
  res.redirect('/admin/enquiries');
});

// ---------- Evidence review ----------
router.get('/submissions', (req, res) => {
  const show = req.query.show === 'all' ? 'all' : 'open';
  const rows = db.prepare(`SELECT s.*, u.name student, u.id student_id, l.title lesson_title, l.total_marks, c.title course_title, mk.name marker,
      COALESCE(NULLIF(al.due_date,''), NULLIF(l.due_date,'')) due
    FROM submissions s JOIN users u ON u.id=s.user_id JOIN lessons l ON l.id=s.lesson_id JOIN modules m ON m.id=l.module_id JOIN courses c ON c.id=m.course_id
    LEFT JOIN assignment_learners al ON al.lesson_id=l.id AND al.user_id=s.user_id LEFT JOIN users mk ON mk.id=s.marked_by
    WHERE (@show='all' OR s.reviewed_at IS NULL) AND ${myCourses(req)} ORDER BY s.id DESC LIMIT 200`).all({ show });
  res.render('admin/submissions', { title: 'Evidence review', rows, show });
});
const submissionCourse = id => db.prepare('SELECT m.course_id FROM submissions s JOIN lessons l ON l.id=s.lesson_id JOIN modules m ON m.id=l.module_id WHERE s.id=?').get(id);
router.post('/submissions/:id', (req, res, next) => {
  const sc = submissionCourse(req.params.id);
  if (!sc) return next();
  if (!teaches(req, sc.course_id)) return noAccess(res);
  // Once a mark is saved the submission is locked: the mark, feedback and decision can no longer be changed
  if (db.prepare('SELECT mark FROM submissions WHERE id=?').get(req.params.id).mark !== null) {
    flash(req, 'error', 'This work has already been marked and is locked, so nothing was changed.');
    return res.redirect(back(req, '/admin/submissions'));
  }
  const status = ['accepted', 'resubmit'].includes(req.body.status) ? req.body.status : 'submitted';
  // Mark is optional; when given it must be between 0 and the assignment's total
  const total = db.prepare('SELECT l.total_marks FROM submissions s JOIN lessons l ON l.id=s.lesson_id WHERE s.id=?').get(req.params.id).total_marks;
  const raw = String(req.body.mark ?? '').trim();
  const mark = raw === '' ? null : Number(raw);
  if (mark !== null && (!Number.isFinite(mark) || mark < 0 || (total && mark > total))) {
    flash(req, 'error', total ? `Enter a mark between 0 and ${total}.` : 'Enter a mark of 0 or more.');
    return res.redirect(back(req, '/admin/submissions'));
  }
  db.prepare(`UPDATE submissions SET status=?, feedback=?, mark=?, marked_by=?, marked_at=${mark === null ? 'NULL' : 'CURRENT_TIMESTAMP'},
    reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND mark IS NULL`).run(status, req.body.feedback || '', mark, mark === null ? null : req.user.id, req.params.id);
  // A resubmission reopens the task in the learner's progress
  const sub = db.prepare('SELECT user_id, lesson_id FROM submissions WHERE id=?').get(req.params.id);
  if (sub && status === 'resubmit') db.prepare('DELETE FROM lesson_progress WHERE user_id=? AND lesson_id=?').run(sub.user_id, sub.lesson_id);
  if (sub && status === 'accepted') db.prepare('INSERT OR IGNORE INTO lesson_progress (user_id,lesson_id) VALUES (?,?)').run(sub.user_id, sub.lesson_id);
  const markNote = mark === null ? '' : ` Mark saved and locked: ${markText(mark, total)}.`;
  flash(req, 'success', (status === 'accepted' ? 'Evidence accepted.' : 'Feedback sent — learner asked to resubmit.') + markNote);
  res.redirect(back(req, '/admin/submissions'));
});
// Admin-only safety valve for a mark entered by mistake: clears the mark so the work can be marked again
router.post('/submissions/:id/unlock', adminOnly, (req, res, next) => {
  if (!submissionCourse(req.params.id)) return next();
  db.prepare('UPDATE submissions SET mark=NULL, marked_by=NULL, marked_at=NULL WHERE id=?').run(req.params.id);
  flash(req, 'success', 'Mark cleared. This work can now be marked again.');
  res.redirect(back(req, '/admin/submissions'));
});
router.get('/evidence/:id', (req, res, next) => {
  const s = db.prepare('SELECT * FROM submissions WHERE id=?').get(req.params.id);
  if (!s) return next();
  if (!teaches(req, submissionCourse(s.id).course_id)) return noAccess(res);
  res.download(path.join(__dirname, '..', 'uploads', 'evidence', s.file), s.original_name, err => {
    if (err && !res.headersSent) res.status(404).render('public/error', { title: 'File not found', message: 'This evidence file is no longer on the server.' });
  });
});

module.exports = router;
