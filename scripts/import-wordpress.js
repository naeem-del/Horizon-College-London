// Imports courses from your existing WordPress (Tutor LMS) site as DRAFTS, so you can review them in /admin.
// Usage:  node scripts/import-wordpress.js https://horizoncollegelondon.com
// Requires Node 18+ (built-in fetch). Tutor LMS exposes courses at /wp-json/wp/v2/courses when its REST
// support is on; if you get a 404, enable it in Tutor LMS settings or use Tools > Export in WordPress instead.
require('dotenv').config({ quiet: true });
const { db, slugify } = require('../db');

const site = (process.argv[2] || '').replace(/\/$/, '');
if (!site) { console.log('Usage: node scripts/import-wordpress.js https://your-wordpress-site.com'); process.exit(1); }

const strip = html => String(html || '')
  .replace(/<\/(p|h\d|li|div)>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8211;/g, '–').replace(/&#8217;/g, '’').replace(/&#8220;|&#8221;/g, '"')
  .replace(/\n{3,}/g, '\n\n').trim();

(async () => {
  let page = 1, added = 0, skipped = 0;
  while (true) {
    const res = await fetch(`${site}/wp-json/wp/v2/courses?per_page=50&page=${page}`);
    if (res.status === 400 && page > 1) break; // past the last page
    if (!res.ok) { console.error(`WordPress returned ${res.status} for page ${page}. See the note at the top of this file.`); break; }
    const items = await res.json();
    if (!items.length) break;
    for (const it of items) {
      const title = strip(it.title && it.title.rendered);
      const slug = slugify(it.slug || title);
      if (db.prepare('SELECT 1 FROM courses WHERE slug=?').get(slug)) { skipped++; continue; }
      const description = strip(it.content && it.content.rendered);
      const summary = strip(it.excerpt && it.excerpt.rendered).slice(0, 220);
      db.prepare('INSERT INTO courses (title,slug,summary,description,published) VALUES (?,?,?,?,0)').run(title, slug, summary, description);
      added++;
    }
    if (items.length < 50) break;
    page++;
  }
  console.log(`Imported ${added} course(s) as drafts, skipped ${skipped} that already exist. Review them at /admin/courses.`);
})();
