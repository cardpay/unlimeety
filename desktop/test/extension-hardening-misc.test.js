'use strict';
// node --test test/extension-hardening-misc.test.js
//
// spec-extension-hardening.md: two small regression pins the main harnesses
// don't reach.
//
// 1) desktop/renderer/record/record.js and desktop/renderer/live/live.js both
//    build a `.ts-model-card[data-model="..."]` selector from a server-sent
//    model id and now wrap it in CSS.escape(...). Executing the
//    modelDownloadProgress handler needs a real DOM (querySelector on a
//    stubbed tree), which neither file's existing tests set up — this pins
//    the source text instead, same technique as test/claude-args.test.js and
//    test/header-values.test.js's per-handler regex counts, so a silent
//    revert back to raw interpolation still fails the suite.
//
// 2) extenstion/content.js carries its own literal copy of main.js's
//    PHONETIC_LETTERS (a content script can't require() main.js) — this pins
//    the two arrays equal so one drifting out of sync with the other (e.g. a
//    reordering, or an added/removed letter) is caught here rather than
//    silently producing different placeholder-shape detection between the
//    desktop naming pass and the extension's guest-impersonation guard.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const RECORD_JS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'record', 'record.js'), 'utf-8');
const LIVE_JS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'live', 'live.js'), 'utf-8');
const MAIN_JS = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
const CONTENT_JS = fs.readFileSync(path.join(__dirname, '..', '..', 'extenstion', 'content.js'), 'utf-8');

test('record.js CSS.escapes the model id in its data-model selector', () => {
    assert.match(RECORD_JS, /\.ts-model-card\[data-model="\$\{CSS\.escape\(evt\.model\)\}"\]/,
        'evt.model must be wrapped in CSS.escape(...), not interpolated raw');
});

test('live.js CSS.escapes the model id in its data-model selector', () => {
    assert.match(LIVE_JS, /\.ts-model-card\[data-model="\$\{CSS\.escape\(event\.model\)\}"\]/,
        'event.model must be wrapped in CSS.escape(...), not interpolated raw');
});

function extractPhoneticLetters(src, label) {
    const start = src.indexOf('const PHONETIC_LETTERS = [');
    assert.notStrictEqual(start, -1, `PHONETIC_LETTERS not found in ${label}`);
    const end = src.indexOf('];', start);
    assert.notStrictEqual(end, -1, `unterminated PHONETIC_LETTERS array in ${label}`);
    const arrayLiteral = src.slice(start, end);
    // Pull out every single-quoted string literal rather than JSON.parse-ing
    // the whole array — both copies keep a trailing comma after 'Omega',
    // which JSON rejects outright.
    return [...arrayLiteral.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('content.js\'s PHONETIC_LETTERS copy stays in sync with main.js\'s', () => {
    const mainLetters = extractPhoneticLetters(MAIN_JS, 'main.js');
    const contentLetters = extractPhoneticLetters(CONTENT_JS, 'content.js');
    assert.deepStrictEqual(contentLetters, mainLetters,
        'the two hand-maintained copies must list the same letters in the same order');
});

console.log('extension-hardening-misc: all checks passed');
