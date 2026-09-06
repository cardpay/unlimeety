'use strict';
// node test/escape-html.test.js
//
// Security review flagged escapeHtml() (renderer/app.js) as not escaping a
// single quote — every call site today wraps its attributes in double
// quotes, so this wasn't exploitable, but it was one character away from XSS
// the moment any future call site used single-quoted attributes instead.
// renderer/app.js is a classic script with no exports, so the function is
// sliced out and evaluated standalone, same technique as
// test/theme-pref-guard.test.js uses on the same file.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf-8');

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

const region = sliceFunction('escapeHtml');
new vm.Script(region, { filename: 'slice:escape-html' });

const escapeHtml = new Function(`${region}\nreturn escapeHtml;`)();

test('escapeHtml escapes all five HTML-significant characters', () => {
    assert.strictEqual(
        escapeHtml(`& < > " '`),
        '&amp; &lt; &gt; &quot; &#39;',
    );
});

test('escapeHtml neutralizes a single-quoted-attribute break-out', () => {
    const payload = `'><img src=x onerror=alert(1)>`;
    const escaped = escapeHtml(payload);
    assert.ok(!escaped.includes("'"), 'a raw single quote must not survive escaping');
    assert.strictEqual(escaped, '&#39;&gt;&lt;img src=x onerror=alert(1)&gt;');
});

console.log('escape-html: all checks passed');
