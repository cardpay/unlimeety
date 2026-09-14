'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function sliceCall(marker) {
    const start = MAIN.indexOf(marker);
    assert.notStrictEqual(start, -1, `${marker} not found`);
    const paren = MAIN.indexOf('(', start);
    let depth = 0;
    for (let i = paren; i < MAIN.length; i++) {
        if (MAIN[i] === '(') depth++;
        else if (MAIN[i] === ')' && --depth === 0) return MAIN.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${marker}`);
}

function sliceFunction(name) {
    const start = MAIN.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `${name} not found`);
    const brace = MAIN.indexOf('{', start);
    let depth = 0;
    for (let i = brace; i < MAIN.length; i++) {
        if (MAIN[i] === '{') depth++;
        else if (MAIN[i] === '}' && --depth === 0) return MAIN.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

test('Stop now leaves the next call-detect prompt unsuppressed', () => {
    const source = sliceCall("ipcMain.on('prompt:stopNow'");
    const cleared = [];
    const triggered = [];
    let closed = 0;
    let handler;
    const callMonitor = { cooldownUntil: 123 };
    const run = new Function('clearTimeout', 'closePromptWindow', 'triggerAutoStop', 'callMonitor', `
        let handler;
        const ipcMain = { on: (_channel, fn) => { handler = fn; } };
        let autoStopTimer = 42;
        let autoStopSlot = 'live';
        ${source};
        handler();
        return { autoStopTimer, autoStopSlot };
    `);

    const state = run(
        (timer) => cleared.push(timer),
        () => { closed++; },
        (slots) => triggered.push(slots),
        callMonitor,
    );

    assert.deepStrictEqual(cleared, [42]);
    assert.strictEqual(closed, 1);
    assert.deepStrictEqual(triggered, [['live']]);
    assert.deepStrictEqual(state, { autoStopTimer: null, autoStopSlot: null });
    assert.strictEqual(callMonitor.cooldownUntil, 123);
});

test('unattended auto-stop uses ten seconds and leaves call detection unsuppressed', () => {
    const source = sliceFunction('onMeetingEnded');
    const prompts = [];
    const triggered = [];
    const timer = {};
    const callMonitor = { cooldownUntil: 123 };
    const run = new Function('showPromptWindow', 'setTimeout', 'closePromptWindow', 'triggerAutoStop', 'live', 'recorder', 'callMonitor', 'timer', `
        const AUTOSTOP_COUNTDOWN_SEC = 10;
        let autoStopTimer = null;
        let autoStopSlot = null;
        ${source}
        onMeetingEnded('live');
        timer.callback();
        return { autoStopTimer, autoStopSlot };
    `);

    const state = run(
        (prompt) => prompts.push(prompt),
        (fn, ms) => { timer.callback = fn; timer.delay = ms; return 42; },
        () => {},
        (slots) => triggered.push(slots),
        { proc: {} },
        { proc: null },
        callMonitor,
        timer,
    );

    assert.deepStrictEqual(prompts, [{ mode: 'autostop', seconds: 10 }]);
    assert.strictEqual(timer.delay, 10_000);
    assert.deepStrictEqual(triggered, [['live']]);
    assert.deepStrictEqual(state, { autoStopTimer: null, autoStopSlot: null });
    assert.strictEqual(callMonitor.cooldownUntil, 123);
});
