// Creates (or updates) the two Supabase Storage buckets the app uses. Safe to run again.
// Usage: npm run setup-storage
require('dotenv').config({ quiet: true });
const { client } = require('../storage');

const MB = 1024 * 1024;
// Supabase Free caps every file at 50 MB; on Pro raise MAX_VIDEO_MB / MAX_FILE_MB and run this again
const largest = Math.max(Number(process.env.MAX_VIDEO_MB) || 50, Number(process.env.MAX_FILE_MB) || 50, 20);
const buckets = [
  { id: 'media', public: true, fileSizeLimit: largest * MB },
  { id: 'private', public: false, fileSizeLimit: largest * MB },
];

(async () => {
  const { data: existing, error } = await client.storage.listBuckets();
  if (error) throw new Error(error.message);
  for (const b of buckets) {
    const options = { public: b.public, fileSizeLimit: b.fileSizeLimit };
    const exists = existing.some(e => e.id === b.id);
    const { error: err } = exists ? await client.storage.updateBucket(b.id, options) : await client.storage.createBucket(b.id, options);
    if (err) throw new Error(`${b.id}: ${err.message}`);
    console.log(`${exists ? 'Updated' : 'Created'} bucket "${b.id}" (${b.public ? 'public' : 'private'}, files up to ${largest} MB)`);
  }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
