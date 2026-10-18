'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const os = require('node:os');
const semver = require('semver');
const { budget, checkAbort, abortable } = require('./update-bounds');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const yauzl = require('yauzl');
const { trustedURL, retryDeadline, channelOf, createCandidateProvider } = require('./update-provider');
const runFile = promisify(execFile);

async function hashFile(file, { signal } = {}) {
    checkAbort(signal);
    const hash = crypto.createHash('sha512');
    for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
    return hash.digest('base64');
}
function safeEntry(name) {
    return typeof name === 'string' && !name.includes('\\') && !name.includes('\0') && !name.startsWith('/')
        && name === path.posix.normalize(name) && name.split('/').every((part) => part !== '..' && part !== '.') && /^[^/]+\.app\//.test(name);
}
function zipKey(value) { return value.normalize('NFD').toUpperCase().toLowerCase(); }
function inspectZip(file, { signal } = {}) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
            if (error) return reject(error);
            let root; let count = 0; let bytes = 0; const seen = new Set(); const aliases = new Map(); const links = new Map();
            const fail = (err) => { zip.close(); reject(err); };
            const abort = () => fail(signal.reason || new Error('Update ZIP validation cancelled.'));
            signal?.addEventListener('abort', abort, { once: true });
            zip.on('close', () => signal?.removeEventListener('abort', abort));
            if (signal?.aborted) { abort(); return; }
            zip.on('error', fail);
            zip.on('entry', (entry) => {
                const name = entry.fileName;
                const entryRoot = name.split('/')[0];
                const key = zipKey(name.replace(/\/$/, ''));
                // APFS aliases include implicit directories as well as entries.
                // Reject ambiguous spellings before ditto can merge their trees.
                const parts = name.replace(/\/$/, '').split('/');
                for (let i = 1; i <= parts.length; i++) {
                    const spelling = parts.slice(0, i).join('/'); const alias = zipKey(spelling);
                    if (aliases.has(alias) && aliases.get(alias) !== spelling) { fail(new Error('Ambiguous case or Unicode update ZIP paths.')); return; }
                    aliases.set(alias, spelling);
                }
                root ||= entryRoot;
                bytes += entry.uncompressedSize;
                const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
                if (!safeEntry(name) || entryRoot !== root || seen.has(key) || ++count > 100000 || bytes > 8 * 1024 ** 3
                    || (mode && ![0x8000, 0x4000, 0xa000].includes(mode)) || entry.generalPurposeBitFlag & 1) {
                    fail(new Error('Unsafe or incompatible update ZIP paths.')); return;
                }
                seen.add(key);
                if (mode !== 0xa000) { zip.readEntry(); return; }
                if (entry.uncompressedSize > 4096) { fail(new Error('Invalid update ZIP symlink.')); return; }
                zip.openReadStream(entry, (err, stream) => {
                    if (err) { fail(err); return; }
                    const chunks = [];
                    stream.on('data', (data) => chunks.push(data));
                    stream.on('error', fail);
                    stream.on('end', () => {
                        const target = Buffer.concat(chunks).toString('utf8');
                        if (!target || target.includes('\0') || target.includes('\\') || path.posix.isAbsolute(target)) { fail(new Error('Update ZIP symlink escapes its application.')); return; }
                        links.set(key, target);
                        zip.readEntry();
                    });
                });
            });
            zip.on('end', () => {
                if (!root || !seen.has(zipKey(`${root}/Contents/Info.plist`))) reject(new Error('Update ZIP contains no application bundle.'));
                else {
                    // Resolve the complete symlink graph before extraction: lexical
                    // containment alone misses links followed by parent segments.
                    try {
                        for (const name of seen) {
                            const todo = name.split('/'); const resolved = []; let hops = 0;
                            while (todo.length) {
                                const part = todo.shift();
                                if (!part || part === '.') continue;
                                if (part === '..') resolved.pop();
                                else {
                                    const next = [...resolved, part].join('/');
                                    if (links.has(zipKey(next))) {
                                        if (++hops > 40) throw new Error('Update ZIP contains cyclic symlinks.');
                                        todo.unshift(...links.get(zipKey(next)).split('/'));
                                    } else resolved.push(part);
                                }
                                if (resolved.length === 0 || zipKey(resolved[0]) !== zipKey(root)) throw new Error('Update ZIP symlink escapes its application.');
                            }
                        }
                        resolve(root);
                    } catch (error) { reject(error); }
                }
            });
            zip.readEntry();
        });
    });
}
async function safeInstallLocation({ packaged, platform, arch, executable, run = runFile, signal }) {
    if (!packaged || platform !== 'darwin' || arch !== 'arm64') throw new Error('In-app updates require an installed macOS arm64 release. Install a signed release manually first.');
    const bundle = path.resolve(executable, '../../..');
    if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')
        || fs.realpathSync(bundle) !== bundle) throw new Error('Move the application to Applications, launch it there, then retry.');
    fs.accessSync(bundle, fs.constants.W_OK);
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { signal, timeout: 120000 });
    const signature = await run('/usr/bin/codesign', ['-d', '-r-', '--verbose=2', bundle], { signal, timeout: 120000 });
    const details = `${signature.stdout}\n${signature.stderr}`;
    const requirement = details.match(/designated => (.+)/)?.[1];
    const team = details.match(/TeamIdentifier=([A-Z0-9]+)/)?.[1];
    if (!requirement || !team || !details.includes('Authority=Developer ID Application:')) throw new Error('The installed app has no trusted Developer ID publisher signature. Install a signed release manually.');
    return { bundle, requirement, team };
}
async function validatePayload(file, candidate, { installed, cacheDir, run = runFile, signal, macVersion, kernelVersion = os.release() } = {}) {
    checkAbort(signal);
    if (candidate.minimumSystemVersion && semver.lt(semver.coerce(kernelVersion), candidate.minimumSystemVersion)) throw new Error('This update requires a newer macOS kernel.');
    const boundedRun = (command, args, options = {}) => run(command, args, { ...options, signal, timeout: 120000 });
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== candidate.size || await hashFile(file, { signal }) !== candidate.sha512) throw new Error('Update integrity check failed. Download the update again.');
    const root = await inspectZip(file, { signal });
    const unpack = fs.mkdtempSync(path.join(cacheDir, 'verify-'));
    try {
        await boundedRun('/usr/bin/ditto', ['-x', '-k', file, unpack], { timeout: 120000 });
        const bundle = path.join(unpack, root);
        const plist = path.join(bundle, 'Contents', 'Info.plist');
        const read = async (key) => (await boundedRun('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim();
        if (await read('CFBundleIdentifier') !== 'com.transcriber.desktop' || await read('CFBundleShortVersionString') !== candidate.version) throw new Error('Update application identity or version does not match its release.');
        const minimumOS = await read('LSMinimumSystemVersion');
        const currentOS = semver.coerce(macVersion || (await boundedRun('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim()); const requiredOS = semver.coerce(minimumOS);
        if (!currentOS || !requiredOS || semver.lt(currentOS, requiredOS)) throw new Error('This update requires a newer macOS version. Upgrade macOS before installing.');
        const executable = await read('CFBundleExecutable');
        if (!/^[A-Za-z0-9._ -]+$/.test(executable)) throw new Error('Invalid application executable.');
        const architectures = (await boundedRun('/usr/bin/lipo', ['-archs', path.join(bundle, 'Contents', 'MacOS', executable)])).stdout.trim().split(/\s+/);
        if (!architectures.includes('arm64')) throw new Error('Update is incompatible with macOS arm64.');
        await boundedRun('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${installed.requirement}`, bundle]);
        const signature = await boundedRun('/usr/bin/codesign', ['-d', '--verbose=2', bundle]);
        if (!`${signature.stdout}\n${signature.stderr}`.includes(`TeamIdentifier=${installed.team}`)) throw new Error('Update publisher differs from the installed app.');
    } finally { fs.rmSync(unpack, { recursive: true, force: true }); }
}
function secureDownload(url, destination, candidate, progress, { request = https.get, redirects = 0, signal, timeoutMs = 15 * 60000 } = {}) {
    const scope = signal ? null : budget(timeoutMs); signal ||= scope.signal;
    let created = false, req, response, output, rejectOperation, observedDeadline = 0;
    const abort = () => { req?.destroy?.(signal.reason); response?.destroy?.(signal.reason); output?.destroy?.(signal.reason); rejectOperation?.(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    return new Promise((resolve, reject) => {
        rejectOperation = reject;
        try { checkAbort(signal); if (!trustedURL(url) || redirects > 5) throw new Error('Untrusted update payload redirect.'); }
        catch (error) { reject(error); return; }
        req = request(url, { headers: { 'User-Agent': 'desktop-update-client', Accept: 'application/octet-stream' } }, (res) => {
            response = res; res.on('error', reject);
            observedDeadline = Math.max(observedDeadline, retryDeadline(res.headers));
            if (signal.aborted) { abort(); reject(signal.reason); return; }
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.destroy();
                let next; try { next = new URL(res.headers.location, url).href; } catch (error) { reject(error); return; }
                secureDownload(next, destination, candidate, progress, { request, redirects: redirects + 1, signal }).then(resolve, reject); return;
            }
            if (res.statusCode !== 200) { res.destroy(); const error = new Error(`Update download failed (${res.statusCode}). Retry later.`); error.blockedUntil = retryDeadline(res.headers); reject(error); return; }
            let size = 0; const hash = crypto.createHash('sha512');
            const verify = new Transform({ transform(chunk, _encoding, callback) {
                size += chunk.length; hash.update(chunk);
                if (size > candidate.size) { callback(new Error('Update payload exceeds its expected size.')); return; }
                progress(100 * size / candidate.size); callback(null, chunk);
            } });
            output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
            output.once('open', () => { created = true; });
            pipeline(res, verify, output, { signal }).then(() => {
                if (size !== candidate.size || hash.digest('base64') !== candidate.sha512) throw new Error('Update integrity check failed. Retry the download.');
            }).then(resolve, reject);
        });
        req.on('error', reject);
    }).then((result) => ({ ...result, blockedUntil: Math.max(observedDeadline, result?.blockedUntil || 0) })).catch(async (error) => {
        error.blockedUntil = Math.max(observedDeadline, error.blockedUntil || 0);
        if (output && !output.closed) await new Promise((resolve) => output.once('close', resolve));
        if (created) { try { fs.unlinkSync(destination); } catch {} }
        throw error;
    })
        .finally(() => { signal.removeEventListener('abort', abort); scope?.close(); });
}
function createMacAdapter({ app, cacheDir, Updater, Provider, run = runFile, download = secureDownload, locationCheck, payloadValidator = validatePayload, cacheHash = hashFile,
    preparationMs = 120000, downloadMs = 17 * 60000, nativeWatchdogMs = 120000 } = {}) {
    let updater, downloadedFile, boundCandidate, proxyReady = false, activeOperation = null;
    function instance() {
        if (updater) return updater;
        const Constructor = Updater || require('electron-updater').MacUpdater;
        updater = new Constructor();
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        updater.autoRunAppAfterInstall = true;
        updater.allowDowngrade = false;
        updater.allowPrerelease = channelOf(app.getVersion()) === 'beta';
        updater.disableDifferentialDownload = true;
        updater.httpExecutor.download = async (url, target) => {
            if (!boundCandidate || url.href !== boundCandidate.url) throw new Error('Unbound update payload.');
            const operation = activeOperation; checkAbort(operation?.signal);
            const result = await download(url.href, target, boundCandidate, (percent) => {
                if (activeOperation === operation && !operation?.signal.aborted) updater.emit('download-progress', { percent });
            }, { signal: operation?.signal });
            checkAbort(operation?.signal);
            if (operation) operation.blockedUntil = Math.max(operation.blockedUntil || 0, result?.blockedUntil || 0);
        };
        // Pinned MacUpdater does not reject its proxy promise on listen errors.
        // Turn these into ordinary download/preparation failures before staging.
        const serve = updater.updateDownloaded.bind(updater);
        updater.updateDownloaded = async (...args) => {
            const operation = activeOperation;
            checkAbort(operation?.signal);
            const pending = serve(...args); const server = updater.server;
            pending.finally(() => { if (operation?.signal.aborted) updater.closeServerIfExists(); }).catch(() => {});
            if (!server) return abortable(pending, operation?.signal);
            const failed = (error) => fail(error);
            let fail;
            const serverError = new Promise((_resolve, reject) => { fail = reject; server.once('error', failed); });
            const abort = () => updater.closeServerIfExists();
            operation?.signal.addEventListener('abort', abort, { once: true });
            pending.finally(() => server.removeListener('error', failed)).catch(() => {});
            try { return await abortable(Promise.race([pending, serverError]), operation?.signal); }
            finally {
                if (!operation?.signal.aborted) server.removeListener('error', failed);
                operation?.signal.removeEventListener('abort', abort);
            }
        };
        // The pinned helper hashes a previous-launch cache without cancellation.
        // Replace only that lookup with a signal-aware hash; keep its cache and
        // download protocol, then perform full payload validation afterwards.
        if (typeof updater.getOrCreateDownloadHelper === 'function') {
            const getHelper = updater.getOrCreateDownloadHelper.bind(updater);
            updater.getOrCreateDownloadHelper = async (...args) => {
                const helper = await getHelper(...args);
                helper.getValidCachedUpdateFile = async (fileInfo) => {
                    const operation = activeOperation; const signal = operation?.signal;
                    checkAbort(signal);
                    try {
                        const info = JSON.parse(await fs.promises.readFile(helper.getUpdateInfoFile(), { encoding: 'utf8', signal }));
                        if (info.fileName !== boundCandidate?.name || info.sha512 !== fileInfo.info.sha512) return null;
                        const file = path.join(helper.cacheDirForPendingUpdate, info.fileName);
                        const stat = await fs.promises.lstat(file);
                        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== boundCandidate.size || await cacheHash(file, { signal }) !== fileInfo.info.sha512) return null;
                        checkAbort(signal); helper._downloadedFileInfo = info; return file;
                    } catch (error) { checkAbort(signal); return null; }
                };
                return helper;
            };
        }
        updater.on('error', () => {});
        return updater;
    }
    async function location(signal) {
        checkAbort(signal);
        if (locationCheck) return locationCheck(signal);
        return safeInstallLocation({ packaged: app.isPackaged, platform: process.platform, arch: process.arch, executable: app.getPath('exe'), run, signal });
    }
    function bind(candidate) {
        const u = instance(); boundCandidate = candidate;
        const Base = Provider || require('electron-updater/out/providers/Provider').Provider;
        class CandidateProvider extends Base {
            constructor(_options, _updater, runtimeOptions) { return createCandidateProvider(Base, candidate, u.httpExecutor, runtimeOptions); }
        }
        u.setFeedURL({ provider: 'custom', updateProvider: CandidateProvider });
        return u;
    }
    async function validate(candidate, { signal } = {}) {
        const scope = budget(preparationMs, signal);
        try {
            if (!downloadedFile || candidate !== boundCandidate) throw new Error('Download and verify this update again before installation.');
            const installed = await location(scope.signal);
            await payloadValidator(downloadedFile, candidate, { installed, cacheDir, run, signal: scope.signal });
            checkAbort(scope.signal);
        } catch (error) {
            error.requiresDownload = true; downloadedFile = null; proxyReady = false;
            updater?.closeServerIfExists(); await updater?.downloadedUpdateHelper?.clear(); throw error;
        } finally { scope.close(); }
    }
    return {
        clear() { downloadedFile = null; boundCandidate = null; proxyReady = false; updater?.closeServerIfExists(); },
        cacheRecord() { return downloadedFile && boundCandidate ? { file: downloadedFile, candidate: boundCandidate } : null; },
        async restore(record) {
            // This is validation only: no download, native proxy or staging.
            if (!record?.candidate || typeof record.file !== 'string') return null;
            const candidate = record.candidate;
            const { manifestCandidate, REPOSITORY } = require('./update-provider');
            const installedVersion = app.getVersion();
            if (candidate.channel !== channelOf(candidate.version) || !semver.valid(candidate.version) || !semver.gt(candidate.version, installedVersion) || channelOf(candidate.version) !== channelOf(installedVersion)
                || candidate.tag !== `v${candidate.version}`) return null;
            const expected = `https://github.com/${REPOSITORY}/releases/download/${candidate.tag}/${candidate.name}`;
            if (candidate.url !== expected) return null;
            manifestCandidate({ tag_name: candidate.tag, assets: [{ name: candidate.name, size: candidate.size, browser_download_url: candidate.url }] }, candidate.version, candidate.channel,
                { version: candidate.version, minimumSystemVersion: candidate.minimumSystemVersion, files: [{ url: candidate.name, sha512: candidate.sha512, size: candidate.size }] });
            // Cache paths are main-owned updater paths, never renderer input.
            // Revalidation checks the payload and installed publisher afresh.
            downloadedFile = record.file; boundCandidate = Object.freeze({ ...candidate });
            await validate(boundCandidate);
            return boundCandidate;
        },
        async download(candidate, progress) {
            if (activeOperation) throw new Error('An update operation is still finishing. Retry after it completes.');
            const scope = budget(downloadMs);
            const { CancellationToken } = require('builder-util-runtime');
            const cancellation = new CancellationToken();
            const operation = { signal: scope.signal, blockedUntil: 0 };
            activeOperation = operation;
            let u, pending, onProgress, onDownloaded, complete = false;
            const cancel = () => { cancellation.cancel(); u?.closeServerIfExists(); };
            scope.signal.addEventListener('abort', cancel, { once: true });
            try {
                await abortable(location(scope.signal), scope.signal);
                fs.mkdirSync(cacheDir, { recursive: true });
                u = bind(candidate); downloadedFile = null; proxyReady = false;
                const provider = await abortable(u.clientPromise, scope.signal);
                u.updateInfoAndProvider = { info: await abortable(provider.getLatestVersion(), scope.signal), provider };
                onProgress = (event) => { if (!scope.signal.aborted) progress(event.percent); };
                onDownloaded = (event) => { if (!scope.signal.aborted && activeOperation === operation) downloadedFile = event.downloadedFile; };
                u.on('download-progress', onProgress); u.on('update-downloaded', onDownloaded);
                pending = u.downloadUpdate(cancellation);
                await abortable(pending, scope.signal);
                await abortable(validate(candidate, { signal: scope.signal }), scope.signal);
                checkAbort(scope.signal); complete = true;
                return { blockedUntil: operation.blockedUntil };
            } catch (error) {
                downloadedFile = null; proxyReady = false;
                error.blockedUntil = Math.max(operation.blockedUntil, error.blockedUntil || 0);
                // Native staging has not started. A late pinned completion must
                // encounter this cancelled operation before creating a proxy.
                if (!scope.signal.aborted) scope.abort(error);
                throw error;
            } finally {
                u?.closeServerIfExists();
                if (onProgress) u.removeListener('download-progress', onProgress);
                if (onDownloaded) u.removeListener('update-downloaded', onDownloaded);
                scope.signal.removeEventListener('abort', cancel); scope.close();
                if (complete || !pending) activeOperation = null;
                else {
                    // Do not overlap a retry with an uncooperative late pinned
                    // operation. Its guards remain attached until it settles.
                    Promise.resolve(pending).catch(() => {}).finally(async () => {
                        u?.closeServerIfExists();
                        await u?.downloadedUpdateHelper?.clear();
                        if (activeOperation === operation) activeOperation = null;
                    }).catch(() => {});
                }
            }
        },
        validate,
        async prepare(candidate, { signal } = {}) {
            if (activeOperation) throw new Error('An update operation is still finishing. Retry after it completes.');
            const scope = budget(preparationMs, signal); const operation = { signal: scope.signal };
            activeOperation = operation;
            try {
                await abortable(validate(candidate, { signal: scope.signal }), scope.signal);
                checkAbort(scope.signal);
                const u = bind(candidate);
                const provider = await abortable(u.clientPromise, scope.signal);
                u.updateInfoAndProvider = { info: await abortable(provider.getLatestVersion(), scope.signal), provider };
                await abortable(u.updateDownloaded({ url: new URL(candidate.url), info: { size: candidate.size } }, { downloadedFile, version: candidate.version }), scope.signal);
                checkAbort(scope.signal); proxyReady = true;
            } catch (error) {
                proxyReady = false; updater?.closeServerIfExists();
                if (!scope.signal.aborted) scope.abort(error);
                throw error;
            } finally { activeOperation = null; scope.close(); }
        },
        async install(candidate, { onRestart = () => {}, onWaiting = () => {} } = {}) {
            if (!downloadedFile || candidate !== boundCandidate) throw new Error('Update candidate changed. Download again.');
            const u = instance();
            if (!proxyReady) throw new Error('Prepare and verify the update before installation.');
            const native = u.nativeUpdater;
            await new Promise((resolve, reject) => {
                const clean = () => { clearTimeout(watchdog); native.removeListener('error', failed); native.removeListener('update-downloaded', ready); native.removeListener('update-not-available', unavailable); };
                const failed = (error) => {
                    clean(); u.closeServerIfExists(); proxyReady = false; downloadedFile = null;
                    error.requiresDownload = true; reject(error);
                };
                const unavailable = () => failed(new Error('Native update is no longer available. Download the update again before retrying installation.'));
                const ready = () => {
                    clean(); u.closeServerIfExists();
                    try { onRestart(); native.quitAndInstall(); resolve(); } catch (error) { error.nativeCommitted = true; reject(error); }
                };
                // Squirrel has no cancellation contract. A watchdog can explain
                // the delay, but must never unlock while staging can still win.
                const watchdog = setTimeout(() => onWaiting('Native installation is still running. Keep the app open; meeting work remains reserved until it finishes.'), nativeWatchdogMs);
                watchdog.unref?.();
                native.once('error', failed); native.once('update-downloaded', ready); native.once('update-not-available', unavailable);
                try { native.checkForUpdates(); } catch (error) { failed(error); }
            });
        },
    };
}
module.exports = { safeEntry, inspectZip, hashFile, safeInstallLocation, validatePayload, secureDownload, createMacAdapter };
