'use strict';
// Shared by transcript-meta.test.js and rail-sections.test.js, which both read
// renderer/app.js off disk and eval a `// ── <name> ── ... // ── end <name> ──`
// marked region in isolation.

function findRegion(src, name) {
    return src.match(
        new RegExp(`\\n[ \\t]*// ── ${name}[\\s\\S]*?\\n[ \\t]*// ── end ${name} ──`),
    );
}

module.exports = { findRegion };
