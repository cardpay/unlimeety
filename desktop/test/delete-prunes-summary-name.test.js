'use strict';
// node test/delete-prunes-summary-name.test.js
//
// spec-robustness-config-writes.md: transcripts:delete now prunes
// cfg.summaryNames[filePath] after a successful delete — otherwise the entry
// (keyed on an absolute path) lives forever, and a future transcript that
// happens to land on the identical path silently inherits someone else's
// custom summary name. Flagged by review as having zero test coverage.
//
// main.js requires electron and cannot be required directly, so the
// transcripts:delete handler is sliced out as a standalone async arrow
// function and evaluated with `new Function`, closing over stub
// dialog/fs/path/readConfig/writeConfig/removeNotesSidecar and real
// isPathInside — same slicing technique as test/enhance-confirm.test.js.
// findExistingSummaryPath/findRelatedAudioPaths are stubbed rather than
// built for real: this test is about the summaryNames prune, not about
// finding siblings (test/path-guards.test.js already covers those).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

function sliceBraces(src, from, what) {
    assert.ok(from >= 0, `could not find ${what}`);
    let depth = 0;
    for (let i = src.indexOf('{', from); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${what}`);
}

function checkParses(text, name) {
    new vm.Script(text, { filename: `slice:${name}` });
    return text;
}

function sliceFunction(name) {
    const start = MAIN.indexOf(`\nfunction ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in main.js — renamed or moved?`);
    return checkParses(sliceBraces(MAIN, start, `${name}()`), name);
}

function sliceIpcHandlerFn(name) {
    const marker = `ipcMain.handle('${name}', async `;
    const at = MAIN.indexOf(marker);
    assert.notStrictEqual(at, -1, `ipcMain.handle('${name}', async ...) not found in main.js`);
    return checkParses(sliceBraces(MAIN, at + marker.length, `${name} handler`), `${name} handler`);
}

const isPathInsideSrc = sliceFunction('isPathInside');

function makeHandler({ cfg, unlinkResults = {} }) {
    const src = `${isPathInsideSrc}\nreturn ${sliceIpcHandlerFn('transcripts:delete')};`;
    const factory = new Function(
        'TRANSCRIPTS_FOLDER', 'dialog', 'mainWindow', 'fs', 'path',
        'findExistingSummaryPath', 'findRelatedAudioPaths', 'removeNotesSidecar',
        'readConfig', 'writeConfig',
        src,
    );
    const writeConfigCalls = [];
    const handler = factory(
        '/rec/Meet_Transcripts',
        { showMessageBoxSync: () => 0 }, // 0 = "Delete" pressed
        {},
        {
            unlinkSync: (p) => {
                if (unlinkResults[p] === false) throw new Error(`EPERM: ${p}`);
            },
        },
        path,
        () => null,   // findExistingSummaryPath — no summary in this test
        () => [],     // findRelatedAudioPaths — no audio siblings in this test
        () => {},     // removeNotesSidecar
        () => cfg,
        (newCfg) => { writeConfigCalls.push(newCfg); Object.assign(cfg, newCfg); },
    );
    return { handler, writeConfigCalls };
}

test('a successful delete prunes the matching summaryNames entry and persists it', async () => {
    const filePath = '/rec/Meet_Transcripts/a.txt';
    const cfg = { summaryNames: { [filePath]: 'Custom Name', '/other.txt': 'Unrelated' } };
    const { handler, writeConfigCalls } = makeHandler({ cfg });

    const result = await handler(null, filePath);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.summaryNames, filePath), false,
        'the deleted transcript\'s own entry must be gone');
    assert.strictEqual(cfg.summaryNames['/other.txt'], 'Unrelated',
        'an unrelated entry must survive untouched');
    assert.strictEqual(writeConfigCalls.length, 1, 'the prune must be persisted via writeConfig');
});

test('a failed delete (unlink throws) leaves the summaryNames entry alone', async () => {
    const filePath = '/rec/Meet_Transcripts/locked.txt';
    const cfg = { summaryNames: { [filePath]: 'Custom Name' } };
    const { handler, writeConfigCalls } = makeHandler({ cfg, unlinkResults: { [filePath]: false } });

    const result = await handler(null, filePath);
    assert.strictEqual(result.ok, false, 'unlink failure must surface as a failed delete');
    assert.strictEqual(cfg.summaryNames[filePath], 'Custom Name',
        'a delete that did not actually happen must not drop the custom name — a future transcript at the same path must not inherit it, but this one is still there');
    assert.strictEqual(writeConfigCalls.length, 0, 'writeConfig must not run when nothing was pruned');
});

test('a transcript with no summaryNames entry at all is a no-op prune, not a crash', async () => {
    const filePath = '/rec/Meet_Transcripts/no-custom-name.txt';
    const cfg = { summaryNames: {} };
    const { handler, writeConfigCalls } = makeHandler({ cfg });

    const result = await handler(null, filePath);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(writeConfigCalls.length, 0, 'nothing to prune means no writeConfig call');
});

console.log('delete-prunes-summary-name: all checks passed');
