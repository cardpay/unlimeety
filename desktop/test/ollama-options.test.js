'use strict';
// node test/ollama-options.test.js
//
// ollamaOptions() is the only thing standing between a user-set context-size
// override and Ollama silently truncating a large prompt on a small model's
// default window. main.js has no exports, so the function (plus the shared
// parsePositiveInt() helper and MAX_OLLAMA_CONTEXT_TOKENS constant it calls)
// is sliced out of the source and evaluated, same technique as
// sliceMainFunction() in test/record-auto-transcribe.test.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

function sliceConst(name) {
    const re = new RegExp(`\\nconst ${name} = [^;]+;`);
    const m = MAIN.match(re);
    assert.ok(m, `const ${name} not found in main.js — renamed or moved?`);
    return m[0];
}

function sliceFunction(name) {
    const start = MAIN.indexOf(`\nfunction ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in main.js — renamed or moved?`);
    let depth = 0;
    for (let i = MAIN.indexOf('{', start); i < MAIN.length; i++) {
        if (MAIN[i] === '{') depth++;
        else if (MAIN[i] === '}' && --depth === 0) return MAIN.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${name}()`);
}

const src = [
    sliceConst('MAX_OLLAMA_CONTEXT_TOKENS'),
    sliceFunction('parsePositiveInt'),
    sliceFunction('ollamaOptions'),
].join('\n');
new vm.Script(src, { filename: 'slice:ollamaOptions' });
const ollamaOptions = new Function(`${src}\nreturn ollamaOptions;`)();

test('unset contextTokens sends no options at all — unchanged default behavior', () => {
    assert.deepStrictEqual(ollamaOptions({}), {});
    assert.deepStrictEqual(ollamaOptions({ contextTokens: '' }), {});
    assert.deepStrictEqual(ollamaOptions({ contextTokens: undefined }), {});
});

test('a valid positive integer becomes options.num_ctx', () => {
    assert.deepStrictEqual(ollamaOptions({ contextTokens: 16384 }), { options: { num_ctx: 16384 } });
    // Persisted config round-trips through JSON, so a numeric string must work too.
    assert.deepStrictEqual(ollamaOptions({ contextTokens: '8192' }), { options: { num_ctx: 8192 } });
});

test('zero, negative, fractional, and over-the-cap values are all rejected', () => {
    assert.deepStrictEqual(ollamaOptions({ contextTokens: 0 }), {});
    assert.deepStrictEqual(ollamaOptions({ contextTokens: -1 }), {});
    assert.deepStrictEqual(ollamaOptions({ contextTokens: 4096.7 }), {});
    assert.deepStrictEqual(ollamaOptions({ contextTokens: 2_000_001 }), {});
    assert.deepStrictEqual(ollamaOptions({ contextTokens: 'not a number' }), {});
});
