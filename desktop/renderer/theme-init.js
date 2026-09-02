// Set the theme attribute before first paint to avoid a flash of the dark theme.
// Runs synchronously from <head> (inline scripts are blocked by the page CSP).
// Also loaded by the floating panels (renderer/prompt/, renderer/notes/), which
// read the same preference — see renderer/panel-theme.css.
//
// Nothing here may throw out of the script: an exception from <head> aborts it
// before data-theme is set, which is why the resolution and the write are each
// guarded and every failure path lands on the shipped dark look.
(function () {
  let effective = 'dark'; // default dark — the current look, and the fallback
                          // for anything unreadable or unrecognized below
  try {
    const saved = localStorage.getItem('uds-theme');
    if (saved === 'light' || saved === 'dark') {
      effective = saved;
    } else if (saved === 'system') {
      // Only 'system' consults the OS. For an explicit preference the query
      // result would just be discarded, and matchMedia is one more thing that
      // can be missing or throw in a host we don't control.
      effective = window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
    }
    // Anything else — unset, '', or a hand-edited/legacy value like 'Light' —
    // keeps the dark default instead of being written through: an unrecognized
    // attribute matches no stylesheet block, so the page would render dark
    // anyway with nothing reporting why.
  } catch {
    effective = 'dark'; // storage refused, or no usable matchMedia
  }
  try {
    document.documentElement.dataset.theme = effective; // 'light' | 'dark'
  } catch {
    // Nothing left to fall back to. Every stylesheet's :root holds the dark
    // palette, so an unset attribute still paints the shipped look.
  }
})();
