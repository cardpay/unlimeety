// Offline release-asset verification. This never builds, uploads or publishes.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const yauzl = require('yauzl');
const semver = require('semver');
const { channelOf, manifestCandidate, REPOSITORY } = require('../update-provider');
const { hashFile, inspectZip } = require('../update-mac');

function readMember(file, member, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true }, (error, zip) => {
            if (error) return reject(error);
            zip.on('error', reject);
            zip.on('entry', (entry) => {
                if (entry.fileName !== member) { zip.readEntry(); return; }
                zip.openReadStream(entry, (err, stream) => {
                    if (err) { zip.close(); reject(err); return; }
                    const chunks = []; let bytes = 0;
                    stream.on('error', reject);
                    stream.on('data', (chunk) => {
                        if (bytes < limit) chunks.push(chunk.subarray(0, limit - bytes));
                        bytes += chunk.length;
                    });
                    stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks)); });
                });
            });
            zip.on('end', () => reject(new Error(`Missing update bundle member: ${member}`)));
            zip.readEntry();
        });
    });
}
export function containsArm64(buffer) {
    if (buffer.length < 8) return false;
    const magic = buffer.readUInt32BE(0);
    if (magic === 0xcffaedfe) return buffer.readUInt32LE(4) === 0x0100000c;
    if (magic === 0xfeedfacf) return buffer.readUInt32BE(4) === 0x0100000c;
    if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false;
    const count = buffer.readUInt32BE(4); const stride = magic === 0xcafebabf ? 32 : 20;
    if (count > 32 || buffer.length < 8 + count * stride) return false;
    for (let i = 0; i < count; i++) if (buffer.readUInt32BE(8 + i * stride) === 0x0100000c) return true;
    return false;
}
export async function verifyBundle(file, root, version) {
    let plist = await readMember(file, `${root}/Contents/Info.plist`);
    if (plist.subarray(0, 6).toString() === 'bplist') {
        if (process.platform !== 'darwin') throw new Error('Binary bundle plists require macOS plutil for offline verification.');
        plist = execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], { input: plist });
    }
    const xml = plist.toString('utf8');
    const value = (key) => xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];
    if (value('CFBundleIdentifier') !== 'com.transcriber.desktop' || value('CFBundleShortVersionString') !== version) throw new Error('Payload bundle identity/version does not match the release.');
    const minimumOS = value('LSMinimumSystemVersion');
    if (!minimumOS || !/^\d+(?:\.\d+){0,2}$/.test(minimumOS) || !semver.coerce(minimumOS)) throw new Error('Payload has no valid minimum macOS version.');
    const executable = value('CFBundleExecutable');
    if (!executable || !/^[A-Za-z0-9._ -]+$/.test(executable)) throw new Error('Invalid payload executable.');
    if (!containsArm64(await readMember(file, `${root}/Contents/MacOS/${executable}`, 4096))) throw new Error('Payload executable does not contain macOS arm64 code.');
}
export async function verifyRelease({ directory, version, channel, bundleVerifier = verifyBundle }) {
    if (channelOf(version) !== channel) throw new Error('Version does not match the requested stable/beta channel.');
    const name = channel === 'beta' ? 'beta-mac.yml' : 'latest-mac.yml';
    const manifest = yaml.load(fs.readFileSync(path.join(directory, name), 'utf8'));
    const tag = `v${version}`;
    const release = { tag_name: tag, assets: fs.readdirSync(directory).map((name) => ({
        name, size: fs.lstatSync(path.join(directory, name)).size,
        browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`,
    })) };
    const candidate = manifestCandidate(release, version, channel, manifest);
    const file = path.join(directory, candidate.name);
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Payload must be an ordinary ZIP file.');
    if (await hashFile(file) !== candidate.sha512) throw new Error('Payload SHA-512 does not match the manifest.');
    const root = await inspectZip(file);
    await bundleVerifier(file, root, version);
    return { version, channel, manifest: name, payload: candidate.name, size: candidate.size, sha512: candidate.sha512 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const option = (name) => args[args.indexOf(name) + 1];
    try {
        if (!args.includes('--version') || !args.includes('--channel')) throw new Error('Usage: npm run verify:update -- --version X.Y.Z[-beta.N] --channel stable|beta [--dir dist]');
        const result = await verifyRelease({ directory: args.includes('--dir') ? option('--dir') : 'dist', version: option('--version'), channel: option('--channel') });
        console.log(JSON.stringify(result, null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
