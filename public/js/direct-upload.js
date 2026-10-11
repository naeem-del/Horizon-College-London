// Uploads chosen files straight to storage before a form is sent, so big files never pass through the web server
// (on Vercel a request can carry at most 4.5 MB).
// A form opts in with data-direct-upload="<url that signs uploads>"; each <input type="file" data-upload="<purpose>">
// is uploaded first and then sent as hidden <purpose>_path and <purpose>_name fields. A SCORM package
// (data-upload="scorm") is unzipped and uploaded file by file instead, by scorm-upload.js.
(function () {
  const shown = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const loadScript = src => new Promise((resolve, reject) => {
    if (document.querySelector('script[src="' + src + '"]')) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve;
    s.onerror = () => reject(new Error('Part of the page couldn’t be loaded. Refresh and try again.'));
    document.head.appendChild(s);
  });

  function post(url, form, fields) {
    const body = new URLSearchParams(Object.assign({ _csrf: form.querySelector('input[name=_csrf]').value }, fields));
    return fetch(url, { method: 'POST', body, credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(r => r.json().catch(() => ({ error: 'The upload couldn’t be started. Refresh the page and try again.' })));
  }

  // PUT to the signed link; XMLHttpRequest because fetch can't report upload progress
  function put(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('The file couldn’t be uploaded (storage said ' + xhr.status + ').')));
      xhr.onerror = () => reject(new Error('The upload failed. Check your connection and try again.'));
      const data = new FormData();
      data.append('cacheControl', '3600');
      data.append('', file);
      xhr.send(data);
    });
  }

  function hidden(form, name, value) {
    let input = form.querySelector('input[type=hidden][name="' + name + '"]');
    if (!input) { input = document.createElement('input'); input.type = 'hidden'; input.name = name; form.appendChild(input); }
    input.value = value;
  }

  document.addEventListener('submit', async e => {
    const form = e.target;
    if (e.defaultPrevented || !form.matches('form[data-direct-upload]') || form.dataset.uploaded) return;
    // Inputs in a hidden part of the form (e.g. the SCORM box when adding a course by hand) are left out
    const inputs = Array.from(form.querySelectorAll('input[type=file][data-upload]')).filter(i => !i.disabled && i.files.length && shown(i));
    if (!inputs.length) return;
    e.preventDefault();
    const submitter = e.submitter;
    const buttons = Array.from(form.querySelectorAll('button, input[type=submit]'));
    let note = form.querySelector('.upload-note');
    if (!note) { note = document.createElement('p'); note.className = 'upload-note small'; note.setAttribute('role', 'status'); (submitter || form.lastElementChild).insertAdjacentElement('afterend', note); }
    note.classList.remove('upload-error');
    buttons.forEach(b => { b.disabled = true; });
    try {
      for (const input of inputs) {
        const file = input.files[0], purpose = input.dataset.upload;
        if (purpose === 'scorm') {
          await loadScript('/js/scorm-upload.js?v=1');
          const pkg = await window.HorizonScorm.upload(file, {
            signUrl: input.dataset.signUrl, csrf: form.querySelector('input[name=_csrf]').value,
            maxZipMB: Number(input.dataset.maxMb), maxFileMB: Number(input.dataset.fileMaxMb),
            onStatus: text => { note.textContent = text; },
          });
          hidden(form, 'scorm_pkg', pkg.folder);
          hidden(form, 'scorm_home', pkg.home);
          hidden(form, 'scorm_name', file.name);
          input.disabled = true;
          continue;
        }
        note.textContent = 'Uploading ' + file.name + '…';
        const sign = await post(form.dataset.directUpload, form, { purpose, filename: file.name, size: file.size });
        if (sign.error) throw new Error(sign.error);
        await put(sign.url, file, pct => { note.textContent = 'Uploading ' + file.name + ': ' + pct + '%'; });
        hidden(form, purpose + '_path', sign.path);
        hidden(form, purpose + '_name', file.name);
        input.disabled = true; // already uploaded: don't send the file itself
      }
      note.textContent = 'Uploaded. Saving…';
      form.dataset.uploaded = '1';
      buttons.forEach(b => { b.disabled = false; });
      if (form.requestSubmit) form.requestSubmit(submitter && submitter.form === form ? submitter : undefined); else form.submit();
    } catch (err) {
      note.textContent = err.message;
      note.classList.add('upload-error');
      buttons.forEach(b => { b.disabled = false; });
    }
  });
})();
