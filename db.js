// Uses the SQLite built into Node.js (22.5+), so there is nothing to compile on Windows or your server
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');

const raw = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'data', 'college.db'));
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Small wrapper: lets queries ignore extra keys in parameter objects
const db = {
  exec: sql => raw.exec(sql),
  prepare(sql) {
    const st = raw.prepare(sql);
    st.setAllowUnknownNamedParameters(true);
    return st;
  },
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','tutor','admin')),
  phone TEXT, dob TEXT, postcode TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS awarding_bodies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  logo TEXT, website TEXT, description TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  awarding_body_id INTEGER REFERENCES awarding_bodies(id) ON DELETE SET NULL,
  level TEXT, qualification_type TEXT, framework TEXT DEFAULT 'RQF',
  duration TEXT, study_mode TEXT, price REAL DEFAULT 0,
  summary TEXT, description TEXT, entry_requirements TEXT, assessment TEXT,
  image TEXT, published INTEGER DEFAULT 1, featured INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL, position INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'lesson' CHECK (kind IN ('lesson','assignment')),
  content TEXT, video_url TEXT, attachment TEXT,
  position INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS enrolments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','completed','cancelled')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, course_id)
);
CREATE TABLE IF NOT EXISTS lesson_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  file TEXT, original_name TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','resubmit','accepted')),
  feedback TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, email TEXT, phone TEXT, dob TEXT, postcode TEXT,
  course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  message TEXT, status TEXT DEFAULT 'new' CHECK (status IN ('new','contacted','enrolled','closed')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS course_staff (
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (course_id, user_id)
);
-- Learners an assignment is set for when it isn't set for the whole course, with optional individual deadlines
CREATE TABLE IF NOT EXISTS assignment_learners (
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_date TEXT,
  PRIMARY KEY (lesson_id, user_id)
);
-- Policy documents uploaded by admins; files live in uploads/policies and are only served to logged-in users
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, description TEXT,
  file TEXT NOT NULL, original_name TEXT,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','staff','learners')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- What a SCORM package has saved for each learner: the full data model (JSON) plus a summary for staff
CREATE TABLE IF NOT EXISTS scorm_attempts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  cmi TEXT NOT NULL DEFAULT '{}',
  status TEXT, score REAL, total_time TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS password_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Columns added after the first release
const userCols = raw.prepare('PRAGMA table_info(users)').all().map(c => c.name);
for (const col of ['first_name', 'last_name', 'address', 'photo']) {
  if (!userCols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
}
const lessonCols = raw.prepare('PRAGMA table_info(lessons)').all().map(c => c.name);
if (!lessonCols.includes('due_date')) db.exec('ALTER TABLE lessons ADD COLUMN due_date TEXT');
if (!lessonCols.includes('assign_to')) db.exec("ALTER TABLE lessons ADD COLUMN assign_to TEXT NOT NULL DEFAULT 'all'");
if (!lessonCols.includes('video_file')) db.exec('ALTER TABLE lessons ADD COLUMN video_file TEXT');
if (!lessonCols.includes('total_marks')) db.exec('ALTER TABLE lessons ADD COLUMN total_marks REAL');
// SCORM package: folder under uploads/scorm, the page to launch inside it, and '1.2' or '2004'
for (const col of ['scorm_folder', 'scorm_launch', 'scorm_version']) {
  if (!lessonCols.includes(col)) db.exec(`ALTER TABLE lessons ADD COLUMN ${col} TEXT`);
}
const subCols = raw.prepare('PRAGMA table_info(submissions)').all().map(c => c.name);
if (!subCols.includes('mark')) db.exec('ALTER TABLE submissions ADD COLUMN mark REAL');
if (!subCols.includes('marked_by')) db.exec('ALTER TABLE submissions ADD COLUMN marked_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
if (!subCols.includes('marked_at')) db.exec('ALTER TABLE submissions ADD COLUMN marked_at TEXT');

// ---------- Seed (runs once, on an empty database) ----------
function slugify(s) {
  return String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@horizoncollegelondon.com';
  const adminPass = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)')
    .run('Site Admin', adminEmail, bcrypt.hashSync(adminPass, 12), 'admin');
  db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)')
    .run('Demo Student', 'student@example.com', bcrypt.hashSync('Student123!', 12), 'student');

  const fa = db.prepare('INSERT INTO awarding_bodies (name,slug,website,description) VALUES (?,?,?,?)')
    .run('Focus Awards', 'focus-awards', 'https://www.focusawards.org.uk',
      'An Ofqual-regulated awarding organisation offering vocational qualifications on the Regulated Qualifications Framework (RQF). Horizon College London is an approved Focus Awards centre.').lastInsertRowid;

  const addCourse = db.prepare(`INSERT INTO courses
    (title,slug,awarding_body_id,level,qualification_type,duration,study_mode,price,summary,description,entry_requirements,assessment,featured)
    VALUES (@title,@slug,@ab,@level,@type,@duration,@mode,@price,@summary,@description,@entry,@assessment,@featured)`);

  const courses = [
    { title: 'Level 4 NVQ Diploma in Business Administration', level: 'Level 4', type: 'NVQ Diploma', duration: '9–12 months', mode: 'Online, work-based',
      summary: 'For experienced administrators who manage processes, people or projects in a business setting.',
      description: 'This qualification recognises the skills of administrators working at a senior level. You build a portfolio of evidence from your own job, covering areas such as managing business processes, supporting projects, and communicating in a business environment.',
      entry: 'You should be working in an administrative role where you can gather evidence at Level 4. No formal qualifications are required.',
      assessment: 'Portfolio of workplace evidence, reviewed by your assessor. No exams.', featured: 1 },
    { title: 'Level 4 NVQ Diploma in Customer Service', level: 'Level 4', type: 'NVQ Diploma', duration: '9–12 months', mode: 'Online, work-based',
      summary: 'For team leaders and managers responsible for customer service delivery and improvement.',
      description: 'Develop and evidence your ability to lead customer service, handle complex issues, and improve service standards across your team or organisation.',
      entry: 'You should be working in a customer service role with some management or supervisory responsibility.',
      assessment: 'Portfolio of workplace evidence, observations and professional discussion.', featured: 1 },
    { title: 'Level 5 Diploma in Management and Leadership', level: 'Level 5', type: 'Diploma', duration: '12 months', mode: 'Online',
      summary: 'For managers who want a recognised qualification in leading people, managing change and planning strategically.',
      description: 'Covers the core of modern management: leading teams, managing performance, developing organisational strategy, and managing change and resources.',
      entry: 'Usually aimed at practising managers or those moving into a management role.',
      assessment: 'Written assignments and workplace evidence.', featured: 1 },
  ];
  for (const c of courses) addCourse.run({ ...c, slug: slugify(c.title), ab: fa, price: 0 });

  // Example learning content for the first course
  const courseId = db.prepare('SELECT id FROM courses WHERE slug=?').get(slugify(courses[0].title)).id;
  const addModule = db.prepare('INSERT INTO modules (course_id,title,position) VALUES (?,?,?)');
  const addLesson = db.prepare('INSERT INTO lessons (module_id,title,kind,content,position) VALUES (?,?,?,?,?)');
  const m1 = addModule.run(courseId, 'Getting started', 1).lastInsertRowid;
  addLesson.run(m1, 'Welcome and how your NVQ works', 'lesson',
    'Your NVQ is assessed on what you already do at work. Over the coming months you will collect evidence, meet your assessor, and build a portfolio that shows you meet each unit.\n\nStart by reading the unit list and noting where your current role gives you natural evidence.', 1);
  addLesson.run(m1, 'Your learning agreement', 'assignment',
    'Download, sign and upload your learning agreement so we can confirm your registration with the awarding body.', 2);
  const m2 = addModule.run(courseId, 'Manage business processes', 2).lastInsertRowid;
  addLesson.run(m2, 'Understanding business processes', 'lesson',
    'Look at one process you are responsible for. Map its steps, who is involved, and where it could be improved.', 1);
  addLesson.run(m2, 'Evidence: process improvement', 'assignment',
    'Upload evidence of a process you have reviewed or improved, with a short reflective account (300–500 words).', 2);

  const student = db.prepare("SELECT id FROM users WHERE email='student@example.com'").get().id;
  db.prepare("INSERT INTO enrolments (user_id,course_id,status) VALUES (?,?, 'active')").run(student, courseId);

  console.log(`Seeded database. Admin login: ${adminEmail} / ${adminPass}`);
}

module.exports = { db, slugify };
