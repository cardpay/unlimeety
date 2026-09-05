'use strict';
// node test/fatal-error-quit.test.js
//
// spec-robustness-config-writes.md: an uncaught exception or an unhandled
// rejection used to crash the process outright, skipping every before-quit
// flush and losing an in-flight Live/Record session. handleFatalError routes
// both through app.quit() instead, re-entering the existing flush — guarded
// by fatalErrorHandled so a second fatal error during that same flush is a
// no-op rather than calling app.quit() twice. Flagged by review as having
// zero test coverage despite backing the spec's own acceptance criterion
// ("app.quit() is invoked exactly once").
//
// main.js requires electron and cannot be required directly, so
// fatalErrorHandled/handleFatalError are sliced out by name and evaluated
// with `new Function`, closing over stub app/process/console/setTimeout —
// same technique as test/config-persistence.test.js. Deliberately NOT sliced
// together with the two process.on(...) registrations that follow it in
// main.js: executing those against a real `process` would attach real
// uncaughtException/unhandledRejection listeners to THIS test run.

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

const fatalErrorHandledDecl = 'let fatalErrorHandled = false;';
assert.ok(MAIN.includes(`\n${fatalErrorHandledDecl}\n`), 'fatalErrorHandled declaration not found in main.js — renamed or moved?');

function makeSandbox(quitFlushTimeoutMs) {
    const src = [fatalErrorHandledDecl, sliceFunction('handleFatalError')].join('\n');
    const quitCalls = [];
    const timers = []; // { fn, ms }
    const factory = new Function(
        'app', 'process', 'console', 'QUIT_FLUSH_TIMEOUT_MS', 'setTimeout',
        `${src}\nreturn { handleFatalError, get fatalErrorHandled() { return fatalErrorHandled; } };`,
    );
    const app = { quit: () => quitCalls.push(Date.now()) };
    const stubProcess = { exit: () => {} }; // only ever reached from an uncalled setTimeout callback below
    const fakeSetTimeout = (fn, ms) => {
        const handle = { fn, ms, unref: () => handle };
        timers.push(handle);
        return handle;
    };
    const box = factory(app, stubProcess, { error: () => {} }, quitFlushTimeoutMs, fakeSetTimeout);
    box.quitCalls = quitCalls;
    box.timers = timers;
    return box;
}

test('the first fatal error calls app.quit() exactly once', () => {
    const box = makeSandbox(10000);
    box.handleFatalError(new Error('boom'));
    assert.strictEqual(box.quitCalls.length, 1);
    assert.strictEqual(box.fatalErrorHandled, true);
});

test('a second fatal error while already quitting is a no-op — app.quit() is not called again', () => {
    const box = makeSandbox(10000);
    box.handleFatalError(new Error('first'));
    box.handleFatalError(new Error('second'));
    assert.strictEqual(box.quitCalls.length, 1, 'a second fatal error must not call app.quit() again');
});

test('handleFatalError schedules a process.exit backstop past QUIT_FLUSH_TIMEOUT_MS, unref\'d', () => {
    const box = makeSandbox(10000);
    box.handleFatalError(new Error('boom'));
    assert.strictEqual(box.timers.length, 1, 'exactly one backstop timer must be scheduled');
    assert.ok(box.timers[0].ms > 10000, 'the backstop must fire after the flush\'s own timeout, not before it');
});

test('accepts a plain (non-Error) rejection reason without throwing', () => {
    const box = makeSandbox(10000);
    assert.doesNotThrow(() => box.handleFatalError('a rejected string reason'));
    assert.strictEqual(box.quitCalls.length, 1);
});

console.log('fatal-error-quit: all checks passed');
