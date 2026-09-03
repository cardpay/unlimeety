'use strict';
// node test/theme-init.test.js
//
// renderer/theme-init.js is the one piece of logic the floating panels borrowed
// from the main window (see panel-theme.test.js): it resolves the stored
// `uds-theme` preference — including 'system' — onto <html data-theme> before
// first paint. It is a bare IIFE over three globals, so this reads it off disk
// and runs it with stubs, the way transcript-meta.test.js evals app.js regions.
//
// The panels' rendering needs a real browser; what is pinned here is only which
// preference produces which attribute.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'theme-init.js'), 'utf-8',
);

// Returns the data-theme the script would set for a stored preference and an
// OS appearance. `stored === undefined` stands for "never chosen"; the THROWS
// sentinel stands for storage the browser refuses to hand over as `stored`, and
// for a host whose matchMedia is unusable as `sysLight`.
const THROWS = Symbol('storage blocked');

function resolve(stored, sysLight) {
    const documentEl = { documentElement: { dataset: {} } };
    new Function('localStorage', 'window', 'document', SRC)(
        {
            getItem: (k) => {
                if (stored === THROWS) throw new DOMException('denied', 'SecurityError');
                return k === 'uds-theme' && stored !== undefined ? stored : null;
            },
        },
        {
            matchMedia: (q) => {
                if (sysLight === THROWS) throw new TypeError('matchMedia is not a function');
                return { matches: q === '(prefers-color-scheme: light)' && sysLight };
            },
        },
        documentEl,
    );
    return documentEl.documentElement.dataset.theme;
}

// Unset must stay dark: that is the look every panel shipped with, and a first
// run must not flip to light just because the OS is.
assert.strictEqual(resolve(undefined, true), 'dark');
assert.strictEqual(resolve(undefined, false), 'dark');

assert.strictEqual(resolve('dark', true), 'dark');
assert.strictEqual(resolve('light', false), 'light');

// 'system' is the only value that reads the OS.
assert.strictEqual(resolve('system', true), 'light');
assert.strictEqual(resolve('system', false), 'dark');

// Storage the browser refuses to read must not throw out of a <head> script:
// that would abort before data-theme is set and leave the page unstyled.
assert.strictEqual(resolve(THROWS, true), 'dark');
assert.strictEqual(resolve(THROWS, false), 'dark');

// A value outside {light, dark, system} — hand-edited storage, or a key left by
// an older build — must land on dark rather than be written through:
// `data-theme="Light"` matches neither stylesheet block, so the panel renders
// dark with nothing reporting it.
assert.strictEqual(resolve('Light', true), 'dark');
assert.strictEqual(resolve('LIGHT', false), 'dark');
assert.strictEqual(resolve('midnight', true), 'dark');
// Empty string is the same case, and `|| 'dark'` used to be the only thing
// catching it — a truthiness check would not have caught 'Light' above.
assert.strictEqual(resolve('', true), 'dark');

// A host whose matchMedia throws must still come out with an attribute set —
// aborting mid-resolution is exactly what leaves the page unstyled.
assert.strictEqual(resolve('system', THROWS), 'dark');

// ...and an explicit preference must never consult matchMedia at all, so a
// throwing one cannot affect it.
assert.strictEqual(resolve('light', THROWS), 'light');
assert.strictEqual(resolve('dark', THROWS), 'dark');

// window.__themeInit.apply lets an already-loaded window re-resolve the
// preference later (notes.js calls it on a main-process broadcast). Unlike
// resolve() above, this needs stubs that persist across two calls: the first
// runs the script's own load-time apply(), the second is the explicit re-run.
{
    let stored = 'dark';
    const documentEl = { documentElement: { dataset: {} } };
    const windowStub = { matchMedia: () => ({ matches: false, addEventListener: () => {} }) };
    new Function('localStorage', 'window', 'document', SRC)(
        { getItem: (k) => (k === 'uds-theme' ? stored : null) },
        windowStub,
        documentEl,
    );
    assert.strictEqual(documentEl.documentElement.dataset.theme, 'dark');

    stored = 'light';
    windowStub.__themeInit.apply();
    assert.strictEqual(documentEl.documentElement.dataset.theme, 'light');
}

console.log('theme-init: all checks passed');
