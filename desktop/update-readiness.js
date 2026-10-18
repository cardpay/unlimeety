'use strict';
const crypto = require('node:crypto');

// Installation owns an exclusive, short-lived reservation. Renderer acks are
// sender- and token-bound; the second check runs immediately before staging.
function createUpdateReadiness({ busy, participants, timeoutMs = 10000, onRelease = () => {}, token = () => crypto.randomBytes(32).toString('hex') }) {
    let active = null;
    function acknowledge(sender, value) {
        if (!active || value?.token !== active.token || !active.pending.has(sender)) return false;
        if (value.ok !== true) { active.fail(new Error(value.error || 'Save all edits before installing, then click Install again.')); return true; }
        active.pending.delete(sender);
        if (!active.pending.size) active.resolve();
        return true;
    }
    function abort(reason) { if (!active?.committed) active?.fail(new Error(reason)); }
    async function reserve() {
        if (active) throw new Error('Update preparation is already in progress.');
        const reason = busy();
        if (reason) throw new Error(reason);
        const windows = participants();
        if (!windows.length) throw new Error('Open the main window before installing.');
        const controller = new AbortController();
        const state = { controller, committed: false, restartAllowed: false, token: token(), pending: new Set(windows), error: null, listeners: [] };
        let rejectWait;
        const waiting = new Promise((resolve, reject) => { state.resolve = resolve; rejectWait = reject; });
        state.fail = (error) => { if (state.committed) return; state.error ||= error; controller.abort(error); rejectWait(error); };
        active = state;
        const timer = setTimeout(() => state.fail(new Error('Saving/readiness timed out. Installation was cancelled; retry after saving.')), timeoutMs);
        function release() {
            clearTimeout(timer);
            for (const [window, event, listener] of state.listeners) window.removeListener(event, listener);
            if (active === state) active = null;
            for (const window of windows) { try { if (!window.isDestroyed()) window.send('updates:release', state.token); } catch {} }
            onRelease();
        }
        try {
            for (const window of windows) {
                for (const event of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
                    const listener = () => state.fail(new Error('A window became unavailable. Installation was cancelled.'));
                    window.once(event, listener); state.listeners.push([window, event, listener]);
                }
                window.send('updates:prepare', state.token);
            }
            await waiting;
            clearTimeout(timer);
            return {
                signal: controller.signal,
                commit() { this.recheck(); state.committed = true; },
                permitRestart() { state.restartAllowed = true; },
                recheck() {
                    if (active !== state || state.error || windows.some((window) => window.isDestroyed())) throw state.error || new Error('Update readiness expired.');
                    const reason = busy();
                    if (reason) throw new Error(reason);
                },
                release,
            };
        } catch (error) { release(); throw error; }
    }
    return { reserve, acknowledge, abort, isReserved: () => !!active, isCommitted: () => !!active?.committed, canRestart: () => !!active?.restartAllowed };
}
module.exports = { createUpdateReadiness };
