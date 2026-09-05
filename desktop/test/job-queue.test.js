'use strict';
// node test/job-queue.test.js

const assert = require('assert');
const { createJobQueue } = require('../job-queue');

// A controllable executor: resolves/rejects only when the test tells it to,
// so scheduling order can be asserted without real timers.
function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function makeLane(queue, type) {
    const calls = [];
    const pending = new Map(); // jobId -> deferred
    queue.registerLane(type, {
        run: (job) => {
            calls.push(job.id);
            const d = deferred();
            pending.set(job.id, d);
            return d.promise;
        },
        cancel: (job) => {
            const d = pending.get(job.id);
            if (d) d.resolve({ ok: false, canceled: true });
        },
    });
    return { calls, pending };
}

// Lets every microtask queued by a resolve()/cancel() (settle → emit → drain)
// finish before the next assertion — a plain `await` on that same promise
// isn't enough, since settle()/drain() run in .then() hops *after* it.
function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

function statusOf(queue, jobId) {
    const job = queue.list().find((j) => j.id === jobId);
    return job ? job.status : undefined;
}

async function main() {
    // ─── Lane independence: a busy transcribe lane must not block enhance ────
    {
        const queue = createJobQueue();
        const transcribe = makeLane(queue, 'transcribe');
        const enhance = makeLane(queue, 'enhance');

        const t1 = queue.submit('transcribe', '/a.wav');
        assert.strictEqual(t1.status, 'running');

        const e1 = queue.submit('enhance', '/a.txt');
        assert.strictEqual(e1.status, 'running', 'enhance must start while transcribe is still running');

        transcribe.pending.get(t1.id).resolve({ ok: true });
        enhance.pending.get(e1.id).resolve({ ok: true });
        await flush();
    }

    // ─── Duplicate collapse: same (type, filePath) queued/running is reused ──
    {
        const queue = createJobQueue();
        makeLane(queue, 'enhance');

        const first = queue.submit('enhance', '/a.txt');
        const second = queue.submit('enhance', '/a.txt');
        assert.strictEqual(second.id, first.id, 'duplicate submit must return the existing job');
        assert.strictEqual(queue.list().filter((j) => j.filePath === '/a.txt').length, 1);
    }

    // ─── FIFO within a lane ────────────────────────────────────────────────────
    {
        const queue = createJobQueue();
        const lane = makeLane(queue, 'enhance');

        const j1 = queue.submit('enhance', '/1.txt');
        const j2 = queue.submit('enhance', '/2.txt');
        const j3 = queue.submit('enhance', '/3.txt');
        assert.strictEqual(j1.status, 'running');
        assert.strictEqual(j2.status, 'queued');
        assert.strictEqual(j3.status, 'queued');

        lane.pending.get(j1.id).resolve({ ok: true });
        await flush();
        assert.strictEqual(statusOf(queue, j2.id), 'running');
        assert.strictEqual(statusOf(queue, j3.id), 'queued');

        lane.pending.get(j2.id).resolve({ ok: true });
        await flush();
        assert.strictEqual(statusOf(queue, j3.id), 'running');
        lane.pending.get(j3.id).resolve({ ok: true });
        await flush();

        assert.deepStrictEqual(lane.calls, [j1.id, j2.id, j3.id], 'jobs must run in submission order');
    }

    // ─── Cancel while queued: dropped before it ever runs ─────────────────────
    {
        const queue = createJobQueue();
        const lane = makeLane(queue, 'enhance');

        const j1 = queue.submit('enhance', '/1.txt');
        const j2 = queue.submit('enhance', '/2.txt');
        assert.strictEqual(j2.status, 'queued');

        const ok = queue.cancel(j2.id);
        assert.strictEqual(ok, true);
        assert.strictEqual(queue.list().some((j) => j.id === j2.id), false,
            'a canceled queued job is dropped, not marked');
        assert.strictEqual(lane.calls.includes(j2.id), false, 'a canceled queued job must never run');

        lane.pending.get(j1.id).resolve({ ok: true });
        await flush();
    }

    // ─── Cancel while running: lane's cancel hook fires, job ends canceled ────
    {
        const queue = createJobQueue();
        const lane = makeLane(queue, 'enhance');

        const j1 = queue.submit('enhance', '/1.txt');
        assert.strictEqual(queue.cancel(j1.id), true);
        // The lane's cancel() (registered in makeLane) resolves the pending
        // promise itself, exactly like the real enhance/transcribe/summarize
        // cancel paths do (stdin stop, enhanceCancelled, summarizeAbort).
        await flush();
        assert.strictEqual(statusOf(queue, j1.id), 'canceled');
    }

    // ─── Failure does not stall its lane ──────────────────────────────────────
    {
        const queue = createJobQueue();
        const lane = makeLane(queue, 'enhance');

        const j1 = queue.submit('enhance', '/1.txt');
        const j2 = queue.submit('enhance', '/2.txt');
        lane.pending.get(j1.id).resolve({ ok: false, error: 'model missing' });
        await flush();

        const job1 = queue.list().find((j) => j.id === j1.id);
        assert.strictEqual(job1.status, 'failed');
        assert.strictEqual(job1.error, 'model missing');
        assert.strictEqual(statusOf(queue, j2.id), 'running',
            'the next queued job must start once the failed one settles');

        lane.pending.get(j2.id).resolve({ ok: true });
        await flush();
    }

    // ─── A rejected executor promise also fails without stalling the lane ────
    {
        const queue = createJobQueue();
        const lane = makeLane(queue, 'enhance');

        const j1 = queue.submit('enhance', '/1.txt');
        const j2 = queue.submit('enhance', '/2.txt');
        lane.pending.get(j1.id).reject(new Error('boom'));
        await flush();

        const job1 = queue.list().find((j) => j.id === j1.id);
        assert.strictEqual(job1.status, 'failed');
        assert.strictEqual(job1.error, 'boom');
        assert.strictEqual(statusOf(queue, j2.id), 'running');

        lane.pending.get(j2.id).resolve({ ok: true });
        await flush();
    }

    // ─── list() carries progress updates while running ────────────────────────
    {
        const queue = createJobQueue();
        let capturedUpdate;
        queue.registerLane('enhance', {
            run: (job, update) => {
                capturedUpdate = update;
                return new Promise(() => {}); // never settles in this test
            },
        });
        const j1 = queue.submit('enhance', '/1.txt');
        capturedUpdate({ done: 1, total: 4 });
        const job = queue.list().find((j) => j.id === j1.id);
        assert.deepStrictEqual(job.progress, { done: 1, total: 4 });
    }

    // ─── Cancel racing a genuine success: success wins, job is `done` ─────────
    {
        const queue = createJobQueue();
        const pending = new Map();
        queue.registerLane('enhance', {
            run: (job) => {
                const d = deferred();
                pending.set(job.id, d);
                return d.promise;
            },
            cancel: () => {}, // deliberately does NOT resolve — result wins the race
        });
        const j1 = queue.submit('enhance', '/1.txt');
        assert.strictEqual(queue.cancel(j1.id), true);
        pending.get(j1.id).resolve({ ok: true, content: 'done anyway' });
        await flush();
        assert.strictEqual(statusOf(queue, j1.id), 'done',
            'a genuine ok:true result must win over a cancel that landed just before it');
    }

    // ─── Cancel is idempotent: a second cancel while still stopping is a no-op ─
    {
        const queue = createJobQueue();
        let cancelCalls = 0;
        const pending = new Map();
        queue.registerLane('enhance', {
            run: (job) => {
                const d = deferred();
                pending.set(job.id, d);
                return d.promise;
            },
            cancel: () => { cancelCalls++; },
        });
        const j1 = queue.submit('enhance', '/1.txt');
        assert.strictEqual(queue.cancel(j1.id), true);
        assert.strictEqual(queue.cancel(j1.id), false, 'a second cancel on an already-canceling job is a no-op');
        assert.strictEqual(cancelCalls, 1, "the lane's cancel() must fire only once");
        pending.get(j1.id).resolve({ ok: false, canceled: true });
        await flush();
    }

    // ─── Duplicate collapse merges settings into a still-queued job only ──────
    {
        const queue = createJobQueue();
        const seenExtra = new Map(); // jobId -> extra it was actually run with
        const pending = new Map();
        queue.registerLane('enhance', {
            run: (job) => {
                seenExtra.set(job.id, job.extra);
                const d = deferred();
                pending.set(job.id, d);
                return d.promise;
            },
        });

        const j1 = queue.submit('enhance', '/1.txt'); // running, occupies the lane
        const j2 = queue.submit('enhance', '/2.txt', { title: 'first', extra: { lang: 'en' } }); // queued
        const j2again = queue.submit('enhance', '/2.txt', { title: 'second', extra: { lang: 'ru' } });
        assert.strictEqual(j2again.id, j2.id, 'still-queued duplicate must collapse to the same job');
        assert.strictEqual(queue.list().find((j) => j.id === j2.id).title, 'second',
            'a later submission on a still-queued job must win');

        pending.get(j1.id).resolve({ ok: true });
        await flush();
        assert.deepStrictEqual(seenExtra.get(j2.id), { lang: 'ru' },
            'the executor must run with the newer submission\'s settings, not the first one\'s');

        // Once running, a duplicate submit must NOT rewrite its settings.
        const j2running = queue.submit('enhance', '/2.txt', { title: 'third', extra: { lang: 'de' } });
        assert.strictEqual(j2running.id, j2.id);
        assert.strictEqual(queue.list().find((j) => j.id === j2.id).title, 'second',
            'a duplicate submit on an already-running job must not change its settings');

        pending.get(j2.id).resolve({ ok: true });
        await flush();
    }

    // ─── Dismiss removes a terminal job, but never a queued/running one ───────
    {
        const queue = createJobQueue();
        const lane = makeLane(queue, 'enhance');
        const j1 = queue.submit('enhance', '/1.txt');
        assert.strictEqual(queue.dismiss(j1.id), false, 'a running job cannot be dismissed');
        lane.pending.get(j1.id).resolve({ ok: false, error: 'nope' });
        await flush();
        assert.strictEqual(queue.dismiss(j1.id), true);
        assert.strictEqual(queue.list().some((j) => j.id === j1.id), false);
    }

    // ─── Terminal jobs are capped, but never in the same tick they settle ─────
    {
        const queue = createJobQueue();
        const lane = makeLane(queue, 'enhance');
        let firstId, lastId;
        // Two more than the cap: by the 52nd settle, 51 already-terminal jobs
        // plus this one would be 52 candidates — if the just-settled one
        // weren't excluded, it could be the one evicted before ever being
        // seen at a terminal status.
        for (let i = 0; i < 52; i++) {
            const job = queue.submit('enhance', `/${i}.txt`);
            if (i === 0) firstId = job.id;
            lastId = job.id;
            lane.pending.get(job.id).resolve({ ok: true });
            await flush();
            // The job that JUST settled must always be visible at least once,
            // regardless of how many older terminal jobs are sitting around.
            assert.strictEqual(statusOf(queue, job.id), 'done',
                `job ${i} must not be pruned in the same tick it settles`);
        }
        assert.strictEqual(queue.list().length, 51, 'the cap must trim old terminal jobs once exceeded');
        assert.strictEqual(queue.list().some((j) => j.id === firstId), false, 'the oldest job must be the one trimmed');
        assert.strictEqual(statusOf(queue, lastId), 'done', 'the most recently settled job must survive');
    }

    console.log('job-queue: all checks passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
