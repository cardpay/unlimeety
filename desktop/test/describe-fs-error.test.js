'use strict';
// node test/describe-fs-error.test.js
//
// spec-robustness-config-writes.md: ~19 renderer-facing error sites in
// main.js were switched from raw err.message (which, for a real fs/spawn
// error, embeds the absolute path — "ENOENT: no such file or directory,
// open '/Users/name/Downloads/Meet_Transcripts/x.txt'") to
// describeFsError(err), which strips the quoted path. Flagged by review as
// having zero test coverage despite backing that many sites — a regression
// in its gating regex would either leak paths again or start mangling
// unrelated error messages (e.g. a TypeError whose text happens to contain
// "reading 'foo'") at every one of them, with nothing in the suite to catch
// it either way.
//
// main.js requires electron and cannot be required directly, so
// describeFsError is sliced out by name and evaluated standalone — same
// technique as test/default-filenames.test.js.

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

function sliceConst(name) {
    const start = MAIN.indexOf(`\nconst ${name} = `);
    assert.notStrictEqual(start, -1, `const ${name} not found in main.js — renamed or moved?`);
    const end = MAIN.indexOf(';\n', start);
    assert.notStrictEqual(end, -1, `const ${name} has no terminating ";"`);
    return checkParses(MAIN.slice(start, end + 1), name);
}

const src = [sliceConst('NODE_ERRNO_MESSAGE_RE'), sliceFunction('describeFsError')].join('\n');
const describeFsError = new Function(`${src}\nreturn describeFsError;`)();

test('strips the quoted path and syscall off a real ENOENT message', () => {
    const msg = "ENOENT: no such file or directory, open '/Users/alice/Downloads/Meet_Transcripts/x.txt'";
    assert.strictEqual(describeFsError({ message: msg }), 'ENOENT: no such file or directory');
});

test('strips both paths off a rename-shaped errno message', () => {
    const msg = "ENOENT: no such file or directory, rename '/old/a.txt' -> '/new/b.txt'";
    assert.strictEqual(describeFsError({ message: msg }), 'ENOENT: no such file or directory');
});

test('leaves a message with no quote untouched', () => {
    assert.strictEqual(describeFsError({ message: 'Timed out (5 min). Make sure Claude Code is authenticated.' }),
        'Timed out (5 min). Make sure Claude Code is authenticated.');
});

test('leaves an unrelated TypeError whose text happens to contain a quote untouched', () => {
    const msg = "Cannot read properties of undefined (reading 'foo')";
    assert.strictEqual(describeFsError({ message: msg }), msg,
        'only Node\'s own errno shape (CODE: reason, syscall \'path\') may be stripped — not any message with a quote in it');
});

test('accepts a plain string, not just an Error object', () => {
    assert.strictEqual(describeFsError('EACCES: permission denied, unlink \'/a/b.wav\''), 'EACCES: permission denied');
});

console.log('describe-fs-error: all checks passed');
