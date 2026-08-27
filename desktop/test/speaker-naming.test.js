'use strict';
// node test/speaker-naming.test.js

const assert = require('assert');
const {
    parseBlocks,
    splitTranscript,
    assembleTranscript,
    speakerFromMarker,
    isPlaceholderLabel,
    placeholderSpeakers,
    speakerEvidence,
    participantsFromHeader,
    parseSpeakerNames,
    renameSpeakers,
    renameParticipantsLine,
    displaySpeaker,
} = require('../transcript-enhance');

// Mirrors main.js's PHONETIC_LETTERS (passed in there, so the module has no copy).
const PHONETIC = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];

const HEADER = [
    'Meeting: Status checks',
    'Participants: Gamma, Delta, Beta',
    'Language: ru',
    '',
    '',
].join('\n');

const BODY = [
    '[00:00] Gamma:',
    'Олег, расскажи что по лимитам.',
    '',
    '[00:20] Delta:',
    'Лимиты подняли вчера, Марина уже проверила.',
    '',
    '[00:40] Beta:',
    'Спасибо, Олег. Марина, а по отчётам?',
    '',
    '[01:00] Note:',
    'свериться с легалом',
    '',
    '[01:10] Me:',
    'Я подхвачу отчёты.',
    '',
].join('\n');

const blocks = parseBlocks(BODY);

// ─── marker surgery ─────────────────────────────────────────────────────────
{
    assert.strictEqual(speakerFromMarker('[00:20] Delta:'), 'Delta');
    assert.strictEqual(speakerFromMarker('[1:02:03] S1:'), 'S1');
    assert.strictEqual(speakerFromMarker('not a marker'), '');
    assert.strictEqual(displaySpeaker('Олег', 'Delta'), 'Олег (Delta)');
}

// ─── which labels are placeholders ──────────────────────────────────────────
{
    for (const yes of ['Speaker', 'S1', 'S12', 'Beta', 'Delta', 'Beta 2', '?', 'Me']) {
        assert.ok(isPlaceholderLabel(yes, PHONETIC), `${yes} should be a placeholder`);
    }
    for (const no of ['Олег', 'Anna Petrova', 'Олег (Delta)', 'Валерий (Me)', '']) {
        assert.ok(!isPlaceholderLabel(no, PHONETIC), `${no} should NOT be a placeholder`);
    }
}

// ─── collecting them ────────────────────────────────────────────────────────
{
    const found = placeholderSpeakers(blocks, { noteLabel: 'Note', phonetic: PHONETIC });
    assert.deepStrictEqual(found, ['Gamma', 'Delta', 'Beta', 'Me'], 'distinct, in speaking order');
    assert.ok(!found.includes('Note'), 'notes are not speech');
}

// ─── header participants ────────────────────────────────────────────────────
{
    assert.deepStrictEqual(participantsFromHeader(HEADER), ['Gamma', 'Delta', 'Beta']);
    assert.deepStrictEqual(participantsFromHeader('Meeting: x\n\n'), []);
}

// ─── evidence sampling ──────────────────────────────────────────────────────
{
    assert.ok(speakerEvidence(blocks, 'Note').includes('Олег'), 'carries the spoken text');
    assert.ok(!speakerEvidence(blocks, 'Note').includes('свериться с легалом'), 'notes left out');
    const big = parseBlocks(Array.from({ length: 400 }, (_, i) =>
        `[00:${String(i % 60).padStart(2, '0')}] Beta:\n${'слово '.repeat(40)}\n`).join('\n'));
    const sampled = speakerEvidence(big, 'Note', 2000);
    assert.ok(sampled.length <= 2600, `evidence stays near budget, got ${sampled.length}`);
    assert.ok(sampled.length > 0, 'still returns something');
}

// ─── the model's answer is not trusted ──────────────────────────────────────
const opts = { labels: ['Gamma', 'Delta', 'Beta', 'Me'], body: BODY, participants: [], phonetic: PHONETIC };

{
    const map = parseSpeakerNames('Delta = Олег\nBeta = Марина', opts);
    assert.strictEqual(map.get('Delta'), 'Олег', 'name spoken in the transcript is accepted');
    assert.strictEqual(map.get('Beta'), 'Марина');
    assert.strictEqual(map.size, 2);
}
{
    // Nobody ever says "Сергей" — the model made it up.
    const map = parseSpeakerNames('Delta = Сергей', opts);
    assert.strictEqual(map.size, 0, 'unattested name rejected');
}
{
    const map = parseSpeakerNames('Delta = ?\nBeta = unknown\nGamma = n/a', opts);
    assert.strictEqual(map.size, 0, 'declining to answer is respected');
}
{
    const map = parseSpeakerNames('Delta = Олег\nBeta = Олег', opts);
    assert.strictEqual(map.size, 1, 'one name cannot cover two speakers');
    assert.strictEqual(map.get('Delta'), 'Олег', 'first answer wins');
}
{
    const map = parseSpeakerNames('Delta = Gamma\nBeta = S3', opts);
    assert.strictEqual(map.size, 0, 'a placeholder is not a name');
}
{
    const map = parseSpeakerNames('Zeta = Олег', opts);
    assert.strictEqual(map.size, 0, 'labels we did not ask about are ignored');
}
{
    // "Ан" must not ride in on "Марина"/"Олег" — attestation is word-wise.
    const map = parseSpeakerNames('Delta = Ол', opts);
    assert.strictEqual(map.size, 0, 'substring of a spoken word is not attestation');
}
{
    const listed = { ...opts, participants: ['Anna Petrova'] };
    const map = parseSpeakerNames('Delta = Anna Petrova', listed);
    assert.strictEqual(map.get('Delta'), 'Anna Petrova', 'a listed participant needs no mention');
}
{
    const map = parseSpeakerNames('Delta: Олег', opts);
    assert.strictEqual(map.get('Delta'), 'Олег', 'colon form accepted too');
}
{
    // The shape the prompt actually asks for, and the shape a model dresses it in.
    const map = parseSpeakerNames(
        '- **Delta** → Олег (представился в 00:20)\n* Beta -> Марина — её благодарят', opts);
    assert.strictEqual(map.get('Delta'), 'Олег', 'bullet, emphasis, arrow and evidence all survive');
    assert.strictEqual(map.get('Beta'), 'Марина', 'a dash-separated aside is evidence too');
}
{
    // A model that answers in the display form is answering the same thing.
    const map = parseSpeakerNames('Delta = Олег (Delta)', opts);
    assert.strictEqual(map.get('Delta'), 'Олег', 'display form reduces to the name');
}
{
    // The transcript never says the nominative — nobody calls out "Марина!" in
    // the nominative — so attestation has to see through the declension.
    const inflected = { ...opts, body: '[00:00] Beta:\nПередай Марине отчёт, Олегу скажу сам.' };
    const map = parseSpeakerNames('Beta = Марина\nDelta = Олег', inflected);
    assert.strictEqual(map.get('Beta'), 'Марина', 'declined mention attests the name');
    assert.strictEqual(map.get('Delta'), 'Олег');
}
{
    // A stem must not swallow a longer, unrelated word.
    const marketing = { ...opts, body: '[00:00] Beta:\nПо маркетингу всё готово.' };
    const map = parseSpeakerNames('Beta = Марк', marketing);
    assert.strictEqual(map.size, 0, 'a longer unrelated word is not attestation');
}
{
    const map = parseSpeakerNames('Me = Марина', opts);
    assert.strictEqual(map.get('Me'), 'Марина', 'the user gets a name like anyone else');
}
{
    const map = parseSpeakerNames('```\nDelta = Олег\n```', opts);
    assert.strictEqual(map.get('Delta'), 'Олег', 'fenced reply still parses');
}
{
    const map = parseSpeakerNames('Delta = ' + 'я'.repeat(60), opts);
    assert.strictEqual(map.size, 0, 'absurdly long answer rejected');
}

// ─── applying the map ───────────────────────────────────────────────────────
{
    const map = parseSpeakerNames('Delta = Олег\nBeta = Марина', opts);
    const renamed = renameSpeakers(blocks, map);

    assert.strictEqual(renamed[1].marker, '[00:20] Олег (Delta):', 'name keeps the placeholder');
    assert.strictEqual(renamed[2].marker, '[00:40] Марина (Beta):');
    assert.strictEqual(renamed[0].marker, '[00:00] Gamma:', 'unresolved label untouched');
    assert.strictEqual(renamed[3].marker, '[01:00] Note:', 'note untouched');
    assert.strictEqual(renamed[4].marker, '[01:10] Me:', 'unresolved Me untouched');
    assert.strictEqual(renamed[1].text, blocks[1].text, 'text is not the naming pass\'s business');

    // Running Enhance again must not re-name an already named speaker.
    const again = placeholderSpeakers(renamed, { noteLabel: 'Note', phonetic: PHONETIC });
    assert.deepStrictEqual(again, ['Gamma', 'Me'], 'named speakers are no longer placeholders');

    // The renamed markers must still read back as markers, or the proofreading
    // pass that runs next would see a different set of turns than it renamed.
    const rebuilt = assembleTranscript(HEADER, renamed);
    const reparsed = parseBlocks(splitTranscript(rebuilt).body);
    assert.strictEqual(reparsed.length, blocks.length, 'same turn count after a round trip');
    assert.deepStrictEqual(
        reparsed.map((b) => b.marker), renamed.map((b) => b.marker),
        'renamed markers survive assemble → parse');

    // `Me` keeps its label so the reader can still tell whose microphone it was.
    const withMe = parseSpeakerNames('Me = Олег', opts);
    assert.strictEqual(
        renameSpeakers(blocks, withMe)[4].marker, '[01:10] Олег (Me):', 'named Me keeps the label');

    const head = renameParticipantsLine(HEADER, map);
    assert.ok(head.includes('Participants: Gamma, Олег (Delta), Марина (Beta)'), head);
    assert.ok(head.includes('Meeting: Status checks'), 'other header lines survive');
    assert.strictEqual(renameParticipantsLine(HEADER, new Map()), HEADER, 'empty map is a no-op');
}

console.log('speaker-naming: all checks passed');
