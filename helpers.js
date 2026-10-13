// Small view helpers, available in every template
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Shapes for icon(): simple outline icons on a 24x24 grid
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  evidence: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  learners: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  staff: '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
  courses: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  enrolments: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
  enquiries: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  bodies: '<circle cx="12" cy="8" r="6"/><path d="M15.48 12.89 17 22l-5-3-5 3 1.52-9.11"/>',
  policies: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  account: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  website: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  collapse: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

module.exports = {
  // Plain text with blank lines -> escaped paragraphs
  paras(text) {
    return String(text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
      .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  },
  // Turns a YouTube / Vimeo link into an embeddable URL
  embed(url) {
    if (!url) return null;
    let m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
    if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}`;
    m = url.match(/vimeo\.com\/(\d+)/);
    if (m) return `https://player.vimeo.com/video/${m[1]}`;
    return null;
  },
  money(n) { return Number(n) > 0 ? '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 0 }) : null; },
  date(d) { return d ? new Date(d.replace(' ', 'T') + (d.includes('Z') ? '' : 'Z')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; },
  // Deadlines are stored as YYYY-MM-DD and compared against today's date in London
  dueDate(d) { return d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : ''; },
  today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); },
  // Label for an assignment deadline, given the learner's latest submission status (if any)
  dueState(due, subStatus) {
    if (!due) return null;
    if (subStatus === 'accepted' || subStatus === 'submitted') return { cls: 'accepted', text: 'Handed in' };
    const today = module.exports.today();
    if (due < today) return { cls: 'resubmit', text: 'Overdue' };
    if (due === today) return { cls: 'pending', text: 'Due today' };
    return { cls: 'pending', text: 'Due ' + module.exports.dueDate(due) };
  },
  // "18 / 20 (90%)" — marks may be halves, so trim trailing ".0"
  markText(mark, total) {
    if (mark === null || mark === undefined) return '';
    const n = v => String(Math.round(v * 10) / 10);
    return total ? `${n(mark)} / ${n(total)} (${Math.round((mark / total) * 100)}%)` : n(mark);
  },
  // SCORM time ("0001:23:10.5" in 1.2, "PT1H23M10S" in 2004) -> "1h 23m"
  scormTime(t) {
    if (!t) return '';
    let h = 0, m = 0, sec = 0, x;
    if ((x = String(t).match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/))) [h, m, sec] = x.slice(1).map(Number);
    else if ((x = String(t).match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/))) { h = (+x[1] || 0) * 24 + (+x[2] || 0); m = +x[3] || 0; sec = +x[4] || 0; }
    else return '';
    const total = Math.round(h * 3600 + m * 60 + sec);
    return total < 60 ? `${total}s` : `${Math.floor(total / 3600) ? Math.floor(total / 3600) + 'h ' : ''}${Math.floor(total / 60) % 60}m`;
  },
  // Badge colour for a SCORM status
  scormStatusClass(s) { return ['completed', 'passed'].includes(s) ? 'accepted' : s === 'failed' ? 'resubmit' : s === 'incomplete' ? 'pending' : ''; },
  // Public address of an uploaded image, resource or video (Supabase Storage, "media" bucket)
  fileUrl(folder, name) {
    return name ? `${String(process.env.SUPABASE_URL || '').replace(/\/$/, '')}/storage/v1/object/public/media/${folder}/${encodeURIComponent(name)}` : '';
  },
  // Line icon drawn inline (24x24 grid, takes the text colour): <%- icon('learners') %>
  icon(name, size = 18) {
    const shapes = ICONS[name];
    return shapes ? `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shapes}</svg>` : '';
  },
  initials(name) { return String(name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase(); },
};
