import { createHash } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';
import { get } from 'node:https';

export function downloadPinnedArchive({
  url, target, expectedSha256, approvedHosts,
  request = get, maxRedirects = 3,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) {
        try { rmSync(target, { force: true }); } catch {}
        reject(error);
      } else resolve();
    };
    const requestUrl = (current, redirects) => {
      if (!(current instanceof URL) || current.protocol !== 'https:' || !approvedHosts.has(current.hostname) || redirects > maxRedirects) {
        finish(new Error('Runner archive redirected to an unapproved location.'));
        return;
      }
      const req = request(current, { headers: { 'User-Agent': 'Unlimeety runner downloader' } }, (response) => {
        if (settled) { response.resume(); return; }
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          let next;
          try { next = new URL(response.headers.location, current); } catch { finish(new Error('Invalid runner archive redirect.')); return; }
          requestUrl(next, redirects + 1);
          return;
        }
        if (response.statusCode !== 200) { response.resume(); finish(new Error(`Runner download failed (${response.statusCode || 'network error'}).`)); return; }
        let output;
        const hash = createHash('sha256');
        try { output = createWriteStream(target, { flags: 'wx', mode: 0o600 }); } catch (error) { finish(error); return; }
        response.on('data', (chunk) => hash.update(chunk));
        response.on('error', finish);
        output.on('error', finish);
        output.on('finish', () => {
          if (hash.digest('hex') !== expectedSha256) {
            finish(new Error('Runner archive SHA-256 mismatch.'));
            return;
          }
          finish();
        });
        response.pipe(output);
      });
      req.on('error', finish);
    };
    requestUrl(url, 0);
  });
}
