'use strict';
// node test/path-guards.test.js
//
// spec-security-paths-headers.md: a transcript's own `Source:` header is
// attacker-controlled (voice, extension DOM, pasted text, a hand-edited
// file) yet findRelatedAudioPaths used to trust it as a filesystem path with
// only a bare fs.existsSync check — a planted `Source: /tmp/victim.wav` made
// "Delete meeting" unlink an arbitrary file the user can write. Half of the
// delete/rename IPC handlers also confined a renderer-supplied path with
// `path.startsWith(FOLDER)`, which a sibling folder
// ("…Meet_Transcripts_evil/x.txt") or a "../" segment defeats — `isPathInside`
// (real relative-path containment) is what the fix routes through instead.
// summary:save/overwrite moved off a plain fs.writeFileSync onto
// writeFileAtomic, whose rename-over-a-symlink is what actually stops a
// planted `<title>.summary.md -> ~/victim.txt` from being followed.
//
// main.js requires electron and cannot be required directly, so each function
// under test is sliced out by name and evaluated in a fresh vm context that
// predefines the module-level state it closes over (TRANSCRIPTS_FOLDER,
// RECORDINGS_FOLDER, allowedReadPaths, …) — same technique
// test/library-filters.test.js uses for cachedHasSpokenTurns.

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

/// Source of a top-level `const NAME = ...;`, taken verbatim (its value
/// matters, so it comes from the shipped file rather than being restated
/// here).
function sliceConst(name) {
    const start = MAIN.indexOf(`\nconst ${name} = `);
    assert.notStrictEqual(start, -1, `const ${name} not found in main.js — renamed or moved?`);
    const end = MAIN.indexOf(';\n', start);
    assert.notStrictEqual(end, -1, `const ${name} has no terminating ";"`);
    return checkParses(MAIN.slice(start, end + 1), name);
}

// ─── Sandbox: isPathInside / canReadPath / findRelatedAudioPaths / ─────────
// ─── writeFileAtomic, closing over fixture-sized folders ───────────────────
//
// Built with `new Function(...)`, not a vm context: these functions return
// plain arrays (findRelatedAudioPaths) that the tests below compare with
// assert.deepStrictEqual against array literals written in this file — a vm
// context is a separate realm with its own Array constructor, and
// deepStrictEqual across realms fails structurally-equal values as "not
// reference-equal" (see test/participant-rename.test.js's note on the same
// pitfall). `new Function` bodies run in this realm, sharing one Array/Object
// with the rest of the file, at the cost of every free variable the sliced
// functions close over (TRANSCRIPTS_FOLDER, RECORDINGS_FOLDER,
// allowedReadPaths, lastSelfWrite, spokenTurnsIndex, fs, path, …) having to be
// passed in as an explicit parameter instead of a sandbox-object property.

function makeSandbox(transcriptsFolder, recordingsFolder) {
    const src = [
        sliceFunction('isPathInside'),
        sliceFunction('canReadPath'),
        sliceFunction('canWritePath'),
        sliceConst('AUDIO_EXTS'),
        sliceConst('WHISPER_MODEL_RE'),
        sliceFunction('parseTranscriptHeaderMain'),
        sliceFunction('sanitizeRecordingName'),
        sliceFunction('findRelatedAudioPaths'),
        sliceFunction('writeFileAtomic'),
        sliceFunction('uniqueFilePath'),
    ].join('\n');
    const factory = new Function(
        'fs', 'path', 'process', 'console',
        'TRANSCRIPTS_FOLDER', 'RECORDINGS_FOLDER', 'allowedReadPaths', 'lastSelfWrite', 'spokenTurnsIndex',
        `${src}\nreturn { isPathInside, canReadPath, canWritePath, findRelatedAudioPaths, writeFileAtomic, uniqueFilePath, WHISPER_MODEL_RE };`,
    );
    const allowedReadPaths = new Set();
    const box = factory(
        fs, path, process, console,
        transcriptsFolder, recordingsFolder, allowedReadPaths, { name: null, at: 0 }, new Map(),
    );
    box.allowedReadPaths = allowedReadPaths; // exposed so a test can simulate registerReadablePath
    return box;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guards-'));
const TRANSCRIPTS = path.join(tmpRoot, 'Meet_Transcripts');
const RECORDINGS = path.join(tmpRoot, 'Meet_Recordings');
const OUTSIDE = path.join(tmpRoot, 'outside'); // stands in for e.g. /tmp or ~
fs.mkdirSync(TRANSCRIPTS, { recursive: true });
fs.mkdirSync(RECORDINGS, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const box = makeSandbox(TRANSCRIPTS, RECORDINGS);

// ─── findRelatedAudioPaths ──────────────────────────────────────────────────

test('a Source: header pointing outside the managed folders is never returned', () => {
    const victim = path.join(OUTSIDE, 'victim.wav');
    fs.writeFileSync(victim, 'not actually audio');
    const txt = path.join(TRANSCRIPTS, 'outside-source.txt');
    fs.writeFileSync(txt, `Meeting: Test\nSource: ${victim}\n\n[00:00] A:\nhi\n`);

    assert.deepStrictEqual(box.findRelatedAudioPaths(txt), [],
        'an unreadable Source: path must not surface as this meeting\'s audio — the delete/player path both key off this list');
});

test('the RECORDINGS_FOLDER wav is returned when there is no (or no valid) Source: line', () => {
    const wav = path.join(RECORDINGS, 'direct-match.wav');
    fs.writeFileSync(wav, 'wav bytes');
    const txt = path.join(TRANSCRIPTS, 'direct-match.txt');
    fs.writeFileSync(txt, 'Meeting: Test\n\n[00:00] A:\nhi\n');

    assert.deepStrictEqual(box.findRelatedAudioPaths(txt), [wav]);
});

test('a Source: header naming a real audio file inside a managed folder is returned first', () => {
    const sourceWav = path.join(RECORDINGS, 'ordering-source.wav');
    const directWav = path.join(RECORDINGS, 'ordering.wav');
    fs.writeFileSync(sourceWav, 'wav bytes');
    fs.writeFileSync(directWav, 'wav bytes');
    const txt = path.join(TRANSCRIPTS, 'ordering.txt');
    fs.writeFileSync(txt, `Meeting: Test\nSource: ${sourceWav}\n\n[00:00] A:\nhi\n`);

    const paths = box.findRelatedAudioPaths(txt);
    assert.strictEqual(paths[0], sourceWav, 'Source: is the most reliable link and must be tried first');
    assert.ok(paths.includes(directWav), 'the folder\'s own direct-match wav must still be listed');
});

test('a Source: header pointing at a non-audio file (e.g. another transcript) is not returned', () => {
    const otherTxt = path.join(TRANSCRIPTS, 'not-audio.txt');
    fs.writeFileSync(otherTxt, 'Meeting: Other\n\nbody\n');
    const txt = path.join(TRANSCRIPTS, 'in-folder-source.txt');
    fs.writeFileSync(txt, `Meeting: Test\nSource: ${otherTxt}\n\n[00:00] A:\nhi\n`);

    assert.deepStrictEqual(box.findRelatedAudioPaths(txt), [],
        'canReadPath alone is not enough — the AUDIO_EXTS gate must also reject a non-audio extension');
});

test('a registerReadablePath-granted external wav is still returned', () => {
    const picked = path.join(OUTSIDE, 'picked.wav');
    fs.writeFileSync(picked, 'wav bytes');
    box.allowedReadPaths.add(fs.realpathSync(picked)); // what registerReadablePath does
    const txt = path.join(TRANSCRIPTS, 'granted-source.txt');
    fs.writeFileSync(txt, `Meeting: Test\nSource: ${picked}\n\n[00:00] A:\nhi\n`);

    assert.deepStrictEqual(box.findRelatedAudioPaths(txt), [picked]);
});

// ─── isPathInside ────────────────────────────────────────────────────────────

test('isPathInside: a real child path is inside', () => {
    assert.strictEqual(box.isPathInside(path.join(TRANSCRIPTS, 'a', 'b.txt'), TRANSCRIPTS), true);
});

test('isPathInside: a "../" traversal escaping the parent is not inside', () => {
    const traversal = path.join(TRANSCRIPTS, '..', '..', 'etc', 'passwd');
    assert.strictEqual(box.isPathInside(traversal, TRANSCRIPTS), false);
});

test('isPathInside: a sibling folder whose name merely starts with the parent\'s is not inside', () => {
    const sibling = `${TRANSCRIPTS}_evil`;
    assert.strictEqual(box.isPathInside(path.join(sibling, 'x.txt'), TRANSCRIPTS), false,
        'this is exactly what a bare .startsWith(FOLDER) check gets wrong');
});

test('isPathInside: a folder is not "inside" itself', () => {
    assert.strictEqual(box.isPathInside(TRANSCRIPTS, TRANSCRIPTS), false);
});

// ─── canWritePath ────────────────────────────────────────────────────────────

test('canWritePath rejects a symlink inside the transcripts folder that resolves outside it', () => {
    const victim = path.join(OUTSIDE, 'canwrite-victim.txt');
    fs.writeFileSync(victim, 'precious data');
    const link = path.join(TRANSCRIPTS, 'canwrite-escape.txt');
    fs.symlinkSync(victim, link);
    try {
        assert.strictEqual(box.canWritePath(link), false,
            'a symlink whose OWN path lies inside TRANSCRIPTS_FOLDER but whose target resolves outside it must not be writable — this is exactly what transcripts:rename\'s canWritePath gate exists to reject');
    } finally {
        fs.unlinkSync(link);
    }
});

test('canWritePath allows a new (not-yet-existing) file inside a managed folder', () => {
    const target = path.join(TRANSCRIPTS, 'brand-new-file.txt');
    assert.strictEqual(fs.existsSync(target), false);
    assert.strictEqual(box.canWritePath(target), true);
});

test('canWritePath rejects a dangling symlink at a uniqueFilePath-picked path', () => {
    // uniqueFilePath only ever calls fs.existsSync, which follows a symlink to
    // its target — a dangling one (target since deleted) reports false, so
    // uniqueFilePath hands back the same colliding name as "free". canWritePath
    // must independently refuse it via lstatSync, which sees the symlink node
    // itself whether or not its target still exists.
    const target = path.join(TRANSCRIPTS, 'dangling-target.txt');
    fs.writeFileSync(target, 'x');
    const link = path.join(TRANSCRIPTS, 'dangling-link.txt');
    fs.symlinkSync(target, link);
    fs.unlinkSync(target); // now dangling
    try {
        assert.strictEqual(fs.existsSync(link), false,
            'existsSync follows the symlink and reports false for a dangling link — this is the trap');
        const picked = box.uniqueFilePath(TRANSCRIPTS, 'dangling-link', '.txt');
        assert.strictEqual(picked, link, 'uniqueFilePath, keyed only on existsSync, treats the dangling link as free');
        assert.strictEqual(box.canWritePath(picked), false,
            'a dangling symlink must still be refused as a write target');
    } finally {
        fs.unlinkSync(link);
    }
});

// ─── writeFileAtomic ─────────────────────────────────────────────────────────

test('writeFileAtomic replaces a symlink at the target path, leaving the symlink\'s target untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-atomic-'));
    try {
        const victim = path.join(dir, 'victim.txt');
        fs.writeFileSync(victim, 'precious data');
        const linkPath = path.join(dir, 'Title 01-01-26.summary.md');
        fs.symlinkSync(victim, linkPath);

        box.writeFileAtomic(linkPath, 'new summary content');

        assert.strictEqual(fs.readFileSync(victim, 'utf-8'), 'precious data',
            'a planted symlink must not redirect the write onto its target');
        assert.strictEqual(fs.lstatSync(linkPath).isSymbolicLink(), false,
            'the rename must replace the symlink itself, not follow it');
        assert.strictEqual(fs.readFileSync(linkPath, 'utf-8'), 'new summary content');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ─── Source-scan: the fix must not regress behind a future edit ────────────

test('no bare startsWith(...FOLDER) containment check is left in main.js', () => {
    assert.ok(!/\.startsWith\(TRANSCRIPTS_FOLDER\)/.test(MAIN),
        'a startsWith(TRANSCRIPTS_FOLDER) containment check has crept back in — use isPathInside');
    assert.ok(!/\.startsWith\(RECORDINGS_FOLDER\)/.test(MAIN),
        'a startsWith(RECORDINGS_FOLDER) containment check has crept back in — use isPathInside');
});

test('summary:save and summary:overwrite write through writeFileAtomic, not a plain fs.writeFileSync', () => {
    for (const channel of ['summary:save', 'summary:overwrite']) {
        const start = MAIN.indexOf(`ipcMain.handle('${channel}'`);
        assert.notStrictEqual(start, -1, `${channel} handler not found in main.js`);
        const handler = sliceBraces(MAIN, start, channel);
        assert.ok(/writeFileAtomic\(/.test(handler), `${channel} must write through writeFileAtomic`);
        assert.ok(!/fs\.writeFileSync\(/.test(handler),
            `${channel} must not fall back to a plain fs.writeFileSync — it follows a planted symlink`);
    }
});

// ─── transcripts:list / transcripts:search symlink-skip ────────────────────

test('lstatSync (unlike statSync) treats a symlinked .txt as not-a-file, so it is skipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-list-'));
    try {
        const victim = path.join(dir, 'victim.txt');
        fs.writeFileSync(victim, 'arbitrary file content the list/search must not surface');
        const link = path.join(dir, 'planted.txt');
        fs.symlinkSync(victim, link);

        assert.strictEqual(fs.statSync(link).isFile(), true,
            'documents the old bug: statSync follows the symlink and reports a regular file');
        assert.strictEqual(fs.lstatSync(link).isFile(), false,
            'lstatSync sees the symlink itself, not its target — this is what makes the handlers skip it');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('transcripts:list and transcripts:search use lstatSync, not a symlink-following statSync', () => {
    for (const channel of ['transcripts:list', 'transcripts:search']) {
        const start = MAIN.indexOf(`ipcMain.handle('${channel}'`);
        const handler = sliceBraces(MAIN, start, channel);
        assert.ok(/fs\.lstatSync\(/.test(handler), `${channel} must gate entries through fs.lstatSync`);
    }
});

test('WHISPER_MODEL_RE accepts a real model name and rejects path-traversal-shaped ones', () => {
    assert.strictEqual(box.WHISPER_MODEL_RE.test('openai_whisper-large-v3_turbo'), true);
    assert.strictEqual(box.WHISPER_MODEL_RE.test('openai_whisper-tiny.en'), true);
    assert.strictEqual(box.WHISPER_MODEL_RE.test('../../etc/passwd'), false);
    assert.strictEqual(box.WHISPER_MODEL_RE.test('openai_whisper-../../etc'), false);
    assert.strictEqual(box.WHISPER_MODEL_RE.test('openai_whisper-a/b'), false);
    assert.strictEqual(box.WHISPER_MODEL_RE.test('not-openai-shaped'), false);
});

test('WHISPER_MODEL_RE gates every renderer-supplied model-name entry point', () => {
    const count = (MAIN.match(/WHISPER_MODEL_RE\.test\(/g) || []).length;
    assert.ok(count >= 4,
        `expected WHISPER_MODEL_RE.test( at live:start/live:downloadModel/runRecordTranscribeJob/record:deleteModel (>=4), got ${count}`);
});

test('transcripts:getAudioPath refuses a path outside the managed folders before calling findRelatedAudioPaths', () => {
    const start = MAIN.indexOf(`ipcMain.handle('transcripts:getAudioPath'`);
    const handler = sliceBraces(MAIN, start, 'transcripts:getAudioPath handler');
    assert.ok(/if \(!canReadPath\(filePath\)\) return null;/.test(handler),
        'transcripts:getAudioPath must reject an un-readable path before it ever reaches findRelatedAudioPaths');
});

test('transcripts:rename requires canWritePath, not just isPathInside, since it is the one delete/rename handler that also writes', () => {
    const start = MAIN.indexOf(`ipcMain.handle('transcripts:rename'`);
    const handler = sliceBraces(MAIN, start, 'transcripts:rename handler');
    assert.ok(/canWritePath\(filePath\)/.test(handler),
        'transcripts:rename must require canWritePath(filePath) alongside isPathInside — see the canWritePath sandbox tests above for why isPathInside alone is not enough');
});

console.log('path-guards: all checks passed');
