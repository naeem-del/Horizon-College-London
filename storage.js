// Uploaded files live in Supabase Storage. The browser uploads them straight to Storage through a one-time signed
// link (see public/js/direct-upload.js), so large files never pass through the web server, which on Vercel accepts
// at most 4.5 MB per request. The database keeps only each file's name; its folder decides the bucket:
//   media   (public)  images/, files/, videos/   linked directly from pages
//   private (no public access)  evidence/, policies/   handed out as short-lived signed links after a permission check
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL || 'http://localhost', process.env.SUPABASE_SERVICE_ROLE_KEY || 'missing', {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BUCKET = { images: 'media', files: 'media', videos: 'media', evidence: 'private', policies: 'private', scorm: 'private' };
const MB = 1024 * 1024;
const IMAGES = ['.jpg', '.jpeg', '.png', '.webp'];
const DOCS = ['.pdf', '.doc', '.docx', '.xlsx', '.pptx', '.zip'];

// What each upload field may contain. `staff` uploads come from the admin area; `admin` ones only from administrators.
const UPLOADS = {
  logo: { folder: 'images', exts: IMAGES, max: 20 * MB, who: 'admin' },
  'course-image': { folder: 'images', exts: IMAGES, max: 20 * MB, who: 'admin' },
  photo: { folder: 'images', exts: IMAGES, max: 20 * MB, who: 'admin' },
  policy: { folder: 'policies', exts: ['.pdf', '.doc', '.docx'], max: 20 * MB, who: 'admin' },
  attachment: { folder: 'files', exts: DOCS, max: (Number(process.env.MAX_FILE_MB) || 50) * MB, who: 'staff' },
  video: { folder: 'videos', exts: ['.mp4', '.webm', '.mov'], max: (Number(process.env.MAX_VIDEO_MB) || 50) * MB, who: 'staff' },
  evidence: { folder: 'evidence', exts: ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.xlsx', '.pptx', '.mp4', '.zip'], max: 20 * MB, who: 'learner' },
};

const objectPath = (folder, name) => `${folder}/${path.basename(String(name))}`;
const sizeText = bytes => `${Math.round(bytes / MB)} MB`;

// Why a file can't be uploaded for this field, or '' when it's fine
function refuse(purpose, filename, size) {
  const rule = UPLOADS[purpose];
  if (!rule) return 'Unknown upload.';
  if (!rule.exts.includes(path.extname(String(filename || '')).toLowerCase())) return `That type of file isn’t accepted here. Use ${rule.exts.join(', ')}.`;
  if (!(size > 0)) return 'That file is empty.';
  if (size > rule.max) return `That file is too big. The limit is ${sizeText(rule.max)}.`;
  return '';
}

// A one-time link the browser can upload this file to; returns { path, url } where path is "<folder>/<name>"
async function signUpload(purpose, filename) {
  const rule = UPLOADS[purpose];
  const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(filename).toLowerCase()}`;
  const key = objectPath(rule.folder, name);
  const { data, error } = await sb.storage.from(BUCKET[rule.folder]).createSignedUploadUrl(key);
  if (error) throw new Error(`Storage refused the upload: ${error.message}`);
  return { path: key, url: data.signedUrl };
}

// Size in bytes of a stored file, or null when it isn't there
async function sizeOf(folder, name) {
  const { data, error } = await sb.storage.from(BUCKET[folder]).list(folder, { search: name, limit: 5 });
  if (error) throw new Error(`Storage lookup failed: ${error.message}`);
  const hit = (data || []).find(f => f.name === name);
  return hit ? (hit.metadata && hit.metadata.size) || 0 : null;
}

// The file the browser uploaded for this field, as { filename, originalname }, after checking it really is in
// storage, in the right folder and within the size limit. Null when nothing (valid) was uploaded.
async function receive(body, purpose) {
  const rule = UPLOADS[purpose];
  const m = /^([a-z]+)\/(\d+-[a-f0-9]{16}\.[a-z0-9]+)$/.exec(String(body[`${purpose}_path`] || ''));
  if (!m || m[1] !== rule.folder || !rule.exts.includes(path.extname(m[2]))) return null;
  const size = await sizeOf(rule.folder, m[2]);
  if (size === null) return null;
  if (size > rule.max) { await remove(rule.folder, m[2]); return null; }
  return { filename: m[2], originalname: String(body[`${purpose}_name`] || m[2]).slice(0, 200) };
}

// Deletes stored files; missing ones are ignored. Never throws, so a failed clean-up can't break a save.
async function remove(folder, ...names) {
  const keys = names.filter(Boolean).map(n => objectPath(folder, n));
  if (!keys.length) return;
  const { error } = await sb.storage.from(BUCKET[folder]).remove(keys);
  if (error) console.error(`Couldn't delete ${keys.join(', ')}: ${error.message}`);
}

// A link to a private file that works for `seconds`; with downloadName the browser saves it under that name
async function signedUrl(folder, name, seconds = 60, downloadName) {
  const { data, error } = await sb.storage.from(BUCKET[folder]).createSignedUrl(objectPath(folder, name), seconds,
    downloadName ? { download: downloadName } : undefined);
  if (error) return null;
  return data.signedUrl;
}

module.exports = { UPLOADS, BUCKET, refuse, signUpload, receive, remove, signedUrl, sizeOf, client: sb };
