'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const prompt = fs.readFileSync(path.join(__dirname, '..', 'renderer/prompt/prompt.js'), 'utf8');
const HOUR = 3600000;

function harness() {
    let now = 0, nextId = 0;
    const timers = new Map(), handlers = {}, shown = [], stopped = [];
    const ctx = vm.createContext({
        Date: { now: () => now }, live: { proc: {} }, recorder: { proc: {} },
        autoStopTimer: null, autoStopSlot: null, promptWindow: null,
        callMonitor: { cooldownUntil: 123 },
        setInterval(fn, ms) { assert.equal(ms, HOUR); timers.set(++nextId, fn); return nextId; },
        clearInterval(id) { timers.delete(id); }, clearTimeout() {},
        showPromptWindow(data) { ctx.promptWindow = {}; shown.push(data); },
        triggerAutoStop(slots) { stopped.push(...slots); },
        cancelAutoStop() { throw new Error('Reminder must not cancel auto-stop'); },
        ipcMain: { on(channel, fn) { handlers[channel] = fn; } },
    });
    vm.runInContext(`
        ${main.slice(main.indexOf('// Hourly reminders belong'), main.indexOf('// ─── Auto-stop when'))}
        function closePromptWindow() { promptWindow = null; recordingReminderSlot = null; }
        ${main.slice(main.indexOf("ipcMain.on('prompt:keepRecording'"), main.indexOf('// "✕" — hide'))}
        ${main.slice(main.indexOf('function closeCallPrompt()'), main.indexOf("ipcMain.on('prompt:record'"))}
    `, ctx);
    return { ctx, timers, handlers, shown, stopped,
        run: code => vm.runInContext(code, ctx),
        tick() { now += HOUR; for (const fn of [...timers.values()]) fn(); },
    };
}

test('hourly reminders repeat after Not now without stopping or suppressing call detection', () => {
    const h = harness();
    h.run("startRecordingReminder('record')");
    assert.equal(h.shown.length, 0);
    h.tick();
    assert.equal(h.shown[0].mode, 'reminder');
    assert.equal(h.shown[0].elapsedMs, HOUR);
    h.handlers['prompt:keepRecording']();
    assert.equal(h.ctx.promptWindow, null);
    assert.ok(h.ctx.recorder.proc);
    assert.deepEqual(h.stopped, []);
    assert.equal(h.ctx.callMonitor.cooldownUntil, 123);
    h.tick();
    assert.equal(h.shown[1].elapsedMs, 2 * HOUR);
});

test('Stop now targets only the reminder session with concurrent capture', () => {
    const h = harness();
    h.run("startRecordingReminder('live'); startRecordingReminder('record')");
    h.tick();
    assert.equal(h.shown.length, 1);
    h.handlers['prompt:stopNow']();
    assert.deepEqual(h.stopped, ['live']);
    assert.equal(h.ctx.promptWindow, null);
});

test('unanswered reminder stays visible through later hours and micInactive', () => {
    const h = harness();
    h.run("startRecordingReminder('record')");
    h.tick();
    h.run('closeCallPrompt()');
    assert.ok(h.ctx.promptWindow);
    h.tick();
    assert.equal(h.shown.length, 1);
    assert.deepEqual(h.stopped, []);
});

test('meeting-end countdown takes priority over reminders', () => {
    const h = harness();
    h.run("startRecordingReminder('record')");
    h.ctx.autoStopTimer = 42;
    h.tick();
    assert.equal(h.shown.length, 0);
    h.ctx.autoStopTimer = null;
    h.tick();
    assert.equal(h.shown[0].elapsedMs, 2 * HOUR);
});

test('stop, helper replacement and restart clear old clocks and stale prompts', () => {
    const h = harness();
    h.run("startRecordingReminder('record')"); h.tick();
    h.run("cancelRecordingReminder('live')");
    assert.ok(h.ctx.promptWindow);
    h.run("cancelRecordingReminder('record')");
    assert.equal(h.ctx.promptWindow, null);
    assert.equal(h.timers.size, 0);
    h.run("startRecordingReminder('record'); startRecordingReminder('record')");
    assert.equal(h.timers.size, 1);
    h.tick();
    assert.equal(h.shown[1].elapsedMs, HOUR);
    h.ctx.recorder.proc = {};
    h.tick();
    assert.equal(h.timers.size, 0);
    assert.equal(h.ctx.promptWindow, null);
});

test('both event handlers start reminders on actual audio capture', () => {
    for (const [name, slot] of [['liveHandleEvent', 'live'], ['recordHandleEvent', 'record']]) {
        const start = main.indexOf(`function ${name}(`);
        const events = [];
        const ctx = vm.createContext({ Date, live: { segments: [] }, recorder: {},
            startRecordingReminder: value => events.push(value),
            liveSendToRenderer() {}, recordSendToRenderer() {},
        });
        vm.runInContext(main.slice(start, main.indexOf('\nfunction ', start + 1)), ctx);
        ctx[name]({ type: 'loaded' });
        assert.deepEqual(events, []);
        ctx[name]({ type: 'recording' });
        assert.deepEqual(events, [slot]);
    }
});

test('renderer shows elapsed duration and exactly two actions without countdown', () => {
    const elements = new Map(), calls = [];
    let onData;
    const ctx = vm.createContext({
        document: { getElementById(id) {
            const el = { style: {}, textContent: '', classList: { add() {}, remove() {} },
                addEventListener(event, fn) { this[event] = fn; } };
            elements.set(id, el); return el;
        } },
        window: { promptApi: { onData(fn) { onData = fn; },
            stopNow() { calls.push('stop'); }, keepRecording() { calls.push('keep'); } } },
        setInterval() { throw new Error('No countdown allowed'); }, clearInterval() {},
    });
    vm.runInContext(prompt, ctx);
    onData({ mode: 'reminder', elapsedMs: 2 * HOUR + 5 * 60000 });
    assert.equal(elements.get('title').textContent, 'Recording has been running for 2h 5m');
    assert.equal(elements.get('subtitle').textContent, 'Would you like to stop recording?');
    assert.equal(elements.get('keep-btn').textContent, 'Not now');
    assert.deepEqual([...elements].filter(([id, el]) => id.endsWith('-btn') && el.style.display !== 'none').map(([id]) => id), ['keep-btn', 'stop-btn']);
    elements.get('keep-btn').click(); elements.get('stop-btn').click();
    assert.deepEqual(calls, ['keep', 'stop']);
});
