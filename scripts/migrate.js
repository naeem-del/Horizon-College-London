// Applies the SQL files in supabase/migrations to the database in DATABASE_URL, in name order.
// Each file runs once, inside a transaction, and is recorded in schema_migrations.
// Usage: npm run migrate
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const dir = path.join(__dirname, '..', 'supabase', 'migrations');

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (see .env.example).');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    let applied = 0;
    for (const file of files) {
      if (done.has(file)) continue;
      process.stdout.write(`Applying ${file}... `);
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('done');
        applied++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('failed');
        throw err;
      }
    }
    console.log(applied ? `${applied} migration${applied === 1 ? '' : 's'} applied.` : 'Database is up to date.');
  } finally {
    await client.end();
  }
})().catch(err => { console.error(err.message); process.exit(1); });
