// Finds uploaded files that nothing in the database uses any more (mostly uploads from forms that were started but
// never saved) and, with --delete, removes them from Storage. Anything newer than --min-age hours (default 24) is
// left alone, so an upload whose form is still being filled in is never touched.
// Usage: npm run cleanup-uploads                      (list only)
//        npm run cleanup-uploads -- --delete          (remove them)
//        npm run cleanup-uploads -- --min-age=72
require('dotenv').config({ quiet: true });
const { db } = require('../db');
const storage = require('../storage');

const args = process.argv.slice(2);
const doDelete = args.includes('--delete');
const ageArg = args.find(a => a.startsWith('--min-age='));
const minAgeHours = ageArg ? Number(ageArg.split('=')[1]) : 24;

// Where each folder's files are referenced
const USED_BY = {
  images: 'SELECT logo AS f FROM awarding_bodies UNION SELECT image FROM courses UNION SELECT photo FROM users',
  files: 'SELECT attachment AS f FROM lessons',
  videos: 'SELECT video_file AS f FROM lessons',
  evidence: 'SELECT file AS f FROM submissions',
  policies: 'SELECT file AS f FROM policies',
  documents: 'SELECT file AS f FROM user_documents',
};
const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;

(async () => {
  if (!(minAgeHours >= 0)) throw new Error('--min-age must be a number of hours, e.g. --min-age=24');
  const cutoff = Date.now() - minAgeHours * 3600 * 1000;
  const unused = [];

  for (const [folder, sql] of Object.entries(USED_BY)) {
    const used = new Set((await db.all(sql)).map(r => r.f).filter(Boolean));
    for (const file of await storage.listTree(storage.BUCKET[folder], folder)) {
      const name = file.key.slice(folder.length + 1);
      if (!used.has(name) && new Date(file.created).getTime() < cutoff) unused.push({ folder, name, size: file.size });
    }
  }

  // SCORM packages: one folder per package (named after its upload time), in use while any lesson points at it
  const usedPackages = new Set((await db.all('SELECT DISTINCT scorm_folder AS f FROM lessons WHERE scorm_folder IS NOT NULL')).map(r => r.f));
  const packages = new Map();
  for (const file of await storage.listTree('private', 'scorm')) {
    const pkg = file.key.split('/')[1];
    packages.set(pkg, (packages.get(pkg) || 0) + file.size);
  }
  for (const [pkg, size] of packages) {
    if (!usedPackages.has(pkg) && Number(pkg.split('-')[0]) < cutoff) unused.push({ folder: 'scorm', name: pkg, size, isPackage: true });
  }

  const total = unused.reduce((n, f) => n + f.size, 0);
  console.log(`${new Date().toISOString()} ${unused.length} unused upload(s) older than ${minAgeHours} h, ${mb(total)} in total.`);
  for (const f of unused) console.log(`  ${f.folder}/${f.name}${f.isPackage ? '/ (SCORM package)' : ''}  ${mb(f.size)}`);
  if (!unused.length) return;
  if (!doDelete) { console.log('Nothing was deleted. Run again with --delete to remove them.'); return; }

  for (const folder of Object.keys(USED_BY)) {
    const names = unused.filter(f => f.folder === folder).map(f => f.name);
    for (let i = 0; i < names.length; i += 100) await storage.remove(folder, ...names.slice(i, i + 100));
  }
  for (const f of unused.filter(x => x.isPackage)) await storage.removeTree('scorm', f.name);
  console.log(`Deleted ${unused.length} unused upload(s), freeing ${mb(total)}.`);
})()
  .catch(err => { console.error(err.message); process.exitCode = 1; })
  .finally(() => db.pool.end());
