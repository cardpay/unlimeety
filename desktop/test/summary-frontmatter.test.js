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

// Form 2: model reasoning above the block — dropped, block repaired.
{
    const r = run(PREAMBLE);
    assert.deepStrictEqual(r.repairs, ['preamble', 'missing_close']);
    assert.ok(hasValidFrontmatter(r.text));
    assert.ok(!r.text.includes('Skip plan mode ceremony'));
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
