'use strict';

// node test/summary-frontmatter.test.js
const assert = require('assert');
const { normalizeSummary, hasValidFrontmatter } = require('../summary-frontmatter');

const DATE = '2026-08-05';
const HEALTHY = `---
categories:
  - "[[Meetings]]"
type:
  - project
date: ${DATE}
people:
  - Valerii Ovchinnikov
topics:
---

## Summary

Текст саммари.
`.trim();

const MISSING_CLOSE = `---
categories:
  - "[[Meetings]]"
date: ${DATE}
topics:
  - sc

## Summary

Текст саммари.
`.trim();

const PREAMBLE = `Task simple. No plan needed, no code touch. Skip plan mode ceremony, just output summary directly.

${MISSING_CLOSE}`;

const NO_FRONTMATTER = `Ниже представлено структурированное резюме встречи.

## Summary

Текст саммари.
`.trim();

const run = (t) => normalizeSummary(t, { date: DATE });

// A sound summary must survive byte-for-byte.
{
    const r = run(HEALTHY);
    assert.strictEqual(r.text, HEALTHY);
    assert.deepStrictEqual(r.repairs, []);
}

// Form 1: opened, never closed.
{
    const r = run(MISSING_CLOSE);
    assert.deepStrictEqual(r.repairs, ['missing_close']);
    assert.ok(hasValidFrontmatter(r.text));
    assert.ok(r.text.startsWith(`---\ncategories:`));
    assert.ok(r.text.includes(`  - sc\n---\n\n## Summary`), r.text);
}

// Form 2: model reasoning above the block — moved below it, block repaired.
// It is moved rather than deleted because nothing here can tell leaked reasoning
// apart from summary prose; the assertion that matters is that the frontmatter
// now starts at line 0 and that no line of the summary was lost.
{
    const r = run(PREAMBLE);
    assert.deepStrictEqual(r.repairs, ['preamble', 'missing_close']);
    assert.ok(hasValidFrontmatter(r.text));
    assert.ok(r.text.startsWith('---\ncategories:'));
    assert.ok(r.text.indexOf('Skip plan mode ceremony') > r.text.indexOf('\n---\n'), r.text);
    assert.ok(r.text.includes('Текст саммари.'), r.text);
}

// Form 3: no frontmatter at all — synthesize, keep every line of the body.
{
    const r = run(NO_FRONTMATTER);
    assert.deepStrictEqual(r.repairs, ['synthesized']);
    assert.ok(hasValidFrontmatter(r.text));
    assert.ok(r.text.includes(`date: ${DATE}`));
    assert.ok(r.text.endsWith(NO_FRONTMATTER));
}

// Form 4: `--- ` with a trailing space is not a delimiter to Obsidian.
{
    const r = run(HEALTHY.replace(/^---$/m, '--- '));
    assert.deepStrictEqual(r.repairs, ['trailing_space']);
    assert.strictEqual(r.text, HEALTHY);
}

// …and the same break on the *closing* delimiter, which the validator must
// report as broken rather than accept.
{
    const dirtyClose = HEALTHY.replace('\n---\n', '\n--- \n');
    assert.ok(!hasValidFrontmatter(dirtyClose));
    const r = run(dirtyClose);
    assert.deepStrictEqual(r.repairs, ['trailing_space']);
    assert.strictEqual(r.text, HEALTHY);
}

// CRLF output: sound frontmatter must stay sound, not gain a second block.
{
    const r = run(HEALTHY.split('\n').join('\r\n'));
    assert.deepStrictEqual(r.repairs, []);
    assert.strictEqual(r.text, HEALTHY);
}

// A custom prompt writes its own fields — no `date`/`categories` in sight. The
// unterminated block still gets closed instead of buried under a stub.
{
    const custom = '---\ntitle: Weekly sync\ntags:\n  - work\n\n## Notes\n\nBody.';
    const r = run(custom);
    assert.deepStrictEqual(r.repairs, ['missing_close']);
    assert.ok(hasValidFrontmatter(r.text));
    assert.ok(r.text.startsWith('---\ntitle: Weekly sync'), r.text);
    assert.ok(r.text.includes('  - work\n---\n\n## Notes'), r.text);
}

// Leaked reasoning is not always one line — a multi-paragraph preamble must be
// moved below the block too, not left above it under a synthesized stub.
{
    const long = 'Line one of reasoning.\n\nLine two of reasoning.\n\nHere is the summary:\n\n' + MISSING_CLOSE;
    const r = run(long);
    assert.deepStrictEqual(r.repairs, ['preamble', 'missing_close']);
    assert.ok(r.text.startsWith('---\ncategories:'));
    assert.ok(r.text.indexOf('Line one of reasoning') > r.text.indexOf('\n---\n'), r.text);
    assert.ok(r.text.includes('Текст саммари.'), r.text);
    assert.ok(hasValidFrontmatter(r.text));
}

// A `---` rule inside the preamble must not end the search — the real block sits
// after it, and giving up buries it under a stub.
{
    const r = run('Вот резюме встречи.\n\n---\n\n' + HEALTHY);
    assert.deepStrictEqual(r.repairs, ['preamble']);
    assert.ok(hasValidFrontmatter(r.text));
    assert.ok(r.text.startsWith('---\ncategories:'));
    assert.ok(r.text.includes('Вот резюме встречи.'));
}

// The break this module exists to fix, plus a horizontal rule further down: the
// rule is NOT the closing delimiter. Accepting it swallowed the top of the
// summary into the YAML block and reported the note as sound.
{
    const r = run(MISSING_CLOSE + '\n\n---\n\n## Action Items\n\n- Denis');
    assert.deepStrictEqual(r.repairs, ['missing_close']);
    assert.ok(hasValidFrontmatter(r.text));
    assert.ok(r.text.includes('  - sc\n---\n\n## Summary'), r.text);
    assert.ok(r.text.includes('Текст саммари.'), r.text);
}

// Body prose resuming after the block's blank line must stay in the body — a
// blank line ends the block, `Speaker: quote` lines are not frontmatter.
{
    const r = run('---\ndate: ' + DATE + '\ntopics:\n\nIvan: ship on Friday.\n\n## Summary\n\nText.');
    assert.deepStrictEqual(r.repairs, ['missing_close']);
    assert.ok(r.text.includes('topics:\n---\n\nIvan: ship on Friday.'), r.text);
}

// A `|` block scalar's continuation lines belong to the block, not the body.
{
    const r = run('---\ntitle: Weekly\nsummary: |\n  Line one\n  Line two\ntopics:\n\n## Body\n\nText.');
    assert.deepStrictEqual(r.repairs, ['missing_close']);
    assert.ok(r.text.includes('  Line two\ntopics:\n---\n\n## Body'), r.text);
}

// Cyrillic keys are valid Obsidian properties — these summaries are written in
// Russian, so an ASCII-only key pattern would bury every custom block.
{
    const cyrillic = '---\nдата: ' + DATE + '\nучастники:\n  - Денис\n---\n\n## Итог\n\nТекст.';
    assert.ok(hasValidFrontmatter(cyrillic));
    const r = run(cyrillic);
    assert.deepStrictEqual(r.repairs, []);
    assert.strictEqual(r.text, cyrillic);
}

// Column-0 list items are valid YAML sequences and several models emit them.
{
    const r = run('---\ncategories:\n- "[[Meetings]]"\ndate: ' + DATE + '\ntopics:\n- sc\n\n## Summary\n\nText.');
    assert.deepStrictEqual(r.repairs, ['missing_close']);
    assert.ok(hasValidFrontmatter(r.text));
    assert.ok(r.text.startsWith('---\ncategories:\n- "[[Meetings]]"'), r.text);
}

// A body that ends in a code block is not a fenced whole-response wrapper —
// unwrapping it there deletes the code block's own closing fence.
{
    const fenced = '```markdown\n' + HEALTHY + '\n\n```bash\nnpm run rollback\n```';
    const r = run(fenced);
    assert.ok(r.text.includes('npm run rollback\n```'), r.text);
}

// Frontmatter we cannot read is left alone rather than buried under a stub: two
// `---` openers is not a repair. The save handlers warn on it instead.
{
    const r = run('---\ntitle: only one key\n\n## Notes\n\nBody.');
    assert.deepStrictEqual(r.repairs, []);
    assert.ok(!hasValidFrontmatter(r.text));
    assert.ok(r.text.startsWith('---\ntitle: only one key'), r.text);
}

// Whole-response code fence.
{
    const r = run('```markdown\n' + HEALTHY + '\n```');
    assert.strictEqual(r.text, HEALTHY);
    assert.deepStrictEqual(r.repairs, []);
}

// Prose that merely contains a horizontal rule must not be mistaken for
// frontmatter — nothing gets cut, a stub goes on top.
{
    const junk = 'Meeting transcript quality bad. Extract signal despite noise.\n\n---\n\n## Speaker Mapping\n\n- Denis';
    const r = run(junk);
    assert.deepStrictEqual(r.repairs, ['synthesized']);
    assert.ok(hasValidFrontmatter(r.text));
    assert.ok(r.text.includes('Meeting transcript quality bad.'));
}

// Empty/garbage input still yields an indexable note rather than a broken one.
{
    const r = run('');
    assert.deepStrictEqual(r.repairs, ['synthesized']);
    assert.ok(hasValidFrontmatter(r.text));
}

assert.ok(!hasValidFrontmatter(MISSING_CLOSE));
assert.ok(!hasValidFrontmatter(NO_FRONTMATTER));
assert.ok(hasValidFrontmatter(HEALTHY));

console.log('summary-frontmatter: all checks passed');
