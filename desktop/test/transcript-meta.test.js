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

const RENDERER = path.join(__dirname, '..', 'renderer');

function region(file, name) {
    const src = fs.readFileSync(path.join(RENDERER, file), 'utf-8');
    const m = src.match(
        new RegExp(`\\n[ \\t]*// ── ${name}[\\s\\S]*?\\n[ \\t]*// ── end ${name} ──`),
    );
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

const { deriveMeetingFromTranscript } = new Function(
    'stripMeetPrefix', 'deriveStatus',
    `${region('app.js', 'meeting record')}
     return { deriveMeetingFromTranscript };`,
)(
    (s) => s,
    () => 'transcribed',
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
// `Generated` is written with toLocaleString() (main.js x3, the extension's
// background.js), so its shape follows the writer's locale. Handing that to
// new Date() either fails or silently reparses a US-looking string as a
// different instant, and a bare "2026" would be inflated into a full timestamp.
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

console.log('transcript-meta: all checks passed');
