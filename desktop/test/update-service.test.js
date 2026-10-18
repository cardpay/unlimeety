'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdateService } = require('../update-service');
const HOUR = 3600000;
function harness(options = {}) {
    let now = 100000000; let seq = 0; const timers = new Map(); const writes = []; const calls = [];
    const clock = { now: () => now, setTimeout: (fn, delay) => { const id = ++seq; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout: (id) => timers.delete(id) };
    const service = createUpdateService({ version: '2.0.0', clock, random: () => 0.5, load: () => ({}), persist: (value) => writes.push({ ...value }),
        discover: async () => { calls.push(now); return { candidate: null }; }, adapter: {}, readiness: {}, ...options });
    async function advance(ms) {
        const target = now + ms;
        while (true) {
            const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            timers.delete(next[0]); now = next[1].at; await next[1].fn();
        }
        now = target;
    }
    return { service, clock, calls, writes, advance, jump: (ms) => { now += ms; }, now: () => now };
}
test('first launch persists uniform 6–10h deadline and checks at 8h midpoint', async () => {
    const h = harness(); h.service.start();
    assert.equal(h.service.scheduleState().nextDue, h.now() + 8 * HOUR);
    await h.advance(8 * HOUR - 1); assert.equal(h.calls.length, 0);
    await h.advance(1); assert.equal(h.calls.length, 1);
    assert.equal(h.service.scheduleState().nextDue, h.now() + 8 * HOUR);
});
test('random delay bounds and empirical mean are eight hours', () => {
    let sum = 0;
    for (let i = 0; i < 1000; i++) {
        const h = harness({ random: () => i / 999 });
        const delay = h.service.scheduleState().nextDue - h.now();
        assert.ok(delay >= 6 * HOUR && delay <= 10 * HOUR); sum += delay;
    }
    assert.ok(Math.abs(sum / 1000 - 8 * HOUR) < 1);
});
test('restart retains future deadline; repeated wakes persist one overdue jitter', async () => {
    const h = harness({ load: () => ({ nextDue: 100000000 + HOUR }) }); h.service.start();
    assert.equal(h.service.scheduleState().nextDue, h.now() + HOUR);
    h.jump(3 * HOUR); h.service.wake(); const due = h.service.scheduleState().recoveryDue;
    h.service.wake(); h.service.wake(); assert.equal(h.service.scheduleState().recoveryDue, due);
    assert.equal(due - h.now(), 150000); await h.advance(150000); assert.equal(h.calls.length, 1);
});
test('manual checks coalesce and retain the scheduled deadline', async () => {
    let finish; let count = 0;
    const h = harness({ discover: () => { count++; return new Promise((resolve) => { finish = resolve; }); } });
    h.service.start(); const due = h.service.scheduleState().nextDue;
    const one = h.service.check(); const two = h.service.check();
    assert.equal(count, 1); finish({ candidate: null }); await Promise.all([one, two]);
    assert.equal(h.service.scheduleState().nextDue, due);
});
test('offline scheduled attempts advance deadlines without automatic retry bursts', async () => {
    let count = 0;
    const h = harness({ discover: async () => { count++; throw new Error('offline'); } }); h.service.start();
    await h.advance(8 * HOUR); assert.equal(count, 1); assert.equal(h.service.snapshot().phase, 'error');
    await h.advance(HOUR); assert.equal(count, 1);
});
test('rate limits persist and manual checks honor the deadline', async () => {
    let count = 0;
    const h = harness({ discover: async () => { count++; const error = new Error('limited'); error.blockedUntil = 100000000 + 12 * HOUR; throw error; } });
    h.service.start(); await h.service.check(); await h.service.check(); assert.equal(count, 1);
    await h.advance(10 * HOUR); assert.equal(count, 1); assert.equal(h.service.scheduleState().blockedUntil, 100000000 + 12 * HOUR);
});
test('backward clock changes reset bounded horizon; stopped scheduler performs no work', async () => {
    const h = harness(); h.service.start(); h.jump(-24 * HOUR); h.service.wake();
    assert.equal(h.service.scheduleState().nextDue - h.now(), 8 * HOUR);
    h.service.stop(); await h.advance(40 * HOUR); assert.equal(h.calls.length, 0);
});
test('forward clock jump recovers with jitter instead of a burst', async () => {
    const h = harness(); h.service.start(); h.jump(24 * HOUR); h.service.wake();
    await h.advance(150000); assert.equal(h.calls.length, 1); await h.advance(HOUR); assert.equal(h.calls.length, 1);
});
test('disk failure pauses automatic schedule with an actionable state', () => {
    const h = harness({ persist: () => { throw new Error('disk full'); } }); h.service.start();
    assert.match(h.service.snapshot().error, /disk full/);
});
test('download and installation are separate actions; readiness failures never stage', async () => {
    const events = []; let fail = true;
    const candidate = { version: '2.0.1' };
    const h = harness({ discover: async () => ({ candidate }), adapter: {
        download: async () => events.push('download'), validate: async () => events.push('validate'), install: async () => events.push('install'),
    }, readiness: { reserve: async () => { events.push('reserve'); if (fail) throw new Error('busy'); return { recheck: () => events.push('recheck'), release: () => events.push('release') }; } } });
    await h.service.check(); assert.deepEqual(events, []);
    await h.service.download(); assert.deepEqual(events, ['download']);
    await h.service.install(); assert.deepEqual(events, ['download', 'reserve']); assert.match(h.service.snapshot().error, /busy/);
    fail = false; await h.service.install(); assert.deepEqual(events.slice(2), ['reserve', 'validate', 'recheck', 'install']);
    h.service.shutdown(); assert.equal(events.at(-1), 'release');
});
test('new work after readiness or cache validation failure prevents staging', async () => {
    for (const failure of ['validation', 'race']) {
        let staged = 0; let released = 0;
        const h = harness({ discover: async () => ({ candidate: { version: '2.0.1' } }), adapter: {
            download: async () => {}, validate: async () => { if (failure === 'validation') throw new Error('corrupt'); }, install: async () => staged++,
        }, readiness: { reserve: async () => ({ recheck: () => { if (failure === 'race') throw new Error('work started'); }, release: () => released++ }) } });
        await h.service.check(); await h.service.download(); await h.service.install();
        assert.equal(staged, 0); assert.equal(released, 1);
    }
});
test('failed/interrupted downloads support retry without automatic installation', async () => {
    let tries = 0;
    const h = harness({ discover: async () => ({ candidate: { version: '2.0.1' } }), adapter: { download: async () => { if (++tries === 1) throw new Error('interrupted'); } } });
    await h.service.check(); await h.service.download(); assert.equal(h.service.snapshot().phase, 'error');
    await h.service.download(); assert.equal(h.service.snapshot().phase, 'downloaded'); assert.equal(tries, 2);
});

test('download cache validation failure exposes a retry-download state instead of an unusable install loop', async () => {
    const h = harness({ discover: async () => ({ candidate: { version: '2.0.1' } }), adapter: {
        download: async () => {}, validate: async () => { const error = new Error('cache corrupt'); error.requiresDownload = true; throw error; },
    }, readiness: { reserve: async () => ({ recheck() {}, release() {} }) } });
    await h.service.check(); await h.service.download(); await h.service.install();
    assert.equal(h.service.snapshot().phase, 'error'); assert.equal(h.service.snapshot().downloadedVersion, null);
    assert.equal(h.service.snapshot().availableVersion, '2.0.1');
});
test('invalid persisted state recovers without crashing first launch', () => {
    for (const value of [null, {}, { nextDue: Infinity, blockedUntil: NaN }]) {
        const h = harness({ load: () => value }); h.service.start();
        assert.equal(h.service.scheduleState().nextDue, h.now() + 8 * HOUR);
    }
});
test('backward clock jump translates persisted server suppression to a bounded remaining interval', async () => {
    const h = harness({ load: () => ({ nextDue: 100000000 + 8 * HOUR, lastWall: 100000000, blockedUntil: 100000000 + 2 * HOUR }) });
    h.jump(-72 * HOUR); h.service.start();
    assert.equal(h.service.scheduleState().blockedUntil - h.now(), 2 * HOUR);
    await h.advance(8 * HOUR); assert.equal(h.calls.length, 1);
});
test('downloaded candidate relationship persists and restores readiness by validation only', async () => {
    const candidate = { version: '2.0.1' }; let downloads = 0, stages = 0, restores = 0;
    const record = { candidate, file: '/fixture/cached.zip' };
    const first = harness({ discover: async () => ({ candidate }), adapter: { download: async () => downloads++, cacheRecord: () => record } });
    first.service.start(); await first.service.check(); await first.service.download();
    const saved = first.writes.at(-1); assert.deepEqual(saved.cache, record);
    const next = harness({ load: () => saved, adapter: { restore: async (value) => { restores++; assert.deepEqual(value, record); return candidate; }, download: async () => downloads++, install: async () => stages++ } });
    await next.service.start(); assert.equal(next.service.snapshot().phase, 'downloaded');
    assert.equal(restores, 1); assert.equal(downloads, 1); assert.equal(stages, 0);
    const corrupt = harness({ load: () => saved, adapter: { restore: async () => { throw new Error('signature invalid'); } } });
    await corrupt.service.start(); assert.equal(corrupt.service.snapshot().phase, 'error'); assert.equal(corrupt.service.snapshot().downloadedVersion, undefined);
    assert.equal(corrupt.writes.at(-1).cache, null);
});
test('native commitment keeps reservation on a delayed terminal event; only terminal errors release', async () => {
    let finish, waiting, releases = 0, commits = 0;
    const h = harness({ discover: async () => ({ candidate: { version: '2.0.1' } }), adapter: {
        download: async () => {}, validate: async () => {}, install: (_candidate, callbacks) => { waiting = callbacks.onWaiting; return new Promise((resolve) => { finish = resolve; }); },
    }, readiness: { reserve: async () => ({ recheck() {}, commit() { commits++; }, release() { releases++; } }) } });
    await h.service.check(); await h.service.download(); const install = h.service.install();
    await new Promise((resolve) => setImmediate(resolve)); waiting('still staging');
    assert.equal(commits, 1); assert.equal(releases, 0); assert.equal(h.service.snapshot().phase, 'installing');
    await h.service.install(); assert.equal(releases, 0); finish(); await install; assert.equal(releases, 0);
    h.service.stop(); assert.equal(releases, 0);
    h.service.shutdown(); assert.equal(releases, 1);
});
test('successful native restart return and restart throw retain the reservation until confirmed shutdown', async () => {
    for (const throws of [false, true]) {
        let releases = 0, installs = 0;
        const h = harness({ discover: async () => ({ candidate: { version: '2.0.1' } }), adapter: {
            download: async () => {}, validate: async () => {}, install: async () => { installs++; if (throws) { const error = new Error('restart failed'); error.nativeCommitted = true; throw error; } },
        }, readiness: { reserve: async () => ({ recheck() {}, commit() {}, release() { releases++; } }) } });
        await h.service.check(); await h.service.download(); await h.service.install();
        assert.equal(releases, 0); assert.equal(h.service.snapshot().phase, 'installing');
        await h.service.install(); assert.equal(installs, 1); h.service.stop(); assert.equal(releases, 0);
        h.service.shutdown(); assert.equal(releases, 1);
    }
});
test('terminal native unavailability releases the reservation and requires another explicit download', async () => {
    let releases = 0;
    const h = harness({ discover: async () => ({ candidate: { version: '2.0.1' } }), adapter: {
        download: async () => {}, validate: async () => {}, install: async () => { const error = new Error('native unavailable'); error.requiresDownload = true; throw error; },
    }, readiness: { reserve: async () => ({ recheck() {}, release() { releases++; } }) } });
    await h.service.check(); await h.service.download(); await h.service.install();
    assert.equal(releases, 1); assert.equal(h.service.snapshot().phase, 'error'); assert.equal(h.service.snapshot().downloadedVersion, null);
});
test('a successful manual retry after a transient persistence failure rearms automatic checks', async () => {
    let diskFails = true;
    const h = harness({ persist: () => { if (diskFails) throw new Error('disk full'); } });
    h.service.start(); assert.equal(h.service.snapshot().automaticChecksPaused, true);
    diskFails = false; await h.service.check(); assert.equal(h.service.snapshot().automaticChecksPaused, false);
    assert.equal(h.service.snapshot().phase, 'current'); await h.advance(8 * HOUR); assert.equal(h.calls.length, 2);
});
