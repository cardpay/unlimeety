'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateReadiness } = require('../update-readiness');
class Window extends EventEmitter {
    constructor() { super(); this.messages = []; this.dead = false; }
    send(channel, value) { this.messages.push({ channel, value }); }
    isDestroyed() { return this.dead; }
}
function setup({ busy = () => null, timeoutMs = 1000 } = {}) {
    const main = new Window(); const notes = new Window();
    const gate = createUpdateReadiness({ busy, participants: () => [main, notes], timeoutMs, token: () => 'fixture-token' });
    return { main, notes, gate };
}
test('busy work blocks before renderer save requests or reservation', async () => {
    for (const reason of ['starting session', 'active session', 'stopping session', 'saving transcript', 'queued job', 'running job', 'model download', 'dirty transcript']) {
        const { gate, main } = setup({ busy: () => reason });
        await assert.rejects(gate.reserve(), new RegExp(reason));
        assert.equal(gate.isReserved(), false); assert.equal(main.messages.length, 0);
    }
});
test('readiness requires both exact senders and the token; reservations recheck main work', async () => {
    let reason;
    const { gate, main, notes } = setup({ busy: () => reason });
    const waiting = gate.reserve();
    assert.equal(gate.isReserved(), true);
    assert.equal(gate.acknowledge(new Window(), { token: 'fixture-token', ok: true }), false);
    assert.equal(gate.acknowledge(main, { token: 'old-token', ok: true }), false);
    gate.acknowledge(main, { token: 'fixture-token', ok: true });
    assert.equal(gate.acknowledge(main, { token: 'fixture-token', ok: true }), false);
    gate.acknowledge(notes, { token: 'fixture-token', ok: true });
    const reservation = await waiting;
    reservation.recheck(); reason = 'new work'; assert.throws(() => reservation.recheck(), /new work/);
    reservation.release(); assert.equal(gate.isReserved(), false);
    assert.equal(notes.messages.at(-1).channel, 'updates:release');
});
test('failed save/draft aborts, unfreezes every window and requires a fresh click', async () => {
    const { gate, main, notes } = setup(); const waiting = gate.reserve();
    gate.acknowledge(main, { token: 'fixture-token', ok: true });
    gate.acknowledge(notes, { token: 'fixture-token', ok: false, error: 'note draft' });
    await assert.rejects(waiting, /note draft/);
    assert.equal(gate.isReserved(), false); assert.equal(main.messages.at(-1).channel, 'updates:release');
    assert.equal(main.listenerCount('destroyed'), 0);
});
test('readiness timeout never returns an install reservation', async () => {
    const { gate } = setup({ timeoutMs: 5 }); await assert.rejects(gate.reserve(), /timed out/);
    assert.equal(gate.isReserved(), false);
});
for (const event of ['destroyed', 'render-process-gone', 'did-start-navigation']) test(`${event} aborts readiness and cleans listeners`, async () => {
    const { gate, main, notes } = setup(); const waiting = gate.reserve(); notes.emit(event);
    await assert.rejects(waiting, /unavailable/); assert.equal(gate.isReserved(), false);
    assert.equal(main.listenerCount('destroyed'), 0);
});
test('renderer loss after acknowledgement invalidates recheck', async () => {
    const { gate, main, notes } = setup(); const waiting = gate.reserve();
    gate.acknowledge(main, { token: 'fixture-token', ok: true }); gate.acknowledge(notes, { token: 'fixture-token', ok: true });
    const reservation = await waiting; notes.emit('render-process-gone');
    assert.throws(() => reservation.recheck(), /unavailable/); reservation.release();
});
test('ordinary quit invalidates a pending reservation without invoking staging', async () => {
    const { gate } = setup(); const waiting = gate.reserve(); gate.abort('ordinary quit');
    await assert.rejects(waiting, /ordinary quit/); assert.equal(gate.isReserved(), false);
});
test('after native commitment renderer loss and quit cannot cancel or unlock; restart is explicit', async () => {
    const { gate, main, notes } = setup(); const waiting = gate.reserve();
    gate.acknowledge(main, { token: 'fixture-token', ok: true }); gate.acknowledge(notes, { token: 'fixture-token', ok: true });
    const reservation = await waiting; reservation.commit();
    main.emit('render-process-gone'); gate.abort('quit');
    assert.equal(gate.isCommitted(), true); assert.equal(gate.isReserved(), true); assert.equal(reservation.signal.aborted, false);
    assert.equal(gate.canRestart(), false); reservation.permitRestart(); assert.equal(gate.canRestart(), true);
    reservation.release(); assert.equal(gate.isReserved(), false);
});
