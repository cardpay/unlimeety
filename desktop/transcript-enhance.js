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

// ─── Speaker naming ─────────────────────────────────────────────────────────
// Diarization knows how many people spoke, not who they are, so the writers
// label turns `Speaker`, `S1`, or a phonetic placeholder (`Beta`, `Gamma 2`).
// This pass works out the real names and rewrites the markers.
//
// It is deliberately NOT part of the proofreading reply. That pass is safe
// because the marker is immutable by construction; letting the model hand
// markers back would give away the one anchor that proves a reply lines up.
// Instead the model answers a separate question — "who is Beta?" — and the
// answer is a name per placeholder, applied here mechanically.
//
// Nothing the model says is taken on trust. A name is used only if it is
// already a listed participant or is actually spoken somewhere in the
// transcript, so the worst case is a placeholder left alone, never an invented
// person. `Me` is never renamed: it is the user, and it is already correct.

const MAX_NAME_CHARS = 40;
const MAX_NAME_WORDS = 3;
const DEFAULT_EVIDENCE_CHARS = 6000;

// `[00:20] Delta:` → the three pieces around the speaker, so a rename keeps the
// original timestamp and trailing whitespace byte for byte.
const MARKER_PARTS = new RegExp(`^(${TIMESTAMP}\\s*)(.*?)(:[ \\t\\r]*)$`);

const NAME_SHAPE = /^\p{L}[\p{L}\p{M}'’.\- ]*$/u;

const SPEAKER_PROMPT = `You are identifying the speakers in a meeting transcript.

Automatic diarization labelled each speaker with a placeholder because it does not know who they are. Work out each placeholder's real name from the conversation itself: self-introductions, people addressing each other by name, someone being handed a topic they own.

Rules you must not break:
- Use only names that are actually spoken in the transcript or listed as participants. Never guess a name from a role, an accent or a topic.
- If a placeholder's name is not clearly established, answer ? for it. A wrong name is far worse than no name.
- Answer one line per placeholder, exactly: Placeholder = Name
- Output those lines and nothing else.`;

function speakerFromMarker(marker) {
    const m = MARKER_PARTS.exec(String(marker || ''));
    return m ? m[2].trim() : '';
}

function markerWithSpeaker(marker, name) {
    const m = MARKER_PARTS.exec(String(marker || ''));
    return m ? `${m[1]}${name}${m[3]}` : marker;
}

/// A label the app itself produced for "someone we cannot name yet".
/// `phonetic` is passed in rather than copied: main.js owns that list for
/// humanizeSpeakerLabel, and a second copy here is a second place to forget.
function isPlaceholderLabel(label, phonetic = []) {
    const s = String(label || '').trim();
    if (!s) return false;
    if (s === 'Me') return false; // the user — already the right answer
    if (s === 'Speaker' || s === '?' || s === '…') return true;
    if (/^S\d+$/i.test(s)) return true;
    // `Beta`, and the wrap-around form `Beta 2`.
    const m = /^(\p{L}+)(?: (\d+))?$/u.exec(s);
    return Boolean(m && phonetic.some((p) => p.toLowerCase() === m[1].toLowerCase()));
}

/// Distinct placeholder labels, in the order they first speak.
function placeholderSpeakers(blocks, { noteLabel = 'Note', phonetic = [] } = {}) {
    const seen = new Set();
    const out = [];
    for (const block of blocks) {
        if (isNoteBlock(block, noteLabel)) continue;
        const label = speakerFromMarker(block.marker);
        if (!label || seen.has(label) || !isPlaceholderLabel(label, phonetic)) continue;
        seen.add(label);
        out.push(label);
    }
    return out;
}

/// The turns the model gets to reason over. Sampled evenly across the whole
/// meeting, not just the opening: people are addressed by name throughout, and
/// plenty of meetings start mid-thought with no introductions at all.
// ponytail: a stride drops the turns between samples, so a name said exactly
// once in a skipped turn is missed. Raise the budget if that shows up.
function speakerEvidence(blocks, noteLabel = 'Note', maxChars = DEFAULT_EVIDENCE_CHARS) {
    const usable = blocks.filter((b) => !isNoteBlock(b, noteLabel) && b.text.trim());
    if (!usable.length) return '';
    const total = usable.reduce((n, b) => n + blockSize(b), 0);
    const stride = Math.max(1, Math.ceil(total / maxChars));
    const out = [];
    let size = 0;
    for (let i = 0; i < usable.length && size < maxChars; i += stride) {
        const line = `${usable[i].marker}\n${usable[i].text}`;
        out.push(line);
        size += line.length + 2;
    }
    return out.join('\n\n');
}

function participantsFromHeader(header) {
    const line = String(header || '').split('\n').find((l) => /^Participants:/i.test(l));
    if (!line) return [];
    return line.slice(line.indexOf(':') + 1).split(',').map((s) => s.trim()).filter(Boolean);
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/// Spoken somewhere, as a word rather than a substring: "Ан" must not qualify
/// on the strength of "Анна", or a placeholder gets someone else's name.
function spokenIn(word, haystack) {
    return new RegExp(`(^|[^\\p{L}])${escapeRe(word)}([^\\p{L}]|$)`, 'iu').test(haystack);
}

function nameIsAttested(name, body, participants) {
    const lower = name.toLowerCase();
    if (participants.some((p) => p.toLowerCase() === lower)) return true;
    const parts = name.split(/\s+/).filter((p) => p.length >= 2);
    return parts.length > 0 && parts.every((p) => spokenIn(p, body));
}

/// Model reply → a validated `label → name` map. Every rule that fails drops
/// that one label and keeps its placeholder; nothing fails the whole pass.
function parseSpeakerNames(reply, { labels = [], body = '', participants = [], phonetic = [] } = {}) {
    const wanted = new Map(labels.map((l) => [l.toLowerCase(), l]));
    const map = new Map();
    const taken = new Set();
    for (const line of stripCodeFence(String(reply || '')).split('\n')) {
        const m = /^\s*(.+?)\s*[=:]\s*(.+?)\s*$/.exec(line);
        if (!m) continue;
        const label = wanted.get(m[1].trim().toLowerCase());
        const name = m[2].trim().replace(/^["'«]|["'»]$/g, '').trim();
        if (!label || map.has(label)) continue;
        if (!name || name === '?' || /^(unknown|unclear|n\/?a)$/i.test(name)) continue;
        if (name.length > MAX_NAME_CHARS) continue;
        if (name.split(/\s+/).length > MAX_NAME_WORDS) continue;
        if (!NAME_SHAPE.test(name)) continue;
        // A placeholder is not a name — the model echoing the label back, or
        // swapping one placeholder for another, must not be written in.
        if (isPlaceholderLabel(name, phonetic)) continue;
        if (taken.has(name.toLowerCase())) continue;   // two speakers, one name
        if (!nameIsAttested(name, body, participants)) continue;
        map.set(label, name);
        taken.add(name.toLowerCase());
    }
    return map;
}

/// The written form keeps the placeholder in brackets: `Олег (Delta)`. The name
/// is a reading of the conversation, not a fact the recorder established, so the
/// label it replaces stays visible — the reader can still tell turns apart by
/// diarization if the name is wrong, and a second Enhance pass sees a speaker
/// that is no longer a placeholder and leaves it alone.
function displaySpeaker(name, label) {
    return `${name} (${label})`;
}

/// Mechanical: only the speaker part of a marker changes, and only for labels
/// the map resolved.
function renameSpeakers(blocks, map) {
    if (!map || !map.size) return blocks;
    return blocks.map((block) => {
        const label = speakerFromMarker(block.marker);
        const name = map.get(label);
        return name
            ? { ...block, marker: markerWithSpeaker(block.marker, displaySpeaker(name, label)) }
            : block;
    });
}

/// Keep the header honest: a body that says "Anna" while `Participants:` still
/// says "Beta" is a transcript that contradicts itself.
function renameParticipantsLine(header, map) {
    if (!map || !map.size) return header;
    return String(header || '').split('\n').map((line) => {
        if (!/^Participants:/i.test(line)) return line;
        const head = line.slice(0, line.indexOf(':') + 1);
        const seen = new Set();
        const names = line.slice(line.indexOf(':') + 1)
            .split(',').map((s) => s.trim()).filter(Boolean)
            .map((entry) => (map.has(entry) ? displaySpeaker(map.get(entry), entry) : entry))
            .filter((entry) => {
                const key = entry.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        return `${head} ${names.join(', ')}`;
    }).join('\n');
}

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
// Both bounds combine a ratio with a small absolute allowance, as the *union* of
// the two and not their intersection. Each is wrong alone: a ratio is far too
// loose for a two-character "ок", and an allowance alone scales with nothing —
// 40 characters is a rounding error in a 7000-character monologue and a rewrite
// of "ок". So a reply passes if it is within either one.
//
// Taking the stricter of the two instead (what this did before) collapsed to a
// hard ±MAX_DRIFT at every length: MAX_DRIFT was added to the ratio ceiling and
// the result then min'd against `was + MAX_DRIFT`, so the ratio could never be
// the stricter bound and never applied at all. That left a 7297-character turn
// with a 0.5% tolerance, and proofreading one measures +3-5% — restored
// punctuation, casing and domain terms on ASR output that has none. Every long
// turn was rejected, so Enhance failed outright on any transcript with a
// monologue in it.
//
// Hence the ratios. +10% is two to three times the measured drift, and still
// under a closing pleasantry: "Hope this helps! Let me know if you want a
// summary of the meeting." is +16% on a 400-character turn, which no absolute
// cap can catch on a long one anyway. -25% is more than punctuation can remove,
// while catching the summary a small model returns when a chunk overflows its
// context. The allowance is what a two-word turn needs for a comma — small
// enough that the same pleasantry on a short turn also trips the ceiling.
const MIN_RATIO = 0.75;
const MAX_RATIO = 1.1;
const MAX_DRIFT = 12;

function outOfBounds(was, now) {
    const floor = Math.min(was.length * MIN_RATIO, was.length - MAX_DRIFT);
    const ceiling = Math.max(was.length * MAX_RATIO, was.length + MAX_DRIFT);
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

/// Whole-file answer to "is there anything here for Enhance to do?", composed
/// from the same three steps runEnhanceJob gates on — split off the header,
/// parse the turns, keep the ones Enhance may touch. The sidebar's "To enhance"
/// queue calls this so the filter and the job can never disagree; keep it a
/// composition of the exported steps rather than a cheaper look-alike.
function hasSpokenTurns(raw, noteLabel) {
    return spokenTargets(parseBlocks(splitTranscript(raw).body), noteLabel).length > 0;
}

/// Line endings of the merged text follow the file's own: a CRLF transcript whose
/// turns come back with LF would end up mixed.
function matchLineEndings(text, sample) {
    const crlf = (sample.match(/\r\n/g) || []).length;
    const lf = (sample.match(/\n/g) || []).length;
    if (crlf === 0 || crlf * 2 < lf) return text.replace(/\r\n/g, '\n');
    return text.replace(/\r?\n/g, '\r\n');
}

/// Upsert a `Key: value` line into a transcript header (the part splitTranscript
/// returns). Replaces the line where the key is already present, otherwise adds
/// it after the last non-empty line — never into the blank line that separates
/// the header from the first turn, or the header would stop being one. A header
/// with no content at all (a transcript that starts at its first marker) gets a
/// header block of its own.
function stampHeaderLine(header, key, value) {
    const lines = String(header || '').split('\n');
    const line = `${key}: ${value}`;
    // Written back onto whichever line ending the file already uses; the enhance
    // path re-normalizes anyway (matchLineEndings), but a caller assembling a
    // CRLF header by hand gets a CRLF line too.
    const keep = (i) => (lines[i].endsWith('\r') ? `${line}\r` : line);
    const bare = (i) => lines[i].replace(/\r$/, '');

    const at = lines.findIndex((_, i) => bare(i).startsWith(`${key}: `));
    if (at >= 0) {
        lines[at] = keep(at);
        return lines.join('\n');
    }
    let last = -1;
    for (let i = 0; i < lines.length; i++) if (bare(i) !== '') last = i;
    if (last < 0) return `${line}\n\n`;
    lines.splice(last + 1, 0, keep(last));
    return lines.join('\n');
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
    hasSpokenTurns,
    stampHeaderLine,
    matchLineEndings,
    ENHANCE_PROMPT,
    MARKER_RE,
    // Speaker naming
    speakerFromMarker,
    isPlaceholderLabel,
    placeholderSpeakers,
    speakerEvidence,
    participantsFromHeader,
    parseSpeakerNames,
    renameSpeakers,
    renameParticipantsLine,
    displaySpeaker,
    SPEAKER_PROMPT,
};
