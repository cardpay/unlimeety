'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { inspectZip, validatePayload } = require('../update-mac');

// Independent stored-ZIP fixture writer, including Unix symlink modes.
function zipBuffer(entries) {
    const locals = []; const central = []; let offset = 0;
    for (const { name, data: value = '', mode = 0o100644 } of entries) {
        const data = Buffer.from(value); const filename = Buffer.from(name);
        let crc = 0xffffffff;
        for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
        crc = (crc ^ 0xffffffff) >>> 0;
        const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
        header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
        const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x031e, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
        record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(filename.length, 28);
        record.writeUInt32LE((mode << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
        locals.push(header, filename, data); central.push(record, filename); offset += header.length + filename.length + data.length;
    }
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    const directory = Buffer.concat(central); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}
function fixture(t, { version = '2.0.1', channel = 'stable', bundleVersion = version, identifier = 'com.transcriber.desktop', arch = 'arm64', minimumOS = '14.2', entries = [] } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'update-release-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const plist = `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleShortVersionString</key><string>${bundleVersion}</string><key>CFBundleExecutable</key><string>Desktop</string><key>LSMinimumSystemVersion</key><string>${minimumOS}</string></dict></plist>`;
    const executable = Buffer.alloc(32); executable.writeUInt32LE(0xfeedfacf, 0); executable.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
    const buffer = zipBuffer([{ name: 'Desktop.app/Contents/Info.plist', data: plist }, { name: 'Desktop.app/Contents/MacOS/Desktop', data: executable }, ...entries]);
    const name = `desktop-${version}-arm64.zip`; const file = path.join(directory, name); fs.writeFileSync(file, buffer);
    const manifest = { version, files: [{ url: name, size: buffer.length, sha512: crypto.createHash('sha512').update(buffer).digest('base64') }] };
    const metadata = path.join(directory, channel === 'beta' ? 'beta-mac.yml' : 'latest-mac.yml'); fs.writeFileSync(metadata, yaml.dump(manifest));
    return { directory, version, channel, manifest, metadata, file };
}
test('offline verifier accepts actual arm64 stable and beta payloads', async (t) => {
    const { verifyRelease } = await import('../scripts/verify-update-release.mjs');
    for (const settings of [{}, { version: '2.1.0-beta.10', channel: 'beta' }]) {
        const data = fixture(t, settings); const result = await verifyRelease(data);
        assert.equal(result.version, data.version); assert.equal(result.channel, data.channel);
    }
});
for (const settings of [{ bundleVersion: '9.0.0' }, { identifier: 'org.example.other' }, { arch: 'x64' }]) {
    test(`offline verifier rejects incompatible bundle: ${JSON.stringify(settings)}`, async (t) => {
        const { verifyRelease } = await import('../scripts/verify-update-release.mjs'); await assert.rejects(verifyRelease(fixture(t, settings)));
    });
}
test('offline verifier rejects channel mismatch and corrupt payload', async (t) => {
    const { verifyRelease } = await import('../scripts/verify-update-release.mjs'); const data = fixture(t);
    await assert.rejects(verifyRelease({ ...data, channel: 'beta' }), /channel/);
    fs.appendFileSync(data.file, 'corrupt'); await assert.rejects(verifyRelease(data), /inconsistent|SHA-512/);
});
test('offline verifier rejects wrong manifest version/hash and missing payload', async (t) => {
    const { verifyRelease } = await import('../scripts/verify-update-release.mjs'); const data = fixture(t);
    fs.writeFileSync(data.metadata, yaml.dump({ ...data.manifest, version: '8.0.0' })); await assert.rejects(verifyRelease(data), /version/);
    fs.writeFileSync(data.metadata, yaml.dump({ ...data.manifest, files: [{ ...data.manifest.files[0], sha512: crypto.randomBytes(64).toString('base64') }] })); await assert.rejects(verifyRelease(data), /SHA-512/);
    fs.unlinkSync(data.file); await assert.rejects(verifyRelease(data), /missing|inconsistent/);
});
for (const entries of [
    [{ name: '../escape', data: 'bad' }],
    [{ name: 'Other.app/Contents/Info.plist', data: 'bad' }],
    [{ name: 'Desktop.app/link', data: '../../escape', mode: 0o120777 }],
    [{ name: 'Desktop.app/link', data: 'link', mode: 0o120777 }],
    [{ name: 'Desktop.app/dir/link', data: '../sub', mode: 0o120777 }, { name: 'Desktop.app/alias', data: 'dir/link/../../outside', mode: 0o120777 }],
]) test('unsafe/cyclic ZIP paths and symlink graphs are rejected before extraction', async (t) => {
    const data = fixture(t, { entries }); await assert.rejects(inspectZip(data.file));
});
test('framework symlinks stay supported inside the bundle', async (t) => {
    const data = fixture(t, { entries: [
        { name: 'Desktop.app/Contents/Frameworks/Fixture.framework/Versions/Current', data: 'A', mode: 0o120777 },
        { name: 'Desktop.app/Contents/Frameworks/Fixture.framework/Fixture', data: 'Versions/Current/Fixture', mode: 0o120777 },
        { name: 'Desktop.app/Contents/Frameworks/Fixture.framework/Versions/A/Fixture', data: 'fixture' },
    ] });
    assert.equal(await inspectZip(data.file), 'Desktop.app');
});
test('payload validator checks archive and designated publisher; cleanup survives a wrong signature', async (t) => {
    const data = fixture(t); const candidate = { ...data.manifest.files[0], version: data.version };
    const commands = [];
    const run = async (command, args) => {
        commands.push({ command, args });
        if (command.endsWith('plutil')) return { stdout: ({ CFBundleIdentifier: 'com.transcriber.desktop', CFBundleShortVersionString: data.version, CFBundleExecutable: 'Desktop', LSMinimumSystemVersion: '14.2' })[args[1]], stderr: '' };
        if (command.endsWith('lipo')) return { stdout: 'arm64', stderr: '' };
        return { stdout: '', stderr: 'TeamIdentifier=FIXTURE123' };
    };
    const options = { macVersion: '15.0', cacheDir: data.directory, installed: { requirement: 'anchor apple generic and certificate leaf[subject.OU] = FIXTURE123', team: 'FIXTURE123' }, run };
    await validatePayload(data.file, candidate, options);
    assert.ok(commands.some(({ command, args }) => command.endsWith('codesign') && args.includes(`-R=${options.installed.requirement}`)));
    await assert.rejects(validatePayload(data.file, candidate, { ...options, installed: { ...options.installed, team: 'OTHER12345' } }), /publisher/);
    assert.equal(fs.readdirSync(data.directory).some((name) => name.startsWith('verify-')), false);
});
for (const entries of [
    [{ name: 'Desktop.app/contents/Other', data: 'alias' }],
    [{ name: 'Desktop.app/Contents/Café', data: 'one' }, { name: 'Desktop.app/Contents/Cafe\u0301', data: 'two' }],
    [{ name: 'Desktop.app/Contents/LINK', data: '../../escape', mode: 0o120777 }, { name: 'Desktop.app/Contents/link/file', data: 'alias' }],
    [{ name: 'Desktop.app/Contents/Case', data: 'one' }, { name: 'Desktop.app/Contents/case/', mode: 0o40755 }],
]) test('case-folded Unicode aliases and implicit directory collisions are rejected before extraction', async (t) => {
    const data = fixture(t, { entries }); await assert.rejects(inspectZip(data.file), /Ambiguous|Unsafe/);
});
test('payload minimum macOS version is enforced before publisher/native staging', async (t) => {
    const data = fixture(t); const commands = [];
    const run = async (command, args) => {
        commands.push(command);
        if (command.endsWith('plutil')) return { stdout: ({ CFBundleIdentifier: 'com.transcriber.desktop', CFBundleShortVersionString: data.version, LSMinimumSystemVersion: '99.0' })[args[1]] };
        return { stdout: '' };
    };
    await assert.rejects(validatePayload(data.file, { ...data.manifest.files[0], version: data.version }, { cacheDir: data.directory, installed: {}, macVersion: '15.0', run }), /newer macOS/);
    assert.equal(commands.some((command) => command.endsWith('codesign')), false);
    assert.equal(fs.readdirSync(data.directory).some((name) => name.startsWith('verify-')), false);
});
test('pinned builder configuration validates without building; ZIP is versioned and DMG keeps its stable name', async () => {
    const config = require('../package.json').build;
    assert.equal(require('electron-builder/package.json').version, '26.15.3');
    await require('app-builder-lib/out/util/config/config').validateConfiguration(config);
    assert.equal(config.mac.artifactName, '${productName}-${version}-${arch}.${ext}');
    assert.equal(config.dmg.artifactName, '${productName}-${arch}.${ext}');
    assert.equal(config.zip, undefined);
});
test('cancellation reaches payload extraction and removes its partial verification directory', async (t) => {
    const data = fixture(t); const controller = new AbortController(); let started;
    const extracting = new Promise((resolve) => { started = resolve; });
    const run = async (command, _args, options) => {
        assert.ok(options.signal); assert.ok(options.timeout > 0);
        assert.equal(command, '/usr/bin/ditto'); started();
        await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    };
    const pending = validatePayload(data.file, { ...data.manifest.files[0], version: data.version }, { cacheDir: data.directory, installed: {}, run, signal: controller.signal });
    await extracting; controller.abort(new Error('preparation cancelled'));
    await assert.rejects(pending, /preparation cancelled/);
    assert.equal(fs.readdirSync(data.directory).some((name) => name.startsWith('verify-')), false);
});
