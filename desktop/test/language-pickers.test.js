'use strict';
// node test/language-pickers.test.js
//
// Four segmented controls let the user pick a transcription language: the Live
// tab's setup form, the batch settings screen, and the Record tab's setup and
// recording screens. They are four copies of one vocabulary, which is exactly
// the shape that rots — add Italian to one and the other three silently offer a
// different app. The Record ones are worse than cosmetic: they all write the same
// `batchSettings.language`, so a code only one of them lists is a value the
// others cannot display as selected.
//
// Source-text assertions are the only reachable kind here: the markup is static
// and the values live in index.html, not in any module a test can require.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const src = fs.readFileSync(HTML, 'utf-8');

// The one vocabulary. Restated here on purpose: this file is the contract, so a
// change to index.html has to be a deliberate change here too.
const EXPECTED = ['ru', 'en', 'sr', 'es', 'de', 'fr', 'auto'];

// Four now: Live's setup, the batch settings screen, and the Record tab's two
// (setup and recording screen). The Record pair writes one setting, so a code
// only one of them lists is a value the other cannot show as selected.
const PICKERS = ['live-language', 'ts-lang-seg', 'record-setup-lang-seg', 'record-rec-lang-seg'];

/// The markup of one `id="…"` container, brace-free so a nested element cannot
/// truncate it: everything from the id up to the matching close of that div.
function blockOf(id) {
    const open = src.indexOf(`id="${id}"`);
    assert.notStrictEqual(open, -1, `#${id} not found in renderer/index.html — renamed or removed?`);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src.startsWith('<div', i)) depth++;
        else if (src.startsWith('</div>', i) && --depth === 0) return src.slice(open, i);
    }
    throw new Error(`#${id} has no matching </div>`);
}

/// One entry per `<button …>` in the block: its language and whether it is the
/// pre-selected one. Attribute order is deliberately not part of the match —
/// swapping two attributes changes nothing about the behaviour under test.
function optionsOf(id) {
    const block = blockOf(id);
    return [...block.matchAll(/<button\b[^>]*>/g)]
        .map((m) => m[0])
        .filter((tag) => /data-lang="/.test(tag))
        .map((tag) => ({
            lang: tag.match(/data-lang="([^"]+)"/)[1],
            active: /\bis-active\b/.test(tag),
        }));
}

const langsOf = (id) => optionsOf(id).map((o) => o.lang);

for (const id of PICKERS) {
    test(`#${id} offers exactly the shared language set, in order`, () => {
        assert.deepStrictEqual(langsOf(id), EXPECTED);
    });
}

test('no picker carries the dead "More…" option', () => {
    // `data-lang="more"` shipped as a button whose click handler returned early,
    // so it looked like a choice and did nothing. Nothing may reintroduce it
    // without also giving it behaviour.
    assert.strictEqual(src.includes('data-lang="more"'), false);
});

test('exactly one option per picker starts selected', () => {
    for (const id of PICKERS) {
        const active = optionsOf(id).filter((o) => o.active);
        assert.strictEqual(active.length, 1, `#${id} should mark exactly one option active`);
        assert.ok(EXPECTED.includes(active[0].lang), `#${id}'s active option is not in the shared set`);
    }
});

test('the pills announce themselves as a radio group', () => {
    // They are <button>s, so nothing about them says "pick one of these" to a
    // screen reader unless the roles are spelled out. `aria-checked` is kept in
    // sync by paintLangSegs; here we only pin the initial markup.
    for (const id of PICKERS) {
        const block = blockOf(id);
        assert.ok(/role="radiogroup"/.test(block), `#${id} is not a radiogroup`);
        const tags = [...block.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
        for (const tag of tags) {
            assert.ok(/role="radio"/.test(tag), `an option in #${id} is missing role="radio": ${tag}`);
            assert.ok(/aria-checked="(true|false)"/.test(tag), `an option in #${id} is missing aria-checked`);
        }
        const checked = tags.filter((t) => /aria-checked="true"/.test(t));
        assert.strictEqual(checked.length, 1, `#${id} should start with exactly one aria-checked option`);
    }
});

test('the two tccutil troubleshoot blocks cannot drift apart', () => {
    // The Live setup and the Record setup each carry a copy of the reset
    // command, bundle id and all. Two copies of one literal is exactly what the
    // rest of this file exists to prevent, and only a test can hold them equal.
    const cmd = (id) => {
        const m = src.match(new RegExp(`<code id="${id}">([\\s\\S]*?)</code>`));
        assert.ok(m, `#${id} not found in renderer/index.html`);
        return m[1].trim();
    };
    assert.strictEqual(cmd('record-tcc-reset-cmd'), cmd('live-tcc-reset-cmd'));
});
