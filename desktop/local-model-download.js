'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

function removeStalePartArtifacts(destination) {
    const dir = path.dirname(destination);
    const prefix = `.${path.basename(destination)}-`;
    for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(prefix) || !name.endsWith('.part')) continue;
        const stale = path.join(dir, name);
        try {
            const stat = fs.lstatSync(stale);
            if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(stale);
        } catch { /* a concurrent cleanup is harmless */ }
    }
}

// Downloads one manifest-owned artifact to an app-owned destination. The
// caller supplies only static manifest values; no renderer input crosses here.
function downloadVerifiedArtifact({
    url, destination, expectedBytes, expectedSha256, approvedHosts,
    isCancelled = () => false, onProgress = () => {}, onRequest = () => {},
    request = https.get, writeSync = fs.writeSync, maxRedirects = 3,
}) {
    return new Promise((resolve, reject) => {
        let finished = false;
        let fd;
        let tmp;
        const finish = (err) => {
            if (finished) return;
            finished = true;
            try { if (fd !== undefined) fs.closeSync(fd); } catch {}
            try { if (tmp) fs.unlinkSync(tmp); } catch {}
            if (err) reject(err); else resolve();
        };
        const requestUrl = (current, redirects) => {
            if (isCancelled()) { finish(new Error('Download cancelled.')); return; }
            if (!(current instanceof URL) || current.protocol !== 'https:' || !approvedHosts.has(current.hostname) || redirects > maxRedirects) {
                finish(new Error('The model download redirected to an unapproved location.'));
                return;
            }
            const req = request(current, { headers: { 'User-Agent': 'Unlimeety local model downloader' } }, (res) => {
                if (finished) { res.resume(); return; }
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    let next;
                    try { next = new URL(res.headers.location, current); } catch { finish(new Error('Invalid model download redirect.')); return; }
                    requestUrl(next, redirects + 1);
                    return;
                }
                if (res.statusCode !== 200) { res.resume(); finish(new Error(`Model download failed (${res.statusCode || 'network error'}).`)); return; }
                try {
                    tmp = path.join(path.dirname(destination), `.${path.basename(destination)}-${crypto.randomBytes(16).toString('hex')}.part`);
                    fd = fs.openSync(tmp, 'wx', 0o600);
                } catch (err) { finish(err); return; }
                let bytes = 0;
                const hash = crypto.createHash('sha256');
                res.on('data', (chunk) => {
                    if (finished) return;
                    if (isCancelled()) { res.destroy(); finish(new Error('Download cancelled.')); return; }
                    try {
                        let offset = 0;
                        while (offset < chunk.length) {
                            const written = writeSync(fd, chunk, offset, chunk.length - offset);
                            if (!Number.isInteger(written) || written <= 0) throw new Error('Could not write downloaded model.');
                            offset += written;
                        }
                        bytes += chunk.length;
                        hash.update(chunk);
                        if (bytes > expectedBytes) throw new Error('Downloaded model did not pass verification.');
                        onProgress(Math.min(99, Math.floor(bytes * 100 / expectedBytes)));
                    } catch (err) { res.destroy(); finish(err); }
                });
                res.on('error', finish);
                res.on('end', () => {
                    if (finished) return;
                    try {
                        fs.fsyncSync(fd);
                        fs.closeSync(fd);
                        fd = undefined;
                        if (isCancelled()) throw new Error('Download cancelled.');
                        if (bytes !== expectedBytes || hash.digest('hex') !== expectedSha256) throw new Error('Downloaded model did not pass verification.');
                        fs.renameSync(tmp, destination);
                        tmp = null;
                        finish();
                    } catch (err) { finish(err); }
                });
            });
            onRequest(req);
            req.on('error', finish);
        };
        try { removeStalePartArtifacts(destination); } catch (err) { finish(err); return; }
        requestUrl(url, 0);
    });
}

module.exports = { downloadVerifiedArtifact, removeStalePartArtifacts };
