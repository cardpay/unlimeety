'use strict';
// node test/transcript-enhance.test.js

const assert = require('assert');
const {
    splitTranscript,
    parseBlocks,
    isNoteBlock,
    chunkBlocks,
    renderChunk,
    mergeEnhanced,
    assembleTranscript,
    spokenTargets,
    MARKER_RE,
    ENHANCE_PROMPT,
} = require('../transcript-enhance');

const TRANSCRIPT = [
    'Meeting: Weekly sync',
    'Recorded-At: 2026-08-19T09:00:00.000Z',
    'Generated: 19.08.2026, 12:00:00',
    'Participants: Alpha, Beta',
    'Language: ru',
    '',
    '[00:00] Alpha:',
    'Привет, начнём с эквайрина.',
    '',
    '[00:12] Beta:',
    'Да, у меня две строки',
    'и вот вторая.',
    '',
    '[00:30] Note:',
    'проверить лимиты',
    '',
    '[00:45] Alpha:',
    'Хорошо.',
    '',
].join('\n');

// ─── splitTranscript ──────────────────────────────────────────────────────────
{
    const { header, body } = splitTranscript(TRANSCRIPT);
    assert.match(header, /^Meeting: Weekly sync\n/, 'header starts at the first line');
    assert.ok(!header.includes('[00:00]'), 'header stops before the first marker');
    assert.match(body, /^\[00:00\] Alpha:\n/, 'body starts at the first marker');
    assert.strictEqual(header + body, TRANSCRIPT, 'the split is lossless');
}

// A transcript with no dialogue at all is all header and no body.
{
    const { header, body } = splitTranscript('Meeting: empty\n\n');
    assert.strictEqual(header, 'Meeting: empty\n\n');
    assert.strictEqual(body, '');
}

// ─── parseBlocks ──────────────────────────────────────────────────────────────
{
    const blocks = parseBlocks(splitTranscript(TRANSCRIPT).body);
    assert.strictEqual(blocks.length, 4, 'one block per marker');
    assert.strictEqual(blocks[0].marker, '[00:00] Alpha:');
    assert.strictEqual(blocks[0].text, 'Привет, начнём с эквайрина.');
    assert.strictEqual(blocks[1].text, 'Да, у меня две строки\nи вот вторая.', 'multi-line turns stay whole');
    assert.strictEqual(blocks[2].marker, '[00:30] Note:');
    assert.deepStrictEqual(blocks.map(isNoteBlock), [false, false, true, false]);
}

// A line that merely starts with a bracket is not a marker.
{
    const blocks = parseBlocks('[00:00] Alpha:\n[неразборчиво] дальше по тексту\n');
    assert.strictEqual(blocks.length, 1, 'only the timestamped, colon-terminated line is a marker');
    assert.strictEqual(blocks[0].text, '[неразборчиво] дальше по тексту');
}

// ─── assembleTranscript ───────────────────────────────────────────────────────
{
    const { header, body } = splitTranscript(TRANSCRIPT);
    const blocks = parseBlocks(body);
    assert.strictEqual(
        assembleTranscript(header, blocks),
        TRANSCRIPT,
        'header + untouched blocks reproduce the file byte for byte',
    );
}

// Single-newline separation is not reflowed into double.
{
    const tight = 'Meeting: x\n\n[00:00] Alpha:\nОдин.\n[00:05] Beta:\nДва.\n';
    const { header, body } = splitTranscript(tight);
    assert.strictEqual(assembleTranscript(header, parseBlocks(body)), tight, 'the original gaps survive');
}

// ─── chunkBlocks ──────────────────────────────────────────────────────────────
{
    const blocks = parseBlocks(splitTranscript(TRANSCRIPT).body);
    assert.strictEqual(chunkBlocks(blocks, 10_000).length, 1, 'a small transcript is one chunk');

    const chunks = chunkBlocks(blocks, 60);
    assert.ok(chunks.length > 1, 'a tight budget splits');
    assert.deepStrictEqual(
        chunks.flat().map((b) => b.marker),
        blocks.map((b) => b.marker),
        'every block lands in exactly one chunk, in order',
    );
    for (const chunk of chunks) {
        assert.ok(chunk.length >= 1, 'no empty chunks');
    }
}

// A block larger than the whole budget goes on its own rather than being cut.
{
    const [long, short] = parseBlocks(
        `[00:00] Alpha:\n${'я'.repeat(500)}\n\n[09:00] Beta:\nок\n`,
    );
    const chunks = chunkBlocks([long, short], 100);
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0].length, 1, 'the oversized block is alone');
    assert.strictEqual(chunks[0][0].text.length, 500, 'and is not truncated');
}

// ─── renderChunk / mergeEnhanced ──────────────────────────────────────────────
{
    const blocks = parseBlocks(splitTranscript(TRANSCRIPT).body);
    const chunk = [blocks[0], blocks[1]];
    const rendered = renderChunk(chunk);
    assert.match(rendered, /^\[00:00\] Alpha:\nПривет/, 'the model sees the on-disk shape');

    // An echoing model changes nothing.
    const echo = mergeEnhanced(chunk, rendered);
    assert.strictEqual(echo.ok, true);
    assert.deepStrictEqual(echo.texts, [chunk[0].text, chunk[1].text]);

    // A corrected reply is taken text-only, and a preamble before the first
    // marker is ignored rather than rejected — models add one constantly.
    const fixed = mergeEnhanced(chunk, [
        'Вот исправленный текст:',
        '',
        '[00:00] Alpha:',
        'Привет, начнём с эквайринга.',
        '',
        '[00:12] Beta:',
        'Да, у меня две строки',
        'и вот вторая.',
    ].join('\n'));
    assert.strictEqual(fixed.ok, true, 'chatter before the first marker is ignored');
    assert.deepStrictEqual(fixed.texts, [
        'Привет, начнём с эквайринга.',
        'Да, у меня две строки\nи вот вторая.',
    ]);

    // A wrapping code fence is unwrapped (shared with the frontmatter gate).
    const fenced = mergeEnhanced(chunk, '```\n' + rendered + '\n```');
    assert.strictEqual(fenced.ok, true, 'a fenced reply is still usable');
}

// Fail closed. Every one of these is something a model actually does, and the
// overwrite has no backup, so each has to be caught here or not at all.
{
    const blocks = parseBlocks(splitTranscript(TRANSCRIPT).body);
    const chunk = [blocks[0], blocks[1]];
    const rendered = renderChunk(chunk);
    const rejected = (reply, why) => assert.strictEqual(mergeEnhanced(chunk, reply).ok, false, why);

    rejected('[00:00] Alpha:\nОдин блок вместо двух.', 'too few blocks');
    rejected(`${rendered}\n\n[01:00] Alpha:\nЛишний блок.`, 'too many blocks');
    rejected('I cannot help with that.', 'no blocks at all');
    rejected('[00:00] Alpha:\n\n[00:12] Beta:\nтекст', 'an emptied turn');

    // Trailing chatter welded onto the last turn.
    rejected(`${rendered}\n\nHope this helps! Let me know if you want a summary of the meeting.`,
        'a closing pleasantry appended to the last turn');

    // Turns returned in the other order. Markers are reused positionally, so
    // without the marker check this would file Beta's words under Alpha's.
    // (A model that keeps both markers in place and merely swaps the words under
    // them is not detectable here — nothing in the reply says it happened.)
    rejected(`${blocks[1].marker}\n${blocks[1].text}\n\n${blocks[0].marker}\n${blocks[0].text}`,
        'reordered turns');
    rejected(`[00:00] Alpha:\n${blocks[0].text}\n\n[99:99] СовсемДругой:\n${blocks[1].text}`,
        'a rewritten marker');

    // What a small model does when the chunk overflows its context.
    rejected('[00:00] Alpha:\nОк.\n\n[00:12] Beta:\nОк.', 'turns collapsed to a stub');
    // A translation is the same length as the original, so only the alphabet
    // gives it away.
    rejected('[00:00] Alpha:\nHi, let\'s start with acquiring.\n\n[00:12] Beta:\nYes, I have two lines and here is the second.',
        'a translated chunk');
}

// Length bounds leave normal proofreading alone: punctuation, casing and a
// restored term all fit, and a short turn may grow proportionally more.
{
    const chunk = parseBlocks('[00:00] Alpha:\nв пейкоре сломался эквайрин надо чинить\n\n[00:10] Beta:\nага\n');
    const ok = mergeEnhanced(chunk, '[00:00] Alpha:\nВ PayCore сломался эквайринг, надо чинить.\n\n[00:10] Beta:\nАга.');
    assert.strictEqual(ok.ok, true, ok.reason || '');
}

// The alphabet check runs one way only: a Latin turn corrected into Cyrillic is
// what proofreading a Russian transcript looks like ("ok" → "Ок.").
{
    const chunk = parseBlocks('[00:00] Alpha:\nok\n\n[00:10] Beta:\npipeline упал\n');
    const ok = mergeEnhanced(chunk, '[00:00] Alpha:\nОк.\n\n[00:10] Beta:\nPipeline упал.');
    assert.strictEqual(ok.ok, true, ok.reason || '');
}

// ─── CRLF ─────────────────────────────────────────────────────────────────────
// A transcript hand-edited on Windows must not read as one long header — that
// would hand the marker lines to the model as ordinary prose.
{
    const crlf = TRANSCRIPT.replace(/\n/g, '\r\n');
    const { header, body } = splitTranscript(crlf);
    const blocks = parseBlocks(body);
    assert.strictEqual(blocks.length, 4, 'CRLF markers are still markers');
    assert.deepStrictEqual(blocks.map(isNoteBlock), [false, false, true, false], 'and notes are still notes');
    assert.strictEqual(assembleTranscript(header, blocks), crlf, 'CRLF survives the round trip');
    assert.ok(MARKER_RE.test('[00:00] Alpha:\r'), 'the marker pattern tolerates the carriage return');
}

// ─── spokenTargets ────────────────────────────────────────────────────────────
{
    const blocks = parseBlocks(splitTranscript(TRANSCRIPT).body);
    assert.deepStrictEqual(
        spokenTargets(blocks).map((b) => b.index),
        [0, 1, 3],
        'notes are excluded and every target carries its index',
    );
}

// An empty turn is skipped: there is nothing to proofread, and a model asked to
// return something for it invents a line.
{
    const blocks = parseBlocks('[00:00] Alpha:\nПривет.\n\n[00:12] Beta:\n\n');
    assert.strictEqual(blocks.length, 2);
    assert.deepStrictEqual(spokenTargets(blocks).map((b) => b.index), [0]);
}

// A marker that is the file's last line with nothing after it: if such a turn
// ever gained text, fusing it onto the marker line would destroy the marker.
{
    const tail = 'Meeting: x\n\n[00:00] Alpha:\nПривет.\n\n[00:12] Beta:';
    const { header, body } = splitTranscript(tail);
    const blocks = parseBlocks(body);
    assert.strictEqual(assembleTranscript(header, blocks), tail, 'lossless as it stands');
    blocks[1].text = 'Да, ок.';
    assert.ok(
        MARKER_RE.test(assembleTranscript(header, blocks).split('\n').at(-2)),
        'the marker keeps its own line once the turn has text',
    );
}

// ─── prompt ───────────────────────────────────────────────────────────────────
{
    assert.match(ENHANCE_PROMPT, /same number of blocks/i, 'the prompt states the block-count contract');
    assert.match(ENHANCE_PROMPT, /language/i, 'and forbids translating');
}

console.log('transcript-enhance: all checks passed');
