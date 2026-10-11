// SCORM 1.2 / 2004 packages. The admin's browser unzips a package and uploads its files to private storage under
// scorm/<folder>/ (public/js/scorm-upload.js). This module reads imsmanifest.xml from there to set up the lessons,
// hands out signed addresses for learners to play the package from our own domain (routes/scorm-content.js),
// and works out a learner's status from the data the package reports back.
const crypto = require('crypto');
const storage = require('./storage');

// ---------- Package folders and file paths ----------
const newFolder = () => `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
const validFolder = f => /^\d{13}-[a-f0-9]{16}$/.test(String(f || ''));
// A file path inside a package: relative, no "." or ".." parts, and only characters Supabase Storage accepts in keys
const safePath = p => typeof p === 'string' && p.length > 0 && p.length <= 500 && /^[\w/!\-.*'() &$@=;+,]+$/.test(p)
  && p.split('/').every(part => part && part !== '.' && part !== '..');
// The folder inside the package that holds imsmanifest.xml: '' (the top) or up to two levels, e.g. 'course/'
const safeHome = h => h === '' || (typeof h === 'string' && h.endsWith('/') && safePath(h.slice(0, -1)) && h.split('/').length <= 3);

const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), m[3] ?? m[4]]));
const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

// Minimal XML reader for imsmanifest.xml: builds { name, attrs, children, text } nodes.
// Namespace prefixes are dropped from element names (adlcp:location -> location) but kept on attributes.
function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' }, stack = [root];
  const body = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
  const re = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(body))) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) { top.text += decode(m[5]); continue; }
    const name = m[2].replace(/^[\w.-]+:/, '').toLowerCase();
    if (m[1]) { if (stack.length > 1 && top.name === name) stack.pop(); continue; }
    const node = { name, attrs: attrs(m[3]), children: [], text: '' };
    top.children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}
const kids = (node, name) => (node ? node.children.filter(c => c.name === name) : []);
const kid = (node, name) => kids(node, name)[0];
const textOf = node => (node ? node.text.trim() : '');
function find(node, name) {
  if (!node) return null;
  for (const c of node.children) { if (c.name === name) return c; const f = find(c, name); if (f) return f; }
  return null;
}

// Reads imsmanifest.xml into the course structure. Top-level items in the organisation become units (modules)
// and every item that launches something becomes a lesson. Launchable items sitting directly under the
// organisation are grouped into a unit named after the organisation.
function readManifest(xml) {
  const doc = parseXml(xml);
  const manifest = find(doc, 'manifest') || doc;
  const schema = textOf(find(kid(manifest, 'metadata'), 'schemaversion'));
  const version = /2004|CAM\s*1\.3/i.test(schema) || /adlcp_v1p3|adlseq/i.test(xml) ? '2004' : '1.2';

  const orgsNode = kid(manifest, 'organizations');
  const orgs = kids(orgsNode, 'organization');
  const org = orgs.find(o => orgsNode.attrs.default && o.attrs.identifier === orgsNode.attrs.default) || orgs[0];
  const title = textOf(kid(org, 'title'));
  // Course description from the package metadata, if the authoring tool wrote one
  const descNode = find(find(manifest, 'general'), 'description');
  const description = textOf(find(descNode, 'string') || descNode);

  const resourcesNode = kid(manifest, 'resources');
  const resBase = (resourcesNode && resourcesNode.attrs['xml:base']) || '';
  const resources = kids(resourcesNode, 'resource');
  function launchFor(item) {
    const res = item.attrs.identifierref && resources.find(r => r.attrs.identifier === item.attrs.identifierref && r.attrs.href);
    if (!res) return null;
    let href = resBase + (res.attrs['xml:base'] || '') + res.attrs.href;
    const params = item.attrs.parameters || '';
    if (params) href += (href.includes('?') ? '&' : '?') + params.replace(/^[?&]/, '');
    return href;
  }
  const visible = item => item.attrs.isvisible !== 'false';
  // Every launchable item under a node, in order (sub-sections are flattened into the unit)
  function lessonsUnder(node) {
    const out = [];
    for (const item of kids(node, 'item').filter(visible)) {
      const launch = launchFor(item);
      if (launch) out.push({ title: textOf(kid(item, 'title')) || 'Activity', launch });
      out.push(...lessonsUnder(item));
    }
    return out;
  }

  const units = [];
  let loose = null;
  for (const item of kids(org, 'item').filter(visible)) {
    const itemTitle = textOf(kid(item, 'title'));
    const launch = launchFor(item);
    if (kids(item, 'item').length) {
      loose = null;
      const lessons = (launch ? [{ title: itemTitle || 'Activity', launch }] : []).concat(lessonsUnder(item));
      if (lessons.length) units.push({ title: itemTitle || `Unit ${units.length + 1}`, lessons });
    } else if (launch) {
      if (!loose) units.push(loose = { title: units.length ? 'More activities' : 'Introduction', lessons: [] });
      loose.lessons.push({ title: itemTitle || 'Activity', launch });
    }
  }
  // No usable organisation: fall back to the first SCO resource, then any resource with a page
  if (!units.length) {
    const res = resources.find(r => /sco/i.test(r.attrs['adlcp:scormtype'] || '') && r.attrs.href) || resources.find(r => r.attrs.href);
    if (!res) throw new Error('No launch page was found in imsmanifest.xml.');
    units.push({ title: title || 'Course content', lessons: [{ title: title || 'Activity', launch: resBase + (res.attrs['xml:base'] || '') + res.attrs.href }] });
  }
  if (units.length === 1 && units[0].title === 'Introduction') units[0].title = 'Course content';
  return { version, title, description, units };
}

// Reads the manifest of a package the browser has uploaded and returns its structure: version, title, description,
// units -> lessons (each with a launch path inside the folder), `launch` (the first lesson's page) and `count`.
// `home` is where imsmanifest.xml sits, in case the zip was made from the folder rather than its contents.
async function install(folder, home) {
  if (!validFolder(folder) || !safeHome(home)) throw new Error('The package upload didn’t complete. Please upload it again.');
  const xml = await storage.readText('scorm', `${folder}/${home}imsmanifest.xml`);
  if (xml === null) throw new Error('This isn’t a SCORM package: imsmanifest.xml is missing.');
  const m = readManifest(xml);
  for (const u of m.units) for (const l of u.lessons) {
    l.launch = home + l.launch;
    if (!safePath(launchFile(l.launch))) throw new Error(`The package launches a page outside itself (${l.launch}).`);
  }
  const all = m.units.flatMap(u => u.lessons);
  if (!(await storage.exists('scorm', `${folder}/${launchFile(all[0].launch)}`))) throw new Error(`The launch page ${launchFile(all[0].launch)} isn’t in the package.`);
  return { folder, version: m.version, title: m.title || all[0].title, description: m.description, units: m.units, launch: all[0].launch, count: all.length };
}
// The file a launch address points at: without its ?query or #fragment, and with %20 and the like decoded
function launchFile(launch) {
  const file = String(launch).split(/[?#]/)[0];
  try { return decodeURIComponent(file); } catch { return file; }
}

// Deletes a package's files once no lesson uses them any more (one package can feed several lessons).
// Call it after the lessons have been changed or deleted.
async function remove(folder) {
  if (!validFolder(folder)) return;
  if (await require('./db').db.get('SELECT 1 FROM lessons WHERE scorm_folder=? LIMIT 1', folder)) return;
  await storage.removeTree('scorm', folder);
}

// ---------- Playing a package ----------
// The lesson page gives each visit an address like /scorm-content/<folder>/<expiry>.<signature>/ under which the
// package's files are served. The signature proves the page checked the learner's access, so the many requests a
// package makes need no session or database lookups. Addresses last 4 hours; reloading the lesson gives a new one.
const SIGNED_FOR = 4 * 60 * 60;
const signature = (folder, exp) => crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-only-secret-change-me')
  .update(`scorm-content:${folder}:${exp}`).digest('base64url');
function contentBase(folder) {
  const exp = Math.floor(Date.now() / 1000) + SIGNED_FOR;
  return `/scorm-content/${folder}/${exp}.${signature(folder, exp)}/`;
}
function checkToken(folder, token) {
  const [exp, sig = ''] = String(token).split('.');
  if (!validFolder(folder) || !(Number(exp) > Date.now() / 1000)) return false;
  const want = signature(folder, exp);
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

// Status, score and whether the lesson counts as complete, from the data model the package saved
function summarise(version, cmi) {
  if (version === '2004') {
    const completion = cmi['cmi.completion_status'] || 'unknown', success = cmi['cmi.success_status'] || 'unknown';
    const scaled = parseFloat(cmi['cmi.score.scaled']), raw = parseFloat(cmi['cmi.score.raw']), max = parseFloat(cmi['cmi.score.max']);
    const score = !isNaN(scaled) ? scaled * 100 : !isNaN(raw) ? (max > 0 ? (raw / max) * 100 : raw) : null;
    const status = success !== 'unknown' ? success : completion;
    return { status, score, complete: completion === 'completed' || success === 'passed', time: cmi['cmi.total_time'] || '' };
  }
  const status = cmi['cmi.core.lesson_status'] || 'not attempted';
  const raw = parseFloat(cmi['cmi.core.score.raw']), max = parseFloat(cmi['cmi.core.score.max']);
  const score = isNaN(raw) ? null : max > 0 && max !== 100 ? (raw / max) * 100 : raw;
  return { status, score, complete: status === 'completed' || status === 'passed', time: cmi['cmi.core.total_time'] || '' };
}

module.exports = { newFolder, validFolder, safePath, safeHome, readManifest, install, remove, contentBase, checkToken, summarise };
