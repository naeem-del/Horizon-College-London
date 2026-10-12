// Gentle motion for the public site: sections fade up as they scroll into view (cards one after another), and the
// hero's course / awarding-body numbers count up. The <html class="anim"> flag is set in partials/head.ejs, only
// when the visitor hasn't asked their device for reduced motion; without it (or without this script) nothing is hidden.
(function () {
  const root = document.documentElement;
  window.__anim = true; // tells head.ejs's safety timer this script loaded
  if (!root.classList.contains('anim')) return;

  // Keep in step with the matching list in site.css (".anim :is(...)")
  const SEL = '.pillar, .section-head, .course-card, .about-photo, .about-copy > *, .why > div, .steps li, .cta-band, .bodies-band h2, .filters';
  const items = Array.from(document.querySelectorAll(SEL));

  // Cards in the same row come in one after another
  for (const el of items) {
    const siblings = Array.from(el.parentElement.children).filter(c => c.matches(SEL));
    el.style.setProperty('--reveal-delay', `${(siblings.indexOf(el) % 4) * 90}ms`);
  }

  const show = el => el.classList.add('is-in');
  if (!('IntersectionObserver' in window)) { items.forEach(show); return; }
  const io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { show(e.target); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  items.forEach(el => io.observe(el));

  // Hero numbers ("5 courses") count up once the facts card has appeared
  document.querySelectorAll('.horizon-facts b').forEach(b => {
    const target = Number(b.textContent.trim());
    if (!Number.isInteger(target) || target < 2) return;
    const start = performance.now() + 1100, duration = 900;
    b.textContent = '0';
    const tick = now => {
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      b.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
})();
