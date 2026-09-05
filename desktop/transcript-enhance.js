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
const { withinDistance } = require('./glossary');

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
// already a listed participant, or is actually spoken somewhere in the
// transcript, or has at least one part spoken and the rest bound to exactly one
// participant's email address — so the worst case is a placeholder left alone,
// never an invented person.
//
// `Me` is a placeholder like any other. It says which turns are the user's, not
// who the user is, and the transcript itself usually answers that — the others
// address them by name. So it is asked about too and written `Valerij (Me)`,
// keeping the label that tells the reader whose microphone this was.

const MAX_NAME_CHARS = 40;
const MAX_NAME_WORDS = 3;
// The whole meeting, in practice. Naming is one call over the transcript, the
// same shape as summarize — which reads the file whole and resolves speakers
// reliably. Every earlier budget strided over almost everything and dropped the
// one turn where a name was said, which is why this pass kept failing where
// summarize did not: a real 90-minute meeting is 41530 characters of speech, and
// at 40000 the stride kept 18922 of them and lost the only turn naming one
// participant. The cap only exists so a marathon transcript degrades to trimmed
// turns instead of overflowing the model outright.
//
// This is the shipped default and the test suite pins it: lowering it back
// silently reinstates the original bug.
const DEFAULT_EVIDENCE_CHARS = 120000;

// `[00:20] Delta:` → the three pieces around the speaker, so a rename keeps the
// original timestamp and trailing whitespace byte for byte.
const MARKER_PARTS = new RegExp(`^(${TIMESTAMP}\\s*)(.*?)(:[ \\t\\r]*)$`);

const NAME_SHAPE = /^\p{L}[\p{L}\p{M}'’.\- ]*$/u;

const SPEAKER_PROMPT = `You are identifying the speakers in a meeting transcript.

Automatic diarization labelled each speaker with a placeholder because it does not know who they are: a Greek letter (Alpha, Beta, Gamma, ...), S1/S2, or "Me" for the person who made the recording. Work out each placeholder's real name from the conversation itself: self-introductions, people addressing each other by name, someone being greeted or thanked by name, someone being handed a topic they own. "Me" is named the same way — the others address them by name too.

The participant list is taken from the calendar invitation, so it often holds email addresses instead of names. An address is legitimate evidence for the rest of a name you already heard: if the conversation calls someone Nadezhda and the list holds n.zorina@example.com, answer "Nadezhda Zorina". Prefer the full name over a bare given name whenever the list supports it.

Rules you must not break:
- Use only names that are actually spoken in the transcript or listed as participants. Never guess a name from a role, an accent or a topic.
- An address alone never names anybody. A single initial fits dozens of given names, so n.zorina@example.com is evidence only once "Nadezhda" has been spoken in the transcript. If no part of a name was spoken, that placeholder is unknown: answer ?.
- Write the name as its owner would introduce themselves: the plain dictionary form, not the form it is declined into when someone calls out to them.
- Keep the name in the script of the transcript. Never transliterate it — a surname read off an address is written in the transcript's own script, not as the address spells it.
- If a placeholder's name is not clearly established, answer ? for it. A wrong name is far worse than no name.
- Answer one line per placeholder, exactly: Placeholder -> Name (short evidence)
- Output those lines and nothing else.`;

/// The naming pass's whole instruction: the prompt, then the domain terms with
/// a heading of their own, then what the header knows about this meeting.
/// Assembled here rather than at the call site so that a missing piece leaves no
/// empty block and no stray heading behind, and so the meeting's own facts stay
/// last — the closing line of a prompt is the one a small model obeys hardest,
/// and it must not be an imperative borrowed from proofreading.
function speakerInstruction({ terms = '', meetingTitle = '', participants = [] } = {}) {
    const context = [];
    if (meetingTitle) context.push(`Meeting: ${meetingTitle}`);
    if (participants.length) context.push(`Participants: ${participants.join(', ')}`);
    return [SPEAKER_PROMPT, terms, context.join('\n')].filter(Boolean).join('\n\n');
}

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
    if (s === 'Me' || s === 'Speaker' || s === '?' || s === '…') return true;
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

// An elision inside one turn. Visible on purpose: the model is reading a
// transcript, and a turn that jumps mid-sentence without a mark reads as a
// recognition error it should account for.
const EVIDENCE_ELISION = ' […] ';

// Roughly the least text that still says something about who anyone is — a
// short sentence. Below it a turn is a stub, so the fallback keeps fewer turns
// instead of more stubs: at 900 characters for 300 turns, letting the marker
// lines take what they liked left every turn cut to two letters, and the pass
// was then guaranteed to name nobody.
const MIN_EVIDENCE_TEXT = 60;

/// `text` cut to `max` characters from the middle. The two ends are what name a
/// person — a turn opens by addressing someone and closes by handing something
/// over — so the middle is what goes.
function trimMiddle(text, max) {
    if (text.length <= max) return text;
    // Never an unmarked jump: below the width of the elision itself there is no
    // room for a cut a reader could see, so the turn keeps its marker and no
    // text at all rather than a mid-word stub.
    if (max <= EVIDENCE_ELISION.length) return '';
    const keep = max - EVIDENCE_ELISION.length;
    const head = Math.ceil(keep / 2);
    return text.slice(0, head) + EVIDENCE_ELISION + text.slice(text.length - (keep - head));
}

/// Water-filling: an equal share each, and whatever a turn does not need for its
/// full text raises the share of the ones that do. Sorted ascending so the
/// leftovers flow to the long turns — an even split would trim a 30-character
/// "да, согласен" to nothing while a monologue still lost most of itself.
function shareOut(sizes, budget) {
    const out = new Array(sizes.length).fill(0);
    const order = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
    let left = Math.max(0, budget);
    let n = order.length;
    for (const i of order) {
        const take = Math.min(sizes[i], Math.floor(left / n));
        out[i] = take;
        left -= take;
        n--;
    }
    return out;
}

/// The turns the model gets to reason over: every one of them, in order, whole
/// while the budget allows and trimmed in the middle once it does not.
///
/// It used to stride across the meeting instead, and that is precisely how this
/// pass failed — a name said exactly once, in a skipped turn, was invisible,
/// while summarize (which reads the file whole) resolved the same speaker. At an
/// equal budget trimming keeps every naming cue a stride threw away, and at the
/// shipped budget a real meeting goes through untouched.
function speakerEvidence(blocks, noteLabel = 'Note', maxChars = DEFAULT_EVIDENCE_CHARS) {
    let usable = blocks.filter((b) => !isNoteBlock(b, noteLabel) && b.text.trim());
    if (!usable.length) return '';
    const render = (b, max) => `${b.marker}\n${max === undefined ? b.text : trimMiddle(b.text, max)}`;
    if (usable.reduce((n, b) => n + blockSize(b), 0) <= maxChars) {
        return usable.map((b) => render(b)).join('\n\n');
    }
    // What a turn costs before a character of its text — the marker line, its
    // newline and the blank line before the next turn — and what it costs with
    // the least text worth sending.
    const fixed = (b) => b.marker.length + 3;
    const floor = (b) => fixed(b) + MIN_EVIDENCE_TEXT;
    let overhead = usable.reduce((n, b) => n + fixed(b), 0);
    const wanted = usable.reduce((n, b) => n + floor(b), 0);
    if (wanted > maxChars) {
        // ponytail: more turns than the budget can say anything about, so turns
        // are dropped and a name said once in a dropped turn is missed again.
        // Reachable only past ~1500 turns at the shipped budget; raise the budget
        // if a transcript that long shows up.
        const stride = Math.ceil(wanted / maxChars);
        const kept = [];
        let used = 0;
        for (let i = 0; i < usable.length; i += stride) {
            if (used + floor(usable[i]) > maxChars) break;
            kept.push(usable[i]);
            used += fixed(usable[i]);
        }
        // Too small for even one turn: there is no evidence to send, and a marker
        // line over the cap is worse than none.
        if (!kept.length) return '';
        usable = kept;
        overhead = used;
    }
    const budgets = shareOut(usable.map((b) => b.text.length), maxChars - overhead);
    return usable.map((b, i) => render(b, budgets[i])).join('\n\n');
}

function participantsFromHeader(header) {
    const line = String(header || '').split('\n').find((l) => /^Participants:/i.test(l));
    if (!line) return [];
    return line.slice(line.indexOf(':') + 1).split(',').map((s) => s.trim()).filter(Boolean);
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/// Spoken somewhere, as a word rather than a substring: "Ол" must not qualify on
/// the strength of "Олег", or a placeholder gets someone else's name.
///
/// A name of four letters or more matches by its stem plus a short ending,
/// because the vocative that names a speaker in the first place is declined:
/// the model answers "Олег" and the transcript says "Олега", "Валеру" for
/// "Валерий", "Марину" for "Марина". Demanding the exact answered form threw
/// away almost every correct answer in a Russian meeting — the single biggest
/// reason this pass ended up renaming nothing. The ending is capped at three
/// letters so a stem cannot swallow an unrelated longer word ("Марк" must not
/// ride in on "маркетинг"), and shorter names still need an exact word: three
/// letters of prefix match half the dictionary.
const MAX_INFLECTION_CHARS = 3;

function spokenIn(word, haystack) {
    const stem = word.length >= 4 ? word.slice(0, Math.max(4, word.length - 2)) : word;
    const ending = word.length >= 4 ? `\\p{L}{0,${MAX_INFLECTION_CHARS}}` : '';
    return new RegExp(`(^|[^\\p{L}])${escapeRe(stem)}${ending}([^\\p{L}]|$)`, 'iu').test(haystack);
}

// ─── Binding a name's unspoken parts to a participant's address ─────────────
// A surname is very often nowhere in the speech: colleagues call each other by
// the given name, and the surname exists only in the `Participants:` line, which
// a calendar fills with email addresses (`i.example@corp.com`). Summarize
// resolves those speakers because it reads the addresses and treats them as
// evidence; this pass could not, so it dropped every full name the model
// answered and named almost nobody.
//
// So an address may supply the *rest* of a name whose given part was heard —
// never the name itself. Binding on its own attests nothing: a single initial
// fits any given name, so `i.example@` would have happily "confirmed" Ирина,
// Игорь or Инна for a person who never spoke. That is the one failure this
// module's header promises cannot happen.

// Exact equality is too strict and any two edits are too loose, so the budget
// is one substitution at the *same length*, and nothing below five characters.
//
// Same length is what keeps a different person out: `zorin` and `zorina` are one
// edit apart and two people, and a Russian surname's feminine form differs from
// the masculine by exactly that trailing letter. The drift the address book
// really shows is a letter swapped in place — measured against one meeting's 16
// addresses, 14 surnames transliterate exactly and one lands one substitution
// away (`…уряков` → `uryakov` where the address spells `uriakov`). Below five
// characters even a substitution covers too much of the language, so those must
// match outright.
//
// The cost of being this strict is a binding missed when transliteration changes
// the length (`ц` → `ts` against an address's `c`), and a missed binding is a
// placeholder left alone — the failure this module is allowed to have.
const SEGMENT_FUZZY_MIN = 5;
const SEGMENT_EDITS = 1;

// Below two letters everything is an initial, and an initial names nobody. Such
// a part attests nothing by either route: it can never bind, and `И`, `О` and `А`
// are ordinary Russian words, so finding one "spoken" proves nothing either.
const MIN_PART_CHARS = 2;

// The scheme corporate address books actually use for Cyrillic. `й`/`ы` → y and
// `я` → ya are the drifty ones; the one-substitution budget above absorbs the
// difference. Any letter missing from this table survives into the output as
// Cyrillic and can then match nothing — the test sweeps the alphabets below and
// fails on the first gap, because a silent gap here reads as "that colleague
// simply has no name in the transcript".
const CYRILLIC_LATIN = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
    щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
    // Serbian, the team's other alphabet: `Ђорђевић` has to reach
    // `djordjevic`, which is how the address spells it.
    ј: 'j', љ: 'lj', њ: 'nj', ћ: 'c', ђ: 'dj', џ: 'dz', ѕ: 'dz', ќ: 'k', ѓ: 'g',
    // Ukrainian and Belarusian, from the same address book.
    і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u',
};

/// A name part → the Latin an address is likely to spell it with: lower case,
/// no separators, no diacritics. Diacritics are folded rather than dropped, so
/// `Müller` becomes `muller` and not `mller` — a deleted letter is an edit the
/// fuzzy budget then has to pay for.
function translit(part) {
    let out = '';
    for (const ch of String(part).normalize('NFC').toLowerCase()) {
        out += ch in CYRILLIC_LATIN ? CYRILLIC_LATIN[ch] : ch;
    }
    return out.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

/// The pieces of a participant entry's local part: `i.saridi@corp.com` →
/// `['i', 'saridi']`. An entry that is not an address has no segments and can
/// therefore bind nothing — a bare name in the list attests by being that name,
/// not by being taken apart.
function addressSegments(entry) {
    const at = String(entry).indexOf('@');
    if (at <= 0) return [];
    return String(entry).slice(0, at).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function segmentMatches(needle, segment) {
    if (needle.length !== segment.length) return false;
    if (needle.length < SEGMENT_FUZZY_MIN) return needle === segment;
    return withinDistance(needle, segment, SEGMENT_EDITS);
}

/// Every part matched to a *distinct* segment: two parts must not both claim the
/// one `zorin` in `a.zorin@`, or `Зорин Зорин` would bind to a real person.
///
/// `initials` lets a one-letter segment — how `i.saridi@` spells a given name —
/// match a part by its first letter. Only ever true for a name already heard:
/// an initial fits dozens of given names, so it can corroborate one but never
/// supply one, which is why `bindingEntry` runs without it.
// ponytail: greedy, first segment that fits wins. A name has at most three
// parts and an address two or three segments, so a perfect matching this misses
// would need a contrived address; swap in Hopcroft-Karp if one turns up.
function bindsEveryPart(parts, entry, initials = false) {
    const segments = addressSegments(entry);
    if (segments.length < parts.length) return false;
    const used = new Set();
    return parts.every((part) => {
        const needle = translit(part);
        // Checked again after transliteration: `И.` is two characters and one
        // letter, and it would otherwise bind to the initial in `i.saridi@`.
        if (needle.length < MIN_PART_CHARS) return false;
        const fits = (s) => segmentMatches(needle, s)
            || (initials && s.length === 1 && needle[0] === s);
        const at = segments.findIndex((s, i) => !used.has(i) && fits(s));
        if (at === -1) return false;
        used.add(at);
        return true;
    });
}

/// The one participant entry every unspoken part binds to, or '' — for none and
/// for more than one, since an ambiguous binding proves nothing: two colleagues
/// share a surname and only one of them is in the room.
function bindingEntry(parts, participants) {
    const bound = participants.filter((entry) => bindsEveryPart(parts, entry));
    return bound.length === 1 ? bound[0] : '';
}

function listedVerbatim(name, participants) {
    const lower = String(name).toLowerCase();
    return participants.find((p) => String(p).toLowerCase() === lower) || '';
}

function nameParts(name) {
    return String(name).trim().split(/\s+/).filter(Boolean);
}

const NOT_ATTESTED = { ok: false, entry: '' };

/// Attested — safe to write — and what it leans on. `entry` is the participant
/// entry that carried the name: the entry that *is* the name, or the one address
/// that supplied every part nobody spoke; '' when the speech alone carried it.
///
/// One function, because two callers ask two halves of the same question — may
/// this name be written, and is that entry the same person (so the header must
/// not list both). Asked twice by two rules that can drift, the answer becomes a
/// header contradicting its own body.
///
/// `parseSpeakerNames` writes the model's string exactly as answered, so a part
/// waved through here is a part that ends up in the transcript.
function attestation(name, body, participants) {
    const listed = listedVerbatim(name, participants);
    if (listed) return { ok: true, entry: listed };
    const parts = nameParts(name);
    if (!parts.length || parts.some((p) => p.length < MIN_PART_CHARS)) return NOT_ATTESTED;
    const unspoken = parts.filter((p) => !spokenIn(p, body));
    if (!unspoken.length) return { ok: true, entry: '' };
    // Nothing heard at all: an address cannot make up the difference.
    if (unspoken.length === parts.length) return NOT_ATTESTED;
    const entry = bindingEntry(unspoken, participants);
    // The surname binds, but the name has to be *that same* participant's:
    // every part, the spoken ones included, must fit one address. Checking only
    // the unspoken parts let a given name heard from one colleague be stamped
    // onto another colleague's surname — "Ольга" spoken and `i.saridi@` listed
    // is not Ольга Сариди.
    if (!entry || !bindsEveryPart(parts, entry, true)) return NOT_ATTESTED;
    return { ok: true, entry };
}

// One answered line, in any shape a model actually returns: `Beta = Anna`,
// `Beta: Anna`, `- **Beta** -> Anna Petrova (introduces herself at 00:02)`. The
// arrow forms and the parenthesised evidence are the reason: asking for the
// evidence is what makes the answer better (it is what the summarize prompt asks
// for, and that one resolves speakers well), so the parser has to accept the
// shape that comes back with it. A stricter `label = name` reader dropped every
// such line and reported the whole pass as "no names found".
const REPLY_LINE = /^\s*(?:[-*•]\s*)?(.+?)\s*(?:=|:|→|->|=>)\s*(.+?)\s*$/;

function stripDecoration(s) {
    return String(s).replace(/[*_`"'«»]/g, '').trim();
}

/// The name alone: no markdown, no quotes, and no trailing evidence — neither
/// the parenthesised form the prompt asks for nor a dash-separated aside. An
/// answer already in display form (`Anna (Beta)`) reduces to the name too.
function cleanName(s) {
    return stripDecoration(s)
        .replace(/\s+[—–]\s+.*$/, '')
        .replace(/\s*\([^()]*\)\s*$/, '')
        .trim();
}

/// Model reply → a validated `label → name` map. Every rule that fails drops
/// that one label and keeps its placeholder; nothing fails the whole pass.
function parseSpeakerNames(reply, { labels = [], body = '', participants = [], phonetic = [] } = {}) {
    const wanted = new Map(labels.map((l) => [l.toLowerCase(), l]));
    const map = new Map();
    const taken = new Set();
    const claimed = new Set();
    for (const line of stripCodeFence(String(reply || '')).split('\n')) {
        const m = REPLY_LINE.exec(line);
        if (!m) continue;
        const label = wanted.get(stripDecoration(m[1]).toLowerCase());
        const name = cleanName(m[2]);
        if (!label || map.has(label)) continue;
        if (!name || name === '?' || /^(unknown|unclear|n\/?a)$/i.test(name)) continue;
        if (name.length > MAX_NAME_CHARS) continue;
        if (name.split(/\s+/).length > MAX_NAME_WORDS) continue;
        if (!NAME_SHAPE.test(name)) continue;
        // A placeholder is not a name — the model echoing the label back, or
        // swapping one placeholder for another, must not be written in.
        if (isPlaceholderLabel(name, phonetic)) continue;
        if (taken.has(name.toLowerCase())) continue;   // two speakers, one name
        const attested = attestation(name, body, participants);
        if (!attested.ok) continue;
        // One participant is one person. Two labels whose names were both read
        // off the same address cannot both be right — the model was choosing
        // given names to fit one initial — so the second is dropped rather than
        // guessed between.
        if (attested.entry && claimed.has(attested.entry)) continue;
        map.set(label, name);
        taken.add(name.toLowerCase());
        if (attested.entry) claimed.add(attested.entry);
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

/// Same written form, plus the address it was bound from (when known), kept
/// rather than discarded — a wrong binding then only mispairs a name next to
/// a still-recoverable address instead of destroying it. `address` is looked
/// up by label (see addressFor in renameParticipantsLine below), not read off
/// whichever raw entry triggered this call: the same person can appear twice
/// in Participants: (the placeholder listed verbatim AND their address), and
/// both must annotate identically or the dedup below stops collapsing them.
function displaySpeakerAnnotated(name, label, address) {
    const display = displaySpeaker(name, label);
    return address ? `${display} <${address}>` : display;
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
///
/// Two entries can be the same person — the placeholder diarization produced and
/// the address the calendar listed. Both become the same `Name (Label) <address>`
/// string and the dedupe below collapses them into one. The address is kept,
/// annotated rather than replaced outright: a wrong binding then only mispairs
/// a name next to a still-recoverable address instead of destroying it. `body`
/// is what says which parts were spoken, and therefore which entry a name
/// leaned on; a caller with no body still gets the placeholder rewrite, with
/// no address to annotate.
function renameParticipantsLine(header, map, body = '') {
    if (!map || !map.size) return header;
    return String(header || '').split('\n').map((line) => {
        if (!/^Participants:/i.test(line)) return line;
        const head = line.slice(0, line.indexOf(':') + 1);
        const entries = line.slice(line.indexOf(':') + 1)
            .split(',').map((s) => s.trim()).filter(Boolean);
        // entry → the label whose name that entry belongs to.
        const bound = new Map();
        for (const [label, name] of map) {
            const { entry } = attestation(name, body, entries);
            if (entry && !bound.has(entry)) bound.set(entry, label);
        }
        // label → the one address-shaped entry bound to it, so every entry
        // resolving to the same label (the placeholder listed verbatim AND its
        // address, when both are in the header) annotates identically — not
        // just whichever entry happened to trigger the lookup.
        const addressFor = new Map();
        for (const entry of entries) {
            if (!/@/.test(entry)) continue;
            const label = bound.get(entry);
            if (label && !addressFor.has(label)) addressFor.set(label, entry);
        }
        const seen = new Set();
        const names = entries
            .map((entry) => {
                if (map.has(entry)) return displaySpeakerAnnotated(map.get(entry), entry, addressFor.get(entry));
                const label = bound.get(entry);
                return label ? displaySpeakerAnnotated(map.get(label), label, addressFor.get(label)) : entry;
            })
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
    // Exported for its own test: MIN_EVIDENCE_TEXT keeps `speakerEvidence` from
    // ever handing it a budget this small, so the no-unmarked-cut rule has no
    // other way to be pinned.
    trimMiddle,
    participantsFromHeader,
    translit,
    parseSpeakerNames,
    renameSpeakers,
    renameParticipantsLine,
    displaySpeaker,
    speakerInstruction,
    SPEAKER_PROMPT,
};
