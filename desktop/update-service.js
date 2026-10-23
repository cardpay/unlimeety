'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { channelOf } = require('./update-provider');
const { budget, checkAbort, clampRetryDeadline } = require('./update-bounds');
const HOUR = 3600000;
const MAX_TIMER = 60000; // Re-evaluate wall time so clock changes cannot strand a timer.
function atomicState(file, state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomBytes(16).toString('hex')}.tmp`;
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, file);
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
}
function createUpdateService({ version, statePath, discover, adapter, readiness,
    clock = { now: Date.now, setTimeout, clearTimeout }, random = Math.random,
    load = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; } },
    persist = (value) => atomicState(statePath, value), onStatus = () => {} }) {
    let saved = load();
    if (!saved || typeof saved !== 'object') saved = {};
    let due = (Number.isFinite(saved.nextDue) && saved.nextDue > 0 ? saved.nextDue : 0) || clock.now() + interval();
    let blockedUntil = clampRetryDeadline(saved.blockedUntil, clock.now());
    let recoveryDue = (Number.isFinite(saved.recoveryDue) && saved.recoveryDue > 0 ? saved.recoveryDue : 0);
    let timer, stopped = true, enabled = false, persistenceFailed = false, committedReservation = null, checking, downloading, installing = false;
    let candidate = null;
    let cache = saved.cache || null;
    let restoring;
    let previousWall = Number.isFinite(saved.lastWall) ? saved.lastWall : clock.now();
    let status = { version, channel: channelOf(version), phase: 'idle', error: null, availableVersion: null };
    function interval() { return (6 + 4 * random()) * HOUR; }
    function write() {
        try {
            persist({ nextDue: due, blockedUntil, recoveryDue, lastWall: clock.now(), cache });
            if (persistenceFailed) { persistenceFailed = false; stopped = !enabled; }
            status = { ...status, automaticChecksPaused: false };
            return true;
        } catch (error) {
            persistenceFailed = true; stopped = true; clock.clearTimeout(timer);
            emit({ phase: 'error', automaticChecksPaused: true, error: `Could not save the update schedule: ${error.message}. Automatic checks are paused; retry after restoring write access.` });
            return false;
        }
    }
    function emit(patch) { status = { ...status, ...patch }; onStatus({ ...status }); }
    function schedule(overdue = false) {
        clock.clearTimeout(timer);
        if (stopped) return;
        const now = clock.now();
        if (now < previousWall) {
            const shift = previousWall - now;
            // Retry deadlines track remaining duration across backwards jumps.
            if (blockedUntil) blockedUntil = clampRetryDeadline(Math.max(now, blockedUntil - shift), now);
            if (recoveryDue) recoveryDue = Math.max(now, recoveryDue - shift);
            due -= shift;
            write();
        }
        previousWall = now;
        // A backwards clock jump has a bounded 10-hour recovery horizon.
        if (due > now + 10 * HOUR) { due = now + interval(); recoveryDue = 0; write(); }
        if (overdue && due <= now && !recoveryDue) { recoveryDue = now + random() * 300000; write(); }
        const target = Math.max(recoveryDue || due, blockedUntil);
        timer = clock.setTimeout(tick, (downloading || installing) && target <= now ? MAX_TIMER : Math.min(MAX_TIMER, Math.max(1, target - now)));
        timer?.unref?.();
    }
    async function tick() {
        if (stopped) return;
        if (!recoveryDue && due < clock.now() - MAX_TIMER) { schedule(true); return; }
        if (clock.now() >= Math.max(recoveryDue || due, blockedUntil)) await check(true);
        schedule();
    }
    async function check(scheduled = false) {
        if (restoring) await restoring;
        if (checking) {
            if (scheduled) { await checking; due = clock.now() + interval(); recoveryDue = 0; write(); schedule(); }
            return checking || { ...status };
        }
        if (downloading || installing) return { ...status };
        if (clock.now() < blockedUntil) { emit({ error: `Update checks are limited until ${new Date(blockedUntil).toISOString()}.`, retryAt: blockedUntil }); return { ...status }; }
        checking = (async () => {
            emit({ phase: 'checking', error: null, retryAt: null });
            try {
                const result = await discover(version);
                blockedUntil = clampRetryDeadline(Math.max(blockedUntil, result.blockedUntil || 0), clock.now());
                // Preserve a downloaded candidate on a repeat check.
                if (status.downloadedVersion && candidate && result.candidate && ['version', 'channel', 'url', 'sha512', 'size', 'minimumSystemVersion'].every((key) => result.candidate[key] === candidate[key])) emit({ phase: 'downloaded' });
                else {
                    candidate = result.candidate;
                    adapter.clear?.(); cache = null;
                    emit({ phase: candidate ? 'available' : 'current', availableVersion: candidate?.version || null, downloadedVersion: null, progress: null });
                }
            } catch (error) {
                blockedUntil = clampRetryDeadline(Math.max(blockedUntil, error.blockedUntil || 0), clock.now());
                if (!status.downloadedVersion) { candidate = null; emit({ availableVersion: null }); }
                emit({ phase: 'error', error: error.message, retryAt: blockedUntil > clock.now() ? blockedUntil : null });
            } finally {
                if (scheduled) { due = clock.now() + interval(); recoveryDue = 0; }
                write(); checking = null; schedule();
            }
            return { ...status };
        })();
        return checking;
    }
    async function download() {
        if (restoring) await restoring;
        if (downloading) return downloading;
        if (checking || installing || !candidate) return { ...status };
        if (clock.now() < blockedUntil) { emit({ error: 'The update server is rate limited. Retry after its deadline.', retryAt: blockedUntil }); return { ...status }; }
        downloading = (async () => {
            emit({ phase: 'downloading', error: null, progress: 0 });
            try {
                const result = await adapter.download(candidate, (percent) => emit({ progress: Math.max(0, Math.min(100, percent)) }));
                blockedUntil = clampRetryDeadline(Math.max(blockedUntil, result?.blockedUntil || 0), clock.now());
                cache = adapter.cacheRecord?.() || null; write();
                emit({ phase: 'downloaded', downloadedVersion: candidate.version, progress: 100 });
            } catch (error) { blockedUntil = clampRetryDeadline(Math.max(blockedUntil, error.blockedUntil || 0), clock.now()); write(); emit({ phase: 'error', downloadedVersion: null, error: error.message, retryAt: blockedUntil > clock.now() ? blockedUntil : null }); }
            finally { downloading = null; schedule(true); }
            return { ...status };
        })();
        return downloading;
    }
    async function install() {
        if (restoring) await restoring;
        if (installing || downloading || checking || !candidate || status.downloadedVersion !== candidate.version) return { ...status };
        installing = true;
        let reservation, hold = false;
        const scope = budget(120000);
        try {
            emit({ phase: 'preparing', error: null });
            reservation = await readiness.reserve();
            // The readiness signal aborts when a renderer is lost or quit starts.
            scope.follow(reservation.signal);
            const signal = scope.signal;
            if (adapter.prepare) await adapter.prepare(candidate, { signal });
            else await adapter.validate(candidate, { signal });
            checkAbort(signal); reservation.recheck();
            scope.close();
            reservation.commit?.();
            emit({ phase: 'installing' });
            await adapter.install(candidate, {
                onRestart: () => reservation.permitRestart?.(),
                onWaiting: (error) => emit({ phase: 'installing', error }),
            });
            // A returned restart request is not proof that the process exited.
            hold = true; committedReservation = reservation;
        } catch (error) {
            hold = error.nativeCommitted === true;
            if (hold) committedReservation = reservation;
            if (error.requiresDownload) { cache = null; write(); }
            emit({ phase: hold ? 'installing' : error.requiresDownload ? 'error' : 'downloaded', downloadedVersion: error.requiresDownload ? null : status.downloadedVersion, error: error.message });
        } finally {
            scope.close();
            if (!hold) { installing = false; reservation?.release(); }
        }
        return { ...status };
    }
    async function restore() {
        if (!cache || !adapter.restore) return;
        emit({ phase: 'checking', error: null, retryAt: null });
        try {
            candidate = await adapter.restore(cache);
            if (!candidate) { cache = null; emit({ phase: 'idle' }); return; }
            emit({ phase: 'downloaded', availableVersion: candidate.version, downloadedVersion: candidate.version, progress: 100 });
        } catch (error) { candidate = null; cache = null; emit({ phase: 'error', error: `The cached update could not be verified. Check and download again: ${error.message}` }); }
        finally { write(); }
    }
    function start() { enabled = true; stopped = false; if (cache && adapter.restore) restoring = restore().finally(() => { restoring = null; }); write(); schedule(true); return restoring; }
    function stop() { enabled = false; stopped = true; clock.clearTimeout(timer); }
    function shutdown() { stop(); committedReservation?.release(); committedReservation = null; }
    return { start, stop, shutdown, wake: () => schedule(true), check: () => check(false), download, install,
        snapshot: () => ({ ...status }), scheduleState: () => ({ nextDue: due, blockedUntil, recoveryDue }) };
}
module.exports = { createUpdateService, atomicState };
