'use strict';
// node test/export-html.test.js
//
// spec-security-model-isolation.md: generatePdf loads buildExportHtml's output
// in an offscreen BrowserWindow with no CSP of its own — a transcript or a
// markdown-rendered summary that carried a `<script>` or a remote resource
// could run or phone home there. buildExportHtml now emits a locked-down CSP
// meta tag; this pins that it's present for both export kinds.
//
// renderer/app.js is a classic <script> with no exports, so the function is
// sliced out by name and evaluated standalone with trivial stand-ins for the
// renderer helpers it calls — same technique as test/participant-rename.test.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf-8');

function sliceFunction(name) {
    const start = APP.indexOf(`\nfunction ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in renderer/app.js — renamed or moved?`);
    let depth = 0;
    for (let i = APP.indexOf('{', start); i < APP.length; i++) {
        if (APP[i] === '{') depth++;
        else if (APP[i] === '}' && --depth === 0) return APP.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${name}()`);
}

const src = sliceFunction('buildExportHtml');
new vm.Script(src, { filename: 'slice:export-html' });
const { buildExportHtml } = new Function(
    'escapeHtml', 'renderMarkdown', 'parseFrontmatterFromMd',
    `${src}\nreturn { buildExportHtml };`,
)(
    (s) => s,                    // escapeHtml stub: pass text through
    (s) => s,                    // renderMarkdown stub: pass text through
    (text) => ({ body: text }),  // parseFrontmatterFromMd stub: no frontmatter
);

test('an exported transcript carries a locked-down CSP meta tag', () => {
    const html = buildExportHtml('transcript', 'hello');
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
});

test('an exported summary carries the same CSP meta tag', () => {
    const html = buildExportHtml('summary', '# hi');
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
});

console.log('export-html: all checks passed');
