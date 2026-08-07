// Reusable "rename speaker" popover, shared by the Live tab and the Editor.
// Click a speaker chip → a tiny input (with name suggestions) to bind a real
// name to that speaker. Commits on Enter or blur; Escape cancels. An empty
// value resets the override. Self-contained: injects its own styles and builds
// the popover on demand, mirroring calendar-picker.js.
(function () {
  injectStyles();

  let pop = null;        // the single open popover, if any
  let committed = false; // guard so Escape's blur doesn't also commit

  function injectStyles() {
    const css = `
      .spk-rename {
        position: absolute; z-index: 1000; min-width: 200px; max-width: 320px;
        padding: 6px; background: var(--bg-elevated);
        border: 1px solid var(--border-strong); border-radius: 10px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.5);
      }
      .spk-rename input {
        width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 13px;
        color: var(--text-primary); background: var(--bg-input, var(--bg-elevated));
        border: 1px solid var(--border); border-radius: 7px; outline: none;
      }
      .spk-rename input:focus { border-color: var(--border-focus, var(--accent)); }
      .spk-rename .spk-hint {
        margin-top: 4px; font-size: 11px; color: var(--text-muted); line-height: 1.3;
      }
      .spk-rename .spk-hint-error { color: var(--danger); }
    `;
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener('mousedown', onOutside, true);
  }

  // Clicking away closes the popover; the input's blur commits whatever's typed.
  function onOutside(e) {
    if (pop && !pop.contains(e.target)) close();
  }

  function positionUnder(anchor) {
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${window.scrollY + r.bottom + 4}px`;
    pop.style.left = `${window.scrollX + r.left}px`;
  }

  function open({ anchor, current, suggestions, onCommit, validate }) {
    close();
    committed = false;

    pop = document.createElement('div');
    pop.className = 'spk-rename';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = (current && current !== 'S?' && current !== '…') ? current : '';
    input.placeholder = 'Speaker name';
    input.setAttribute('autocomplete', 'off');

    const list = Array.isArray(suggestions) ? suggestions.filter(Boolean) : [];
    if (list.length) {
      const dl = document.createElement('datalist');
      dl.id = 'spk-rename-suggestions';
      for (const name of list) {
        const opt = document.createElement('option');
        opt.value = name;
        dl.appendChild(opt);
      }
      pop.appendChild(dl);
      input.setAttribute('list', dl.id);
    }

    pop.appendChild(input);
    const hint = document.createElement('div');
    hint.className = 'spk-hint';
    const HINT_DEFAULT = 'Enter to apply · empty to reset';
    hint.textContent = HINT_DEFAULT;
    pop.appendChild(hint);

    // `validate` (optional) refuses a name by returning a reason string — it
    // must be side-effect free, because it runs before anything is committed
    // and may run repeatedly. `onCommit` is the effect and still runs exactly
    // once, after `committed` is set and the popover is closed: both callers
    // rebuild the DOM this popover is anchored to, so any blur they induce
    // would otherwise re-enter here.
    // Refusing keeps the popover open with the reason — a silent no-op is
    // indistinguishable from a misclick, so the user just tries again and gets
    // the same silence. A refusal on blur closes instead: they clicked away.
    const commit = (viaBlur) => {
      if (committed) return;
      const name = input.value.trim();
      const rejection = validate ? validate(name) : null;
      if (rejection && !viaBlur) {
        hint.textContent = rejection;
        hint.classList.add('spk-hint-error');
        input.select();
        return;
      }
      committed = true;
      close();
      if (!rejection) onCommit(name); // empty string => clear the override
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(false); }
      else if (e.key === 'Escape') { e.preventDefault(); committed = true; close(); }
      else if (hint.classList.contains('spk-hint-error')) {
        hint.textContent = HINT_DEFAULT;
        hint.classList.remove('spk-hint-error');
      }
    });
    input.addEventListener('blur', () => commit(true));

    document.body.appendChild(pop);
    positionUnder(anchor);
    setTimeout(() => { input.focus(); input.select(); }, 0);
    document.addEventListener('mousedown', onOutside, true);
  }

  window.speakerRename = { open };
})();
