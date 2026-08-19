'use strict';

// Enhance: an LLM proofreading pass over a transcript's spoken text.
//
// The model is only ever trusted with the words. The header block, the
// `[mm:ss] Speaker:` markers and the order of turns are immutable *by
// construction*: reassembly reuses the original markers and gaps and takes
// nothing from the reply but the text of each turn. If a reply does not line up
// block for block, the caller keeps the original — same fail-closed stance as
// the frontmatter gate in summary-frontmatter.js, and for the same reason: a
// transcript quietly reshaped by a model is worse than one with typos.
//
// Chunking exists because a meeting transcript outgrows a small model's context
// long before it outgrows the file system. Chunks split on turn boundaries only.

// A marker line: `[` + timestamp + `] ` + speaker + `:`. The timestamp must
// start with a digit and the line must end at the colon, so neither a header
// line nor a bracketed aside inside a turn ("[неразборчиво] …") can pass for one.
const MARKER_RE = /^\[\d[^\]\n]*\][^\n]*:[ \t]*$/;

const DEFAULT_CHUNK_CHARS = 6000;

const ENHANCE_PROMPT = `You are proofreading a meeting transcript produced by automatic speech recognition.

Fix only recognition errors: misheard words, wrong or missing punctuation, casing, obvious typos, and split or fused words. Restore domain terms and names that were misheard.

Rules you must not break:
- Keep the original language of every turn. Never translate.
- Return the same number of blocks, in the same order, each starting with its "[timestamp] Speaker:" line followed by the turn's text.
- Never merge, split, drop, reorder or invent blocks, and never move text between them.
- Do not summarise, shorten, expand, comment or add anything of your own. Preserve meaning and register, including filler words that carry meaning.
- If a turn is already correct, repeat it unchanged.

Output the blocks and nothing else.`;

/// Everything before the first marker line is the header; the rest is the body.
/// Lossless: header + body === input.
function splitTranscript(text) {
    const input = String(text || '');
    const starts = markerStarts(input);
    if (!starts.length) return { header: input, body: '' };
    return { header: input.slice(0, starts[0]), body: input.slice(starts[0]) };
}

function markerStarts(text) {
    const out = [];
    let pos = 0;
    for (const line of text.split('\n')) {
        if (MARKER_RE.test(line)) out.push(pos);
        pos += line.length + 1;
    }
    return out;
}

/// Body → one entry per turn. `sep` and `gap` carry the exact whitespace around
/// the text so assembleTranscript can put the file back byte for byte — a turn
/// separated by a single newline must not come back reflowed into two.
function parseBlocks(body) {
    const text = String(body || '');
    const starts = markerStarts(text);
    return starts.map((start, i) => {
        const raw = text.slice(start, i + 1 < starts.length ? starts[i + 1] : text.length);
        const nl = raw.indexOf('\n');
        const marker = nl === -1 ? raw : raw.slice(0, nl);
        const rest = nl === -1 ? '' : raw.slice(nl + 1);
        const trailing = rest.match(/\s*$/)[0];
        return {
            marker,
            sep: nl === -1 ? '' : '\n',
            text: rest.slice(0, rest.length - trailing.length),
            gap: trailing,
        };
    });
}

/// `[mm:ss] Note:` turns are text the user typed during the meeting, not speech
/// (NOTE_LABEL in main.js). Nothing recognised them wrong, so they are left out
/// of the pass entirely.
function isNoteBlock(block) {
    return /\]\s*Note:[ \t]*$/.test(block.marker || '');
}

function blockSize(block) {
    return block.marker.length + 1 + block.text.length;
}

/// Split into chunks of at most `maxChars`, never cutting a turn. A turn bigger
/// than the whole budget travels alone rather than truncated.
function chunkBlocks(blocks, maxChars = DEFAULT_CHUNK_CHARS) {
    const chunks = [];
    let current = [];
    let size = 0;
    for (const block of blocks) {
        const cost = blockSize(block);
        if (current.length && size + cost > maxChars) {
            chunks.push(current);
            current = [];
            size = 0;
        }
        current.push(block);
        size += cost;
    }
    if (current.length) chunks.push(current);
    return chunks;
}

function renderChunk(blocks) {
    return blocks.map((b) => `${b.marker}\n${b.text}`).join('\n\n');
}

/// A whole-reply code fence, which some models add and some don't. An inner
/// fence is left alone — only a wrapper is stripped.
function stripFence(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed.startsWith('```')) return trimmed;
    const firstNl = trimmed.indexOf('\n');
    if (firstNl === -1 || !trimmed.endsWith('```')) return trimmed;
    return trimmed.slice(firstNl + 1, trimmed.length - 3).trim();
}

/// Reply → the new text of each turn, or `ok: false` if it cannot be trusted.
/// Prose before the first marker is ignored (parseBlocks starts at the marker),
/// but the block count must match exactly and no turn may come back empty.
function mergeEnhanced(chunk, modelText) {
    const parsed = parseBlocks(stripFence(modelText));
    if (parsed.length !== chunk.length) {
        return { ok: false, reason: `expected ${chunk.length} blocks, got ${parsed.length}` };
    }
    if (parsed.some((b) => !b.text.trim())) {
        return { ok: false, reason: 'a turn came back empty' };
    }
    return { ok: true, texts: parsed.map((b) => b.text) };
}

function assembleTranscript(header, blocks) {
    return header + blocks.map((b) => `${b.marker}${b.sep}${b.text}${b.gap}`).join('');
}

module.exports = {
    splitTranscript,
    parseBlocks,
    isNoteBlock,
    chunkBlocks,
    renderChunk,
    mergeEnhanced,
    assembleTranscript,
    stripFence,
    blockSize,
    ENHANCE_PROMPT,
    DEFAULT_CHUNK_CHARS,
    MARKER_RE,
};
