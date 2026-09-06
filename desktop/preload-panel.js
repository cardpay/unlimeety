// Narrow preload for the notes/prompt companion windows (floating Live notes
// panel, call-detect prompt overlay) — the only two windows besides the main
// one. They must NOT get the main window's full `transcriber`/`recordApi`/
// `live`/`calendar`/`queueApi` surface: none of it is relevant to a small
// frameless panel, and every handler reachable from that surface which
// touches file:*/summary:*/settings:* or a destructive transcripts:*/record:*
// channel now also checks the IPC sender is the main window (see main.js's
// fromMain()) — this file is what keeps these two windows off that surface
// in the first place, rather than relying on the sender check alone.
//
// The three blocks below are duplicated from preload.js rather than shared
// via a `require()` of a common module: both preload.js and this file run
// with `sandbox: true`, and this codebase has never relied on a sandboxed
// preload script requiring a second local file — safer to keep ~30
// already-working lines duplicated than introduce an unproven pattern here.
const { contextBridge, ipcRenderer } = require('electron');

// ─── Notes (isolated namespace) ──────────────────────────────────────────────
// Freeform timestamped notes captured during a Live session. Shared with the
// main window's Record-tab inline control, which calls the same two methods
// through preload.js's own copy of this block.
contextBridge.exposeInMainWorld('notesApi', {
    add:          (text)      => ipcRenderer.invoke('notes:add', text),
    list:         ()          => ipcRenderer.invoke('notes:list'),
    onChanged:    (cb)        => {
        const handler = () => cb();
        ipcRenderer.on('notes:changed', handler);
        return () => ipcRenderer.removeListener('notes:changed', handler);
    },
    close:        ()          => ipcRenderer.send('notes:close'),
    reopen:       ()          => ipcRenderer.invoke('notes:reopen'),
    setCollapsed: (collapsed) => ipcRenderer.send('notes:setCollapsed', collapsed),
});

// ─── Call-detection prompt (isolated namespace) ─────────────────────────────
// Used only by the small frameless prompt window (renderer/prompt/).
contextBridge.exposeInMainWorld('promptApi', {
    onData:  (cb) => ipcRenderer.on('prompt:data', (_e, data) => cb(data)),
    record:  ()   => ipcRenderer.send('prompt:record'),
    dismiss: ()   => ipcRenderer.send('prompt:dismiss'),
    keepRecording: () => ipcRenderer.send('prompt:keepRecording'),
    stopNow: () => ipcRenderer.send('prompt:stopNow'),
    hide: () => ipcRenderer.send('prompt:hide'),
});

// ─── Theme (isolated namespace) ─────────────────────────────────────────────
// Lets the notes window pick up a theme change made in the main window's
// Settings while it stays open across it.
contextBridge.exposeInMainWorld('themeApi', {
    notifyChanged: () => ipcRenderer.send('theme:changed'),
    onChanged:     (cb) => {
        const handler = () => cb();
        ipcRenderer.on('theme:changed', handler);
        return () => ipcRenderer.removeListener('theme:changed', handler);
    },
});
