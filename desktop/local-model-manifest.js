'use strict';

// This is deliberately code, not downloaded metadata. Only this module names
// a model repository, revision, artifact or runner argument.
const LOCAL_MODEL_MANIFEST = Object.freeze([
    Object.freeze({
        id: 'qwen3-1.7b-q8_0', tier: 'Fast', name: 'Qwen3 1.7B Q8_0',
        repository: 'Qwen/Qwen3-1.7B-GGUF', revision: '90862c4b9d2787eaed51d12237eafdfe7c5f6077',
        filename: 'Qwen3-1.7B-Q8_0.gguf', bytes: 1834426016,
        sha256: '061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a',
        format: 'gguf', minRamGb: 8, platforms: ['darwin-arm64'],
        disclosure: 'Fastest option. Quality and language coverage are not benchmarked yet.',
    }),
    Object.freeze({
        id: 'qwen3-4b-q4_k_m', tier: 'Recommended', name: 'Qwen3 4B Q4_K_M',
        repository: 'Qwen/Qwen3-4B-GGUF', revision: 'bc640142c66e1fdd12af0bd68f40445458f3869b',
        filename: 'Qwen3-4B-Q4_K_M.gguf', bytes: 2497280256,
        sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
        format: 'gguf', minRamGb: 16, platforms: ['darwin-arm64'],
        disclosure: 'Recommended balance. Quality and language coverage are not benchmarked yet.',
    }),
    Object.freeze({
        id: 'qwen3-8b-q4_k_m', tier: 'Quality', name: 'Qwen3 8B Q4_K_M',
        repository: 'Qwen/Qwen3-8B-GGUF', revision: '7c41481f57cb95916b40956ab2f0b139b296d974',
        filename: 'Qwen3-8B-Q4_K_M.gguf', bytes: 5027783488,
        sha256: 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785',
        format: 'gguf', minRamGb: 24, platforms: ['darwin-arm64'],
        disclosure: 'Highest-capacity option. Quality and language coverage are not benchmarked yet.',
    }),
]);

const MODEL_FIELDS = new Set(['id', 'tier', 'name', 'repository', 'revision', 'filename', 'bytes', 'sha256', 'format', 'minRamGb', 'platforms', 'disclosure']);
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/;

function validateManifest(entries) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('Local model manifest must be a non-empty array.');
    const ids = new Set();
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') throw new Error('Invalid local model manifest entry.');
        if (Object.keys(entry).some((key) => !MODEL_FIELDS.has(key))) throw new Error('Local model manifest has an unknown field.');
        if (!MODEL_ID_RE.test(entry.id || '') || ids.has(entry.id)) throw new Error('Local model manifest has an invalid model ID.');
        if (!/^[\w.-]+\/[\w.-]+$/.test(entry.repository || '')) throw new Error('Local model manifest has an invalid repository.');
        if (!REVISION_RE.test(entry.revision || '') || !FILENAME_RE.test(entry.filename || '')) throw new Error('Local model manifest has mutable or unsafe artifact coordinates.');
        if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !HASH_RE.test(entry.sha256 || '') || entry.format !== 'gguf') throw new Error('Local model manifest has invalid artifact verification data.');
        if (!Number.isSafeInteger(entry.minRamGb) || entry.minRamGb <= 0 || !Array.isArray(entry.platforms) || entry.platforms.some((p) => p !== 'darwin-arm64')) throw new Error('Local model manifest has invalid platform requirements.');
        ids.add(entry.id);
    }
    return true;
}

function modelById(id) {
    return typeof id === 'string' ? LOCAL_MODEL_MANIFEST.find((entry) => entry.id === id) || null : null;
}

function displayModel(entry) {
    return {
        id: entry.id, tier: entry.tier, name: entry.name, bytes: entry.bytes,
        minRamGb: entry.minRamGb, disclosure: entry.disclosure,
    };
}

validateManifest(LOCAL_MODEL_MANIFEST);

module.exports = { LOCAL_MODEL_MANIFEST, validateManifest, modelById, displayModel };
