'use strict';
// node test/claude-args.test.js
//
// spec-security-model-isolation.md: the two privacy flags
// (--no-session-persistence, --strict-mcp-config) must live in
// CLAUDE_BASE_ARGS, not CLAUDE_ISOLATION_ARGS — the isolation-flag fallback
// (a CLI too old for --safe-mode) exists to keep summarizing working, and
// folding the privacy flags into that same fallback would let a CLI that
// merely lacks *them* degrade to full session persistence with no error
// surfaced. spawnClaude also scopes its child's cwd to userData, a folder
// with no CLAUDE.md/.claude/.mcp.json to auto-load.
//
// main.js requires electron and cannot be required directly, so the relevant
// consts/function are sliced out of the source and pattern-matched — same
// technique as test/default-filenames.test.js and test/participant-rename.test.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

function sliceConst(name) {
    const start = MAIN.indexOf(`\nconst ${name} = `);
    assert.notStrictEqual(start, -1, `const ${name} not found in main.js`);
    const end = MAIN.indexOf(';\n', start);
    return MAIN.slice(start, end + 1);
}

function sliceFunction(name) {
    let start = MAIN.indexOf(`\nasync function ${name}(`);
    if (start === -1) start = MAIN.indexOf(`\nfunction ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in main.js — renamed or moved?`);
    let depth = 0;
    for (let i = MAIN.indexOf('{', start); i < MAIN.length; i++) {
        if (MAIN[i] === '{') depth++;
        else if (MAIN[i] === '}' && --depth === 0) return MAIN.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${name}()`);
}

const BASE_ARGS = sliceConst('CLAUDE_BASE_ARGS');
const ISOLATION_ARGS = sliceConst('CLAUDE_ISOLATION_ARGS');
const SPAWN_CLAUDE = sliceFunction('spawnClaude');

test('the two privacy flags are base args, never isolation args', () => {
    assert.match(BASE_ARGS, /--tools=/);
    assert.match(BASE_ARGS, /--no-session-persistence/);
    assert.match(BASE_ARGS, /--strict-mcp-config/);
    assert.doesNotMatch(ISOLATION_ARGS, /--no-session-persistence/,
        'a CLI that only lacks the privacy flags must not fall back through the isolation path');
    assert.doesNotMatch(ISOLATION_ARGS, /--strict-mcp-config/);
});

test('neither arg list ever asks for --bare or a permission bypass', () => {
    for (const list of [BASE_ARGS, ISOLATION_ARGS]) {
        assert.doesNotMatch(list, /--bare/);
        assert.doesNotMatch(list, /--dangerously-skip-permissions/);
    }
});

test('spawnClaude scopes cwd to userData and only shells out on Windows', () => {
    assert.match(SPAWN_CLAUDE, /cwd:\s*app\.getPath\(\s*'userData'\s*\)/);
    assert.match(SPAWN_CLAUDE, /shell:\s*process\.platform === 'win32'/);
});

test('generatePdf blocks the offscreen window from opening a new window or navigating away', () => {
    const GENERATE_PDF = sliceFunction('generatePdf');
    assert.match(GENERATE_PDF, /setWindowOpenHandler\(\s*\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\s*\)/);
    assert.match(GENERATE_PDF, /on\(\s*'will-navigate'/);
    assert.match(GENERATE_PDF, /preventDefault\(\)/);
});

console.log('claude-args: all checks passed');
