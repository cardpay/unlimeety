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

const { stripCodeFence } = require('./summary-frontmatter');

// A marker line: `[` + timestamp + `] ` + speaker + `:`. The timestamp must
// start with a digit and the line must end at the colon, so neither a header
// line nor a bracketed aside inside a turn ("[неразборчиво] …") can pass for one.
const MARKER_RE = /^\[\d[^\]\n]*\][^\n]*:[ \t\r]*$/;

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
    return /\]\s*Note:[ \t\r]*$/.test(block.marker || '');
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

// Proofreading is close to length-preserving: punctuation and a restored term
// move a turn by a few characters, a summary or a translation does not. The
// floor and ceiling are what separate the two, and they also catch the model
// welding "Hope this helps!" onto the last turn of a chunk.
const MIN_RATIO = 0.6;
const MAX_RATIO = 1.6;
const MAX_SLACK = 40;   // short turns move proportionally more: "ок" → "Ок."

// A translation is the one failure the length bounds cannot see — English runs
// about as long as the Russian it replaces. Losing the alphabet is what gives it
// away. One direction only: a Cyrillic turn that comes back with no Cyrillic at
// all was translated, but the reverse ("ok" → "Ок.", "пайплайн" for "pipeline")
// is ordinary proofreading in a Russian transcript. A transcript with no
// Cyrillic to begin with gets no protection from this check — the length bounds
// are all there is for a Latin-to-Latin translation.
const CYRILLIC = /\p{Script=Cyrillic}/u;

function lostCyrillic(was, now) {
    return CYRILLIC.test(was) && !CYRILLIC.test(now);
}

/// Reply → the new text of each turn, or `ok: false` if it cannot be trusted.
/// Prose before the first marker is ignored (parseBlocks starts at the marker) —
/// that preamble is too common to fail on. Everything else must line up: the
/// model is told to echo each marker, so a marker that comes back different is
/// how a reordered, merged or invented block gives itself away. Reusing the
/// original markers without checking would hide exactly that: the reply's text
/// would be filed under the wrong speaker.
function mergeEnhanced(chunk, modelText) {
    const parsed = parseBlocks(stripCodeFence(String(modelText || '').trim()));
    if (parsed.length !== chunk.length) {
        return { ok: false, reason: `expected ${chunk.length} blocks, got ${parsed.length}` };
    }
    for (let i = 0; i < chunk.length; i++) {
        if (parsed[i].marker.trim() !== chunk[i].marker.trim()) {
            return { ok: false, reason: `block ${i + 1}: marker changed` };
        }
        const was = chunk[i].text.trim();
        const now = parsed[i].text.trim();
        if (!now) return { ok: false, reason: `block ${i + 1}: came back empty` };
        if (now.length < was.length * MIN_RATIO || now.length > was.length * MAX_RATIO + MAX_SLACK) {
            return { ok: false, reason: `block ${i + 1}: length ${was.length} → ${now.length}` };
        }
        if (lostCyrillic(was, now)) return { ok: false, reason: `block ${i + 1}: text is no longer in Cyrillic` };
    }
    return { ok: true, texts: parsed.map((b) => b.text) };
}

function assembleTranscript(header, blocks) {
    // `sep` is empty only for a marker that was the file's last line with nothing
    // after it. If such a turn ever gained text, concatenating would fuse it onto
    // the marker line and the marker would stop being one.
    return header + blocks.map((b) => `${b.marker}${b.sep || (b.text ? '\n' : '')}${b.text}${b.gap}`).join('');
}

/// The turns Enhance may touch, each tagged with its index in `blocks`. Notes are
/// the user's own typing; an empty turn has nothing to proofread and would come
/// back invented.
function spokenTargets(blocks) {
    return blocks
        .map((block, index) => ({ ...block, index }))
        .filter((block) => !isNoteBlock(block) && block.text.trim());
}

module.exports = {
    splitTranscript,
    parseBlocks,
    isNoteBlock,
    chunkBlocks,
    renderChunk,
    mergeEnhanced,
    assembleTranscript,
    spokenTargets,
    blockSize,
    ENHANCE_PROMPT,
    DEFAULT_CHUNK_CHARS,
    MARKER_RE,
};
