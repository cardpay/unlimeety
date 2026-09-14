#!/usr/bin/env node
'use strict';

// The denylist intentionally contains hashes only. Keep diagnostics limited to
// a path (when applicable) and the rule label: neither can reveal a matched
// candidate from staged content or a commit message.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_DENYLIST = path.join(__dirname, 'personal-data-denylist.json');
const MAX_TERM_WORDS = 16;
const EMAIL_DOMAIN_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/gi;
const HEX_DIGEST_RE = /^[a-f0-9]{64}$/;

function normalizeCandidate(value) {
    return String(value)
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/gu, ' ')
        .trim();
}

function digestCandidate(value) {
    return crypto.createHash('sha256').update(normalizeCandidate(value), 'utf8').digest('hex');
}

function loadDenylist(filename = DEFAULT_DENYLIST) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch {
        throw new Error('Personal-data guard could not read its denylist.');
    }

    if (parsed.version !== 1 || !Array.isArray(parsed.rules)) {
        throw new Error('Personal-data guard denylist has an unsupported format.');
    }

    return parsed.rules.map((rule) => {
        if (!rule || typeof rule.label !== 'string' ||
            !['email-domain', 'normalized-term'].includes(rule.kind) ||
            !Array.isArray(rule.digests) || rule.digests.length === 0 ||
            rule.digests.some((digest) => typeof digest !== 'string' || !HEX_DIGEST_RE.test(digest))) {
            throw new Error('Personal-data guard denylist has an invalid rule.');
        }
        return { ...rule, digestSet: new Set(rule.digests) };
    });
}

function hasDigest(rule, candidate) {
    return candidate && rule.digestSet.has(digestCandidate(candidate));
}

function findEmailDomainMatch(value, rule) {
    EMAIL_DOMAIN_RE.lastIndex = 0;
    let match;
    while ((match = EMAIL_DOMAIN_RE.exec(value)) !== null) {
        if (hasDigest(rule, match[1])) return rule;
    }
    return null;
}

function termForms(value, isPath = false) {
    const normalized = normalizeCandidate(value);
    if (!normalized) return [];

    const forms = [
        normalized,
        normalized.replace(/[^\p{L}\p{N}@._+-]+/gu, ' '),
        normalized.replace(/[._+-]+/gu, ' '),
    ];
    if (isPath) {
        const basename = path.basename(normalized);
        forms.push(basename, basename.replace(/\.[^.]+$/u, ''));
        forms.push(normalized.replace(/[^\p{L}\p{N}@._+-]+/gu, ' '));
        forms.push(basename.replace(/[^\p{L}\p{N}@._+-]+/gu, ' '));
        forms.push(normalized.replace(/[._+-]+/gu, ' '));
        forms.push(basename.replace(/[._+-]+/gu, ' '));
    }
    return [...new Set(forms.map(normalizeCandidate).filter(Boolean))];
}

function findTermMatch(value, rule, isPath = false) {
    for (const form of termForms(value, isPath)) {
        if (hasDigest(rule, form)) return rule;

        const words = form.split(' ').filter(Boolean);
        for (let start = 0; start < words.length; start += 1) {
            let candidate = '';
            for (let end = start; end < words.length && end < start + MAX_TERM_WORDS; end += 1) {
                candidate += (end === start ? '' : ' ') + words[end];
                if (hasDigest(rule, candidate)) return rule;
            }
        }
    }
    return null;
}

function findMatch(value, rules, options = {}) {
    const text = String(value);
    for (const rule of rules) {
        if (rule.kind === 'email-domain') {
            const match = findEmailDomainMatch(text, rule);
            if (match) return match;
            continue;
        }

        if (options.isPath) {
            const match = findTermMatch(text, rule, true);
            if (match) return match;
            continue;
        }

        const match = findTermMatch(text, rule);
        if (match) return match;
    }
    return null;
}

function decodeTextBuffer(buffer) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        return null;
    }
}

function runGit(args, cwd) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'buffer',
        maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout;
}

function stagedPaths(cwd) {
    const output = runGit(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'], cwd);
    if (output === null) throw new Error('Personal-data guard could not read the staged index.');
    return output.toString('utf8').split('\0').filter(Boolean);
}

function stagedBlob(filename, cwd) {
    const output = runGit(['show', '--no-textconv', `:${filename}`], cwd);
    if (output === null) throw new Error(`Personal-data guard could not read staged path: ${filename}`);
    return output;
}

function scanStaged(rules, cwd = process.cwd()) {
    for (const filename of stagedPaths(cwd)) {
        const pathMatch = findMatch(filename, rules, { isPath: true });
        if (pathMatch) return { scope: 'staged path', filename, rule: pathMatch.label };

        const content = decodeTextBuffer(stagedBlob(filename, cwd));
        if (content === null) continue;
        const contentMatch = findMatch(content, rules);
        if (contentMatch) return { scope: 'staged content', filename, rule: contentMatch.label };
    }
    return null;
}

function scanCommitMessage(message, rules) {
    const match = findMatch(message, rules);
    return match ? { scope: 'commit message', rule: match.label } : null;
}

function diagnostic(finding) {
    if (finding.filename) {
        const filename = finding.scope === 'staged path' ? '[redacted]' : finding.filename;
        return `Personal-data guard: blocked ${finding.scope} in ${filename} (rule: ${finding.rule}).`;
    }
    return `Personal-data guard: blocked ${finding.scope} (rule: ${finding.rule}).`;
}

function parseArguments(argv) {
    if (argv.length === 1 && argv[0] === '--staged') return { mode: 'staged' };
    if (argv.length === 2 && argv[0] === '--commit-msg') return { mode: 'commit-message', filename: argv[1] };
    throw new Error('Usage: check-personal-data.js --staged | --commit-msg <message-file>');
}

function main(argv = process.argv.slice(2), options = {}) {
    try {
        const args = parseArguments(argv);
        const rules = options.rules || loadDenylist(options.denylist);
        const finding = args.mode === 'staged'
            ? scanStaged(rules, options.cwd)
            : scanCommitMessage(fs.readFileSync(args.filename, 'utf8'), rules);
        if (!finding) return 0;
        console.error(diagnostic(finding));
        return 1;
    } catch (error) {
        const message = error && typeof error.message === 'string' &&
            error.message.startsWith('Personal-data guard')
            ? error.message
            : 'Personal-data guard failed safely.';
        console.error(message);
        return 2;
    }
}

if (require.main === module) process.exitCode = main();

module.exports = {
    digestCandidate,
    diagnostic,
    decodeTextBuffer,
    findMatch,
    loadDenylist,
    main,
    normalizeCandidate,
    scanCommitMessage,
    scanStaged,
};
