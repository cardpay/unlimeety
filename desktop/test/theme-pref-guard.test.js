'use strict';
// node test/theme-pref-guard.test.js
//
// The main window's own uds-theme localStorage access used to be unguarded
// (unlike renderer/theme-init.js, which every panel shares and which
// test/theme-init.test.js already covers): a storage backend that throws on
// read/write would abort applyTheme() before it ever set data-theme, breaking
// the Settings theme radio live rather than just failing to persist the
// choice. readThemePref()/writeThemePref() close that; this pins the exact
// failure mode. renderer/app.js is a classic script with no exports, so the
// three functions are sliced out and evaluated standalone, same technique as
// test/ollama-options.test.js uses on main.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf-8');

function sliceConst(name) {
    const re = new RegExp(`\\nconst ${name} = [^;]+;`);
    const m = SRC.match(re);
    assert.ok(m, `const ${name} not found in renderer/app.js — renamed or moved?`);
    return m[0];
}

function sliceFunction(name) {
    const start = SRC.indexOf(`\nfunction ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in renderer/app.js — renamed or moved?`);
    let depth = 0;
    for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${name}()`);
}

const region = [
    sliceConst('lightThemeMQ'),
    sliceFunction('readThemePref'),
    sliceFunction('writeThemePref'),
    sliceFunction('applyTheme'),
].join('\n');
new vm.Script(region, { filename: 'slice:theme-pref-guard' });

function makeApplyTheme({ localStorage, matches = false }) {
    const documentEl = { documentElement: { dataset: {} } };
    const notifyChanged = () => { notifyChanged.called = true; };
    const windowStub = {
        matchMedia: () => ({ matches }),
        themeApi: { notifyChanged },
    };
    const applyTheme = new Function(
        'window', 'document', 'localStorage',
        `${region}\nreturn applyTheme;`,
    )(windowStub, documentEl, localStorage);
    return { applyTheme, documentEl, notifyChanged };
}

const THROWING_STORAGE = {
    getItem: () => { throw new DOMException('denied', 'SecurityError'); },
    setItem: () => { throw new DOMException('denied', 'SecurityError'); },
};

test('a throwing localStorage must not stop applyTheme from setting data-theme', () => {
    const { applyTheme, documentEl, notifyChanged } = makeApplyTheme({ localStorage: THROWING_STORAGE });
    applyTheme('light');
    assert.strictEqual(documentEl.documentElement.dataset.theme, 'light',
        'the theme must still apply live even though persisting it failed');
    assert.strictEqual(notifyChanged.called, true,
        'the floating panels must still be told, even on a storage failure');
});

test('a throwing localStorage resolves "system" against the OS, not a stuck value', () => {
    const { applyTheme, documentEl } = makeApplyTheme({ localStorage: THROWING_STORAGE, matches: true });
    applyTheme('system');
    assert.strictEqual(documentEl.documentElement.dataset.theme, 'light');
});

test('a working localStorage is unaffected — pref still round-trips', () => {
    const store = new Map();
    const workingStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
    };
    const { applyTheme, documentEl } = makeApplyTheme({ localStorage: workingStorage });
    applyTheme('dark');
    assert.strictEqual(store.get('uds-theme'), 'dark');
    assert.strictEqual(documentEl.documentElement.dataset.theme, 'dark');
});

console.log('theme-pref-guard: all checks passed');
