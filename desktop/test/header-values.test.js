'use strict';
// node test/header-values.test.js
//
// spec-security-paths-headers.md: every header writer (transcripts:create,
// transcripts:rename, live:saveTranscript, record:rename,
// runRecordTranscribeJob's header build) wrote a renderer-supplied title or
// participant name straight into a `Key: value` transcript header line with
// no sanitization. A value containing "\nSource: /etc/passwd" — typed as a
// meeting title, spoken and transcribed, or planted via a compromised
// extension DOM — became its own header line once written, which is exactly
// the injection findRelatedAudioPaths's Source: trust (see
// test/path-guards.test.js) turned into an arbitrary-file-delete. headerValue
// is the one sanitizer every writer now routes through before the value ever
// reaches setHeaderLine or a `Key: ${value}` template.
//
// main.js requires electron and cannot be required directly; headerValue and
// setHeaderLine are pure string functions with no other dependency, so they
// are sliced out by name and evaluated standalone — same technique as
// test/default-filenames.test.js.

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

/// Text from `from` through the brace-matched block that starts at the first `{`.
function sliceBraces(src, from, what) {
    assert.notStrictEqual(from, -1, `could not find ${what}`);
    let depth = 0;
    for (let i = src.indexOf('{', from); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${what}`);
}

const src = [sliceFunction('setHeaderLine'), sliceFunction('headerValue')].join('\n');
new vm.Script(src, { filename: 'slice:header-values' });
const { setHeaderLine, headerValue } = new Function(`${src}\nreturn { setHeaderLine, headerValue };`)();

// ─── headerValue ─────────────────────────────────────────────────────────────

test('strips control/null bytes and collapses whitespace to single spaces', () => {
    assert.strictEqual(headerValue('a\r\n b\tc\u0000'), 'a b c');
});

test('the I/O matrix example: repeated tabs and spaces both collapse to one', () => {
    assert.strictEqual(headerValue('A\t\tB   C'), 'A B C');
});

test('never touches ":" — header values routinely carry one (e.g. a time)', () => {
    assert.strictEqual(headerValue('Standup: 09:30'), 'Standup: 09:30');
});

test('leading/trailing whitespace is trimmed away, not collapsed to a single space', () => {
    assert.strictEqual(headerValue('  Weekly Sync  '), 'Weekly Sync');
});

test('strips NEL (U+0085) — a C1 control byte plain \\s does not match', () => {
    const nel = String.fromCharCode(0x85);
    assert.strictEqual(headerValue(`a${nel}b`), 'a b');
});

// ─── setHeaderLine, fed an unsanitized vs. a headerValue()-sanitized value ──

test('an unsanitized value containing a newline injects a fake header line (why the fix exists)', () => {
    // Documents the vulnerability, not the fix: setHeaderLine itself does no
    // sanitizing, by design (see main.js's comment above it) — the caller is
    // responsible. Skipping headerValue at a call site reopens exactly this.
    const original = 'Meeting: Old Title\nSource: /real/audio.wav\n\n[00:00] A:\nhi\n';
    const malicious = 'Evil\nSource: /etc/passwd';
    const updated = setHeaderLine(original, 'Meeting', malicious);
    assert.ok(updated.split('\n').some(l => l === 'Source: /etc/passwd'),
        'an unsanitized value is expected to inject a line here — this pins the failure headerValue must prevent');
});

test('a headerValue()-sanitized value cannot inject a fake header line', () => {
    const original = 'Meeting: Old Title\nSource: /real/audio.wav\nGenerated: 2026-01-01T00:00:00.000Z\n\n[00:00] A:\nhi\n';
    const malicious = 'Evil\nSource: /etc/passwd';
    const updated = setHeaderLine(original, 'Meeting', headerValue(malicious));

    const lines = updated.split('\n');
    assert.strictEqual(lines.length, original.split('\n').length,
        'sanitizing must not change the header\'s line count — no line was added or removed');
    const sourceLines = lines.filter((l) => l.startsWith('Source: '));
    assert.deepStrictEqual(sourceLines, ['Source: /real/audio.wav'],
        'exactly the original Source: line must survive, untouched');
    assert.ok(!updated.includes('\nSource: /etc/passwd'),
        'the malicious text must never become its own header line');
    assert.ok(updated.includes('Meeting: Evil Source: /etc/passwd'),
        'the sanitized text is still written — just flattened onto the Meeting: line');
});

// ─── Every header writer routes through headerValue() ───────────────────────
//
// A single handler-wide /headerValue\(/.test(handler) is satisfied by any ONE
// surviving call — it would still pass if a regression dropped sanitization
// from any other value in the same handler (e.g. participants, but not
// title). Pinning an exact per-value count catches that: it only holds if
// every one of the handler's renderer-controlled header values (title,
// participants/names, language) is still wrapped.

test('transcripts:create sanitizes title, each participant, and language through headerValue()', () => {
    const start = MAIN.indexOf(`ipcMain.handle('transcripts:create'`);
    const handler = sliceBraces(MAIN, start, 'transcripts:create handler');
    assert.ok(/headerValue\(title\)/.test(handler), 'title must be sanitized');
    assert.ok(/participants\.map\(s => headerValue\(s\)\)/.test(handler), 'each participant must be sanitized');
    assert.ok(/headerValue\(language\)/.test(handler), 'language must be sanitized');
    assert.strictEqual((handler.match(/headerValue\(/g) || []).length, 3,
        'expected exactly 3 headerValue( call sites (title, participants, language) — a count drop means one was un-sanitized');
});

test('live:saveTranscript sanitizes title, each speaker name, each calendar participant, and language through headerValue()', () => {
    const start = MAIN.indexOf(`ipcMain.handle('live:saveTranscript'`);
    const handler = sliceBraces(MAIN, start, 'live:saveTranscript handler');
    assert.ok(/headerValue\(String\(payload\?\.title/.test(handler), 'title must be sanitized');
    assert.ok(/v == null \? v : headerValue\(v\)/.test(handler), 'each speaker name must be sanitized (null/undefined preserved, not stringified)');
    assert.ok(/calendarParticipants\.map\(p => headerValue\(p\)\)/.test(handler), 'each calendar participant must be sanitized');
    assert.ok(/headerValue\(writtenLanguage\)|headerValue\(language\)/.test(handler), 'language must be sanitized');
    assert.strictEqual((handler.match(/headerValue\(/g) || []).length, 4,
        'expected exactly 4 headerValue( call sites (title, names, calendarParticipants, language) — a count drop means one was un-sanitized');
});

test('runRecordTranscribeJob sanitizes title, each calendar participant, and the written language through headerValue()', () => {
    const start = MAIN.indexOf('async function runRecordTranscribeJob(');
    const fn = sliceBraces(MAIN, start, 'runRecordTranscribeJob()');
    assert.ok(/headerValue\(existingTitle/.test(fn), 'title must be sanitized');
    assert.ok(/opts\.participants\.map\(p => headerValue\(p\)\)/.test(fn), 'each calendar participant must be sanitized');
    assert.ok(/headerValue\(writtenLanguage\)/.test(fn), 'writtenLanguage must be sanitized');
    assert.strictEqual((fn.match(/headerValue\(/g) || []).length, 3,
        'expected exactly 3 headerValue( call sites (title, participants, writtenLanguage) — a count drop means one was un-sanitized');
});

test('transcripts:rename and record:rename sanitize the submitted title through headerValue()', () => {
    for (const channel of ['transcripts:rename', 'record:rename']) {
        const start = MAIN.indexOf(`ipcMain.handle('${channel}'`);
        const handler = sliceBraces(MAIN, start, `${channel} handler`);
        assert.ok(/headerValue\(/.test(handler),
            `${channel} must sanitize the submitted title through headerValue()`);
    }
});

console.log('header-values: all checks passed');
