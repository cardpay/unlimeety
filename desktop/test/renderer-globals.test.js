'use strict';
// node test/renderer-globals.test.js
//
// Renderer scripts are classic <script> tags sharing one global lexical scope,
// and contextBridge exposes each bridge as a NON-CONFIGURABLE property on
// window. A top-level `const queueApi = window.queueApi` is therefore a
// SyntaxError that kills the whole file at parse time — silently, since
// `node --check` parses it as a module and sees nothing wrong. That shipped
// once: app.js died on load, taking the Transcripts sidebar and the header
// queue panel with it.
//
// Rule: never give a top-level binding in a renderer script the same name as a
// bridge. Use a different local name (`api = window.transcriber`,
// `jobsApi = window.queueApi`), or declare it inside an IIFE.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DESKTOP = path.join(__dirname, '..');
const RENDERER = path.join(DESKTOP, 'renderer');

const bridges = new Set(
    [...fs.readFileSync(path.join(DESKTOP, 'preload.js'), 'utf-8')
        .matchAll(/exposeInMainWorld\(\s*['"]([^'"]+)['"]/g)].map(m => m[1])
);

function rendererScripts(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return rendererScripts(p);
        return e.isFile() && e.name.endsWith('.js') ? [p] : [];
    });
}

// Column 0 only: anything indented is inside a function/IIFE and scoped safely.
const TOP_LEVEL = /^(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/;

assert.ok(bridges.size > 0, 'expected preload.js to expose at least one bridge');

const problems = [];
for (const file of rendererScripts(RENDERER)) {
    const rel = path.relative(DESKTOP, file);
    const src = fs.readFileSync(file, 'utf-8');
    // Same silent-death failure mode, other cause: a stray backtick inside an
    // injected-CSS template literal took calendar-picker.js out whole, so all
    // three "From calendar" buttons quietly did nothing. vm.Script parses the
    // way the browser loads a classic <script>, which is what these all are —
    // and the assertion below this loop keeps it that way, since vm.Script
    // rejects `import`/`export`/top-level await and would report a perfectly
    // good module as unparseable.
    try { new vm.Script(src, { filename: file }); }
    catch (err) { problems.push(`${rel} does not parse: ${err.message}`); }
    const lines = src.split('\n');
    lines.forEach((line, i) => {
        const m = TOP_LEVEL.exec(line);
        if (m && bridges.has(m[1])) {
            problems.push(`${rel}:${i + 1} shadows the bridge global '${m[1]}'`);
        }
    });
}

// Both kinds reported together: asserted separately, whichever ran first hid
// every finding of the other kind.
assert.deepStrictEqual(
    problems, [],
    'renderer script dies silently at load:\n  ' + problems.join('\n  ')
);

// vm.Script above can only vouch for classic scripts. The day one of these
// becomes type="module" this fires, rather than the parse check quietly
// reporting a bogus failure (or being quietly skipped).
assert.doesNotMatch(
    fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf-8'),
    /<script[^>]*\btype\s*=\s*["']module["']/,
    'a renderer script became type="module": the vm.Script parse check above '
    + 'cannot read modules, so switch it to `node --check` on an .mjs first'
);

console.log('renderer-globals: all checks passed');
