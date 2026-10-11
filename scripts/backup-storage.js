// Copies every uploaded file (both Supabase Storage buckets) to a folder on this machine. Supabase's database
// backups don't include Storage, so run this regularly (e.g. daily from cron on the server) and copy the folder off
// the server as well. Files already copied with the same size are skipped, so later runs only fetch what's new.
// Files deleted from Storage are kept in the backup.
// Usage: npm run backup-storage                       (into ./backups/storage)
//        npm run backup-storage -- /path/to/folder
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { client, listTree } = require('../storage');

const dest = path.resolve(process.argv[2] || path.join(__dirname, '..', 'backups', 'storage'));

(async () => {
  let copied = 0, skipped = 0, bytes = 0;
  const failed = [];
  for (const bucket of ['media', 'private']) {
    const base = path.join(dest, bucket);
    for (const file of await listTree(bucket, '')) {
      const target = path.join(base, ...file.key.split('/'));
      if (!target.startsWith(base + path.sep)) { failed.push(`${bucket}/${file.key}: unsafe name`); continue; }
      if (fs.existsSync(target) && fs.statSync(target).size === file.size) { skipped++; continue; }
      const { data, error } = await client.storage.from(bucket).download(file.key);
      if (error) { failed.push(`${bucket}/${file.key}: ${error.message}`); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(await data.arrayBuffer()));
      copied++;
      bytes += file.size;
    }
  }
  console.log(`${new Date().toISOString()} Storage backup in ${dest}: ${copied} new or changed file(s) copied (${(bytes / 1048576).toFixed(1)} MB), ${skipped} already up to date.`);
  if (failed.length) { console.error(`Not copied:\n${failed.join('\n')}`); process.exitCode = 1; }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
