'use strict';

// Summaries are written by the model, frontmatter delimiters and all — nothing
// in this app ever built that YAML block. Models drop the closing `---`, leak a
// line of reasoning above the block, or skip the frontmatter entirely; Obsidian
// Bases/Dataview then silently refuse to index the note. This module is the
// deterministic gate between model output and disk.
//
// The repair heuristics are a port of ~/code/evening-wrap/lib/fix_frontmatter.py,
// which has been cleaning up after this bug in the vault for a while.
//
// No Electron, no dependencies — plain CommonJS so `node test/summary-frontmatter.test.js`
// can exercise it directly.

// Repair-side: tolerant, so a delimiter with trailing whitespace is recognised
// and cleaned. Read-side (`hasValidFrontmatter`) compares against a bare `---`
// instead — Obsidian does not accept `--- `, so a validator that does would pass
// exactly the break this module repairs.
const DELIM = /^---[ \t]*$/;
// A line that belongs inside a YAML block: top-level key, list item at column 0,
// or any indented continuation (nested keys, indented list items, `|`/`>` scalar
// bodies). Unicode-aware: these summaries are written in Russian, and an
// ASCII-only key pattern scores a Cyrillic block as "not frontmatter".
// A blank line is deliberately NOT in the set — it ends the block. Frontmatter
// does not contain blank lines, but summary bodies open with them, and treating
// one as in-block absorbs the first paragraph into the YAML.
const YAML_LINE = /^(?:[\p{L}_][\p{L}\p{N}_-]*:|-\s|\s+\S)/u;
const TOP_LEVEL_KEY = /^[\p{L}_][\p{L}\p{N}_-]*:/u;
const PREAMBLE_LOOKAHEAD = 10;

// Whole-response code fence: ```markdown … ``` wrapped around everything.
function stripCodeFence(text) {
    const lines = text.split('\n');
    if (lines.length < 2) return text;
    if (!/^```[A-Za-z]*$/.test(lines[0].trim())) return text;
    let last = lines.length - 1;
    while (last > 0 && !lines[last].trim()) last -= 1;
    if (lines[last].trim() !== '```') return text;
    // Any fence in between means these two are not a pair — the response merely
    // starts and ends with code blocks. Unwrapping there truncates the body.
    if (lines.slice(1, last).some((l) => l.trim().startsWith('```'))) return text;
    return lines.slice(1, last).join('\n').trim();
}

function keyCount(blockLines) {
    return blockLines.filter((l) => TOP_LEVEL_KEY.test(l)).length;
}

// Index of the closing delimiter for a block opened at lines[0], or -1.
function closingDelimiter(lines) {
    if (!lines.length || !DELIM.test(lines[0])) return -1;
    for (let i = 1; i < lines.length; i += 1) {
        if (DELIM.test(lines[i])) return i;
    }
    return -1;
}

// End of the YAML-shaped run for a block opened at lines[0] — the index of the
// first line that cannot be inside the block (a blank, a heading, prose, or the
// closing `---` itself). 0 when the block is empty.
function findBlockEnd(lines) {
    let end = 1;
    while (end < lines.length && YAML_LINE.test(lines[end])) end += 1;
    return end > 1 ? end : 0;
}

// Mirrors what Obsidian actually indexes: opened and closed by a bare `---`,
// at least one key.
function hasValidFrontmatter(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    if (lines[0] !== '---') return false;
    const end = lines.indexOf('---', 1);
    return end > 0 && keyCount(lines.slice(1, end)) > 0;
}

function stubFrontmatter(date) {
    return ['---', 'categories:', '  - "[[Meetings]]"', `date: ${date}`, 'topics:', '---', ''];
}

/**
 * Make a model-generated summary safe to write: frontmatter always opened and
 * closed, no model preamble above it.
 *
 * Fails closed. Every branch either produces an indexable note or returns the
 * text untouched for the caller to warn about — no branch may drop a line of
 * model output. The shape tests here cannot tell real frontmatter from prose
 * that merely looks like it, so "unsure" must never mean "delete".
 *
 * @param  {string} text            raw model output
 * @param  {object} opts            { date: 'YYYY-MM-DD' } used only when synthesizing
 * @return {{ text: string, repairs: string[] }}  repairs: preamble | trailing_space |
 *         missing_close | synthesized (empty array = output was already sound)
 */
function normalizeSummary(text, { date }) {
    const repairs = [];
    // CRLF up front: every check below is line-anchored, and `'---\r'` matches
    // none of them — a sound CRLF summary would look like it had no frontmatter
    // at all and get a stub prepended above its own block.
    let lines = stripCodeFence(String(text || '').replace(/\r\n/g, '\n').trim()).split('\n');

    // Model reasoning above the block. Never deleted: a `---` rule followed by two
    // `Word:` lines is shape-identical to real frontmatter, and summary prose hits
    // that shape often (`Owner:`, `Decision:`, `Итог:`). Moved below the block
    // instead — the note gets indexed either way, and a stray line of reasoning in
    // the body is a nuisance the user can see and delete, unlike a deleted summary.
    // Every `---` in the window is a candidate, not just the first: leaked reasoning
    // can itself contain a horizontal rule, and giving up on it would bury the real
    // block that follows under a synthesized stub.
    let preamble = [];
    if (!DELIM.test(lines[0])) {
        for (let i = 1; i <= PREAMBLE_LOOKAHEAD && i < lines.length; i += 1) {
            if (!DELIM.test(lines[i])) continue;
            const rest = lines.slice(i);
            if (keyCount(rest.slice(1, findBlockEnd(rest))) < 2) continue;
            preamble = lines.slice(0, i);
            lines = rest;
            repairs.push('preamble');
            break;
        }
    }

    if (DELIM.test(lines[0])) {
        if (lines[0] !== '---') {
            lines[0] = '---';
            repairs.push('trailing_space');
        }
        const blockEnd = findBlockEnd(lines);
        const close = closingDelimiter(lines);
        // A `---` past the end of the YAML-shaped run is a horizontal rule in the
        // body, not the closer. Accepting it swallows everything above the rule
        // into the block: the note stops rendering that text and the YAML no
        // longer parses, while every check downstream reports the note as sound.
        if (close > 0 && close <= blockEnd) {
            if (lines[close] !== '---') {
                lines[close] = '---';
                if (!repairs.includes('trailing_space')) repairs.push('trailing_space');
            }
        } else if (keyCount(lines.slice(1, blockEnd)) >= 2) {
            const body = lines.slice(blockEnd);
            while (body.length && !body[0].trim()) body.shift();
            lines = lines.slice(0, blockEnd).concat(['---', ''], body);
            repairs.push('missing_close');
        }
    }

    if (preamble.length) {
        const close = lines.indexOf('---', 1);
        lines = close > 0
            ? lines.slice(0, close + 1).concat([''], preamble, lines.slice(close + 1))
            : lines.concat([''], preamble);
    }

    // Nothing parseable and no block of the model's own to conflict with: prepend
    // a minimal one so the note is at least indexable. people/type/org stay out —
    // we don't invent metadata. When the text DOES open with `---` the block is
    // real but unreadable to us; a stub above it would give the note two openers
    // and demote the model's metadata to body text, so leave it and let
    // `hasValidFrontmatter` drive the warning the save handlers return.
    if (!hasValidFrontmatter(lines.join('\n')) && lines[0] !== '---') {
        lines = stubFrontmatter(date).concat(lines);
        repairs.push('synthesized');
    }

    return { text: lines.join('\n'), repairs };
}

module.exports = { normalizeSummary, hasValidFrontmatter };
