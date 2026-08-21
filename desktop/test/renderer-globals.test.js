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

const collisions = [];
for (const file of rendererScripts(RENDERER)) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
        const m = TOP_LEVEL.exec(line);
        if (m && bridges.has(m[1])) {
            collisions.push(`${path.relative(DESKTOP, file)}:${i + 1} declares '${m[1]}'`);
        }
    });
}

assert.deepStrictEqual(
    collisions, [],
    'renderer top-level binding shadows a contextBridge global (SyntaxError at load):\n  '
    + collisions.join('\n  ')
);

console.log('renderer-globals: all checks passed');
