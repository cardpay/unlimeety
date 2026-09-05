'use strict';
// node test/default-filenames.test.js
//
// spec-recording-summary-filename-date-suffix.md moved the date/time stamp
// from a leading prefix to a trailing suffix on both recording and summary
// filenames, but nothing pinned the new order — a future edit could flip
// title and timestamp back and no test would fail. main.js has no exports,
// so the functions are sliced out of the source and evaluated, same
// technique as sliceMainFunction() in test/record-auto-transcribe.test.js.
// Pinning is on ORDER only (title before timestamp), not on the exact date
// arithmetic, so this stays independent of the machine's timezone.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

function sliceFunction(name) {
    const start = MAIN.indexOf(`\nfunction ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in main.js — renamed or moved?`);
    let depth = 0;
    for (let i = MAIN.indexOf('{', start); i < MAIN.length; i++) {
        if (MAIN[i] === '{') depth++;
        else if (MAIN[i] === '}' && --depth === 0) return MAIN.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${name}()`);
}

// Full dependency chain of defaultRecordingStem/defaultSummaryBase, sliced
// together so it can be evaluated standalone with only `path` injected.
const DEPS = [
    'sanitizeRecordingName', 'recordingTimestamp', 'defaultRecordingStem',
    'dateParts', 'meetingDateParts', 'formatDateDashedYy',
    'stripMeetPrefix', 'sanitizeFilenameChars', 'legacySummaryBase', 'defaultSummaryBase',
];
const src = DEPS.map(sliceFunction).join('\n');
new vm.Script(src, { filename: 'slice:default-filenames' });
const { defaultRecordingStem, defaultSummaryBase } = new Function(
    'path',
    `${src}\nreturn { defaultRecordingStem, defaultSummaryBase };`,
)(path);

test('a recording stem is "<title> <timestamp>", not the reverse', () => {
    const stem = defaultRecordingStem('Weekly Sync');
    assert.match(stem, /^Weekly Sync \d{2}-\d{2} \d{2}-\d{2}-\d{2}$/,
        `expected "<title> HH-mm DD-MM-YY", got ${JSON.stringify(stem)}`);
});

test('an untitled recording stem is just the timestamp — no leading placeholder', () => {
    const stem = defaultRecordingStem('Recording');
    assert.match(stem, /^\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/, `got ${JSON.stringify(stem)}`);
});

test('a summary base is "<title> <date>", not the reverse', () => {
    const base = defaultSummaryBase('/x/some-transcript.txt', { title: 'Weekly Sync' }, Date.now());
    assert.match(base, /^Weekly Sync \d{2}-\d{2}-\d{2}$/,
        `expected "<title> DD-MM-YY", got ${JSON.stringify(base)}`);
});

test('a missing title still gets the date suffix, derived from the transcript filename', () => {
    // info.title absent (not blank-but-present) falls back to the filename
    // stem as the *title* source, which then still runs through the same
    // "<title> <date>" order as an explicit title would.
    const base = defaultSummaryBase('/x/some-transcript.txt', {}, Date.now());
    assert.match(base, /^some-transcript \d{2}-\d{2}-\d{2}$/, `got ${JSON.stringify(base)}`);
});

test('a title that sanitizes down to nothing falls back to the bare transcript stem, no date', () => {
    const base = defaultSummaryBase('/x/some-transcript.txt', { title: '   ' }, Date.now());
    assert.strictEqual(base, 'some-transcript');
});
