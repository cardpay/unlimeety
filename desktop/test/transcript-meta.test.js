'use strict';
// node test/transcript-meta.test.js
//
// The transcript header is hidden behind a hover-revealed info icon in view
// mode. renderer/app.js and renderer/find-in-note.js are classic <script>s with
// no exports, so — like meeting-date-format.test.js — this reads them off disk
// and evals the marked regions. Both regions are deliberately free of the DOM
// and localStorage (`modelLabel` / `formatMeetingStamp` / `escHtml` / `iconSvg`
// and `NodeFilter` are stubbed here, and the find predicate only ever calls
// parentElement.closest); if either grows a real dependency on them, this test
// is what breaks first.

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
// machine. escHtml is the real implementation — escaping is part of the
// contract asserted below.
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const { parseTranscriptMeta, transcriptMetaHtml } = new Function(
    'modelLabel', 'formatMeetingStamp', 'escHtml', 'iconSvg',
    `${region('app.js', 'transcript meta')}
     return { parseTranscriptMeta, transcriptMetaHtml };`,
)(
    (id) => `MODEL(${id})`,
    (d) => `STAMP(${d.toISOString()})`,
    escHtml,
    (name) => `<svg data-icon="${name}"></svg>`,
);

const { skipInFind, findNodeFilter } = new Function(
    'NodeFilter',
    `${region('find-in-note.js', 'find skip predicate')}
     return { skipInFind, findNodeFilter };`,
)({ FILTER_ACCEPT: 1, FILTER_REJECT: 2, SHOW_TEXT: 4 });

// ─── Full header ────────────────────────────────────────────────────────────
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
        'every header line survives, in header order, keyed as written on disk',
    );
    assert.strictEqual(rows[0].value, 'Daily Sync');
    assert.strictEqual(
        rows[1].value, 'STAMP(2026-08-24T16:14:00.000Z)',
        'an ISO stamp is house-formatted, not shown raw',
    );
    assert.strictEqual(
        rows[3].value, 'MODEL(openai_whisper-large-v3)',
        'Model goes through modelLabel, not the raw WhisperKit id',
    );
    assert.strictEqual(
        rows[6].value, '/Users/me/Recordings/daily: sync.m4a',
        'only the first ": " splits — a colon inside a path stays in the value',
    );
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
        'and never as a row inside the panel',
    );
}
{
    // live.js writes this on every Live-saved transcript. Nothing is wrong with
    // it, so it must not be flagged — and it must not vanish either.
    const { rows, warn } = parseTranscriptMeta('Status: live (still in progress)');
    assert.strictEqual(warn, '', 'a healthy Live status is not a warning');
    assert.deepStrictEqual(rows, [{ key: 'Status', value: 'live (still in progress)' }],
        'it is an ordinary panel row');
}
{
    const { rows, warn } = parseTranscriptMeta('Status:');
    assert.strictEqual(warn, '', 'an empty Status is not a warning');
    assert.deepStrictEqual(rows, [{ key: 'Status', value: '' }], 'and is not dropped either');
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

// ─── Empty value ────────────────────────────────────────────────────────────
{
    const { rows } = parseTranscriptMeta('Participants:\nLanguage: ');
    assert.deepStrictEqual(rows, [
        { key: 'Participants', value: '' },
        { key: 'Language', value: '' },
    ], 'a key with no value is still a row');
}

// ─── Markup ─────────────────────────────────────────────────────────────────
{
    const html = transcriptMetaHtml([
        'Meeting: Q3 <plan> & budget',
        'Recorded-At: 2026-08-24T16:14:00.000Z',
        'Status: PARTIAL — <interrupted>',
        'free text with <b>markup</b>',
    ].join('\n'));

    const panelAt = html.indexOf('<div class="tv-meta-panel"');
    const warnAt = html.indexOf('<span class="tv-meta-warn">');
    assert.ok(panelAt > 0 && warnAt > 0, 'both the panel and the warning are rendered');
    assert.ok(
        warnAt < panelAt,
        'the warning is a sibling BEFORE the panel — inside it, the one line this '
        + 'whole change exists to keep visible would be hidden behind the hover',
    );
    assert.ok(
        !html.slice(panelAt).includes('tv-meta-warn'),
        'and no copy of it is nested inside the panel',
    );

    assert.ok(html.includes('aria-describedby="tv-meta-panel"')
        && html.includes('id="tv-meta-panel"'),
        'the button points a screen reader at the panel content');
    assert.ok(html.includes('<svg data-icon="info">'), 'the icon comes from iconSvg("info")');

    assert.ok(
        html.includes('<span class="tv-meta-key">Recorded</span>'),
        'Recorded-At is labelled "Recorded" for display',
    );
    assert.ok(html.includes('Q3 &lt;plan&gt; &amp; budget'), 'row values are escaped');
    assert.ok(html.includes('free text with &lt;b&gt;markup&lt;/b&gt;'),
        'so are keyless rows');
    assert.ok(html.includes('PARTIAL — &lt;interrupted&gt;'), 'so is the warning');
    assert.ok(!/<(b|plan|interrupted)>/.test(html), 'nothing reaches the DOM unescaped');
}
{
    assert.strictEqual(transcriptMetaHtml(''), '', 'no header, no markup at all');
    const statusOnly = transcriptMetaHtml('Status: PARTIAL — nothing else');
    assert.ok(!statusOnly.includes('tv-meta-btn') && !statusOnly.includes('tv-meta-panel'),
        'no rows means no button and no empty panel — just the warning');
    assert.ok(statusOnly.includes('tv-meta-warn'));
}

// ─── find-in-note skips the closed panel ────────────────────────────────────
{
    const node = (hit) => ({ parentElement: { closest: (sel) => (sel === '.tv-meta-panel' ? hit : null) } });

    assert.strictEqual(skipInFind(node({})), true, 'text inside the meta panel is skipped');
    assert.strictEqual(skipInFind(node(null)), false, 'transcript text is searched');
    assert.strictEqual(skipInFind({ parentElement: null }), false, 'a detached text node is searched');

    // The predicate is only half of it: the walker's filter has to map it onto
    // the right NodeFilter constants. Inverted, find-in-note would go blind on
    // the transcript pane and the summary rail at once.
    assert.strictEqual(findNodeFilter.acceptNode(node({})), 2, 'panel text → FILTER_REJECT');
    assert.strictEqual(findNodeFilter.acceptNode(node(null)), 1, 'everything else → FILTER_ACCEPT');
}

console.log('transcript-meta: all checks passed');
