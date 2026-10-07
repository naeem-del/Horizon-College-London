// SCORM runtime for the lesson page. Packages look for window.API (SCORM 1.2) or window.API_1484_11 (SCORM 2004)
// in a parent window; both are defined here. Values are kept in a flat { "cmi.x.y": "value" } map and the whole
// map is posted to the server on Commit, on Finish/Terminate, every minute while it changes, and when the page closes.
(function () {
  const cfg = JSON.parse(document.getElementById('scorm-data').textContent);
  const is2004 = cfg.version === '2004';
  const data = Object.assign({}, cfg.saved);
  const hasHistory = Object.keys(data).length > 0;
  let state = 'new', lastError = '0', dirty = false;

  // ---- Time: SCORM 1.2 uses HHHH:MM:SS.SS, 2004 uses ISO 8601 durations like PT1H2M3.5S ----
  function toSeconds(t) {
    let m = String(t || '').match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
    m = String(t || '').match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/);
    if (m) return ((+m[1] || 0) * 365 + (+m[2] || 0) * 30 + (+m[3] || 0)) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0);
    return 0;
  }
  function fromSeconds(s) {
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = Math.round((s % 60) * 100) / 100;
    if (is2004) return `PT${h}H${m}M${sec}S`;
    const pad = (n, w) => String(Math.floor(n)).padStart(w, '0');
    return `${pad(h, 4)}:${pad(m, 2)}:${pad(sec, 2)}${sec % 1 ? '.' + String(Math.round((sec % 1) * 100)).padStart(2, '0') : ''}`;
  }

  // ---- Data model ----
  const K = is2004
    ? { status: 'cmi.completion_status', session: 'cmi.session_time', total: 'cmi.total_time', entry: 'cmi.entry', exit: 'cmi.exit' }
    : { status: 'cmi.core.lesson_status', session: 'cmi.core.session_time', total: 'cmi.core.total_time', entry: 'cmi.core.entry', exit: 'cmi.core.exit' };
  const resume = hasHistory && (is2004 ? data['cmi.exit'] === 'suspend' || !!data['cmi.suspend_data'] : true);

  const fixed = is2004 ? {
    'cmi._version': '1.0', 'cmi.learner_id': cfg.learner.id, 'cmi.learner_name': cfg.learner.name,
    'cmi.mode': 'normal', 'cmi.credit': 'credit', 'cmi.entry': resume ? 'resume' : 'ab-initio',
    'cmi.score._children': 'scaled,raw,min,max',
    'cmi.objectives._children': 'id,score,success_status,completion_status,progress_measure,description',
    'cmi.interactions._children': 'id,type,objectives,timestamp,correct_responses,weighting,learner_response,result,latency,description',
    'cmi.comments_from_learner._children': 'comment,location,timestamp', 'cmi.comments_from_lms._children': 'comment,location,timestamp',
    'cmi.learner_preference._children': 'audio_level,language,delivery_speed,audio_captioning',
  } : {
    'cmi._version': '3.4', 'cmi.core.student_id': cfg.learner.id, 'cmi.core.student_name': cfg.learner.name,
    'cmi.core.lesson_mode': 'normal', 'cmi.core.credit': 'credit', 'cmi.core.entry': resume ? 'resume' : 'ab-initio',
    'cmi.core._children': 'student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time',
    'cmi.core.score._children': 'raw,min,max', 'cmi.objectives._children': 'id,score,status',
    'cmi.interactions._children': 'id,objectives,time,type,correct_responses,weighting,student_response,result,latency',
    'cmi.student_data._children': 'mastery_score,max_time_allowed,time_limit_action',
    'cmi.student_preference._children': 'audio,language,speed,text',
  };
  const defaults = is2004
    ? { 'cmi.completion_status': 'unknown', 'cmi.success_status': 'unknown', 'cmi.total_time': 'PT0H0M0S', 'cmi.location': '', 'cmi.suspend_data': '', 'cmi.launch_data': '' }
    : { 'cmi.core.lesson_status': 'not attempted', 'cmi.core.total_time': '0000:00:00', 'cmi.core.lesson_location': '', 'cmi.suspend_data': '', 'cmi.launch_data': '', 'cmi.comments': '' };
  const writeOnly = is2004 ? ['cmi.exit', 'cmi.session_time'] : ['cmi.core.exit', 'cmi.core.session_time'];

  function count(prefix) {
    const re = new RegExp('^' + prefix.replace(/\./g, '\\.') + '\\.(\\d+)\\.'), seen = new Set();
    for (const k in data) { const m = k.match(re); if (m) seen.add(m[1]); }
    return String(seen.size);
  }
  function get(key) {
    key = String(key);
    if (state !== 'running') { lastError = is2004 ? (state === 'new' ? '122' : '123') : '301'; return ''; }
    lastError = '0';
    if (key in fixed) return fixed[key];
    if (key === 'adl.nav.request_valid.continue') return cfg.nextUrl ? 'true' : 'false';
    if (key === 'adl.nav.request_valid.previous') return cfg.prevUrl ? 'true' : 'false';
    if (key.endsWith('._count')) return count(key.slice(0, -7));
    if (writeOnly.includes(key)) { lastError = is2004 ? '405' : '404'; return ''; }
    if (key in data) return data[key];
    if (key in defaults) return defaults[key];
    return '';
  }
  function set(key, value) {
    key = String(key); value = String(value);
    if (state !== 'running') { lastError = is2004 ? (state === 'new' ? '132' : '133') : '301'; return 'false'; }
    if (key in fixed || key.endsWith('._count') || key.endsWith('._children')) { lastError = is2004 ? '404' : '403'; return 'false'; }
    if (!/^(cmi|adl)\./.test(key)) { lastError = is2004 ? '401' : '201'; return 'false'; }
    data[key] = value; dirty = true; lastError = '0';
    if (key === K.status || key === 'cmi.success_status') commit();
    return 'true';
  }

  // ---- Saving ----
  const statusEl = document.getElementById('scorm-status');
  function body() {
    const p = new URLSearchParams();
    p.set('_csrf', cfg.csrf); p.set('data', JSON.stringify(data));
    return p;
  }
  function onSaved(r) {
    if (!r || !r.ok) return;
    if (statusEl && r.status) {
      statusEl.textContent = r.status.replace(/^\w/, c => c.toUpperCase());
      statusEl.className = 'status ' + ({ completed: 'accepted', passed: 'accepted', failed: 'resubmit', incomplete: 'pending' }[r.status] || '');
    }
    if (r.complete && !cfg.done) {
      cfg.done = true;
      document.querySelectorAll('[data-scorm-done]').forEach(el => { el.hidden = false; });
    }
  }
  function commit() {
    dirty = false;
    fetch(cfg.commitUrl, { method: 'POST', body: body(), credentials: 'same-origin' })
      .then(r => r.json()).then(onSaved).catch(() => { dirty = true; });
    return 'true';
  }
  // Session time is added to total time when the package finishes (or the page closes without finishing)
  function rollUpTime() {
    if (data[K.session]) {
      data[K.total] = fromSeconds(toSeconds(data[K.total] || defaults[K.total]) + toSeconds(data[K.session]));
      delete data[K.session];
    }
  }
  function finish() {
    if (state !== 'running') { lastError = is2004 ? (state === 'new' ? '112' : '113') : '301'; return 'false'; }
    rollUpTime();
    state = 'done'; lastError = '0';
    // SCORM 2004 packages can ask to move on when they finish: go to the next/previous lesson in the course
    const nav = { continue: cfg.nextUrl, previous: cfg.prevUrl, exit: cfg.exitUrl, exitAll: cfg.exitUrl, suspendAll: cfg.exitUrl }[data['adl.nav.request']];
    delete data['adl.nav.request'];
    if (is2004 && nav) {
      dirty = false;
      navigator.sendBeacon(cfg.commitUrl, body());
      setTimeout(() => { window.location.href = nav; }, 0);
      return 'true';
    }
    commit();
    return 'true';
  }
  function init() {
    if (state === 'running') { lastError = is2004 ? '103' : '101'; return 'false'; }
    if (state === 'done' && is2004) { lastError = '104'; return 'false'; }
    state = 'running'; lastError = '0';
    if (!is2004 && (data[K.status] || 'not attempted') === 'not attempted') { data[K.status] = 'incomplete'; dirty = true; }
    if (is2004 && (data[K.status] || 'unknown') === 'unknown') { data[K.status] = 'incomplete'; dirty = true; }
    return 'true';
  }
  setInterval(() => { if (dirty && state === 'running') commit(); }, 60000);
  window.addEventListener('pagehide', () => {
    if (state === 'running') rollUpTime();
    if (state === 'running' || dirty) navigator.sendBeacon(cfg.commitUrl, body());
  });

  const errors = {
    0: 'No error', 101: 'General exception', 103: 'Already initialized', 104: 'Content instance terminated', 112: 'Termination before initialization',
    113: 'Termination after termination', 122: 'Retrieve data before initialization', 123: 'Retrieve data after termination',
    132: 'Store data before initialization', 133: 'Store data after termination', 201: 'Invalid argument error', 301: 'Not initialized',
    401: 'Not implemented error', 403: 'Element is read only', 404: is2004 ? 'Data model element is read only' : 'Element is write only', 405: 'Data model element is write only',
  };
  const errorString = c => errors[c] || 'Unknown error';

  if (is2004) {
    window.API_1484_11 = {
      Initialize: () => init(), Terminate: () => finish(), GetValue: get, SetValue: set,
      Commit: () => (state === 'running' ? commit() : (lastError = '142', 'false')),
      GetLastError: () => lastError, GetErrorString: errorString, GetDiagnostic: c => errorString(c || lastError),
    };
  } else {
    window.API = {
      LMSInitialize: () => init(), LMSFinish: () => finish(), LMSGetValue: get, LMSSetValue: set,
      LMSCommit: () => (state === 'running' ? commit() : (lastError = '301', 'false')),
      LMSGetLastError: () => lastError, LMSGetErrorString: errorString, LMSGetDiagnostic: c => errorString(c || lastError),
    };
  }

  // The package iframe is only given its address once the API exists, so it always finds it
  const frame = document.getElementById('scorm-frame');
  frame.src = frame.dataset.src;
  const full = document.getElementById('scorm-full');
  if (full && document.fullscreenEnabled) full.addEventListener('click', () => frame.parentElement.requestFullscreen());
  else if (full) full.hidden = true;
})();
