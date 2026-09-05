'use strict';
// node test/panel-theme.test.js
//
// The two floating panels — the recording prompt and the live-notes widget —
// used to pin `color-scheme: dark` and hardcode dark hex literals, so on the
// light theme they floated as dark cards over a light desktop. They now link
// renderer/theme-init.js (which resolves the shared `uds-theme` preference onto
// <html data-theme> — see theme-init.test.js) plus renderer/panel-theme.css,
// the ONE stylesheet holding both the dark defaults and the light overrides.
//
// Guarded here, beyond the original bug:
//   1. any color reaching a panel outside a shared custom property, in ANY
//      notation — `color: white` is the likeliest regression of the lot, since
//      `.primary` really was `color: #fff` before this change;
//   2. the light palette drifting — a `:root` property with no counterpart in
//      the `[data-theme="light"]` block silently keeps its dark value. That is
//      how the setup-screen fix drifted once already (see the header of
//      setup-screens.test.js), which is why panel-theme.css is shared at all;
//   3. the panels' CSP loosening past the one `'self'` this change needs.
//
// Rendering itself needs a real browser; nothing here can see a blocked
// stylesheet or a panel that never got the preference — that is checked by hand
// with an Electron harness, and tracked in deferred-work.md.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'renderer');
const SHARED = 'panel-theme.css';
const PANELS = [path.join('prompt', 'prompt.html'), path.join('notes', 'notes.html')];

const read = (rel) => fs.readFileSync(path.join(RENDERER, rel), 'utf-8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

// Body of a top-level rule, found by selector-then-brace with whitespace free
// to move, so reformatting the stylesheet does not fail the suite. Both blocks
// in panel-theme.css are flat declaration lists, so no nesting to unwind.
function block(css, re, label) {
    const m = css.match(re);
    assert.ok(m, `${SHARED} must declare a \`${label}\` block`);
    const open = css.indexOf('{', m.index);
    return css.slice(open + 1, css.indexOf('}', open));
}

// `prop: value` pairs of a flat declaration list. Values here hold no colon or
// brace, so splitting on `;` is enough.
function decls(body) {
    const out = new Map();
    for (const part of body.split(';')) {
        const i = part.indexOf(':');
        if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    return out;
}

// Compare colors, not their spelling: `#fff`/`#FFFFFF` and `rgba(0,0,0,.1)`
// with either spacing are the same value, and the drift assertion below must
// not be satisfiable by that kind of trivia.
function norm(v) {
    return v.trim().toLowerCase()
        .replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ')
        .replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, '#$1$1$2$2$3$3');
}

// Tokens that are genuinely theme-independent and so are expected to be equal
// in both blocks. Kept explicit — and asserted in BOTH directions below, so it
// cannot quietly grow to cover real drift.
const SAME_IN_BOTH_THEMES = new Set([
    '--panel-primary-fg', // white ink on the red Record/Stop button either way
]);

// ─── 1. panel-theme.css holds the dark defaults and a full light override ───
const shared = stripComments(read(SHARED));
const dark = decls(block(shared, /:root\s*\{/, ':root'));
const light = decls(block(
    shared, /:root\s*\[\s*data-theme\s*=\s*"light"\s*\]\s*\{/, ':root[data-theme="light"]',
));

assert.strictEqual(dark.get('color-scheme'), 'dark',
    `${SHARED} \`:root\` must keep \`color-scheme: dark\` — a panel with no `
    + 'data-theme has to render exactly as it did before this change');
assert.strictEqual(light.get('color-scheme'), 'light',
    `${SHARED} light block must set \`color-scheme: light\` so native widgets `
    + 'and scrollbars follow the card');

for (const prop of dark.keys()) {
    assert.ok(light.has(prop),
        `${SHARED} — \`${prop}\` is declared in \`:root\` but not in the `
        + '`[data-theme="light"]` block, so it silently keeps its dark value on the '
        + 'light theme. Every default needs a light counterpart or it is drift.');
    if (prop === 'color-scheme') continue;
    const same = norm(light.get(prop)) === norm(dark.get(prop));
    if (SAME_IN_BOTH_THEMES.has(prop)) {
        assert.ok(same,
            `${SHARED} — \`${prop}\` is listed in SAME_IN_BOTH_THEMES but its two `
            + 'values differ. Either drop it from that list or make them match.');
    } else {
        assert.ok(!same,
            `${SHARED} — \`${prop}\` resolves to the same color in both themes. Give it `
            + 'a light value from theme-light.css, or add it to SAME_IN_BOTH_THEMES if '
            + 'it is genuinely theme-independent.');
    }
}

// Nothing light-only either: a property overridden with no default is undefined
// on dark, which renders as an unset color rather than the current look.
for (const prop of light.keys()) {
    assert.ok(dark.has(prop),
        `${SHARED} — \`${prop}\` is only in the \`[data-theme="light"]\` block; without a `
        + '`:root` default it resolves to nothing on the dark theme');
}

// ─── 2. Both panels load the theme script and the shared stylesheet ─────────
// Matched on tag + src/href rather than byte-exact markup, so attribute order
// and a self-closing slash are free to change.
const referenced = new Set(); // every --panel-* the panels actually read

for (const rel of PANELS) {
    const html = read(rel);
    const head = html.slice(0, html.indexOf('</head>'));

    assert.match(head, /<script\b[^>]*\bsrc="\.\.\/theme-init\.js"/,
        `${rel} must load ../theme-init.js from <head> — it sets data-theme before `
        + 'first paint, so the card never flashes the wrong theme');
    const link = head.match(/<link\b[^>]*\bhref="\.\.\/panel-theme\.css"[^>]*>/);
    assert.ok(link, `${rel} must link ../${SHARED} — the only stylesheet these panels share`);
    assert.match(link[0], /\brel="stylesheet"/, `${rel} — the ../${SHARED} <link> needs rel="stylesheet"`);

    // ── CSP: the 'self' this change needs, and nothing else loosened ──
    const csp = head.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/);
    assert.ok(csp, `${rel} should still carry a Content-Security-Policy meta tag`);
    const directives = new Map(csp[1].split(';').map((d) => d.trim()).filter(Boolean)
        .map((d) => [d.split(/\s+/)[0], d]));

    assert.strictEqual(directives.get('default-src'), "default-src 'none'",
        `${rel} — \`default-src 'none'\` is the floor these panels are built on; `
        + `got \`${directives.get('default-src')}\``);
    assert.ok((directives.get('style-src') || '').includes("'self'"),
        `${rel} — style-src is \`${directives.get('style-src')}\`; it needs 'self' or the `
        + `browser blocks ../${SHARED} with no visible error`);
    for (const unsafe of ["'unsafe-inline'", "'unsafe-eval'"]) {
        assert.ok(!(directives.get('script-src') || '').includes(unsafe),
            `${rel} — script-src must not gain ${unsafe}. Adding 'self' to style-src is `
            + 'the only CSP change this fix is allowed; theme-init.js is a file, not inline.');
    }

    // The panels must not link the main window's stylesheets: those assume the
    // app shell's markup and would drag its opaque backgrounds into a
    // transparent, frameless panel.
    for (const sheet of ['style.css', 'live.css', 'theme-light.css']) {
        assert.doesNotMatch(html, new RegExp(`href="[^"]*${sheet.replace('.', '\\.')}"`),
            `${rel} must not link ${sheet} — only ${SHARED} is shared with the panels`);
    }

    // ── No color may reach a panel except through a shared property ──
    const style = stripComments(html).match(/<style>([\s\S]*?)<\/style>/);
    assert.ok(style, `${rel} should still have an inline <style> block`);
    assert.doesNotMatch(style[1], /color-scheme\s*:/,
        `${rel} must not declare color-scheme — ${SHARED} owns it, and pinning \`dark\` `
        + 'here is the original bug');

    // Allowlist rather than a blocklist of notations: hex, rgb(), hsl(), lab(),
    // oklch(), color-mix(), `white`, `ButtonFace` and anything CSS adds next all
    // fail this, whereas a `#[0-9a-f]{3,8}` blocklist waved most of them through.
    const COLOR_PROP = /(^|-)(color|background|shadow|fill|stroke|outline|border)(-|$)/;
    const ALLOWED = /^(none|transparent|currentcolor|inherit|initial|unset|solid|dashed|dotted|inset|[\d.]+(px|em|rem|%)?)$/;

    for (const [, body] of style[1].matchAll(/\{([^{}]*)\}/g)) {
        for (const part of body.split(';')) {
            const i = part.indexOf(':');
            if (i <= 0) continue;
            const prop = part.slice(0, i).trim().toLowerCase();
            if (!COLOR_PROP.test(prop)) continue; // `transition: background …` is not a color
            // Strip the shared properties, then every token left must be
            // geometry or a keyword that carries no color of its own.
            const rest = part.slice(i + 1).toLowerCase()
                .replace(/var\((--panel-[\w-]+)\)/g, (_m, name) => (referenced.add(name), ' '));
            for (const tok of rest.split(/[\s,]+/).filter(Boolean)) {
                assert.ok(ALLOWED.test(tok),
                    `${rel} — \`${prop}\` carries \`${tok}\`, which is not a var(--panel-…) `
                    + `or a colorless keyword. Add a property to ${SHARED} (dark default + `
                    + 'light override) and reference it, or the light theme cannot reach it.');
            }
        }
    }
}

// ─── 3. The palette is exactly what the panels read ─────────────────────────
// Nothing missing: a var() with no declaration is dropped in silence and the
// element renders unstyled. Nothing dead either: a token no panel reads is a
// color with no way to see it, and a light value nobody can check.
assert.deepStrictEqual(
    [...dark.keys()].filter((k) => k.startsWith('--')).sort(),
    [...referenced].sort(),
    `${SHARED} must declare exactly the --panel-* properties the two panels read `
    + '— left side is what it declares, right side is what they reference',
);

// ─── 4. panel-theme.css's light values match theme-light.css's own ──────────
// panel-theme.css's own header comment says its light block borrows these
// values from theme-light.css — because the panels are locked-down `file://`
// documents that cannot link theme-light.css directly (see SHARED's header),
// the values are copied as literals instead, with nothing enforcing the
// mapping. Re-tune a token in theme-light.css and this is what would silently
// leave the panels on the stale color (deferred-work.md, "panel-theme.css
// copies its light values ... with nothing enforcing the mapping").
//
// Not every --panel-* light value has a theme-light.css counterpart: some are
// panel-specific (--panel-bg is a plain white card, not a named token) and one
// is a documented deliberate deviation (--panel-focus-border uses a solid
// --accent, not the alpha --border-focus, per its own comment above) — both
// are correctly absent from this map, not omissions.
const themeLight = decls(block(
    stripComments(read('theme-light.css')), /:root\s*\[\s*data-theme\s*=\s*"light"\s*\]\s*\{/,
    'theme-light.css :root[data-theme="light"]',
));
const PANEL_TO_THEME_LIGHT = {
    '--panel-border': '--border-strong',
    '--panel-title': '--text-primary',
    '--panel-muted': '--text-secondary',
    '--panel-hover': '--bg-hover',
    '--panel-primary': '--rec',
    '--panel-primary-hover': '--danger',
    '--panel-primary-fg': '--accent-fg',
    '--panel-ghost-text': '--text-secondary',
    '--panel-ghost-border': '--border-strong',
    '--panel-row-border': '--border',
    '--panel-note-time': '--text-secondary',
    '--panel-note-text': '--text-primary',
    '--panel-input-bg': '--bg-elevated',
    '--panel-input-border': '--border-strong',
    '--panel-dim': '--text-muted',
};
for (const [panelProp, themeProp] of Object.entries(PANEL_TO_THEME_LIGHT)) {
    assert.ok(themeLight.has(themeProp),
        `theme-light.css no longer declares \`${themeProp}\` — ${SHARED}'s \`${panelProp}\` `
        + 'has nothing to be checked against; update this map if the token was renamed');
    assert.strictEqual(norm(light.get(panelProp)), norm(themeLight.get(themeProp)),
        `${SHARED}'s \`${panelProp}\` (${light.get(panelProp)}) has drifted from theme-light.css's `
        + `\`${themeProp}\` (${themeLight.get(themeProp)}) — re-copy the value, or update both `
        + 'together next time.');
}

console.log('panel-theme: all checks passed');
