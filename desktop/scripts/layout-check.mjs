// npm run check:layout
//
// Geometry check for the Record and Live start screens and the shared "From
// calendar" popover. It lives in scripts/ rather than test/ on purpose: bare
// `node --test` globs `**/test/**/*.?(c|m)js`, so anything under test/ would be
// dragged into `npm test`, which must stay Electron-free and under a second.
// `test/setup-screens.test.js` guards the CSS invariants there; this file
// measures what the browser actually lays out.
//
// It drives its own Electron over CDP: a scratch --user-data-dir (the installed
// app holds the single-instance lock on the real one), --remote-debugging-port
// for the socket, Emulation.setDeviceMetricsOverride for the two window sizes
// the bug was reported at.
//
// One line per row of the spec's I/O matrix, plus one for the scratch-dir
// cleanup; exit code 1 if any FAILs or if fewer rows ran than expected.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import {
    connect, debugPort, evaluator, requireNode22, waitForRenderer, waitForTarget,
} from './cdp.mjs';

requireNode22('check:layout');

const DESKTOP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = debugPort();
const EXPECTED_ROWS = 23;
const EPS = 1.5; // sub-pixel layout slack

const results = [];
const check = (row, ok, detail) => {
    results.push({ row, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${row}${detail ? `  — ${detail}` : ''}`);
};

// Every row goes through here: a throw inside one row must not swallow the rows
// after it, or a single harness fault hides the whole matrix behind a shrunken
// denominator.
async function row(name, fn) {
    try {
        const [ok, detail] = await fn();
        check(name, ok, detail);
    } catch (err) {
        check(name, false, `threw: ${err.message}`);
    }
}

// ─── Page-side helpers, injected once ────────────────────────────────────────

const HELPERS = `
window.__lc = {
  // Show a tab and skip its platform gate: this check is about geometry, and on
  // a host where live.platformOK()/record's gate says no, #*-setup would sit
  // inside a hidden ancestor and every rect would read zero.
  showTab(tab) {
    document.querySelector('.tab-btn[data-tab="' + tab + '"]').click();
    for (const t of ['live', 'record']) {
      document.getElementById(t + '-unsupported')?.classList.add('hidden');
      document.getElementById(t + '-main')?.classList.remove('hidden');
    }
  },
  // Every measurement is taken against a fully expanded form: the disclosure
  // open is what pushed Live's heading above scrollTop 0 in the first place.
  setup(tab, { details }) {
    const box = document.getElementById(tab + '-setup');
    box.querySelectorAll('details').forEach((d) => { d.open = details; });
    box.scrollTop = 0;
    return box;
  },
  rects(tab) {
    const box = document.getElementById(tab + '-setup');
    const inner = box.querySelector('.live-setup-inner');
    return {
      box: box.getBoundingClientRect().toJSON(),
      inner: inner.getBoundingClientRect().toJSON(),
      heading: inner.querySelector('h2').getBoundingClientRect().toJSON(),
      maxScroll: box.scrollHeight - box.clientHeight,
    };
  },
  // Anything laying out wider than its own box. Form controls scroll their own
  // text by design, and so does anything with a non-visible overflow-x, so only
  // ordinary boxes count.
  hOverflow(tab) {
    const box = document.getElementById(tab + '-setup');
    return [...box.querySelectorAll('*')]
      .filter((el) => el.clientWidth > 0
        && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
        && getComputedStyle(el).overflowX === 'visible'
        && el.scrollWidth - el.clientWidth > 1)
      .map((el) => (el.tagName.toLowerCase() + '.' + (el.className || '?')).slice(0, 60)
        + ' (' + el.clientWidth + ' vs ' + el.scrollWidth + ')');
  },
  // Open the popover and give it a body taller than its 320px cap, so the
  // geometry does not depend on how many events the calendar happens to hold.
  //
  // window.calendar is a deeply frozen contextBridge object, so calendar.list
  // cannot be stubbed out (writable: false, configurable: false — verified).
  // Instead of racing a fixed timeout, wait for the real reply to land and only
  // then install the filler, so nothing overwrites it afterwards.
  async openCal(btnId, place) {
    const btn = document.getElementById(btnId);
    if (getComputedStyle(btn).display === 'none') {
      return { unavailable: 'calendar bridge reports this platform unsupported' };
    }
    btn.click();
    const deadline = Date.now() + 8000;
    let pop = null;
    for (;;) {
      pop = document.querySelector('.cal-pop');
      // 'Loading…' is what showMessage puts in synchronously; anything else
      // means api.list() has settled and no further write is coming.
      if (pop && !pop.textContent.includes('Loading')) break;
      if (Date.now() > deadline) {
        return { unavailable: pop ? 'calendar.list() never settled' : 'popover never opened' };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    pop.innerHTML = '<div style="height:900px"></div>';
    if (place) btn.scrollIntoView({ block: place });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      pop: pop.getBoundingClientRect().toJSON(),
      btn: btn.getBoundingClientRect().toJSON(),
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  },
  closeCal() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    return !document.querySelector('.cal-pop');
  },
};
return 'ok';
`;

// ─── Assertions ──────────────────────────────────────────────────────────────

const inViewport = (r, vw, vh) =>
    r.top >= -EPS && r.left >= -EPS && r.bottom <= vh + EPS && r.right <= vw + EPS;

const rendered = (r) => r.width > 0 && r.height > 0;

const fmt = (r) => `top ${Math.round(r.top)}, bottom ${Math.round(r.bottom)}, `
    + `left ${Math.round(r.left)}, right ${Math.round(r.right)}`;

async function run(evaluate, cdp) {
    await evaluate(HELPERS);

    // Block If: the popover fix is CSS anchor positioning or nothing.
    const support = await evaluate(`return {
        area: CSS.supports('position-area', 'block-end span-inline-end'),
        fallbacks: CSS.supports('position-try-fallbacks', 'flip-block'),
        visibility: CSS.supports('position-visibility', 'anchors-visible'),
        anchorName: 'anchorName' in document.body.style,
    };`);
    const supported = Object.values(support).every(Boolean);
    check('anchor positioning supported at runtime', supported, JSON.stringify(support));
    if (!supported) return;

    const size = async (w, h) => {
        await cdp.send('Emulation.setDeviceMetricsOverride',
            { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        await evaluate('await new Promise((r) => requestAnimationFrame(r)); return 1;');
    };

    // ── Row: form fits (tall window) ────────────────────────────────────────
    await size(1200, 1600);
    for (const tab of ['live', 'record']) {
        await row(`form fits — ${tab} column centred, no scrollbar`, async () => {
            await evaluate(`__lc.showTab('${tab}'); __lc.setup('${tab}', { details: false });`);
            const r = await evaluate(`return __lc.rects('${tab}')`);
            const above = r.inner.top - r.box.top;
            const below = r.box.bottom - r.inner.bottom;
            return [rendered(r.inner) && r.maxScroll <= EPS && Math.abs(above - below) <= 2,
                `above ${Math.round(above)}, below ${Math.round(below)}, `
                + `maxScroll ${Math.round(r.maxScroll)}`];
        });
    }

    // ── Rows: form taller than window (1200x800) and smallest window (800x600)
    for (const [w, h] of [[1200, 800], [800, 600]]) {
        await size(w, h);
        for (const tab of ['live', 'record']) {
            await evaluate(`__lc.showTab('${tab}'); __lc.setup('${tab}', { details: true });`);

            await row(`${w}x${h} — ${tab} heading reachable at scrollTop 0, overflow scrollable`,
                async () => {
                    const r = await evaluate(`return __lc.rects('${tab}')`);
                    const above = r.inner.top - r.box.top;
                    const overflowBelow = Math.max(0, r.inner.bottom - r.box.bottom);
                    const headingVisible = r.heading.top >= r.box.top - EPS
                        && r.heading.bottom <= r.box.bottom + EPS;
                    // Only assert the 40px padding when the form really does
                    // overflow — a form that fits is correctly centred instead,
                    // and reporting that as FAIL would be the wrong alarm.
                    const overflows = r.maxScroll > EPS;
                    return [rendered(r.inner) && overflows && above >= -EPS
                        && Math.abs(above - 40) <= EPS && headingVisible
                        && r.maxScroll + EPS >= overflowBelow,
                    `padding above ${Math.round(above)}, maxScroll ${Math.round(r.maxScroll)} `
                    + `>= overflowBelow ${Math.round(overflowBelow)}`];
                });

            await row(`${w}x${h} — ${tab} "Start recording" reachable by scrolling`, async () => {
                const reach = await evaluate(`
                    const box = document.getElementById('${tab}-setup');
                    box.scrollTop = box.scrollHeight;
                    await new Promise((r) => requestAnimationFrame(r));
                    const b = document.getElementById('${tab}-btn-start').getBoundingClientRect();
                    const c = box.getBoundingClientRect();
                    box.scrollTop = 0;
                    return { ok: b.bottom <= c.bottom + 1.5 && b.top >= c.top - 1.5,
                             b: b.toJSON() };`);
                return [reach.ok && rendered(reach.b), fmt(reach.b)];
            });

            // The row that would have caught the 58px horizontal spill: three
            // `1fr` model cards whose min-content floor was the download footer.
            await row(`${w}x${h} — ${tab} no horizontal overflow inside the form`, async () => {
                const over = await evaluate(`return __lc.hOverflow('${tab}')`);
                return [over.length === 0, over.length ? over.join('; ') : 'nothing overflows'];
            });
        }
    }

    // ── Rows: popover placement ─────────────────────────────────────────────
    // Room below needs a window where the form fits: #live-cal-btn sits in the
    // last row of the column, so at 1200x800 with the disclosure open there is
    // never 320px under it — which is why the popover used to open off-screen.
    await row('popover, room below — under the button, left edges aligned', async () => {
        await size(1200, 1600);
        await evaluate(`__lc.showTab('live'); __lc.setup('live', { details: false });`);
        const m = await evaluate(`return __lc.openCal('live-cal-btn', null)`);
        if (m.unavailable) return [false, m.unavailable];
        const closed = await evaluate('return __lc.closeCal()');
        const ok = m.pop.top >= m.btn.bottom - EPS && Math.abs(m.pop.left - m.btn.left) <= EPS
            && inViewport(m.pop, m.vw, m.vh);
        return [ok && closed, `${fmt(m.pop)} vs button bottom ${Math.round(m.btn.bottom)}`];
    });

    // Same popover, form scrolled under it: anchor positioning must follow.
    await row('form scrolls while open — popover follows the button', async () => {
        await size(1200, 800);
        await evaluate(`__lc.setup('live', { details: true });`);
        const m = await evaluate(`return __lc.openCal('live-cal-btn', 'center')`);
        if (m.unavailable) return [false, m.unavailable];
        const moved = await evaluate(`
            const box = document.getElementById('live-setup');
            const before = box.scrollTop;
            const max = box.scrollHeight - box.clientHeight;
            // Move somewhere reachable: += 120 is a no-op at maxScroll, which
            // is exactly where scrollIntoView({ block: 'center' }) can leave a
            // button that lives in the form's last rows.
            box.scrollTop = before + 120 <= max ? before + 120 : Math.max(0, before - 120);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            const btn = document.getElementById('live-cal-btn').getBoundingClientRect();
            const pop = document.querySelector('.cal-pop').getBoundingClientRect();
            return { btn: btn.toJSON(), pop: pop.toJSON(), scrolled: box.scrollTop - before };`);
        // scrollTop += 120 is a no-op when maxScroll < 120, and then "it
        // followed" would be vacuously true.
        const closed = await evaluate('return __lc.closeCal()');
        const ok = Math.abs(moved.scrolled) > EPS
            && Math.abs(moved.pop.left - moved.btn.left) <= EPS
            && (moved.pop.top >= moved.btn.bottom - EPS
                || moved.pop.bottom <= moved.btn.top + EPS);
        return [ok && closed,
            `scrolled ${Math.round(moved.scrolled)}px; button ${fmt(moved.btn)} `
            + `/ popover ${fmt(moved.pop)}`];
    });

    // No room below: button parked at the bottom of the scroll box.
    await row('popover, no room below — flips above, fully inside the viewport', async () => {
        await evaluate(`__lc.setup('live', { details: true });`);
        const m = await evaluate(`return __lc.openCal('live-cal-btn', 'end')`);
        if (m.unavailable) return [false, m.unavailable];
        const closed = await evaluate('return __lc.closeCal()');
        const ok = inViewport(m.pop, m.vw, m.vh) && m.pop.bottom <= m.btn.top + EPS;
        return [ok && closed,
            `${fmt(m.pop)} vs button top ${Math.round(m.btn.top)}, viewport ${m.vw}x${m.vh}`];
    });

    // Room on neither side: the 320px popover plus its 4px margin fits neither
    // below nor above only when the button sits in a ~100px band in the middle
    // of a viewport shorter than ~676px. No real "From calendar" button reaches
    // it — all three sit in their form's last rows, so scrolling to the bottom
    // still leaves 460px of viewport above them — so the button is parked there
    // by hand. Everything else is the real popover, real anchor, real CSS: this
    // is the row that proves the popover stays on screen when both flips
    // overflow, which is the guarantee whether the app can reach it or not.
    await row('popover, room on neither side — capped, on screen, scrolls internally',
        async () => {
            await size(800, 600);
            await evaluate(`__lc.setup('live', { details: true });`);
            const m = await evaluate(`return __lc.openCal('live-cal-btn', 'center')`);
            if (m.unavailable) return [false, m.unavailable];
            const sq = await evaluate(`
                const btn = document.getElementById('live-cal-btn');
                Object.assign(btn.style, { position: 'fixed', top: '300px', left: '20px' });
                try {
                  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
                  const pop = document.querySelector('.cal-pop');
                  if (!pop) return null;
                  const b = btn.getBoundingClientRect();
                  return {
                    pop: pop.getBoundingClientRect().toJSON(),
                    below: window.innerHeight - b.bottom, above: b.top,
                    clientHeight: pop.clientHeight, scrollHeight: pop.scrollHeight,
                    vw: window.innerWidth, vh: window.innerHeight,
                  };
                } finally {
                  // Must run even when the popover vanished, or the next row
                  // inherits a position: fixed button.
                  Object.assign(btn.style, { position: '', top: '', left: '' });
                }`);
            const closed = await evaluate('return __lc.closeCal()');
            if (!sq) return [false, 'popover vanished while being squeezed'];
            const ok = sq.below < 324 && sq.above < 324 && inViewport(sq.pop, sq.vw, sq.vh)
                && sq.pop.height <= 320 + EPS && sq.scrollHeight > sq.clientHeight;
            return [ok && closed,
                `room below ${Math.round(sq.below)} / above ${Math.round(sq.above)}; `
                + `height ${Math.round(sq.pop.height)} (content ${sq.scrollHeight}), `
                + fmt(sq.pop)];
        });

    // ── Row: the New Meeting modal's button, same picker ────────────────────
    await row('New Meeting modal — same picker, popover inside the viewport', async () => {
        await size(1200, 800);
        await evaluate(`
            __lc.showTab('editor');
            document.getElementById('new-modal').classList.remove('hidden');
            await new Promise((r) => requestAnimationFrame(r));
            return 1;`);
        const m = await evaluate(`return __lc.openCal('new-cal-btn', null)`);
        const closed = await evaluate(`
            const ok = __lc.closeCal();
            document.getElementById('new-modal').classList.add('hidden');
            return ok;`);
        if (m.unavailable) return [false, m.unavailable];
        return [inViewport(m.pop, m.vw, m.vh) && Math.abs(m.pop.left - m.btn.left) <= EPS
            && closed, fmt(m.pop)];
    });

    // ── Row: one --cal-anchor name, three buttons ───────────────────────────
    // The whole reason `anchored` exists in calendar-picker.js: the name has to
    // move to whichever button is open, and be cleared off the last one.
    await row('anchor handoff — second button takes over --cal-anchor', async () => {
        await evaluate(`__lc.showTab('live'); __lc.setup('live', { details: true });`);
        const a = await evaluate(`return __lc.openCal('live-cal-btn', 'center')`);
        if (a.unavailable) return [false, a.unavailable];
        const handoff = await evaluate(`
            const live = document.getElementById('live-cal-btn');
            const rec = document.getElementById('record-cal-btn');
            const first = live.style.anchorName;
            __lc.closeCal();
            __lc.showTab('record'); __lc.setup('record', { details: true });
            rec.scrollIntoView({ block: 'center' });
            return { first, cleared: live.style.anchorName };`);
        const b = await evaluate(`return __lc.openCal('record-cal-btn', 'center')`);
        if (b.unavailable) return [false, b.unavailable];
        const names = await evaluate(`return {
            live: document.getElementById('live-cal-btn').style.anchorName,
            record: document.getElementById('record-cal-btn').style.anchorName,
        };`);
        const attached = b.pop.top >= b.btn.bottom - EPS
            || b.pop.bottom <= b.btn.top + EPS;
        const closed = await evaluate('return __lc.closeCal()');
        const ok = handoff.first === '--cal-anchor' && handoff.cleared === ''
            && names.live === '' && names.record === '--cal-anchor'
            && attached && inViewport(b.pop, b.vw, b.vh);
        return [ok && closed,
            `live "${handoff.first}" -> "${names.live}", record "${names.record}"; `
            + `popover ${fmt(b.pop)} vs button ${fmt(b.btn)}`];
    });

    // ── Dismiss behaviour, unchanged by the rewrite ─────────────────────────
    // openPopover/closePopover now also own the anchor name, so the three ways
    // out have to keep working — and leave no --cal-anchor behind on the button,
    // or the next popover would anchor to the wrong one. The toggle is driven
    // with a real mousedown+click pair: the capture-phase outside-mousedown
    // listener sees the button too, so a plain .click() would not exercise it.
    await row('popover dismiss — click-to-toggle, outside mousedown, Escape; anchor cleared',
        async () => {
            await evaluate(`__lc.showTab('live'); __lc.setup('live', { details: true });`);
            const d = await evaluate(`
                const btn = document.getElementById('live-cal-btn');
                const press = (el) => {
                  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                };
                const open = async () => {
                  press(btn);
                  const deadline = Date.now() + 8000;
                  while (Date.now() < deadline) {
                    const p = document.querySelector('.cal-pop');
                    if (p && !p.textContent.includes('Loading')) return true;
                    await new Promise((r) => setTimeout(r, 50));
                  }
                  return false;
                };
                const gone = () => !document.querySelector('.cal-pop') && !btn.style.anchorName;
                const out = {};
                out.opened = await open();
                press(btn);                                   // real second click
                out.toggle = gone();
                out.reopened = await open();
                document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                out.outside = gone();
                await open();
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
                out.escape = gone();
                out.anchorWhileOpen = (await open()) && btn.style.anchorName === '--cal-anchor';
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
                return out;`);
            return [d.opened && d.toggle && d.reopened && d.outside && d.escape
                && d.anchorWhileOpen, JSON.stringify(d)];
        });
}

// ─── Harness ─────────────────────────────────────────────────────────────────

const userData = await mkdtemp(path.join(tmpdir(), 'unlimeety-layout-'));
const childExited = { done: null };
let cdp;
let child;

try {
    child = spawn(electron, [
        DESKTOP,
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${userData}`,
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    // Without these, a missing binary throws outside the try and an early exit
    // burns the full startup timeout before reporting something unrelated.
    child.on('error', (err) => { childExited.done = `spawn failed: ${err.message}`; });
    child.on('exit', (code, sig) => {
        childExited.done ??= `exit code ${code}${sig ? ` (${sig})` : ''}`;
    });

    const target = await waitForTarget(PORT, Date.now() + 45_000, childExited);
    // A stranger's Electron on a colliding port must not be driven silently.
    const expected = `file://${DESKTOP}/renderer/index.html`;
    if (target.url !== expected) {
        throw new Error(`CDP target is not this project: ${target.url} (want ${expected})`);
    }
    cdp = connect(target.webSocketDebuggerUrl);
    await cdp.open;
    await cdp.send('Runtime.enable');
    const evaluate = evaluator(cdp);

    // Renderer scripts are classic <script> tags; wait for the document, not just
    // the target, or the tab buttons are not wired up yet.
    if (!(await waitForRenderer(evaluate))) {
        check('renderer ready', false, 'document never finished loading in 20s');
    } else {
        await run(evaluate, cdp);
    }
} catch (err) {
    check('harness', false, err.message);
} finally {
    cdp?.close();
    if (child) {
        child.kill('SIGKILL');
        // Electron's helper processes keep writing into the scratch dir until
        // the group is actually gone; removing it before that is an ENOTEMPTY
        // that used to replace the whole verdict.
        if (!childExited.done) await once(child, 'exit').catch(() => {});
    }
    await row('scratch dir cleaned up', async () => {
        await rm(userData, { recursive: true, force: true });
        return [true, userData];
    });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} rows passed`);
if (results.length !== EXPECTED_ROWS) {
    console.log(`FAIL  row count — ran ${results.length}, expected ${EXPECTED_ROWS}: `
        + 'a row was skipped, so the denominator above is not the whole matrix');
}
process.exitCode = (failed.length || results.length !== EXPECTED_ROWS) ? 1 : 0;
