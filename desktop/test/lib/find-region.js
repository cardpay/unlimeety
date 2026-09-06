'use strict';
// Shared by transcript-meta.test.js, rail-sections.test.js and
// segment-offsets.test.js, which all read a renderer file off disk and eval a
// `// ── <name> ── ... // ── end <name> ──` marked region in isolation.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const RENDERER = path.join(__dirname, '..', '..', 'renderer');

function findRegion(src, name) {
    return src.match(
        new RegExp(`\\n[ \\t]*// ── ${name}[\\s\\S]*?\\n[ \\t]*// ── end ${name} ──`),
    );
}

// Reads renderer/<file> off disk and returns one marked region's source text.
function region(file, name) {
    const src = fs.readFileSync(path.join(RENDERER, file), 'utf-8');
    const m = findRegion(src, name);
    assert.ok(m, `"${name}" region markers not found in renderer/${file}`);
    return m[0];
}

module.exports = { findRegion, region };
