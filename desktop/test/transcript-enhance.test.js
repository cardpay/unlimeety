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
    matchLineEndings,
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
    assert.deepStrictEqual(blocks.map((b) => isNoteBlock(b)), [false, false, true, false]);
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
    assert.deepStrictEqual(blocks.map((b) => isNoteBlock(b)), [false, false, true, false], 'and notes are still notes');
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

// ─── the gate on long turns ───────────────────────────────────────────────────
// One chunk can be a single monologue, so a proportional bound alone would let a
// model delete a hundred characters of the user's only copy and call it
// proofreading.
{
    const long = 'Значит смотрите, мы вчера обсуждали пайплайн деплоя и решили что надо всё переделать. '.repeat(5).trim();
    const chunk = parseBlocks(`[00:00] Alpha:\n${long}\n`);
    const shortened = long.slice(0, Math.round(long.length * 0.7));
    assert.strictEqual(mergeEnhanced(chunk, `[00:00] Alpha:\n${shortened}`).ok, false,
        'a long turn losing 30% is rejected');

    const padded = `${long}\n\nHope this helps! Let me know if you want a summary of the meeting.`;
    assert.strictEqual(mergeEnhanced(chunk, `[00:00] Alpha:\n${padded}`).ok, false,
        'a pleasantry welded onto a long turn is rejected');

    const proofread = long.replace(/Значит смотрите/, 'Значит, смотрите,') + '.';
    assert.strictEqual(mergeEnhanced(chunk, `[00:00] Alpha:\n${proofread}`).ok, true,
        'ordinary punctuation fixes on a long turn still pass');
}

// A translation that keeps a name is still a translation.
{
    const chunk = parseBlocks('[00:00] Alpha:\nвчера мы обсуждали пайплайн деплоя и решили что Иван всё переделает\n');
    const translated = '[00:00] Alpha:\nyesterday we discussed the deploy pipeline and decided Иван will redo it';
    assert.strictEqual(mergeEnhanced(chunk, translated).ok, false, 'one surviving proper noun is not enough');
}

// A fence opened after a preamble is not a wrapper, so its closing line arrives
// inside the last turn.
{
    const chunk = parseBlocks('[00:00] Alpha:\nПривет всем.\n\n[00:10] Beta:\nДа, всё ок.\n');
    const reply = 'Вот исправленный текст:\n\n```\n[00:00] Alpha:\nПривет всем.\n\n[00:10] Beta:\nДа, всё ок.\n```';
    assert.strictEqual(mergeEnhanced(chunk, reply).ok, false, 'a stray fence line is rejected');
}

// A line the app's own reader would render as a turn must not appear in text.
{
    const chunk = parseBlocks('[00:00] Alpha:\nПривет всем, начинаем.\n');
    assert.strictEqual(
        mergeEnhanced(chunk, '[00:00] Alpha:\nПривет всем.\n[00:05] Beta: а я против').ok,
        false,
        'an invented timestamped line is rejected',
    );
}

// Marker whitespace is not meaning: re-spacing it must not discard the chunk.
{
    const chunk = parseBlocks('[00:01] Иван Петров:\nпривет коллеги\n');
    const reply = '[00:01]  Иван   Петров:\nПривет, коллеги.';
    assert.strictEqual(mergeEnhanced(chunk, reply).ok, true, 'a re-spaced marker is still the same marker');
}

// Padding is dropped rather than written into the file.
{
    const chunk = parseBlocks('[00:00] Alpha:\nпривет всем\n');
    const merged = mergeEnhanced(chunk, `[00:00] Alpha:\n${'\n'.repeat(20)}Привет всем.`);
    assert.strictEqual(merged.ok, true);
    assert.strictEqual(merged.texts[0], 'Привет всем.', 'leading blank lines are not kept');
}

// ─── what never reaches the model ─────────────────────────────────────────────
// A numbered list inside a note is not a turn boundary — splitting it would send
// the tail of the user's own note to the model.
{
    const blocks = parseBlocks('[00:30] Note:\nОткрытые вопросы:\n[1] уточнить лимиты у легала:\nнаписать письмо\n');
    assert.strictEqual(blocks.length, 1, 'the note stays whole');
    assert.deepStrictEqual(spokenTargets(blocks, 'Note'), [], 'and is excluded');
    assert.ok(!MARKER_RE.test('[1] уточнить лимиты у легала:'), 'a list item is not a marker');
    assert.ok(!MARKER_RE.test('[2026] Отчёт:'), 'nor is a year');
    assert.ok(MARKER_RE.test('[1:00:32 PM] Alpha:'), 'a 12-hour timestamp is');
}

// A turn holding a one-line "[mm:ss] Speaker: text" is left alone: the app renders
// that line as a turn, and rewritten it would carry a model-invented timestamp.
{
    const blocks = parseBlocks('[00:00] Alpha:\nПривет.\n[00:10] Beta: да согласен\n\n[00:20] Alpha:\nОк.\n');
    assert.deepStrictEqual(spokenTargets(blocks, 'Note').map((b) => b.index), [1],
        'the block carrying the embedded turn is skipped',
    );
}

// The note label comes from main, not from a copy in this module.
{
    const blocks = parseBlocks('[00:30] Заметка:\nмой текст\n');
    assert.deepStrictEqual(spokenTargets(blocks, 'Заметка'), [], 'a renamed label is honoured');
    assert.strictEqual(spokenTargets(blocks, 'Note').length, 1, 'and only that label');
}

// ─── matchLineEndings ─────────────────────────────────────────────────────────
{
    assert.strictEqual(matchLineEndings('a\nb', 'x\r\ny\r\n'), 'a\r\nb', 'CRLF file, LF reply');
    assert.strictEqual(matchLineEndings('a\r\nb', 'x\ny\n'), 'a\nb', 'LF file, CRLF reply');
    assert.strictEqual(matchLineEndings('a\nb', 'x\ny\n'), 'a\nb', 'LF stays LF');
}

console.log('transcript-enhance: all checks passed');
