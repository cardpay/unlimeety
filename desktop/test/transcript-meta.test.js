'use strict';
// node test/transcript-meta.test.js
//
// The transcript header is dropped from view mode and shown from an info chip
// on the library card instead. renderer/app.js is a classic <script> with no
// exports, so — like meeting-date-format.test.js — this reads it off disk and
// evals the marked regions. Both regions are deliberately free of the DOM and
// localStorage (their collaborators are stubbed below); if either grows a real
// dependency on them, this test is what breaks first.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { findRegion } = require('./lib/find-region');

const RENDERER = path.join(__dirname, '..', 'renderer');

function region(file, name) {
    const src = fs.readFileSync(path.join(RENDERER, file), 'utf-8');
    const m = findRegion(src, name);
    assert.ok(m, `"${name}" region markers not found in renderer/${file}`);
    return m[0];
}

// Stubs, not the real collaborators: what is under test is which key goes
// through which formatter and what markup comes out, not Intl's output on this
// machine. escHtml here is a hand-written stand-in with the same contract, not
// app.js's own — these assertions pin the escaping the region performs on
// whatever escaper it is given.
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const {
    parseTranscriptMeta, transcriptMetaHtml, meetingMetaRows, meetingMetaPanelHtml,
} = new Function(
    'modelLabel', 'formatMeetingStamp', 'escHtml',
    `${region('app.js', 'transcript meta')}
     return { parseTranscriptMeta, transcriptMetaHtml, meetingMetaRows, meetingMetaPanelHtml };`,
)(
    (id) => `MODEL(${id})`,
    (d) => `STAMP(${d.toISOString()})`,
    escHtml,
);

const { deriveMeetingFromTranscript, deriveMeetingFromRecording, mergeMeetings } = new Function(
    'stripMeetPrefix', 'deriveStatus',
    `${region('app.js', 'meeting record')}
     return { deriveMeetingFromTranscript, deriveMeetingFromRecording, mergeMeetings };`,
)(
    (s) => s,
    (m) => (m.hasTranscript ? 'transcribed' : 'audio_only'),
);

const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.key, r.value]));

// ─── Every header line survives ─────────────────────────────────────────────
{
    const header = [
        'Meeting: Daily Sync',
        'Recorded-At: 2026-08-24T16:14:00.000Z',
        'Generated: 2026-08-24T16:20:00.000Z',
        'Model: openai_whisper-large-v3',
        'Participants: Anna, Oleg',
        'Language: ru',
        'Source: /Users/me/Recordings/daily: sync.m4a',
    ].join('\n');
    const { rows, warn } = parseTranscriptMeta(header);

    assert.strictEqual(warn, '', 'no Status line, no warning');
    assert.deepStrictEqual(
        rows.map((r) => r.key),
        ['Meeting', 'Recorded-At', 'Generated', 'Model', 'Participants', 'Language', 'Source'],
        'in header order, keyed as written on disk',
    );
    const v = byKey(rows);
    assert.strictEqual(v['Meeting'], 'Daily Sync');
    assert.strictEqual(v['Recorded-At'], 'STAMP(2026-08-24T16:14:00.000Z)',
        'an ISO stamp is house-formatted, not shown raw');
    assert.strictEqual(v['Model'], 'MODEL(openai_whisper-large-v3)',
        'Model goes through modelLabel, not the raw WhisperKit id');
    assert.strictEqual(v['Source'], '/Users/me/Recordings/daily: sync.m4a',
        'only the first ": " splits — a colon inside a path stays in the value');
}
{
    // The reason there is no whitelist: older extension builds wrote `Started:`,
    // which main.js's typed parser has never known about. 72 of the transcripts
    // on the author's disk carry it, and it must not become invisible.
    const { rows } = parseTranscriptMeta('Meeting: A\nStarted: 5/28/2026, 2:02:20 PM\nDate: today');
    assert.deepStrictEqual(byKey(rows), {
        'Meeting': 'A', 'Started': '5/28/2026, 2:02:20 PM', 'Date': 'today',
    }, 'a key nobody has typed into a table is still a row');
}

// ─── Dates: ISO shape only ──────────────────────────────────────────────────
// `Generated` is now written with toISOString() (main.js x3, the extension's
// background.js), but every transcript written before that change still has
// its old toLocaleString() shape on disk — this must keep tolerating both.
// Handing a locale string to new Date() either fails or silently reparses a
// US-looking string as a different instant, and a bare "2026" would be
// inflated into a full timestamp.
{
    for (const raw of ['24.08.2026, 18:14:00', '24/08/2026, 18:14', '2026', 'whenever']) {
        const { rows } = parseTranscriptMeta(`Generated: ${raw}`);
        assert.deepStrictEqual(rows, [{ key: 'Generated', value: raw }],
            `a non-ISO date is shown exactly as written (${raw})`);
    }
    const { rows } = parseTranscriptMeta('Enhanced: 2026-08-24T17:00:00.000Z');
    assert.strictEqual(rows[0].value, 'STAMP(2026-08-24T17:00:00.000Z)', 'Enhanced is ISO');

    // ISO-shaped but not a real instant: shown as written rather than as
    // "Invalid Date" — the isNaN fallback in metaValue.
    const bad = parseTranscriptMeta('Recorded-At: 2026-13-45T99:99:99.000Z').rows[0];
    assert.strictEqual(bad.value, '2026-13-45T99:99:99.000Z', 'an unparsable ISO stamp is left alone');
}

// ─── Status: only PARTIAL is a warning ──────────────────────────────────────
{
    const { rows, warn } = parseTranscriptMeta([
        'Meeting: Daily Sync',
        'Status: PARTIAL — transcription was interrupted, re-run it for the full text',
        'Language: ru',
    ].join('\n'));

    assert.strictEqual(
        warn, 'PARTIAL — transcription was interrupted, re-run it for the full text',
        'the interruption notice comes back apart, to be rendered inline',
    );
    assert.deepStrictEqual(
        rows.map((r) => r.key), ['Meeting', 'Language'],
        'and never as a row — the card panel is a click away, this line is not',
    );
}
{
    // live.js writes this on every Live-saved transcript. Nothing is wrong with
    // it, so it must not be flagged — and it must not vanish either.
    const { rows, warn } = parseTranscriptMeta('Status: live (still in progress)');
    assert.strictEqual(warn, '', 'a healthy Live status is not a warning');
    assert.deepStrictEqual(rows, [{ key: 'Status', value: 'live (still in progress)' }],
        'it is an ordinary row');
    assert.strictEqual(parseTranscriptMeta('Status: PARTIALLY done').warn, '',
        'the word boundary holds — PARTIALLY is not PARTIAL');
    assert.strictEqual(parseTranscriptMeta('Status:').warn, '', 'an empty Status is not a warning');
}

// ─── No header ──────────────────────────────────────────────────────────────
for (const empty of ['', '   \n\n  ', null, undefined]) {
    const { rows, warn } = parseTranscriptMeta(empty);
    assert.deepStrictEqual(rows, [], `no rows for ${JSON.stringify(empty)}`);
    assert.strictEqual(warn, '', `no warning for ${JSON.stringify(empty)}`);
}

// ─── Unparsable header line ─────────────────────────────────────────────────
{
    const { rows } = parseTranscriptMeta([
        'Meeting: Daily Sync',
        'pasted from a mail thread, sender unknown',
        'draft notes: see the second half',
        'https://wiki.internal/meetings/daily',
        '2026 kickoff',
    ].join('\n'));

    assert.deepStrictEqual(rows, [
        { key: 'Meeting', value: 'Daily Sync' },
        { key: '', value: 'pasted from a mail thread, sender unknown' },
        // A space before the colon means it is prose, not a "Key: value" line.
        { key: '', value: 'draft notes: see the second half' },
        // "//" after the colon means the colon was a URL scheme's, not a key's.
        { key: '', value: 'https://wiki.internal/meetings/daily' },
        { key: '', value: '2026 kickoff' },
    ], 'free text and bare links become keyless rows — nothing is silently dropped');
}

// ─── View mode: warning always, rows only without a card ────────────────────
{
    const header = [
        'Meeting: Q3 <plan> & budget',
        'Recorded-At: 2026-08-24T16:14:00.000Z',
        'Status: PARTIAL — <interrupted>',
        'Source: /Users/me/Recordings/daily.m4a',
    ].join('\n');

    const carded = transcriptMetaHtml(header);
    assert.ok(carded.includes('PARTIAL — &lt;interrupted&gt;'), 'the warning renders, escaped');
    assert.ok(!/<(plan|interrupted)>/.test(carded), 'nothing reaches the DOM unescaped');
    // The matrix row find-in-note cares about: with a card carrying the rows,
    // no header value reaches #transcript-view, so nothing invisible can feed
    // the find counter — which is why find-in-note needs no node filter.
    for (const leaked of ['Q3', 'STAMP(', 'Recorded', 'daily.m4a']) {
        assert.ok(!carded.includes(leaked), `${leaked} stays off the transcript view`);
    }

    // No card (opened from outside the transcripts folder): the rows are the
    // reader's only access to them, so they stay inline.
    const inline = transcriptMetaHtml(header, { inlineRows: true });
    assert.ok(inline.includes('tv-meta-rows'), 'the rows are rendered');
    assert.ok(inline.includes('Q3 &lt;plan&gt; &amp; budget') && inline.includes('daily.m4a'),
        'and they carry the header values');
    assert.ok(inline.indexOf('tv-meta-warn') < inline.indexOf('tv-meta-rows'),
        'with the warning still first, above them');
}
{
    assert.strictEqual(transcriptMetaHtml(''), '', 'no header, no markup at all');
    assert.strictEqual(transcriptMetaHtml('', { inlineRows: true }), '',
        'and no empty rows box either');
    assert.strictEqual(
        transcriptMetaHtml('Meeting: Daily Sync\nLanguage: ru'), '',
        'a healthy header renders nothing — the card carries it',
    );
}

// ─── main.js row → meeting record → card rows ───────────────────────────────
// The end-to-end key contract. `header` is what main.js's transcripts:list
// hands over; renaming it on either side must fail here, not in silence.
{
    const item = {
        filename: 'Daily Sync.txt',
        filePath: '/Users/me/Downloads/Meet_Transcripts/Daily Sync.txt',
        createdAt: Date.parse('2026-08-24T16:14:00.000Z'),
        mtime: Date.parse('2026-08-24T16:20:00.000Z'),
        hasSummary: false,
        hasAudio: true,
        audioPath: '/Users/me/Recordings/daily.m4a',
        header: [
            'Meeting: Daily Sync',
            'Recorded-At: 2026-08-24T16:14:00.000Z',
            'Model: openai_whisper-large-v3',
            'Started: 5/28/2026, 2:02:20 PM',
            'Source: /Users/me/Recordings/daily.m4a',
        ].join('\n'),
        // ...info — the spread parseTranscriptHeaderMain contributes.
        title: 'Daily Sync',
        generated: null,
        recordedAt: '2026-08-24T16:14:00.000Z',
        language: null,
        source: '/Users/me/Recordings/daily.m4a',
        model: 'openai_whisper-large-v3',
        enhancedAt: null,
        participants: [],
    };

    const m = deriveMeetingFromTranscript(item);
    assert.deepStrictEqual(
        meetingMetaRows(m).map((r) => r.key),
        ['Meeting', 'Recorded-At', 'Model', 'Started', 'Source'],
        'the card shows every header line main.js sent, whitelisted keys or not',
    );
    assert.strictEqual(byKey(meetingMetaRows(m))['Model'], 'MODEL(openai_whisper-large-v3)');
    assert.strictEqual(m.interrupted, false, 'not present on item — must default to false, not undefined');
    // The exact field meetingMatchesFilter's retranscribe/enhance/summarize
    // branches key on — a copy step dropped here would leave the filter logic
    // in renderer/app.js correct but permanently unreachable.
    assert.strictEqual(
        deriveMeetingFromTranscript({ ...item, interrupted: true }).interrupted, true,
        'transcripts:list\'s parsed Status: field must survive into the meeting record',
    );

    // What the Chrome extension writes: no Model, no Source. The chip must
    // still appear, with the fields that transcript does have.
    const fromExtension = deriveMeetingFromTranscript({
        ...item,
        header: 'Meeting: Kickoff\nGenerated: 5/28/2026, 2:34:47 PM\nLanguage: Русский',
    });
    assert.deepStrictEqual(
        meetingMetaRows(fromExtension).map((r) => r.key),
        ['Meeting', 'Generated', 'Language'],
        'an extension-written transcript still has rows to show',
    );

    assert.strictEqual(deriveMeetingFromTranscript(null), null, 'no item, no record');
    assert.deepStrictEqual(
        meetingMetaRows(deriveMeetingFromTranscript({ ...item, header: undefined })), [],
        'a transcript with no header yields no rows, so the card renders no chip',
    );
    assert.deepStrictEqual(meetingMetaRows(undefined), [], 'and neither does no meeting at all');
}

// ─── main.js record:list row → meeting record ───────────────────────────────
// Same contract for the other list source. Every key below is one main.js
// actually emits (main.js:record:list) — renaming either side fails here rather
// than leaving the library quietly short of half its rows.
{
    const row = {
        filename: '14-30 25-08-26 Daily.wav',
        filePath: '/Users/me/Downloads/Meet_Recordings/14-30 25-08-26 Daily.wav',
        createdAt: Date.parse('2026-08-25T14:30:00.000Z'),
        mtime: Date.parse('2026-08-25T15:05:00.000Z'),
        size: 41_943_040,
        hasTranscript: false,
        transcriptPath: '/Users/me/Downloads/Meet_Transcripts/14-30 25-08-26 Daily.txt',
        hasSummary: false,
        summaryPath: null,
    };

    const m = deriveMeetingFromRecording(row);
    assert.strictEqual(m.id, row.filePath, 'the wav path is the id');
    assert.strictEqual(m.audioPath, row.filePath);
    assert.strictEqual(m.transcriptPath, null, 'the .txt does not exist — do not name it');
    assert.strictEqual(m.title, '14-30 25-08-26 Daily', 'title is the on-disk stem, minus .wav');
    assert.strictEqual(m.sizeBytes, row.size);
    assert.strictEqual(m.date.getTime(), row.createdAt);
    assert.strictEqual(m.status, 'audio_only');
    assert.deepStrictEqual(
        { hasAudio: m.hasAudio, hasTranscript: m.hasTranscript, hasSummary: m.hasSummary,
          hasSpokenTurns: m.hasSpokenTurns, readFailed: m.readFailed },
        { hasAudio: true, hasTranscript: false, hasSummary: false,
          hasSpokenTurns: false, readFailed: false },
        'every queue flag is a finding here, and none of them is undefined',
    );
    // No transcript means no header, so the card must not offer a details chip.
    assert.strictEqual(m.header, '');
    assert.deepStrictEqual(meetingMetaRows(m), []);

    // mtime stands in when the row has no birthtime.
    assert.strictEqual(
        deriveMeetingFromRecording({ ...row, createdAt: 0 }).date.getTime(), row.mtime,
        'a row with no createdAt falls back to mtime rather than to now',
    );
    assert.strictEqual(deriveMeetingFromRecording(null), null, 'no row, no record');
    assert.strictEqual(deriveMeetingFromRecording({ filename: 'x.wav' }), null,
        'a row with no path has no id, so it is not a meeting');
}

// ─── The union the library renders ──────────────────────────────────────────
// One card per meeting, whichever list it came from. The dedup rule is the
// whole point: get it wrong and a recording shows twice, or not at all.
{
    const REC = '/Users/me/Downloads/Meet_Recordings';
    const TXT = '/Users/me/Downloads/Meet_Transcripts';
    const txt = (stem, audioPath) => ({
        filename: `${stem}.txt`, filePath: `${TXT}/${stem}.txt`,
        createdAt: Date.parse('2026-08-20T09:00:00.000Z'),
        hasAudio: Boolean(audioPath), audioPath: audioPath || null, participants: [],
    });
    const wav = (stem, hasTranscript) => ({
        filename: `${stem}.wav`, filePath: `${REC}/${stem}.wav`,
        createdAt: Date.parse('2026-08-21T09:00:00.000Z'), size: 1024, hasTranscript,
    });

    const merged = mergeMeetings(
        [txt('Daily', `${REC}/Daily.wav`), txt('Pasted', null)],
        [wav('Daily', true), wav('Fresh', false)],
    );
    assert.deepStrictEqual(
        merged.map((m) => m.id),
        [`${TXT}/Daily.txt`, `${TXT}/Pasted.txt`, `${REC}/Fresh.wav`],
        'every transcript, plus only the recordings without one',
    );
    assert.strictEqual(merged.filter((m) => m.hasTranscript === false).length, 1);

    // The legacy shape: the wav stem carries a timestamp the transcript's does
    // not, so record:list cannot pair them — but transcripts:list already did,
    // and its audioPath is what breaks the tie.
    const legacyWav = `${REC}/Daily-20260821-090000.wav`;
    const legacy = mergeMeetings(
        [txt('Daily', legacyWav)],
        [{ filename: 'Daily-20260821-090000.wav', filePath: legacyWav, createdAt: 1, size: 1, hasTranscript: false }],
    );
    assert.deepStrictEqual(
        legacy.map((m) => m.id), [`${TXT}/Daily.txt`],
        'a wav a transcript already claims must not get a second card of its own',
    );

    // A legacy-stem recording can pair with more than one wav (Source: header
    // plus a direct-stem match, say) — every one of them must be claimed, not
    // just the first, or the others double-card as their own recordings.
    const multiWav1 = `${REC}/Daily.wav`;
    const multiWav2 = `${REC}/Daily-20260821-090000.wav`;
    const multi = mergeMeetings(
        [{ filename: 'Daily.txt', filePath: `${TXT}/Daily.txt`,
           createdAt: Date.parse('2026-08-20T09:00:00.000Z'),
           hasAudio: true, audioPath: multiWav1, audioPaths: [multiWav1, multiWav2], participants: [] }],
        [
            { filename: 'Daily.wav', filePath: multiWav1, createdAt: 1, size: 1, hasTranscript: false },
            { filename: 'Daily-20260821-090000.wav', filePath: multiWav2, createdAt: 1, size: 1, hasTranscript: false },
        ],
    );
    assert.deepStrictEqual(multi.map((m) => m.id), [`${TXT}/Daily.txt`],
        'every related wav must be claimed, not just the first — a second one must not get its own card');

    // A transcript whose read failed still claims its own wav: main.js computes
    // audioPaths independently of whether the read succeeded (see
    // transcripts:list's catch branch), so the identity survives even though
    // every other field on this row is a fabricated default.
    const readFailedWav = `${REC}/Broken.wav`;
    const readFailed = mergeMeetings(
        [{ filename: 'Broken.txt', filePath: `${TXT}/Broken.txt`, readFailed: true,
           audioPaths: [readFailedWav], participants: [] }],
        [{ filename: 'Broken.wav', filePath: readFailedWav, createdAt: 1, size: 1, hasTranscript: false }],
    );
    assert.deepStrictEqual(readFailed.map((m) => m.id), [`${TXT}/Broken.txt`],
        'a read-failed transcript must still keep its own wav from double-carding');

    // A transcript with no audio claims nothing, so an unrelated recording is
    // still listed.
    assert.strictEqual(
        mergeMeetings([txt('Pasted', null)], [wav('Fresh', false)]).length, 2,
        'a transcript without audio must not suppress unrelated recordings',
    );
    assert.deepStrictEqual(mergeMeetings(null, null), [], 'two empty sources yield an empty library');
    assert.deepStrictEqual(
        mergeMeetings([], [null, { filePath: '' }, wav('Fresh', false)]).map((m) => m.id),
        [`${REC}/Fresh.wav`],
        'malformed rows are dropped rather than rendered as blank cards',
    );
}

// ─── Panel markup ───────────────────────────────────────────────────────────
{
    const html = meetingMetaPanelHtml(parseTranscriptMeta([
        'Recorded-At: 2026-08-24T16:14:00.000Z',
        'Source: /tmp/Q3 <plan> & budget.m4a',
        'pasted from a mail thread',
    ].join('\n')).rows);

    assert.ok(
        html.includes('<span class="meta-key">Recorded</span>'),
        'Recorded-At is labelled "Recorded" for display, though the parsed key keeps the file\'s word',
    );
    assert.ok(html.includes('Q3 &lt;plan&gt; &amp; budget'), 'row values are escaped');
    assert.ok(!/<plan>/.test(html), 'nothing reaches the DOM unescaped');
    assert.strictEqual((html.match(/class="meta-row"/g) || []).length, 3, 'one row per line');
    assert.strictEqual((html.match(/class="meta-key"/g) || []).length, 2,
        'a keyless row renders its value alone, with no empty label column');
    assert.strictEqual(meetingMetaPanelHtml([]), '', 'no rows, no markup');
}

// ─── buildTranscriptViewHtml: the PARTIAL warning's wiring ──────────────────
// transcriptMetaHtml (above) is already covered on its own; what has no
// coverage is the glue in renderTranscriptView that decides whether to slice
// a header off the content and call it at all — deleting that one call used
// to leave this whole suite green. Uses the REAL transcriptMetaHtml already
// bound above, not a stub, so deleting the wiring line fails this test.
const { buildTranscriptViewHtml } = new Function(
    'escHtml', 'fmtTc', 'parseSegments', 'transcriptMetaHtml', 'NOTE_LABEL',
    `${region('app.js', 'transcript view')}
     return { buildTranscriptViewHtml };`,
)(
    escHtml,
    (sec) => { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${s.toString().padStart(2, '0')}`; },
    // A minimal stand-in with the real contract: [t|null, label, speaker|null, text].
    // parseSegments' own parsing logic is not what this test is about.
    (content) => (content.includes('[0:05] Alice:')
        ? [{ t: 5, label: '0:05', speaker: 'Alice', text: 'hello there' }]
        : []),
    transcriptMetaHtml,
    'Note',
);

{
    const content = [
        'Meeting: Q3 planning',
        'Status: PARTIAL — transcription was interrupted, re-run it for the full text',
        '',
        '[0:05] Alice: hello there',
    ].join('\n');

    const carded = buildTranscriptViewHtml(content, true);
    assert.ok(carded.includes('tv-meta-warn'), 'the PARTIAL warning must reach the transcript view');
    assert.ok(carded.includes('transcription was interrupted'), 'with its real text');
    assert.ok(!carded.includes('tv-meta-rows'), 'carded: header rows stay off, only the warning shows');
    assert.ok(carded.includes('hello there'), 'segments still render alongside the warning');

    const uncarded = buildTranscriptViewHtml(content, false);
    assert.ok(uncarded.includes('tv-meta-rows'), 'uncarded: header rows render inline too');

    const noHeader = buildTranscriptViewHtml('[0:05] Alice: hello there', true);
    assert.ok(!noHeader.includes('tv-meta'), 'no header text before the first timecode — nothing to warn about');
    assert.ok(noHeader.includes('hello there'), 'segments render on their own');

    const noTimecodes = buildTranscriptViewHtml('just plain pasted text', true);
    assert.ok(noTimecodes.includes('tv-plain'), 'no bracketed timecode at all falls back to a plain block');
    assert.ok(!noTimecodes.includes('tv-meta'), 'and never calls into the header path');
}

console.log('transcript-meta: all checks passed');
