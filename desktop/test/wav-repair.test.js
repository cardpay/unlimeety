'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repairUnfinalizedWav } = require('../wav-repair');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wav-repair-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;

function chunk(id, body, declared = body.length) {
    const header = Buffer.alloc(8);
    header.write(id); header.writeUInt32LE(declared, 4);
    return Buffer.concat([header, body]);
}

function fmt() {
    const body = Buffer.alloc(16);
    body.writeUInt16LE(1, 0); body.writeUInt16LE(1, 2); body.writeUInt32LE(16000, 4);
    body.writeUInt32LE(32000, 8); body.writeUInt16LE(2, 12); body.writeUInt16LE(16, 14);
    return chunk('fmt ', body);
}

function wav({ samples, dataDeclared, riffDeclared, before = [] }) {
    const body = Buffer.concat([Buffer.from('WAVE'), ...before, fmt(), chunk('data', samples, dataDeclared)]);
    const header = Buffer.alloc(8); header.write('RIFF');
    header.writeUInt32LE(riffDeclared ?? body.length, 4);
    return Buffer.concat([header, body]);
}

function save(buffer) {
    const file = path.join(root, `${++serial}.wav`);
    fs.writeFileSync(file, buffer);
    return file;
}

function dataSize(buffer) {
    const at = buffer.indexOf('data');
    return buffer.readUInt32LE(at + 4);
}

test('fills in the sizes of a recording that was never finalized', () => {
    const samples = Buffer.alloc(6400, 7);
    const file = save(wav({
        samples, dataDeclared: 0, riffDeclared: 4088,
        before: [chunk('JUNK', Buffer.alloc(28))],
    }));
    assert.equal(repairUnfinalizedWav(file), true);
    const fixed = fs.readFileSync(file);
    assert.equal(fixed.readUInt32LE(4), fixed.length - 8);
    assert.equal(dataSize(fixed), samples.length);
    assert.equal(fixed.subarray(fixed.length - samples.length).equals(samples), true);
});

test('drops a trailing half-written frame from the data size', () => {
    const file = save(wav({ samples: Buffer.alloc(321), dataDeclared: 0, riffDeclared: 36 }));
    assert.equal(repairUnfinalizedWav(file), true);
    assert.equal(dataSize(fs.readFileSync(file)), 320);
});

test('leaves a finalized recording untouched', () => {
    const original = wav({ samples: Buffer.alloc(320, 1) });
    const file = save(original);
    assert.equal(repairUnfinalizedWav(file), false);
    assert.equal(fs.readFileSync(file).equals(original), true);
});

test('leaves an empty or non-WAV file untouched', () => {
    const empty = save(wav({ samples: Buffer.alloc(0), dataDeclared: 0, riffDeclared: 36 }));
    assert.equal(repairUnfinalizedWav(empty), false);
    const other = save(Buffer.from('ID3\u0004 not a wav at all, just some bytes'));
    assert.equal(repairUnfinalizedWav(other), false);
});
