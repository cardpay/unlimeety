'use strict';
// node test/current-calendar-title.test.js
//
// currentCalendarTitle() used to be a naive `.find()` with no duration cap
// and no title check — an all-day entry ("PTO", a day-long "Sprint 42") is
// "ongoing" from midnight to midnight and would beat the real meeting to the
// pick, since it satisfies the same start/end window. renderer/calendar-
// picker.js's currentEvent() already solved this (duration cap, non-empty
// title, shortest-overlap-wins); this pins that main.js's independent
// reimplementation has the same shape. main.js has no exports, so the
// function is sliced out and evaluated with runCalendarQuery/
// readSelectedCalendarIds/process stubbed, same technique as
// test/ollama-options.test.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

function sliceFunction(name) {
    const start = MAIN.indexOf(`\nasync function ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in main.js — renamed or moved?`);
    let depth = 0;
    for (let i = MAIN.indexOf('{', start); i < MAIN.length; i++) {
        if (MAIN[i] === '{') depth++;
        else if (MAIN[i] === '}' && --depth === 0) return MAIN.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${name}()`);
}

const src = sliceFunction('currentCalendarTitle');
new vm.Script(src, { filename: 'slice:currentCalendarTitle' });

function makeCurrentCalendarTitle(events) {
    return new Function(
        'process', 'readSelectedCalendarIds', 'runCalendarQuery',
        `${src}\nreturn currentCalendarTitle;`,
    )(
        { platform: 'darwin' },
        () => null,
        async (_payload, matcher) => matcher({ type: 'calendarEvents', events }),
    );
}

const iso = (offsetMin) => new Date(Date.now() + offsetMin * 60000).toISOString();

test('an all-day entry never outranks the real meeting happening inside it', async () => {
    const currentCalendarTitle = makeCurrentCalendarTitle([
        { title: 'PTO', start: iso(-12 * 60), end: iso(12 * 60) }, // all-day, "ongoing"
        { title: 'Daily Standup', start: iso(-5), end: iso(10) },   // the real, short call
    ]);
    assert.strictEqual(await currentCalendarTitle(), 'Daily Standup');
});

test('an untitled event cannot be picked even when it is the only match', async () => {
    const currentCalendarTitle = makeCurrentCalendarTitle([
        { title: '', start: iso(-5), end: iso(10) },
        { title: '   ', start: iso(-5), end: iso(10) },
    ]);
    assert.strictEqual(await currentCalendarTitle(), '');
});

test('no events in the window returns empty, not a throw', async () => {
    const currentCalendarTitle = makeCurrentCalendarTitle([]);
    assert.strictEqual(await currentCalendarTitle(), '');
});

test('a real ongoing meeting is still picked when nothing else overlaps', async () => {
    const currentCalendarTitle = makeCurrentCalendarTitle([
        { title: 'Weekly Sync', start: iso(-10), end: iso(20) },
    ]);
    assert.strictEqual(await currentCalendarTitle(), 'Weekly Sync');
});

test('an ongoing meeting outranks a merely-upcoming one, whatever their durations', async () => {
    const currentCalendarTitle = makeCurrentCalendarTitle([
        { title: 'Already running (long)', start: iso(-5), end: iso(180) },
        { title: 'Starts soon (short)', start: iso(2), end: iso(15) },
    ]);
    assert.strictEqual(await currentCalendarTitle(), 'Already running (long)');
});

test('among two merely-upcoming candidates, the earliest start wins — not the shortest', async () => {
    // The bug a naive single tie-break introduces: neither event has started
    // yet, so both are in the "upcoming" phase, where currentEvent()'s own
    // rule is earliest-start-wins, not shortest-duration-wins.
    const currentCalendarTitle = makeCurrentCalendarTitle([
        { title: 'Long meeting starting first', start: iso(1), end: iso(240) },
        { title: 'Short meeting starting later', start: iso(4), end: iso(19) },
    ]);
    assert.strictEqual(await currentCalendarTitle(), 'Long meeting starting first');
});

// ─── Parity with renderer/calendar-picker.js's currentEvent() ───────────────
// The two are comment-linked, not code-linked (main cannot require() a
// renderer script) — nothing else stops them from silently drifting apart
// again the way the original bug happened. Fixtures stay inside 5 minutes so
// both functions' (different) upcoming-window caps agree.
const PICKER_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'calendar-picker.js'), 'utf-8',
);
function sliceFromPicker(name) {
    const constMatch = PICKER_SRC.match(new RegExp(`\\n\\s*const ${name} = [^;]+;`));
    if (constMatch) return constMatch[0];
    const start = PICKER_SRC.indexOf(`\n  function ${name}(`);
    assert.notStrictEqual(start, -1, `${name} not found in renderer/calendar-picker.js — renamed or moved?`);
    let depth = 0;
    for (let i = PICKER_SRC.indexOf('{', start); i < PICKER_SRC.length; i++) {
        if (PICKER_SRC[i] === '{') depth++;
        else if (PICKER_SRC[i] === '}' && --depth === 0) return PICKER_SRC.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${name}()`);
}
const pickerRegion = [
    sliceFromPicker('MAX_MEETING_MS'),
    sliceFromPicker('UPCOMING_CAP_MIN'),
    sliceFromPicker('currentEvent'),
].join('\n');
new vm.Script(pickerRegion, { filename: 'slice:currentEvent' });
const currentEvent = new Function(`${pickerRegion}\nreturn currentEvent;`)();

async function bothPick(events) {
    const currentCalendarTitle = makeCurrentCalendarTitle(events);
    const fromMain = await currentCalendarTitle();
    const fromRenderer = currentEvent(events)?.title || '';
    assert.strictEqual(fromMain, fromRenderer,
        `main.js and calendar-picker.js disagree: ${JSON.stringify({ fromMain, fromRenderer, events })}`);
    return fromMain;
}

test('parity: all-day vs. real meeting', async () => {
    assert.strictEqual(await bothPick([
        { title: 'PTO', start: iso(-12 * 60), end: iso(12 * 60) },
        { title: 'Daily Standup', start: iso(-5), end: iso(10) },
    ]), 'Daily Standup');
});

test('parity: ongoing beats upcoming regardless of duration', async () => {
    assert.strictEqual(await bothPick([
        { title: 'Already running (long)', start: iso(-5), end: iso(180) },
        { title: 'Starts soon (short)', start: iso(2), end: iso(15) },
    ]), 'Already running (long)');
});

test('parity: among upcoming candidates, earliest start wins', async () => {
    assert.strictEqual(await bothPick([
        { title: 'Long meeting starting first', start: iso(1), end: iso(240) },
        { title: 'Short meeting starting later', start: iso(4), end: iso(19) },
    ]), 'Long meeting starting first');
});

test('parity: two ongoing overlaps — shortest wins', async () => {
    assert.strictEqual(await bothPick([
        { title: 'Focus block', start: iso(-90), end: iso(90) },
        { title: 'Actual call', start: iso(-5), end: iso(10) },
    ]), 'Actual call');
});

console.log('current-calendar-title: all checks passed');
