'use strict';
// node test/library-filters.test.js
//
// The Meetings sidebar chips are queues of work left to do — "To re-transcribe",
// "To enhance", "To summarize" — and each one has a way to lie. A weak-model
// meeting with no audio cannot be re-transcribed; a transcript with no spoken
// turns is one Enhance refuses; a transcript that failed to read has fabricated
// defaults for every flag a queue reads. Getting those wrong puts an entry in a
// queue the user cannot act on, which is worse than not listing it at all.
//
// renderer/app.js is a classic <script> with no exports, so the functions under
// test are sliced out by name and evaluated in a vm sandbox, with only the DOM
// each one actually touches stubbed. renderer-globals.test.js is the house
// precedent for reading renderer source as text; it regex-scans only, so the
// slicing and the sandbox are new here. Every slice is parsed with `new
// vm.Script` before it runs, so a brace inside a string cannot mis-slice
// silently.
//
// Two mutation passes shaped this file. Regex-over-source assertions kept
// passing while the feature was dead — a gate dropped from a `disabled`
// expression but left in the tooltip, a constant `"true"` in place of the
// aria-pressed ternary, a predicate flipped to `.length < 0` next to a test that
// re-implemented the predicate inline. So: execute the real code, assert on what
// it emits, and keep source-text checks for the few things no in-process test
// can reach.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const enhance = require('../transcript-enhance');

const DESKTOP = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(DESKTOP, 'renderer', 'app.js'), 'utf-8');
const htmlSrc = fs.readFileSync(path.join(DESKTOP, 'renderer', 'index.html'), 'utf-8');
const mainSrc = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf-8');

// ─── Slicing source into sandboxes ───────────────────────────────────────────

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

/// A `{` or `}` inside a string or a comment would end a slice in the wrong
/// place; parsing catches that instead of running a truncated function.
function checkParses(text, name) {
    new vm.Script(text, { filename: `slice:${name}` });
    return text;
}

/// Source of a top-level `function name(...) {...}`. Throws rather than
/// returning nothing: a renamed function must fail the suite loudly, not
/// quietly stop being covered.
function sliceFunction(src, name, where) {
    const start = src.indexOf(`\nfunction ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in ${where} — renamed or moved?`);
    return checkParses(sliceBraces(src, start, `${name}()`), name);
}

/// Source of a top-level `const NAME = { ... };` — the values matter, so they are
/// read from the shipped file rather than restated here.
function sliceConst(src, name) {
    const start = src.indexOf(`\nconst ${name} = {`);
    assert.notStrictEqual(start, -1, `const ${name} not found in renderer/app.js`);
    // `var`, not `const`: a lexical declaration in a vm context is not a
    // property of the sandbox object, so the test could not read the values back.
    const text = sliceBraces(src, start, `const ${name}`).replace(/^\nconst /, '\nvar ');
    return checkParses(`${text};`, name);
}

// ─── Renderer sandbox ────────────────────────────────────────────────────────

// Minimal fakes for the DOM the sliced functions touch. Only what they reach:
// the click listeners inside openMeetingMenu never fire here.
const fakeChip = (filter) => ({
    dataset: { filter },
    classes: new Set(),
    attrs: {},
    classList: {
        toggle(name, on) { if (on) this.owner.classes.add(name); else this.owner.classes.delete(name); },
    },
    setAttribute(k, v) { this.attrs[k] = v; },
});
const makeChips = (filters) => filters.map((f) => {
    const c = fakeChip(f);
    c.classList.owner = c;
    return c;
});

let queried = [];        // what document.querySelectorAll should answer with
let lastMenuHtml = '';   // innerHTML openMeetingMenu built

const sandbox = {
    // Module-level state the sliced functions close over.
    contentMatches: new Map(),
    meetings: [],
    searchQuery: '',
    activeFilter: 'all',
    contextMenu: null,
    console,
    window: { innerWidth: 1440, innerHeight: 900 },
    document: {
        querySelectorAll: () => queried,
        createElement: () => ({
            dataset: {},
            className: '',
            _html: '',
            set innerHTML(v) { this._html = v; lastMenuHtml = v; },
            get innerHTML() { return this._html; },
            addEventListener() {},
            querySelector: () => ({ addEventListener() {}, getBoundingClientRect: () => ({}) }),
            querySelectorAll: () => [],
        }),
        body: { appendChild() {} },
    },
    // Collaborators buildMeetingCard calls that are not what is under test.
    activeMeetingId: null,
    selectedRecordings: new Set(),
    modelChipHtml: () => '',
    formatMeetingStamp: () => 'STAMP',
    avatarStackHtml: () => '',
    enhancedChipTitle: () => 'ENHANCED',
    // Collaborators openMeetingMenu calls that are not what is under test.
    closeMeetingMenu: () => {},
    // The card's info popover: openMeetingMenu dismisses it so the two are
    // never on screen together.
    closeMeetingMeta: () => {},
    iconSvg: () => '<svg/>',
    escapeHtml: (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    activeJobFor: () => null,
};

const SLICED = [
    'modelIsStrong', 'modelLabel', 'modelWorthRedoing', 'meetingMatchesFilter',
    'meetingMatchesSearch', 'computeFilterCounts', 'emptyStateText', 'markActiveChip',
    'deriveStatus', 'stripMeetPrefix', 'deriveMeetingFromTranscript',
    'deriveMeetingFromRecording',
    'reasonTitle', 'openMeetingMenu',
    'statusPillHtml', 'formatMeetingDuration', 'formatMeetingSize',
    'highlightSnippet', 'buildMeetingCard',
];
vm.runInNewContext(
    // FILTERS first: FILTER_EMPTY_TEXT's own initializer reads it, and
    // meetingMatchesFilter reads it at call time.
    [sliceConst(appSrc, 'FILTERS'), sliceConst(appSrc, 'FILTER_EMPTY_TEXT'), sliceConst(appSrc, 'STATUS_LABELS'),
     ...SLICED.map((n) => sliceFunction(appSrc, n, 'renderer/app.js'))]
        .join('\n'),
    sandbox,
);
const {
    modelWorthRedoing, meetingMatchesFilter, meetingMatchesSearch, computeFilterCounts,
    deriveMeetingFromTranscript, deriveMeetingFromRecording, emptyStateText, markActiveChip,
    openMeetingMenu, buildMeetingCard, formatMeetingSize,
} = sandbox;

// ─── (a) Behavioral: one case per row of the spec's edge-case matrix ──────────

// A transcript row. hasTranscript is not decoration: the To summarize queue
// gates on it, so a fixture without it models nothing that exists on disk.
const meeting = (over) => ({
    hasAudio: false, hasTranscript: true, hasSummary: false, hasSpokenTurns: false,
    model: null, enhancedAt: null, enhanceAttemptedAt: null, interrupted: false, readFailed: false, ...over,
});

// An un-transcribed recording. Every queue flag is false as a finding, not as a
// default — there is no transcript to enhance, summarize or improve on.
const recording = (over) => ({
    hasAudio: true, hasTranscript: false, hasSummary: false, hasSpokenTurns: false,
    model: undefined, enhancedAt: undefined, enhanceAttemptedAt: undefined, readFailed: false, ...over,
});

// To transcribe: the only queue an audio-only row belongs to, and the only one
// that is about producing a transcript rather than improving one.
assert.strictEqual(meetingMatchesFilter(recording({}), 'transcribe'), true,
    'a recording with no transcript belongs in the To transcribe queue');
assert.strictEqual(meetingMatchesFilter(meeting({ hasAudio: true }), 'transcribe'), false,
    'a transcript is not waiting to be transcribed, audio or not');

// …and it belongs in no other queue. `!hasSummary` alone would have swept every
// recording into To summarize, offering an action it cannot run.
for (const q of ['retranscribe', 'enhance', 'summarize']) {
    assert.strictEqual(meetingMatchesFilter(recording({}), q), false,
        `an un-transcribed recording must not enter the ${q} queue`);
}

// A queue excludes a row whose own job is already in flight — same guard the
// menu item disables on — so it is never offered work already running.
sandbox.activeJobFor = (type, fp) => (type === 'transcribe' && fp === '/r/busy.wav' ? { id: 'j' } : null);
assert.strictEqual(meetingMatchesFilter(recording({ id: '/r/busy.wav' }), 'transcribe'), false,
    'a recording already being transcribed must not stay in To transcribe');
assert.strictEqual(meetingMatchesFilter(recording({ id: '/r/idle.wav' }), 'transcribe'), true,
    'a different recording with no job in flight is unaffected');
sandbox.activeJobFor = () => null;

// To re-transcribe. Worth redoing means "not the most accurate model available",
// so the app's own default — large-v3_turbo — is in the queue: turbo → large-v3
// is the upgrade users actually have.
assert.strictEqual(
    meetingMatchesFilter(meeting({ model: 'openai_whisper-medium', hasAudio: true }), 'retranscribe'),
    true, 'weak model with audio belongs in the re-transcribe queue');
assert.strictEqual(
    meetingMatchesFilter(meeting({ model: 'openai_whisper-large-v3_turbo', hasAudio: true }), 'retranscribe'),
    true, 'turbo is not the most accurate model — it belongs in the queue');
assert.strictEqual(
    meetingMatchesFilter(meeting({ model: 'openai_whisper-base', hasAudio: false }), 'retranscribe'),
    false, 'no audio means it cannot be re-transcribed at all');
assert.strictEqual(
    meetingMatchesFilter(meeting({ model: 'openai_whisper-large-v3', hasAudio: true }), 'retranscribe'),
    false, 'large-v3 proper is the best available — nothing to gain');
assert.strictEqual(
    meetingMatchesFilter(meeting({ model: null, hasAudio: true }), 'retranscribe'),
    false, 'unknown model is not evidence of a weak model');
// Interrupted overrides modelWorthRedoing: incomplete text is worth re-running
// even from the best model — large-v3 proper would otherwise never qualify.
assert.strictEqual(
    meetingMatchesFilter(meeting({ model: 'openai_whisper-large-v3', hasAudio: true, interrupted: true }), 'retranscribe'),
    true, 'a partial large-v3 transcript is still the clearest re-transcribe candidate there is');
assert.strictEqual(
    meetingMatchesFilter(meeting({ model: 'openai_whisper-large-v3', hasAudio: false, interrupted: true }), 'retranscribe'),
    false, 'interrupted does not bypass the hasAudio gate');
// The in-flight guard checks audioPath (the transcribe job's own key), not id.
sandbox.activeJobFor = (type, fp) => (type === 'transcribe' && fp === '/r/busy.wav' ? { id: 'j' } : null);
assert.strictEqual(
    meetingMatchesFilter(
        meeting({ model: 'openai_whisper-medium', hasAudio: true, audioPath: '/r/busy.wav' }), 'retranscribe'),
    false, 'already being re-transcribed — must not stay in the queue too');
sandbox.activeJobFor = () => null;

// The predicate is the filter's own; modelIsStrong() keeps its /large/i meaning
// so the provenance chip's colour does not move with it.
assert.strictEqual(modelWorthRedoing('openai_whisper-large-v3'), false);
assert.strictEqual(modelWorthRedoing('openai_whisper-large-v3_turbo'), true);
assert.strictEqual(modelWorthRedoing('openai_whisper-large-v3_turbo_632MB'), true,
    'a size-suffixed turbo is still turbo');
// A size-suffixed best model would otherwise sit in the queue forever: the only
// re-transcribe available reproduces the very same id.
assert.strictEqual(modelWorthRedoing('openai_whisper-large-v3_947MB'), false,
    'large-v3 with a size suffix IS the best model');
assert.strictEqual(modelWorthRedoing(''), false);
assert.strictEqual(modelWorthRedoing(undefined), false);
assert.strictEqual(sandbox.modelIsStrong('openai_whisper-large-v3_turbo'), true,
    'modelIsStrong must keep counting turbo as strong — the provenance chip depends on it');

// To enhance
assert.strictEqual(
    meetingMatchesFilter(meeting({ enhancedAt: null, hasSpokenTurns: true }), 'enhance'),
    true, 'never enhanced and has spoken turns');
assert.strictEqual(
    meetingMatchesFilter(meeting({ enhancedAt: null, hasSpokenTurns: false }), 'enhance'),
    false, 'no spoken turns — Enhance would refuse it');
assert.strictEqual(
    meetingMatchesFilter(meeting({ enhancedAt: '2026-08-01T10:00:00Z', hasSpokenTurns: true }), 'enhance'),
    false, 'already enhanced');
// Every proofreading part was rejected on an earlier run — a re-run would hit
// the identical rejection, so this must not sit in the queue forever either.
assert.strictEqual(
    meetingMatchesFilter(
        meeting({ enhancedAt: null, enhanceAttemptedAt: '2026-08-01T10:00:00Z', hasSpokenTurns: true }),
        'enhance',
    ),
    false, 'already attempted and rejected — re-running would not help');
sandbox.activeJobFor = (type, fp) => (type === 'enhance' && fp === '/t/busy.txt' ? { id: 'j' } : null);
assert.strictEqual(
    meetingMatchesFilter(meeting({ enhancedAt: null, hasSpokenTurns: true, id: '/t/busy.txt' }), 'enhance'),
    false, 'already being enhanced — must not stay in the queue too');
sandbox.activeJobFor = () => null;
// A partial's text is about to be replaced by the full re-transcription —
// proofreading it now is wasted work.
assert.strictEqual(
    meetingMatchesFilter(meeting({ enhancedAt: null, hasSpokenTurns: true, interrupted: true }), 'enhance'),
    false, 'an interrupted transcript must not enter To enhance');

// To summarize
assert.strictEqual(meetingMatchesFilter(meeting({ hasSummary: false }), 'summarize'), true);
assert.strictEqual(meetingMatchesFilter(meeting({ hasSummary: true }), 'summarize'), false);
assert.strictEqual(
    meetingMatchesFilter(meeting({ hasSummary: false, interrupted: true }), 'summarize'),
    false, 'an interrupted transcript must not enter To summarize either');
sandbox.activeJobFor = (type, fp) => (type === 'summarize' && fp === '/t/busy.txt' ? { id: 'j' } : null);
assert.strictEqual(
    meetingMatchesFilter(meeting({ hasSummary: false, id: '/t/busy.txt' }), 'summarize'),
    false, 'already being summarized — must not stay in the queue too');
sandbox.activeJobFor = () => null;
// A summary written before a later Enhance/Re-transcribe rewrote the
// transcript is stale — it must re-enter the queue exactly like "no summary"
// would, and the status pill must say so rather than "Summarized".
assert.strictEqual(
    meetingMatchesFilter(meeting({ hasSummary: true, summaryOutdated: true }), 'summarize'),
    true, 'an outdated summary belongs back in the To summarize queue');
assert.strictEqual(sandbox.deriveStatus(meeting({ hasSummary: true, summaryOutdated: true })), 'outdated');
assert.strictEqual(sandbox.deriveStatus(meeting({ hasSummary: true, summaryOutdated: false })), 'summarized');

// Read failure: every flag a queue would read is a fabricated default, so all
// three exclude it — including the one whose summary exists on disk but whose
// check never ran. It still shows under All.
const readFailed = meeting({
    readFailed: true, hasAudio: true, model: 'openai_whisper-medium', hasSpokenTurns: true,
});
assert.strictEqual(meetingMatchesFilter(readFailed, 'all'), true, 'a read failure still shows under All');
for (const q of ['retranscribe', 'enhance', 'summarize']) {
    assert.strictEqual(meetingMatchesFilter(readFailed, q), false,
        `read-failed meeting must not enter the ${q} queue`);
}
// The status pill must not present the fabricated defaults as findings —
// `failed` was already a defined pill with nothing driving it.
assert.strictEqual(sandbox.deriveStatus(readFailed), 'failed',
    'a read failure must not derive as "transcribed" from its fabricated hasTranscript default');

// Counts come off the whole list, and an exhausted queue reads 0 rather than
// falling back to the total.
const library = [
    meeting({ model: 'openai_whisper-medium', hasAudio: true, enhancedAt: '2026-08-01T10:00:00Z', hasSummary: true, hasSpokenTurns: true }),
    meeting({ model: 'openai_whisper-large-v3', hasAudio: true, enhancedAt: '2026-08-02T10:00:00Z', hasSummary: false, hasSpokenTurns: true }),
    readFailed,
];
assert.deepStrictEqual(
    // Spread into a host object: the sandbox's own Object.prototype is a
    // different realm's, which deepStrictEqual counts as a difference.
    { ...computeFilterCounts(library) },
    { all: 3, audio: 3, transcribe: 0, retranscribe: 1, enhance: 0, summarize: 1 },
    'every transcript enhanced → To enhance counts 0, and the read-failed row counts in none');

// One recording in the library moves exactly one count, and none of the others.
assert.deepStrictEqual(
    { ...computeFilterCounts([...library, recording({})]) },
    { all: 4, audio: 4, transcribe: 1, retranscribe: 1, enhance: 0, summarize: 1 },
    'a recording counts under To transcribe and under no other queue');

// Acceptance criterion: filter and search both apply, and the counts a chip
// shows are independent of the search box.
const searchable = [
    meeting({ title: 'Weekly sync', participants: [], hasSummary: false, id: 'a' }),
    meeting({ title: 'Retro', participants: [], hasSummary: false, id: 'b' }),
    meeting({ title: 'Weekly planning', participants: [], hasSummary: true, id: 'c' }),
];
const visible = searchable.filter(
    (m) => meetingMatchesFilter(m, 'summarize') && meetingMatchesSearch(m, 'weekly'));
assert.deepStrictEqual(visible.map((m) => m.id), ['a'],
    'an active queue chip and a search query must both narrow the list');
assert.deepStrictEqual(
    { ...computeFilterCounts(searchable) },
    { all: 3, audio: 0, transcribe: 0, retranscribe: 0, enhance: 0, summarize: 2 },
    'chip counts are computed off the unfiltered, unsearched list');

// The renderer's pass-through: an IPC-shaped item must arrive on the meeting
// with both new fields intact. Deleting the pass-through used to leave the
// To enhance chip permanently dead with the suite still green.
const derived = deriveMeetingFromTranscript({
    filePath: '/tmp/Meet_Transcripts/x.txt', filename: 'x.txt', createdAt: Date.now(),
    hasSummary: false, hasAudio: true, hasSpokenTurns: true, readFailed: false,
    model: 'openai_whisper-medium', enhancedAt: null, participants: [],
});
assert.strictEqual(derived.hasSpokenTurns, true, 'deriveMeetingFromTranscript drops hasSpokenTurns');
assert.strictEqual(derived.readFailed, false, 'deriveMeetingFromTranscript drops readFailed');
assert.strictEqual(
    meetingMatchesFilter(derived, 'enhance'), true,
    'a derived meeting with spoken turns must reach the To enhance queue');
const derivedFailed = deriveMeetingFromTranscript({
    filePath: '/tmp/Meet_Transcripts/y.txt', filename: 'y.txt', createdAt: Date.now(),
    hasSummary: false, hasAudio: false, hasSpokenTurns: false, readFailed: true, participants: [],
});
assert.strictEqual(derivedFailed.readFailed, true);
assert.strictEqual(meetingMatchesFilter(derivedFailed, 'summarize'), false);
// Absent fields (an older main, or a shape that never carried them) must read
// as false, never undefined.
const derivedBare = deriveMeetingFromTranscript({ filePath: '/tmp/z.txt', filename: 'z.txt' });
assert.strictEqual(derivedBare.hasSpokenTurns, false);
assert.strictEqual(derivedBare.readFailed, false);

// ─── The placeholder text, executed ─────────────────────────────────────────
// An exhausted queue over a full library must not read "No meetings yet". The
// call site used to be the only thing asserted, and deleting it kept the suite
// green while the bug came straight back.
sandbox.meetings = [];
sandbox.searchQuery = '';
sandbox.activeFilter = 'all';
assert.strictEqual(emptyStateText(), 'No meetings yet', 'an empty library says so');
sandbox.meetings = library;
assert.strictEqual(emptyStateText(), 'No meetings yet', 'the All chip over a library is still that');
for (const [filter, expected] of [
    ['transcribe', 'Nothing to transcribe'],
    ['retranscribe', 'Nothing to re-transcribe'],
    ['enhance', 'Nothing to enhance'],
    ['summarize', 'Nothing to summarize'],
]) {
    sandbox.activeFilter = filter;
    assert.strictEqual(emptyStateText(), expected,
        `an exhausted ${filter} queue must not claim the library is empty`);
}
sandbox.searchQuery = 'nothing matches this';
assert.strictEqual(emptyStateText(), 'No matches', 'a search that found nothing says so');
sandbox.activeFilter = 'all';
sandbox.searchQuery = '';
sandbox.meetings = [];

// ─── Selection, executed ────────────────────────────────────────────────────
// Exactly one chip pressed. A constant "true" in place of the ternary used to
// pass every assertion here.
queried = makeChips(['all', 'transcribe', 'retranscribe', 'enhance', 'summarize']);
markActiveChip('enhance');
assert.deepStrictEqual(
    queried.filter((c) => c.attrs['aria-pressed'] === 'true').map((c) => c.dataset.filter),
    ['enhance'], 'exactly one chip may be aria-pressed, and it is the selected one');
assert.deepStrictEqual(
    queried.filter((c) => c.classes.has('active')).map((c) => c.dataset.filter),
    ['enhance'], 'exactly one chip may carry .active, and it is the selected one');
markActiveChip('all');
assert.deepStrictEqual(
    queried.filter((c) => c.attrs['aria-pressed'] === 'true').map((c) => c.dataset.filter),
    ['all'], 'selecting another chip must unpress the previous one');

// ─── The menu, executed ─────────────────────────────────────────────────────
// The chips' invariant reaches the actions too. Asserted on emitted markup, not
// on the source of the gate: dropping `enhanceDisabled` from the `disabled`
// expression while leaving it in the tooltip satisfied every regex.
const menuFor = (m) => {
    lastMenuHtml = '';
    openMeetingMenu(10, 10, { id: 'x', title: 'T', ...m });
    return lastMenuHtml;
};
const itemOf = (html, action) => {
    const found = new RegExp(`<button[^>]*data-action="${action}"[^>]*>`).exec(html);
    assert.ok(found, `the ${action} menu item disappeared`);
    return found[0];
};

const noTurns = menuFor(meeting({ hasSpokenTurns: false }));
assert.ok(/disabled/.test(itemOf(noTurns, 'enhance')),
    'Enhance must be disabled with no spoken turns — the chip filters on the same field');
assert.ok(/No spoken turns/.test(itemOf(noTurns, 'enhance')), 'and must say why');

const withTurns = menuFor(meeting({ hasSpokenTurns: true }));
assert.ok(!/disabled/.test(itemOf(withTurns, 'enhance')),
    'Enhance must stay enabled when there are spoken turns');
assert.ok(!/title=/.test(itemOf(withTurns, 'enhance')), 'an enabled item needs no reason');

const failedMenu = menuFor(meeting({ readFailed: true, hasSummary: false, hasAudio: false }));
for (const action of ['enhance', 'summarize']) {
    assert.ok(/disabled/.test(itemOf(failedMenu, action)),
        `${action} must be disabled on a read-failed transcript — it would fail the same read`);
    assert.ok(/could not be read/.test(itemOf(failedMenu, action)),
        `${action} must name the read failure, not a fabricated reason`);
}
assert.ok(/disabled/.test(itemOf(failedMenu, 'retranscribe')),
    'Re-transcribe stays gated on audio, which a read failure cannot vouch for');

// No item may grey out without saying why — the gate and the tooltip come off
// one string per cause, so they cannot drift apart.
const noArtifacts = menuFor(meeting({ hasAudio: false, hasSummary: false, hasSpokenTurns: true }));
for (const action of ['retranscribe', 'delete-audio']) {
    assert.ok(/No audio file/.test(itemOf(noArtifacts, action)),
        `${action} must name the missing audio, not grey out silently`);
}
assert.ok(/No summary yet/.test(itemOf(noArtifacts, 'delete-summary')),
    'Delete summary must name the missing summary');

sandbox.activeJobFor = () => ({ id: 'job' });
const running = menuFor(meeting({ hasSpokenTurns: true }));
assert.ok(/disabled/.test(itemOf(running, 'enhance')), 'a running Enhance disables the item');
assert.ok(/already running/.test(itemOf(running, 'enhance')),
    'a control that greys out silently just looks broken');
sandbox.activeJobFor = () => null;

// An audio-only row: every item that reads or writes a .txt is off, and the one
// action it has is spelled Transcribe…, not Re-transcribe….
const audioOnlyMenu = menuFor(recording({}));
for (const action of ['summarize', 'enhance', 'delete-transcript']) {
    assert.ok(/disabled/.test(itemOf(audioOnlyMenu, action)),
        `${action} must be disabled on a recording with no transcript`);
    assert.ok(/Not transcribed yet/.test(itemOf(audioOnlyMenu, action)),
        `${action} must say the transcript is what is missing`);
}
assert.ok(!/disabled/.test(itemOf(audioOnlyMenu, 'retranscribe')),
    'transcribing is the one action a recording does have');
assert.ok(!/disabled/.test(itemOf(audioOnlyMenu, 'rename')),
    'renaming a recording moves the wav — it does not need a transcript');
assert.ok(!/disabled/.test(itemOf(audioOnlyMenu, 'delete-audio')),
    'the wav is exactly what there is to delete');
assert.ok(/>Transcribe…</.test(audioOnlyMenu) && !/Re-transcribe/.test(audioOnlyMenu),
    'nothing has been transcribed yet, so the label cannot say "Re-"');
assert.ok(itemOf(audioOnlyMenu, 'reveal'), 'a recording offers Show in Finder');
assert.ok(!/data-action="reveal"/.test(menuFor(meeting({ hasAudio: true }))),
    'Show in Finder is the recording row\'s item, not every row\'s');

// A transcribe job already running on the same wav — the queue keys on that
// exact path, so the item can see it.
sandbox.activeJobFor = (type) => (type === 'transcribe' ? { id: 'job' } : null);
const busyRec = menuFor(recording({}));
assert.ok(/disabled/.test(itemOf(busyRec, 'retranscribe')),
    'a transcription already running on this recording disables the item');
assert.ok(/already running/.test(itemOf(busyRec, 'retranscribe')), 'and must say why');
sandbox.activeJobFor = () => null;

// The recordings pass-through, end to end: a `record:list` row must derive into
// a meeting the To transcribe queue accepts and no other queue does.
const derivedRec = deriveMeetingFromRecording({
    filePath: '/tmp/Meet_Recordings/a.wav', filename: 'a.wav',
    createdAt: Date.now(), mtime: Date.now(), size: 4096, hasTranscript: false,
});
assert.strictEqual(derivedRec.id, '/tmp/Meet_Recordings/a.wav',
    'the wav path is the id — every record:* handler takes exactly that');
assert.strictEqual(derivedRec.audioPath, derivedRec.id);
assert.strictEqual(derivedRec.transcriptPath, null);
assert.strictEqual(derivedRec.hasTranscript, false);
assert.strictEqual(derivedRec.status, 'audio_only',
    'deriveStatus must report a transcript-less recording as audio_only');
assert.strictEqual(meetingMatchesFilter(derivedRec, 'transcribe'), true);
for (const q of ['retranscribe', 'enhance', 'summarize']) {
    assert.strictEqual(meetingMatchesFilter(derivedRec, q), false,
        `a derived recording must not reach the ${q} queue`);
}
assert.strictEqual(deriveMeetingFromRecording({}), null, 'a row without a path is not a meeting');

// ─── The card, executed ─────────────────────────────────────────────────────
// The checkbox is the only route into batch transcription now that the Record
// sidebar is gone, and its gate is one boolean nothing else observes.
// `status` the way deriveStatus would have set it — the filter fixtures above
// model predicates, not derived records, so they carry none.
const asCard = (m) => ({
    id: '/r/a.wav', title: 'T', date: new Date(0),
    status: m.hasTranscript === false ? 'audio_only' : 'transcribed', ...m,
});
const cardHtml = (m) => {
    sandbox.selectedRecordings.clear();
    return buildMeetingCard(asCard(m))._html;
};

assert.ok(/class="meeting-pick"/.test(cardHtml(recording({}))),
    'a recording must offer a checkbox — it is the only way into a batch');
assert.ok(!/class="meeting-pick"/.test(cardHtml(meeting({ hasAudio: true }))),
    'a transcript is not batch-transcribable, so it gets no checkbox');
assert.ok(/aria-label="Select T for batch transcription"/.test(cardHtml(recording({}))),
    'the checkbox must name its own row, not carry one shared string');

// A wav already in the transcribe lane: re-submitting queues it twice and
// deleting it kills the run, so the row is neither selectable nor silent.
sandbox.activeJobFor = (type, fp) => (type === 'transcribe' && fp === '/r/busy.wav' ? { id: 'j' } : null);
const busyCard = cardHtml(recording({ id: '/r/busy.wav' }));
assert.ok(!/class="meeting-pick"/.test(busyCard),
    'a recording being transcribed must not be selectable');
assert.ok(/<span class="status-pill" data-status="transcribing"/.test(busyCard),
    'the card must say a transcription is running');
assert.ok(/class="meeting-progress"/.test(busyCard),
    'and show the in-flight bar the deleted sidebar used to draw per card');
const idleCard = cardHtml(recording({ id: '/r/idle.wav' }));
assert.ok(/Audio only/.test(idleCard) && !/class="meeting-progress"/.test(idleCard),
    'a recording with no job stays Audio only');
sandbox.activeJobFor = () => null;

// A checked row must render checked, or the selection is invisible on repaint.
sandbox.selectedRecordings.add('/r/a.wav');
assert.ok(/checked/.test(buildMeetingCard(asCard(recording({})))._html),
    'a selected recording must repaint as checked');
sandbox.selectedRecordings.clear();

// A read-failed row: one honest badge, never the four fabricated artifact
// chips (hasAudio/hasTranscript/enhancedAt/hasSummary are all defaults here,
// not findings).
const failedCard = cardHtml({ readFailed: true, status: 'failed', hasAudio: false, hasSummary: false });
assert.ok(/artifact-chip--error/.test(failedCard) && /Couldn't read/.test(failedCard),
    'a read-failed card shows the error badge');
assert.ok(!/data-kind="audio"/.test(failedCard) && !/data-kind="transcript"/.test(failedCard),
    'a read-failed card must not render the fabricated artifact chips');

// Size stands in for the duration record:list does not report. Below a megabyte
// the MB form read "0.0 MB", which is what an empty file looks like.
assert.strictEqual(formatMeetingSize(0), '');
assert.strictEqual(formatMeetingSize(62 * 1024), '62 KB');
assert.strictEqual(formatMeetingSize(500), '1 KB', 'a tiny file is not zero-sized');
assert.strictEqual(formatMeetingSize(5 * 1024 * 1024), '5.0 MB');
assert.strictEqual(formatMeetingSize(36 * 1024 * 1024), '36 MB');
assert.strictEqual(formatMeetingSize(2 * 1024 * 1024 * 1024), '2.0 GB');
assert.ok(/62 KB/.test(cardHtml(recording({ sizeBytes: 62 * 1024 }))),
    'the card shows the size where a duration would go');

// ─── The real spoken-turns predicate, on real files ─────────────────────────
// The shipped function, not a re-implementation: flipping `.length > 0` to
// `.length < 0` inside it used to leave every chip dead and the suite green.
// NOTE_LABEL is read from main.js for the same reason — parity with the Enhance
// job is the whole point of this field.
const noteLabel = /const NOTE_LABEL = '([^']+)'/.exec(mainSrc);
assert.ok(noteLabel, 'NOTE_LABEL could not be read from main.js');

const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'library-filters-'));
try {
    const write = (name, body) => {
        const p = path.join(fixtures, name);
        fs.writeFileSync(p, body, 'utf-8');
        return p;
    };
    const hasSpokenTurns = (file) =>
        enhance.hasSpokenTurns(fs.readFileSync(file, 'utf-8'), noteLabel[1]);

    assert.strictEqual(hasSpokenTurns(write('turns.txt',
        'Meeting: Weekly\nModel: openai_whisper-medium\n\n[00:01] Alice:\nHello there\n\n[00:07] Bob:\nHi\n')),
    true, 'a transcript with spoken turns');
    assert.strictEqual(hasSpokenTurns(write('notes.txt',
        `Meeting: Weekly\n\n[00:01] ${noteLabel[1]}:\nremember to send the deck\n`)),
    false, 'notes are the user\'s own typing — Enhance refuses them');
    assert.strictEqual(hasSpokenTurns(write('prose.txt',
        'Meeting: Pasted\n\nJust prose someone pasted in, with no [mm:ss] markers at all.\n')),
    false, 'marker-less prose has no turns to enhance');
} finally {
    fs.rmSync(fixtures, { recursive: true, force: true });
}

// ─── main's cache, executed ─────────────────────────────────────────────────
// Sliced out the same way: main.js requires electron, so it cannot be required,
// but this function is pure over the Map and the enhance module it closes over.
const cacheSandbox = (enhanceStub) => {
    const box = {
        spokenTurnsIndex: new Map(),
        enhance: enhanceStub || enhance,
        NOTE_LABEL: noteLabel[1],
        console: { warn() {} },
    };
    vm.runInNewContext(sliceFunction(mainSrc, 'cachedHasSpokenTurns', 'main.js'), box);
    return box;
};

const TURNS = 'Meeting: x\n\n[00:01] Alice:\nHello there\n';
const box = cacheSandbox();
assert.strictEqual(box.cachedHasSpokenTurns('/t/a.txt', 100, TURNS), true);
assert.deepStrictEqual([...box.spokenTurnsIndex.keys()], ['/t/a.txt'], 'the answer is remembered');

// Same mtime and same length: the body is not looked at again. The replacement
// has no turns at all, so a re-parse would answer false.
const sameLenNoTurns = 'x'.repeat(TURNS.length);
assert.strictEqual(box.cachedHasSpokenTurns('/t/a.txt', 100, sameLenNoTurns), true,
    'an unchanged file must be served from the cache, not re-parsed');
// Either half of the key moving means a re-scan.
assert.strictEqual(box.cachedHasSpokenTurns('/t/a.txt', 101, sameLenNoTurns), false,
    'a new mtime must re-scan');
assert.strictEqual(box.cachedHasSpokenTurns('/t/a.txt', 101, `${sameLenNoTurns}x`), false,
    'a new byte length must re-scan — two writes can share a millisecond');
assert.strictEqual(box.cachedHasSpokenTurns('/t/a.txt', 101, TURNS.slice(0, TURNS.length - 1) + ' '), true,
    'and the re-scan is a real one');

// A throwing scan costs the flag and nothing else: it must not escape into the
// caller's try (which would collapse the whole row into the read-failed
// fallback), and it must not be cached as a genuine "no turns".
for (const thrown of [new Error('boom'), 'a bare string', Symbol('no message'), null]) {
    const t = cacheSandbox({ hasSpokenTurns() { throw thrown; } });
    assert.strictEqual(t.cachedHasSpokenTurns('/t/b.txt', 1, 'body'), false,
        `a ${String(typeof thrown)} throw must be contained`);
    assert.strictEqual(t.spokenTurnsIndex.size, 0,
        'a failed scan must not be cached — false would be indistinguishable from "no turns"');
}

// ─── (b) Static drift guard: chips, branches, counts and main's fields ───────

const filterRow = /<div class="library-filters"[^>]*>([\s\S]*?)<\/div>/.exec(htmlSrc);
assert.ok(filterRow, 'the .library-filters chip row could not be found in index.html');
// One record per chip, so selection can be asserted rather than pattern-matched:
// the old regex passed with `active` sitting on a different chip than `all`.
const chipTags = filterRow[1].split('<button').slice(1).map((tag) => ({
    filter: /data-filter="([^"]+)"/.exec(tag)?.[1],
    active: /class="[^"]*\bactive\b/.test(tag),
    pressed: /aria-pressed="true"/.test(tag),
    title: /title="([^"]+)"/.exec(tag)?.[1],
    label: /aria-label="([^"]+)"/.exec(tag)?.[1],
    count: /class="filter-count" data-count="([^"]+)"/.exec(tag)?.[1],
}));
const chips = chipTags.map((c) => c.filter);
assert.deepStrictEqual(
    chips, ['all', 'transcribe', 'retranscribe', 'enhance', 'summarize'],
    'the chip row is exactly All + the four work queues, All first');
assert.deepStrictEqual(
    chipTags.filter((c) => c.active).map((c) => c.filter), ['all'],
    'All must be the one chip marked .active in the markup');
assert.deepStrictEqual(
    chipTags.filter((c) => c.pressed).map((c) => c.filter), ['all'],
    'All must be the one chip marked aria-pressed in the markup');
assert.ok(/let activeFilter = "all"/.test(appSrc), 'activeFilter must default to "all"');

// Filter toggles, not tabs — but the row still needs a name, which the removed
// tablist role used to provide.
assert.ok(!/role="tab(list)?"/.test(filterRow[0]), 'the chip row must not use tab roles');
assert.ok(/role="group"/.test(filterRow[0]) && /aria-label="[^"]+"/.test(filterRow[0]),
    'the chip row needs role=group and a label of its own');
for (const chip of chipTags) {
    assert.ok(chip.title, `chip '${chip.filter}' must state its criterion in a title`);
    // title is mouse-only and announced unreliably; the same sentence has to be
    // in the accessible name.
    assert.ok(chip.label && chip.label.toLowerCase().includes(chip.title.toLowerCase()),
        `chip '${chip.filter}' must carry its criterion in aria-label too`);
    assert.ok(chip.count === chip.filter, `chip '${chip.filter}' has no matching .filter-count span`);
}

// meetingMatchesFilter, the count-loop in renderMeetings and FILTER_EMPTY_TEXT
// all derive from one FILTERS table now (see renderer/app.js), so there is
// exactly one remaining place drift can enter: FILTERS itself vs the chip row
// in index.html. Checking that directly is both simpler and stronger than
// grepping for a per-filter branch that no longer exists.
assert.deepStrictEqual(
    [...Object.keys(sandbox.FILTERS)].sort(), [...chips.filter((c) => c !== 'all')].sort(),
    'FILTERS must have exactly one entry per non-"all" chip in index.html — a mismatch either shows ' +
    'everything for a chip with no entry, or leaves a table entry unreachable');
// Confirms the count-loop still derives its kind list from FILTERS rather than
// a separately-typed literal, which is what made the two driftable in the
// first place.
assert.ok(/for \(const kind of \["all", \.\.\.Object\.keys\(FILTERS\)\]\)/.test(appSrc),
    "renderMeetings' count-loop must derive its kind list from FILTERS, not a separate literal");
// `?? 0` in that loop turns a missing counter into a permanent, silent 0, so the
// counts object has to cover every chip on its own.
const counted = computeFilterCounts([meeting({})]);
assert.deepStrictEqual(
    chips.filter((c) => !(c in counted)), [],
    'computeFilterCounts must produce a count for every chip');

// The placeholder element the filter-aware text is written into, and one line
// per chip to write.
assert.ok(/id="library-empty-text"/.test(htmlSrc),
    'the placeholder needs #library-empty-text — without it the filter-aware text goes nowhere');
// Scoped to the placeholder's own tag: another element on the page already uses
// aria-live, and a file-wide scan was satisfied by that one.
const emptyTag = /<div id="library-empty"[^>]*>/.exec(htmlSrc);
assert.ok(emptyTag, 'the #library-empty placeholder could not be found');
assert.ok(/aria-live="polite"/.test(emptyTag[0]),
    'the placeholder text now changes with the filter — it must announce that');
assert.ok(/libraryEmptyText\.textContent = emptyStateText\(\)/.test(appSrc),
    'renderMeetings must actually write the filter-aware placeholder text');
const emptyKinds = Object.keys(sandbox.FILTER_EMPTY_TEXT);
assert.deepStrictEqual(
    [...emptyKinds].sort(), [...chips].sort(),
    'every chip needs its own empty-state line in FILTER_EMPTY_TEXT');

// "The most accurate model available" is a claim about the model list, so tie it
// to the list: shipping a better model should fail here, not quietly empty the
// queue by leaving large-v3 as the only exempt id.
const cards = [...htmlSrc.matchAll(/data-model="([^"]+)"[^>]*data-quality="([^"]+)"/g)]
    .map((m) => ({ model: m[1], quality: Number(m[2]) }));
assert.ok(cards.length >= 6, 'the transcription model cards could not be read from index.html');
const best = cards.reduce((a, b) => (b.quality > a.quality ? b : a));
assert.strictEqual(best.model, 'openai_whisper-large-v3',
    'modelWorthRedoing exempts large-v3 as the most accurate model — a better one shipped, so update it');
assert.strictEqual(modelWorthRedoing(best.model), false, 'the best model is never worth redoing');
for (const card of cards.filter((c) => c.model !== best.model)) {
    assert.strictEqual(modelWorthRedoing(card.model), true,
        `${card.model} is not the best model, so it belongs in the queue`);
}

// ─── main.js: the parts no in-process test can reach ────────────────────────
// Scoped to the transcripts:list handler, so an unrelated `catch` elsewhere in a
// 4000-line file cannot satisfy these.
const listStart = mainSrc.indexOf("ipcMain.handle('transcripts:list'");
const listSrc = sliceBraces(mainSrc, listStart, 'the transcripts:list handler');
// The per-file callback, not the whole handler: the handler holds three
// try/catch pairs and only this one builds the row the renderer sees.
const mapSrc = sliceBraces(listSrc, listSrc.indexOf('.map(f => {'), "transcripts:list' row builder");
const [successBranch, catchBranch] = mapSrc.split(/\}\s*catch\b/);
assert.ok(catchBranch, 'the per-file row builder has no catch branch any more');

// The returned object literal, not the branch text: computing the flag into a
// local and then forgetting to return it is exactly the mutation that left the
// To enhance chip dead with the suite green.
const returned = (branch, what) => sliceBraces(branch, branch.indexOf('return {'), `${what} return`);
const successReturn = returned(successBranch, 'success');
const catchReturn = returned(catchBranch, 'catch');

for (const field of ['hasSpokenTurns,', 'readFailed: false']) {
    assert.ok(successReturn.includes(field),
        `transcripts:list' success path must RETURN ${field} — without it the chip goes dead`);
}
assert.ok(/hasSpokenTurns: false/.test(catchReturn),
    "transcripts:list' catch branch must carry hasSpokenTurns: false");
assert.ok(/readFailed: true/.test(catchReturn),
    "transcripts:list' catch branch must carry readFailed: true");
// readFailed alone says only that something failed, never what.
assert.ok(/catch \(err\)/.test(mapSrc) && /console\.warn/.test(catchBranch),
    'the row builder must log what it swallowed');
assert.ok(/cachedHasSpokenTurns\(filePath, stat\.mtimeMs, raw\)/.test(successBranch),
    'transcripts:list must go through the cache');

// Entries for files that are gone must go with them: a long session would grow
// the map forever, and a reused path could be served the old file's flag.
assert.ok(/spokenTurnsIndex\.delete\(key\)/.test(listSrc) && /listed\.has\(key\)/.test(listSrc),
    'transcripts:list must evict index entries for files it no longer lists');

// The app's own writes are hidden from the watcher, so nothing else invalidates
// what was cached about their content.
const stamp = sliceFunction(mainSrc, 'stampSelfWrite', 'main.js');
assert.ok(/spokenTurnsIndex\.delete\(filePath\)/.test(stamp),
    'a self-write must drop the cached scan for that file');
const atomic = sliceFunction(mainSrc, 'writeFileAtomic', 'main.js');
assert.ok(/spokenTurnsIndex\.delete\(target\)/.test(atomic),
    'the atomic write replaces the target behind the watcher — drop its entry too');

// The scan's own try, sliced rather than regex-matched: a greedy
// /try[\s\S]*catch/ was satisfied by any later catch in the function.
const helper = sliceFunction(mainSrc, 'cachedHasSpokenTurns', 'main.js');
const tryBlock = sliceBraces(helper, helper.indexOf('try {'), "the scan's try block");
assert.ok(/enhance\.hasSpokenTurns\(/.test(tryBlock),
    'the scan must go through the shipped enhance.hasSpokenTurns — parity with the job is the point');
assert.ok(/spokenTurnsIndex\.set\(/.test(tryBlock),
    'only a completed scan may be cached, so the write belongs inside the try');
const afterTry = helper.slice(helper.indexOf(tryBlock) + tryBlock.length);
assert.ok(!/spokenTurnsIndex\.set\(/.test(afterTry),
    'a failed scan must not be cached');
assert.ok(!/err\.message/.test(helper),
    'reading .message off a non-Error throws again, out of the very try that exists to contain it');

// ─── parseTranscriptHeaderMain, executed ────────────────────────────────────
// Pure string parsing, no electron dependency — sliced out and run directly,
// not only exercised indirectly through the ...info spread fixtures above.
const parseBox = {};
vm.runInNewContext(sliceFunction(mainSrc, 'parseTranscriptHeaderMain', 'main.js'), parseBox);
const attempted = parseBox.parseTranscriptHeaderMain(
    'Meeting: x\nEnhance-Attempted: 2026-08-27T10:00:00.000Z\n',
);
assert.strictEqual(attempted.enhanceAttemptedAt, '2026-08-27T10:00:00.000Z',
    'the full timestamp must survive — a slice() length one off from the key would truncate it');
const notAttempted = parseBox.parseTranscriptHeaderMain('Meeting: x\nEnhanced: 2026-08-27T10:00:00.000Z\n');
assert.strictEqual(notAttempted.enhanceAttemptedAt, null, 'absent by default, not a guess');
const partial = parseBox.parseTranscriptHeaderMain(
    'Meeting: x\nStatus: PARTIAL — transcription was interrupted, re-run it for the full text\n',
);
assert.strictEqual(partial.interrupted, true, 'the only Status: value ever written must parse to interrupted');
const complete = parseBox.parseTranscriptHeaderMain('Meeting: x\nGenerated: 2026-08-27T10:00:00.000Z\n');
assert.strictEqual(complete.interrupted, false, 'no Status: line means not interrupted, not a guess');

console.log('library-filters: all checks passed');
