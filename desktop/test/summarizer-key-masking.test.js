'use strict';
// node test/summarizer-key-masking.test.js
//
// spec-security-key-exposure-preload.md (finding H): settings:getSummarizer
// used to hand the renderer the decrypted OpenRouter/OpenAI-compatible API
// key — settings:setSummarizer's response did too, since it just returned
// readSummarizerConfig() again. publicSummarizerConfig() is the renderer-
// facing shape: `hasKey` instead of the secret. Saving with an empty key must
// not clear a stored one (preserveApiKeyFields) — an empty, write-only key
// field is how the renderer says "leave it alone", not "delete it".
//
// main.js requires electron and cannot be required directly; the relevant
// functions are sliced out by name and evaluated with `new Function`, closing
// over a stub `safeStorage` and stubbed app/dialog/fs — same technique
// test/config-persistence.test.js uses (mkdtemp for the config file).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { test, after } = require('node:test');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

function checkParses(text, name) {
    new vm.Script(text, { filename: `slice:${name}` });
    return text;
}

function sliceBraces(src, from, what) {
    assert.notStrictEqual(from, -1, `could not find ${what}`);
    let depth = 0;
    for (let i = src.indexOf('{', from); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${what}`);
}

function sliceFunction(name) {
    const start = MAIN.indexOf(`\nfunction ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in main.js — renamed or moved?`);
    return checkParses(sliceBraces(MAIN, start, `${name}()`), name);
}

function sliceIpcHandlerFn(name) {
    const marker = `ipcMain.handle('${name}', `;
    const at = MAIN.indexOf(marker);
    assert.notStrictEqual(at, -1, `ipcMain.handle('${name}', ...) not found in main.js`);
    return checkParses(sliceBraces(MAIN, at + marker.length, `${name} handler`), `${name} handler`);
}

// DEFAULT_SUMMARIZER is a multi-line object constant, not a function — same
// slice-to-`;` technique as test/participant-rename.test.js's sliceConst.
function sliceConstVar(name) {
    const start = MAIN.indexOf(`\nconst ${name} = `);
    assert.notStrictEqual(start, -1, `const ${name} not found in main.js`);
    const end = MAIN.indexOf(';\n', start);
    return MAIN.slice(start, end + 1).replace(/^\nconst /, '\nvar ');
}

// ─── Sandbox ─────────────────────────────────────────────────────────────────
//
// A reversible fake for safeStorage: Buffer round-trips through base64 for
// real (encryptApiKey/decryptApiKey call `.toString('base64')` /
// `Buffer.from(x, 'base64')` themselves), only the "encryption" itself is
// fake. Good enough to exercise hasKey/preserve logic without real Keychain
// access in a test environment.
function fakeSafeStorage() {
    return {
        isEncryptionAvailable: () => true,
        encryptString: (key) => Buffer.from(`enc:${key}`, 'utf-8'),
        decryptString: (buf) => {
            const s = buf.toString('utf-8');
            if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
            return s.slice(4);
        },
    };
}

function makeSandbox(userDataDir) {
    const src = [
        sliceFunction('configPath'),
        sliceFunction('readConfig'),
        sliceFunction('writeConfig'),
        sliceFunction('writeFileAtomic'),
        sliceFunction('parsePositiveInt'),
        sliceConstVar('DEFAULT_SUMMARIZER'),
        sliceFunction('decryptApiKey'),
        sliceFunction('encryptApiKey'),
        sliceFunction('readSummarizerConfig'),
        sliceFunction('publicSummarizerConfig'),
        sliceFunction('preserveApiKeyFields'),
    ].join('\n');
    const factory = new Function(
        'fs', 'path', 'process', 'app', 'dialog', 'lastSelfWrite', 'spokenTurnsIndex', 'safeStorage',
        `${src}\nreturn { readConfig, writeConfig, readSummarizerConfig, publicSummarizerConfig, preserveApiKeyFields, encryptApiKey, decryptApiKey };`,
    );
    const app = { getPath: () => userDataDir };
    const dialog = { showErrorBox: () => {} };
    return factory(fs, path, process, app, dialog, { name: null, at: 0 }, new Map(), fakeSafeStorage());
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'summarizer-key-masking-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// ─── publicSummarizerConfig: hasKey, never the secret ───────────────────────

test('no stored key: hasKey is false and no apiKey field leaks through', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'no-key-'));
    const box = makeSandbox(dir);
    const pub = box.publicSummarizerConfig();
    assert.strictEqual(pub.openrouter.hasKey, false);
    assert.strictEqual(pub.openaiCompatible.hasKey, false);
    assert.strictEqual('apiKey' in pub.openrouter, false, 'openrouter must not carry an apiKey field');
    assert.strictEqual('apiKey' in pub.openaiCompatible, false, 'openaiCompatible must not carry an apiKey field');
});

test('a stored (encrypted) key: hasKey is true, model/baseUrl still pass through, secret does not', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'has-key-'));
    const box = makeSandbox(dir);
    box.writeConfig({
        summarizer: {
            provider: 'openrouter',
            openrouter: { ...box.encryptApiKey('sk-super-secret'), model: 'my-model', baseUrl: 'https://x/v1' },
        },
    });
    const pub = box.publicSummarizerConfig();
    assert.strictEqual(pub.openrouter.hasKey, true);
    assert.strictEqual(pub.openrouter.model, 'my-model');
    assert.strictEqual(pub.openrouter.baseUrl, 'https://x/v1');
    assert.strictEqual(JSON.stringify(pub).includes('sk-super-secret'), false,
        'the decrypted key must never appear anywhere in the public shape');
});

// ─── preserveApiKeyFields: empty key input keeps the stored key ────────────

test('preserves an existing apiKeyEnc untouched', () => {
    const box = makeSandbox(fs.mkdtempSync(path.join(tmpRoot, 'preserve-enc-')));
    assert.deepStrictEqual(box.preserveApiKeyFields({ apiKeyEnc: 'abc123' }), { apiKeyEnc: 'abc123' });
});

test('preserves a legacy plaintext apiKey untouched', () => {
    const box = makeSandbox(fs.mkdtempSync(path.join(tmpRoot, 'preserve-plain-')));
    assert.deepStrictEqual(box.preserveApiKeyFields({ apiKey: 'sk-legacy' }), { apiKey: 'sk-legacy' });
});

test('nothing stored yet: preserves nothing (not an error)', () => {
    const box = makeSandbox(fs.mkdtempSync(path.join(tmpRoot, 'preserve-none-')));
    assert.deepStrictEqual(box.preserveApiKeyFields(undefined), {});
    assert.deepStrictEqual(box.preserveApiKeyFields({}), {});
});

// ─── The real handler wires apiKey ? encrypt : preserve for BOTH providers ──

test("settings:setSummarizer encrypts a non-empty key and preserves the stored one otherwise, for both openrouter and openaiCompatible", () => {
    const start = MAIN.indexOf(`ipcMain.handle('settings:setSummarizer'`);
    const handler = sliceBraces(MAIN, start, 'settings:setSummarizer handler');
    assert.match(handler, /apiKey \? encryptApiKey\(apiKey\) : preserveApiKeyFields\(existing\.openrouter\)/,
        'openrouter key must be encrypted when provided, preserved when blank');
    assert.match(handler, /oaiKey \? encryptApiKey\(oaiKey\) : preserveApiKeyFields\(existing\.openaiCompatible\)/,
        'openaiCompatible key must be encrypted when provided, preserved when blank');
    assert.match(handler, /publicSummarizerConfig\(\)/,
        'the response must be the masked shape, not the decrypted readSummarizerConfig()');
    assert.doesNotMatch(handler, /summarizer:\s*readSummarizerConfig\(\)/,
        'must never hand the decrypted config back to the renderer');
});

test('settings:getSummarizer returns publicSummarizerConfig(), never the decrypted readSummarizerConfig()', () => {
    const start = MAIN.indexOf(`ipcMain.handle('settings:getSummarizer'`);
    const handler = sliceBraces(MAIN, start, 'settings:getSummarizer handler');
    assert.match(handler, /return publicSummarizerConfig\(\);/,
        'settings:getSummarizer must return the masked shape');
    assert.doesNotMatch(handler, /readSummarizerConfig\(\)/,
        'settings:getSummarizer must never call readSummarizerConfig() directly — that would leak the decrypted key');
});

test('settings:getSummarizer and settings:setSummarizer both check fromMain(e)', () => {
    for (const channel of ['settings:getSummarizer', 'settings:setSummarizer']) {
        const start = MAIN.indexOf(`ipcMain.handle('${channel}'`);
        const handler = sliceBraces(MAIN, start, `${channel} handler`);
        assert.match(handler, /fromMain\(e\)/, `${channel} must check fromMain(e)`);
    }
});

// ─── renderer: write-only key fields ────────────────────────────────────────
//
// renderer/app.js is a classic <script> with no exports; openSettingsModal
// and saveSettings are DOM-heavy (not pure functions), so these are
// source-text checks — same style as the fromMain(e) checks above — rather
// than a vm-sandboxed execution.

const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf-8');

function sliceAppFunction(name) {
    const start = APP.indexOf(`\nasync function ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in renderer/app.js`);
    return sliceBraces(APP, start, `${name}()`);
}

test('openSettingsModal never pre-fills a key field from the fetched config (write-only)', () => {
    const fn = sliceAppFunction('openSettingsModal');
    assert.doesNotMatch(fn, /settingsOrKey\.value\s*=\s*cfg/, 'settings-or-key must not be pre-filled from cfg');
    assert.doesNotMatch(fn, /settingsOaiKey\.value\s*=\s*cfg/, 'settings-oai-key must not be pre-filled from cfg');
    assert.match(fn, /settingsOrKey\.value\s*=\s*""/, 'settings-or-key must be explicitly cleared');
    assert.match(fn, /settingsOaiKey\.value\s*=\s*""/, 'settings-oai-key must be explicitly cleared');
    // Pins the exact ternary polarity (reads cfg.hasKey, "1" on true, "" on
    // false) rather than just checking the property is touched somewhere —
    // an inverted ternary would permanently lock out a user who already has
    // a key stored (saveSettings would then always demand a new one) while
    // silently accepting "no key" saves for everyone else.
    assert.match(fn, /settingsOrKey\.dataset\.hasKey\s*=\s*cfg\?\.openrouter\?\.hasKey\s*\?\s*"1"\s*:\s*""\s*;/,
        'settings-or-key\'s hasKey flag must be set from cfg.openrouter.hasKey with "1"/"" polarity');
    assert.match(fn, /settingsOaiKey\.dataset\.hasKey\s*=\s*cfg\?\.openaiCompatible\?\.hasKey\s*\?\s*"1"\s*:\s*""\s*;/,
        'settings-oai-key\'s hasKey flag must be set from cfg.openaiCompatible.hasKey with "1"/"" polarity');
});

test('saveSettings only requires a new OpenRouter key when none is already stored', () => {
    const fn = sliceAppFunction('saveSettings');
    assert.match(fn, /settingsOrKey\.dataset\.hasKey\s*!==\s*"1"/,
        'the "OpenRouter requires an API key" check must fall through when a key is already stored');
});

// ─── End-to-end: the real settings:setSummarizer handler ───────────────────
//
// Not just its ingredients (publicSummarizerConfig/preserveApiKeyFields
// above) — the actual handler body, wired with the real fromMain/
// normalizeBaseUrl/parsePositiveInt/DEFAULT_SUMMARIZER/encrypt-decrypt, run
// against a real mkdtemp config.json. Closes the I/O matrix rows for
// "save with the key field blank" and "save with a new key".

function makeSetSummarizerHandler(userDataDir) {
    const src = [
        sliceFunction('fromMain'),
        sliceFunction('configPath'),
        sliceFunction('readConfig'),
        sliceFunction('writeConfig'),
        sliceFunction('writeFileAtomic'),
        sliceConstVar('MAX_OLLAMA_CONTEXT_TOKENS'),
        sliceFunction('parsePositiveInt'),
        sliceConstVar('DEFAULT_SUMMARIZER'),
        sliceFunction('decryptApiKey'),
        sliceFunction('encryptApiKey'),
        sliceFunction('readSummarizerConfig'),
        sliceFunction('publicSummarizerConfig'),
        sliceFunction('preserveApiKeyFields'),
        sliceFunction('normalizeBaseUrl'),
    ].join('\n') + `\nreturn ${sliceIpcHandlerFn('settings:setSummarizer')};`;
    const factory = new Function(
        'fs', 'path', 'process', 'app', 'dialog', 'lastSelfWrite', 'spokenTurnsIndex', 'safeStorage', 'mainWindow',
        src,
    );
    const app = { getPath: () => userDataDir };
    const dialogStub = { showErrorBox: () => {} };
    const mainWindow = { webContents: { id: 'REAL' } };
    const handler = factory(fs, path, process, app, dialogStub, { name: null, at: 0 }, new Map(), fakeSafeStorage(), mainWindow);
    return { handler, mainWindow };
}

test('end-to-end: a mismatched sender is denied and writes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'e2e-denied-'));
    const { handler } = makeSetSummarizerHandler(dir);
    const res = await handler({ sender: { id: 'OTHER' } }, { provider: 'openrouter', openrouter: { apiKey: 'sk-x', model: 'm', baseUrl: 'https://a/v1' } });
    assert.deepStrictEqual(res, { ok: false, error: 'Forbidden' });
    assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false, 'a denied call must not write config.json');
});

test('end-to-end: saving with the key field blank keeps the previously stored key; other fields still update', async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'e2e-blank-'));
    const { handler, mainWindow } = makeSetSummarizerHandler(dir);
    const e = { sender: mainWindow.webContents };

    const first = await handler(e, {
        provider: 'openrouter',
        openrouter: { apiKey: 'sk-original', model: 'model-a', baseUrl: 'https://a/v1' },
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.summarizer.openrouter.hasKey, true);

    // Same call, but the key field is now blank (write-only field, user only
    // changed the model) and the response must still not leak the secret.
    const second = await handler(e, {
        provider: 'openrouter',
        openrouter: { apiKey: '', model: 'model-b', baseUrl: 'https://a/v1' },
    });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.summarizer.openrouter.hasKey, true, 'the stored key must survive a blank key field');
    assert.strictEqual(second.summarizer.openrouter.model, 'model-b', 'the unrelated field must still update');
    assert.strictEqual('apiKey' in second.summarizer.openrouter, false);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
    assert.strictEqual(onDisk.summarizer.openrouter.apiKeyEnc.includes('sk-original'), false,
        'apiKeyEnc on disk is the encrypted form, never the plaintext key');
});

test('end-to-end: saving with a new key replaces the stored one', async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'e2e-replace-'));
    const { handler, mainWindow } = makeSetSummarizerHandler(dir);
    const e = { sender: mainWindow.webContents };

    await handler(e, { provider: 'openrouter', openrouter: { apiKey: 'sk-old', model: 'm', baseUrl: 'https://a/v1' } });
    await handler(e, { provider: 'openrouter', openrouter: { apiKey: 'sk-new', model: 'm', baseUrl: 'https://a/v1' } });

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
    const decrypted = Buffer.from(onDisk.summarizer.openrouter.apiKeyEnc, 'base64').toString('utf-8');
    assert.strictEqual(decrypted, 'enc:sk-new', 'the newly submitted key must be what is now stored (fake-encrypted)');
});

console.log('summarizer-key-masking: all checks passed');
