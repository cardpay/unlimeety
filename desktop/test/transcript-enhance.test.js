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
    stripFence,
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
    const long = { marker: '[00:00] Alpha:', text: 'я'.repeat(500), gap: '\n' };
    const short = { marker: '[09:00] Beta:', text: 'ок', gap: '\n' };
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

    // A corrected reply is taken text-only.
    const fixed = mergeEnhanced(chunk, [
        'Вот исправленный текст:',
        '',
        '[00:00] Alpha:',
        'Привет, начнём с эквайринга.',
        '',
        '[99:99] СовсемДругой:',
        'Да, у меня две строки',
        'и вот вторая.',
    ].join('\n'));
    assert.strictEqual(fixed.ok, true, 'chatter before the first marker is ignored');
    assert.deepStrictEqual(fixed.texts, [
        'Привет, начнём с эквайринга.',
        'Да, у меня две строки\nи вот вторая.',
    ], 'only the text is taken — a rewritten marker cannot leak in');
}

// Fail closed: anything that does not line up block for block is rejected.
{
    const blocks = parseBlocks(splitTranscript(TRANSCRIPT).body);
    const chunk = [blocks[0], blocks[1]];
    assert.strictEqual(mergeEnhanced(chunk, '[00:00] Alpha:\nОдин блок вместо двух.').ok, false, 'too few blocks');
    assert.strictEqual(
        mergeEnhanced(chunk, `${renderChunk(chunk)}\n\n[01:00] Alpha:\nЛишний блок.`).ok,
        false,
        'too many blocks',
    );
    assert.strictEqual(mergeEnhanced(chunk, 'I cannot help with that.').ok, false, 'no blocks at all');
    assert.strictEqual(mergeEnhanced(chunk, '[00:00] Alpha:\n\n[00:12] Beta:\nтекст').ok, false, 'an emptied turn');
}

// ─── stripFence ───────────────────────────────────────────────────────────────
{
    assert.strictEqual(stripFence('```\n[00:00] A:\nтекст\n```'), '[00:00] A:\nтекст', 'bare fence');
    assert.strictEqual(stripFence('```text\n[00:00] A:\nтекст\n```\n'), '[00:00] A:\nтекст', 'tagged fence');
    assert.strictEqual(stripFence('[00:00] A:\nтекст'), '[00:00] A:\nтекст', 'unfenced text is untouched');
    assert.strictEqual(
        stripFence('[00:00] A:\nсмотри ```code``` внутри'),
        '[00:00] A:\nсмотри ```code``` внутри',
        'an inner fence is not a wrapper',
    );
}

// ─── prompt ───────────────────────────────────────────────────────────────────
{
    assert.match(ENHANCE_PROMPT, /same number of blocks/i, 'the prompt states the block-count contract');
    assert.match(ENHANCE_PROMPT, /language/i, 'and forbids translating');
}

console.log('transcript-enhance: all checks passed');
