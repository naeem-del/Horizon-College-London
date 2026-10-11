// Fills an empty database with the first admin, a demo learner, Focus Awards and the starter courses.
// Run once after `npm run migrate`: npm run seed. Does nothing if any account already exists.
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { db, slugify } = require('../db');

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

(async () => {
  if ((await db.get('SELECT COUNT(*) c FROM users')).c > 0) {
    console.log('The database already has accounts, so nothing was seeded.');
    return;
  }
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@horizoncollegelondon.com';
  const adminPass = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  await db.tx(async t => {
    await t.run('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)', 'Site Admin', adminEmail, bcrypt.hashSync(adminPass, 12), 'admin');
    const student = (await t.get('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?) RETURNING id',
      'Demo Student', 'student@example.com', bcrypt.hashSync('Student123!', 12), 'student')).id;

    const fa = (await t.get('INSERT INTO awarding_bodies (name,slug,website,description) VALUES (?,?,?,?) RETURNING id',
      'Focus Awards', 'focus-awards', 'https://www.focusawards.org.uk',
      'An Ofqual-regulated awarding organisation offering vocational qualifications on the Regulated Qualifications Framework (RQF). Horizon College London is an approved Focus Awards centre.')).id;

    const ids = [];
    for (const c of courses) {
      ids.push((await t.get(`INSERT INTO courses
        (title,slug,awarding_body_id,level,qualification_type,duration,study_mode,price,summary,description,entry_requirements,assessment,featured)
        VALUES (@title,@slug,@ab,@level,@type,@duration,@mode,@price,@summary,@description,@entry,@assessment,@featured) RETURNING id`,
      { ...c, slug: slugify(c.title), ab: fa, price: 0 })).id);
    }

    // Example learning content for the first course
    const courseId = ids[0];
    const addModule = async (title, pos) => (await t.get('INSERT INTO modules (course_id,title,position) VALUES (?,?,?) RETURNING id', courseId, title, pos)).id;
    const addLesson = (moduleId, title, kind, content, pos) => t.run('INSERT INTO lessons (module_id,title,kind,content,position) VALUES (?,?,?,?,?)', moduleId, title, kind, content, pos);
    const m1 = await addModule('Getting started', 1);
    await addLesson(m1, 'Welcome and how your NVQ works', 'lesson',
      'Your NVQ is assessed on what you already do at work. Over the coming months you will collect evidence, meet your assessor, and build a portfolio that shows you meet each unit.\n\nStart by reading the unit list and noting where your current role gives you natural evidence.', 1);
    await addLesson(m1, 'Your learning agreement', 'assignment',
      'Download, sign and upload your learning agreement so we can confirm your registration with the awarding body.', 2);
    const m2 = await addModule('Manage business processes', 2);
    await addLesson(m2, 'Understanding business processes', 'lesson',
      'Look at one process you are responsible for. Map its steps, who is involved, and where it could be improved.', 1);
    await addLesson(m2, 'Evidence: process improvement', 'assignment',
      'Upload evidence of a process you have reviewed or improved, with a short reflective account (300–500 words).', 2);

    await t.run("INSERT INTO enrolments (user_id,course_id,status) VALUES (?,?,'active')", student, courseId);
  });
  console.log(`Seeded the database. Admin login: ${adminEmail} (password from ADMIN_PASSWORD${process.env.ADMIN_PASSWORD ? '' : ', default ChangeMe123!'}).`);
  console.log('Demo learner: student@example.com / Student123! (delete it before going live).');
})()
  .catch(err => { console.error(err.message); process.exitCode = 1; })
  .finally(() => db.pool.end());
