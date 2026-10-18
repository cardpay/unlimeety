'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createMacAdapter, safeEntry, safeInstallLocation, secureDownload } = require('../update-mac');
const crypto = require('node:crypto');
function requestFixture(response) {
    return (_url, _options, callback) => {
        const request = new EventEmitter(); request.setTimeout = () => {};
        queueMicrotask(() => {
            const res = Readable.from(response.body ? [response.body] : []);
            res.statusCode = response.statusCode || 200; res.headers = response.headers || {};
            callback(res);
        });
        return request;
    };
}
test('payload transport verifies exact size/hash and restricts redirects before requesting another host', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-transport-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const body = Buffer.from('fixture update'); const candidate = { size: body.length, sha512: crypto.createHash('sha512').update(body).digest('base64') };
    const url = 'https://github.com/cardpay/unlimeety/releases/download/v2.0.1/a.zip';
    await secureDownload(url, path.join(dir, 'good.zip'), candidate, () => {}, { request: requestFixture({ body }) });
    await assert.rejects(secureDownload(url, path.join(dir, 'bad.zip'), { ...candidate, sha512: 'bad' }, () => {}, { request: requestFixture({ body }) }), /integrity/);
    await assert.rejects(secureDownload(url, path.join(dir, 'large.zip'), { ...candidate, size: 1 }, () => {}, { request: requestFixture({ body }) }), /size/);
    await assert.rejects(secureDownload(url, path.join(dir, 'redirect.zip'), candidate, () => {}, { request: requestFixture({ statusCode: 302, headers: { location: 'https://evil.example/a.zip' } }) }), /Untrusted/);
    await assert.rejects(secureDownload(url, path.join(dir, 'rate.zip'), candidate, () => {}, { request: requestFixture({ statusCode: 429, headers: { 'retry-after': '60' } }) }), (error) => error.blockedUntil > Date.now());
});
test('ZIP path contract rejects traversal, absolute and other-root entries', () => {
    for (const name of ['../App.app/a', '/App.app/a', 'App.app/../a', 'App.app\\a', 'other.txt', 'App.app/./a']) assert.equal(safeEntry(name), false);
    assert.equal(safeEntry('Desktop.app/Contents/Info.plist'), true);
});
test('development and unsupported platform locations fail closed', async () => {
    for (const settings of [{ packaged: false, platform: 'darwin', arch: 'arm64' }, { packaged: true, platform: 'linux', arch: 'arm64' }, { packaged: true, platform: 'darwin', arch: 'x64' }]) {
        await assert.rejects(safeInstallLocation({ ...settings, executable: '/Applications/Desktop.app/Contents/MacOS/Desktop' }), /installed macOS arm64/);
    }
    await assert.rejects(safeInstallLocation({ packaged: true, platform: 'darwin', arch: 'arm64', executable: '/Volumes/Installer/Desktop.app/Contents/MacOS/Desktop' }), /Applications/);
});
class FakeUpdater extends EventEmitter {
    constructor() {
        super(); FakeUpdater.instance = this; this.httpExecutor = {}; this.nativeUpdater = new EventEmitter();
        this.stages = 0; this.restarts = 0; this.closes = 0;
        this.nativeUpdater.checkForUpdates = () => { this.stages++; };
        this.nativeUpdater.quitAndInstall = () => { this.restarts++; };
    }
    setFeedURL(config) { this.clientPromise = Promise.resolve(new config.updateProvider(config, this, { platform: 'darwin' })); }
    async updateDownloaded() {}
    async downloadUpdate() { this.emit('update-downloaded', { downloadedFile: '/fixture/update.zip' }); }
    closeServerIfExists() { this.closes++; }
}
function adapterOptions(extras = {}) {
    return { app: { getVersion: () => '2.0.0-beta.1' }, cacheDir: os.tmpdir(), Updater: FakeUpdater,
        Provider: class { constructor(options) { this.options = options; } }, locationCheck: async () => ({}), payloadValidator: async () => {}, ...extras };
}
test('adapter download never stages, disables unsafe defaults, and cleans action listeners', async () => {
    const adapter = createMacAdapter(adapterOptions()); const candidate = { version: '2.0.0-beta.2', url: 'https://github.com/cardpay/unlimeety/releases/download/v2.0.0-beta.2/desktop-2.0.0-beta.2-arm64.zip', size: 7 };
    await adapter.download(candidate, () => {}); const updater = FakeUpdater.instance;
    assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.allowDowngrade, false); assert.equal(updater.disableDifferentialDownload, true);
    assert.equal(updater.stages, 0); assert.equal(updater.restarts, 0);
    assert.equal(updater.listenerCount('download-progress'), 0); assert.equal(updater.listenerCount('update-downloaded'), 0);
    adapter.clear(); assert.equal(updater.stages, 0); assert.equal(updater.restarts, 0);
});
test('native errors remove retry listeners; only a fresh explicit install can restart', async () => {
    const adapter = createMacAdapter(adapterOptions()); const candidate = { version: '2.0.0-beta.2', url: 'https://github.com/cardpay/unlimeety/releases/download/v2.0.0-beta.2/desktop-2.0.0-beta.2-arm64.zip', size: 7 };
    await adapter.download(candidate, () => {}); const updater = FakeUpdater.instance;
    await adapter.prepare(candidate);
    const failed = adapter.install(candidate); updater.nativeUpdater.emit('error', new Error('signature rejected'));
    await assert.rejects(failed, /signature rejected/);
    updater.nativeUpdater.emit('update-downloaded'); assert.equal(updater.restarts, 0);
    assert.equal(updater.nativeUpdater.listenerCount('update-downloaded'), 0);
    await assert.rejects(adapter.install(candidate), /Download again/);
    await adapter.download(candidate, () => {}); await adapter.prepare(candidate);
    const retry = adapter.install(candidate); updater.nativeUpdater.emit('update-downloaded'); await retry;
    assert.equal(updater.stages, 2); assert.equal(updater.restarts, 1);
    assert.equal(updater.nativeUpdater.listenerCount('update-downloaded'), 0);
});
test('cached payload is revalidated before install and an inconsistent candidate is rejected', async () => {
    let validations = 0;
    const adapter = createMacAdapter(adapterOptions({ payloadValidator: async () => { validations++; if (validations > 1) throw new Error('cache changed'); } }));
    const candidate = { version: '2.0.0-beta.2', url: 'https://github.com/cardpay/unlimeety/releases/download/v2.0.0-beta.2/desktop-2.0.0-beta.2-arm64.zip', size: 7 };
    await adapter.download(candidate, () => {});
    await assert.rejects(adapter.validate(candidate), /cache changed/);
    await assert.rejects(adapter.install({ ...candidate }), /changed/);
    assert.equal(FakeUpdater.instance.stages, 0);
});

// Execute the actual installed/pinned MacUpdater.updateDownloaded path with
// fake native Electron and a fake loopback server. This establishes the source
// behavior our adapter depends on, without claiming signed native replacement.
function pinnedMacUpdater(realHTTP = false) {
    const filename = require.resolve('electron-updater/out/MacUpdater');
    const source = fs.readFileSync(filename, 'utf8'); const native = new EventEmitter();
    let stages = 0; native.setFeedURL = () => {}; native.checkForUpdates = () => stages++;
    const module = { exports: {} };
    const fakeRequire = (name) => {
        if (name === 'electron') return { autoUpdater: native };
        if (name === 'http' && !realHTTP) return { createServer: () => {
            const server = new EventEmitter(); server.listen = (_port, _host, cb) => cb(); server.address = () => ({ port: 12345 }); server.close = () => {};
            return server;
        } };
        if (name === './AppUpdater') return { AppUpdater: class extends EventEmitter {
            constructor() { super(); this.httpExecutor = {}; this._logger = { info() {}, warn() {}, debug() {} }; }
            dispatchUpdateDownloaded(value) { this.emit('update-downloaded', value); }
        } };
        return require(require.resolve(name, { paths: [path.dirname(filename)] }));
    };
    vm.runInNewContext('(function(require,module,exports){' + source + '\n})', { Buffer, URL })(fakeRequire, module, module.exports);
    return { Constructor: module.exports.MacUpdater, native, stages: () => stages };
}
test('pinned 6.8.9 downloaded path creates proxy but does not invoke native staging on ordinary quit', async () => {
    assert.equal(require('electron-updater/package.json').version, '6.8.9');
    const { Constructor, native, stages } = pinnedMacUpdater();
    const updater = new Constructor(); updater.autoInstallOnAppQuit = false;
    let downloaded = 0; updater.on('update-downloaded', () => downloaded++);
    await updater.updateDownloaded({ url: new URL('https://github.com/cardpay/unlimeety/releases/download/v2/a-arm64.zip'), info: { size: 7 } }, { downloadedFile: '/fixture/update.zip' });
    assert.equal(downloaded, 1); assert.equal(stages(), 0);
    native.emit('before-quit'); assert.equal(stages(), 0);
    assert.equal(native.listenerCount('update-downloaded'), 1); // Constructor bookkeeping only, no quit/install listener.
});
test('real pinned proxy is recreated after a terminal error; delayed native readiness never loses commitment', async (t) => {
    const { Constructor, native } = pinnedMacUpdater(true); const http = require('node:http');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-proxy-')); const file = path.join(dir, 'payload.zip'); fs.writeFileSync(file, 'payload');
    let feed, checks = 0, restarts = 0, warnings = 0, served;
    native.setFeedURL = (value) => { feed = value; };
    native.quitAndInstall = () => restarts++;
    const read = (url, headers = {}) => new Promise((resolve, reject) => {
        http.get(url, { headers }, (res) => { const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject); }).on('error', reject);
    });
    native.checkForUpdates = () => {
        if (++checks === 1) { queueMicrotask(() => native.emit('update-not-available')); return; }
        served = (async () => {
            const manifest = JSON.parse((await read(feed.url, feed.headers)).toString());
            assert.equal((await read(manifest.url)).toString(), 'payload');
            await new Promise((resolve) => setTimeout(resolve, 35)); native.emit('update-downloaded');
        })(); served.catch((error) => native.emit('error', error));
    };
    class Pinned extends Constructor {
        setFeedURL(config) { this.clientPromise = Promise.resolve(new config.updateProvider(config, this, { platform: 'darwin' })); }
        async downloadUpdate() { await this.updateDownloaded({ url: new URL(candidate.url), info: { size: 7 } }, { downloadedFile: file }); }
    }
    const candidate = { version: '2.0.1', size: 7, url: 'https://github.com/cardpay/unlimeety/releases/download/v2.0.1/desktop-2.0.1-arm64.zip' };
    const adapter = createMacAdapter(adapterOptions({ Updater: Pinned, cacheDir: dir, nativeWatchdogMs: 5 }));
    t.after(() => { adapter.clear(); fs.rmSync(dir, { recursive: true, force: true }); });
    await adapter.download(candidate, () => {}); assert.equal(checks, 0); await adapter.prepare(candidate);
    await assert.rejects(adapter.install(candidate), (error) => error.requiresDownload && /no longer available/.test(error.message));
    await assert.rejects(adapter.install(candidate), /Download again/);
    await adapter.download(candidate, () => {}); await adapter.prepare(candidate);
    const installing = adapter.install(candidate, { onWaiting: () => warnings++ });
    await new Promise((resolve) => setTimeout(resolve, 15)); assert.equal(restarts, 0); assert.equal(warnings, 1);
    await installing; await served; assert.equal(restarts, 1); assert.equal(checks, 2);
    assert.equal(native.listenerCount('update-downloaded'), 1); // pinned constructor bookkeeping only
});
test('download total deadline cancels a continuously streaming response and removes partial files', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-timeout-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'partial.zip'); let timer;
    const request = (_url, _options, callback) => {
        const req = new EventEmitter(); req.destroy = () => {};
        queueMicrotask(() => {
            const response = new Readable({ read() {} }); response.statusCode = 200; response.headers = {};
            response.on('close', () => clearInterval(timer)); callback(response); timer = setInterval(() => response.push('x'), 2);
        });
        return req;
    };
    await assert.rejects(secureDownload('https://release-assets.githubusercontent.com/asset', file, { size: 10000 }, () => {}, { request, timeoutMs: 20 }), /timed out|abort/i);
    clearInterval(timer); await new Promise((resolve) => setImmediate(resolve)); assert.equal(fs.existsSync(file), false);
});
test('preparation abort stops validation before any native serving or staging begins', async () => {
    const controller = new AbortController(); let validations = 0;
    const adapter = createMacAdapter(adapterOptions({ payloadValidator: async (_file, _candidate, { signal }) => { validations++; if (validations === 1) return; await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } }));
    const candidate = { version: '2.0.1' }; await adapter.download(candidate, () => {});
    const pending = adapter.prepare(candidate, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve)); controller.abort(new Error('renderer lost'));
    await assert.rejects(pending, /renderer lost/); assert.equal(FakeUpdater.instance.stages, 0);
});
test('adapter restores the candidate cache only after new publisher/payload validation without initialization or download', async () => {
    const before = FakeUpdater.instance; let validations = 0;
    const sha512 = crypto.createHash('sha512').update('payload').digest('base64');
    const candidate = { version: '2.0.0-beta.2', channel: 'beta', tag: 'v2.0.0-beta.2', name: 'desktop-2.0.0-beta.2-arm64.zip', size: 7, sha512,
        url: 'https://github.com/cardpay/unlimeety/releases/download/v2.0.0-beta.2/desktop-2.0.0-beta.2-arm64.zip' };
    const adapter = createMacAdapter(adapterOptions({ payloadValidator: async () => { validations++; } }));
    const restored = await adapter.restore({ candidate, file: '/fixture/cached.zip' });
    assert.equal(restored.version, candidate.version); assert.equal(validations, 1); assert.equal(FakeUpdater.instance, before);
    assert.equal(adapter.cacheRecord().file, '/fixture/cached.zip');
    await assert.rejects(adapter.install(restored), /Prepare and verify/); assert.equal(FakeUpdater.instance.stages, 0);
    const wrong = createMacAdapter(adapterOptions({ payloadValidator: async () => { throw new Error('invalid publisher'); } }));
    await assert.rejects(wrong.restore({ candidate, file: '/fixture/cached.zip' }), /publisher/); assert.equal(wrong.cacheRecord(), null);
});
test('native update-not-available is terminal, clears all action listeners and requires a new download', async () => {
    const adapter = createMacAdapter(adapterOptions()); const candidate = { version: '2.0.0-beta.2', size: 7, url: 'https://github.com/cardpay/unlimeety/releases/download/v2.0.0-beta.2/desktop-2.0.0-beta.2-arm64.zip' };
    await adapter.download(candidate, () => {}); await adapter.prepare(candidate); const updater = FakeUpdater.instance;
    const pending = adapter.install(candidate); updater.nativeUpdater.emit('update-not-available');
    await assert.rejects(pending, (error) => error.requiresDownload && /no longer available/.test(error.message));
    for (const event of ['error', 'update-downloaded', 'update-not-available']) assert.equal(updater.nativeUpdater.listenerCount(event), 0);
    updater.nativeUpdater.emit('update-downloaded'); assert.equal(updater.restarts, 0); await assert.rejects(adapter.install(candidate), /Download again/);
});
test('payload redirects aggregate successful rate deadlines and destroy unused/error bodies', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-unused-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const body = Buffer.from('payload'), candidate = { size: body.length, sha512: crypto.createHash('sha512').update(body).digest('base64') };
    for (const status of [302, 503]) {
        let calls = 0, unused, timer;
        const request = (_url, _opts, callback) => { const req = new EventEmitter(); req.destroy = () => {}; queueMicrotask(() => {
            const res = new Readable({ read() {} }); res.statusCode = ++calls === 1 ? status : 200; res.headers = calls === 1 ? { location: 'https://release-assets.githubusercontent.com/payload', 'retry-after': '120' } : {};
            callback(res);
            if (calls === 1) { unused = res; timer = setInterval(() => res.push('unused'), 2); res.once('close', () => clearInterval(timer)); }
            else { res.push(body); res.push(null); }
        }); return req; };
        try {
            const pending = secureDownload('https://github.com/cardpay/unlimeety/releases/download/v2/payload.zip', path.join(dir, `${status}.zip`), candidate, () => {}, { request });
            if (status === 503) await assert.rejects(pending, (error) => error.blockedUntil > Date.now());
            else assert.ok((await pending).blockedUntil >= Date.now() + 110000);
            await new Promise((resolve) => setImmediate(resolve)); assert.equal(unused.destroyed, true);
        } finally { clearInterval(timer); }
    }
});
test('total download budget covers cached lookup and rejects late serving completion without staging/readiness', async () => {
    let finish, serveCalls = 0, cancellation;
    class SlowCache extends FakeUpdater {
        async downloadUpdate(token) {
            cancellation = token; await new Promise((resolve) => { finish = resolve; });
            await this.updateDownloaded(); this.emit('update-downloaded', { downloadedFile: '/fixture/late.zip' });
        }
        async updateDownloaded() { serveCalls++; }
    }
    const adapter = createMacAdapter(adapterOptions({ Updater: SlowCache, downloadMs: 10 }));
    const candidate = { version: '2.0.1' }; const pending = adapter.download(candidate, () => {});
    // Keep the test process alive while the unref'ed operation budget expires.
    const alive = setTimeout(() => {}, 100);
    try { await assert.rejects(pending, /timed out/); } finally { clearTimeout(alive); }
    assert.equal(cancellation.cancelled, true); assert.equal(adapter.cacheRecord(), null);
    finish(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(serveCalls, 0); assert.equal(FakeUpdater.instance.stages, 0);
    assert.equal(FakeUpdater.instance.listenerCount('update-downloaded'), 0);
});
test('initial serving setup is bounded and late completion cannot restore readiness or leave its proxy open', async () => {
    let finish; let open = false;
    class SlowServe extends FakeUpdater {
        async downloadUpdate() { await this.updateDownloaded(); this.emit('update-downloaded', { downloadedFile: '/fixture/late.zip' }); }
        async updateDownloaded() { await new Promise((resolve) => { finish = resolve; }); open = true; }
        closeServerIfExists() { super.closeServerIfExists(); open = false; }
    }
    const adapter = createMacAdapter(adapterOptions({ Updater: SlowServe, downloadMs: 10 }));
    const pending = adapter.download({ version: '2.0.1' }, () => {}); const alive = setTimeout(() => {}, 100);
    try { await assert.rejects(pending, /timed out/); } finally { clearTimeout(alive); }
    finish(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(open, false); assert.equal(adapter.cacheRecord(), null); assert.equal(FakeUpdater.instance.stages, 0);
});
test('pinned previous-launch cache helper uses the total operation signal while hashing', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cache-budget-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { DownloadedUpdateHelper } = require('electron-updater/out/DownloadedUpdateHelper');
    const helper = new DownloadedUpdateHelper(dir); fs.mkdirSync(helper.cacheDirForPendingUpdate);
    const candidate = { version: '2.0.1', name: 'desktop-2.0.1-arm64.zip', size: 7, sha512: 'fixture hash' };
    fs.writeFileSync(path.join(helper.cacheDirForPendingUpdate, candidate.name), 'payload');
    fs.writeFileSync(helper.getUpdateInfoFile(), JSON.stringify({ fileName: candidate.name, sha512: candidate.sha512 }));
    let hashStarted = false, hashAborted = false;
    class Cached extends FakeUpdater {
        async getOrCreateDownloadHelper() { return helper; }
        async downloadUpdate() { const cache = await this.getOrCreateDownloadHelper(); await cache.getValidCachedUpdateFile({ info: { sha512: candidate.sha512 } }); this.emit('update-downloaded', { downloadedFile: '/fixture/late.zip' }); }
    }
    const adapter = createMacAdapter(adapterOptions({ Updater: Cached, downloadMs: 20, cacheHash: async (_file, { signal }) => {
        hashStarted = true; await new Promise((_resolve, reject) => signal.addEventListener('abort', () => { hashAborted = true; reject(signal.reason); }, { once: true }));
    } }));
    const alive = setTimeout(() => {}, 100);
    try { await assert.rejects(adapter.download(candidate, () => {}), /timed out/); } finally { clearTimeout(alive); }
    assert.equal(hashStarted, true); assert.equal(hashAborted, true); assert.equal(adapter.cacheRecord(), null); assert.equal(FakeUpdater.instance.stages, 0);
});
test('a cancelled initial proxy retains its late-error guard until serving settles', async () => {
    let finish;
    class LateListen extends FakeUpdater {
        async updateDownloaded() { this.server = new EventEmitter(); await new Promise((resolve) => { finish = resolve; }); }
        async downloadUpdate() { await this.updateDownloaded(); }
    }
    const adapter = createMacAdapter(adapterOptions({ Updater: LateListen, downloadMs: 10 }));
    const alive = setTimeout(() => {}, 100);
    try { await assert.rejects(adapter.download({ version: '2.0.1' }, () => {}), /timed out/); } finally { clearTimeout(alive); }
    assert.doesNotThrow(() => FakeUpdater.instance.server.emit('error', new Error('late listen error')));
    finish(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(adapter.cacheRecord(), null);
});
