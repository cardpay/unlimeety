// "Smart" calendar router: looks at the conferencing links on the nearest
// calendar event and recommends a recording mode —
//   • Google Meet  → nothing (the browser extension records Meet)
//   • Zoom/Teams/…  → Live (system-audio capture)
//   • no such links → Record (likely an in-person meeting)
// Triggered automatically on launch (if a meeting is ongoing/imminent) and
// manually via the header button. The action switches to the right tab and
// pre-fills title + participants; it never auto-starts recording.
//
// Self-contained: injects its own styles, builds the banner on demand, and
// depends only on window.calendar.list() + window.liveTab/recordTab hooks.
(function () {
  const api = window.calendar;
  const platformReady = (api && api.platformOK)
    ? api.platformOK().catch(() => false)
    : Promise.resolve(false);

  // Conferencing host allowlist. Editable here without rebuilding the Swift
  // helper. Google Meet is handled specially (see recommendMode).
  const PLATFORMS = [
    { key: 'google-meet', label: 'Google Meet',     hosts: ['meet.google.com'] },
    { key: 'zoom',        label: 'Zoom',            hosts: ['zoom.us'] },
    { key: 'teams',       label: 'Microsoft Teams', hosts: ['teams.microsoft.com', 'teams.live.com'] },
    { key: 'webex',       label: 'Webex',           hosts: ['webex.com'] },
    { key: 'whereby',     label: 'Whereby',         hosts: ['whereby.com'] },
    { key: 'jitsi',       label: 'Jitsi',           hosts: ['meet.jit.si'] },
    { key: 'other',       label: 'online meeting',  hosts: ['bluejeans.com', 'gotomeeting.com', 'goto.com', 'chime.aws', 'meet.lync.com'] },
  ];

  injectStyles();
  let banner = null;

  function injectStyles() {
    const css = `
      #cal-smart-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 11px; font-size: 13px; cursor: pointer;
        background: var(--bg-elevated); color: var(--text-secondary);
        border: 1px solid var(--border); border-radius: 8px;
      }
      #cal-smart-btn:hover { color: var(--text-primary); border-color: var(--border-strong); }
      .cal-smart-banner {
        position: fixed; top: 54px; left: 50%; transform: translateX(-50%);
        z-index: 1000; max-width: 640px; width: max-content;
        display: flex; align-items: center; gap: 12px;
        padding: 10px 12px; font-size: 13px; color: var(--text-primary);
        background: var(--bg-elevated); border: 1px solid var(--border-strong);
        border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.5);
      }
      .cal-smart-msg { line-height: 1.4; }
      .cal-smart-msg .cal-smart-title { color: var(--text-primary); font-weight: 600; }
      .cal-smart-msg .cal-smart-time { color: var(--accent); font-variant-numeric: tabular-nums; }
      .cal-smart-act {
        flex: none; padding: 6px 12px; font-size: 13px; cursor: pointer;
        background: var(--accent); color: var(--accent-fg);
        border: none; border-radius: 8px; font-weight: 600;
      }
      .cal-smart-act:hover { filter: brightness(1.05); }
      .cal-smart-x {
        flex: none; padding: 2px 6px; font-size: 15px; cursor: pointer; line-height: 1;
        background: transparent; color: var(--text-muted); border: none;
      }
      .cal-smart-x:hover { color: var(--text-primary); }
    `;
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  function hostOf(u) {
    try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
  }

  // First matching platform among the event's urls; Google Meet wins if present.
  function detectPlatform(urls) {
    const list = Array.isArray(urls) ? urls : [];
    let meet = null, other = null;
    for (const u of list) {
      const host = hostOf(u);
      if (!host) continue;
      for (const p of PLATFORMS) {
        const hit = p.hosts.some(h => host === h || host.endsWith('.' + h));
        if (!hit) continue;
        if (p.key === 'google-meet') meet = meet || { ...p, url: u };
        else other = other || { ...p, url: u };
      }
    }
    return meet || other || null;
  }

  // → { mode: 'extension' | 'live' | 'record', platform, url }
  function recommendMode(event) {
    const p = detectPlatform(event && event.urls);
    if (!p) return { mode: 'record', platform: null, url: null };
    if (p.key === 'google-meet') return { mode: 'extension', platform: p.label, url: p.url };
    return { mode: 'live', platform: p.label, url: p.url };
  }

  // Ongoing event (now within [start,end]); otherwise the next upcoming one.
  // maxUpcomingMin caps how far ahead an upcoming event counts (null = no cap).
  function pickEvent(events, maxUpcomingMin) {
    const list = Array.isArray(events) ? events : [];
    const now = Date.now();
    let ongoing = null, next = null;
    for (const ev of list) {
      const s = new Date(ev.start).getTime();
      const e = new Date(ev.end).getTime();
      if (s <= now && now <= e) { if (!ongoing) ongoing = ev; }
      else if (s > now && (!next || s < new Date(next.start).getTime())) next = ev;
    }
    if (ongoing) return ongoing;
    if (next && (maxUpcomingMin == null
        || (new Date(next.start).getTime() - now) <= maxUpcomingMin * 60000)) return next;
    return null;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function removeBanner() {
    if (banner) { banner.remove(); banner = null; }
  }

  function showBanner({ title, time, message, actionLabel, onAction }) {
    removeBanner();
    banner = document.createElement('div');
    banner.className = 'cal-smart-banner';

    const msg = document.createElement('div');
    msg.className = 'cal-smart-msg';
    const t = document.createElement('span'); t.className = 'cal-smart-title'; t.textContent = title || '(no title)';
    const sep = document.createTextNode('  ');
    const tm = document.createElement('span'); tm.className = 'cal-smart-time'; tm.textContent = time || '';
    const rest = document.createTextNode(' — ' + message);
    msg.append(t, sep, tm, rest);
    banner.appendChild(msg);

    if (actionLabel && onAction) {
      const act = document.createElement('button');
      act.className = 'cal-smart-act';
      act.textContent = actionLabel;
      act.addEventListener('click', onAction);
      banner.appendChild(act);
    }

    const x = document.createElement('button');
    x.className = 'cal-smart-x';
    x.textContent = '✕';
    x.title = 'Dismiss';
    x.addEventListener('click', removeBanner);
    banner.appendChild(x);

    document.body.appendChild(banner);
  }

  function switchTo(tab) {
    document.querySelector(`#tab-switch .tab-btn[data-tab="${tab}"]`)?.click();
  }

  // Build + show the recommendation for one event. On auto-launch we stay silent
  // for Google Meet (the extension handles it); the manual button shows the info.
  function present(ev, { showExtensionInfo }) {
    const rec = recommendMode(ev);
    const time = `${fmtTime(ev.start)}–${fmtTime(ev.end)}`;

    if (rec.mode === 'extension') {
      if (!showExtensionInfo) return;
      showBanner({
        title: ev.title, time,
        message: `${rec.platform} — the browser extension records this, no desktop app needed.`,
      });
      return;
    }

    const target = rec.mode === 'live' ? 'live' : 'record';
    const actionLabel = rec.mode === 'live' ? 'Go to Live' : 'Go to Record';
    const message = rec.mode === 'live'
      ? `looks like ${rec.platform} — we recommend Live (system-audio capture).`
      : 'no online-meeting links — looks in-person, we recommend Record.';

    showBanner({
      title: ev.title, time, message, actionLabel,
      onAction: () => {
        switchTo(target);
        const hook = target === 'live' ? window.liveTab : window.recordTab;
        hook?.applyCalendarPick({ title: ev.title, participants: ev.participants || [] });
        removeBanner();
      },
    });
  }

  async function onManual() {
    let res;
    try { res = await api.list(); } catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
    if (!res || !res.ok) {
      showBanner({ title: 'Calendar', time: '', message: res && res.error || 'could not read it.' });
      return;
    }
    const ev = pickEvent(res.events, null);
    if (!ev) {
      showBanner({ title: 'Calendar', time: '', message: 'no suitable meeting nearby.' });
      return;
    }
    present(ev, { showExtensionInfo: true });
  }

  // Auto-detect on launch: only nag when there's an actionable recommendation.
  async function autoCheck() {
    if (!(await platformReady)) return;
    let res;
    try { res = await api.list(); } catch { return; }
    if (!res || !res.ok) return; // stay quiet about permissions on launch
    const ev = pickEvent(res.events, 15);
    if (ev) present(ev, { showExtensionInfo: false });
  }

  // Wire the header button (hidden on unsupported platforms) and run autoCheck.
  (async () => {
    const ok = await platformReady;
    const btn = document.getElementById('cal-smart-btn');
    if (btn) {
      if (!ok) btn.style.display = 'none';
      else btn.addEventListener('click', onManual);
    }
  })();
  window.addEventListener('load', autoCheck);

  // Exposed for inspection/testing (e.g. in DevTools).
  window.calendarSmart = { recommendMode, detectPlatform, pickEvent };
})();
