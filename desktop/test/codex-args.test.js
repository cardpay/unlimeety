'use strict';
// node test/codex-args.test.js
//
// Codex has no tool-disable flag. These checks keep its fixed read-only,
// ephemeral invocation in a fresh app-owned directory, with all dynamic
// content delivered through stdin rather than argv.

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
const SETTINGS_HTML = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf-8');
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf-8');

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

const CODEX_ARGS = sliceConst('CODEX_CLI_ARGS');
const RUN_CODEX = sliceFunction('runCodexCli');
const SPAWN_CODEX = sliceFunction('spawnCodex');
const CODEX_ENV = sliceFunction('codexChildEnv');

function makeChild(onEnd) {
    const proc = new EventEmitter();
    proc.pid = 1;
    proc.stdin = new EventEmitter();
    proc.stdin.written = '';
    proc.stdin.write = (text) => { proc.stdin.written += text; };
    proc.stdin.end = () => queueMicrotask(() => onEnd(proc));
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    return proc;
}

test('Codex argv is constant and keeps every supported isolation flag', () => {
    for (const arg of ['exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) {
        assert.match(CODEX_ARGS, new RegExp(`['\"]${arg.replace(/[-]/g, '\\-')}['\"]`));
    }
    for (const forbidden of ['--ask-for-approval', '--search', '--add-dir', '--output-file', '--dangerously-bypass-approvals-and-sandbox']) {
        assert.doesNotMatch(CODEX_ARGS, new RegExp(forbidden.replace(/[-]/g, '\\-')));
    }
});

test('Codex uses a fresh user-data workspace and sends dynamic text only on stdin', () => {
    assert.match(RUN_CODEX, /fs\.mkdtempSync\(path\.join\(app\.getPath\('userData'\), 'codex-summary-'\)\)/);
    assert.match(SPAWN_CODEX, /CODEX_CLI_ARGS/);
    assert.match(SPAWN_CODEX, /cwd,/);
    assert.match(SPAWN_CODEX, /stdio:\s*\['pipe', 'pipe', 'pipe'\]/);
    assert.match(SPAWN_CODEX, /CODEX_TOOL_NOTICE/);
});

test('Codex runner keeps transcript data out of argv and cleans its private workspace', async () => {
    let invocation;
    const runner = new Function(
        'spawn', 'process', 'codexChildEnv', 'killClaudeProcess', 'fs', 'CODEX_CLI_ARGS', 'CODEX_TOOL_NOTICE', 'MAX_CODEX_OUTPUT_BYTES',
        `${SPAWN_CODEX}\nreturn spawnCodex;`,
    )(
        (command, args, options) => {
            invocation = { command, args, options };
            return makeChild((proc) => {
                proc.stdout.emit('data', Buffer.from('safe summary'));
                proc.emit('close', 0);
            });
        },
        { platform: 'darwin' },
        () => ({ PATH: '/bin' }),
        () => {},
        fs,
        ['exec', '--sandbox', 'read-only'],
        'Do not use tools.',
        1_000_000,
    );
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-args-'));
    const result = await runner('/bin/codex', 'untrusted transcript', 'fixed instruction', '/bin', cwd);
    assert.deepStrictEqual(invocation.args, ['exec', '--sandbox', 'read-only']);
    assert.strictEqual(invocation.args.includes('untrusted transcript'), false);
    assert.match(invocation.options.cwd, /codex-args-/);
    assert.match(invocation.options.env.PATH, /\/bin/);
    assert.strictEqual(result.summary, 'safe summary');
    assert.strictEqual(fs.existsSync(cwd), false, 'private workspace must be removed after the child exits');
});

test('Codex preserves only minimal auth/process environment and shared abort/timeout handling', () => {
    assert.doesNotMatch(CODEX_ENV, /\.\.\.process\.env/);
    assert.match(CODEX_ENV, /CODEX_HOME/);
    assert.match(SPAWN_CODEX, /codexChildEnv\(extendedPath\)/);
    assert.match(SPAWN_CODEX, /onAbort\) onAbort\(\{ abort: \(\) => \{ canceled = true; killClaudeProcess\(proc\); \} \}\)/);
    assert.match(SPAWN_CODEX, /setTimeout\([\s\S]*killClaudeProcess\(proc\)[\s\S]*300_000/);
    assert.match(SPAWN_CODEX, /MAX_CODEX_OUTPUT_BYTES/);
    assert.match(SPAWN_CODEX, /outputTooLarge/);
    assert.match(SPAWN_CODEX, /code === 0 && stdout\.trim\(\)/);
});

test('Codex fails closed when it is unavailable and never falls back to another provider', () => {
    assert.match(RUN_CODEX, /if \(!codexPath\)/);
    assert.match(RUN_CODEX, /notInstalled: true/);
    assert.match(RUN_CODEX, /provider: 'codex-cli'/);
    assert.doesNotMatch(RUN_CODEX, /runClaudeCode|runOpenRouter|runOllama|runOpenAICompat/);
});

test('Settings makes the weaker Codex isolation an explicit opt-in', () => {
    assert.match(SETTINGS_HTML, /value="codex-cli"/);
    assert.match(SETTINGS_HTML, /tools cannot be disabled/);
    assert.match(RENDERER, /"codex-cli":\s+"Codex is reading the transcript/);
    assert.match(RENDERER, /result\.provider === "codex-cli"/);
});

console.log('codex-args: all checks passed');
