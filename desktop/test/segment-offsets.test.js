'use strict';
// node test/segment-offsets.test.js
//
// segmentOffsets(content) maps parseSegments(content)'s array back to raw
// character offsets in `content`, and resolveEditCaretOffset uses that to land
// the textarea's caret on the segment last active in View mode, instead of
// the textarea's native end-of-text default. All three must agree line-for-
// line on where a segment starts, so this reads them off disk and evals them
// together (no DOM dependency to stub — resolveEditCaretOffset only reads
// `activeSeg.dataset.idx`, so a plain object stands in for a real .tv-seg
// element); if they drift apart, this is what breaks first.

const assert = require('assert');
const { region } = require('./lib/find-region');

const { parseSegments, segmentOffsets, resolveEditCaretOffset } = new Function(
    `${region('app.js', 'segment offsets')}
     return { parseSegments, segmentOffsets, resolveEditCaretOffset };`,
)();

{
    const content = [
        'Meeting: Q3 planning',
        'Participants: Alice, Bob',
        '',
        '[0:05] Alice: hello there',
        'a continuation line, folded into the same segment',
        '[0:12] Bob: hi Alice',
    ].join('\n');

    const segments = parseSegments(content);
    const offsets = segmentOffsets(content);
    assert.strictEqual(offsets.length, segments.length, 'one offset per segment, same order');

    for (let i = 0; i < segments.length; i++) {
        const rest = content.slice(offsets[i]);
        assert.ok(rest.startsWith(`[${segments[i].label}]`),
            `offset ${i} must point at its own "[${segments[i].label}]" line, got ${JSON.stringify(rest.slice(0, 20))}`);
    }
}

{
    // No timecode line at all: no segments, no offsets — not a crash.
    assert.deepStrictEqual(segmentOffsets('just plain pasted text'), []);
    assert.deepStrictEqual(parseSegments('just plain pasted text'), []);
}

{
    // A header before the first timecode must not be counted as segment 0.
    const content = 'Meeting: Q3\n\n[0:05] Alice: hi\n[0:09] Bob: yo';
    const offsets = segmentOffsets(content);
    assert.strictEqual(offsets.length, 2);
    assert.strictEqual(content.slice(offsets[0], offsets[0] + 6), '[0:05]');
    assert.strictEqual(content.slice(offsets[1], offsets[1] + 6), '[0:09]');
}

{
    // A text-export transcript has no audio to seek — its segments carry a
    // wall-clock label instead of an [m:ss] one, and parseSegments gives them
    // t: null. Mixed with a normal audio segment, since a real note can be one
    // or the other but the parsing/offset code path is shared either way.
    const content = '[1:00:32 PM] Alice: good morning\n[0:05] Bob: hi';
    const segments = parseSegments(content);
    const offsets = segmentOffsets(content);
    assert.strictEqual(segments.length, 2);
    assert.strictEqual(segments[0].t, null, 'wall-clock label has no seekable offset');
    assert.strictEqual(segments[1].t, 5);
    assert.strictEqual(content.slice(offsets[0], offsets[0] + 12), '[1:00:32 PM]');
    assert.strictEqual(content.slice(offsets[1], offsets[1] + 6), '[0:05]');
}

{
    // resolveEditCaretOffset: the View->Edit toggle's decision logic.
    const content = '[0:05] Alice: hi\n[0:09] Bob: yo\n[0:14] Alice: bye';
    const offsets = segmentOffsets(content);

    assert.strictEqual(resolveEditCaretOffset(null, content), null,
        'no active segment (fresh note, or one with no timed segments) — leave the caret alone');
    assert.strictEqual(resolveEditCaretOffset({ dataset: { idx: 'not-a-number' } }, content), null,
        'a malformed data-idx must not throw or resolve to NaN/undefined as if it were 0');
    assert.strictEqual(resolveEditCaretOffset({ dataset: { idx: '99' } }, content), null,
        'an index past the end (stale data-idx from before an edit shrank the transcript) is not offsets[0]');
    assert.strictEqual(resolveEditCaretOffset({ dataset: { idx: '1' } }, content), offsets[1],
        'a valid data-idx resolves to that exact segment\'s offset');
}

console.log('segment-offsets: all checks passed');
