// Unzips a SCORM package in the browser and uploads its files straight to storage, so the web server never
// handles the zip (on Vercel a request can carry at most 4.5 MB). Loaded on demand by direct-upload.js.
// HorizonScorm.upload(file, options) resolves to { folder, home }: the package's storage folder and where
// imsmanifest.xml sits inside it ('' or e.g. 'course/'), which the form then sends to the server.
window.HorizonScorm = (function () {
  const MB = 1024 * 1024;
  // Storage serves each file with the type it was uploaded with, so scripts and pages must be labelled correctly
  const TYPES = {
    html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
    xml: 'application/xml', xsd: 'application/xml', txt: 'text/plain', vtt: 'text/vtt', svg: 'image/svg+xml', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', mp4: 'video/mp4',
    webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', woff: 'font/woff',
    woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject', pdf: 'application/pdf',
  };
  // Characters Supabase Storage accepts in file names (matches scorm.safePath on the server)
  const SAFE = /^[\w/!\-.*'() &$@=;+,]+$/;

  function loadJsZip() {
    if (window.JSZip) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/js/vendor/jszip.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('The unzipper couldn’t be loaded. Refresh the page and try again.'));
      document.head.appendChild(s);
    });
  }

  // Runs async tasks with at most `limit` in flight
  async function pool(tasks, limit) {
    let next = 0;
    const worker = async () => { while (next < tasks.length) await tasks[next++](); };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  }

  async function upload(file, o) {
    if (o.maxZipMB && file.size > o.maxZipMB * MB) throw new Error('That package is too big. The limit is ' + o.maxZipMB + ' MB.');
    o.onStatus('Opening the package…');
    await loadJsZip();
    let zip;
    try { zip = await window.JSZip.loadAsync(file); } catch (err) {
      throw new Error(/encrypt/i.test(err.message) ? 'This package is password-protected.' : 'This file isn’t a valid .zip.');
    }
    // Skip folders and the clutter macOS adds to zips
    const entries = Object.values(zip.files).filter(e => !e.dir && !/^__MACOSX\//.test(e.name) && !/(^|\/)\.DS_Store$/.test(e.name));
    for (const e of entries) {
      if (e.name.startsWith('/') || e.name.includes('\\') || e.name.split('/').some(p => p === '..' || p === '.')) throw new Error('This package contains unsafe file paths.');
      if (!SAFE.test(e.name)) throw new Error('This package contains a file name that can’t be stored: ' + e.name + '. Rename it (letters, numbers, - and _ are safe) and export the package again.');
    }
    const manifest = entries.map(e => e.name).filter(n => /(^|\/)imsmanifest\.xml$/.test(n) && n.split('/').length <= 3)
      .sort((a, b) => a.split('/').length - b.split('/').length)[0];
    if (!manifest) throw new Error('This isn’t a SCORM package: imsmanifest.xml is missing.');
    const home = manifest.slice(0, -'imsmanifest.xml'.length);

    let folder = '', done = 0;
    for (let i = 0; i < entries.length; i += 100) {
      const batch = entries.slice(i, i + 100);
      const body = new URLSearchParams({ _csrf: o.csrf, paths: JSON.stringify(batch.map(e => e.name)) });
      if (folder) body.set('folder', folder);
      const sign = await fetch(o.signUrl, { method: 'POST', body, credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(r => r.json()).catch(() => ({ error: 'The upload couldn’t be started. Refresh the page and try again.' }));
      if (sign.error) throw new Error(sign.error);
      folder = sign.folder;
      await pool(batch.map((e, j) => async () => {
        const data = await e.async('blob');
        if (o.maxFileMB && data.size > o.maxFileMB * MB) throw new Error(e.name + ' is larger than ' + o.maxFileMB + ' MB, the most storage accepts for one file.');
        const ext = (e.name.split('.').pop() || '').toLowerCase();
        const form = new FormData();
        form.append('cacheControl', '3600');
        form.append('', new Blob([data], { type: TYPES[ext] || 'application/octet-stream' }), e.name.split('/').pop());
        const r = await fetch(sign.urls[j].url, { method: 'PUT', body: form });
        if (!r.ok) throw new Error(e.name + ' couldn’t be uploaded (storage said ' + r.status + ').');
        o.onStatus('Uploading the package: ' + (++done) + ' of ' + entries.length + ' files');
      }), 6);
    }
    return { folder, home };
  }

  return { upload };
})();
