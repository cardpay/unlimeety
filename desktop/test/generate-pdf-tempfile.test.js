'use strict';
// node test/generate-pdf-tempfile.test.js
//
// spec-security-packaging.md: generatePdf (desktop/main.js) used to write its
// scratch HTML via a predictable `transcriber-export-${pid}-${seq}.html` name
// and a plain fs.writeFileSync — on a shared /tmp an attacker who knows (or
// guesses) the next pid/seq pair can pre-plant a symlink at that path, and
// writeFileSync follows it, turning the scratch write into a write wherever
// the symlink points. The fix: an unpredictable crypto.randomBytes-derived
// name opened with fs.openSync(path, 'wx', 0o600) — 'wx' fails on any
// existing directory entry, symlink included, mirroring writeFileAtomic's
// own temp-file convention (see test/path-guards.test.js).
//
// main.js requires electron and cannot be required directly, so the function
// is sliced out by name and checked as text (same sliceFunction/sliceBraces
// technique as path-guards.test.js) rather than executed — generatePdf itself
// needs a real BrowserWindow. The runtime half below proves the *mechanism*
// (random names don't collide, 'wx' rejects a repeat) without electron.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { test, after } = require('node:test');

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

function sliceFunction(name) {
    const start = MAIN.indexOf(`\nasync function ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in main.js — renamed or moved?`);
    const text = sliceBraces(MAIN, start, `${name}()`);
    new vm.Script(text, { filename: `slice:${name}` }); // throws if a }/{ landed in the wrong place
    return text;
}

const generatePdfSrc = sliceFunction('generatePdf');

// ─── Source-text checks ─────────────────────────────────────────────────────

test('generatePdf derives its temp filename from crypto.randomBytes', () => {
    assert.ok(/crypto\.randomBytes\(/.test(generatePdfSrc),
        'generatePdf must name its scratch HTML file with crypto.randomBytes, not a predictable pid/seq counter');
});

test('generatePdf opens the temp file with fs.openSync(..., \'wx\', ...), not a plain fs.writeFileSync(path, ...)', () => {
    assert.ok(/fs\.openSync\([^)]*'wx'/.test(generatePdfSrc),
        'generatePdf must open its temp file with the \'wx\' flag so a pre-planted symlink/file is refused, not followed');
    assert.ok(!/fs\.writeFileSync\(tmpPath/.test(generatePdfSrc),
        'generatePdf must not write through a path-based fs.writeFileSync(tmpPath, ...) — that follows a symlink at tmpPath');
});

test('generatePdf still installs the setWindowOpenHandler/will-navigate guards untouched', () => {
    assert.ok(/setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/.test(generatePdfSrc),
        'the PR2 window-open guard must survive the temp-file rewrite');
    assert.ok(/will-navigate.*event\.preventDefault\(\)/s.test(generatePdfSrc),
        'the PR2 will-navigate guard must survive the temp-file rewrite');
});

// ─── Runtime: the mechanism itself is sound ────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-tempfile-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('two sequential crypto.randomBytes-derived names never collide', () => {
    const a = `transcriber-export-${crypto.randomBytes(16).toString('hex')}.html`;
    const b = `transcriber-export-${crypto.randomBytes(16).toString('hex')}.html`;
    assert.notStrictEqual(a, b);
});

test('opening the same name twice with \'wx\' throws EEXIST on the second call — the flag is load-bearing', () => {
    const target = path.join(tmpRoot, `transcriber-export-${crypto.randomBytes(16).toString('hex')}.html`);
    const fd1 = fs.openSync(target, 'wx', 0o600);
    fs.closeSync(fd1);
    assert.throws(() => fs.openSync(target, 'wx', 0o600), /EEXIST/,
        '\'wx\' must refuse an already-existing path — this is what stops a pre-planted symlink from being followed');
});

test('\'wx\' also refuses a pre-planted symlink at the target path, rather than following it', () => {
    const victim = path.join(tmpRoot, 'victim.html');
    fs.writeFileSync(victim, 'precious data');
    const link = path.join(tmpRoot, `transcriber-export-${crypto.randomBytes(16).toString('hex')}.html`);
    fs.symlinkSync(victim, link);
    assert.throws(() => fs.openSync(link, 'wx', 0o600), /EEXIST/,
        'a planted symlink must be refused, not followed, by the \'wx\' open');
    assert.strictEqual(fs.readFileSync(victim, 'utf-8'), 'precious data');
});

console.log('generate-pdf-tempfile: all checks passed');
