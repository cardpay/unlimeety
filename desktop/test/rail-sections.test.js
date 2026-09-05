'use strict';
// node test/rail-sections.test.js
//
// The summary rail draws one layout per preset section. renderer/app.js is a
// classic <script> with no exports, so — like transcript-meta.test.js — this
// reads it off disk and evals the marked region. The region is deliberately free
// of the DOM (`escapeHtml`, `iconSvg` and `avatarHtml` are stubbed here); if it
// grows a real dependency on one, this test is what breaks first.
//
// Two cases carry most of the weight:
//   * every `##` heading printed by every preset in PROMPTS has a RAIL_SECTIONS
//     entry — add a section to a preset without teaching the rail and it fails;
//   * every RAIL_SECTIONS entry actually renders the kind it claims — retag one
//     and it fails. Presence alone is not enough: a "problems" section tagged as
//     a win is exactly the mistake the registry exists to prevent.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { findRegion } = require('./lib/find-region');

const APP = path.join(__dirname, '..', 'renderer', 'app.js');
const src = fs.readFileSync(APP, 'utf-8');

function region(name) {
    const m = findRegion(src, name);
    assert.ok(m, `"${name}" region markers not found in renderer/app.js`);
    return m[0];
}

const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const rail = new Function(
    'escapeHtml', 'iconSvg', 'avatarHtml',
    `${region('rail sections')}
     return { railSlug, RAIL_SECTIONS, RAIL_TONES, shouldRenderStructured, parseStructured,
              buildStructuredHtml, renderRailSection, renderMarkdown, parseMapRow,
              splitDue, parsePeople, parseActionItems };`,
)(
    escapeHtml,
    (name) => `<svg data-icon="${name}"></svg>`,
    (name) => `<span class="avatar">${escapeHtml(name)}</span>`,
);

const {
    railSlug, RAIL_SECTIONS, RAIL_TONES, shouldRenderStructured, parseStructured,
    buildStructuredHtml, renderRailSection, renderMarkdown, parseMapRow, splitDue,
    parsePeople, parseActionItems,
} = rail;

// Render a whole summary the way renderSummaryRail does.
function render(md) {
    const parsed = parseStructured(md);
    assert.ok(!parsed.fallback, 'expected structured parse');
    return buildStructuredHtml(parsed);
}

// Render exactly one section, so an assertion cannot be satisfied by markup
// that belongs to a different section of the same document.
function section(heading, body, slug) {
    return renderRailSection({ slug: slug || railSlug(heading), heading, lines: body.split('\n') });
}

// The order the labels come out in, for the pinned-order contract.
function labels(html) {
    return [...html.matchAll(/rail-section-label">([^<]*)/g)].map((m) => m[1].trim());
}

// ─── Every preset section is known to the rail ───────────────────────────────
{
    const start = src.indexOf('const PROMPTS = [');
    const end = src.indexOf('\nconst DEFAULT_PROMPT');
    assert.ok(start > 0 && end > start, 'PROMPTS block not found');
    const headings = [...new Set(
        [...src.slice(start, end).matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()),
    )];
    // An exact count, not a floor: deleting preset sections must be noticed too.
    assert.strictEqual(headings.length, 40, `preset heading count changed: ${headings.length}`);

    const missing = headings.filter((h) => !RAIL_SECTIONS[railSlug(h)]);
    assert.deepStrictEqual(missing, [], `preset headings with no RAIL_SECTIONS entry: ${missing}`);

    // The slugger strips digits and punctuation — the three that surprise people.
    assert.strictEqual(railSlug('For next 1-1'), 'for_next');
    assert.strictEqual(railSlug('TL;DR'), 'tl_dr');
    assert.strictEqual(railSlug("What didn't go well"), 'what_didn_t_go_well');
}

// ─── Every registry entry renders the kind it claims ────────────────────────
{
    // Spelled out here on purpose. Reading the kind back out of RAIL_SECTIONS and
    // then asserting it renders that kind is a tautology — retagging a section
    // would move both sides together. This table is the second opinion: a
    // "problems" section quietly retagged as a win fails by name.
    const EXPECTED = {
        summary: 'plain', tl_dr: 'plain', notes: 'plain', brief: 'plain',
        hardest_problem_solved: 'plain', career_growth: 'plain', mood_well_being: 'plain',
        scorecard: 'plain',

        speaker_mapping: 'map', root_causes: 'map',
        action_items: 'actions', milestones_timeline: 'dated',
        status: 'status', participants: 'people', recommendation: 'recommendation',

        decisions: 'good', agreed_terms: 'good', progress: 'good',
        what_went_well: 'good', strong_answers: 'good', strengths: 'good',

        risks: 'bad', red_flags: 'bad', what_didn_t_go_well: 'bad',
        weak_concerning_answers: 'bad', weaknesses_risks: 'bad',

        blockers_dependencies: 'warn', open_unresolved_points: 'warn', scope_changes: 'warn',

        experiments_to_try: 'idea', for_next: 'idea',
        open_questions_for_follow_up: 'idea', concessions_movement: 'idea',

        topics: 'neutral', discussion: 'neutral', feedback: 'neutral', motivation: 'neutral',
        candidate_preferences: 'neutral', parties_positions: 'neutral', asks_offers: 'neutral',
        leverage_batna_notes: 'neutral',
    };
    // Spread, because RAIL_SECTIONS has a null prototype on purpose.
    assert.deepStrictEqual({ ...RAIL_SECTIONS }, EXPECTED);

    // And the dispatch actually reaches each renderer: one fixture per kind, and
    // the markup only that kind produces from it.
    const FIXTURES = {
        good:    ['- one', 'rail-bullet--good'],
        bad:     ['- one', 'rail-bullet--bad'],
        warn:    ['- one', 'rail-bullet--warn'],
        idea:    ['- one', 'rail-bullet--idea'],
        neutral: ['- one', 'rail-bullet--neutral'],
        actions: ['- [ ] **Anna** — do it — *Thu*', 'rail-action"'],
        map:     ['- Alpha → Anna', 'rail-map-arrow'],
        dated:   ['- Beta cut — *Jun 30*', 'rail-due-pill'],
        status:  ['At risk — vendor slipped', 'status-at-risk'],
        people:  ['### Anna\n- **Done:** x', 'rail-person"'],
        recommendation: ['Hire — solid', 'verdict-hire'],
        // Prose sections get a bullet on purpose: a mistagged prose slug would
        // then grow a tone bullet, and the absence check below catches it.
        plain:   ['- one', 'rail-md'],
    };
    for (const [slug, kind] of Object.entries(EXPECTED)) {
        const [body, marker] = FIXTURES[kind];
        const html = section('X', body, slug);
        assert.ok(html.includes(marker), `${slug} is tagged "${kind}" but did not render ${marker}`);
        if (kind === 'plain') {
            assert.ok(!html.includes('rail-bullet'), `${slug} is tagged plain but grew a bullet`);
        } else if (RAIL_TONES.includes(kind)) {
            for (const other of RAIL_TONES.filter((t) => t !== kind)) {
                assert.ok(!html.includes(`rail-bullet--${other}`), `${slug}: also rendered ${other}`);
            }
        }
    }
}

// ─── Bullet syntax the models actually emit ─────────────────────────────────
{
    // "-", "*", "1." and indentation all mean the same thing.
    for (const bullet of ['- Deploys got faster', '* Deploys got faster',
                          '1. Deploys got faster', '  - Deploys got faster']) {
        const html = section('What went well', bullet);
        assert.ok(html.includes('rail-bullet--good'), `bullet form not recognised: ${bullet}`);
        assert.ok(html.includes('Deploys got faster'));
    }
    assert.match(renderMarkdown('1. first\n2. second'), /<ul><li>first<\/li><li>second<\/li><\/ul>/);

    // Action items are parsed from the same shapes, and a section whose bullets
    // do not parse at all falls back to prose instead of vanishing.
    assert.strictEqual(parseActionItems(['* [ ] **Anna** — chase it — *Thu*'])[0].who, 'Anna');
    const noBullets = section('Action Items', 'None identified.');
    assert.ok(noBullets.includes('None identified.'), 'an unparsed Action Items section was dropped');
    assert.ok(noBullets.includes('rail-section-label'), 'the section kept its label');
}

// ─── Tone bullets, and the prose around them ───────────────────────────────
{
    const html = section('What went well', '- Deploys got faster');
    assert.match(html, /data-icon="check"/, 'the good tone is the check glyph');
    assert.match(html, /rail-section-count">1</, 'the section is counted');

    const bad = section("What didn't go well", '- Staging drifted\n- Alerts too noisy');
    assert.match(bad, /rail-section-count">2</);

    // No preset asks for nesting, but a model can still indent a sub-point.
    // partitionBullets flattens it into its own <li> (a real nested <ul> is a
    // bigger change) — but the badge must count it as part of its parent, not
    // inflate to "2" for what reads as one item.
    const nested = section('Strengths', '- Roadmap\n  - Q3 slip');
    assert.match(nested, /rail-section-count">1</,
        'an indented sub-bullet must not inflate the section count badge');
    assert.strictEqual((nested.match(/<li>/g) || []).length, 2,
        'both lines still render as their own row — only the badge changed');

    // A lead-in sentence stays above the list; a closing note stays below it.
    const mixed = section('Strengths', 'Overall strong.\n\n- Ships fast\n\nWorth a second look.');
    const iList = mixed.indexOf('<ul');
    assert.ok(mixed.indexOf('Overall strong.') < iList, 'lead-in prose belongs above the list');
    assert.ok(mixed.indexOf('Worth a second look.') > iList, 'closing prose belongs below the list');

    // No bullets at all: plain markdown rather than an empty list.
    const prose = section('Strengths', 'Nothing itemised, just a paragraph.');
    assert.ok(!prose.includes('rail-list'));
    assert.match(prose, /rail-md/);
}

// ─── Mapping rows ───────────────────────────────────────────────────────────
{
    assert.deepStrictEqual(
        parseMapRow('Alpha → Anna (introduced at 00:02)'),
        { from: 'Alpha', to: 'Anna', note: 'introduced at 00:02' },
    );
    assert.deepStrictEqual(
        parseMapRow('slow deploys -> CI runs the full suite'),
        { from: 'slow deploys', to: 'CI runs the full suite', note: null },
    );
    assert.strictEqual(parseMapRow('no arrow here'), null);
    // Half a mapping is not a mapping — an empty cell reads as a rendering bug.
    assert.strictEqual(parseMapRow('Alpha →'), null);
    assert.strictEqual(parseMapRow('→ Anna'), null);

    const html = section('Speaker Mapping', '- Alpha → Anna (introduced at 00:02)');
    assert.match(html, /rail-map-from">Alpha</);
    assert.match(html, /rail-map-to">Anna</);
    assert.match(html, /rail-map-note">introduced at 00:02</);

    // Arrowless rows sit in the same list with no glyph, so it reads straight.
    const roots = section('Root causes', '- Alerts too noisy → nobody reads them\n- Unclear ownership');
    assert.match(roots, /rail-map-to">nobody reads them</);
    assert.ok(roots.includes('Unclear ownership'));
    assert.ok(!roots.includes('rail-bullet'), 'a map list mixes marked and unmarked rows');
}

// ─── Dated rows ─────────────────────────────────────────────────────────────
{
    assert.deepStrictEqual(splitDue('Beta cut — *Jun 30*'), { text: 'Beta cut', due: 'Jun 30' });
    assert.deepStrictEqual(splitDue('Beta cut'), { text: 'Beta cut', due: null });

    const html = section('Milestones & timeline', '- Beta cut — *Jun 30*\n- GA still unscheduled');
    assert.match(html, /rail-due-pill">Jun 30</);
    assert.ok(html.includes('GA still unscheduled'));
    assert.strictEqual((html.match(/rail-due-pill/g) || []).length, 1, 'no pill without a date');
}

// ─── Chips: status and recommendation ──────────────────────────────────────
{
    const risk = section('Status', 'At risk — the vendor slipped a week.');
    assert.match(risk, /rail-verdict status-at-risk">At risk</);
    assert.ok(risk.includes('the vendor slipped a week'));
    assert.ok(!/At risk[^<]*—/.test(risk), 'the chip word is repeated in the prose');

    assert.match(section('Status', 'On track.'), /status-on-track/);
    assert.match(section('Status', 'Blocked on the migration'), /status-blocked/);
    // A chip with nothing left to say must not leave a paragraph holding "."
    assert.ok(!section('Status', 'On track.').includes('rail-rec-body'));

    // The prefix has to end where the word ends.
    const tracked = section('Status', 'On tracked to slip by a week.');
    assert.ok(!tracked.includes('rail-verdict'), '"On tracked" is prose, not a chip');
    assert.ok(tracked.includes('On tracked to slip'), 'and the sentence survives whole');

    // Russian is the common case for these presets; a miss stays prose.
    assert.match(section('Status', 'Под угрозой — вендор не подписал.'), /status-at-risk/);
    assert.match(section('Status', 'В графике'), /status-on-track/);
    assert.ok(!section('Status', 'Трудно сказать').includes('rail-verdict'));

    // Recommendation: the longest verdict wins, and the label is not repeated.
    assert.match(section('Recommendation', 'Hire — strong on systems.'), /verdict-hire">Hire</);
    assert.match(section('Recommendation', 'Strong hire — best this quarter.'), /verdict-hire-strong/);
    assert.match(section('Recommendation', 'No hire — no evidence of ownership.'), /verdict-no-hire/);
    const hiring = section('Recommendation', 'Hiring manager wants another loop.');
    assert.ok(!hiring.includes('rail-verdict'), '"Hiring manager" is not a Hire verdict');
    assert.ok(hiring.includes('Hiring manager wants another loop.'));
}

// ─── Person cards ───────────────────────────────────────────────────────────
{
    const body = [
        '### Alpha (Anna)',
        '- **Done:** shipped the importer',
        '- **Plans:** start on exports',
        '',
        '### Beta (Oleg)',
        '- **Done:** review backlog',
    ].join('\n');
    const people = parsePeople(body.split('\n'));
    assert.strictEqual(people.people.length, 2);
    assert.strictEqual(people.people[0].name, 'Alpha (Anna)');

    const html = section('Participants', body);
    assert.strictEqual((html.match(/rail-person"/g) || []).length, 2, 'one card per person');
    assert.ok(html.includes('shipped the importer'));
    assert.match(html, /rail-section-count">2</);

    // No ### at all: plain markdown, not two-and-a-half empty cards.
    assert.ok(!section('Participants', 'Anna and Oleg.').includes('rail-person'));
}

// ─── Tables ─────────────────────────────────────────────────────────────────
{
    const scorecard = [
        'Only two criteria came up.',
        '',
        '| Criterion | Rating | Evidence |',
        '|---|---|---|',
        '| Smart | Strong | traced the bug live |',
        '| Gets things done | Not assessed | never came up |',
        '',
        'Evidence was thin throughout.',
    ].join('\n');
    const html = section('Scorecard', scorecard);
    assert.match(html, /<table class="rail-table">/);
    assert.match(html, /sc-rating sc-strong">Strong</);
    assert.match(html, /sc-rating sc-na">Not assessed</);
    // The prose on either side of the table is part of the section.
    assert.ok(html.includes('Only two criteria came up.'), 'lead-in prose dropped');
    assert.ok(html.includes('Evidence was thin throughout.'), 'trailing prose dropped');
    // A 360px rail cannot clip columns out of reach.
    assert.match(html, /rail-table-wrap/);

    // The tint follows the column named Rating, not the second column.
    const reordered = renderMarkdown('| Rating | Criterion |\n|---|---|\n| Weak | Smart |');
    assert.match(reordered, /sc-rating sc-weak">Weak</);
    assert.ok(!/sc-rating[^>]*>Smart/.test(reordered), 'the wrong column was tinted');
    // No Rating column: no tint at all.
    assert.ok(!renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |').includes('sc-rating'));

    // Indented tables are tables; a pipe block that parses to nothing is text.
    assert.match(renderMarkdown('  | a |\n  |---|\n  | 1 |'), /<table class="rail-table">/);
    assert.ok(renderMarkdown('|---|').includes('|---|'), 'a stray separator line was dropped');
}

// ─── The pinned display order is a contract ────────────────────────────────
{
    // Status, Summary and Action Items float up even when the model emits them
    // last; everything else keeps source order.
    const md = [
        '## Progress', '', '- Importer merged', '',
        '## Notes', '', 'Nothing else.', '',
        '## Status', '', 'On track — fine', '',
        '## Summary', '', 'Words.', '',
    ].join('\n');
    assert.deepStrictEqual(labels(render(md)), ['Summary', 'Status', 'Progress', 'Notes']);
}

// ─── A preset that skipped Decisions and Action Items is still structured ────
{
    const retro = [
        '---', 'type:', '  - retro', '---', '',
        '## Summary', '', 'Quiet cycle, two process gripes.', '',
        '## What went well', '', '- Release train held', '',
        "## What didn't go well", '', '- Staging drifted from prod', '',
        '## Root causes', '', '- Staging drifted from prod → nobody owns the reset job', '',
        '## Experiments to try', '', '- Nightly staging reset — *next sprint*', '',
    ].join('\n');
    assert.strictEqual(shouldRenderStructured(retro), true, 'recognised on its retro sections alone');
    const html = render(retro);
    assert.deepStrictEqual(labels(html),
        ['Summary', 'What went well', "What didn't go well", 'Root causes', 'Experiments to try']);
    assert.match(html, /rail-bullet--good/);
    assert.match(html, /rail-bullet--bad/);
    assert.match(html, /rail-map-to">nobody owns the reset job</);
    assert.match(html, /rail-bullet--idea/);
    // The YAML frontmatter never reaches the rail as text.
    assert.ok(!html.includes('type:'));
}

// ─── Project and Negotiations render every section they emit ────────────────
{
    const project = [
        '## Status', '', 'Blocked — the vendor has not signed.', '',
        '## Progress', '', '- Importer merged', '',
        '## Risks', '', '- Vendor may walk', '',
        '## Blockers & dependencies', '', '- Vendor signature', '',
        '## Scope changes', '', '- Dropped the CSV path', '',
        '## Milestones & timeline', '', '- Beta cut — *Jun 30*', '',
        '## Action Items', '', '- [ ] **Anna** — chase the vendor — *Thu*', '',
    ].join('\n');
    const html = render(project);
    assert.strictEqual(labels(html).length, 7, 'a Project section fell out of the rail');
    assert.match(html, /status-blocked/);
    assert.match(html, /rail-action-who[\s\S]*Anna/);

    const nego = [
        '## Parties & positions', '', '- **Us:** wants a two-year term', '',
        '## Asks & offers', '', '- They offered a 5% discount', '',
        '## Concessions / movement', '', '- They moved off the audit clause', '',
        '## Agreed terms', '', '- Two-year term', '',
        '## Open / unresolved points', '', '- Liability cap', '',
        '## Leverage & BATNA notes', '', '- We have a second bidder', '',
    ].join('\n');
    assert.strictEqual(labels(render(nego)).length, 6, 'a Negotiations section fell out of the rail');
}

// ─── Custom prompts and freeform output are untouched ───────────────────────
{
    // A heading no preset uses still gets a labelled plain-markdown section.
    const custom = render('## Summary\n\nShort.\n\n## Ветеринария\n\n- Осмотр кота\n');
    assert.match(custom, /rail-section-label">Ветеринария/);
    assert.ok(!custom.includes('rail-bullet'), 'unknown headings get no tone');

    // Nothing recognisable: the rail keeps its Markdown path.
    assert.strictEqual(shouldRenderStructured('## Ветеринария\n\n- Осмотр кота\n'), false);
    assert.strictEqual(shouldRenderStructured('Just some prose about a call.'), false);
    assert.strictEqual(parseStructured('Just some prose about a call.').fallback, true);

    // The registry must not answer for keys it inherited from Object.prototype.
    assert.strictEqual(shouldRenderStructured('## Constructor\n\n- nope\n'), false);
    assert.ok(section('Constructor', '- nope').includes('rail-md'), 'inherited kind reached the dispatch');

    // The gate and the parser agree on what separates ## from its text.
    assert.strictEqual(shouldRenderStructured('##\u00a0Summary\n\nHere.\n'), true);

    // Every section empty renders nothing, so the caller can fall back.
    assert.strictEqual(render('## Summary\n\n## Notes\n'), '');

    // A heading is the one place raw model text becomes a label.
    assert.match(section('A <b>bold</b> heading', 'x'), /rail-section-label">A &lt;b&gt;bold&lt;\/b&gt; heading/);
}

// ─── renderMarkdown's tables also reach the PDF export ─────────────────────
{
    // buildExportHtml writes a self-contained document that does not load
    // style.css, so the table rules have to live in its own inline stylesheet.
    const exp = src.slice(src.indexOf('function buildExportHtml'));
    const body = exp.slice(0, exp.indexOf('\n}\n'));
    assert.ok(/table\s*\{[^}]*border-collapse/.test(body), 'the export stylesheet has no table rule');
    assert.ok(/\bth\s*\{/.test(body) && /\btd\s*\{/.test(body), 'the export stylesheet has no th/td rules');
}

console.log('rail-sections: ok');
