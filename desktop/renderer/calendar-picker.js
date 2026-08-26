// Reusable "From calendar" picker, shared by the New Meeting modal, the Live
// tab and the Record tab. Calls window.calendar.list() (EventKit, macOS) and
// shows a small popover of nearby events with the current/nearest pre-selected.
// Self-contained: it injects its own styles and builds the popover on demand.
// Remove the <script> tag + the three attach() calls to drop the feature.
(function () {
  const api = window.calendar;
  // Resolves once: is the calendar bridge usable on this platform?
  const platformReady = (api && api.platformOK)
    ? api.platformOK().catch(() => false)
    : Promise.resolve(false);

  injectStyles();

  let popover = null; // the single open popover, if any
  let anchored = null; // the button currently carrying --cal-anchor

  function injectStyles() {
    const css = `
      .cal-pick-btn {
        margin-top: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer;
        background: var(--bg-elevated); color: var(--text-secondary);
        border: 1px solid var(--border); border-radius: 7px;
      }
      .cal-pick-btn:hover { color: var(--text-primary); border-color: var(--border-strong); }
      /* Placement is the browser's job (CSS anchor positioning, Chromium 146 in
         Electron 41). position-area 'block-end span-inline-end' puts the
         popover under the button with their left edges aligned; the fallbacks
         flip it above / to the left when that overflows the viewport. Fixed
         positioning plus an anchor inside a scrolling form also means the
         browser keeps it glued to the button while the form scrolls — which the
         old top/left arithmetic could not do, and got wrong anyway (it added
         window.scrollY, always 0 here, and clamped to nothing).

         No @position-try rule clamping max-height to the space left over: the
         320px cap always fits the window, whose minHeight is 600, and when the
         flips both overflow, box alignment's safe fallback slides the popover
         back inside the viewport on its own. Measured identical with and
         without one — see npm run check:layout.

         position-visibility 'anchors-visible' is not decoration: an anchor that
         stops being rendered — tab switch, the New Meeting modal closing,
         record.js swapping phase sections — stops resolving, and an anchored
         element with an unresolvable anchor falls back to its STATIC position,
         i.e. jumps somewhere unrelated. The old absolute + top/left at least
         stayed put. It also hides the popover when the button scrolls out of
         the form's pane instead of leaving it floating over the toolbar.

         NB: no backticks in here — this whole block is a template literal, and
         a stray one silently kills the file at parse time. */
      .cal-pop {
        position: fixed; z-index: 1000; min-width: 280px; max-width: 420px;
        position-anchor: --cal-anchor;
        position-area: block-end span-inline-end;
        position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline;
        position-visibility: anchors-visible;
        margin: 4px 0;
        max-height: 320px; overflow-y: auto; padding: 4px;
        background: var(--bg-elevated); border: 1px solid var(--border-strong);
        border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,0.5);
        font-size: 13px; color: var(--text-primary);
      }
      .cal-pop-item {
        padding: 8px 10px; border-radius: 7px; cursor: pointer; line-height: 1.35;
      }
      .cal-pop-item:hover, .cal-pop-item.cal-default { background: var(--bg-hover); }
      .cal-pop-item.cal-default { outline: 1px solid var(--accent-2, var(--border-focus)); }
      .cal-pop-time { color: var(--accent); font-variant-numeric: tabular-nums; margin-right: 6px; }
      .cal-pop-title { color: var(--text-primary); }
      .cal-pop-meta { color: var(--text-muted); font-size: 11px; margin-top: 2px; }
      .cal-pop-msg { padding: 10px; color: var(--text-secondary); }
      .cal-pop-link {
        margin-top: 6px; padding: 4px 9px; font-size: 12px; cursor: pointer;
        background: transparent; color: var(--accent); border: 1px solid var(--border); border-radius: 6px;
      }
    `;
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Index of the event happening now; otherwise the next upcoming; otherwise 0.
  function defaultIndex(events) {
    const now = Date.now();
    let ongoing = -1;
    let nextUpcoming = -1;
    events.forEach((ev, i) => {
      const start = new Date(ev.start).getTime();
      const end = new Date(ev.end).getTime();
      if (start <= now && now <= end && ongoing < 0) ongoing = i;
      if (start >= now && nextUpcoming < 0) nextUpcoming = i;
    });
    if (ongoing >= 0) return ongoing;
    if (nextUpcoming >= 0) return nextUpcoming;
    return 0;
  }

  function closePopover() {
    if (!popover) return;
    popover.remove();
    popover = null;
    // One anchor name for all three buttons: whichever one is open owns it.
    if (anchored) { anchored.style.anchorName = ''; anchored = null; }
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onOutside(e) {
    if (!popover || popover.contains(e.target)) return;
    // The anchor button is not "outside": a real second click on it fires
    // mousedown before click, so closing here would let openPopover's toggle
    // immediately reopen — the button would look dead. Leave it to the toggle.
    if (anchored && anchored.contains(e.target)) return;
    closePopover();
  }
  function onKey(e) {
    if (e.key === 'Escape') closePopover();
  }

  function showMessage(text, withSettings) {
    popover.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'cal-pop-msg';
    msg.textContent = text;
    popover.appendChild(msg);
    if (withSettings) {
      const link = document.createElement('button');
      link.className = 'cal-pop-link';
      link.textContent = 'Open Settings';
      link.addEventListener('click', () => { api.openSettings(); closePopover(); });
      msg.appendChild(document.createElement('br'));
      msg.appendChild(link);
    }
  }

  function renderEvents(events, onPick) {
    popover.innerHTML = '';
    if (!events.length) {
      showMessage('No calendar events around now.', false);
      return;
    }
    const def = defaultIndex(events);
    events.forEach((ev, i) => {
      const item = document.createElement('div');
      item.className = 'cal-pop-item' + (i === def ? ' cal-default' : '');
      const title = ev.title || '(no title)';
      const parts = Array.isArray(ev.participants) ? ev.participants : [];
      const meta = `${fmtTime(ev.start)}–${fmtTime(ev.end)}`
        + (parts.length ? ` · ${parts.length} participant${parts.length === 1 ? '' : 's'}` : '');
      item.innerHTML =
        `<div><span class="cal-pop-time">${fmtTime(ev.start)}</span><span class="cal-pop-title"></span></div>` +
        `<div class="cal-pop-meta"></div>`;
      item.querySelector('.cal-pop-title').textContent = title;
      item.querySelector('.cal-pop-meta').textContent = meta;
      item.addEventListener('click', () => {
        closePopover();
        onPick({ title, participants: parts });
      });
      popover.appendChild(item);
    });
  }

  async function openPopover(button, onPick) {
    // Toggle: a second click on the button closes it.
    if (popover) { closePopover(); return; }
    popover = document.createElement('div');
    popover.className = 'cal-pop';
    anchored = button;
    button.style.anchorName = '--cal-anchor';
    document.body.appendChild(popover);
    showMessage('Loading…', false);
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);

    const mine = popover;
    let res;
    try {
      res = await api.list();
    } catch (err) {
      res = { ok: false, error: String(err && err.message || err) };
    }
    if (popover !== mine) return; // closed/reopened while awaiting

    if (res && res.ok) {
      renderEvents(res.events || [], onPick);
    } else {
      showMessage(res && res.error || 'Could not read the calendar.', res && res.reason === 'calendar-permission');
    }
  }

  // Public API: hide the button on unsupported platforms, otherwise wire it up.
  async function attach({ button, onPick }) {
    if (!button) return;
    const ok = await platformReady;
    if (!ok) { button.style.display = 'none'; return; }
    button.addEventListener('click', (e) => {
      e.preventDefault();
      openPopover(button, onPick);
    });
  }

  window.calendarPicker = { attach };
})();
