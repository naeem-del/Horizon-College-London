// Admin sidebar: collapse it to icons only and back, and fold the menu groups open or closed.
// Both choices are remembered in this browser. Loaded straight after the sidebar so it's set up before the page shows.
(function () {
  const shell = document.getElementById('shell'), toggle = document.getElementById('side-toggle');
  if (!shell || !toggle) return;
  const store = {
    get: key => { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set: (key, value) => { try { localStorage.setItem(key, value); } catch (e) { /* private mode: just don't remember */ } },
  };

  // ---- Icons only / full menu ----
  const named = shell.querySelectorAll('.admin-side nav a, .admin-side .me .person, .admin-side .me .link-btn');
  function showCollapsed(collapsed) {
    shell.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.querySelector('.label').textContent = collapsed ? 'Expand menu' : 'Collapse menu';
    toggle.title = collapsed ? 'Expand menu' : '';
    // While the labels are hidden, each icon shows its name on hover
    named.forEach(el => {
      const label = el.querySelector('.label');
      if (collapsed && label) el.title = label.textContent.trim(); else el.removeAttribute('title');
    });
  }
  showCollapsed(shell.classList.contains('collapsed'));
  toggle.addEventListener('click', () => {
    const collapsed = !shell.classList.contains('collapsed');
    showCollapsed(collapsed);
    store.set('adminNav', collapsed ? 'collapsed' : 'expanded');
  });

  // ---- Phones: the Menu button opens and closes the whole menu ----
  const menu = document.getElementById('side-menu'), side = document.getElementById('side');
  if (menu && side) {
    menu.addEventListener('click', () => {
      const open = side.classList.toggle('open');
      menu.setAttribute('aria-expanded', String(open));
    });
  }

  // ---- Fold-out groups ----
  let closed = [];
  try { closed = JSON.parse(store.get('adminNavClosed') || '[]'); } catch (e) { closed = []; }
  shell.querySelectorAll('.admin-side .group').forEach(button => {
    const items = document.getElementById(button.getAttribute('aria-controls'));
    if (!items) return;
    const show = open => { button.setAttribute('aria-expanded', String(open)); items.classList.toggle('closed', !open); };
    // The group holding the current page always starts open
    show(!closed.includes(button.dataset.group) || !!items.querySelector('a.on'));
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      show(open);
      closed = closed.filter(g => g !== button.dataset.group).concat(open ? [] : [button.dataset.group]);
      store.set('adminNavClosed', JSON.stringify(closed));
    });
  });
})();
