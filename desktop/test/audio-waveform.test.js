'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { readWaveform } = require('../audio-waveform');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-waveform-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;

function chunk(id, body) {
    const header = Buffer.alloc(8);
    header.write(id); header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body, Buffer.alloc(body.length % 2)]);
}

function wav({ bits = 16, channels = 1, codec = 1, extensible = false, data, metadata = [] } = {}) {
    const fmt = Buffer.alloc(extensible ? 40 : 16);
    fmt.writeUInt16LE(extensible ? 0xfffe : codec, 0);
    fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(16000, 4);
    fmt.writeUInt32LE(16000 * channels * bits / 8, 8);
    fmt.writeUInt16LE(channels * bits / 8, 12); fmt.writeUInt16LE(bits, 14);
    if (extensible) {
        fmt.writeUInt16LE(22, 16); fmt.writeUInt16LE(bits, 18);
        Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(fmt, 24);
        fmt.writeUInt16LE(codec, 24);
    }
    const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), ...metadata, chunk('data', data || Buffer.alloc(320))]);
    const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
}

function save(buffer) {
    const file = path.join(root, `${++serial}.wav`);
    fs.writeFileSync(file, buffer);
    return file;
}

for (const [codec, bits] of [[1, 8], [1, 16], [1, 24], [1, 32], [3, 32], [3, 64]]) {
    test(`real amplitudes survive sparse sampling: codec ${codec}, ${bits} bits, stereo`, async () => {
        const bytes = bits / 8;
        const data = Buffer.alloc(80 * 100 * 2 * bytes);
        for (let frame = 0; frame < 8000; frame++) {
            // Only the right channel has a signal; alternating sign catches
            // readers that forget absolute values or inspect only channel zero.
            const amplitude = (Math.floor(frame / 100) + 1) / 80 * (frame % 2 ? -0.75 : 0.75);
            for (let channel = 0; channel < 2; channel++) {
                const value = channel ? amplitude : 0;
                const offset = (frame * 2 + channel) * bytes;
                if (codec === 3) {
                    if (bits === 32) data.writeFloatLE(value, offset);
                    else data.writeDoubleLE(value, offset);
                } else if (bits === 8) data[offset] = Math.round(128 + value * 128);
                else data.writeIntLE(Math.round(value * (2 ** (bits - 1))), offset, bytes);
            }
        }
        const peaks = await readWaveform(save(wav({ codec, bits, channels: 2, data })));
        assert.equal(peaks.length, 80);
        assert.equal(peaks[79], 1);
        assert.ok(Math.abs(peaks[39] - 0.5) < 0.02);
        assert.ok(peaks[0] < 0.03);
    });
}

test('extensible WAV and odd-sized metadata are parsed without assuming a 44-byte header', async () => {
    const data = Buffer.alloc(1600);
    data.writeInt16LE(16000, 800);
    const peaks = await readWaveform(save(wav({ extensible: true, data, metadata: [chunk('JUNK', Buffer.alloc(17))] })));
    assert.equal(peaks[40], 1);
    assert.equal(peaks[0], 0);
});

test('large files skip almost all bytes, sample across the timeline, and use less detail as size grows', async (t) => {
    const originalOpen = fsp.open;
    let bytesRead = 0;
    let closed = 0;
    t.mock.method(fsp, 'open', async (...args) => {
        const file = await originalOpen(...args);
        return {
            stat: () => file.stat(),
            read: async (...readArgs) => {
                const result = await file.read(...readArgs);
                bytesRead += result.bytesRead;
                return result;
            },
            close: async () => { closed++; await file.close(); },
        };
    });
    const reads = [];
    for (const sizeMiB of [8, 64, 228]) {
        const totalBytes = sizeMiB * 1024 * 1024;
        const header = wav().subarray(0, 44);
        header.writeUInt32LE(totalBytes - 8, 4);
        header.writeUInt32LE(totalBytes - 44, 40);
        const filePath = save(header);
        fs.truncateSync(filePath, totalBytes);
        const frames = (totalBytes - 44) / 2;
        const tone = Buffer.alloc(128);
        for (let i = 0; i < tone.length; i += 2) tone.writeInt16LE(16000, i);
        const fd = fs.openSync(filePath, 'r+');
        fs.writeSync(fd, tone, 0, tone.length, 44 + Math.floor(frames * 0.75) * 2);
        fs.closeSync(fd);
        bytesRead = 0;
        const peaks = await readWaveform(filePath);
        assert.equal(peaks[60], 1, 'must read a signal three quarters into the recording');
        assert.equal(peaks[0], 0);
        assert.ok(bytesRead <= 256 * 1024, `read ${bytesRead} bytes from ${sizeMiB} MiB`);
        reads.push(bytesRead);
    }
    assert.ok(reads[2] < reads[1] && reads[1] < reads[0]);
    assert.equal(closed, 3);
});

test('silence and recordings shorter than 80 frames produce finite bars', async () => {
    for (const frames of [1, 10, 100]) {
        const peaks = await readWaveform(save(wav({ data: Buffer.alloc(frames * 2) })));
        assert.deepEqual(peaks, new Array(80).fill(0));
    }
});

test('unsupported formats and malformed chunks return no peaks', async () => {
    const badLength = wav(); badLength.writeUInt32LE(0xffffffff, 40);
    const badGuid = wav({ extensible: true }); badGuid[45] = 0xff;
    const invalidAlign = wav(); invalidAlign.writeUInt16LE(0, 32);
    for (const input of [Buffer.from('not audio'), wav({ codec: 6 }), badLength, badGuid, invalidAlign]) {
        assert.equal(await readWaveform(save(input)), null);
    }
});

test('waveform IPC rejects another window or an unreadable path before opening the file', async () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const start = main.indexOf("ipcMain.handle('audio:waveform',");
    const handler = main.slice(start, main.indexOf('\n});', start) + 4);
    let readCalls = 0;
    let callback;
    new Function('ipcMain', 'fromMain', 'canReadPath', 'readWaveform', handler)(
        { handle: (_channel, fn) => { callback = fn; } },
        event => event.main,
        file => file === '/allowed.wav',
        async () => { readCalls++; return [1]; },
    );
    assert.equal(await callback({ main: false }, '/allowed.wav'), null);
    assert.equal(await callback({ main: true }, '/outside.wav'), null);
    assert.equal(readCalls, 0);
    assert.deepEqual(await callback({ main: true }, '/allowed.wav'), [1]);
    assert.equal(readCalls, 1);
});

test('renderer ignores late samples after switching or hiding and preserves playback progress', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    const player = source.slice(source.indexOf('const SPEEDS ='), source.indexOf('\nif (PLAYER_OK) {'));
    const element = () => {
        const classes = new Set();
        return {
            style: {}, children: [],
            set innerHTML(_value) { this.children = []; },
            appendChild(child) { this.children.push(child); },
            classList: {
                add: name => classes.add(name), remove: name => classes.delete(name),
                toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
                contains: name => classes.has(name),
            },
        };
    };
    const pending = new Map();
    const box = {
        PLAYER_OK: true,
        api: { getWaveform: file => new Promise(resolve => pending.set(file, resolve)) },
        document: { createElement: element },
        audioEl: { load() {}, pause() {}, currentTime: 50, duration: 100 },
        audioPlayer: element(), apWaveform: element(), apTime: element(),
        apIconPlay: element(), apIconPause: element(),
    };
    vm.runInNewContext(`${player}\nglobalThis.player = { show: playerShowPath, hide: playerHide, progress: updateWaveformProgress };`, box);
    box.player.show('/first.wav');
    box.player.show('/second.wav');
    pending.get('/first.wav')(new Array(80).fill(1));
    await Promise.resolve();
    assert.equal(box.apWaveform.children[0].style.height, '25%');
    pending.get('/second.wav')(new Array(80).fill(0.5));
    await Promise.resolve();
    assert.equal(box.apWaveform.children[0].style.height, '50%');
    assert.equal(box.apWaveform.children.filter(bar => bar.classList.contains('played')).length, 41);
    box.player.progress(1);
    assert.equal(box.apWaveform.children.filter(bar => bar.classList.contains('played')).length, 80);
    box.player.progress(0);
    assert.equal(box.apWaveform.children.filter(bar => bar.classList.contains('played')).length, 1);
    box.player.show('/third.wav');
    box.player.hide();
    pending.get('/third.wav')(new Array(80).fill(1));
    await Promise.resolve();
    assert.equal(box.apWaveform.children[0].style.height, '25%');
    assert.ok(box.audioPlayer.classList.contains('hidden'));
});
