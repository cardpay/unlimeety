'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const source = main.slice(main.indexOf('async function generatePdf('), main.indexOf('// Raw export:'));

function harness(t, failPrint = false) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-export-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sessions = [], windows = [];
    const session = { fromPartition(partition, options) {
        const isolated = { partition, options, webRequest: { onBeforeRequest(listener) { isolated.filter = listener; } } };
        sessions.push(isolated); return isolated;
    } };
    class BrowserWindow {
        constructor(options) {
            this.options = options; windows.push(this);
            this.webContents = {
                setWindowOpenHandler: (handler) => { this.open = handler; },
                on: (event, handler) => { if (event === 'will-navigate') this.navigate = handler; },
                printToPDF: async () => {
                    assert.ok(fs.existsSync(this.file));
                    if (failPrint) throw new Error('print failed');
                    return Buffer.from('%PDF-fixture');
                },
            };
        }
        async loadFile(file) { this.file = file; }
        destroy() { this.destroyed = true; }
    }
    const context = vm.createContext({ app: { getPath: () => dir }, fs, path, crypto, pathToFileURL, session, BrowserWindow });
    vm.runInContext(source, context);
    return { generatePdf: context.generatePdf, sessions, windows, dir };
}

test('PDF export disables scripts and isolates each document behind an exact file URL allowlist', async (t) => {
    const h = harness(t);
    for (let i = 0; i < 2; i++) assert.equal((await h.generatePdf('<h1>Fixture</h1>')).toString(), '%PDF-fixture');
    assert.equal(h.sessions.length, 2);
    assert.notEqual(h.sessions[0].partition, h.sessions[1].partition);
    for (const [index, win] of h.windows.entries()) {
        const prefs = win.options.webPreferences;
        assert.equal(prefs.javascript, false);
        assert.equal(prefs.nodeIntegration, false);
        assert.equal(prefs.contextIsolation, true);
        assert.equal(prefs.sandbox, true);
        assert.equal(prefs.session, h.sessions[index]);
        assert.ok(!prefs.session.partition.startsWith('persist:'));
        const url = pathToFileURL(win.file).href;
        const allowed = (value) => {
            let response;
            prefs.session.filter({ url: value }, (result) => { response = result; });
            return response.cancel === false;
        };
        assert.equal(allowed(url), true);
        for (const target of [pathToFileURL(h.windows[1 - index].file).href, `${url}.other`, `${url}?query=1`,
            'file:///etc/hosts', 'http://127.0.0.1:8123/leak', 'https://example.com/leak', 'ws://127.0.0.1:8123/']) {
            assert.equal(allowed(target), false, target);
        }
        assert.equal(win.open().action, 'deny');
        let prevented = false; win.navigate({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
        assert.equal(win.destroyed, true);
        assert.equal(fs.existsSync(win.file), false);
    }
});

test('PDF export cleans up its window and temporary file when printing fails', async (t) => {
    const h = harness(t, true);
    await assert.rejects(h.generatePdf('<p>Fixture</p>'), /print failed/);
    assert.equal(h.windows[0].destroyed, true);
    assert.deepEqual(fs.readdirSync(h.dir), []);
});
