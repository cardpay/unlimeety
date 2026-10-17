'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function ipcHarness() {
    const handlers = new Map(); let reserved = false;
    const context = vm.createContext({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        app: { on() {} }, Promise });
    const start = main.indexOf('let updateGate = null;'); const end = main.indexOf("app.on('before-quit', (event)", start);
    vm.runInContext(main.slice(start, end), context);
    context.gate = { isReserved: () => reserved };
    vm.runInContext('updateGate = gate;', context);
    return { context, handlers, reserve: () => { reserved = true; }, pending: () => vm.runInContext('updatePendingWork', context) };
}
test('actual IPC lifetime gate includes async permission/start and stop/save gaps', async () => {
    const h = ipcHarness(); let finish;
    h.context.ipcMain.handle('record:start', () => new Promise((resolve) => { finish = resolve; }));
    const started = h.handlers.get('record:start')({}); assert.equal(h.pending(), 1);
    finish({ ok: true }); await started; assert.equal(h.pending(), 0);
    h.context.ipcMain.handle('live:saveTranscript', () => new Promise((resolve) => { finish = resolve; }));
    const saved = h.handlers.get('live:saveTranscript')({}); assert.equal(h.pending(), 1);
    finish({ ok: false, error: 'disk full' }); await saved; assert.equal(h.pending(), 0);
});
test('actual main reservation blocks fresh work and allows only editor save/update actions', async () => {
    const h = ipcHarness(); let runs = 0;
    for (const channel of ['record:start', 'live:start', 'localModels:download', 'summarize:run', 'notes:add', 'file:save', 'updates:status']) h.context.ipcMain.handle(channel, () => { runs++; return { ok: true }; });
    h.reserve();
    for (const channel of ['record:start', 'live:start', 'localModels:download', 'summarize:run', 'notes:add']) assert.equal((await h.handlers.get(channel)({})).ok, false);
    assert.equal(runs, 0);
    assert.equal((await h.handlers.get('file:save')({})).ok, true); assert.equal((await h.handlers.get('updates:status')({})).ok, true);
    assert.equal(h.pending(), 0);
});
test('actual main busy reason covers helper-exit-to-save and queued jobs', () => {
    const source = main.slice(main.indexOf('function updateBusyReason()'), main.indexOf('function startUpdates()'));
    const ctx = vm.createContext({ quitFlushing: false, quitting: false, updatePendingWork: 0, updateFailedNoteWrites: new Map(), live: { outputPath: '/fixture/pending.wav' }, recorder: {}, transcriber: {}, queue: { list: () => [] }, LOCAL_MODEL_DOWNLOADS: new Map(), isDirty: false });
    vm.runInContext(source, ctx); assert.match(ctx.updateBusyReason(), /Finish and save/);
    ctx.live.outputPath = null; ctx.queue.list = () => [{ status: 'queued' }]; assert.match(ctx.updateBusyReason(), /queued/);
    ctx.queue.list = () => []; ctx.isDirty = true; assert.match(ctx.updateBusyReason(), /Save transcript/);
});
test('actual editor readiness rejects failed saves/remainders without a discard path', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    const callback = source.slice(source.indexOf('window.prepareEditorForUpdate ='));
    for (const scenario of ['dirty', 'failed save', 'remainder', 'live failed save']) {
        const ctx = vm.createContext({ document: { getElementById: () => null, querySelector: () => null }, window: { liveUpdateBusy: () => scenario === 'live failed save' }, state: { isDirty: scenario === 'dirty', savedContent: 'saved' }, editor: { value: 'saved' },
            autosave: async () => { if (scenario === 'remainder') ctx.editor.value = 'remainder'; return scenario !== 'failed save'; } });
        vm.runInContext(callback, ctx);
        await assert.rejects(ctx.window.prepareEditorForUpdate());
    }
    assert.doesNotMatch(callback, /confirm\(|flushBeforeReplace/);
});
test('companion bridge has no update actions or URL/path inputs and main actions enforce sender', () => {
    const panel = fs.readFileSync(path.join(__dirname, '..', 'preload-panel.js'), 'utf8');
    assert.doesNotMatch(panel, /invoke\('updates:(?:check|download|install)/);
    for (const action of ['check', 'download', 'install']) assert.match(main, new RegExp(`ipcMain\\.handle\\('updates:${action}', \\(event\\) => fromMain\\(event\\)`));
    assert.match(main, /event\.senderFrame !== event\.sender\.mainFrame/);
});

test('failed meeting-note sidecar writes block updates until the exact snapshot is saved', () => {
    const source = main.slice(main.indexOf('function updateBusyReason()'), main.indexOf('function startUpdates()'));
    const pending = new Map([['/fixture/session.notes.json', 'fixture notes']]); const writes = [];
    const ctx = vm.createContext({ quitFlushing: false, quitting: false, updatePendingWork: 0, updateFailedNoteWrites: pending,
        live: {}, recorder: {}, transcriber: {}, queue: { list: () => [] }, LOCAL_MODEL_DOWNLOADS: new Map(), isDirty: false,
        canWritePath: () => false, writeFileAtomic: (file, data) => writes.push({ file, data }) });
    vm.runInContext(source, ctx); assert.match(ctx.updateBusyReason(), /notes could not be saved/); assert.equal(pending.size, 1);
    ctx.canWritePath = () => true; assert.equal(ctx.updateBusyReason(), null);
    assert.equal(pending.size, 0); assert.deepEqual(writes, [{ file: '/fixture/session.notes.json', data: 'fixture notes' }]);
});
test('actual note inputs report drafts and in-flight writes; failed submission restores text', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'notes-list.js'), 'utf8');
    let keydown; let finish;
    const ctx = vm.createContext({ window: { notesApi: { add: () => new Promise((resolve) => { finish = resolve; }) } }, setTimeout: () => {} });
    vm.runInContext(source, ctx);
    const input = { value: 'fixture draft', addEventListener: (_event, callback) => { keydown = callback; } };
    ctx.window.notesList.attachInput({ input, placeholder: 'note', rejectedMessage: 'not saved' });
    assert.match(ctx.window.notesList.updateReadinessError(), /note draft/);
    const submitting = keydown({ key: 'Enter' }); assert.equal(input.value, '');
    assert.match(ctx.window.notesList.updateReadinessError(), /note draft/);
    finish({ ok: false }); await submitting;
    assert.equal(input.value, 'fixture draft'); assert.match(ctx.window.notesList.updateReadinessError(), /note draft/);
    input.value = ''; assert.equal(ctx.window.notesList.updateReadinessError(), null);
});
test('production startUpdates wires main and companion readiness through sender-checked IPC before staging', async () => {
    const { EventEmitter } = require('node:events'); const { createUpdateService } = require('../update-service'); const { createUpdateReadiness } = require('../update-readiness');
    const handlers = new Map(); const ipcMain = new EventEmitter(); ipcMain.handle = (name, callback) => handlers.set(name, callback);
    let noteDraft = true, stages = 0, mainPrepares = 0, notePrepares = 0;
    function participant(isNotes) {
        const contents = new EventEmitter(); contents.mainFrame = {}; contents.isDestroyed = () => false;
        contents.send = (name, value) => {
            if (name !== 'updates:prepare') return;
            if (isNotes) notePrepares++; else mainPrepares++;
            ipcMain.emit('updates:ready', { sender: contents, senderFrame: contents.mainFrame }, { token: value, ok: !isNotes || !noteDraft, error: 'note draft' });
        };
        return { isDestroyed: () => false, webContents: contents };
    }
    const mainWindow = participant(false), notesWindow = participant(true);
    const app = new EventEmitter(); app.getVersion = () => '2.0.0'; app.getPath = () => '/fixture';
    const candidate = { version: '2.0.1' };
    const context = vm.createContext({ app, ipcMain, mainWindow, notesWindow, powerMonitor: new EventEmitter(), path,
        updateGate: null, updateService: null, pendingFilePath: null, quitting: false, updateBusyReason: () => null,
        fromMain: (event) => event.sender === mainWindow.webContents,
        require: (name) => {
            if (name === './update-readiness') return { createUpdateReadiness };
            if (name === './update-provider') return { discoverUpdate: async () => ({ candidate }) };
            if (name === './update-mac') return { createMacAdapter: () => ({ download: async () => {}, prepare: async () => {}, install: async () => { stages++; } }) };
            if (name === './update-service') return { createUpdateService: (options) => createUpdateService({ ...options, load: () => ({}), persist() {}, clock: { now: Date.now, setTimeout: () => 1, clearTimeout() {} } }) };
            throw new Error(`Unexpected dependency ${name}`);
        } });
    vm.runInContext(main.slice(main.indexOf('function startUpdates()'), main.indexOf('// ─── App lifecycle')), context);
    context.startUpdates();
    const event = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame };
    await handlers.get('updates:check')(event); await handlers.get('updates:download')(event);
    assert.equal((await handlers.get('updates:install')({ sender: notesWindow.webContents })).error, 'Forbidden');
    await handlers.get('updates:install')(event); assert.equal(stages, 0); assert.match(context.updateService.snapshot().error, /note draft/);
    noteDraft = false; await handlers.get('updates:install')(event);
    assert.equal(stages, 1); assert.equal(mainPrepares, 2); assert.equal(notePrepares, 2);
    assert.equal(context.updateGate.isReserved(), true);
    app.emit('will-quit'); assert.equal(context.updateGate.isReserved(), true);
    app.emit('quit'); assert.equal(context.updateGate.isReserved(), false);
});
test('production quit guard vetoes ordinary quit during native commitment and permits the selected restart', () => {
    let handler, prevented = 0, aborted = 0, committed = true, allowed = false;
    const ctx = vm.createContext({ app: { on: (_name, callback) => { handler = callback; } }, updateGate: {
        isCommitted: () => committed, canRestart: () => allowed, abort: () => aborted++,
    } });
    const start = main.indexOf("app.on('before-quit', (event)");
    vm.runInContext(main.slice(start, main.indexOf('const TRANSCRIPTS_FOLDER', start)), ctx);
    handler({ preventDefault: () => prevented++ }); assert.equal(prevented, 1); assert.equal(aborted, 0);
    allowed = true; handler({ preventDefault: () => prevented++ }); assert.equal(prevented, 1);
    committed = false; handler({ preventDefault: () => prevented++ }); assert.equal(aborted, 2);
});
test('production close handler preserves the main window during native commitment', () => {
    let close, committed = true, restart = false, prevented = 0, hidden = 0;
    const ctx = vm.createContext({ mainWindow: { on: (_event, callback) => { close = callback; }, hide: () => hidden++ },
        updateGate: { isCommitted: () => committed, canRestart: () => restart }, quitting: false, live: {}, recorder: {} });
    const start = main.indexOf("mainWindow.on('close', (e) => {"); const end = main.indexOf('\n    });', start) + '\n    });'.length;
    vm.runInContext(main.slice(start, end), ctx);
    close({ preventDefault: () => prevented++ }); assert.equal(prevented, 1); assert.equal(hidden, 0);
    restart = true; close({ preventDefault: () => prevented++ }); assert.equal(prevented, 1);
    committed = false; close({ preventDefault: () => prevented++ }); assert.equal(prevented, 1);
});
test('production library refresh receives its read contracts during a reservation', async () => {
    const h = ipcHarness(); const items = [{ id: 'synthetic transcript' }], recordings = [{ id: 'synthetic audio', filePath: '/fixture/recording.wav' }];
    h.context.ipcMain.handle('transcripts:list', () => items); h.context.ipcMain.handle('record:list', () => recordings); h.reserve();
    const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8'); let rendered = 0;
    const ctx = vm.createContext({ Promise, Set, Array, api: { listTranscripts: () => h.handlers.get('transcripts:list')({}) },
        recApi: { list: async () => h.handlers.get('record:list')({}) }, meetings: [], selectedRecordings: new Set(), audioOnlyState: null,
        mergeMeetings: (one, two) => [...one, ...two], renderMeetings: () => rendered++ });
    const start = source.indexOf('function recordingsSignature('), end = source.indexOf('// ─── Chat state', start);
    vm.runInContext(source.slice(start, end), ctx); await ctx.loadLibrary();
    assert.equal(ctx.meetings.length, 2); assert.equal(rendered, 1); assert.equal(h.pending(), 0);
});
