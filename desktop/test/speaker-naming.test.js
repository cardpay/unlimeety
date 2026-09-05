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
    speakerInstruction,
    trimMiddle,
    translit,
    SPEAKER_PROMPT,
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

// A turn of about `chars` characters whose every word is unique — including a
// distinct first and last word, so "the head survived" and "the tail survived"
// cannot pass on some other turn's identical filler. A periodic filler
// (`'слово '.repeat(n)`) makes both assertions vacuous.
//
// Minutes wrap at 60 and the hour is one digit: TIMESTAMP matches at most a
// two-digit hour, so a generated `[100:00]` marker never parses and the fixture
// would silently be a fraction of its intended size.
function turnBlock(i, chars) {
    const stamp = `[${Math.floor(i / 3600) % 10}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}`
        + `:${String(i % 60).padStart(2, '0')}]`;
    const tail = `конец${i}`;
    const words = [`начало${i}`];
    let len = words[0].length;
    for (let j = 0; len + tail.length + 12 < chars; j++) {
        words.push(`сл${i}ов${j}`);
        len += words[words.length - 1].length + 1;
    }
    words.push(tail);
    return `${stamp} Beta:\n${words.join(' ')}\n`;
}

{
    assert.ok(speakerEvidence(blocks, 'Note').includes('Олег'), 'carries the spoken text');
    assert.ok(!speakerEvidence(blocks, 'Note').includes('свериться с легалом'), 'notes left out');
    const big = parseBlocks(Array.from({ length: 400 }, (_, i) =>
        `[00:${String(i % 60).padStart(2, '0')}] Beta:\n${'слово '.repeat(40)}\n`).join('\n'));
    const sampled = speakerEvidence(big, 'Note', 2000);
    assert.ok(sampled.length <= 2600, `evidence stays near budget, got ${sampled.length}`);
    assert.ok(sampled.length > 0, 'still returns something');
}

// The shipped default, pinned by behaviour rather than by reading the constant:
// a real 90-minute meeting is 41530 characters of speech, and the whole point of
// this change is that such a body goes to the model whole. Lowering
// DEFAULT_EVIDENCE_CHARS back to 40000 must fail here, or the original bug —
// a stride that dropped the only turn naming someone — comes back unnoticed.
{
    const body = parseBlocks(Array.from({ length: 175 }, (_, i) => turnBlock(i, 255)).join('\n'));
    assert.strictEqual(body.length, 175, 'every generated marker parses as one');
    const size = body.reduce((n, b) => n + b.text.length, 0);
    assert.ok(size > 41530, `fixture is at least the failing transcript's size, got ${size}`);

    const whole = speakerEvidence(body, 'Note');
    for (const b of body) {
        assert.ok(whole.includes(b.text), `turn ${b.marker} went through whole`);
    }
    assert.ok(!whole.includes('[…]'), 'nothing was trimmed at the shipped default');
}

// Past the cap: every turn is still there — a stride's dropped turn is exactly
// how a name said once goes missing — and long turns give up their middles
// while short ones survive whole.
{
    const sizes = Array.from({ length: 200 }, (_, i) => (i % 10 === 0 ? 40 : 2350));
    const body = parseBlocks(sizes.map((n, i) => turnBlock(i, n)).join('\n'));
    const size = body.reduce((n, b) => n + b.text.length, 0);
    assert.ok(size > 400000, `fixture is a marathon, got ${size}`);

    const out = speakerEvidence(body, 'Note');
    assert.ok(out.length <= 120000, `output is inside the cap, got ${out.length}`);
    for (const b of body) {
        assert.ok(out.includes(b.marker), `${b.marker} is present`);
        assert.ok(out.includes(b.text.slice(0, 14)), `${b.marker} keeps its opening`);
        assert.ok(out.includes(b.text.slice(-14)), `${b.marker} keeps its close`);
    }
    const short = body.find((b) => b.text.length < 100);
    assert.ok(out.includes(short.text), 'a short turn is not trimmed to pay for a monologue');
    const long = body.find((b) => b.text.length > 2000);
    assert.ok(!out.includes(long.text), 'a long turn is trimmed');
    assert.ok(out.includes('[…]'), 'and the cut is marked where it happened');
}

// A cut is always marked. An unmarked one is an invisible mid-sentence jump,
// which the model reads as a recognition error and tries to repair.
{
    assert.strictEqual(trimMiddle('короткий', 40), 'короткий', 'nothing to cut');
    assert.strictEqual(trimMiddle('абвгдеёжзийклмноп', 11), 'абв […] ноп');
    assert.strictEqual(trimMiddle('абвгдеёжзийклмноп', 11).length, 11, 'and exactly to the budget');
    for (const max of [0, 1, 5]) {
        assert.strictEqual(trimMiddle('абвгдеёжзийклмноп', max), '',
            `a budget of ${max} leaves no room for a visible cut, so no text`);
    }
}

// A budget too small for the marker lines is the one lossy fallback left. It
// drops turns, but what survives has to be readable: markers filling the budget
// left every turn cut to two letters, so the model was asked to name people
// from nothing and `out.includes('Beta:')` called that a pass.
{
    const body = parseBlocks(Array.from({ length: 300 }, (_, i) => turnBlock(i, 200)).join('\n'));
    const out = speakerEvidence(body, 'Note', 900);
    assert.ok(out.length <= 900, `tiny budget still honoured, got ${out.length}`);
    assert.ok(/начало\d/.test(out), `a turn's opening word survives whole, got: ${out.slice(0, 120)}`);
    assert.ok(/конец\d/.test(out), 'and a closing word too');
    const kept = out.split('\n\n');
    assert.ok(kept.length >= 10, `over several turns, not one, got ${kept.length}`);
    for (const turn of kept) {
        const text = turn.split('\n')[1] || '';
        assert.ok(text.length >= 40, `every kept turn carries a readable stretch, got "${text}"`);
    }

    // Smaller than a single marker line: there is no evidence to send, and one
    // marker over the cap is worse than none.
    assert.strictEqual(speakerEvidence(body, 'Note', 10), '', 'an unusable budget returns nothing');
    assert.strictEqual(speakerEvidence(body, 'Note', 0), '', 'and so does no budget at all');
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

// ─── a surname that exists only in the participant list ─────────────────────
// The calendar fills `Participants:` with email addresses, so a surname is
// often nowhere in the speech: colleagues use given names. Every name and
// address below is invented — the shape is what is under test, not an address
// book. `Зорина` transliterates to `zorina` exactly; `Костяева` lands one edit
// from `kostiaeva`, the я/ia drift a real address book has.
const SPOKEN = [
    '[00:00] Beta:',
    'Полина, покажи пожалуйста экран.',
    '',
    '[00:20] Gamma:',
    'Сейчас, а Мария подключится позже.',
    '',
].join('\n');
const SILENT = '[00:00] Beta:\nдавайте начнём, экран уже виден.\n';
const emails = (...list) => ({
    labels: ['Beta', 'Gamma'], body: SPOKEN, participants: list, phonetic: PHONETIC,
});

{
    const map = parseSpeakerNames('Beta -> Полина Зорина (представилась в 00:00)',
        emails('p.zorina@example.com', 'k.lebedev@example.com'));
    assert.strictEqual(map.get('Beta'), 'Полина Зорина',
        'given name heard, surname read off the one address that matches');
}
{
    // The whole reason the strict reading was chosen: an initial fits dozens of
    // given names, so an address must never carry a name on its own.
    const silent = { ...emails('p.zorina@example.com'), body: SILENT };
    for (const answer of ['Полина Зорина', 'Пётр Зорин', 'Зорина']) {
        assert.strictEqual(parseSpeakerNames(`Beta -> ${answer}`, silent).size, 0,
            `"${answer}": binding attests nothing when no part was spoken`);
    }
}
{
    const map = parseSpeakerNames('Gamma -> Мария Костяева', emails('m.kostiaeva@example.com'));
    assert.strictEqual(map.get('Gamma'), 'Мария Костяева',
        'a single edit of transliteration drift is still the same surname');
}
{
    assert.strictEqual(
        parseSpeakerNames('Beta -> Полина Зорина',
            emails('p.zorina@example.com', 'a.zorina@example.com')).size,
        0, 'two addresses bind — which of the two is in the room is unknown');
}
{
    // The name's two halves belong to two different participants: the surname
    // binds one address while the given name that was heard fits another. No
    // single entry accommodates the name, so nothing is written.
    const split = emails('p.vetrova@example.com', 'k.zorina@example.com');
    assert.strictEqual(parseSpeakerNames('Beta -> Полина Зорина', split).size, 0,
        'a surname from one participant and a given name from another is not a person');
    assert.strictEqual(
        parseSpeakerNames('Beta -> Полина Зорина',
            emails('p.vetrova@example.com', 'p.zorina@example.com')).get('Beta'),
        'Полина Зорина', 'the same answer stands when one address accommodates both parts');

    assert.strictEqual(
        parseSpeakerNames('Beta -> Полина Ветрова',
            emails('p.zorina@example.com', 'k.lebedev@example.com')).size,
        0, 'the unspoken part matches no address at all');
    // A diminutive is not the name, so "Окси" leaves nothing spoken and the
    // surname cannot carry the answer by itself.
    assert.strictEqual(
        parseSpeakerNames('Beta -> Оксана Зорина',
            { ...emails('p.zorina@example.com'), body: '[00:00] Beta:\nОкси, покажи экран.' }).size,
        0, 'a diminutive does not attest the dictionary form');
}
{
    // The old rule dropped sub-two-character parts before checking and then
    // wrote the model's string in full, so `П Зорина` was accepted on the
    // strength of "Зорина" alone.
    const heard = { ...emails('p.zorina@example.com'), body: '[00:00] Gamma:\nЗорина уже прислала.' };
    assert.strictEqual(parseSpeakerNames('Beta -> П Зорина', heard).size, 0,
        'a one-character part binds to nothing, so the whole name is refused');
    assert.strictEqual(parseSpeakerNames('Beta -> Зорина', heard).get('Beta'), 'Зорина',
        'the spoken part alone is still a name');
    // Two characters, one letter: an initial must not bind to the initial in
    // the address either.
    assert.strictEqual(parseSpeakerNames('Beta -> П. Зорина', heard).size, 0,
        'an initial is not a name part that can bind');
    // And the spoken route is no way around it: `И`, `О` and `А` are ordinary
    // Russian words, so a one-letter part is always "spoken" somewhere.
    for (const initial of ['И', 'О', 'А']) {
        assert.strictEqual(
            parseSpeakerNames(`Beta -> ${initial} Зорина`,
                { ...heard, body: `[00:00] Gamma:\n${initial} что дальше? Зорина уже прислала.` }).size,
            0, `"${initial}" is a word, not a name part`);
    }
}
{
    // Attestation is per part, and the older rule is untouched: a name whose
    // every part was spoken needs no participant list at all.
    const heard = { ...emails(), body: '[00:00] Gamma:\nПолина Ветрова обещала прислать.' };
    assert.strictEqual(parseSpeakerNames('Beta -> Полина Ветрова', heard).get('Beta'),
        'Полина Ветрова', 'both parts spoken, no address needed');
}

// ─── transliteration ────────────────────────────────────────────────────────
{
    assert.strictEqual(translit('Зорина'), 'zorina');
    assert.strictEqual(translit('Костяева'), 'kostyaeva', 'я → ya, one edit from an "ia" address');
    assert.strictEqual(translit('Щербаков'), 'shcherbakov');
    assert.strictEqual(translit('Müller'), 'muller', 'diacritics are folded, not dropped');
    assert.strictEqual(translit("O'Brien-Smith"), 'obriensmith', 'separators go, letters stay');
    assert.strictEqual(translit('Zorina'), 'zorina', 'a Latin name passes through');

    // Serbian: the team is in Belgrade, and `Ђорђевић` has to reach the
    // `djordjevic` its address spells.
    assert.strictEqual(translit('Ђорђевић'), 'djordjevic');
    assert.strictEqual(translit('Јањић'), 'janjic');

    // A letter missing from the table survives as Cyrillic and then matches
    // nothing — a colleague silently left nameless. Sweep the alphabets the
    // table claims to cover, so the next gap fails here instead.
    const alphabets = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'      // Russian
        + 'јљњћђџѕќѓ'                                          // Serbian, Macedonian
        + 'іїєґў';                                             // Ukrainian, Belarusian
    for (const ch of alphabets) {
        const out = translit(ch);
        assert.ok(!/\p{Script=Cyrillic}/u.test(out), `${ch} is not transliterated (got "${out}")`);
        assert.ok(!/\p{M}/u.test(out), `${ch} left a combining mark behind`);
    }
    assert.ok(!/\p{Script=Cyrillic}/u.test(translit(alphabets.toUpperCase())),
        'and the same holds for capitals');
}

// ─── the fuzzy budget's edges ───────────────────────────────────────────────
// Every accepting case above sits at zero or one edit and would also pass under
// a far looser budget, so the rejections are what actually pin the constants:
// relaxing them left the whole suite green while `Оксана Зина` bound
// `o.zorina@`.
{
    // One edit, but a different length — and in Russian that trailing letter is
    // the difference between a man and a woman, not a spelling drift.
    assert.strictEqual(
        parseSpeakerNames('Beta -> Пётр Зорин',
            { ...emails('p.zorina@example.com'), body: '[00:00] Gamma:\nПётр, ты готов?' }).size,
        0, 'a masculine surname does not bind a feminine address');

    // Two edits at the same length: outside the budget at any length.
    assert.strictEqual(
        parseSpeakerNames('Beta -> Полина Зорина', emails('p.zolino@example.com')).size,
        0, 'two edits reach a different colleague');
    assert.strictEqual(
        parseSpeakerNames('Beta -> Полина Зорина', emails('p.zolina@example.com')).get('Beta'),
        'Полина Зорина', 'one edit at the same length is the same surname');

    // Below five characters even one substitution covers too much of the
    // language, so a short part has to match outright.
    const zina = { ...emails('p.zena@example.com'), body: '[00:00] Gamma:\nПолина, начинай.' };
    assert.strictEqual(parseSpeakerNames('Beta -> Полина Зина', zina).size, 0,
        'a four-letter part one edit off binds nothing');
    assert.strictEqual(
        parseSpeakerNames('Beta -> Полина Зина',
            { ...zina, participants: ['p.zina@example.com'] }).get('Beta'),
        'Полина Зина', 'the same part matching outright does');
}

// ─── one participant is one person ──────────────────────────────────────────
// The model picks a given name to fit an initial, so two labels can arrive with
// two different names read off the same address. At most one is right.
{
    const two = { ...emails('p.zorina@example.com'), body: '[00:00] Beta:\nПолина, а Пелагея где?' };
    const map = parseSpeakerNames('Beta -> Полина Зорина\nGamma -> Пелагея Зорина', two);
    assert.strictEqual(map.size, 1, 'the second name is dropped, not guessed between');
    assert.strictEqual(map.get('Beta'), 'Полина Зорина', 'first answer wins, as everywhere else');

    // And the header stays honest — the address the name was read off carries
    // that one name (annotated, not discarded), and the label that got
    // nothing keeps its placeholder.
    assert.strictEqual(
        renameParticipantsLine('Participants: p.zorina@example.com, Beta, Gamma\n', map, two.body),
        'Participants: Полина Зорина (Beta) <p.zorina@example.com>, Gamma\n',
        'one address, one name, and the unnamed label untouched');
}

// ─── a header that already spells the name ──────────────────────────────────
// The commonest shape: the calendar supplied real names, so `Participants:` is
// the answer and the body need not mention it at all. The name still gains its
// diarization label, and the person is listed once.
{
    const listed = { labels: ['Beta'], body: BODY, participants: ['Anna Petrova'], phonetic: PHONETIC };
    const map = parseSpeakerNames('Beta -> Anna Petrova', listed);
    assert.strictEqual(map.get('Beta'), 'Anna Petrova', 'a listed participant needs no mention');
    assert.strictEqual(
        renameParticipantsLine('Participants: Anna Petrova, Beta\n', map, BODY),
        'Participants: Anna Petrova (Beta)\n',
        'the entry and the label were one person');
    assert.strictEqual(
        renameParticipantsLine('Participants: Anna Petrova\n', map, BODY),
        'Participants: Anna Petrova (Beta)\n',
        'and the label reaches the header even when only the name was listed');
}

// ─── the naming prompt ──────────────────────────────────────────────────────
{
    assert.strictEqual(speakerInstruction({}), SPEAKER_PROMPT, 'nothing to add → the prompt alone');

    const full = speakerInstruction({
        terms: 'Domain terms:\n- PayCore',
        meetingTitle: 'Status checks',
        participants: ['p.zorina@example.com'],
    });
    assert.ok(full.startsWith(SPEAKER_PROMPT), 'the prompt leads');
    assert.ok(full.includes('\n\nDomain terms:\n- PayCore\n\n'), 'terms keep their own heading');
    assert.ok(full.endsWith('Meeting: Status checks\nParticipants: p.zorina@example.com'),
        'the meeting\'s own facts come last, not a borrowed imperative');

    // An empty glossary must leave no blank block and no stray heading.
    const noTerms = speakerInstruction({ terms: '', meetingTitle: 'Status checks' });
    assert.strictEqual(noTerms, `${SPEAKER_PROMPT}\n\nMeeting: Status checks`);
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

// ─── the header must not list one person twice ───────────────────────────────
// The address a name was read off *is* that person, so it becomes the name
// rather than standing next to it — and where the calendar listed both the
// address and the diarization placeholder, the two collapse into one entry.
{
    const listed = ['p.zorina@example.com', 'k.lebedev@example.com'];
    const map = parseSpeakerNames('Beta -> Полина Зорина', emails(...listed));
    assert.strictEqual(map.size, 1, 'precondition: the name was accepted');

    const withEmails = `Meeting: Sync\nParticipants: ${listed.join(', ')}\nLanguage: ru\n\n`;
    assert.ok(renameParticipantsLine(withEmails, map, SPOKEN).includes(
        'Participants: Полина Зорина (Beta) <p.zorina@example.com>, k.lebedev@example.com'),
        renameParticipantsLine(withEmails, map, SPOKEN));

    const both = `Participants: ${listed[0]}, Beta, ${listed[1]}\n`;
    assert.strictEqual(renameParticipantsLine(both, map, SPOKEN),
        'Participants: Полина Зорина (Beta) <p.zorina@example.com>, k.lebedev@example.com\n',
        'the address and the placeholder were one person all along, and the address is kept, not dropped');

    // Without the body there is no way to know which parts were spoken, so the
    // placeholder rewrite still happens and no address is touched.
    assert.strictEqual(renameParticipantsLine(both, map),
        `Participants: ${listed[0]}, Полина Зорина (Beta), ${listed[1]}\n`,
        'no body → no binding, and nothing is dropped on a guess');

    // A name attested by speech alone leans on no address, so every address the
    // calendar listed survives exactly as written.
    const heard = '[00:00] Gamma:\nПолина Ветрова обещала прислать.';
    const bySpeech = parseSpeakerNames('Beta -> Полина Ветрова',
        { ...emails('k.lebedev@example.com'), body: heard });
    assert.strictEqual(
        renameParticipantsLine('Participants: k.lebedev@example.com, Beta\n', bySpeech, heard),
        'Participants: k.lebedev@example.com, Полина Ветрова (Beta)\n',
        'nothing is dropped on a guess');
}

console.log('speaker-naming: all checks passed');
