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

// A marker line: `[` + a clock time + `] ` + speaker + `:`, ending at the colon.
// The timestamp shape is spelled out rather than "starts with a digit" so that a
// numbered list inside a turn or a note ("[1] уточнить лимиты у легала:") is not
// mistaken for a turn boundary — that would split the note and hand its tail to
// the model. Every writer in the app produces one of these: `[mm:ss]`,
// `[h:mm:ss]`, and `[1:00:32 PM]` from a pasted text export.
const TIMESTAMP = String.raw`\[\d{1,2}(?::\d{2}){1,2}(?:\s?[AP]M)?\]`;
const MARKER_RE = new RegExp(`^${TIMESTAMP}[^\\n]*:[ \\t\\r]*$`, 'i');

// What the app's own transcript reader treats as the start of a turn
// (parseSegments in renderer/app.js). It is looser than MARKER_RE: a
// `[mm:ss] Speaker: text` line, all on one line, renders as a turn there but is
// not a marker here. Text containing such a line therefore never goes to the
// model — rewritten, its timestamp and speaker would be whatever the model said.
const TURN_LIKE = /^\[\d[^\]\n]*\]/m;

// Kept below a small model's context: a 6000-char Russian chunk plus a reply of
// the same size overflows Ollama's default 4096-token window, and the whole part
// comes back unusable.
const DEFAULT_CHUNK_CHARS = 3000;

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

/// `[mm:ss] Note:` turns are text the user typed during the meeting, not speech.
/// Nothing recognised them wrong, so they are left out of the pass entirely. The
/// label is passed in: main.js spells it once (NOTE_LABEL) for both transcript
/// writers, the summarize gate and the renderer, and a copy here would be a
/// fourth place to forget.
function isNoteBlock(block, noteLabel = 'Note') {
    return new RegExp(`\\]\\s*${noteLabel}:[ \\t\\r]*$`).test(block.marker || '');
}

function blockSize(block) {
    // +1 for the newline after the marker, +2 for the blank line renderChunk puts
    // between blocks: undercounting is how a chunk overflows the model's context.
    return block.marker.length + block.text.length + 3;
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
// move a turn by a few characters, a summary or a translation does not.
//
// Both bounds need the ratio *and* an absolute cap, because each is wrong alone.
// A ratio alone scales the tolerance with the turn — 40% of a 400-character
// monologue is 160 characters of the user's only copy, and one chunk can be a
// single monologue. An absolute cap alone is far too loose for a two-character
// "ок". So the floor is the stricter of the two, and so is the ceiling; the
// ceiling is also what catches "Hope this helps!" welded onto the last turn.
const MIN_RATIO = 0.6;
const MAX_RATIO = 1.6;
const MAX_DRIFT = 40;

function outOfBounds(was, now) {
    const floor = Math.max(was.length * MIN_RATIO, was.length - MAX_DRIFT);
    const ceiling = Math.min(was.length * MAX_RATIO + MAX_DRIFT, was.length + MAX_DRIFT);
    return now.length < floor || now.length > ceiling;
}

// A translation is the one failure the length bounds cannot see — English runs
// about as long as the Russian it replaces. Losing the alphabet is what gives it
// away. One direction only: a Cyrillic turn that comes back with no Cyrillic at
// all was translated, but the reverse ("ok" → "Ок.", "пайплайн" for "pipeline")
// is ordinary proofreading in a Russian transcript. A transcript with no
// Cyrillic to begin with gets no protection from this check — the length bounds
// are all there is for a Latin-to-Latin translation.
const CYRILLIC_RUN = /\p{Script=Cyrillic}/gu;
const LETTER_RUN = /\p{L}/gu;

function cyrillicShare(text) {
    const letters = (text.match(LETTER_RUN) || []).length;
    if (!letters) return 0;
    return (text.match(CYRILLIC_RUN) || []).length / letters;
}

// A share, not mere presence: a translating model keeps proper nouns, and one
// surviving name ("…decided to redo it, Иван") is enough to defeat a
// does-any-Cyrillic-remain check.
function lostCyrillic(was, now) {
    const before = cyrillicShare(was);
    return before > 0.3 && cyrillicShare(now) < before / 2;
}

/// Reply → the new text of each turn, or `ok: false` if it cannot be trusted.
/// Prose before the first marker is ignored (parseBlocks starts at the marker) —
/// that preamble is too common to fail on. Everything else must line up: the
/// model is told to echo each marker, so a marker that comes back different is
/// how a reordered, merged or invented block gives itself away. Reusing the
/// original markers without checking would hide exactly that: the reply's text
/// would be filed under the wrong speaker.
// Whitespace inside a marker is not meaning: models re-space them constantly, and
// the marker is thrown away at reassembly anyway. Comparing collapsed forms costs
// nothing and saves discarding a whole chunk over a double space.
function sameMarker(a, b) {
    return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

function mergeEnhanced(chunk, modelText) {
    const parsed = parseBlocks(stripCodeFence(String(modelText || '').trim()));
    if (parsed.length !== chunk.length) {
        return { ok: false, reason: `expected ${chunk.length} blocks, got ${parsed.length}` };
    }
    for (let i = 0; i < chunk.length; i++) {
        if (!sameMarker(parsed[i].marker, chunk[i].marker)) {
            return { ok: false, reason: `block ${i + 1}: marker changed` };
        }
        const was = chunk[i].text.trim();
        const now = parsed[i].text.trim();
        if (!now) return { ok: false, reason: `block ${i + 1}: came back empty` };
        if (outOfBounds(was, now)) {
            return { ok: false, reason: `block ${i + 1}: length ${was.length} → ${now.length}` };
        }
        if (lostCyrillic(was, now)) return { ok: false, reason: `block ${i + 1}: no longer in Cyrillic` };
        // A fence that opened after a preamble is not stripped by stripCodeFence,
        // so its closing line arrives inside the last turn.
        if (/^\s*```/m.test(now)) return { ok: false, reason: `block ${i + 1}: code fence in the text` };
        // A line the app's reader would render as a new turn: written back, it
        // would split this turn and invent a timestamp and a speaker.
        if (TURN_LIKE.test(now) && !TURN_LIKE.test(was)) {
            return { ok: false, reason: `block ${i + 1}: a timestamped line appeared in the text` };
        }
    }
    // Trimmed: the bounds above are measured on trimmed text, and `sep`/`gap`
    // already carry the file's layout, so a model that pads every turn with blank
    // lines cannot reshape the file.
    return { ok: true, texts: parsed.map((b) => b.text.trim()) };
}

function assembleTranscript(header, blocks) {
    // `sep` is empty only for a marker that was the file's last line with nothing
    // after it. If such a turn ever gained text, concatenating would fuse it onto
    // the marker line and the marker would stop being one.
    return header + blocks.map((b) => `${b.marker}${b.sep || (b.text ? '\n' : '')}${b.text}${b.gap}`).join('');
}

/// The turns Enhance may touch, each tagged with its index in `blocks`. Left out:
/// notes (the user's own typing), empty turns (nothing to proofread, and the model
/// invents a line for them), and turns whose text holds a line the app's own
/// reader would render as another turn — rewriting those would put a
/// model-invented timestamp and speaker into the transcript.
function spokenTargets(blocks, noteLabel) {
    return blocks
        .map((block, index) => ({ ...block, index }))
        .filter((block) => !isNoteBlock(block, noteLabel)
            && block.text.trim()
            && !TURN_LIKE.test(block.text));
}

/// Line endings of the merged text follow the file's own: a CRLF transcript whose
/// turns come back with LF would end up mixed.
function matchLineEndings(text, sample) {
    const crlf = (sample.match(/\r\n/g) || []).length;
    const lf = (sample.match(/\n/g) || []).length;
    if (crlf === 0 || crlf * 2 < lf) return text.replace(/\r\n/g, '\n');
    return text.replace(/\r?\n/g, '\r\n');
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
    matchLineEndings,
    ENHANCE_PROMPT,
    MARKER_RE,
};
