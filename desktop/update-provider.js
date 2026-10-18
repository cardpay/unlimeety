'use strict';

const https = require('node:https');
const semver = require('semver');
const yaml = require('js-yaml');
const os = require('node:os');
const { budget, checkAbort } = require('./update-bounds');

const REPOSITORY = 'cardpay/unlimeety';
const RELEASES = `https://api.github.com/repos/${REPOSITORY}/releases`;
const MAX_PAGES = 20;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;

function channelOf(version) {
    if (typeof version !== 'string') return null;
    const parsed = semver.parse(version, { loose: false });
    if (!parsed || parsed.version + (parsed.build.length ? `+${parsed.build.join('.')}` : '') !== version) return null;
    const pre = semver.prerelease(version);
    return !pre ? 'stable' : pre[0] === 'beta' ? 'beta' : null;
}
function trustedURL(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    return url.hostname === 'api.github.com' || url.hostname === 'release-assets.githubusercontent.com'
        || url.hostname === 'objects.githubusercontent.com'
        || (url.hostname === 'github.com' && url.pathname.startsWith(`/${REPOSITORY}/releases/download/`));
}
function retryDeadline(headers, now = Date.now()) {
    const retry = headers['retry-after'];
    const delay = retry && /^\d+$/.test(String(retry)) ? now + Number(retry) * 1000 : Date.parse(retry);
    const reset = Number(headers['x-ratelimit-reset']) * 1000;
    return Math.max(Number.isFinite(delay) ? delay : 0,
        headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset) ? reset : 0);
}
// Discovery and payload downloads share the same redirect policy. Never forward
// credentials, and bound time, redirects and response sizes before parsing.
function requestBuffer(url, { request = https.get, maxBytes = MAX_METADATA_BYTES, redirects = 0, now = Date.now, signal, timeoutMs = 30000 } = {}) {
    const scope = signal ? null : budget(timeoutMs);
    signal ||= scope.signal;
    let abort, observedDeadline = 0;
    return new Promise((resolve, reject) => {
        let req, response;
        const fail = (error) => { req?.destroy?.(); response?.destroy?.(); reject(error); };
        abort = () => fail(signal.reason || new Error('Update request timed out.'));
        try { checkAbort(signal); if (!trustedURL(url) || redirects > 5) throw new Error('Untrusted update download location.'); }
        catch (error) { reject(error); return; }
        signal.addEventListener('abort', abort, { once: true });
        req = request(url, { headers: { 'User-Agent': 'desktop-update-client', Accept: 'application/vnd.github+json' } }, (res) => {
            response = res; res.on('error', reject);
            observedDeadline = Math.max(observedDeadline, retryDeadline(res.headers, now()));
            if (signal.aborted) { abort(); return; }
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.destroy();
                let next;
                try { next = new URL(res.headers.location, url).href; } catch (error) { reject(error); return; }
                requestBuffer(next, { request, maxBytes, redirects: redirects + 1, now, signal }).then(resolve, reject);
                return;
            }
            const blockedUntil = retryDeadline(res.headers, now());
            if (res.statusCode !== 200) {
                res.destroy();
                const error = new Error(`Update server returned ${res.statusCode}. Try again later.`);
                error.blockedUntil = blockedUntil;
                reject(error); return;
            }
            const chunks = []; let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > maxBytes) { fail(new Error('Update response exceeds the size limit.')); return; }
                chunks.push(chunk);
            });
            res.on('end', () => resolve({ body: Buffer.concat(chunks), blockedUntil }));
        });
        req.on('error', reject);
    }).then((result) => ({ ...result, blockedUntil: Math.max(observedDeadline, result.blockedUntil || 0) })).catch((error) => { error.blockedUntil = Math.max(observedDeadline, error.blockedUntil || 0); throw error; }).finally(() => { if (abort) signal.removeEventListener('abort', abort); scope?.close(); });
}
function manifestCandidate(release, version, channel, manifest, { kernelVersion = os.release() } = {}) {
    const minimum = manifest?.minimumSystemVersion;
    if (minimum !== undefined && (!semver.valid(minimum) || semver.lt(semver.coerce(kernelVersion), minimum))) {
        throw new Error('This update requires a newer macOS kernel. Upgrade macOS before updating the app.');
    }
    if (!manifest || manifest.version !== version || !Array.isArray(manifest.files)) throw new Error('Update metadata has an inconsistent version or file list.');
    const zips = manifest.files.filter((file) => typeof file.url === 'string' && file.url.endsWith('.zip'));
    if (zips.length !== 1) throw new Error('Update metadata must reference one macOS arm64 ZIP.');
    const file = zips[0];
    if (file.url !== file.url.split('/').pop() || !file.url.includes('-arm64') || !file.url.includes(version)
        || !/^[A-Za-z0-9._+-]+$/.test(file.url)
        || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512 || '') || !Number.isSafeInteger(file.size) || file.size <= 0) {
        throw new Error('Update payload metadata is invalid or incompatible with macOS arm64.');
    }
    const asset = release.assets.find((a) => a.name === file.url);
    const expectedURL = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${file.url}`;
    if (!asset || asset.size !== file.size || asset.browser_download_url !== expectedURL) throw new Error('Update payload is missing or inconsistent with its release.');
    return Object.freeze({ version, channel, tag: release.tag_name, url: expectedURL, name: file.url,
        sha512: file.sha512, size: file.size, minimumSystemVersion: minimum, releaseDate: release.published_at || undefined });
}
async function discoverUpdate(installed, { fetch = requestBuffer, timeoutMs = 120000, kernelVersion, now = Date.now } = {}) {
    const channel = channelOf(installed);
    if (!channel) throw new Error('This app version does not support stable or beta updates.');
    const eligible = [];
    const scope = budget(timeoutMs);
    let blockedUntil = 0; let complete = false;
    async function get(url) {
        checkAbort(scope.signal);
        if (blockedUntil > now()) {
            const error = new Error('The update server is rate limited. Retry after its deadline.');
            error.blockedUntil = blockedUntil; throw error;
        }
        const response = await fetch(url, { signal: scope.signal });
        blockedUntil = Math.max(blockedUntil, response.blockedUntil || 0);
        return response;
    }
    try {
        for (let page = 1; page <= MAX_PAGES; page++) {
            const response = await get(`${RELEASES}?per_page=100&page=${page}`);
            blockedUntil = Math.max(blockedUntil, response.blockedUntil || 0);
            const releases = JSON.parse(response.body.toString('utf8'));
            if (!Array.isArray(releases)) throw new Error('Invalid update release list.');
            for (const release of releases) {
                if (release.draft !== false || typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) continue;
                const version = release.tag_name.slice(1);
                if (channelOf(version) !== channel || release.prerelease !== (channel === 'beta') || !semver.gt(version, installed)) continue;
                eligible.push({ release, version });
            }
            if (releases.length < 100) { complete = true; break; }
        }
        if (!complete) throw new Error('Release discovery exceeded its page limit. Retry after the release list is reduced.');
        eligible.sort((a, b) => semver.rcompare(a.version, b.version));
        if (!eligible.length) return { candidate: null, blockedUntil };
        const { release, version } = eligible[0];
        const name = channel === 'beta' ? 'beta-mac.yml' : 'latest-mac.yml';
        const asset = Array.isArray(release.assets) && release.assets.find((a) => a.name === name);
        const expectedURL = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${name}`;
        if (!asset || asset.browser_download_url !== expectedURL) throw new Error(`Update ${version} is incomplete: ${name} is unavailable. Try again after its release assets are published.`);
        const response = await get(expectedURL);
        blockedUntil = Math.max(blockedUntil, response.blockedUntil || 0);
        return { candidate: manifestCandidate(release, version, channel, yaml.load(response.body.toString('utf8')), { kernelVersion }), blockedUntil };
    } catch (error) { error.blockedUntil = Math.max(blockedUntil, error.blockedUntil || 0); throw error; }
    finally { scope.close(); }
}

// electron-updater's GitHub provider promotes prereleases to stable. This
// provider is bound to exactly one independently selected candidate instead.
function createCandidateProvider(Provider, candidate, executor, runtimeOptions) {
    return new class extends Provider {
        constructor() { super({ ...runtimeOptions, executor }); }
        async getLatestVersion() { return { version: candidate.version, files: [{ url: candidate.url, sha512: candidate.sha512, size: candidate.size }], releaseDate: candidate.releaseDate }; }
        resolveFiles(info) {
            if (info.version !== candidate.version) throw new Error('Update candidate changed. Check again.');
            return [{ url: new URL(candidate.url), info: { url: candidate.url, sha512: candidate.sha512, size: candidate.size } }];
        }
    }();
}
module.exports = { REPOSITORY, channelOf, trustedURL, retryDeadline, requestBuffer, manifestCandidate, discoverUpdate, createCandidateProvider };
