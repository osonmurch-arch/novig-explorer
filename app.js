/* Novig Markets — page shell: theme toggle and version. The dashboard itself is markets.js. */
(() => {
  'use strict';

  /* ---------- theme ---------- */
  const themeBtn = document.querySelector('.theme');
  const saved = (() => { try { return localStorage.getItem('nv-theme'); } catch { return null; } })();
  if (saved) document.documentElement.dataset.theme = saved;
  themeBtn.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('nv-theme', next); } catch { /* storage off */ }
  });

  /* ---------- version ---------- */
  // version.json is the single source of truth; the local server reads the same file.
  window.NV_VERSION = fetch('version.json', { cache: 'no-store' })
    .then((r) => r.json())
    .then((j) => {
      const v = 'v' + j.version;
      document.getElementById('ver').textContent = v;
      document.getElementById('ver-foot').textContent = `${v} · ${j.date}`;
      return j.version;
    })
    .catch(() => '');
})();
