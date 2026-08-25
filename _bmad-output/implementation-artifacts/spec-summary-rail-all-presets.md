---
title: 'Summary rail renders every built-in preset, not just three'
type: 'feature'
created: '2026-08-25'
status: 'done'
baseline_commit: '20ffa56bacb2f40bd77642fc1e55568ec194d6c6'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The right-hand summary rail has bespoke rendering for only six section slugs
(`decisions`, `action_items`, `risks`, `scorecard`, `recommendation`, `brief`). The seven built-in
presets emit ~35 distinct `##` sections between them, so Retro, Project, Negotiations and most of
1-1 / Interview / Daily fall through to flat grey markdown — and a summary that legitimately skipped
every gate heading is not treated as structured at all.

**Approach:** Replace the if/else chain in `buildStructuredHtml` with one data table mapping every
preset heading slug to a small set of reusable render primitives (tone-coded bullet list, mapping
row, dated row, status chip, person card, table, action cards, plain markdown). Derive the
"is this structured?" gate from that same table so the two can never drift apart.

## Boundaries & Constraints

**Always:**
- Reuse the existing rail visual language — `.rail-section`, `.rail-section-label`,
  `.rail-section-count`, `.rail-list`, `.rail-action`, `.rail-due-pill`, `.rail-verdict`. New CSS is
  modifier classes on those, never a parallel system.
- Colour only through design tokens (`--saved`, `--danger`, `--dirty`, `--accent`, `--text-*`,
  `--bg-*`) so `theme-light.css` follows by token remap with no point-fix.
- An unrecognised heading keeps rendering as a labelled plain-markdown section (today's
  `renderPlainSection`), so custom prompts and pre-existing summaries are unaffected.
- Every new parser is pure and lives inside `// ── rail sections ──` … `// ── end rail sections ──`
  markers so `desktop/test/` can eval it, following `transcript-meta.test.js`.

**Ask First:**
- Reordering sections. The current pinned-first order (`RAIL_ORDER`) is deliberate and stays as is;
  only newly recognised slugs may be added to it.
- Any change to `PROMPTS` text. The presets are the contract; this work reads them, never edits them.

**Never:**
- No Russian heading aliases. The presets print the structure literally in English and only the prose
  is translated; a translated `##` heading degrades to the plain-markdown fallback, which is
  acceptable. Add aliases only if that is ever observed in the wild.
- No markdown-library dependency. `renderMarkdown` stays the hand-rolled ~40-line renderer.
- Do not touch `desktop/app.js` — a stale untracked copy of `renderer/app.js`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Tone bullets | `## What went well` + `- Deploys got faster` | `.rail-list` row with a green check bullet and a count of 1 | Non-`- ` lines fall back to plain markdown for that section |
| Mapping row | `## Speaker Mapping` + `- Alpha → Anna (introduced at 00:02)` | Row: `Alpha` → `Anna`, evidence muted | No `→` present: rendered as a neutral bullet |
| Dated row | `## Milestones & timeline` + `- Beta cut — *Jun 30*` | Row text plus a `.rail-due-pill` reading `Jun 30` | No `*…*` tail: plain row, no pill |
| Status chip | `## Status` + `At risk — vendor slipped` | Amber `.rail-verdict` chip `At risk`, remainder as prose | Unknown wording: whole line as prose, no chip |
| Person card | `## Participants` + `### Anna` + `- **Done:** shipped X` | One card per `###`, labelled lines inside | `###`-less content: plain markdown |
| Skipped sections | Retro output with no Decisions and no Action Items | Still renders structured, because `## What went well` is a recognised slug | — |
| Unknown heading | `## Ветеринария` from a custom prompt | Labelled plain-markdown section, exactly as today | — |
| No `##` at all | Freeform prose summary | `parseStructured` reports fallback; rail keeps the "Markdown" chip path | — |

</frozen-after-approval>

## Code Map

- `desktop/renderer/app.js:116-673` — `PROMPTS`, the 7 presets. 40 distinct `##` headings between
  them; the source of truth for what the registry must cover. Read-only for this work.
- `desktop/renderer/app.js:2110-2646` — the `// ── rail sections ──` region: `railSlug`,
  `RAIL_SECTIONS`, `shouldRenderStructured`, `parseStructured`, `renderMarkdown`, every section
  renderer, `buildStructuredHtml` and `renderRailSection`. Pure string work, DOM-free so
  `desktop/test/rail-sections.test.js` can eval it with stubs for `escapeHtml` / `iconSvg` /
  `avatarHtml`.
- `desktop/renderer/app.js:2161` — `shouldRenderStructured`, now a registry lookup over the `##`
  headings rather than a hardcoded seven-name regex.
- `desktop/renderer/app.js:2190` — `parseStructured`; slugs through the shared `railSlug`, which
  strips digits: `For next 1-1` → `for_next`, `TL;DR` → `tl_dr`.
- `desktop/renderer/app.js:2231` — `renderMarkdown`; gained pipe tables and `*` / `1.` bullets.
  Also feeds `buildExportHtml`, whose inline stylesheet had to learn table rules.
- `desktop/renderer/app.js:2628` — `renderRailSection`, the single dispatch point.
- `desktop/renderer/style.css:1303-1593` — all `.rail-*` structured styles.
- `desktop/renderer/theme-light.css:25-66` — token remap; token-only colours need no point-fix.
- `desktop/renderer/app.js:3752` — `renderModalSection`, the post-generation result modal's own
  two-branch renderer. Deliberately left alone: the spec scopes this work to the rail. Recorded in
  `deferred-work.md`.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/renderer/app.js` — add a `RAIL_SECTIONS` table (slug → kind) covering every heading of
  all 7 presets, inside marker comments, plus the primitives it needs: tone bullet list, mapping
  rows, dated rows, chip, person cards. Rationale: one data table beats 35 branches and cannot drift
  from the gate.
- [x] `desktop/renderer/app.js` — rewrite `shouldRenderStructured` to return true when any `##`
  heading slugs into a `RAIL_SECTIONS` key, and `buildStructuredHtml` to dispatch through the table
  with `renderPlainSection` as the default. `RAIL_ORDER` gains `status` and nothing else.
- [x] `desktop/renderer/app.js` — teach `renderMarkdown` pipe tables. Amended during review:
  `renderTableSection` was deleted rather than generalised, and the tint keys off the column named
  `Rating`, so `scorecard` is a plain section whose table `renderMarkdown` draws — which also keeps
  the prose around the table.
- [x] `desktop/renderer/style.css` — add `.rail-bullet--good/--bad/--warn/--neutral/--idea`,
  `.rail-map-*`, `.rail-person`, `.rail-verdict.status-*`, `.rail-table`; token colours only.
- [x] `desktop/test/rail-sections.test.js` — eval the marked region and assert the I/O matrix rows,
  an independent expected slug→kind table, the pinned order, and full Retro / Project / Negotiations
  summaries end to end.

**Acceptance Criteria:**
- Given a summary from any of the 7 presets, when it is opened in the rail, then no section renders
  as an unlabelled grey markdown blob, and every section carries the rail's section label styling.
- Given a Retro summary whose Decisions and Action Items sections were both skipped, when it is
  opened, then the rail still renders structured rather than falling back to Markdown mode.
- Given a summary from a user's custom prompt with headings none of the presets use, when it is
  opened, then it renders exactly as it does today.
- Given light theme is active, when any new section type is shown, then its colours resolve through
  tokens with no hardcoded dark-only literal.

## Spec Change Log

- **Trigger:** the review found `renderTableSection` near-redundant once `renderMarkdown` drew pipe
  tables, and its `parseTableRows` silently dropped every non-`|` line of the section.
  **Amended:** the Execution task now deletes `renderTableSection`, keys the rating tint off the
  column named `Rating`, and tags `scorecard` as a plain section.
  **Known-bad state avoided:** a Scorecard whose lead-in and closing sentences vanish, plus a tint
  hardwired to the second column that mis-colours if the preset reorders it.
  **KEEP:** the registry table and the single `renderRailSection` dispatch; the marker-region test
  harness; the plain-markdown default for unknown slugs.
- **Trigger:** the registry-coverage test proved only that a slug had *an* entry, so 21 of 41
  entries could be retagged with the suite still green.
  **Amended:** the test task now requires an independent expected slug→kind table in the test,
  compared with `deepStrictEqual`, plus a per-kind render fixture.
  **Known-bad state avoided:** a tautological test that moves with the code it is meant to pin.
  **KEEP:** the preset-heading coverage assertion, which is what catches a *new* preset section.

## Design Notes

The gate widened more than "unrecognised custom prompts keep working" implies: a custom prompt that
emits `## Summary` or `## Notes` used to fail the seven-heading regex and render flat, and now
renders structured. That is the better outcome for those summaries, but it is a presentation change
for already-saved ones, not a no-op.

Heading matching is English-only by design (see Boundaries). Chip *values* are not headings, so
`Status` also matches a small guessed set of Russian phrasings — a miss costs nothing, the section
simply stays prose.

## Verification

**Commands:**
- `cd desktop && npm test` — expected: all suites pass, including the new `rail-sections` file.
- `cd desktop && node --check renderer/app.js` — expected: no syntax error.

**Manual checks (if no CLI):**
- `cd desktop && npm start`, open one saved summary per preset, and confirm each section against the
  I/O matrix in both themes.

## Suggested Review Order

**The registry, and what it replaced**

- Start here: one table maps all 40 preset headings to a render kind.
  [`app.js:2131`](../../desktop/renderer/app.js#L2131)

- The gate is now derived from that table, so the two cannot drift apart.
  [`app.js:2161`](../../desktop/renderer/app.js#L2161)

- The single dispatch point; an unknown slug falls to plain markdown.
  [`app.js:2628`](../../desktop/renderer/app.js#L2628)

- Pinned order gained `status` and nothing else.
  [`app.js:2611`](../../desktop/renderer/app.js#L2611)

**Shared primitives, where the content-loss risk lives**

- One bullet shape for the module: `-`, `*`, `1.`, indented or not.
  [`app.js:2322`](../../desktop/renderer/app.js#L2322)

- Splits bullets from prose and keeps each side in place — nothing dropped.
  [`app.js:2327`](../../desktop/renderer/app.js#L2327)

- Action items reuse that split, so `*` and `1.` no longer erase the section.
  [`app.js:2354`](../../desktop/renderer/app.js#L2354)

- Chips match a whole word; "On tracked to slip" stays prose.
  [`app.js:2449`](../../desktop/renderer/app.js#L2449)

- The rating tint follows the column named `Rating`, not the second column.
  [`app.js:2532`](../../desktop/renderer/app.js#L2532)

- Half a mapping is not a mapping — no empty cells, no phantom rows.
  [`app.js:2426`](../../desktop/renderer/app.js#L2426)

**Styling, both themes**

- One fixed glyph box per tone, so text indent never shifts between sections.
  [`style.css:1352`](../../desktop/renderer/style.css#L1352)

- Wide tables scroll inside the 360px rail instead of being clipped.
  [`style.css:1536`](../../desktop/renderer/style.css#L1536)

- Status chips, and the verdict tints converted to token `color-mix`.
  [`style.css:1590`](../../desktop/renderer/style.css#L1590)

**Tests**

- Fails by name when a preset grows a section the rail does not know.
  [`rail-sections.test.js:71`](../../desktop/test/rail-sections.test.js#L71)

- An independent slug→kind table; retagging a section fails here, not silently.
  [`rail-sections.test.js:91`](../../desktop/test/rail-sections.test.js#L91)
