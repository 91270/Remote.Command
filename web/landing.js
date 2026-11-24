'use strict';
(function () {
  const THEME_KEY = 'rcm_theme';
  const root = document.documentElement;

  function applyTheme(mode) {
    if (mode === 'light' || mode === 'dark') {
      root.setAttribute('data-theme', mode);
    } else {
      root.removeAttribute('data-theme');
    }
  }

  function currentTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  }

  applyTheme(currentTheme());

  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const cur = currentTheme();
      const effectiveDark = cur === 'dark' || (cur === 'system' && prefersDark);
      const next = effectiveDark ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });
  }

  fetch('/manage/api/session', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .then(session => {
      if (!session) return;
      const heroCta = document.getElementById('hero-primary-cta');
      if (heroCta) {
        heroCta.textContent = '进入我的控制台';
        heroCta.href = '/manage';
      }
      const navCta = document.getElementById('nav-cta');
      if (navCta) navCta.textContent = session.email || session.username || '进入控制台';
    })
    .catch(() => {});
})();
