'use strict';

const fs = require('fs');

const MAX_CHUNKS = 128;
const MAX_RIFF_SIZE = 0xffffffff;

function findUnfinalizedData(fd, size) {
    const read = (length, position) => {
        const buffer = Buffer.alloc(length);
        return fs.readSync(fd, buffer, 0, length, position) === length ? buffer : null;
    };
    if (size < 12 || size - 8 > MAX_RIFF_SIZE) return null;
    const riff = read(12, 0);
    if (!riff || riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') return null;

    let blockAlign = 0;
    for (let offset = 12, chunks = 0; offset + 8 <= size && chunks < MAX_CHUNKS; chunks++) {
        const header = read(8, offset);
        if (!header) return null;
        const id = header.toString('ascii', 0, 4);
        const length = header.readUInt32LE(4);
        const body = offset + 8;
        if (id === 'fmt ') {
            if (length < 16) return null;
            const fmt = read(16, body);
            if (!fmt) return null;
            blockAlign = fmt.readUInt16LE(12);
        } else if (id === 'data') {
            if (length !== 0 || !blockAlign) return null;
            const available = size - body;
            const dataBytes = available - (available % blockAlign);
            return dataBytes > 0 ? { sizeOffset: offset + 4, dataBytes } : null;
        }
        offset = body + length + (length % 2);
    }
    return null;
}

function repairUnfinalizedWav(filePath) {
    let fd = fs.openSync(filePath, 'r');
    let found;
    let size;
    try {
        size = fs.fstatSync(fd).size;
        found = findUnfinalizedData(fd, size);
    } finally {
        fs.closeSync(fd);
    }
    if (!found) return false;

    fd = fs.openSync(filePath, 'r+');
    try {
        const field = Buffer.alloc(4);
        field.writeUInt32LE(found.dataBytes, 0);
        fs.writeSync(fd, field, 0, 4, found.sizeOffset);
        field.writeUInt32LE(size - 8, 0);
        fs.writeSync(fd, field, 0, 4, 4);
    } finally {
        fs.closeSync(fd);
    }
    return true;
}

module.exports = { repairUnfinalizedWav };
