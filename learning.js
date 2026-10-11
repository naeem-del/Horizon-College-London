// What a learner sees on a course: assignments set for selected learners or batches are hidden from everyone else.
// Staff (previewing) see everything.
const { db } = require('./db');

// Lessons on a course as seen by one user, with their completion, latest submission and deadline.
// Deadline: the learner's own, else their batch's, else the assignment's.
function visibleLessons(userId, courseId, staff = false) {
  return db.prepare(`SELECT l.*,
      (SELECT 1 FROM lesson_progress p WHERE p.lesson_id=l.id AND p.user_id=@uid) AS done,
      (SELECT status FROM submissions s WHERE s.lesson_id=l.id AND s.user_id=@uid ORDER BY s.id DESC LIMIT 1) AS sub_status,
      CASE WHEN l.kind='assignment' THEN COALESCE(NULLIF(al.due_date,''), NULLIF(ab.due_date,''), NULLIF(l.due_date,'')) END AS due
    FROM lessons l JOIN modules m ON m.id=l.module_id
    LEFT JOIN assignment_learners al ON al.lesson_id=l.id AND al.user_id=@uid
    LEFT JOIN enrolments e ON e.user_id=@uid AND e.course_id=m.course_id
    LEFT JOIN assignment_batches ab ON ab.lesson_id=l.id AND ab.batch_id=e.batch_id
    WHERE m.course_id=@cid AND (@staff=1 OR l.kind<>'assignment' OR l.assign_to='all'
      OR (l.assign_to='selected' AND al.user_id IS NOT NULL) OR (l.assign_to='batches' AND ab.batch_id IS NOT NULL))
    ORDER BY m.position, m.id, l.position, l.id`).all({ uid: userId, cid: courseId, staff: staff ? 1 : 0 });
}

// On a sequential course a module opens once everything set for the learner in the modules before it is finished:
// lessons marked complete, assignments with evidence handed in (a later "resubmit" doesn't lock them out again).
// Locked modules and their lessons get locked = true and blockedBy = the title of the module to finish first.
function outline(userId, courseId, staff = false) {
  const modules = db.prepare('SELECT * FROM modules WHERE course_id=? ORDER BY position, id').all(courseId);
  const lessons = visibleLessons(userId, courseId, staff);
  const sequential = !staff && db.prepare('SELECT sequential FROM courses WHERE id=?').get(courseId).sequential;
  let blockedBy = null;
  for (const m of modules) {
    m.lessons = lessons.filter(l => l.module_id === m.id);
    m.locked = !!(sequential && blockedBy);
    m.blockedBy = m.locked ? blockedBy : null;
    for (const l of m.lessons) Object.assign(l, { locked: m.locked, blockedBy: m.blockedBy });
    if (!blockedBy && m.lessons.some(l => !l.done && !(l.kind === 'assignment' && l.sub_status))) blockedBy = m.title;
  }
  return { modules, flat: lessons };
}

function progress(userId, courseId, staff = false) {
  const lessons = visibleLessons(userId, courseId, staff);
  const total = lessons.length, done = lessons.filter(l => l.done).length;
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
}

module.exports = { visibleLessons, outline, progress };
