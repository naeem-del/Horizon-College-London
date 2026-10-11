// Serves SCORM package files from our own domain, so a package playing in the lesson page's iframe can reach the
// SCORM API that page defines (window.API / window.API_1484_11 only work across the same origin).
// Access comes from the signed address the lesson page hands out (scorm.contentBase), so these requests need no
// session or database lookups; server.js mounts this router before the session middleware.
const router = require('express').Router();
const path = require('path');
const { Readable } = require('stream');
const scorm = require('../scorm');
const storage = require('../storage');

// Pages and the data files a package's own scripts read are passed through from our domain. Everything else
// (scripts, styles, images, audio, video, fonts) is redirected to a short-lived storage link.
const PASS_THROUGH = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.xml': 'application/xml',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt',
};

router.get('/:folder/:token/*file', async (req, res) => {
  const { folder, token } = req.params;
  const key = [].concat(req.params.file).join('/');
  if (!scorm.checkToken(folder, token) || !scorm.safePath(key)) return res.status(404).end();
  const url = await storage.signedKeyUrl('scorm', `${folder}/${key}`, 3600);
  if (!url) return res.status(404).end();
  const type = PASS_THROUGH[path.extname(key).toLowerCase()];
  if (!type) {
    res.set('Cache-Control', 'private, max-age=3000'); // the link lasts an hour; let the browser reuse it meanwhile
    return res.redirect(url);
  }
  const file = await fetch(url);
  if (!file.ok) return res.status(file.status === 400 ? 404 : file.status).end();
  res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=300' });
  Readable.fromWeb(file.body).pipe(res);
});

module.exports = router;
