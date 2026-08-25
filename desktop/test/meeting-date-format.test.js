'use strict';
// node test/meeting-date-format.test.js
//
// renderer/app.js is a classic <script> with no exports, so — like
// renderer-globals.test.js — this reads the source off disk instead of
// requiring it, and evals the marked date-time formatting region. Keeping that
// region free of localStorage and the DOM is what makes it possible; if it
// grows a dependency on either, this test is the thing that breaks first.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'app.js'), 'utf-8',
);

const REGION = SRC.match(
    /\n\/\/ ── date-time formatting[\s\S]*?\n\/\/ ── end date-time formatting ──/,
);
assert.ok(REGION, 'date-time formatting region markers not found in renderer/app.js');

// `Intl` is a parameter, so each load can be handed a stub instead of the real one.
function load(IntlImpl = Intl) {
    return new Function('Intl', `${REGION[0]}
        return { formatMeetingDateTime, systemDateOrder, systemTimeFormat };`)(IntlImpl);
}

const { formatMeetingDateTime } = load();

// Local time, so the formatter's own zone handling is what is under test.
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm);

// ─── Date order × clock ──────────────────────────────────────────────────────
assert.strictEqual(
    formatMeetingDateTime(at(2026, 8, 24, 18, 14), 'dmy', '24h'),
    '24/08/26, 18:14',
    'EU + 24h',
);
assert.strictEqual(
    formatMeetingDateTime(at(2026, 8, 24, 18, 14), 'mdy', '12h'),
    '08/24/26, 6:14 PM',
    'US + 12h',
);
assert.strictEqual(
    formatMeetingDateTime(at(2026, 8, 24, 18, 14), 'mdy', '24h'),
    '08/24/26, 18:14',
    'the clock keeps 24h even when the date order is US',
);
assert.strictEqual(
    formatMeetingDateTime(at(2026, 8, 24, 18, 14), 'dmy', '12h'),
    '24/08/26, 6:14 PM',
    'AM/PM stays uppercase even when the date order is EU',
);

// ─── 12-hour edges ───────────────────────────────────────────────────────────
assert.strictEqual(
    formatMeetingDateTime(at(2026, 8, 24, 0, 5), 'mdy', '12h'),
    '08/24/26, 12:05 AM',
    'midnight is 12:05 AM, never 0:05 AM',
);
assert.strictEqual(
    formatMeetingDateTime(at(2026, 8, 24, 12, 5), 'mdy', '12h'),
    '08/24/26, 12:05 PM',
    'noon is 12:05 PM',
);
assert.strictEqual(
    formatMeetingDateTime(at(2026, 8, 24, 0, 5), 'dmy', '24h'),
    '24/08/26, 00:05',
    'midnight zero-pads in 24h',
);

// ─── Single-digit day and month keep their padding ───────────────────────────
assert.strictEqual(
    formatMeetingDateTime(at(2026, 1, 2, 9, 7), 'dmy', '24h'),
    '02/01/26, 09:07',
);
assert.strictEqual(
    formatMeetingDateTime(at(2026, 1, 2, 9, 7), 'mdy', '24h'),
    '01/02/26, 09:07',
);

// ─── Bad input renders nothing rather than NaN ───────────────────────────────
for (const bad of [undefined, null, '', 'not a date', 0, new Date('nope')]) {
    assert.strictEqual(
        formatMeetingDateTime(bad, 'dmy', '24h'), '',
        `expected "" for ${String(bad)}`,
    );
}

// ─── Unknown preference values fall back, they do not throw ──────────────────
assert.strictEqual(
    formatMeetingDateTime(at(2026, 8, 24, 18, 14), 'garbage', 'garbage'),
    '24/08/26, 18:14',
    'unrecognised preferences fall back to EU + 24h',
);

// ─── Defaults resolved from the OS locale ────────────────────────────────────
// systemDateOrder/systemTimeFormat only touch Intl, so they run against a stub
// instead of whatever locale this machine happens to have.
const partsIntl = (parts) => ({
    DateTimeFormat: function () { return { formatToParts: () => parts }; },
});
const hour12Intl = (hour12) => ({
    DateTimeFormat: function () { return { resolvedOptions: () => ({ hour12 }) }; },
});
const throwingIntl = {
    DateTimeFormat: function () { throw new Error('no ICU data'); },
};
const parts = (...types) => types.map((type) => ({ type, value: '00' }));

assert.strictEqual(
    load(partsIntl(parts('month', 'day', 'year'))).systemDateOrder(), 'mdy',
    'a month-first OS locale defaults to US order',
);
assert.strictEqual(
    load(partsIntl(parts('day', 'month', 'year'))).systemDateOrder(), 'dmy',
    'a day-first OS locale defaults to EU order',
);
assert.strictEqual(
    load(partsIntl(parts('year', 'month', 'day'))).systemDateOrder(), 'mdy',
    'a year-first OS locale still puts the month before the day',
);
assert.strictEqual(
    load(hour12Intl(true)).systemTimeFormat(), '12h',
    'a 12-hour OS locale defaults to 12h',
);
assert.strictEqual(
    load(hour12Intl(false)).systemTimeFormat(), '24h',
    'a 24-hour OS locale defaults to 24h',
);

// ─── A broken Intl degrades, it does not take the sidebar down ───────────────
assert.strictEqual(
    load(throwingIntl).systemDateOrder(), 'dmy',
    'date order falls back when the locale probe throws',
);
assert.strictEqual(
    load(throwingIntl).systemTimeFormat(), '24h',
    'time format falls back when the locale probe throws',
);
assert.strictEqual(
    load(throwingIntl).formatMeetingDateTime(at(2026, 8, 24, 18, 14), 'dmy', '24h'),
    '18:14',
    'formatting falls back to a bare clock rather than throwing per card',
);

// ─── Formatters are built once per preference pair, not once per card ────────
{
    let built = 0;
    const countingIntl = {
        DateTimeFormat: function (...args) {
            built += 1;
            return new Intl.DateTimeFormat(...args);
        },
    };
    const { formatMeetingDateTime: fmt } = load(countingIntl);
    for (let i = 0; i < 50; i += 1) fmt(at(2026, 8, 24, 18, 14), 'dmy', '24h');
    assert.strictEqual(built, 2, 'one date + one time formatter for 50 cards');
    fmt(at(2026, 8, 24, 18, 14), 'mdy', '12h');
    assert.strictEqual(built, 4, 'a different preference pair builds its own two');
}

// ─── Live apply, not Save/Cancel ─────────────────────────────────────────────
// No DOM harness exists for the renderer, so this pins the wiring at the source
// level: the radios must persist on change and repaint, and saveSettings must
// stay out of it — otherwise Cancel would silently revert the user's pick.
const bindBody = SRC.match(/function bindFormatRadios\(radios, key\) \{[\s\S]*?\n\}/);
assert.ok(bindBody, 'bindFormatRadios not found in renderer/app.js');
assert.match(bindBody[0], /addEventListener\("change"/, 'format radios apply on change');
assert.match(bindBody[0], /localStorage\.setItem\(key, r\.value\)/, 'the pick is persisted');
assert.match(bindBody[0], /renderMeetings\(\)/, 'the sidebar repaints immediately');

const saveBody = SRC.match(/async function saveSettings\(\) \{[\s\S]*?\n\}/);
assert.ok(saveBody, 'saveSettings not found in renderer/app.js');
assert.doesNotMatch(
    saveBody[0], /DATE_ORDER_KEY|TIME_FORMAT_KEY|settings-date-order|settings-time-format/,
    'view preferences must not ride the summarizer Save/Cancel flow',
);

console.log('meeting-date-format: ok');
