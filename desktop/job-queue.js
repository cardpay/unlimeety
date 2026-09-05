'use strict';

// Pure scheduling logic for every long-running job (transcribe / enhance /
// summarize) — no Electron, no filesystem, no child processes. main.js wires
// real executors in via registerLane(); this module only decides *when* each
// one runs and tracks the result.
//
// One lane per resource (transcribe = the WhisperKit helper, enhance/summarize
// = their provider call), each running at most one job at a time, independent
// of every other lane. Submitting always creates or reuses a job — never
// rejects — so "busy" only ever shows up as a job sitting in `queued`.

let seq = 0;

// ponytail: simple count cap on settled jobs, not age-based or per-type —
// bump (or add age eviction) if the panel ever needs longer history.
const MAX_TERMINAL_JOBS = 50;

function createJobQueue() {
    const jobs = new Map();   // id -> internal job record
    const lanes = new Map();  // type -> { run, cancel, queue: [id], current: id|null }
    const listeners = new Set();

    function lane(type) {
        let l = lanes.get(type);
        if (!l) {
            l = { run: null, cancel: null, queue: [], current: null };
            lanes.set(type, l);
        }
        return l;
    }

    function toPublic(job) {
        return {
            id: job.id,
            type: job.type,
            filePath: job.filePath,
            title: job.title,
            status: job.status,
            progress: job.progress,
            error: job.error,
            result: job.result,
            createdAt: job.createdAt,
            // Still `status: 'running'` until the executor's promise actually
            // settles — this is what lets a panel say "Stopping…" instead of
            // looking like the click did nothing.
            canceling: job.canceling,
        };
    }

    function list() {
        return Array.from(jobs.values())
            .sort((a, b) => a.createdAt - b.createdAt)
            .map(toPublic);
    }

    function emit() {
        const snapshot = list();
        for (const fn of listeners) fn(snapshot);
    }

    function onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    // `run(job, updateProgress)` does the actual work and resolves with the
    // executor's own `{ok, ...}` result. `cancel(job)` only has to kick the
    // in-flight work off (write stdin, flip a flag, abort a controller) —
    // the queue itself waits for `run`'s promise to settle either way.
    function registerLane(type, { run, cancel } = {}) {
        const l = lane(type);
        l.run = run;
        l.cancel = cancel || null;
    }

    function findActiveDuplicate(type, filePath) {
        for (const job of jobs.values()) {
            if (job.type === type && job.filePath === filePath
                && (job.status === 'queued' || job.status === 'running')) {
                return job;
            }
        }
        return null;
    }

    function submit(type, filePath, opts = {}) {
        const existing = findActiveDuplicate(type, filePath);
        if (existing) {
            // A later submission — e.g. a manual transcribe with different
            // settings landing on a file an auto-queued job already claimed —
            // should win as long as the existing one hasn't started running
            // yet. Once it's running, its executor already has the old
            // settings in hand; leave it alone.
            if (existing.status === 'queued') {
                existing.title = opts.title || existing.title;
                existing.extra = opts.extra;
            }
            return toPublic(existing);
        }

        const job = {
            id: `${type}_${++seq}`,
            type,
            filePath,
            title: opts.title || filePath,
            extra: opts.extra,
            status: 'queued',
            progress: null,
            error: null,
            result: null,
            canceling: false,
            createdAt: Date.now(),
        };
        jobs.set(job.id, job);
        lane(type).queue.push(job.id);
        emit();
        drain(type);
        return toPublic(job);
    }

    function updateProgress(jobId, progress) {
        const job = jobs.get(jobId);
        if (!job || job.status !== 'running') return;
        job.progress = progress;
        emit();
    }

    function drain(type) {
        const l = lane(type);
        if (l.current) return; // lane already busy
        let nextId;
        while ((nextId = l.queue.shift())) {
            const job = jobs.get(nextId);
            if (job && job.status === 'queued') { runJob(l, job); return; }
            // Stale id (its job was dropped by cancel()) — keep looking.
        }
    }

    function settle(job, result, err) {
        if (err) {
            job.status = job.canceling ? 'canceled' : 'failed';
            job.error = err.message || String(err);
            job.result = null;
            return;
        }
        // A genuine success wins even if cancel() landed just before the
        // executor resolved — the work actually completed, so it's `done`,
        // not `canceled`, regardless of the race.
        if (result && result.ok === true) {
            job.status = 'done';
            job.error = null;
            job.result = result;
            return;
        }
        if (job.canceling) {
            job.status = 'canceled';
            job.error = (result && result.error) || job.error;
            job.result = result || null;
            return;
        }
        job.status = 'failed';
        job.error = (result && result.error) || 'Job failed.';
        job.result = result || null;
    }

    // Terminal jobs stay around so the panel can show recent history, but not
    // forever — trim the oldest ones once the count grows past the cap.
    // Queued/running jobs are never touched here. `justSettledId` is always
    // excluded: `createdAt` is submit time, not settle time, so a job that
    // sat queued for a long time can look "oldest" the instant it finally
    // finishes — pruning it away in the same tick it settles would ship a
    // broadcast where it never appears with a terminal status at all, and a
    // renderer watching for that job's result (e.g. app.js's pendingEnhance/
    // pendingSummarize) would see it vanish instead, indistinguishable from
    // a cancel-while-queued.
    function pruneTerminal(justSettledId) {
        const terminal = [];
        for (const job of jobs.values()) {
            if (job.id === justSettledId) continue;
            if (job.status !== 'queued' && job.status !== 'running') terminal.push(job);
        }
        const excess = terminal.length - MAX_TERMINAL_JOBS;
        if (excess <= 0) return;
        terminal.sort((a, b) => a.createdAt - b.createdAt);
        for (let i = 0; i < excess; i++) jobs.delete(terminal[i].id);
    }

    function runJob(l, job) {
        l.current = job.id;
        job.status = 'running';
        emit();

        if (typeof l.run !== 'function') {
            settle(job, null, new Error(`No executor registered for "${job.type}" jobs.`));
            l.current = null;
            pruneTerminal(job.id);
            emit();
            drain(job.type);
            return;
        }

        // Called synchronously (not deferred to a microtask) so the executor's
        // own setup — e.g. spawning the helper process — has already happened
        // by the time submit() returns, exactly like the direct calls it replaces.
        let resultPromise;
        try {
            resultPromise = Promise.resolve(l.run(job, (progress) => updateProgress(job.id, progress)));
        } catch (err) {
            resultPromise = Promise.reject(err);
        }
        resultPromise
            .then((result) => settle(job, result, null))
            .catch((err) => settle(job, null, err))
            .then(() => {
                l.current = null;
                pruneTerminal(job.id);
                emit();
                drain(job.type);
            });
    }

    function cancel(jobId) {
        const job = jobs.get(jobId);
        if (!job) return false;
        if (job.status === 'queued') {
            const l = lane(job.type);
            l.queue = l.queue.filter((id) => id !== jobId);
            jobs.delete(jobId);
            emit();
            return true;
        }
        if (job.status === 'running') {
            if (job.canceling) return false; // already stopping — don't invoke the lane's cancel twice
            job.canceling = true;
            const l = lane(job.type);
            if (typeof l.cancel === 'function') l.cancel(job);
            emit();
            return true;
        }
        return false;
    }

    // Explicit removal of a terminal (done/failed/canceled) row — the
    // panel's per-row "Dismiss". A no-op on a still-active job; use cancel()
    // for that.
    function dismiss(jobId) {
        const job = jobs.get(jobId);
        if (!job || job.status === 'queued' || job.status === 'running') return false;
        jobs.delete(jobId);
        emit();
        return true;
    }

    return { submit, cancel, dismiss, list, onChange, registerLane };
}

module.exports = { createJobQueue };
