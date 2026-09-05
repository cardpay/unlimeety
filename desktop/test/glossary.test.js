'use strict';
// node test/glossary.test.js

const assert = require('assert');
const { parse, select, render, blockFor, withinDistance, MAX_ENTRIES, REFERENCE_HEADING }
    = require('../glossary');

// ─── parse ────────────────────────────────────────────────────────────────────
{
    const entries = parse([
        '# a comment',
        '',
        'PayCore\tпейкор\tпей кор',
        'эквайринг',
        '   ',
        '\torphan alias',
    ].join('\n'));
    assert.strictEqual(entries.length, 2, 'comments, blanks and alias-only lines are skipped');
    assert.deepStrictEqual(entries[0], { term: 'PayCore', aliases: ['пейкор', 'пей кор'] });
    assert.deepStrictEqual(entries[1], { term: 'эквайринг', aliases: [] });
}

// ─── select: the term itself is present ───────────────────────────────────────
{
    const entries = parse('PayCore\nэквайринг');
    assert.deepStrictEqual(
        select(entries, 'обсудили PayCore и эквайринг').map((e) => e.term),
        ['PayCore', 'эквайринг'],
        'terms present verbatim are selected',
    );
    assert.deepStrictEqual(select(entries, 'ничего по теме'), [], 'absent terms are not');
}

// Inflection: the transcript rarely uses the nominative.
{
    const entries = parse('эквайринг\nклиринговый файл');
    assert.strictEqual(select(entries, 'вопрос по эквайрингу').length, 1, 'эквайринг matches эквайрингу');
    assert.strictEqual(select(entries, 'баг с клиринговым файлом').length, 1, 'multi-word term inflects');
    assert.strictEqual(select(entries, 'файл не пришёл').length, 0, 'the noun alone is not the term');
}

// ─── select: alias (a known mishearing, often another script) ─────────────────
{
    const entries = parse('PayCore\tпейкор\tпей кор');
    assert.strictEqual(select(entries, 'в пейкоре это уже есть').length, 1, 'alias hits across scripts');
    assert.strictEqual(select(entries, 'сделали в пей кор вчера').length, 1, 'multi-word alias hits');
    assert.strictEqual(select(entries, 'ничего похожего').length, 0);
}

// ─── select: fuzzy, for same-script mangling ──────────────────────────────────
{
    const entries = parse('эквайринг\nчарджбэк\nAPI');
    assert.strictEqual(select(entries, 'проблема с эквайрином').length, 1, 'one edit away is selected');
    assert.strictEqual(select(entries, 'по чарджбеку ответили').length, 1, 'two edits away is selected');
    assert.strictEqual(select(entries, 'обсудили аквариум и апи-ключ').length, 0, 'unrelated words are not');
}

// Short words must not fuzzy-match half the language.
{
    const entries = parse('ACS\nAR');
    assert.strictEqual(select(entries, 'ACS вернул ошибку').length, 1, 'acronym matches standalone');
    assert.strictEqual(select(entries, 'card payments failed').length, 0, 'AR does not fire inside "card"');
    assert.strictEqual(select(entries, 'ABS и AS уже готовы').length, 0, 'no fuzzy for 2-3 char terms');
}

// ─── limit ────────────────────────────────────────────────────────────────────
{
    const many = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => `термин${i}`).join('\n');
    const text = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => `термин${i}`).join(' ');
    assert.strictEqual(select(parse(many), text).length, MAX_ENTRIES, 'selection is capped');
    assert.strictEqual(select(parse(many), text, 3).length, 3, 'the cap is overridable');
}

// Exact hits outrank fuzzy ones when the cap bites.
{
    const entries = parse('чарджбэк\nэквайринг');
    const picked = select(entries, 'эквайринг и чарджбеки', 1);
    assert.deepStrictEqual(picked.map((e) => e.term), ['эквайринг'], 'exact hit wins the last slot');
}

// ─── render ───────────────────────────────────────────────────────────────────
{
    const entries = parse('PayCore\tпейкор\nэквайринг');
    const block = render(entries);
    assert.strictEqual(
        block.split('\n')[0],
        'Domain terms — restore these spellings when the transcript mangles them:',
        'the proofreading block still carries the proofreading imperative');
    assert.match(block, /- PayCore \(heard as: пейкор\)/, 'aliases are shown to the model');
    assert.match(block, /- эквайринг$/m, 'a term without aliases renders bare');
    assert.strictEqual(render([]), '', 'nothing selected → no block');

    // The heading is the block's imperative, and the speaker naming pass must
    // not inherit the proofreading one — it answers `Placeholder -> Name` and an
    // imperative dangling at the end of its prompt is an instruction it follows.
    // Pinned by exact first line: both headings open with "Domain terms", so a
    // /^Domain terms/ match passes for either, and hard-coding the proofreading
    // heading back inside `render` would leave every other test green.
    assert.strictEqual(
        render(entries, REFERENCE_HEADING).split('\n')[0],
        'Domain terms and names that come up in this meeting, spelled correctly:',
        'the naming block states the terms and commands nothing');
    assert.strictEqual(render([], REFERENCE_HEADING), '', 'and an empty one leaves no heading behind');
}

// ─── withinDistance ───────────────────────────────────────────────────────────
// transcript-enhance.js binds a name to an email segment with this, across a
// module boundary, so the contract is pinned here: (a, b, max), max inclusive,
// and a length difference costs an edit like any other.
{
    assert.ok(withinDistance('zorina', 'zorina', 0), 'equal strings need no budget');
    assert.ok(withinDistance('kostyaeva', 'kostiaeva', 1), 'one substitution inside a budget of one');
    assert.ok(!withinDistance('kostyaeva', 'kostiaeva', 0), 'and outside a budget of none');
    assert.ok(!withinDistance('zorin', 'zorina', 0), 'a trailing letter is an edit');
    assert.ok(withinDistance('zorin', 'zorina', 1), 'which a budget of one pays for');
    assert.ok(!withinDistance('zorin', 'zorinaa', 1), 'two are two');
}

// ─── blockFor ─────────────────────────────────────────────────────────────────
{
    assert.strictEqual(blockFor('', 'какой-то текст'), '', 'empty glossary → no block');
    assert.strictEqual(blockFor(null, 'какой-то текст'), '', 'missing glossary → no block');
    assert.match(blockFor('PayCore\tпейкор', 'в пейкоре готово'), /PayCore/);
}

// Regex specials in a term must not blow up the matcher.
{
    assert.strictEqual(select(parse('C++'), 'пишем на C++ давно').length, 1, 'regex specials are escaped');
}

console.log('glossary: all checks passed');
