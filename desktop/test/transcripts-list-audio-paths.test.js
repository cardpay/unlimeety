'use strict';
// node test/transcripts-list-audio-paths.test.js
//
// The renderer-side dedup tests (test/transcript-meta.test.js) exercise
// mergeMeetings/deriveMeetingFromTranscript against hand-authored fixtures
// that already assume main.js's transcripts:list hands over an `audioPaths`
// array on both branches — they can't catch a typo or a dropped field in the
// actual main.js code that's supposed to produce it. transcripts:list itself
// is not a good slice-and-eval target (it pulls in readdirSync, statSync,
// readFileSync, findExistingSummaryPath, isSummaryOutdated,
// cachedHasSpokenTurns, parseTranscriptHeaderMain — stubbing all of that for
// one field would dwarf the fix), so this instead pins the source shape
// directly, same "assert on the sliced text" technique
// test/record-auto-transcribe.test.js uses for live:saveTranscript.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

function sliceBraces(src, from, label) {
    let depth = 0;
    for (let i = src.indexOf('{', from); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${label}`);
}

const start = MAIN.indexOf("ipcMain.handle('transcripts:list'");
assert.notStrictEqual(start, -1, 'transcripts:list handler not found in main.js');
const handler = sliceBraces(MAIN, start, "transcripts:list");

const [successBranch, catchBranch] = handler.split(/\}\s*catch\s*\(err\)\s*\{/);
assert.ok(catchBranch, 'transcripts:list must have a catch(err) branch — split point not found');

test('the success branch returns audioPaths alongside the existing audioPath', () => {
    assert.match(successBranch, /audioPath:\s*audioPaths\[0\]\s*\|\|\s*null,\s*audioPaths,/,
        'audioPath must stay the first element, with the full array also present — renaming/dropping either breaks mergeMeetings\' dedup');
});

test('the read-failed branch recomputes audioPaths independently of the failed read', () => {
    assert.match(catchBranch, /findRelatedAudioPaths\(filePath\)/,
        'a read-failed row must still resolve its own related wavs — path existence does not depend on the read that just failed');
    assert.match(catchBranch, /audioPath:\s*audioPaths\[0\]\s*\|\|\s*null,\s*audioPaths,/,
        'the fallback object must expose both fields, or mergeMeetings can\'t dedup a read-failed transcript\'s own wav');
    // hasAudio deliberately stays the fabricated default — see the comment
    // above this branch in main.js. If this ever flips to a real finding, the
    // "Ask First: changing the meeting card" boundary in a sibling
    // deferred-work.md entry is the thing to check first.
    assert.match(catchBranch, /hasAudio:\s*false/,
        'hasAudio itself must stay the conservative fabricated default even though audioPaths is now real');
});

console.log('transcripts-list-audio-paths: all checks passed');
