'use strict';

// One cancellation budget follows redirects, streaming, hashing and subprocesses.
// Callers own the scope; nested operations must use the same signal.
function budget(timeoutMs, parent) {
    const controller = new AbortController();
    const parents = [];
    function follow(source) {
        if (!source) return;
        const abort = () => controller.abort(source.reason || new Error('Update operation was cancelled.'));
        parents.push([source, abort]);
        if (source.aborted) abort(); else source.addEventListener('abort', abort, { once: true });
    }
    follow(parent);
    const timer = setTimeout(() => controller.abort(new Error('Update operation timed out. Retry when the connection and disk are ready.')), timeoutMs);
    timer.unref?.();
    return { signal: controller.signal, follow, abort: (reason) => controller.abort(reason), close() { clearTimeout(timer); for (const [source, abort] of parents) source.removeEventListener('abort', abort); } };
}
function checkAbort(signal) { if (signal?.aborted) throw signal.reason || new Error('Update operation was cancelled.'); }
function abortable(promise, signal) {
    if (!signal) return promise;
    checkAbort(signal);
    let abort;
    const cancelled = new Promise((_resolve, reject) => {
        abort = () => reject(signal.reason || new Error('Update operation was cancelled.'));
        signal.addEventListener('abort', abort, { once: true });
    });
    return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}
module.exports = { budget, checkAbort, abortable };
