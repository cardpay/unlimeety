'use strict';
// node test/participant-rename.test.js
//
// Enhance's automated speaker naming annotates a Participants: entry it bound
// from an address — "Name (Label) <email>" — rather than discarding the
// address outright (transcript-enhance.js's renameParticipantsLine). Neither
// of the renderer's two consumers of that line wants the annotation verbatim:
// headerParticipants() feeds rename-suggestion chips (offering to rename a
// speaker chip to a string containing someone's email would be both ugly and
// wrong), and renameSpeakerInText()'s manual rename must recognise an
// annotated entry by its display name alone, while keeping the address on it.
//
// renderer/app.js is a classic <script> with no exports, so both functions are
// sliced out by name and evaluated standalone — same technique as
// test/default-filenames.test.js uses for main.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf-8');

function sliceFunction(name) {
    const start = APP.indexOf(`\nfunction ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() not found in renderer/app.js — renamed or moved?`);
    let depth = 0;
    for (let i = APP.indexOf('{', start); i < APP.length; i++) {
        if (APP[i] === '{') depth++;
        else if (APP[i] === '}' && --depth === 0) return APP.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces while slicing ${name}()`);
}

function sliceConst(name) {
    const start = APP.indexOf(`\nconst ${name} = `);
    assert.notStrictEqual(start, -1, `const ${name} not found in renderer/app.js`);
    const end = APP.indexOf(';\n', start);
    return APP.slice(start, end + 1).replace(/^\nconst /, '\nvar ');
}

const src = [
    sliceConst('HEADER_PARTICIPANT_ANNOTATION_RE'),
    sliceFunction('headerParticipants'),
    sliceFunction('renameSpeakerInText'),
].join('\n');
new vm.Script(src, { filename: 'slice:participant-rename' });
const { headerParticipants, renameSpeakerInText } = new Function(
    `${src}\nreturn { headerParticipants, renameSpeakerInText };`,
)();

test('an annotated entry offers only its display name as a rename suggestion', () => {
    const header = 'Meeting: Sync\nParticipants: Полина Зорина (Beta) <p.zorina@example.com>, Gamma\n\n';
    assert.deepStrictEqual(headerParticipants(header), ['Полина Зорина (Beta)', 'Gamma'],
        'the <email> must not reach a suggestion chip');
});

test('a plain (unannotated) entry passes through unchanged', () => {
    const header = 'Meeting: Sync\nParticipants: Gamma, Delta\n\n';
    assert.deepStrictEqual(headerParticipants(header), ['Gamma', 'Delta']);
});

test('manually renaming an annotated speaker keeps the address, changes only the name', () => {
    const content = 'Meeting: Sync\nParticipants: Полина Зорина (Beta) <p.zorina@example.com>, Gamma\n\n'
        + '[00:00] Полина Зорина (Beta):\nHi.\n';
    const renamed = renameSpeakerInText(content, 'Полина Зорина (Beta)', 'Полина (Beta)');
    assert.ok(renamed.includes('Participants: Полина (Beta) <p.zorina@example.com>, Gamma'),
        `address must survive a manual rename: ${renamed}`);
    assert.ok(renamed.includes('[00:00] Полина (Beta):'), 'the marker itself must also rename');
});

test('renaming a plain entry with no annotation is unaffected', () => {
    const content = 'Meeting: Sync\nParticipants: Gamma, Delta\n\n[00:00] Gamma:\nHi.\n';
    const renamed = renameSpeakerInText(content, 'Gamma', 'Anna');
    assert.ok(renamed.includes('Participants: Anna, Delta'));
    assert.ok(renamed.includes('[00:00] Anna:'));
});

console.log('participant-rename: all checks passed');
