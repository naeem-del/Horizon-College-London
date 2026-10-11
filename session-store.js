// Stores login sessions in the database, so users stay logged in across restarts and server instances.
// Expired rows are cleared by the 'horizon-cleanup' job in supabase/migrations/0002_cleanup_jobs.sql.
const session = require('express-session');
const { db } = require('./db');

class DbSessionStore extends session.Store {
  expiry(sess) {
    return sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
  }
  get(sid, cb) {
    db.get('SELECT sess, expires FROM sessions WHERE sid=?', sid)
      .then(row => cb(null, !row || row.expires < Date.now() ? null : JSON.parse(row.sess)), cb);
  }
  set(sid, sess, cb = () => {}) {
    db.run('INSERT INTO sessions (sid,sess,expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires',
      sid, JSON.stringify(sess), this.expiry(sess)).then(() => cb(null), cb);
  }
  destroy(sid, cb = () => {}) {
    db.run('DELETE FROM sessions WHERE sid=?', sid).then(() => cb(null), cb);
  }
  touch(sid, sess, cb = () => {}) {
    db.run('UPDATE sessions SET expires=? WHERE sid=?', this.expiry(sess), sid).then(() => cb(null), cb);
  }
}
module.exports = DbSessionStore;
