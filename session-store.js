// Stores login sessions in the same SQLite database, so users stay logged in after a restart
const session = require('express-session');
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)`);

class SqliteStore extends session.Store {
  constructor() {
    super();
    setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 15 * 60 * 1000).unref();
  }
  expiry(sess) {
    return sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
  }
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT sess, expires FROM sessions WHERE sid=?').get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb = () => {}) {
    try {
      db.prepare('INSERT INTO sessions (sid,sess,expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires')
        .run(sid, JSON.stringify(sess), this.expiry(sess));
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb = () => {}) {
    try { db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb(null); } catch (e) { cb(e); }
  }
  touch(sid, sess, cb = () => {}) {
    try { db.prepare('UPDATE sessions SET expires=? WHERE sid=?').run(this.expiry(sess), sid); cb(null); } catch (e) { cb(e); }
  }
}
module.exports = SqliteStore;
