'use strict';
// node test/wav-collision.test.js
//
// spec-robustness-config-writes.md: live:start and record:start each picked
// a default wav path via a bare fs.existsSync collision loop, blind to the
// OTHER tab's in-flight session — its output file doesn't exist on disk
// until the helper actually writes to it. Starting Live and Record both
// untitled inside the same clock minute (or the reverse order) used to have
// the second one silently reuse, and eventually clobber, the first's path.
// isRecordingPathTaken closes that by also checking both `outputPath` fields.
//
// main.js requires electron and cannot be required directly, so
// isRecordingPathTaken is sliced out by name and evaluated with `new
// Function`, closing over stub `live`/`recorder`/`fs` objects.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

function sliceBraces(src, from, what) {
    assert.ok(from >= 0, `could not find ${what}`);
    let depth = 0;
    for (let i = src.indexOf('{', from); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${what}`);
}

function checkParses(text, name) {
    new vm.Script(text, { filename: `slice:${name}` });
    return text;
}

function sliceFunction(name) {
    const start = MAIN.indexOf(`\nfunction ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in main.js — renamed or moved?`);
    return checkParses(sliceBraces(MAIN, start, `${name}()`), name);
}

function makeSandbox(live, recorder, existsSync) {
    const src = sliceFunction('isRecordingPathTaken');
    const factory = new Function('fs', 'live', 'recorder', `${src}\nreturn { isRecordingPathTaken };`);
    return factory({ existsSync }, live, recorder);
}

test('a path matching live.outputPath is taken even when fs.existsSync says no', () => {
    const box = makeSandbox({ outputPath: '/rec/foo.wav' }, { outputPath: null }, () => false);
    assert.strictEqual(box.isRecordingPathTaken('/rec/foo.wav'), true);
});

test('a path matching recorder.outputPath is taken even when fs.existsSync says no', () => {
    const box = makeSandbox({ outputPath: null }, { outputPath: '/rec/bar.wav' }, () => false);
    assert.strictEqual(box.isRecordingPathTaken('/rec/bar.wav'), true);
});

test('an on-disk file is still taken when both outputPaths are null', () => {
    const box = makeSandbox({ outputPath: null }, { outputPath: null }, () => true);
    assert.strictEqual(box.isRecordingPathTaken('/rec/baz.wav'), true);
});

test('a path that is neither an in-flight outputPath nor on disk is free', () => {
    const box = makeSandbox({ outputPath: null }, { outputPath: null }, () => false);
    assert.strictEqual(box.isRecordingPathTaken('/rec/free.wav'), false);
});

test('a different in-flight outputPath does not falsely claim an unrelated path', () => {
    const box = makeSandbox({ outputPath: '/rec/foo.wav' }, { outputPath: '/rec/bar.wav' }, () => false);
    assert.strictEqual(box.isRecordingPathTaken('/rec/unrelated.wav'), false);
});

console.log('wav-collision: all checks passed');
