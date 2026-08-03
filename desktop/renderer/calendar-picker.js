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

  function injectStyles() {
    const css = `
      .cal-pick-btn {
        margin-top: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer;
        background: var(--bg-elevated); color: var(--text-secondary);
        border: 1px solid var(--border); border-radius: 7px;
      }
      .cal-pick-btn:hover { color: var(--text-primary); border-color: var(--border-strong); }
      .cal-pop {
        position: absolute; z-index: 1000; min-width: 280px; max-width: 420px;
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
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onOutside(e) {
    if (popover && !popover.contains(e.target)) closePopover();
  }
  function onKey(e) {
    if (e.key === 'Escape') closePopover();
  }

  function positionUnder(button) {
    const r = button.getBoundingClientRect();
    popover.style.top = `${window.scrollY + r.bottom + 4}px`;
    popover.style.left = `${window.scrollX + r.left}px`;
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
    document.body.appendChild(popover);
    positionUnder(button);
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
