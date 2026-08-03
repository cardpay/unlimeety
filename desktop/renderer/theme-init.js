// Set the theme attribute before first paint to avoid a flash of the dark theme.
// Runs synchronously from <head> (inline scripts are blocked by the page CSP).
(function () {
  const saved = localStorage.getItem('uds-theme') || 'dark'; // default dark — current look
  const sysLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  const effective = saved === 'system' ? (sysLight ? 'light' : 'dark') : saved;
  document.documentElement.dataset.theme = effective; // 'light' | 'dark'
})();
