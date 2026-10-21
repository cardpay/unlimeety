'use strict';

const fs = require('fs/promises');

const BARS = 80;
const READ_BUDGET = 256 * 1024;

// Sample uncompressed WAVs directly. Both I/O and CPU stay bounded even for
// multi-hour recordings; unsupported containers/codecs leave the neutral bars.
async function readWaveform(filePath) {
    const file = await fs.open(filePath, 'r');
    try {
        const { size } = await file.stat();
        const read = async (length, position) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await file.read(buffer, 0, length, position);
            if (bytesRead !== length) throw new Error('Truncated WAV');
            return buffer;
        };
        if (size < 12) return null;
        const riff = await read(12, 0);
        if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') return null;

        let format = null;
        let dataOffset = 0;
        let dataBytes = 0;
        // Skip metadata by seeking, including large JUNK/LIST chunks. Bound the
        // number of chunk headers too, so a malformed file cannot create a long job.
        for (let offset = 12, chunks = 0; offset + 8 <= size && chunks < 128; chunks++) {
            const header = await read(8, offset);
            const id = header.toString('ascii', 0, 4);
            const length = header.readUInt32LE(4);
            const body = offset + 8;
            if (body + length > size) return null;
            if (id === 'fmt ') {
                if (length < 16) return null;
                format = await read(Math.min(length, 40), body);
            } else if (id === 'data') {
                dataOffset = body;
                dataBytes = length;
            }
            if (format && dataOffset) break;
            offset = body + length + (length % 2);
        }
        if (!format || !dataBytes) return null;

        let codec = format.readUInt16LE(0);
        const channels = format.readUInt16LE(2);
        const blockAlign = format.readUInt16LE(12);
        const bits = format.readUInt16LE(14);
        if (codec === 0xfffe) {
            // WAVE_FORMAT_EXTENSIBLE: accept only the standard PCM/float GUIDs.
            if (format.length < 40 || format.readUInt16LE(16) < 22
                || format.subarray(26, 40).toString('hex') !== '000000001000800000aa00389b71') return null;
            codec = format.readUInt16LE(24);
        }
        const bytesPerSample = bits / 8;
        if (!channels || channels > 32 || blockAlign !== channels * bytesPerSample) return null;
        if (!(codec === 1 && [8, 16, 24, 32].includes(bits))
            && !(codec === 3 && [32, 64].includes(bits))) return null;
        const frames = Math.floor(dataBytes / blockAlign);
        if (!frames) return null;

        const detail = size > 128 * 1024 * 1024 ? 64 : size > 16 * 1024 * 1024 ? 256 : 512;
        // Reserve space for the bounded header scan within the total I/O budget.
        const maxFrames = Math.min(detail, Math.floor((READ_BUDGET - 8192) / (BARS * 3 * blockAlign)));
        const peaks = [];
        for (let i = 0; i < BARS; i++) {
            const start = Math.floor(i * frames / BARS);
            const end = Math.max(start + 1, Math.floor((i + 1) * frames / BARS));
            const count = Math.min(maxFrames, end - start);
            const windows = count === end - start ? 1 : 3;
            let peak = 0;
            for (let w = 0; w < windows; w++) {
                const frame = start + Math.floor((end - start - count) * w / Math.max(1, windows - 1));
                const samples = await read(count * blockAlign, dataOffset + frame * blockAlign);
                for (let offset = 0; offset < samples.length; offset += bytesPerSample) {
                    let value;
                    if (codec === 3) value = bits === 32 ? samples.readFloatLE(offset) : samples.readDoubleLE(offset);
                    else if (bits === 8) value = (samples[offset] - 128) / 128;
                    else value = samples.readIntLE(offset, bytesPerSample) / (2 ** (bits - 1));
                    if (Number.isFinite(value)) peak = Math.max(peak, Math.min(1, Math.abs(value)));
                }
            }
            peaks.push(peak);
        }
        const max = Math.max(...peaks, 0.01);
        return peaks.map(peak => peak / max);
    } finally {
        await file.close();
    }
}

module.exports = { readWaveform };
