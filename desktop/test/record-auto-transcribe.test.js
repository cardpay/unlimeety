'use strict';
// node test/record-auto-transcribe.test.js
//
// Stop & save no longer parks a recording for later — it queues the
// transcription immediately. Two helpers in renderer/record/record.js carry the
// whole decision, and both have a way to be quietly wrong:
//
//   * autoTranscribeArgs() picks the file, the language and the calendar
//     participants. Return a path when there is none and main gets asked to
//     transcribe ''; drop the participants and the calendar pre-fill silently
//     stops reaching the transcript's "Participants:" line.
//   * paintLangSegs() is what keeps the recording screen's picker and the
//     settings screen's picker showing the same selection. They write one
//     setting, so a picker painting from its own copy would show a language the
//     job is not using.
//
// renderer/record/record.js is a classic <script> inside an IIFE with no
// exports, so the region between the `// ── auto-transcribe ──` markers is read
// off disk and evaluated — the same technique rail-sections.test.js and
// transcript-meta.test.js use on renderer/app.js. Parsing it with `new
// vm.Script` first means a stray brace fails loudly instead of running a
// truncated function.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

const SRC = path.join(__dirname, '..', 'renderer', 'record', 'record.js');
const src = fs.readFileSync(SRC, 'utf-8');

const m = src.match(/\n[ \t]*\/\/ ── auto-transcribe ──[\s\S]*?\n[ \t]*\/\/ ── end auto-transcribe ──/);
assert.ok(m, '"auto-transcribe" region markers not found in renderer/record/record.js');
const region = m[0];
new vm.Script(region, { filename: 'slice:auto-transcribe' });

// This realm, not a fresh context: a separate context would give the helper's
// object and array literals a different Object/Array prototype, and
// deepStrictEqual compares those. The IIFE keeps the declarations out of the
// test process's globals.
const { autoTranscribeArgs, paintLangSegs } = vm.runInThisContext(
    `(() => {${region}\nreturn { autoTranscribeArgs, paintLangSegs };})()`,
    { filename: 'slice:auto-transcribe' },
);

// ─── State fixtures ──────────────────────────────────────────────────────────

const stateWith = (over = {}) => ({
    outputPath: '/rec/session.wav',
    batchSettings: { language: 'ru' },
    calendarParticipants: [],
    ...over,
});

// ─── autoTranscribeArgs ──────────────────────────────────────────────────────

test('takes the language picked while recording, not a default', () => {
    const st = stateWith({ batchSettings: { language: 'sr' } });
    assert.deepStrictEqual(autoTranscribeArgs({ path: '/rec/a.wav' }, st), {
        filePath: '/rec/a.wav',
        language: 'sr',
        participants: [],
    });
});

test("prefers main's canonical path over the one start() reported", () => {
    const st = stateWith({ outputPath: '/rec/stale.wav' });
    assert.strictEqual(autoTranscribeArgs({ path: '/rec/final.wav' }, st).filePath, '/rec/final.wav');
});

test('falls back to the reported path when the event carries none', () => {
    const st = stateWith({ outputPath: '/rec/started.wav' });
    assert.strictEqual(autoTranscribeArgs({}, st).filePath, '/rec/started.wav');
});

test('returns null when there is no file at all — nothing to queue', () => {
    // The alternative is submitting a job for '' and surfacing a failure the
    // user cannot act on.
    assert.strictEqual(autoTranscribeArgs({}, stateWith({ outputPath: null })), null);
    assert.strictEqual(autoTranscribeArgs({ path: '' }, stateWith({ outputPath: '' })), null);
    assert.strictEqual(autoTranscribeArgs(null, stateWith({ outputPath: null })), null);
});

test('carries calendar participants through to the transcript header', () => {
    const st = stateWith({ calendarParticipants: ['Ada', 'Grace'] });
    assert.deepStrictEqual(autoTranscribeArgs({ path: '/rec/a.wav' }, st).participants, ['Ada', 'Grace']);
});

test('normalises a missing or malformed participants list to empty', () => {
    for (const bad of [undefined, null, 'Ada', {}]) {
        const st = stateWith({ calendarParticipants: bad });
        assert.deepStrictEqual(autoTranscribeArgs({ path: '/rec/a.wav' }, st).participants, []);
    }
});

test("passes 'auto' straight through — the helper maps it to detection", () => {
    const st = stateWith({ batchSettings: { language: 'auto' } });
    assert.strictEqual(autoTranscribeArgs({ path: '/rec/a.wav' }, st).language, 'auto');
});

test('passes an unrecognised persisted language through unchanged', () => {
    // Reachable through a hand-edited `record.batchSettings` in localStorage, or
    // an older schema. (Not through the dead "More…" button — its handler
    // early-returned, so that value was never persistable.) Repairing stale
    // settings is not this helper's job; passing the value on keeps the failure
    // visible instead of silently transcribing in the wrong language.
    const st = stateWith({ batchSettings: { language: 'xx-unknown' } });
    assert.strictEqual(autoTranscribeArgs({ path: '/rec/a.wav' }, st).language, 'xx-unknown');
});

test('skips a sub-second recording — nothing there to transcribe', () => {
    // A mis-clicked Start/Stop would otherwise spend a large-v3 run to fail
    // with "produced no text". The wav is still saved and still listed under
    // "To transcribe", so the user loses nothing.
    assert.strictEqual(autoTranscribeArgs({ path: '/rec/a.wav', durationSec: 0.4 }, stateWith()), null);
});

test('queues anything long enough, and anything of unknown length', () => {
    // An older helper emits no durationSec. Treating "unknown" as "too short"
    // would silently stop transcribing on every stop.
    assert.ok(autoTranscribeArgs({ path: '/rec/a.wav', durationSec: 1 }, stateWith()));
    assert.ok(autoTranscribeArgs({ path: '/rec/a.wav', durationSec: 42.3 }, stateWith()));
    assert.ok(autoTranscribeArgs({ path: '/rec/a.wav' }, stateWith()));
    assert.ok(autoTranscribeArgs({ path: '/rec/a.wav', durationSec: 0 }, stateWith()));
    assert.ok(autoTranscribeArgs({ path: '/rec/a.wav', durationSec: 'nope' }, stateWith()));
});

// ─── paintLangSegs ───────────────────────────────────────────────────────────

/// Minimal stand-in for a `.ts-seg-wrap`: only `querySelectorAll`,
/// `classList.toggle` and `setAttribute` — what the helper actually calls.
function fakePicker(langs) {
    const segs = langs.map((lang) => ({
        dataset: { lang },
        active: false,
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        classList: {
            toggle(name, on) {
                assert.strictEqual(name, 'is-active');
                this.owner.active = on;
            },
        },
    }));
    for (const s of segs) s.classList.owner = s;
    return { segs, querySelectorAll: () => segs };
}
const selected = (picker) => picker.segs.filter((s) => s.active).map((s) => s.dataset.lang);
const ariaChecked = (picker) => picker.segs.filter((s) => s.attrs['aria-checked'] === 'true').map((s) => s.dataset.lang);

const LANGS = ['ru', 'en', 'sr', 'es', 'de', 'fr', 'auto'];

test('paints both pickers from one value, so they cannot disagree', () => {
    const rec = fakePicker(LANGS);
    const batch = fakePicker(LANGS);
    paintLangSegs([rec, batch], 'de');
    assert.deepStrictEqual(selected(rec), ['de']);
    assert.deepStrictEqual(selected(batch), ['de']);
});

test('aria-checked tracks the same value the highlight does', () => {
    // The pills are buttons; without this a screen reader hears seven options
    // and no answer to "which one is on".
    const rec = fakePicker(LANGS);
    paintLangSegs([rec], 'sr');
    assert.deepStrictEqual(ariaChecked(rec), ['sr']);
    paintLangSegs([rec], 'auto');
    assert.deepStrictEqual(ariaChecked(rec), ['auto']);
    assert.deepStrictEqual(selected(rec), ariaChecked(rec));
});

test('repainting clears the previous selection instead of stacking one', () => {
    const rec = fakePicker(LANGS);
    paintLangSegs([rec], 'de');
    paintLangSegs([rec], 'auto');
    assert.deepStrictEqual(selected(rec), ['auto']);
});

test('a language no picker lists leaves nothing selected, and does not throw', () => {
    const rec = fakePicker(LANGS);
    paintLangSegs([rec], 'more');
    assert.deepStrictEqual(selected(rec), []);
});

test('a picker absent from the DOM is skipped, not crashed on', () => {
    // recLangSeg is null until index.html has the recording-screen picker; the
    // shared painter runs on both tabs regardless.
    const batch = fakePicker(LANGS);
    paintLangSegs([null, batch, undefined], 'en');
    assert.deepStrictEqual(selected(batch), ['en']);
});

// ─── Wiring the helpers cannot check itself ──────────────────────────────────

test('recordSaved queues the transcription and keeps its section guard', () => {
    // In-process tests reach the helpers but not the event handler around them.
    // These two facts are what make the helpers matter, so they are asserted on
    // the source: the submit happens, and it does not drag the user off a
    // parallel transcription's screen.
    const handler = src.slice(src.indexOf("case 'recordSaved':"));
    const body = handler.slice(0, handler.indexOf('break;'));
    assert.ok(
        /autoTranscribeArgs\(event, state\)/.test(body),
        'recordSaved no longer derives its arguments from autoTranscribeArgs',
    );
    assert.ok(
        /api\.autoQueueTranscribe\(/.test(body),
        'recordSaved no longer queues a transcription on save',
    );
    assert.ok(
        /if \(state\.phase === 'recording'\) showSection\('idle'\)/.test(body),
        "recordSaved lost the guard that keeps a parallel transcription's screen up",
    );
});

test('an auto-stop reaches the same submit as the Stop button', () => {
    // The meeting-ended countdown fires `autoStop`, not a click. It must land on
    // stopAndSave so the submit — which hangs off recordSaved, not off the
    // button handler — happens for an unattended stop too.
    const handler = src.slice(src.indexOf("case 'autoStop':"));
    assert.ok(
        /stopAndSave\(\)/.test(handler.slice(0, handler.indexOf('break;'))),
        'autoStop no longer routes through stopAndSave',
    );
});

test('the idle screen banner follows the queue, not this tab\'s own bookkeeping', () => {
    // With no transcribing screen to switch to, that banner plus the header
    // queue panel are the only feedback a stop produces. It has to repaint from
    // the queue broadcast, or a job this tab did not submit leaves it dark.
    assert.ok(
        /function onQueueJobsChanged\([\s\S]{0,200}updateTransActiveBanner\(\)/.test(src),
        'the queue broadcast no longer refreshes the idle screen banner',
    );
    assert.ok(
        /queueApi\?\.onChanged\(onQueueJobsChanged\)/.test(src),
        'the tab no longer subscribes to queue changes',
    );
});

test('the auto path is never routed through the batch settings plumbing', () => {
    // buildTranscribeOpts carries the settings screen's model choice. Sending
    // the on-stop run through it would reintroduce a second model source next
    // to main's fixed large-v3.
    const handler = src.slice(src.indexOf("case 'recordSaved':"));
    const body = handler.slice(0, handler.indexOf('break;'));
    assert.strictEqual(/buildTranscribeOpts|startTranscription/.test(body), false);
});

// ─── The three-file IPC contract ─────────────────────────────────────────────

const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf-8');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

test('recordApi exposes autoQueueTranscribe on the channel main handles', () => {
    // Rename either side alone and Stop & save throws inside the event handler
    // with every other test still green — the feature ships inert. This is the
    // assertion that fails instead.
    assert.ok(
        /autoQueueTranscribe:\s*\([^)]*\)\s*=>\s*[\s\S]{0,120}?ipcRenderer\.invoke\('record:autoQueueTranscribe'/.test(PRELOAD),
        'preload.js no longer bridges autoQueueTranscribe to record:autoQueueTranscribe',
    );
    assert.ok(
        MAIN.includes("ipcMain.handle('record:autoQueueTranscribe'"),
        'main.js no longer registers the record:autoQueueTranscribe handler',
    );
});

test('every channel preload invokes has a handler in main', () => {
    // The bridge above is only one of many; the same rename can break any of
    // them, and nothing else in the suite checks the pair.
    const invoked = [...PRELOAD.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(invoked.length > 20, 'suspiciously few invoke() calls found — did preload.js change shape?');
    const missing = [...new Set(invoked)].filter((ch) => !MAIN.includes(`ipcMain.handle('${ch}'`));
    assert.deepStrictEqual(missing, []);
});

// ─── main's side of the participants plumbing ────────────────────────────────

/// Source of the top-level `function name(...) {...}` in main.js, brace-matched.
function sliceMainFunction(name) {
    const start = MAIN.indexOf(`\nfunction ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in main.js — renamed or moved?`);
    let depth = 0;
    for (let i = MAIN.indexOf('{', start); i < MAIN.length; i++) {
        if (MAIN[i] === '{') depth++;
        else if (MAIN[i] === '}' && --depth === 0) {
            const text = MAIN.slice(start, i + 1);
            new vm.Script(text, { filename: `slice:${name}` });
            return text;
        }
    }
    throw new Error(`unbalanced braces while slicing ${name}()`);
}

test('queueAutoTranscribe submits a fixed large-v3 diarized job with participants', () => {
    // The renderer tests stop at the IPC boundary. This is the other end: the
    // only reason the participants parameter exists is that it reaches `extra`,
    // where runRecordTranscribeJob reads it for the "Participants:" header.
    const text = sliceMainFunction('queueAutoTranscribe');
    const submitted = [];
    const make = new Function('queue', 'path', `${text}\nreturn queueAutoTranscribe;`);
    const fn = make(
        { submit: (type, key, opts) => { submitted.push({ type, key, opts }); return { id: 'j1' }; } },
        { basename: (p) => p.split('/').pop() },
    );

    fn('/rec/a.wav', 'sr', ['Ada', 'Grace']);
    assert.strictEqual(submitted.length, 1);
    const { type, opts } = submitted[0];
    assert.strictEqual(type, 'transcribe');
    assert.strictEqual(opts.extra.model, 'openai_whisper-large-v3');
    assert.strictEqual(opts.extra.diarize, true);
    assert.strictEqual(opts.extra.language, 'sr');
    assert.deepStrictEqual(opts.extra.participants, ['Ada', 'Grace']);
    // Left undefined on purpose — pyannote auto-detects the speaker count.
    assert.strictEqual(opts.extra.numberOfSpeakers, undefined);
});

test('queueAutoTranscribe keeps live:saveTranscript\'s two-argument call working', () => {
    const text = sliceMainFunction('queueAutoTranscribe');
    const submitted = [];
    const fn = new Function('queue', 'path', `${text}\nreturn queueAutoTranscribe;`)(
        { submit: (type, key, opts) => { submitted.push(opts); return { id: 'j1' }; } },
        { basename: (p) => p.split('/').pop() },
    );
    fn('/rec/live.wav', 'en');
    assert.deepStrictEqual(submitted[0].extra.participants, []);
});

test('queueAutoTranscribe defaults an absent language to detection, not Russian', () => {
    const submitted = [];
    const fn = new Function('queue', 'path', `${sliceMainFunction('queueAutoTranscribe')}\nreturn queueAutoTranscribe;`)(
        { submit: (type, key, opts) => { submitted.push(opts); return { id: 'j1' }; } },
        { basename: (p) => p.split('/').pop() },
    );
    // runRecordTranscribeJob's own fallback is 'ru'. Reaching it would transcribe
    // an unattended recording as Russian on the strength of a missing field.
    fn('/rec/a.wav', '');
    assert.strictEqual(submitted[0].extra.language, 'auto');
});

test('the IPC handler coerces a hostile participants value instead of forwarding it', () => {
    const start = MAIN.indexOf("ipcMain.handle('record:autoQueueTranscribe'");
    const text = MAIN.slice(start, MAIN.indexOf('\n});', start));
    assert.ok(/Array\.isArray\(participants\)/.test(text), 'participants reaches the queue unchecked');
    assert.ok(/canReadPath\(filePath\)/.test(text), 'the path confinement check is gone');
    assert.ok(/process\.platform !== 'darwin'/.test(text), 'the platform gate is gone');
});
