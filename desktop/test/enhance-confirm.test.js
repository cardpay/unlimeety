'use strict';
// node test/enhance-confirm.test.js
//
// spec-robustness-config-writes.md: transcripts:enhance now pre-checks the
// chunk count before submitting and asks the renderer to confirm above
// ENHANCE_CONFIRM_CHUNKS (200) — the exact behavior the spec's own I/O matrix
// and acceptance criteria call out ("Given an Enhance target with 300
// chunks... needsConfirmation is returned"). Flagged by review as having
// zero execution-based test coverage.
//
// The precheck also had to gain the same isPathInside/extension/canReadPath
// guard runEnhanceJob itself already applies — added during this same
// review, since the first cut read the file with no guard at all. This file
// pins that guard too: a path outside TRANSCRIPTS_FOLDER must skip the
// precheck (and reach queue.submit exactly like any other path does today),
// never be read.
//
// main.js requires electron and cannot be required directly, so the
// transcripts:enhance handler is sliced out as a standalone arrow function
// and evaluated with `new Function`, closing over real fs/path/transcript-
// enhance.js plus sliced isPathInside/canReadPath (same construction as
// test/path-guards.test.js) and a stub queue. Real transcript-enhance.js is
// used, not a stub — this test cares about the real chunk count it computes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { test, after } = require('node:test');
const enhance = require('../transcript-enhance');

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

function sliceConst(name) {
    const start = MAIN.indexOf(`\nconst ${name} = `);
    assert.notStrictEqual(start, -1, `const ${name} not found in main.js — renamed or moved?`);
    const end = MAIN.indexOf(';\n', start);
    assert.notStrictEqual(end, -1, `const ${name} has no terminating ";"`);
    return checkParses(MAIN.slice(start, end + 1), name);
}

// The literal value of a top-level `const NAME = <value>;`, taken verbatim
// from main.js rather than restated here — a changed threshold must change
// this test's expectations along with it, not silently drift apart.
function constValue(name) {
    return new Function(`${sliceConst(name)}\nreturn ${name};`)();
}

function sliceIpcHandlerFn(name) {
    const marker = `ipcMain.handle('${name}', `;
    const at = MAIN.indexOf(marker);
    assert.notStrictEqual(at, -1, `ipcMain.handle('${name}', ...) not found in main.js`);
    return checkParses(sliceBraces(MAIN, at + marker.length, `${name} handler`), `${name} handler`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enhance-confirm-'));
const TRANSCRIPTS = path.join(tmpRoot, 'Meet_Transcripts');
const RECORDINGS = path.join(tmpRoot, 'Meet_Recordings');
const OUTSIDE = path.join(tmpRoot, 'outside');
fs.mkdirSync(TRANSCRIPTS, { recursive: true });
fs.mkdirSync(RECORDINGS, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// Real isPathInside/canReadPath, built the same way test/path-guards.test.js
// does — the precheck must apply the identical guard, so the test has to use
// the identical function, not a hand-rolled stand-in.
const guardSrc = [sliceFunction('isPathInside'), sliceFunction('canReadPath')].join('\n');
const guards = new Function(
    'fs', 'path', 'TRANSCRIPTS_FOLDER', 'RECORDINGS_FOLDER', 'allowedReadPaths',
    `${guardSrc}\nreturn { isPathInside, canReadPath };`,
)(fs, path, TRANSCRIPTS, RECORDINGS, new Set());

function makeHandler(queueSubmitCalls) {
    const src = sliceIpcHandlerFn('transcripts:enhance');
    const factory = new Function(
        'isPathInside', 'TRANSCRIPTS_FOLDER', 'path', 'canReadPath', 'fs',
        'ENHANCE_PRECHECK_PARSE_CAP', 'enhance', 'NOTE_LABEL', 'ENHANCE_CONFIRM_CHUNKS', 'queue', 'fromMain',
        `return ${src};`,
    );
    return factory(
        guards.isPathInside, TRANSCRIPTS, path, guards.canReadPath, fs,
        constValue('ENHANCE_PRECHECK_PARSE_CAP'),
        enhance,
        constValue('NOTE_LABEL'),
        constValue('ENHANCE_CONFIRM_CHUNKS'),
        { submit: (type, key, opts) => { queueSubmitCalls.push({ type, key, opts }); return { id: 'job1' }; } },
        () => true, // fromMain — this test is about the chunk-count precheck, not the sender guard
    );
}

test('a small transcript (well under the chunk threshold) submits normally', () => {
    const filePath = path.join(TRANSCRIPTS, 'small.txt');
    fs.writeFileSync(filePath, 'Meeting: x\n\n[00:00] A:\nhi\n\n[00:05] B:\nhello\n');
    const submitted = [];
    const handler = makeHandler(submitted);

    const result = handler(null, filePath, false);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.needsConfirmation, undefined);
    assert.strictEqual(submitted.length, 1, 'a file under the threshold must reach queue.submit');
});

test('a file over ENHANCE_PRECHECK_PARSE_CAP asks for confirmation via the size estimate, without submitting', () => {
    const filePath = path.join(TRANSCRIPTS, 'huge.txt');
    // Content doesn't need to be a well-formed transcript here — above the
    // parse cap the handler estimates from stat.size alone and never parses it.
    fs.writeFileSync(filePath, 'x'.repeat(2_100_000));
    const submitted = [];
    const handler = makeHandler(submitted);

    const result = handler(null, filePath, false);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.needsConfirmation, true);
    assert.ok(result.chunks > 200, `estimated chunk count must exceed the 200 threshold, got ${result.chunks}`);
    assert.strictEqual(submitted.length, 0, 'must not submit while awaiting confirmation');
});

test('confirmed:true bypasses the check even for a file over the threshold', () => {
    const filePath = path.join(TRANSCRIPTS, 'huge-confirmed.txt');
    fs.writeFileSync(filePath, 'x'.repeat(2_100_000));
    const submitted = [];
    const handler = makeHandler(submitted);

    const result = handler(null, filePath, true);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(submitted.length, 1, 'confirmed:true must submit unconditionally');
});

test('a path outside the transcripts folder skips the precheck read entirely and still reaches submit', () => {
    const filePath = path.join(OUTSIDE, 'not-managed.txt');
    fs.writeFileSync(filePath, 'x'.repeat(2_100_000)); // would trip needsConfirmation if it were read
    const submitted = [];
    const handler = makeHandler(submitted);

    const result = handler(null, filePath, false);
    assert.strictEqual(result.needsConfirmation, undefined,
        'a path failing isPathInside/canReadPath must never be read by the precheck — same guard runEnhanceJob applies');
    assert.strictEqual(submitted.length, 1, 'it must still reach queue.submit, where runEnhanceJob rejects it as it already does today');
});

console.log('enhance-confirm: all checks passed');
