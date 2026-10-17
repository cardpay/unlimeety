'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverUpdate, channelOf, manifestCandidate, trustedURL, retryDeadline, createCandidateProvider } = require('../update-provider');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const digest = crypto.createHash('sha512').update('fixture').digest('base64');
function release(version, changes = {}) {
    const name = `desktop-${version}-arm64.zip`;
    const tag = `v${version}`;
    const url = `https://github.com/cardpay/unlimeety/releases/download/${tag}/`;
    const channel = channelOf(version);
    return { tag_name: tag, draft: false, prerelease: channel !== 'stable', assets: [
        { name, size: 7, browser_download_url: url + name },
        { name: channel === 'beta' ? 'beta-mac.yml' : 'latest-mac.yml', browser_download_url: url + (channel === 'beta' ? 'beta-mac.yml' : 'latest-mac.yml') },
    ], ...changes };
}
function network(pages, manifestChanges = {}) {
    const calls = [];
    return { calls, fetch: async (url) => {
        calls.push(url);
        if (url.includes('api.github.com')) return { body: Buffer.from(JSON.stringify(pages[Number(new URL(url).searchParams.get('page')) - 1] || [])) };
        const version = url.split('/').at(-2).slice(1);
        return { body: Buffer.from(yaml.dump({ version, files: [{ url: `desktop-${version}-arm64.zip`, size: 7, sha512: digest }], ...manifestChanges })) };
    } };
}
for (const [installed, versions, expected] of [
    ['2.0.0', ['2.0.1', '2.1.0-beta.1'], '2.0.1'],
    ['2.0.0-beta.1', ['2.0.0', '2.0.0-beta.2'], '2.0.0-beta.2'],
    ['2.0.0-beta.2', ['2.0.0'], null],
    ['2.0.0', ['2.0.0', '1.9.0', '2.1.0-beta.1'], null],
    ['2.0.0-beta.2', ['2.0.0-beta.9', '2.0.0-rc.20', '2.0.0-beta.10', '2.0.0-alpha.1'], '2.0.0-beta.10'],
]) test(`strict channel/semantic selection from ${installed}: ${expected}`, async () => {
    const result = await discoverUpdate(installed, network([versions.map((v) => release(v))]));
    assert.equal(result.candidate?.version || null, expected);
});
test('discovery searches later pages and chooses semantic maximum over release order', async () => {
    const page = Array.from({ length: 100 }, () => release('9.0.0-beta.1'));
    page[0] = release('2.0.3');
    const net = network([page, [release('2.0.10'), release('2.0.4')]]);
    assert.equal((await discoverUpdate('2.0.0', net)).candidate.version, '2.0.10');
    assert.equal(net.calls.length, 3);
});
test('drafts and inconsistent prerelease flags are rejected', async () => {
    const net = network([[release('3.0.0', { draft: true }), release('4.0.0', { prerelease: true }), release('v5.0.0'), release('invalid')]]);
    assert.equal((await discoverUpdate('2.0.0', net)).candidate, null);
});
test('newest same-channel missing assets is incomplete, never current or older fallback', async () => {
    await assert.rejects(discoverUpdate('2.0.0', network([[release('2.0.1'), release('2.0.2', { assets: [] })]])), /incomplete/);
});
for (const changes of [{ version: '9.0.0' }, { files: [] }, { files: [{ url: '../desktop-2.0.1-arm64.zip', size: 7, sha512: digest }] },
    { files: [{ url: 'desktop-2.0.1-x64.zip', size: 7, sha512: digest }] }, { files: [{ url: 'desktop-2.0.1-arm64.zip', size: 7, sha512: 'bad' }] }]) {
    test(`malformed/incompatible metadata rejected: ${JSON.stringify(changes)}`, async () => {
        await assert.rejects(discoverUpdate('2.0.0', network([[release('2.0.1')]], changes)));
    });
}
test('payload release size/URL must match manifest', () => {
    const item = release('2.0.1'); item.assets[0].size = 8;
    assert.throws(() => manifestCandidate(item, '2.0.1', 'stable', { version: '2.0.1', files: [{ url: 'desktop-2.0.1-arm64.zip', size: 7, sha512: digest }] }), /inconsistent/);
});
test('pagination is bounded and never reports current after truncation', async () => {
    const items = Array.from({ length: 100 }, () => release('1.0.0'));
    await assert.rejects(discoverUpdate('2.0.0', network(Array.from({ length: 20 }, () => items))), /page limit/);
});
test('redirect allowlist rejects credentials, ports, lookalike hosts and other repositories', () => {
    for (const url of ['http://github.com/cardpay/unlimeety/releases/download/v2/a.zip', 'https://token@api.github.com/', 'https://api.github.com:8443/',
        'https://release-assets.githubusercontent.com.evil.example/a', 'https://github.com/other/project/releases/download/v2/a.zip']) assert.equal(trustedURL(url), false);
    assert.equal(trustedURL('https://release-assets.githubusercontent.com/asset?signature=fixture'), true);
});
test('rate limit headers produce absolute retry deadlines', () => {
    assert.equal(retryDeadline({ 'retry-after': '60' }, 1000), 61000);
    assert.equal(retryDeadline({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '200' }, 1000), 200000);
});
test('custom provider is bound to its exact candidate and supplies pinned Provider runtime options', async () => {
    const executor = {};
    class Provider { constructor(options) { this.options = options; } }
    const candidate = { version: '2.0.1', url: 'https://github.com/cardpay/unlimeety/releases/download/v2.0.1/a-arm64.zip', size: 7, sha512: digest };
    const provider = createCandidateProvider(Provider, candidate, executor, { platform: 'darwin' });
    assert.equal(provider.options.executor, executor);
    assert.equal((await provider.getLatestVersion()).version, candidate.version);
    assert.equal(provider.resolveFiles({ version: candidate.version })[0].url.href, candidate.url);
    assert.throws(() => provider.resolveFiles({ version: '9.0.0' }), /changed/);
});
test('manifest kernel minimum rejects unsupported or malformed OS versions', () => {
    const item = release('2.0.1');
    for (const minimumSystemVersion of ['99.0.0', 'malformed']) {
        assert.throws(() => manifestCandidate(item, '2.0.1', 'stable', { version: '2.0.1', files: [{ url: 'desktop-2.0.1-arm64.zip', size: 7, sha512: digest }], minimumSystemVersion }, { kernelVersion: '25.0.0' }), /newer macOS/);
    }
});
test('accumulated rate deadline survives later metadata, parse and page failures', async () => {
    const deadline = Date.now() - 60000;
    for (const mode of ['metadata', 'parse', 'page']) {
        let calls = 0;
        await assert.rejects(discoverUpdate('2.0.0', { fetch: async () => {
            if (++calls === 1) return { blockedUntil: deadline, body: Buffer.from(JSON.stringify(mode === 'page' ? Array.from({ length: 100 }, () => release('2.0.1')) : [release('2.0.1')])) };
            if (mode === 'parse') return { body: Buffer.from('invalid YAML: [') };
            throw new Error('offline');
        } }), (error) => error.blockedUntil === deadline);
    }
});
test('metadata total deadline aborts a slow streaming body across redirects', async () => {
    const { requestBuffer } = require('../update-provider');
    const { EventEmitter } = require('node:events'); const { Readable } = require('node:stream');
    let calls = 0, interval;
    const request = (_url, _options, callback) => {
        const req = new EventEmitter(); req.destroy = () => {};
        setTimeout(() => {
            const res = new Readable({ read() {} }); res.headers = {}; res.statusCode = ++calls === 1 ? 302 : 200;
            if (calls === 1) res.headers.location = 'https://release-assets.githubusercontent.com/asset';
            callback(res);
            if (calls === 2) { interval = setInterval(() => res.push('x'), 2); res.once('close', () => clearInterval(interval)); }
        }, 5);
        return req;
    };
    await assert.rejects(requestBuffer('https://api.github.com/repos/cardpay/unlimeety/releases', { request, timeoutMs: 25 }), /timed out/);
    clearInterval(interval); assert.equal(calls, 2);
});
test('a received rate deadline stops subsequent requests immediately and survives a truncated response', async () => {
    const deadline = Date.now() + 600000; let calls = 0;
    await assert.rejects(discoverUpdate('2.0.0', { fetch: async () => { calls++; return { blockedUntil: deadline, body: Buffer.from(JSON.stringify([release('2.0.1')])) }; } }), (error) => error.blockedUntil === deadline);
    assert.equal(calls, 1);
    const { requestBuffer } = require('../update-provider'); const { EventEmitter } = require('node:events'); const { Readable } = require('node:stream');
    const request = (_url, _opts, callback) => {
        const req = new EventEmitter(); req.destroy = () => {};
        queueMicrotask(() => { const res = new Readable({ read() {} }); res.statusCode = 200; res.headers = { 'retry-after': '60' }; callback(res); res.destroy(new Error('body interrupted')); });
        return req;
    };
    await assert.rejects(requestBuffer('https://api.github.com/repos/cardpay/unlimeety/releases', { request }), (error) => error.blockedUntil > Date.now());
});
test('canonical semantic build metadata keeps strict channels and ignores metadata for precedence', async () => {
    assert.equal(channelOf('2.0.0+build.17'), 'stable'); assert.equal(channelOf('2.0.0-beta.2+build.17'), 'beta');
    for (const value of ['v2.0.0+build.17', ' 2.0.0+build.17', '2.0.0+build.17 ', '02.0.0+build.17']) assert.equal(channelOf(value), null);
    for (const [installed, versions, expected] of [
        ['2.0.0+build.1', ['2.0.0+build.99', '2.0.1+build.2', '2.1.0-beta.1+build.3'], '2.0.1+build.2'],
        ['2.0.0-beta.2+build.1', ['2.0.0-beta.2+build.99', '2.0.0-beta.10+build.2', '2.0.0+build.3'], '2.0.0-beta.10+build.2'],
    ]) {
        assert.equal((await discoverUpdate(installed, network([versions.map((version) => release(version))]))).candidate.version, expected);
    }
});
test('successful redirects aggregate rate deadlines and destroy unused streaming bodies', async () => {
    const { requestBuffer } = require('../update-provider'); const { EventEmitter } = require('node:events'); const { Readable } = require('node:stream');
    const streams = []; const intervals = []; let calls = 0;
    const request = (_url, _opts, callback) => {
        const req = new EventEmitter(); req.destroy = () => {};
        queueMicrotask(() => {
            const res = new Readable({ read() {} }); streams.push(res);
            res.statusCode = ++calls === 1 ? 302 : 200; res.headers = calls === 1 ? { location: 'https://release-assets.githubusercontent.com/metadata', 'retry-after': '120' } : {};
            callback(res);
            if (calls === 1) { const timer = setInterval(() => res.push('unused'), 2); intervals.push(timer); res.once('close', () => clearInterval(timer)); }
            else { res.push('{}'); res.push(null); }
        }); return req;
    };
    try {
        const result = await requestBuffer('https://api.github.com/repos/cardpay/unlimeety/releases', { request });
        assert.ok(result.blockedUntil >= Date.now() + 110000); assert.equal(result.body.toString(), '{}');
        await new Promise((resolve) => setImmediate(resolve)); assert.equal(streams[0].destroyed, true);
    } finally { intervals.forEach(clearInterval); }
});
test('HTTP errors immediately destroy unused continuously streaming metadata bodies', async () => {
    const { requestBuffer } = require('../update-provider'); const { EventEmitter } = require('node:events'); const { Readable } = require('node:stream'); let response;
    const request = (_url, _opts, callback) => { const req = new EventEmitter(); req.destroy = () => {}; queueMicrotask(() => { response = new Readable({ read() {} }); response.statusCode = 503; response.headers = {}; callback(response); }); return req; };
    await assert.rejects(requestBuffer('https://api.github.com/repos/cardpay/unlimeety/releases', { request }), /503/); assert.equal(response.destroyed, true);
});
