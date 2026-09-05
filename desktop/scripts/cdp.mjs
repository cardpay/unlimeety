// Shared Chrome DevTools Protocol plumbing for the scripts that drive a real
// Electron over CDP — `layout-check.mjs` (geometry assertions) and
// `screenshots.mjs` (the README's images).
//
// Both need the same four things: the Node-22 gate for the global WebSocket,
// polling the devtools endpoint until the renderer target exists, a request/
// response socket that fails loudly when Electron dies mid-run, and an
// evaluator that runs an async body in the page. Nothing here knows what the
// caller is measuring.

import { writeSync } from 'node:fs';

// Global WebSocket landed in Node 22. README says >= 18, which is right for
// `npm test`; say so here rather than letting this die as "WebSocket is not
// defined", which reads like an Electron fault.
export function requireNode22(scriptName) {
    const major = Number(process.versions.node.split('.')[0]);
    if (major >= 22) return;
    writeSync(2, `${scriptName} needs Node >= 22 for the global WebSocket CDP client `
        + `(running ${process.versions.node}). \`npm test\` still works on Node 18.\n`);
    process.exit(1);
}

// A port far enough from a stray 9222 session, and distinct per process so two
// of these scripts can run at once.
export function debugPort() {
    return 9871 + (process.pid % 100);
}

export async function waitForTarget(port, deadline, childExited) {
    for (;;) {
        if (childExited.done) throw new Error(`Electron exited early: ${childExited.done}`);
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/list`);
            const page = (await res.json())
                .find((t) => t.type === 'page' && t.url.includes('index.html'));
            if (page?.webSocketDebuggerUrl) return page;
        } catch { /* devtools endpoint not up yet */ }
        if (Date.now() > deadline) {
            throw new Error(`no Electron renderer on CDP port ${port} — already in use?`);
        }
        await new Promise((r) => setTimeout(r, 200));
    }
}

export function connect(wsUrl, sendTimeoutMs = 20_000) {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    let dead = null;
    const killAll = (why) => {
        dead = why;
        for (const [, slot] of pending) slot.reject(new Error(why));
        pending.clear();
    };
    ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        const slot = pending.get(msg.id);
        if (!slot) return;
        pending.delete(msg.id);
        clearTimeout(slot.timer);
        msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
    });
    // Without these two, an Electron that dies mid-run leaves every in-flight
    // request unsettled and the script hangs with no output at all.
    ws.addEventListener('close', () => killAll('CDP socket closed'));
    ws.addEventListener('error', () => killAll('CDP socket error'));
    const open = new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        if (dead) return reject(new Error(dead));
        const n = ++id;
        const timer = setTimeout(() => {
            pending.delete(n);
            reject(new Error(`${method} timed out after ${sendTimeoutMs}ms`));
        }, sendTimeoutMs);
        pending.set(n, { resolve, reject, timer });
        ws.send(JSON.stringify({ id: n, method, params }));
    });
    return { open, send, close: () => ws.close() };
}

// Runs an async arrow body in the page and returns its value.
export function evaluator(cdp) {
    return async (body) => {
        const res = await cdp.send('Runtime.evaluate', {
            expression: `(async () => { ${body} })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        if (res.exceptionDetails) {
            throw new Error(res.exceptionDetails.exception?.description
                || res.exceptionDetails.text);
        }
        return res.result.value;
    };
}

// Both callers wait for the same thing: renderer scripts are classic <script>
// tags, so the CDP target existing does not mean the tab buttons are wired up.
export async function waitForRenderer(evaluate, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const ready = await evaluate("return document.readyState === 'complete' "
            + "&& !!document.querySelector('.tab-btn')");
        if (ready) return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 200));
    }
}
