'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { test, after } = require('node:test');
const { LOCAL_MODEL_MANIFEST, validateManifest, modelById } = require('../local-model-manifest');
const runner = require('../local-llm/runner-manifest');
const { downloadVerifiedArtifact } = require('../local-model-download');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const DOWNLOADER = fs.readFileSync(path.join(__dirname, '..', 'local-model-download.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

// Fixture-only keypair: the production path uses normal certificate
// validation. The injected transport below trusts this local server only.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDFSfvYp1fGGgSb
YSCqpr+HTcm2HL1gV5uVriI8FNqBZlVhb540XoC7Tdzaa+HFTZztigfL4CnCsvyJ
SLuJidwp2KuoBr49vhyyFBl+HrlOPfdVXA2AffxtvJa6IBd09ijm3zEREJkA8fCr
2WZnsf8ruxJCpqwz5RYYq5brbyT9adHKKZBD0pXQw4GH13CQDu6yPE8sZ/lJhIJf
ZbUM+4HE664PSxVwdhVTZUxbaviQO7MWptAuHjdXAoXyf+a48DBvhU+IP+7VM4vi
1weXl320XmUbHr0a+vfPLC/B421nz1DSwee20RsKsgGMG1p5/fWAHroUSr/4SodQ
jlHwpgUPAgMBAAECggEAVemI1WjSDT9pQCyEqCui/g2+yCItyZV8+CpzWAyQtobU
qXCMyStaDbazdR5Dm8LXko1oJb0BEnsVA8d7e0JgcIyc+7esAoEWR+n+y/AfK9ZK
LY6/hnPWiAb28ChnbpR/bUJGQLMknce90WgDcyaNAwMcyY+BL7wT6jxWpUGqLvux
FozMR/m9E7/mLoL1puyn98gP4C6m0prQDCKyERDV+6IIGgHVInoYDFrSQDWLh/vJ
ITdG+Vt2IvaRSWWl/M1QPzpsYicRB4OHVWmd/c/k3EpV6wNuNkKG47HZLM6Y8iI2
X2qB9ANFhi/erslDmkTSTXn/2LO0U+8rYwzGQK/ucQKBgQDiKbbHMa5r00MxKzyR
Mz000+a/0X0whc/VR7TL9sMt0yj5kWbR3gwzRk2H/bUGj95sWgz/TRezzYJFqNmz
kkVkf+Isn/4AQIYVaWHg9Aq0byXT4xO5QENSTvxTDSCtVAvJfLzwYlPx5sJQdryu
z1/4h/4mPAmQW9XvP4eQ333euQKBgQDfURlj3w5P67asf+/vbeC1DC44R4cgH23c
FC1TOWAC9Rafm9yTQp8t2qeZNdJ5CvJC02Gm5JLf8bE539QdXg4q+GUlnHACmNWy
BytCio9fYDFKYyH1cSrnK2BR+fMlipTVlhOX2xEHgc5C0zljEzJZjola9WKE1w/o
6aw5cVVeBwKBgQDbWrIYiSsvEXy+F71q51OaBVxs93aAtYhayG2m1fOAYqn/RPOA
4ejbYniYSY5miuukE8M/azpt/gk4HwjnjhsX2qE3vwXQoMRryAZS9N/dGWCLHldm
+dlR36IDu1vSQQ4doopubDAXE0WsXT2sHx5qIxxxYRG1nhzlK60E6n9eoQKBgQC8
KkR/j3Iqy01HuiE8mFPPmWzUhQiJe5IA74tlZaHNvB+M6zKHbopbg7LWeLBYx21r
+1p72nsbcTZIsp2zBQ5hDJ2FfHQw7ACbmkjML54w2geOS0tQ2UMyN61YRYin6EYS
Vfs6aB7IOYrHad0f6wvwxBZeawbRMbk5IrO4TxOEPwKBgAeKnGexmLwi54BhILnN
IajghQOG1KoOHw3MGhsKVTJxGSPZuUTLEehL9juFPbRMOIIo2DFNY7naV1VNkuCw
h8HSJjb6j9+RR4QLmdyyCK4Pps4GunR0Kv3FD5Xbmhg1uiZVw60YO/fAvXeCUyNp
+n0j6eoh6tXckPCUkVBvFntg
-----END PRIVATE KEY-----`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUCBdatYc39XlbCCUeUEtk7EeD4CAwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkwOTExMTYxMloXDTI2MDkx
MDExMTYxMlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAxUn72KdXxhoEm2Egqqa/h03Jthy9YFebla4iPBTagWZV
YW+eNF6Au03c2mvhxU2c7YoHy+ApwrL8iUi7iYncKdirqAa+Pb4cshQZfh65Tj33
VVwNgH38bbyWuiAXdPYo5t8xERCZAPHwq9lmZ7H/K7sSQqasM+UWGKuW628k/WnR
yimQQ9KV0MOBh9dwkA7usjxPLGf5SYSCX2W1DPuBxOuuD0sVcHYVU2VMW2r4kDuz
FqbQLh43VwKF8n/muPAwb4VPiD/u1TOL4tcHl5d9tF5lGx69Gvr3zywvweNtZ89Q
0sHnttEbCrIBjBtaef31gB66FEq/+EqHUI5R8KYFDwIDAQABo1MwUTAdBgNVHQ4E
FgQUDWXDrXr9QKSosKecwIsgs/c7qkYwHwYDVR0jBBgwFoAUDWXDrXr9QKSosKec
wIsgs/c7qkYwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAHyy1
gYbE/65wfthE1X8acpJiR39Gn1W2kTGNU3LC/fw8fLKYMFA5hh84jXacMGkoc9YU
QRId5XLUsTmD/IcIU0CRyt22WOVqFxWzqjLA93KFtMiiUjhpXUHfwSkLx+aP5FrM
7KWHRFLL7P1kLUj0HfTKoMbfKiz7A9faWnIvFEpZYOFsBhavJ/r8viG8T+L/JeZ2
BITQx4V8e9j+FVk3p1kZoQjcA3XfjUelEsZc4oH/g15ayDnRXs8B8iHA6yIDnx3n
i4+Vv7BqdqDsk/JeNjHssrfgrm7L+5GpiGTo+5//HweXv2XzUn8tXY9eteqaihpx
vSJrNL1E1o/cZKQDjg==
-----END CERTIFICATE-----`;

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-download-'));
after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

function hasNoArtifact(dir) {
    return fs.readdirSync(dir).length === 0;
}

async function withFixture(run) {
    const payload = Buffer.from('verified local model fixture');
    const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
        if (req.url === '/success') return res.end(payload);
        if (req.url === '/redirect') { res.writeHead(302, { location: '/success' }); return res.end(); }
        if (req.url === '/cross-host') { res.writeHead(302, { location: 'https://unapproved.example/model' }); return res.end(); }
        if (req.url === '/runner-asset') return res.end(payload);
        if (req.url === '/runner-redirect') { res.writeHead(302, { location: '/runner-asset' }); return res.end(); }
        if (req.url === '/runner-cross-host') { res.writeHead(302, { location: 'https://unapproved.example/runner' }); return res.end(); }
        if (req.url === '/truncated') return res.end(payload.subarray(0, 5));
        if (req.url === '/wrong-size') return res.end(Buffer.concat([payload, Buffer.from('x')]));
        if (req.url === '/wrong-hash') return res.end(Buffer.alloc(payload.length, 0x78));
        if (req.url === '/cancel') { res.write(payload.subarray(0, 8)); return setTimeout(() => res.end(payload.subarray(8)), 30); }
        res.statusCode = 404; res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        await run({ payload, url: (route) => new URL(`https://localhost:${port}${route}`), request: (url, options, callback) => https.get(url, { ...options, rejectUnauthorized: false }, callback) });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function fixtureDownload({ url, request, destination, payload, isCancelled = () => false, onProgress = () => {}, writeSync }) {
    return downloadVerifiedArtifact({
        url, destination, expectedBytes: payload.length,
        expectedSha256: crypto.createHash('sha256').update(payload).digest('hex'),
        approvedHosts: new Set(['localhost']), request, isCancelled, onProgress, writeSync,
    });
}

test('local HTTPS fixture promotes only an exact verified artifact', async () => {
    const dir = fs.mkdtempSync(path.join(fixtureRoot, 'success-'));
    await withFixture(async ({ payload, url, request }) => {
        const destination = path.join(dir, 'model.gguf');
        fs.writeFileSync(path.join(dir, '.model.gguf-leftover.part'), 'stale partial');
        const progress = [];
        await fixtureDownload({
            url: url('/success'), request, destination, payload, onProgress: (value) => progress.push(value),
            writeSync: (fd, chunk, offset, length) => fs.writeSync(fd, chunk, offset, Math.min(length, 2)),
        });
        assert.deepStrictEqual(fs.readFileSync(destination), payload);
        assert.ok(progress.length > 0, 'verified download reports progress');
        assert.deepStrictEqual(fs.readdirSync(dir), ['model.gguf'], 'promotion leaves no partial artifact');
    });
});

test('local HTTPS fixture permits the reviewed redirect host and rejects a cross-host redirect', async () => {
    const dir = fs.mkdtempSync(path.join(fixtureRoot, 'redirect-'));
    await withFixture(async ({ payload, url, request }) => {
        const destination = path.join(dir, 'model.gguf');
        await fixtureDownload({ url: url('/redirect'), request, destination, payload });
        assert.deepStrictEqual(fs.readFileSync(destination), payload);
        fs.unlinkSync(destination);
        fs.writeFileSync(path.join(dir, '.model.gguf-leftover.part'), 'stale partial');
        await assert.rejects(fixtureDownload({ url: url('/cross-host'), request, destination, payload }));
        assert.ok(hasNoArtifact(dir), 'cross-host redirect must leave no final or partial artifact');
    });
});

test('runner archive downloader permits reviewed redirects and rejects cross-host redirects', async () => {
    const { downloadPinnedArchive } = await import('../local-llm/runner-download.mjs');
    const dir = fs.mkdtempSync(path.join(fixtureRoot, 'runner-redirect-'));
    await withFixture(async ({ payload, url, request }) => {
        const target = path.join(dir, 'runner.tar.gz');
        const expectedSha256 = crypto.createHash('sha256').update(payload).digest('hex');
        await downloadPinnedArchive({
            url: url('/runner-redirect'), target, expectedSha256,
            approvedHosts: new Set(['localhost']), request,
        });
        assert.deepStrictEqual(fs.readFileSync(target), payload);
        fs.unlinkSync(target);
        await assert.rejects(downloadPinnedArchive({
            url: url('/runner-cross-host'), target, expectedSha256,
            approvedHosts: new Set(['localhost']), request,
        }));
        assert.ok(hasNoArtifact(dir), 'unsafe runner redirect must leave no archive');
    });
});

for (const route of ['/truncated', '/wrong-size', '/wrong-hash']) {
    test(`local HTTPS fixture ${route} leaves no artifact`, async () => {
        const dir = fs.mkdtempSync(path.join(fixtureRoot, 'failed-'));
        await withFixture(async ({ payload, url, request }) => {
            await assert.rejects(fixtureDownload({ url: url(route), request, destination: path.join(dir, 'model.gguf'), payload }));
            assert.ok(hasNoArtifact(dir), 'failed verification must leave neither final nor partial file');
        });
    });
}

test('local HTTPS fixture cancellation leaves no artifact', async () => {
    const dir = fs.mkdtempSync(path.join(fixtureRoot, 'cancel-'));
    await withFixture(async ({ payload, url, request }) => {
        let cancelled = false;
        await assert.rejects(fixtureDownload({
            url: url('/cancel'), request, destination: path.join(dir, 'model.gguf'), payload,
            isCancelled: () => cancelled,
            onProgress: () => { cancelled = true; },
        }));
        assert.ok(hasNoArtifact(dir), 'cancellation must leave neither final nor partial file');
    });
});

function validEntry() {
    return { ...LOCAL_MODEL_MANIFEST[0], platforms: [...LOCAL_MODEL_MANIFEST[0].platforms] };
}

test('reviewed catalog is immutable-addressed and has the specified tiers', () => {
    assert.deepStrictEqual(LOCAL_MODEL_MANIFEST.map((entry) => entry.tier), ['Fast', 'Recommended', 'Quality']);
    assert.strictEqual(modelById('qwen3-4b-q4_k_m').bytes, 2497280256);
    assert.strictEqual(modelById('../outside'), null);
});

test('runner delivery is pinned and packaging verifies it before signing', () => {
    assert.strictEqual(runner.version, 'b10516');
    assert.strictEqual(runner.sourceCommit, 'b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9');
    assert.match(runner.archiveUrl, /llama-b10516-bin-macos-arm64\.tar\.gz$/);
    assert.match(runner.archiveSha256, /^[a-f0-9]{64}$/);
    const packageJson = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
    assert.match(packageJson, /build:runner/);
    assert.match(packageJson, /local-llm\/bin\/\*/, 'the runner and its bundled dylibs must be signed together');
    assert.match(packageJson, /"from": "local-llm\/bin"/, 'the runner dylibs must ship beside the executable');
    assert.match(packageJson, /"local-model-download\.js"/, 'the main-process downloader must ship in the packaged app');
});

test('manifest validation rejects hostile artifacts and metadata', () => {
    for (const mutate of [
        (entry) => { entry.url = 'https://evil.example/model'; },
        (entry) => { entry.revision = 'main'; },
        (entry) => { entry.filename = '../model.gguf'; },
        (entry) => { entry.format = 'pickle'; },
        (entry) => { entry.sha256 = 'not-a-hash'; },
        (entry) => { entry.bytes = 0; },
        (entry) => { entry.platforms = ['linux-x64']; },
    ]) {
        const entry = validEntry();
        mutate(entry);
        assert.throws(() => validateManifest([entry]));
    }
});

test('local model IPCs are narrow and main-window-only', () => {
    for (const channel of ['localModels:list', 'localModels:download', 'localModels:cancel', 'localModels:remove']) {
        const start = MAIN.indexOf(`ipcMain.handle('${channel}'`);
        assert.notStrictEqual(start, -1, `${channel} must exist`);
        const body = MAIN.slice(start, MAIN.indexOf('\n});', start) + 4);
        assert.match(body, /fromMain\(e\)/, `${channel} must reject non-main renderers`);
    }
    assert.match(PRELOAD, /downloadLocalModel:\s*\(id\)/);
    assert.doesNotMatch(PRELOAD, /localModelPath|repository|revision|--model/);
});

test('download and inference stay manifest-derived, verified, and offline-capable', () => {
    assert.match(MAIN, /fs\.statfsSync\(dir\)/, 'download must preflight free space');
    assert.match(MAIN, /stat\.isSymbolicLink\(\)/, 'model storage must reject symlinked directories');
    assert.match(DOWNLOADER, /crypto\.randomBytes\(16\)/, 'download temp name must be unpredictable');
    assert.match(DOWNLOADER, /bytes !== expectedBytes \|\| hash\.digest\('hex'\) !== expectedSha256/, 'download must verify exact bytes and hash');
    assert.match(DOWNLOADER, /fs\.renameSync\(tmp, destination\)/, 'verified artifact must be atomically promoted');
    assert.match(MAIN, /await verifyLocalModel\(entry\)/, 'inference must reject a later-corrupted artifact');
    assert.match(MAIN, /case 'local-hf':\s+return runLocalHf/, 'summary/enhance dispatch must not fall back');
    assert.match(MAIN, /case 'local-hf':\s+return runChatLocalHf/, 'Ask AI must not fall back');
    assert.match(MAIN, /'--single-turn', '--no-display-prompt', '--simple-io'/, 'runner input must use the reviewed stdin-only mode');
});

test('profiles without an explicit provider are blocked before any provider runs', () => {
    assert.match(MAIN, /providerExplicitlyChosen = \['claude-code', 'codex-cli', 'openrouter', 'ollama', 'openai-compatible', 'local-hf'\]\.includes\(s\.provider\)/);
    assert.match(MAIN, /if \(!cfg\.providerExplicitlyChosen\) \{\s*return \{ ok: false, needsProviderChoice: true/);
});

test('fresh provider chooser persists a choice, opens Settings for local, and covers follow-up', () => {
    assert.match(APP, /api\.setSummarizer\(summarizerPayloadForChoice\(provider, cfg\)\)/,
        'a chooser choice must persist through the existing settings IPC');
    assert.match(APP, /if \(provider === "local-hf"\) openSettingsModal\(\)/,
        'choosing local must lead to the model catalog');
    assert.match(APP, /if \(result\?\.needsProviderChoice\) \{\s*closeFollowupModal\(\);\s*openProviderChooser\(\);/,
        'follow-up must use the same fresh-profile chooser as the other routes');
});

test('local Hugging Face is disabled in Settings and the first-use chooser', () => {
    assert.match(INDEX, /name="settings-provider" value="local-hf" disabled/);
    assert.match(INDEX, /class="provider-choice" data-provider="local-hf" disabled/);
});

test('provider cards disclose cloud, quality, privacy, speed, and local trade-offs', () => {
    assert.match(INDEX, /Claude Code.*provider-badge-cloud.*Cloud.*provider-badge-quality.*Quality.*provider-badge-safety.*Safety/);
    assert.match(INDEX, /Codex CLI.*provider-badge-cloud.*Cloud.*provider-badge-speed.*Speed.*provider-badge-privacy.*Less private/);
    assert.match(INDEX, /Ollama.*provider-badge-local.*Local/);
    assert.match(INDEX, /OpenAI-compatible.*provider-badge-cloud.*Cloud/);
});
