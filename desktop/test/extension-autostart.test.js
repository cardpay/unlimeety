'use strict';
// node --test test/extension-autostart.test.js
//
// Executes the Chrome extension's content script against hand-rolled `chrome`
// and `document` stubs and drives the meeting-status poll, so it asserts
// behaviour rather than source text. No jsdom, no framework — `node:test` plus
// `assert`, in the spirit of renderer-globals.test.js.
//
// Two earlier versions of this file were demonstrably useless, so the harness
// has two deliberate sharp edges:
//
//   * `getElementById` resolves ONLY ids found in the markup injectUI actually
//     assigned. A stub that fabricates any id let "checkbox shipped without a
//     checkbox" and an id typo both pass while the record button went dead.
//   * every case that should complete asserts `injectUI` did not throw. A
//     rendered widget whose click handlers were never registered is worse than
//     a disabled one, and `disabled === false` alone does not detect it.
//
// It lives under desktop/test/ only because `node --test` runs from desktop/ —
// the repository root has no package.json.

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CONTENT_JS = path.join(__dirname, '..', '..', 'extenstion', 'content.js');
const src = fs.readFileSync(CONTENT_JS, 'utf-8');

// ── Harness ─────────────────────────────────────────────────────────────────
// content.js is a classic content script, not a module, so its declarations
// cannot be required. Evaluating it inside a Function whose parameters are the
// globals it touches gives us both isolation and a handle on injectUI.
function run({ stored = {}, active = true, getThrows = false, holdRead = false, pathname = '/abc-defg-hij' } = {}) {
    let isActive = active;
    let markupIds = null;   // ids present in the innerHTML injectUI assigned
    const nodes = new Map();

    const make = (key) => ({
        id: key, disabled: false, title: '', checked: false, value: '',
        style: {}, dataset: {}, _html: '',
        classList: { add() {}, remove() {}, toggle: () => false, contains: () => false },
        handlers: {},
        addEventListener(ev, fn) { this.handlers[ev] = fn; },
        removeEventListener() {},
        appendChild() {},
        querySelector: (sel) => node(sel),
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
        offsetWidth: 220, offsetHeight: 300,
        set innerHTML(v) {
            this._html = v;
            markupIds = new Set([...v.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
            // Honour the markup's own checkbox default instead of inventing one.
            for (const m of v.matchAll(/<input\s+id="([^"]+)"[^>]*>/g)) {
                if (/\bchecked\b/.test(m[0])) node(m[1]).checked = true;
            }
        },
        get innerHTML() { return this._html; },
    });
    const node = (key) => {
        if (!nodes.has(key)) nodes.set(key, make(key));
        return nodes.get(key);
    };

    const document = {
        title: 'Standup - Google Meet',
        body: { appendChild() {} },
        createElement: () => node('#root'),
        // The whole point: an id the injected markup does not contain resolves
        // to null, exactly as a real DOM would.
        getElementById: (id) => (markupIds && !markupIds.has(id) ? null : node(id)),
        addEventListener() {}, removeEventListener() {},
        // isMeetingActive() looks for the Leave-call button first; everything
        // else (meeting title, participants) must miss so it falls back.
        querySelector: (sel) => (isActive && sel.includes('Leave call') ? node('leave') : null),
        querySelectorAll: () => [],
    };

    const timers = new Map();
    let nextTimer = 1;
    const setInterval = (fn) => { const id = nextTimer++; timers.set(id, fn); return id; };
    const clearInterval = (id) => timers.delete(id);
    const setTimeout = () => 0; // never fires: keeps startRecording's awaits pending

    const window = { innerWidth: 1440, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
    const location = { pathname };

    const sent = [];
    const written = {};
    let deferred = null;
    // A real invalidated context breaks every chrome.* entry point, not just the
    // one under test.
    const boom = () => { throw new Error('Extension context invalidated'); };
    const chrome = {
        storage: {
            local: {
                get: (key, cb) => {
                    if (getThrows) boom();
                    if (holdRead && key === 'gmt-autostart') { deferred = () => cb(stored); return; }
                    cb(stored);
                },
                set: (obj, cb) => { if (getThrows) boom(); Object.assign(written, obj); if (cb) cb(); },
            },
        },
        runtime: {
            lastError: undefined,
            sendMessage: (m) => { if (getThrows) boom(); sent.push(m); },
        },
    };

    const factory = new Function(
        'window', 'document', 'chrome', 'setInterval', 'clearInterval', 'setTimeout', 'console', 'location',
        src + '\n; return { injectUI };'
    );
    const quiet = { log() {}, warn() {}, error() {}, debug() {} };
    const api = factory(window, document, chrome, setInterval, clearInterval, setTimeout, quiet, location);

    let threw = null;
    try { api.injectUI(); } catch (e) { threw = e; }

    return {
        threw,
        reinject: () => api.injectUI(),
        liveTimers: () => timers.size,
        setActive: (v) => { isActive = v; },
        setPath: (v) => { location.pathname = v; },
        box: () => document.getElementById('gmt-autostart'),
        recordBtn: () => node('gmt-record-btn'),
        // "Are the primary controls wired?" — the difference between a usable
        // widget and one that merely looks enabled.
        wired: () => Boolean(node('gmt-record-btn').handlers.click && node('gmt-save-btn').handlers.click),
        pollAlive: () => timers.has(window.meetingStatusInterval),
        tick: () => timers.get(window.meetingStatusInterval)?.(),
        toggle: (checked) => {
            const b = document.getElementById('gmt-autostart');
            b.checked = checked;
            b.handlers.change({ target: b });
        },
        resolveRead: () => { if (deferred) { deferred(); deferred = null; } },
        // startRecording sends setMeetingTitle before the captions gate, so this
        // means "the poll decided to start", not "recording succeeded".
        startAttempts: () => sent.filter((m) => m.action === 'setMeetingTitle').length,
        written,
    };
}

test('absent key means on, and the markup ships the box checked', () => {
    const w = run({ stored: {}, active: true });
    assert.strictEqual(w.threw, null);
    assert.strictEqual(w.box().checked, true, 'absent key must leave the box checked');
    w.tick();
    assert.strictEqual(w.startAttempts(), 1, 'no stored value must behave as before this setting existed');
});

test('the markup ships checked, so the on-default never flashes unchecked', () => {
    // Asserted BEFORE the read resolves: afterwards the callback writes the same
    // value either way, so the attribute would look untested.
    const w = run({ stored: {}, active: true, holdRead: true });
    assert.strictEqual(w.box().checked, true, 'the checkbox markup must carry `checked`');
});

test('re-injecting does not leave an orphaned poll behind', () => {
    // injectUI already guards its resize handler "across re-injections", so
    // re-entry happens; a stale interval would go on flipping `disabled` and
    // could fire a second startRecording.
    const w = run({ stored: { 'gmt-autostart': false }, active: true });
    assert.strictEqual(w.liveTimers(), 1);
    w.reinject();
    assert.strictEqual(w.liveTimers(), 1, 'the previous meeting-status poll must be cleared before arming a new one');
});

test('an explicitly stored undefined also means on', () => {
    const w = run({ stored: { 'gmt-autostart': undefined }, active: true });
    w.tick();
    assert.strictEqual(w.startAttempts(), 1);
});

test('auto-start fires once and stops polling', () => {
    const w = run({ stored: {}, active: true });
    w.tick();
    w.tick();
    assert.strictEqual(w.startAttempts(), 1, 'the poll must clear itself, not re-enter startRecording every tick');
    assert.ok(!w.pollAlive(), 'the poll must be gone once auto-start has fired');
});

test('off: nothing starts, and the widget stays usable', () => {
    const w = run({ stored: { 'gmt-autostart': false }, active: true });
    assert.strictEqual(w.threw, null);
    assert.strictEqual(w.box().checked, false, 'a stored false must be reflected in the checkbox');
    assert.ok(w.pollAlive(), 'the poll is the record button\'s only enable path');
    w.tick();
    assert.strictEqual(w.startAttempts(), 0);
    assert.strictEqual(w.recordBtn().disabled, false, 'the button must unlock for manual recording');
    assert.ok(w.wired(), 'and its click handler must actually be registered');
    assert.ok(w.pollAlive(), 'the poll must not be cleared when auto-start is off');
});

test('off with no meeting: button stays locked', () => {
    const w = run({ stored: { 'gmt-autostart': false }, active: false });
    w.tick();
    assert.strictEqual(w.recordBtn().disabled, true);
    assert.strictEqual(w.startAttempts(), 0);
});

test('unticking persists false', () => {
    const w = run({ stored: {}, active: false });
    w.toggle(false);
    assert.strictEqual(w.written['gmt-autostart'], false);
});

test('ticking it on during a live meeting does not record that meeting', () => {
    const w = run({ stored: { 'gmt-autostart': false }, active: true });
    w.tick();                       // poll observes the live meeting
    w.toggle(true);
    assert.strictEqual(w.written['gmt-autostart'], true, 'the preference must still be persisted');
    w.tick();
    w.tick();
    assert.strictEqual(w.startAttempts(), 0, 'this meeting must not be recorded');
});

test('...but the next call in the same tab does auto-start', () => {
    const w = run({ stored: { 'gmt-autostart': false }, active: true, pathname: '/aaa-bbbb-ccc' });
    w.tick();
    w.toggle(true);
    w.tick();
    assert.strictEqual(w.startAttempts(), 0, 'still the opted-out meeting');
    w.setPath('/xxx-yyyy-zzz');      // Meet moves to another call, no page load
    w.tick();
    assert.strictEqual(w.startAttempts(), 1, '"from the next meeting" must hold within one page life');
});

test('ticking it on before the meeting is live does auto-start', () => {
    const w = run({ stored: { 'gmt-autostart': false }, active: false });
    w.toggle(true);
    w.tick();
    assert.strictEqual(w.startAttempts(), 0, 'nothing to start while the meeting is not live');
    w.setActive(true);
    w.tick();
    assert.strictEqual(w.startAttempts(), 1, 'the disarm must not degrade into "never auto-start again"');
});

test('a click outranks a slow read that disagrees with it', () => {
    // The click and the stored value MUST differ, or an overwrite is invisible.
    const w = run({ stored: { 'gmt-autostart': false }, active: false, holdRead: true });
    w.toggle(true);        // user ticks ON while storage still holds false
    w.resolveRead();       // the stale read finally lands
    assert.strictEqual(w.box().checked, true, 'the late callback must not revert the user\'s click');
    w.setActive(true);
    w.tick();
    assert.strictEqual(w.startAttempts(), 1, 'and must not suppress the auto-start they just enabled');
});

test('a read that never returns still leaves a usable widget', () => {
    const w = run({ stored: {}, active: true, holdRead: true });
    assert.strictEqual(w.threw, null);
    assert.ok(w.pollAlive(), 'a dropped storage callback must not take the poll with it');
    w.tick();
    assert.strictEqual(w.recordBtn().disabled, false);
    assert.ok(w.wired(), 'manual recording must be possible');
    assert.strictEqual(w.startAttempts(), 0, 'auto-start must not fire on an unresolved preference');
});

test('an orphaned content script keeps a working widget', () => {
    const w = run({ stored: {}, active: true, getThrows: true });
    assert.strictEqual(w.threw, null, 'a throwing chrome.* call must not abort injectUI');
    assert.ok(w.pollAlive(), 'the poll must still track meeting state');
    assert.ok(w.wired(), 'the record and save buttons must still be wired — an enabled button that ignores clicks is worse than a disabled one');
    w.tick();
    assert.strictEqual(w.recordBtn().disabled, false);
    assert.strictEqual(w.startAttempts(), 0, 'startRecording throws in this context; the poll may try, nothing is recorded');
});

test('a recording in flight short-circuits the poll', () => {
    const w = run({ stored: {}, active: true });
    w.tick();
    const before = w.startAttempts();
    w.tick();
    assert.strictEqual(w.startAttempts(), before, 'isRecording must stop the poll acting again');
});
