// SCORM 1.2 / 2004 packages: unzip an uploaded package, find what to launch from imsmanifest.xml,
// and work out a learner's status from the data the package reports back.
// The unzipper uses Node's built-in zlib, so there is nothing extra to install.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, 'uploads', 'scorm');

// Extracts a .zip into dest. Rejects encrypted/ZIP64 archives and any entry that would land outside dest.
function unzip(zipFile, dest) {
  const buf = fs.readFileSync(zipFile);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file isn’t a valid .zip.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('This package is too large (ZIP64). Re-export it in smaller parts.');
  const base = path.resolve(dest);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('This .zip is damaged.');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new Error('This package is password-protected.');
    const target = path.resolve(base, name);
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error('This package contains unsafe file paths.');
    if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (method === 0) fs.writeFileSync(target, data);
    else if (method === 8) fs.writeFileSync(target, zlib.inflateRawSync(data));
    else throw new Error(`This package uses an unsupported compression method (${method}).`);
  }
}

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

// Unzips an uploaded package into uploads/scorm/<folder> and returns its structure: version, title, description,
// units -> lessons (each with a launch path inside the folder) and `launch`, the first lesson's page.
// The manifest may sit in a sub-folder if the zip was made from the folder rather than its contents.
function install(zipFile) {
  const folder = Date.now() + '-' + Math.random().toString(16).slice(2, 10);
  const dest = path.join(ROOT, folder);
  try {
    unzip(zipFile, dest);
    const findHome = (dir, depth) => {
      if (fs.existsSync(path.join(dir, 'imsmanifest.xml'))) return dir;
      if (depth >= 2) return null;
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) { const f = findHome(path.join(dir, d.name), depth + 1); if (f) return f; }
      }
      return null;
    };
    const home = findHome(dest, 0);
    if (!home) throw new Error('This isn’t a SCORM package: imsmanifest.xml is missing.');
    const m = readManifest(fs.readFileSync(path.join(home, 'imsmanifest.xml'), 'utf8'));
    const sub = path.relative(dest, home).split(path.sep).filter(Boolean).join('/');
    for (const u of m.units) for (const l of u.lessons) l.launch = (sub ? sub + '/' : '') + l.launch;
    const all = m.units.flatMap(u => u.lessons);
    return { folder, version: m.version, title: m.title || all[0].title, description: m.description, units: m.units, launch: all[0].launch, count: all.length };
  } catch (err) {
    fs.rm(dest, { recursive: true, force: true }, () => {});
    throw err;
  } finally {
    fs.unlink(zipFile, () => {});
  }
}

// Deletes a package's files once no lesson uses them any more (one package can feed several lessons).
// Call it after the lessons have been changed or deleted.
function remove(folder) {
  if (!folder || path.basename(folder) !== folder) return;
  if (require('./db').db.prepare('SELECT 1 FROM lessons WHERE scorm_folder=? LIMIT 1').get(folder)) return;
  fs.rm(path.join(ROOT, folder), { recursive: true, force: true }, () => {});
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

module.exports = { ROOT, install, remove, summarise };
