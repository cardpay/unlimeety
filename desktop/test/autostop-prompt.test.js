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
