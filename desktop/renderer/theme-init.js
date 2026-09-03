// Set the theme attribute before first paint to avoid a flash of the dark theme.
// Runs synchronously from <head> (inline scripts are blocked by the page CSP).
// Also loaded by the floating panels (renderer/prompt/, renderer/notes/), which
// read the same preference — see renderer/panel-theme.css.
//
// Nothing here may throw out of the script: an exception from <head> aborts it
// before data-theme is set, which is why the resolution and the write are each
// guarded and every failure path lands on the shipped dark look.
(function () {
  function resolveEffectiveTheme() {
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
    return effective;
  }

  function apply() {
    try {
      document.documentElement.dataset.theme = resolveEffectiveTheme(); // 'light' | 'dark'
    } catch {
      // Nothing left to fall back to. Every stylesheet's :root holds the dark
      // palette, so an unset attribute still paints the shipped look.
    }
  }

  apply();

  // Exposed so a window can re-run this resolution after the preference
  // changes elsewhere — the floating notes window listens for a main-process
  // broadcast and calls this (renderer/notes/notes.js, preload.js `themeApi`).
  // Named under `__` because index.html loads this same file alongside
  // app.js, which has its own top-level `applyTheme`.
  window.__themeInit = { apply };

  // Follow OS appearance changes live while 'system' is selected. app.js has
  // its own copy of this for the main window; every other window that loads
  // this file (the floating panels) is a separate document/JS runtime that
  // never sees that listener, so it needs one of its own. Safe to call
  // unconditionally — resolveEffectiveTheme() only consults matchMedia when
  // the stored preference is 'system', so an explicit choice is unaffected.
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', apply);
  } catch {
    // No matchMedia, or no addEventListener on what it returned — the
    // OS-change case just never fires; the load-time resolution above stands.
  }
})();
