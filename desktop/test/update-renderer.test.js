'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/updates.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
function element(id) {
    const classes = new Set(['hidden']);
    return { id, value: '', inert: false, textContent: '', handlers: {},
        classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value), contains: (value) => classes.has(value), toggle(value, yes) { if (yes) classes.add(value); else classes.delete(value); } },
        addEventListener(name, callback) { this.handlers[name] = callback; } };
}
async function harness({ summary = false, rename = false, save = true, actions = {} } = {}) {
    const ids = new Map(['updates-check', 'updates-download', 'updates-install', 'updates-later', 'updates-version', 'updates-status', 'updates-progress', 'updates-indicator', 'updates-activity', 'chat-input', 'settings-modal'].map((id) => [id, element(id)]));
    if (summary) ids.set('rail-edit-area', element('rail-edit-area'));
    let prepare, release, status; const acknowledgements = []; const events = {};
    const editorRegion = element('workspace'); editorRegion.inert = false;
    const body = { children: [editorRegion, ids.get('settings-modal'), ids.get('updates-activity')], inert: false };
    const calls = [];
    const window = { notesList: { updateReadinessError: () => null }, liveUpdateBusy: () => false,
        updateReadiness: { onPrepare: (callback) => { prepare = callback; }, onRelease: (callback) => { release = callback; }, ready: (value) => acknowledgements.push(value) },
        updateApi: { status: async () => ({ version: '2.0.0', channel: 'stable', phase: 'idle' }), onStatus: (callback) => { status = callback; },
            ...Object.fromEntries(['check', 'download', 'install'].map((name) => [name, async () => { calls.push(name); return actions[name]?.(); }])) } };
    const document = { body, getElementById: (id) => ids.get(id) || null,
        querySelector: () => rename ? {} : null, querySelectorAll: () => [ids.get('settings-modal')],
        addEventListener: (event, callback) => { events[event] = callback; } };
    const context = vm.createContext({ window, document, MutationObserver: class { observe() {} },
        state: { isDirty: false, savedContent: 'fixture' }, editor: { value: 'fixture' }, autosave: async () => save });
    vm.runInContext(app.slice(app.indexOf('window.prepareEditorForUpdate =')), context);
    vm.runInContext(source, context); await Promise.resolve();
    return { ids, window, document, editorRegion, acknowledgements, events, prepare, release, status, calls };
}
for (const scenario of ['summary', 'rename', 'chat', 'dialog', 'notes', 'save']) test(`actual renderer prepare refuses ${scenario} without losing drafts and releases only its token`, async () => {
    const h = await harness({ summary: scenario === 'summary', rename: scenario === 'rename', save: scenario !== 'save' });
    if (scenario === 'chat') h.ids.get('chat-input').value = 'fixture question';
    if (scenario === 'notes') h.window.notesList.updateReadinessError = () => 'note draft';
    if (scenario === 'dialog') {
        const dialog = h.ids.get('settings-modal'); dialog.classList.remove('hidden');
        h.events.input({ target: { closest: () => dialog } });
    }
    await h.prepare('fresh-token');
    assert.equal(h.acknowledgements.length, 1); assert.equal(h.acknowledgements[0].ok, false);
    assert.equal(h.editorRegion.inert, true); assert.equal(h.document.body.inert, false);
    assert.equal(h.ids.get('updates-activity').inert, false);
    h.release('stale-token'); assert.equal(h.editorRegion.inert, true);
    h.release('fresh-token'); assert.equal(h.editorRegion.inert, false);
    if (scenario === 'chat') assert.equal(h.ids.get('chat-input').value, 'fixture question');
});
test('actual renderer acknowledges clean editor and keeps installation progress accessible outside reserved regions', async () => {
    const h = await harness(); await h.prepare('fresh-token');
    assert.equal(h.acknowledgements[0].ok, true);
    h.status({ version: '2.0.0', channel: 'stable', phase: 'installing', error: 'Still staging safely' });
    assert.equal(h.ids.get('updates-activity').textContent, 'Still staging safely');
    assert.equal(h.ids.get('updates-activity').classList.contains('hidden'), false);
    assert.equal(h.ids.get('updates-check').disabled, true);
    h.release('fresh-token'); assert.equal(h.ids.get('updates-activity').classList.contains('hidden'), true);
});
test('actual companion notes participant rejects pending text and restores editing on matching release', () => {
    let prepare, release; const replies = [];
    const window = { updateReadiness: { onPrepare: (callback) => { prepare = callback; }, onRelease: (callback) => { release = callback; }, ready: (reply) => replies.push(reply) } };
    const document = { body: { inert: false } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/notes-list.js'), 'utf8'), { window, document });
    const input = { value: 'fixture note', addEventListener() {} }; window.notesList.attachInput({ input });
    prepare('panel-token'); assert.equal(replies[0].ok, false); assert.equal(input.value, 'fixture note');
    assert.equal(document.body.inert, true); release('stale'); assert.equal(document.body.inert, true);
    release('panel-token'); assert.equal(document.body.inert, false);
    input.value = ''; prepare('next-token'); assert.equal(replies[1].ok, true); release('next-token');
});
test('pending setup meeting titles block replacement until the user finishes or clears them', async () => {
    const h = await harness(); const title = element('live-title'); title.value = 'Synthetic meeting';
    const setup = element('live-setup'); setup.classList.remove('hidden'); h.ids.set('live-title', title); h.ids.set('live-setup', setup);
    h.window.liveUpdateTitleDraft = () => !!title.value.trim();
    await h.prepare('title-token'); assert.equal(h.acknowledgements[0].ok, false); assert.match(h.acknowledgements[0].error, /meeting title/);
    h.release('title-token'); title.value = ''; await h.prepare('clean-token'); assert.equal(h.acknowledgements[1].ok, true); h.release('clean-token');
});
test('production renderer transitions expose mutually exclusive actions and wire check/download/install/later/retries', async () => {
    const base = { version: '2.0.0', channel: 'stable' };
    const available = { ...base, phase: 'available', availableVersion: '2.0.1' };
    const downloaded = { ...available, phase: 'downloaded', downloadedVersion: '2.0.1' };
    let rejectDownload = true;
    const h = await harness({ actions: { check: () => available, download: () => { if (rejectDownload) throw new Error('download interrupted'); return downloaded; }, install: () => ({ ...downloaded, phase: 'preparing' }) } });
    const visible = (id) => !h.ids.get(id).classList.contains('hidden');
    assert.equal(visible('updates-download'), false); await h.ids.get('updates-check').handlers.click();
    assert.deepEqual(h.calls, ['check']); assert.equal(visible('updates-download'), true); assert.equal(visible('updates-install'), false); assert.equal(visible('updates-later'), true);
    h.ids.get('updates-later').handlers.click(); assert.equal(visible('updates-indicator'), false); assert.equal(h.calls.length, 1);
    h.status({ ...available, phase: 'downloading', progress: 42 });
    assert.equal(visible('updates-download'), false); assert.equal(visible('updates-install'), false); assert.equal(visible('updates-later'), false);
    assert.equal(visible('updates-progress'), true); assert.equal(h.ids.get('updates-progress').value, 42); assert.equal(h.ids.get('updates-check').disabled, true);
    h.status({ ...available, phase: 'error', error: 'network failed' });
    assert.equal(visible('updates-download'), true); assert.equal(h.ids.get('updates-download').textContent, 'Retry download');
    await h.ids.get('updates-download').handlers.click(); assert.match(h.ids.get('updates-status').textContent, /download interrupted/);
    rejectDownload = false; await h.ids.get('updates-download').handlers.click();
    assert.equal(visible('updates-download'), false); assert.equal(visible('updates-install'), true); assert.equal(visible('updates-later'), true);
    h.status({ ...downloaded, phase: 'downloaded', error: 'Save the draft first' }); assert.equal(visible('updates-install'), true);
    await h.ids.get('updates-install').handlers.click(); assert.equal(visible('updates-install'), false); assert.equal(h.ids.get('updates-check').disabled, true);
    h.status({ ...base, phase: 'error', error: 'offline' }); assert.equal(h.ids.get('updates-check').textContent, 'Retry check');
    await h.ids.get('updates-check').handlers.click(); assert.equal(visible('updates-download'), true);
    assert.deepEqual(h.calls, ['check', 'download', 'download', 'install', 'check']);
});
test('actual calendar ownership lets generated defaults update and preserves user edits until a real reset', async () => {
    const pickerSource = fs.readFileSync(path.join(__dirname, '../renderer/calendar-picker.js'), 'utf8');
    const start = pickerSource.indexOf('  function autoPrefill('), end = pickerSource.indexOf('  window.calendarPicker =', start);
    const ctx = vm.createContext({ readCurrent: async () => ({ ok: true, pick: { title: 'Generated calendar title', participants: [] } }) });
    vm.runInContext(pickerSource.slice(start, end), ctx);
    for (const mode of ['live', 'record']) {
        const h = await harness(); const input = element(`${mode}-title`); const setup = element(`${mode}-setup`); setup.classList.remove('hidden'); h.ids.set(`${mode}-setup`, setup);
        const controller = ctx.autoPrefill({ input, onPick: (pick) => { if (pick.clear) input.value = ''; else if (pick.title) input.value = pick.title; } });
        h.window[`${mode}UpdateTitleDraft`] = controller.hasDraft;
        await controller.refresh(); assert.equal(input.value, 'Generated calendar title'); await h.prepare('generated'); assert.equal(h.acknowledgements.at(-1).ok, true); h.release('generated');
        input.value = 'Synthetic user edit'; await h.prepare('edited'); assert.equal(h.acknowledgements.at(-1).ok, false); h.release('edited');
        controller.reset(); await controller.refresh(); await h.prepare('reset'); assert.equal(h.acknowledgements.at(-1).ok, true); h.release('reset');
    }
});
