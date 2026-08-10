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

const DELIM = /^---[ \t]*$/;
const DELIM_DIRTY = /^---[ \t]+$/;
// A line that belongs inside a YAML block: top-level key, nested key, list item,
// or blank.
const YAML_LINE = /^(?:[A-Za-z_][\w-]*:|\s+[A-Za-z_][\w-]*:|\s+-\s|\s*$)/;
const TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*):/;
const PREAMBLE_LOOKAHEAD = 5;

// Whole-response code fence: ```markdown … ``` wrapped around everything.
function stripCodeFence(text) {
    const lines = text.split('\n');
    if (lines.length < 2) return text;
    if (!/^```[A-Za-z]*$/.test(lines[0].trim())) return text;
    let last = lines.length - 1;
    while (last > 0 && !lines[last].trim()) last -= 1;
    if (lines[last].trim() !== '```') return text;
    return lines.slice(1, last).join('\n').trim();
}

function topLevelKeys(blockLines) {
    return blockLines.map((l) => l.match(TOP_LEVEL_KEY)).filter(Boolean).map((m) => m[1]);
}

// Index of the closing delimiter for a block opened at lines[0], or -1.
function closingDelimiter(lines) {
    if (!lines.length || !DELIM.test(lines[0])) return -1;
    for (let i = 1; i < lines.length; i += 1) {
        if (DELIM.test(lines[i])) return i;
    }
    return -1;
}

// First body line for an unterminated block (lines[0] === '---'): walk while the
// lines look like YAML, then rewind past trailing blanks. null if the block is empty.
// ponytail: a body that opens with prose shaped like `Key: value` gets absorbed into
// the block. Same ceiling as fix_frontmatter.py; a real YAML parser is the upgrade.
function findBlockEnd(lines) {
    let end = 1;
    while (end < lines.length && YAML_LINE.test(lines[end])) end += 1;
    while (end > 1 && !lines[end - 1].trim()) end -= 1;
    return end > 1 ? end : null;
}

// Strict on purpose: closing `---` too early loses fields, too late breaks the
// YAML. Only insert a delimiter where the block is unmistakably frontmatter.
function looksLikeFrontmatter(blockLines) {
    const keys = topLevelKeys(blockLines);
    return keys.length >= 2 && (keys.includes('date') || keys.includes('categories'));
}

// Lenient — mirrors what Obsidian actually indexes: opened, closed, at least one key.
function hasValidFrontmatter(text) {
    const lines = String(text || '').split('\n');
    const end = closingDelimiter(lines);
    if (end < 1) return false;
    return topLevelKeys(lines.slice(1, end)).length > 0;
}

function stubFrontmatter(date) {
    return ['---', 'categories:', '  - "[[Meetings]]"', `date: ${date}`, 'topics:', '---', ''];
}

function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Make a model-generated summary safe to write: frontmatter always opened and
 * closed, no model preamble above it.
 *
 * @param  {string} text            raw model output
 * @param  {object} [opts]          { date: 'YYYY-MM-DD' } used only when synthesizing
 * @return {{ text: string, repairs: string[] }}  repairs: preamble | trailing_space |
 *         missing_close | synthesized (empty array = output was already sound)
 */
function normalizeSummary(text, opts) {
    const date = (opts && opts.date) || todayIso();
    const repairs = [];
    let lines = stripCodeFence(String(text || '').trim()).split('\n');

    // Model reasoning above the block — only cut it when real frontmatter follows,
    // otherwise we'd be deleting summary prose we can't tell apart from noise.
    if (!DELIM.test(lines[0])) {
        for (let i = 1; i < Math.min(PREAMBLE_LOOKAHEAD, lines.length); i += 1) {
            if (!DELIM.test(lines[i])) continue;
            const rest = lines.slice(i);
            const end = closingDelimiter(rest);
            const block = end > 0 ? rest.slice(1, end) : rest.slice(1, findBlockEnd(rest) || 1);
            if (!looksLikeFrontmatter(block)) break;
            lines = rest;
            repairs.push('preamble');
            break;
        }
    }

    if (DELIM.test(lines[0])) {
        if (DELIM_DIRTY.test(lines[0])) {
            lines[0] = '---';
            repairs.push('trailing_space');
        }
        const end = closingDelimiter(lines);
        if (end > 0) {
            if (DELIM_DIRTY.test(lines[end])) {
                lines[end] = '---';
                if (!repairs.includes('trailing_space')) repairs.push('trailing_space');
            }
        } else {
            const blockEnd = findBlockEnd(lines);
            if (blockEnd && looksLikeFrontmatter(lines.slice(1, blockEnd))) {
                const body = lines.slice(blockEnd);
                while (body.length && !body[0].trim()) body.shift();
                lines = lines.slice(0, blockEnd).concat(['---', ''], body);
                repairs.push('missing_close');
            }
        }
    }

    // Still nothing parseable: prepend a minimal block so the note is at least
    // indexable. people/type/org stay out — we don't invent metadata.
    if (!hasValidFrontmatter(lines.join('\n'))) {
        lines = stubFrontmatter(date).concat(lines);
        repairs.push('synthesized');
    }

    return { text: lines.join('\n'), repairs };
}

module.exports = { normalizeSummary, hasValidFrontmatter };
