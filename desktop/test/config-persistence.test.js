'use strict';
// node test/config-persistence.test.js
//
// spec-robustness-config-writes.md: writeConfig used to be a plain
// fs.writeFileSync — a crash mid-write corrupts config.json and silently
// takes apiKeyEnc/custom prompts/glossary/summaryNames down with it — and
// readConfig's single try/catch could not tell "first run" (ENOENT) apart
// from "corrupt file", so neither was ever surfaced to the user.
//
// main.js requires electron and cannot be required directly, so
// configPath/readConfig/writeConfig/writeFileAtomic are sliced out by name
// and evaluated with `new Function`, closing over stubbed app/dialog/fs —
// same technique test/path-guards.test.js uses.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { test, after } = require('node:test');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

/// Text from `from` through the brace-matched block that starts at the first `{`.
function sliceBraces(src, from, what) {
    assert.ok(from >= 0, `could not find ${what}`);
    let depth = 0;
    for (let i = src.indexOf('{', from); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${what}`);
}

/// A `{`/`}` inside a string or comment would end a slice in the wrong place;
/// parsing catches that instead of silently running a truncated function.
function checkParses(text, name) {
    new vm.Script(text, { filename: `slice:${name}` });
    return text;
}

/// Source of a top-level `function name(...) {...}`. Throws rather than
/// returning nothing: a renamed/moved function must fail the suite loudly.
function sliceFunction(name) {
    const start = MAIN.indexOf(`\nfunction ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in main.js — renamed or moved?`);
    return checkParses(sliceBraces(MAIN, start, `${name}()`), name);
}

// ─── Sandbox: configPath / readConfig / writeConfig / writeFileAtomic ──────
//
// `new Function`, not a vm context, for the same reason test/path-guards.js
// documents: these tests compare plain objects with assert.deepStrictEqual,
// and a vm context is a separate realm whose Object prototype fails that
// comparison as "not reference-equal".

function makeSandbox(userDataDir) {
    const src = [
        sliceFunction('configPath'),
        sliceFunction('readConfig'),
        sliceFunction('writeConfig'),
        sliceFunction('writeFileAtomic'),
    ].join('\n');
    const factory = new Function(
        'fs', 'path', 'process', 'app', 'dialog', 'lastSelfWrite', 'spokenTurnsIndex',
        `${src}\nreturn { configPath, readConfig, writeConfig };`,
    );
    const dialogCalls = [];
    const app = { getPath: () => userDataDir };
    const dialog = { showErrorBox: (title, content) => dialogCalls.push({ title, content }) };
    const box = factory(fs, path, process, app, dialog, { name: null, at: 0 }, new Map());
    box.dialogCalls = dialogCalls;
    return box;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-persistence-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('missing config.json: readConfig returns {} and shows no dialog', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'missing-'));
    const box = makeSandbox(dir);
    assert.deepStrictEqual(box.readConfig(), {});
    assert.strictEqual(box.dialogCalls.length, 0);
});

test('truncated JSON: readConfig returns {}, shows one dialog, and preserves the bad bytes as config.json.corrupt', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'corrupt-'));
    const cfgPath = path.join(dir, 'config.json');
    const badBytes = '{"apiKeyEnc": "abc", "glossary": "term'; // truncated mid-string
    fs.writeFileSync(cfgPath, badBytes, 'utf-8');
    const box = makeSandbox(dir);

    assert.deepStrictEqual(box.readConfig(), {});
    assert.strictEqual(box.dialogCalls.length, 1, 'exactly one dialog for the corruption');
    assert.strictEqual(fs.existsSync(cfgPath), false,
        'the bad file must not be left at the normal config.json path');
    assert.strictEqual(fs.readFileSync(`${cfgPath}.corrupt`, 'utf-8'), badBytes,
        'the original bad bytes must survive on disk, not be silently discarded');

    // The next call sees a clean ENOENT (the bad file is gone, renamed away) —
    // never re-diagnosed as corrupt a second time for the same file.
    assert.deepStrictEqual(box.readConfig(), {});
    assert.strictEqual(box.dialogCalls.length, 1, 'a missing file must not re-trigger the corruption dialog');
});

test('a second corruption overwrites the first .corrupt, rather than piling up', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'corrupt-twice-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(`${cfgPath}.corrupt`, 'stale first corruption', 'utf-8');
    fs.writeFileSync(cfgPath, 'not json at all', 'utf-8');
    const box = makeSandbox(dir);

    box.readConfig();
    assert.strictEqual(fs.readFileSync(`${cfgPath}.corrupt`, 'utf-8'), 'not json at all',
        'the newer corruption must clobber the older .corrupt, not sit beside it');
});

test('readConfig never writes anything back itself on corruption — only the rename, no fresh config.json', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'no-writeback-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, 'not json', 'utf-8');
    const box = makeSandbox(dir);

    box.readConfig();
    assert.strictEqual(fs.existsSync(cfgPath), false,
        'readConfig must not recreate config.json on its own — only writeConfig ever writes it');
});

test('writeConfig then readConfig round-trips', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'roundtrip-'));
    const box = makeSandbox(dir);
    const data = { glossary: 'foo\nbar', summaryNames: { '/a.txt': 'Custom Name' }, apiKeyEnc: 'xyz' };
    box.writeConfig(data);
    assert.deepStrictEqual(box.readConfig(), data);
});

test('writeConfig writes through writeFileAtomic, not a plain fs.writeFileSync', () => {
    const start = MAIN.indexOf('function writeConfig(');
    const body = sliceBraces(MAIN, start, 'writeConfig()');
    assert.ok(/writeFileAtomic\(/.test(body), 'writeConfig must write through writeFileAtomic');
    assert.ok(!/fs\.writeFileSync\(/.test(body),
        'writeConfig must not fall back to a plain fs.writeFileSync — a crash mid-write must not corrupt config.json');
});

console.log('config-persistence: all checks passed');
