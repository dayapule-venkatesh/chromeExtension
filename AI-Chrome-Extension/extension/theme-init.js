(() => {
  'use strict';

  // Runs before the stylesheet so the popup never flashes the wrong theme.
  const PREFS_KEY = 'gemini-field-notes.prefs.v1';
  let preference = 'system';

  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (saved && ['light', 'dark', 'system'].includes(saved.theme)) {
      preference = saved.theme;
    }
  } catch {
    // Storage can be unavailable in hardened profiles; follow the OS instead.
  }

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference;

  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
})();
