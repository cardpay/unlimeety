'use strict';
// node test/setup-screens.test.js
//
// The Record and Live start screens are one design sharing one column,
// `.live-setup-inner`, inside a scroll container. Centering a flex item in a
// scroll container puts half the overflow above the top edge, where scrollTop
// cannot reach it: at 1200x800 with the troubleshoot disclosure open, Live's
// heading sat 146 px above `scrollTop: 0` and could not be scrolled to.
// `margin: auto` centers identically when the form fits and collapses to zero
// when it does not, so the overflow all lands below.
//
// This drifted once already: Record got the `margin: auto` fix as its own
// `#record-setup .live-setup-inner` override and Live kept the broken
// centering. So none of the checks below are scoped to one file or one
// selector — every renderer stylesheet loads into the same document, and the
// last declaration wins wherever it lives.
//
// Geometry itself needs a real browser; `npm run check:layout` measures it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'renderer');
const SHARED = path.join('live', 'live.css'); // where the shared rules must live

function cssFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return cssFiles(p);
        return e.isFile() && e.name.endsWith('.css') ? [p] : [];
    });
}

// Brace-matching walk yielding every style rule as { selector, body }, with
// at-rule wrappers (@media, @supports, …) flattened so a re-declaration nested
// inside one is caught rather than skipped. Naive about braces inside strings —
// none of these stylesheets has any, and a miscount would fail loudly.
// ponytail: regex-free scanner, swap for a real parser if strings ever appear.
function* rules(css) {
    let i = 0;
    let preludeStart = 0;
    while (i < css.length) {
        if (css[i] === '{') {
            const prelude = css.slice(preludeStart, i).trim();
            let depth = 1;
            let j = i + 1;
            while (j < css.length && depth > 0) {
                if (css[j] === '{') depth++;
                else if (css[j] === '}') depth--;
                j++;
            }
            const body = css.slice(i + 1, j - 1);
            if (prelude.startsWith('@')) yield* rules(body);
            else yield { selector: prelude, body };
            i = j;
            preludeStart = i;
        } else if (css[i] === '}') {
            preludeStart = ++i;
        } else {
            i++;
        }
    }
}

// True when this comma-separated part targets `target` itself rather than a
// descendant of it: `#live-setup`, `body.x #live-setup`, `#live-setup:hover` —
// but not `#live-setup .live-setup-inner`.
function targetsSelf(part, target) {
    const last = part.trim().split(/[\s>+~]+/).pop() || '';
    return last === target || last.startsWith(`${target}:`)
        || last.startsWith(`${target}.`) || last.startsWith(`${target}[`);
}

const sheets = cssFiles(RENDERER).map((file) => ({
    rel: path.relative(RENDERER, file),
    // Comments only; the scanner handles nesting.
    css: fs.readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ''),
}));
assert.ok(sheets.some((s) => s.rel === SHARED), `expected to find renderer/${SHARED}`);

// Every rule in every stylesheet that targets one of the two containers, or the
// shared column, wherever it lives and however its selector list is written.
function matching(target) {
    const found = [];
    for (const { rel, css } of sheets) {
        for (const { selector, body } of rules(css)) {
            if (selector.split(',').some((part) => targetsSelf(part, target))) {
                found.push({ rel, selector, body });
            }
        }
    }
    return found;
}

// ─── 1. Neither container may re-introduce a centring keyword ───────────────
// Not just the first matching rule and not just its own stylesheet: a grouped
// `#live-setup, #record-setup { align-items: center }`, a second rule further
// down, or one inside an @media is the same bug.
for (const container of ['#live-setup', '#record-setup']) {
    const found = matching(container);
    assert.ok(found.length > 0, `expected a ${container} rule somewhere in renderer/`);
    for (const { rel, selector, body } of found) {
        for (const prop of ['align-items', 'justify-content', 'place-items', 'place-content']) {
            assert.doesNotMatch(
                body, new RegExp(`(^|[;{\\s])${prop}\\s*:[^;]*\\bcenter\\b`),
                `${rel} — \`${selector}\` must not centre with \`${prop}\`: on a scroll `
                + "container that puts the form's heading above the unreachable "
                + 'top of the box. Use `margin: auto` on .live-setup-inner instead.'
            );
        }
    }
}

// ─── 2. The shared column centres with auto margins on BOTH axes ───────────
const columns = matching('.live-setup-inner');
const inSharedFile = columns.filter((r) => r.rel === SHARED);
assert.ok(
    inSharedFile.length > 0,
    `.live-setup-inner must be defined in renderer/${SHARED} — it is the rule both `
    + 'start screens read from'
);

// Last margin declaration wins, so that is the one that has to be all-auto:
// `margin: auto 0` centres horizontally only, and a trailing `margin-top: 0`
// undoes the shorthand above it just as effectively.
// Two objects from one source: a /g regex carries lastIndex between .test()
// calls, and assert.doesNotMatch below uses .test().
const MARGIN_SRC = '(^|[;{\\s])(margin(?:-top|-bottom|-left|-right|-block|-inline'
    + '|-block-start|-block-end|-inline-start|-inline-end)?)\\s*:\\s*([^;}]+)';
const MARGIN_ALL = new RegExp(MARGIN_SRC, 'g');
const MARGIN_ONE = new RegExp(MARGIN_SRC);
const lastMargin = inSharedFile.flatMap(({ body }) => [...body.matchAll(MARGIN_ALL)]).pop();
assert.ok(lastMargin, `.live-setup-inner in renderer/${SHARED} declares no margin at all`);
assert.strictEqual(
    lastMargin[2], 'margin',
    `the last margin declaration on .live-setup-inner is the longhand `
    + `\`${lastMargin[2]}\`, which overrides the centring shorthand`
);
assert.ok(
    lastMargin[3].trim().split(/\s+/).every((v) => v === 'auto'),
    `.live-setup-inner needs auto margins on both axes, got \`margin: ${lastMargin[3].trim()}\` `
    + '— one non-auto value drops that axis back to no centring'
);

// ─── 3. No second copy of the rule to drift away from it ───────────────────
for (const { rel, selector, body } of columns) {
    if (rel === SHARED) continue;
    assert.doesNotMatch(
        body, MARGIN_ONE,
        `${rel} — \`${selector}\` re-declares a margin on .live-setup-inner. One rule in `
        + `renderer/${SHARED}, not two that drift apart: Record got the scroll fix that way `
        + 'the first time and Live kept the broken centering.'
    );
}

// ─── 4. The markup still uses the shared class ─────────────────────────────
// Rename it in index.html and every assertion above still passes while both
// screens break.
const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf-8');
for (const id of ['live-setup', 'record-setup']) {
    const start = html.indexOf(`id="${id}"`);
    assert.ok(start > 0, `index.html should still have a #${id} section`);
    const section = html.slice(start, html.indexOf('</section>', start));
    assert.match(
        section, /class="live-setup-inner"/,
        `#${id} must still wrap its rows in .live-setup-inner — that shared class is `
        + 'what every rule checked above is attached to'
    );
}

console.log('setup-screens: all checks passed');
