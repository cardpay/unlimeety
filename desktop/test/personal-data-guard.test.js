'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const SCANNER = require(path.join(ROOT, 'scripts', 'check-personal-data.js'));
const HOOKS = path.join(ROOT, '.githooks');
const INSTALLER = path.join(ROOT, 'scripts', 'install-git-hooks.sh');
const AGENTS = path.join(ROOT, 'AGENTS.md');
const RELEASE = path.join(ROOT, 'desktop', 'RELEASE.md');

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr || `${command} failed`);
}

function makeStagedRepo(files) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-data-guard-'));
    run('git', ['init', '--quiet'], directory);
    run('git', ['config', 'user.name', 'Test User'], directory);
    run('git', ['config', 'user.email', 'test@example.com'], directory);
    run('git', ['config', 'commit.gpgSign', 'false'], directory);
    for (const [filename, value] of Object.entries(files)) {
        const target = path.join(directory, filename);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, value);
    }
    run('git', ['add', '--all'], directory);
    return directory;
}

function copyGuard(repository, rules) {
    fs.mkdirSync(path.join(repository, '.githooks'));
    fs.mkdirSync(path.join(repository, 'scripts'));
    for (const hook of ['pre-commit', 'commit-msg']) {
        const target = path.join(repository, '.githooks', hook);
        fs.copyFileSync(path.join(HOOKS, hook), target);
        fs.chmodSync(target, 0o755);
    }
    for (const script of ['check-personal-data.js', 'install-git-hooks.sh']) {
        const target = path.join(repository, 'scripts', script);
        fs.copyFileSync(path.join(ROOT, 'scripts', script), target);
        fs.chmodSync(target, 0o755);
    }
    fs.writeFileSync(path.join(repository, 'scripts', 'personal-data-denylist.json'), JSON.stringify({
        version: 1,
        rules: rules.map(({ label, kind, digests }) => ({ label, kind, digests })),
    }));
}

function testRules() {
    return [
        {
            label: 'test-email-domain',
            kind: 'email-domain',
            digests: [SCANNER.digestCandidate('protected.test')],
            digestSet: new Set([SCANNER.digestCandidate('protected.test')]),
        },
        {
            label: 'test-incident-indicator',
            kind: 'normalized-term',
            digests: [SCANNER.digestCandidate('synthetic incident')],
            digestSet: new Set([SCANNER.digestCandidate('synthetic incident')]),
        },
    ];
}

test('clean staged text, including @example.com, passes', () => {
    const directory = makeStagedRepo({ 'notes.txt': 'Contact sample@example.com for a synthetic fixture.\n' });
    try {
        assert.strictEqual(SCANNER.scanStaged(SCANNER.loadDenylist(), directory), null);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('staged content and paths match only configured digests with safe diagnostics', () => {
    const rules = testRules();
    const contentDirectory = makeStagedRepo({ 'notes.txt': 'Synthetic Incident\n' });
    const pathDirectory = makeStagedRepo({ 'archive/Synthetic-Incident.txt': 'ordinary text\n' });
    try {
        const contentFinding = SCANNER.scanStaged(rules, contentDirectory);
        assert.deepStrictEqual(contentFinding, {
            scope: 'staged content', filename: 'notes.txt', rule: 'test-incident-indicator',
        });

        const messages = [];
        const originalError = console.error;
        console.error = (message) => messages.push(String(message));
        try {
            assert.strictEqual(SCANNER.main(['--staged'], { rules, cwd: contentDirectory }), 1);
        } finally {
            console.error = originalError;
        }
        assert.match(messages.join('\n'), /notes\.txt/);
        assert.match(messages.join('\n'), /test-incident-indicator/);
        assert.doesNotMatch(messages.join('\n'), /synthetic incident/i);

        assert.deepStrictEqual(SCANNER.scanStaged(rules, pathDirectory), {
            scope: 'staged path', filename: 'archive/Synthetic-Incident.txt', rule: 'test-incident-indicator',
        });
        const pathDiagnostic = SCANNER.diagnostic(SCANNER.scanStaged(rules, pathDirectory));
        assert.match(pathDiagnostic, /\[redacted\]/);
        assert.doesNotMatch(pathDiagnostic, /synthetic incident/i);
    } finally {
        fs.rmSync(contentDirectory, { recursive: true, force: true });
        fs.rmSync(pathDirectory, { recursive: true, force: true });
    }
});

test('protected email domains match content without echoing the address', () => {
    const rules = testRules();
    const directory = makeStagedRepo({ 'notes.txt': 'Mail owner@protected.test about a synthetic fixture.\n' });
    const pathDirectory = makeStagedRepo({ 'archive/owner@protected.test': 'ordinary text\n' });
    try {
        assert.deepStrictEqual(SCANNER.scanStaged(rules, directory), {
            scope: 'staged content', filename: 'notes.txt', rule: 'test-email-domain',
        });
        assert.deepStrictEqual(SCANNER.scanStaged(rules, pathDirectory), {
            scope: 'staged path', filename: 'archive/owner@protected.test', rule: 'test-email-domain',
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(pathDirectory, { recursive: true, force: true });
    }
});

test('empty and undecodable staged files are safe no-ops, but NUL text is scanned', () => {
    const directory = makeStagedRepo({
        'empty.txt': '',
        'binary.bin': Buffer.from([0xff, 0xfe, 0xfd]),
    });
    const nulDirectory = makeStagedRepo({ 'nul.txt': 'prefix\0Synthetic Incident\n' });
    try {
        assert.strictEqual(SCANNER.scanStaged(testRules(), directory), null);
        assert.deepStrictEqual(SCANNER.scanStaged(testRules(), nulDirectory), {
            scope: 'staged content', filename: 'nul.txt', rule: 'test-incident-indicator',
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(nulDirectory, { recursive: true, force: true });
    }
});

test('commit messages use the same matching rules and never print their candidate', () => {
    const rules = testRules();
    const finding = SCANNER.scanCommitMessage('chore: Synthetic Incident\n', rules);
    assert.deepStrictEqual(finding, { scope: 'commit message', rule: 'test-incident-indicator' });
    assert.strictEqual(SCANNER.scanCommitMessage('chore: normal synthetic message\n', rules), null);
});

test('denylist is opaque, versioned, and uses SHA-256 values only', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'scripts', 'personal-data-denylist.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.version, 1);
    assert.deepStrictEqual(parsed.rules.map((rule) => rule.label), ['corporate-email-domain', 'incident-indicator']);
    assert.strictEqual(parsed.rules.flatMap((rule) => rule.digests).length, 7);
    for (const digest of parsed.rules.flatMap((rule) => rule.digests)) {
        assert.match(digest, /^[a-f0-9]{64}$/);
    }
    assert.strictEqual(crypto.createHash('sha256').update(raw).digest('hex').length, 64);
});

test('both executable hook entry points invoke the shared scanner', () => {
    for (const hook of ['pre-commit', 'commit-msg']) {
        const filename = path.join(HOOKS, hook);
        assert.ok(fs.statSync(filename).mode & 0o111, `${hook} must be executable`);
        assert.match(fs.readFileSync(filename, 'utf8'), /scripts\/check-personal-data\.js/);
    }
    assert.match(fs.readFileSync(path.join(HOOKS, 'pre-commit'), 'utf8'), /--staged/);
    assert.match(fs.readFileSync(path.join(HOOKS, 'commit-msg'), 'utf8'), /--commit-msg/);
});

test('installer configures the tracked hooks path and rejects non-worktrees', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-data-hook-install-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-data-no-git-'));
    try {
        run('git', ['init', '--quiet'], directory);
        fs.mkdirSync(path.join(directory, '.githooks'));
        for (const hook of ['pre-commit', 'commit-msg']) {
            fs.copyFileSync(path.join(HOOKS, hook), path.join(directory, '.githooks', hook));
            fs.chmodSync(path.join(directory, '.githooks', hook), 0o755);
        }

        const installed = spawnSync(INSTALLER, [], { cwd: directory, encoding: 'utf8' });
        assert.strictEqual(installed.status, 0, installed.stderr);
        const configured = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
            cwd: directory,
            encoding: 'utf8',
        });
        assert.strictEqual(configured.status, 0, configured.stderr);
        assert.strictEqual(configured.stdout.trim(), '.githooks');

        run('git', ['config', '--local', 'core.hooksPath', '.other-hooks'], directory);
        const preserved = spawnSync(INSTALLER, [], { cwd: directory, encoding: 'utf8' });
        assert.notStrictEqual(preserved.status, 0);
        assert.match(preserved.stderr, /refusing to replace/);

        const rejected = spawnSync(INSTALLER, [], { cwd: outside, encoding: 'utf8' });
        assert.notStrictEqual(rejected.status, 0);
        assert.match(rejected.stderr, /not inside a Git worktree/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('type-changed files are scanned from the staged index', () => {
    const directory = makeStagedRepo({ 'entry.txt': 'clean\n' });
    try {
        run('git', ['commit', '--quiet', '-m', 'initial'], directory);
        fs.rmSync(path.join(directory, 'entry.txt'));
        fs.symlinkSync('Synthetic Incident', path.join(directory, 'entry.txt'));
        run('git', ['add', '--all'], directory);
        assert.deepStrictEqual(SCANNER.scanStaged(testRules(), directory), {
            scope: 'staged content', filename: 'entry.txt', rule: 'test-incident-indicator',
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('installed hooks reject staged content and commit messages in real commits', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-data-hook-e2e-'));
    const rules = testRules();
    try {
        run('git', ['init', '--quiet'], directory);
        run('git', ['config', 'user.name', 'Test User'], directory);
        run('git', ['config', 'user.email', 'test@example.com'], directory);
        run('git', ['config', 'commit.gpgSign', 'false'], directory);
        copyGuard(directory, rules);
        run(path.join(directory, 'scripts', 'install-git-hooks.sh'), [], directory);

        fs.writeFileSync(path.join(directory, 'clean.txt'), 'clean\n');
        run('git', ['add', 'clean.txt'], directory);
        run('git', ['commit', '--quiet', '-m', 'initial clean commit'], directory);

        fs.writeFileSync(path.join(directory, 'blocked.txt'), 'Synthetic Incident\n');
        run('git', ['add', 'blocked.txt'], directory);
        const blockedContent = spawnSync('git', ['commit', '-m', 'clean message'], { cwd: directory, encoding: 'utf8' });
        assert.notStrictEqual(blockedContent.status, 0);
        assert.doesNotMatch(`${blockedContent.stdout}${blockedContent.stderr}`, /synthetic incident/i);

        run('git', ['reset', '--hard', 'HEAD'], directory);
        fs.writeFileSync(path.join(directory, 'clean.txt'), 'still clean\n');
        run('git', ['add', 'clean.txt'], directory);
        const blockedMessage = spawnSync('git', ['commit', '-m', 'Synthetic Incident'], { cwd: directory, encoding: 'utf8' });
        assert.notStrictEqual(blockedMessage.status, 0);
        assert.doesNotMatch(`${blockedMessage.stdout}${blockedMessage.stderr}`, /synthetic incident/i);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('policy requires local beta integration and explicit release authorization', () => {
    const agents = fs.readFileSync(AGENTS, 'utf8');
    const release = fs.readFileSync(RELEASE, 'utf8');
    assert.match(agents, /feature\/\*.*locally into `beta` without a PR[\s\S]*Only[\s\S]*`beta`.*PR to `main`/);
    assert.match(agents, /unless the user explicitly requests that release/);
    assert.match(release, /Do not start a pre-release build[\s\S]*user explicitly requests that specific release/);
    assert.match(release, /Only `beta` may open a PR to `main`/);
});
