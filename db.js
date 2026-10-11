// Supabase Postgres, reached through the transaction pooler in DATABASE_URL.
// The tables are created by the SQL files in supabase/migrations (npm run migrate), not here.
//
// Queries keep the SQL style used across the app and are converted to Postgres' $1, $2…:
//   await db.get('SELECT * FROM users WHERE id=?', id)            first row, or undefined
//   await db.all('SELECT … WHERE course_id=@cid', { cid })        all rows
//   await db.run('UPDATE … WHERE id=?', id)                       { rowCount, rows }; add RETURNING id for new ids
//   await db.tx(async t => { await t.run(…); await t.get(…) })    one transaction (t has get/all/run)
const { Pool, types } = require('pg');

// COUNT(*) and millisecond times are int8, which pg returns as strings by default
types.setTypeParser(20, Number);
types.setTypeParser(1700, Number);
// Timestamps as ISO text ("2026-10-11T09:12:33.123Z"), which the date helpers and string sorting expect
const parseTimestamp = types.getTypeParser(1184);
types.setTypeParser(1184, v => parseTimestamp(v).toISOString());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX) || 3, // small: on Vercel every instance has its own pool
  idleTimeoutMillis: 10000,
});

// Turns '?' and '@name' placeholders into $n. Text inside '…' is left alone, and a repeated @name reuses its number.
const compiled = new Map();
function compile(sql) {
  let hit = compiled.get(sql);
  if (hit) return hit;
  let text = '', i = 0;
  const order = [], seen = new Map();
  let positional = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      text += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '?') {
      order.push(positional++);
      text += '$' + order.length;
      i++;
    } else if (ch === '@' && /[A-Za-z_]/.test(sql[i + 1] || '')) {
      const name = /^[A-Za-z_]\w*/.exec(sql.slice(i + 1))[0];
      if (!seen.has(name)) { order.push(name); seen.set(name, order.length); }
      text += '$' + seen.get(name);
      i += name.length + 1;
    } else {
      text += ch;
      i++;
    }
  }
  hit = { text, order, positional };
  compiled.set(sql, hit);
  return hit;
}

// Accepts db.get(sql, a, b), db.get(sql, [a, b]) or db.get(sql, { name: value })
function toArgs(params) {
  if (params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !(params[0] instanceof Date)) return params[0];
  return params;
}

function bind(runner) {
  async function query(sql, params) {
    const { text, order, positional } = compile(sql);
    let values;
    if (Array.isArray(params)) {
      if (params.length !== positional) throw new Error(`Query expects ${positional} values, got ${params.length}: ${sql.slice(0, 80)}`);
      values = order.map(k => params[k]);
    } else {
      values = order.map(k => {
        if (!(k in params)) throw new Error(`Missing value for @${k}: ${sql.slice(0, 80)}`);
        return params[k];
      });
    }
    return runner.query(text, values.map(v => (v === undefined ? null : v)));
  }
  return {
    get: async (sql, ...p) => (await query(sql, toArgs(p))).rows[0],
    all: async (sql, ...p) => (await query(sql, toArgs(p))).rows,
    run: async (sql, ...p) => { const r = await query(sql, toArgs(p)); return { rowCount: r.rowCount, rows: r.rows }; },
  };
}

const db = {
  ...bind(pool),
  // Runs fn inside BEGIN/COMMIT on one connection; any error rolls everything back
  async tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(bind(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
  // True when an INSERT/UPDATE hit a UNIQUE constraint (e.g. a slug, email or batch code already taken)
  isUnique: err => err && err.code === '23505',
  pool,
};

function slugify(s) {
  return String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// An id from a URL or form as a number, or 0 when it isn't a valid id (Postgres rejects text or out-of-range
// values for integer columns, where SQLite simply found no row)
function toId(v) {
  const n = Number(v);
  return /^\d+$/.test(String(v ?? '').trim()) && n > 0 && n <= 2147483647 ? n : 0;
}

module.exports = { db, slugify, toId };
