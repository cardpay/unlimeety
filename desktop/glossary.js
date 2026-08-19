'use strict';

// Domain glossary for the Enhance pass: the terms a speech recogniser mangles.
//
// One entry per line, TAB-separated: `term` first, then any number of known
// mishearings. Aliases carry the cases fuzzy matching cannot reach — a
// transliteration ("PayCore" heard as "пейкор") is a dozen edits away from the
// term, so it has to be spelled out.
//
//   PayCore<TAB>пейкор<TAB>пей кор
//   эквайринг
//   # comment
//
// Only the entries the chunk plausibly contains are sent: a 700-line glossary in
// every prompt would both cost more than the text it precedes and bury it.
//
// The parser, the word-boundary matcher and the crude stemmer are lifted from
// reword's lib/glossary.js. The selection rule is not: there the term appears
// verbatim and an exact match is enough, here the whole point is that it does
// not, so exact matching is only the first of three passes.

const MAX_ENTRIES = 40;

// Fuzzy matching is off below 5 characters — at that length one edit covers a
// large share of the language ("ACS" would fire on "ABS", "AR" on "AS").
const FUZZY_MIN_LENGTH = 5;
const FUZZY_LONG_LENGTH = 8;

function parse(text) {
    const entries = [];
    for (const line of String(text || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [term, ...aliases] = line.split('\t');
        if (!term || !term.trim()) continue;
        entries.push({
            term: term.trim(),
            aliases: aliases.map((a) => a.trim()).filter(Boolean),
        });
    }
    return entries;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// \b is ASCII-only in JS, so boundaries are spelled out with Unicode classes.
// Acronyms (no lowercase letter: ACS, AR, 3DS) need a closing boundary too or
// "AR" fires inside "card"; ordinary words match as a prefix after crude
// stemming, because the transcript is full of inflected forms ("эквайрингу").
const RU_ENDING = /(ого|его|ому|ему|ыми|ими|ый|ий|ой|ая|яя|ое|ее|ые|ие|ом|ем|ам|ям|ах|ях|ов|ев|ей|ия|ии|ию|[аеёиоуыэюяьй])$/iu;

// ponytail: ending list, not a real stemmer. Enough for the noun phrases a
// glossary holds; swap in a real Russian stemmer only if entries start missing.
function stemWord(word) {
    if (!/\p{Ll}/u.test(word)) return word;                          // acronym: leave alone
    if (/[Ѐ-ӿ]/.test(word)) return word.length > 3 ? word.replace(RU_ENDING, '') : word;
    return word.length > 4 ? word.replace(/[aeiouy]$/i, '') : word;  // schema → schem → schemas
}

function matcher(phrase) {
    const isAcronym = !/\p{Ll}/u.test(phrase);
    const body = phrase.trim().split(/\s+/).map((word) => escapeRegExp(stemWord(word))).join('[\\p{L}]*\\s+');
    const tail = isAcronym ? '(?![\\p{L}\\p{N}])' : '';
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}${tail}`, 'iu');
}

// Compiled once per entry and kept on it: Enhance calls `select` once per chunk,
// and rebuilding a few hundred regexes on every call was the dominant cost of
// the whole pass — worse than the fuzzy scan it was meant to precede.
function matchers(entry) {
    if (!entry._re) entry._re = [entry.term, ...entry.aliases].map(matcher);
    return entry._re;
}

// Levenshtein with an early exit: every row is checked against `max`, so a
// hopeless pair costs a couple of rows instead of the full matrix.
function withinDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
            if (row[j] < best) best = row[j];
        }
        if (best > max) return false;
        prev = row;
    }
    return prev[b.length] <= max;
}

function fuzzyBudget(phrase) {
    if (phrase.includes(' ')) return 0;                  // phrases: exact/alias only
    if (phrase.length < FUZZY_MIN_LENGTH) return 0;
    return phrase.length >= FUZZY_LONG_LENGTH ? 2 : 1;
}

// ponytail: every chunk word against every candidate term, O(words × terms).
// A chunk is a few thousand characters and the glossary a few hundred lines, so
// the whole scan is milliseconds; index by trigram if it ever drags.
function words(text) {
    return new Set(String(text || '').toLowerCase().match(/[\p{L}\p{N}+#]+/gu) || []);
}

function fuzzyHit(entry, chunkWords) {
    const candidates = [entry.term, ...entry.aliases];
    for (const candidate of candidates) {
        const budget = fuzzyBudget(candidate);
        if (!budget) continue;
        const needle = candidate.toLowerCase();
        for (const word of chunkWords) {
            if (withinDistance(word, needle, budget)) return true;
        }
    }
    return false;
}

// Two passes, exact first: when the cap bites, a term the chunk actually spells
// out is worth more to the model than one that only looks close to a word.
function select(entries, text, limit = MAX_ENTRIES) {
    const exact = [];
    const fuzzy = [];
    const chunkWords = words(text);
    for (const entry of entries) {
        if (matchers(entry).some((re) => re.test(text))) {
            exact.push(entry);
        } else if (fuzzyHit(entry, chunkWords)) {
            fuzzy.push(entry);
        }
    }
    return [...exact, ...fuzzy].slice(0, limit);
}

function render(entries) {
    if (!entries.length) return '';
    const lines = entries.map((e) =>
        e.aliases.length ? `- ${e.term} (heard as: ${e.aliases.join(', ')})` : `- ${e.term}`
    );
    return [
        'Domain terms — restore these spellings when the transcript mangles them:',
        ...lines,
    ].join('\n');
}

/// Convenience: glossary file text + one chunk → prompt block ('' if nothing
/// plausibly matched).
function blockFor(glossaryText, chunkText, limit = MAX_ENTRIES) {
    return render(select(parse(glossaryText), chunkText, limit));
}

module.exports = { parse, select, render, blockFor, MAX_ENTRIES };
