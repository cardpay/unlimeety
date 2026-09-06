'use strict';
// node test/preload-split.test.js
//
// spec-security-key-exposure-preload.md (finding H): a single preload.js used
// to be shared by every window — main, the floating Live notes panel, and the
// call-detect prompt overlay — so any of them could invoke a channel that
// touches files, summaries, settings, or deletes/renames a transcript or
// recording, with zero sender check. This pins three things:
//   1. preload-panel.js (the notes/prompt windows) exposes only
//      {notesApi, promptApi, themeApi} — nothing else from preload.js.
//   2. showNotesWindow/showPromptWindow actually load preload-panel.js, not
//      the main preload.
//   3. every ipcMain handler reachable from the main preload that touches
//      file:*/summary:*/settings:* or a destructive transcripts:*/record:*
//      channel checks fromMain(e) before doing anything else.
// Also covers the drag&drop fix (webUtils.getPathForFile), since it lives in
// the same preload.js surface.
//
// main.js/preload.js/preload-panel.js require electron and cannot be required
// directly; everything here is a source-text/brace-sliced check — same
// technique as test/header-values.test.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

const DESKTOP = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf-8');
const PRELOAD = fs.readFileSync(path.join(DESKTOP, 'preload.js'), 'utf-8');
const PRELOAD_PANEL = fs.readFileSync(path.join(DESKTOP, 'preload-panel.js'), 'utf-8');
const APP = fs.readFileSync(path.join(DESKTOP, 'renderer', 'app.js'), 'utf-8');

function bridgeNames(src) {
    return [...src.matchAll(/exposeInMainWorld\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/// Text from `from` through the brace-matched block that starts at the first `{`.
function sliceBraces(src, from, what) {
    assert.notStrictEqual(from, -1, `could not find ${what}`);
    let depth = 0;
    for (let i = src.indexOf('{', from); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${what}`);
}

function sliceHandler(channel) {
    let start = MAIN.indexOf(`ipcMain.handle('${channel}'`);
    if (start === -1) start = MAIN.indexOf(`ipcMain.on('${channel}'`);
    return sliceBraces(MAIN, start, `${channel} handler`);
}

function sliceFunction(name) {
    const start = MAIN.indexOf(`\nfunction ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in main.js`);
    return sliceBraces(MAIN, start, `${name}()`);
}

function sliceConstVar(name) {
    const start = MAIN.indexOf(`\nconst ${name} = `);
    assert.notStrictEqual(start, -1, `const ${name} not found in main.js`);
    const end = MAIN.indexOf(';\n', start);
    return MAIN.slice(start, end + 1).replace(/^\nconst /, '\nvar ');
}

// Handles both `ipcMain.handle('x', async (e, ...) => {` and the non-async
// form — same marker-length trick, just tried in order. The "async " prefix
// is part of the marker (so it isn't itself matched by sliceBraces' `{`
// search), so it has to be re-attached to the slice, or an async handler
// comes back as a plain arrow function whose `await` is a SyntaxError.
function sliceIpcHandlerFn(channel) {
    let marker = `ipcMain.handle('${channel}', async `;
    let at = MAIN.indexOf(marker);
    if (at !== -1) return 'async ' + sliceBraces(MAIN, at + marker.length, `${channel} handler`);
    marker = `ipcMain.handle('${channel}', `;
    at = MAIN.indexOf(marker);
    assert.notStrictEqual(at, -1, `ipcMain.handle('${channel}', ...) not found in main.js`);
    return sliceBraces(MAIN, at + marker.length, `${channel} handler`);
}

// ─── preload-panel.js: narrow surface ───────────────────────────────────────

test('preload-panel.js exposes exactly notesApi, promptApi, themeApi — nothing else', () => {
    assert.deepStrictEqual(bridgeNames(PRELOAD_PANEL).sort(), ['notesApi', 'promptApi', 'themeApi']);
});

test('preload-panel.js parses as a CommonJS script', () => {
    new vm.Script(PRELOAD_PANEL, { filename: 'preload-panel.js' });
});

test('preload.js still exposes notesApi/promptApi/themeApi for the main window (Record tab inline notes, theme sync) plus its full surface', () => {
    const names = bridgeNames(PRELOAD);
    for (const n of ['notesApi', 'promptApi', 'themeApi', 'transcriber', 'live', 'calendar', 'queueApi', 'recordApi']) {
        assert.ok(names.includes(n), `preload.js must still expose ${n}`);
    }
});

// The notesApi/promptApi/themeApi blocks are deliberately duplicated, not
// shared, between preload.js and preload-panel.js (spec Design Notes). That
// only stays safe if the two copies keep exposing the same methods — this
// pins the method-name sets, not the exact comment text either copy carries.
function bridgeMethodNames(src, bridgeName) {
    const marker = `exposeInMainWorld('${bridgeName}', {`;
    const at = src.indexOf(marker);
    assert.notStrictEqual(at, -1, `${bridgeName} not found`);
    const block = sliceBraces(src, at + marker.length - 1, `${bridgeName} block`);
    return [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
}

test('preload.js and preload-panel.js expose identical methods for notesApi, promptApi and themeApi', () => {
    for (const bridgeName of ['notesApi', 'promptApi', 'themeApi']) {
        assert.deepStrictEqual(
            bridgeMethodNames(PRELOAD_PANEL, bridgeName),
            bridgeMethodNames(PRELOAD, bridgeName),
            `${bridgeName}'s methods drifted between preload.js and preload-panel.js`,
        );
    }
});

test('showNotesWindow and showPromptWindow load preload-panel.js, not the main preload', () => {
    for (const fnName of ['showNotesWindow', 'showPromptWindow']) {
        const start = MAIN.indexOf(`\nfunction ${fnName}(`);
        assert.notStrictEqual(start, -1, `${fnName}() not found in main.js`);
        const fn = sliceBraces(MAIN, start, `${fnName}()`);
        assert.match(fn, /preload:\s*path\.join\(__dirname,\s*'preload-panel\.js'\)/,
            `${fnName} must create its BrowserWindow with preload-panel.js`);
        assert.doesNotMatch(fn, /preload:\s*path\.join\(__dirname,\s*'preload\.js'\)/,
            `${fnName} must not use the main window's full preload.js`);
    }
});

// ─── fromMain(e) sender guard ────────────────────────────────────────────────

const GUARDED_CHANNELS = [
    'file:accepted', 'file:open', 'file:save', 'file:saveSync', 'file:saveAs',
    'summary:save', 'summary:overwrite', 'summary:setName', 'summary:load',
    'settings:getSummaryFolder', 'settings:setSummaryFolder', 'settings:pickFolder',
    'settings:getGlossary', 'settings:setGlossary',
    'settings:getSummarizer', 'settings:setSummarizer',
    'settings:getAutoStop', 'settings:setAutoStop',
    'transcripts:delete', 'transcripts:deleteTranscriptOnly', 'transcripts:deleteSummaryOnly',
    'transcripts:deleteAudioOnly', 'transcripts:create', 'transcripts:enhance', 'transcripts:rename',
    'record:delete', 'record:deleteMany', 'record:rename', 'record:deleteModel',
];

test(`every guarded channel's handler checks fromMain(e) (${GUARDED_CHANNELS.length} channels)`, () => {
    const missing = GUARDED_CHANNELS.filter((ch) => !/fromMain\(e\)/.test(sliceHandler(ch)));
    assert.deepStrictEqual(missing, [], `these channels are missing a fromMain(e) check: ${missing.join(', ')}`);
});

test('fromMain() itself fails closed when mainWindow is null', () => {
    const start = MAIN.indexOf('\nfunction fromMain(');
    const fn = sliceBraces(MAIN, start, 'fromMain()');
    assert.match(fn, /!!mainWindow/, 'must not assume mainWindow is always set');
});

// End-to-end proof for one representative destructive channel (not just a
// source-text check): the real fromMain(e) plus the real transcripts:delete
// handler, wired together, actually deny a mismatched sender before ever
// touching fs — and actually let the main window's sender through.
test('transcripts:delete: a sender that is not mainWindow.webContents is denied and never reaches unlinkSync; the real main window sender proceeds past the guard', async () => {
    const src = [sliceFunction('fromMain'), sliceFunction('isPathInside')].join('\n')
        + `\nreturn ${sliceIpcHandlerFn('transcripts:delete')};`;
    const factory = new Function(
        'TRANSCRIPTS_FOLDER', 'dialog', 'mainWindow', 'fs', 'path',
        'findExistingSummaryPath', 'findRelatedAudioPaths', 'removeNotesSidecar',
        'readConfig', 'writeConfig',
        src,
    );
    const unlinked = [];
    const mainWindow = { webContents: { id: 'REAL' } };
    const handler = factory(
        '/rec/Meet_Transcripts',
        { showMessageBoxSync: () => 0 }, // 0 = "Delete" pressed
        mainWindow,
        { unlinkSync: (p) => unlinked.push(p) },
        path,
        () => null, () => [], () => {},
        () => ({}), () => {},
    );

    const filePath = '/rec/Meet_Transcripts/a.txt';
    const denied = await handler({ sender: { id: 'OTHER' } }, filePath);
    assert.deepStrictEqual(denied, { ok: false, error: 'Forbidden' });
    assert.deepStrictEqual(unlinked, [], 'a denied call must never reach fs.unlinkSync');

    const allowed = await handler({ sender: mainWindow.webContents }, filePath);
    assert.notDeepStrictEqual(allowed, { ok: false, error: 'Forbidden' },
        'the main window\'s own sender must pass the guard (and proceed to the real delete logic)');
    assert.deepStrictEqual(unlinked, [filePath], 'the allowed call must actually delete');
});

// A second, differently-shaped destructive channel (settings write, not a
// file delete) — a substring match alone can't tell a correct guard from one
// whose polarity got flipped; this actually runs both branches.
test('settings:setGlossary: a mismatched sender is denied and writes nothing; the real main window sender saves', () => {
    const src = [sliceFunction('fromMain'), sliceConstVar('MAX_GLOSSARY_CHARS')].join('\n')
        + `\nreturn ${sliceIpcHandlerFn('settings:setGlossary')};`;
    const factory = new Function('mainWindow', 'readConfig', 'writeConfig', src);
    const writes = [];
    const mainWindow = { webContents: { id: 'REAL' } };
    const cfg = {};
    const handler = factory(mainWindow, () => cfg, (newCfg) => { writes.push(newCfg); Object.assign(cfg, newCfg); });

    const denied = handler({ sender: { id: 'OTHER' } }, 'hello');
    assert.deepStrictEqual(denied, { ok: false, error: 'Forbidden' });
    assert.deepStrictEqual(writes, [], 'a denied call must never reach writeConfig');

    const allowed = handler({ sender: mainWindow.webContents }, 'hello');
    assert.deepStrictEqual(allowed, { ok: true });
    assert.strictEqual(cfg.glossary, 'hello', 'the allowed call must actually save');
});

// A third channel, on the record:* (not transcripts:*) side.
test('record:deleteModel: a mismatched sender is denied and never touches the filesystem; the real main window sender proceeds', async () => {
    const src = [sliceFunction('fromMain'), sliceConstVar('WHISPER_MODEL_RE'), sliceFunction('describeFsError')].join('\n')
        + `\nreturn ${sliceIpcHandlerFn('record:deleteModel')};`;
    const factory = new Function('mainWindow', 'app', 'path', 'fs', src);
    const removed = [];
    const mainWindow = { webContents: { id: 'REAL' } };
    const app = { getPath: () => '/userdata' };
    const fsStub = {
        existsSync: () => true,
        promises: { rm: async (dir) => { removed.push(dir); } },
    };
    const handler = factory(mainWindow, app, path, fsStub);

    const denied = await handler({ sender: { id: 'OTHER' } }, 'openai_whisper-tiny');
    assert.deepStrictEqual(denied, { ok: false, error: 'Forbidden' });
    assert.deepStrictEqual(removed, [], 'a denied call must never touch fs');

    const allowed = await handler({ sender: mainWindow.webContents }, 'openai_whisper-tiny');
    assert.deepStrictEqual(allowed, { ok: true, removed: true });
    assert.strictEqual(removed.length, 1, 'the allowed call must actually remove the model dir');
});

test('a representative read-only transcripts/record channel is left unguarded (defense-in-depth only, not the sole barrier)', () => {
    // Documents the scope decision (spec Design Notes): list/search/watch/
    // getAudioPath/etc. are not gated — after the preload split, notes/prompt
    // windows have no route to them at all (no transcriber/recordApi bridge).
    assert.doesNotMatch(sliceHandler('transcripts:list'), /fromMain\(/);
    assert.doesNotMatch(sliceHandler('record:list'), /fromMain\(/);
});

// ─── drag&drop: webUtils.getPathForFile ──────────────────────────────────────

test('preload.js exposes getPathForFile via webUtils', () => {
    assert.match(PRELOAD, /const \{ contextBridge, ipcRenderer, webUtils \} = require\('electron'\)/);
    assert.match(PRELOAD, /getPathForFile:\s*\(file\)\s*=>\s*webUtils\.getPathForFile\(file\)/);
});

test('the drop handler resolves the path through getPathForFile, not the removed File.path, and bails out on an empty result', () => {
    const start = APP.indexOf('dropOverlay.addEventListener("drop"');
    assert.notStrictEqual(start, -1, 'drop handler not found in renderer/app.js');
    const handler = sliceBraces(APP, start, 'drop handler');
    assert.ok(!/\bfile\.path\b/.test(handler), 'must not read the removed File.path');
    assert.match(handler, /getPathForFile\(file\)/, 'must resolve the path via getPathForFile');
    assert.match(handler, /if\s*\(!filePath\)\s*return;/,
        'a File with no resolvable on-disk path must not fall through into loadContent with an empty path');
});

console.log('preload-split: all checks passed');
