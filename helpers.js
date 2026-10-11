// Small view helpers, available in every template
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  initials(name) { return String(name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase(); },
};
