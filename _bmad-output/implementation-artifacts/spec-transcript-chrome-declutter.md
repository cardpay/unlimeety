---
title: 'Delete the status bar and move the transcript info icon onto the meeting card'
type: 'refactor'
created: '2026-08-25'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done
review_loop_iteration: 1
baseline_commit: '20b3d5575044151281657a23bf5d28fbbffb0dff'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Two pieces of chrome cost more than they earn. The fixed footer
repeats the transcript's own file path and a live word/line count nobody acts
on, eating 28px of every screen. And the info icon added by
`spec-transcript-meta-info-icon.md` sits above the first turn *inside* the
transcript, still pushing the conversation down for reference data.

**Approach:** Delete the status bar outright — markup, wiring, CSS, and the
now-dead `updateUI`/`updateStats`. Move the info icon out of the transcript
view and onto the library meeting card, beside the artifact chips it belongs
with; its panel is built from fields the card already receives. The transcript
view keeps only the inline `Status: PARTIAL …` warning.

## Boundaries & Constraints

**Always:**

- Delete, do not hide. No `display:none` survivors, no orphaned CSS custom
  property, no function kept "in case". `--statusbar-height` goes too, and
  `#editor-container`'s `bottom` becomes `0`.
- The `Status: PARTIAL …` warning stays in the transcript view, inline and
  hover-free — it is the one header line a reader must not have to seek out.
- The card panel is built from the meeting record the library already loads.
  `transcripts:list` already spreads `parseTranscriptHeaderMain`'s output into
  every item (`source`, `generated`, `recordedAt`, `language`, `model`,
  `enhancedAt`, `participants`); `deriveMeetingFromTranscript` currently drops
  three of them. Carry them through — no new IPC, no per-card file read.
- Reuse: `metaValue()` and `META_LABELS` keep formatting rows; `iconSvg("info")`
  keeps drawing the glyph; the popover follows `openMeetingMenu`'s house
  pattern (body-level root + overlay + clamped coordinates), because
  `#library-list` is `overflow-y:auto` and would clip a card-anchored panel.
- The bytes on disk and the edit-mode textarea are untouched, as before.

**Ask First:**

- Dropping any header field from the card panel because a chip already shows
  it. Redundancy on a hidden panel is cheaper than a missing field.
- Any change to what `main.js` *writes* into the transcript header.

**Never:**

- No new renderer script file, no tooltip/popover library, no new dependency.
- Do not touch the Record tab's recording UI beyond deleting its
  `updateStatusBar` helper and its three call sites.
- Do not re-derive the header by reading transcript files from the card render
  path.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full header, card | meeting with `model`, `language`, `source`, `generated`, `recordedAt`, `participants` | `i` chip in the card's chip row; opening it shows one labelled row per present field, `Recorded-At` labelled `Recorded`, `Model` via `modelLabel()`, ISO stamps via `formatMeetingStamp()` | N/A |
| Bare meeting | pasted transcript: no header fields on the record | no `i` chip at all — no empty panel | N/A |
| Interrupted transcript | header carries `Status: PARTIAL …` | the warning renders inline in the transcript view where the header block was; the card chip row is unchanged | N/A |
| Long source path | `source` is a long path/URL | the row wraps inside the panel instead of overflowing it | N/A |
| Panel near the viewport edge | icon clicked on the last card in a scrolled list | panel is clamped to stay fully on screen | N/A |
| Outside click / Escape | panel open | panel closes and leaves no element or listener behind | N/A |
| Find in note | query matches a header value, panel closed | zero hits — the panel is outside every root find-in-note scans (`#transcript-view`, `#summary-rail-body`) | N/A |

</frozen-after-approval>

## Code Map

**Status bar (delete)**

- `desktop/renderer/index.html:955-962` — the `<footer id="status-bar">` block,
  whole.
- `desktop/renderer/app.js:671-673` — `statusPath` / `statusWords` /
  `statusLines` bindings. `:1342` `updateStats()` and `:2901` `updateUI()` do
  nothing else, so both die with their call sites at `:1167`, `:1168`, `:1293`,
  `:1310`, `:2912`, `:2950`.
- `desktop/renderer/record/record.js:533-538` `updateStatusBar()` plus its calls
  at `:433`, `:741`, `:757` — its only job is writing `#status-path`.
- `desktop/renderer/style.css:65` `--statusbar-height`; `:317`
  `#editor-container { bottom: var(--statusbar-height) }` → `0`; `:191` the
  `body.mode-live #status-bar` selector inside a shared rule (drop the selector,
  keep the rule); `:466-498` `#status-bar` / `#status-right` /
  `.status-divider` / `#status-path`.

**Info icon (relocate)**

- `desktop/renderer/app.js:939-1013` — the `// ── transcript meta ──` region.
  `parseTranscriptMeta` stays (the view still needs the warning and still
  strips the header); `metaValue` / `META_ISO` / `META_LABELS` stay as the
  shared formatter. `transcriptMetaHtml` (`:993`) loses the button and panel
  and becomes warning-only. Keep the region markers — the test reads them.
- `desktop/renderer/app.js:1014` `renderTranscriptView()` — the call site; the
  `header` slice at `:1015` stays (it is what strips the block from view).
- `desktop/renderer/app.js:59` `deriveMeetingFromTranscript()` — add `source`,
  `generated`, `recordedAt` alongside the existing `language` / `model` /
  `enhancedAt` passthrough.
- `desktop/renderer/app.js:1503` `buildMeetingCard()` — `.artifact-chips` at
  `:1534-1540` is where the `i` chip goes; `.meeting-card-row3` already wraps.
- `desktop/renderer/app.js:1561-1567` `closeMeetingMenu` / `openMeetingMenu` —
  the popover pattern to mirror: body-level root, `.meeting-menu-overlay` for
  outside-click, `Math.max/min` viewport clamping.
- `desktop/renderer/app.js:1962-1990` `modelLabel` / `modelIsStrong` /
  `modelChipHtml` — sibling chip builders; `:1990` `ICON_PATHS.info` already
  exists.
- `desktop/renderer/style.css:2760-2846` — `.tv-meta*` rules. Panel/row/key/val
  rules are reused under the card popover's names; the `.tv-meta-btn:hover ~
  .tv-meta-panel` reveal chain goes away with hover. `.tv-meta-warn` stays.
- `desktop/renderer/find-in-note.js:147-155` — the `.tv-meta-panel` skip
  predicate and `findNodeFilter`. The panel leaves `#transcript-view` entirely
  (`:98`, `:180-189` are the only roots), so the filter is dead: restore the
  unfiltered `createTreeWalker` at `:159` and delete the region.
- `desktop/test/transcript-meta.test.js` — reads both regions by marker. The
  find-predicate half must go; the parser half stays.
- Read-only reference: `desktop/main.js:1739` `parseTranscriptHeaderMain` (the
  field list) and `:1823` (where it is spread into each list item).

## Tasks & Acceptance

**Execution:**

- [x] `desktop/renderer/index.html` + `desktop/renderer/style.css` +
  `desktop/renderer/record/record.js` -- delete the footer, its four CSS rules,
  `--statusbar-height` (re-pointing `#editor-container`'s `bottom` at `0`), the
  `body.mode-live` selector, and `updateStatusBar` with its three calls --
  grouped because the footer is one element and leaving any half behind is a
  broken layout or a dead reference.
- [x] `desktop/renderer/app.js` -- delete `statusPath`/`statusWords`/
  `statusLines`, `updateStats`, `updateUI` and all six call sites -- both
  functions exist only to feed the footer.
- [x] `desktop/renderer/app.js` -- carry `source`, `generated`, `recordedAt`
  through `deriveMeetingFromTranscript` -- the panel's rows come from the
  meeting record, and these three are already in the IPC payload.
- [x] `desktop/renderer/app.js` -- add a pure `meetingMetaRows(m)` inside the
  marked region, reduce `transcriptMetaHtml` to the warning, render the `i`
  chip in `buildMeetingCard`, and open its panel through a
  `closeMeetingMenu`-style body-level popover -- `#library-list` clips, so the
  panel cannot live inside the card.
- [x] `desktop/renderer/style.css` -- rename the reused `.tv-meta-panel`/`-row`/
  `-key`/`-val` rules to the card popover and drop the hover-reveal chain; keep
  `.tv-meta-warn` -- the panel is now click-toggled from a scroll container.
- [x] `desktop/renderer/find-in-note.js` -- drop the skip predicate and restore
  the unfiltered TreeWalker -- no scanned root can contain the panel any more.
- [x] `desktop/test/transcript-meta.test.js` -- drop the find-predicate cases,
  keep the parser cases, add `meetingMetaRows` cases for the matrix rows that
  need no DOM (full record, bare record, label/format mapping).
- [x] `_bmad-output/implementation-artifacts/spec-transcript-meta-info-icon.md`
  -- append a change-log line recording that the icon moved to the card --
  that spec is the record of why the icon exists, and it now describes a
  placement that is gone.

**Acceptance Criteria:**

- Given the app is running, when any tab is open, then no footer strip exists
  and the editor/transcript pane reaches the bottom of the window.
- Given `rg -n 'status-bar|status-path|status-words|status-lines|statusbar-height|updateStats|updateStatusBar' desktop/ -g '!app.js'` is run, when it completes, then it prints nothing. (`desktop/app.js` is an untracked pre-change copy of `renderer/app.js` that nothing loads.)
- Given a transcript with a full header opens in view mode, when it renders,
  then the first thing under the player is the first turn — no header lines, no
  icon.
- Given a meeting card whose transcript carried a header, when its `i` chip is
  activated, then the panel shows those fields and closes on outside click or
  Escape.

## Spec Change Log

- **2026-08-25 (review round 1, bad_spec)** — the card panel was built from
  `parseTranscriptHeaderMain`'s **typed fields**, and that whitelist has never
  covered every header line actually on disk. A survey of the 636 transcripts
  in `~/Downloads/Meet_Transcripts` found `Started:` in 72 of them and `Date:`
  in one — lines that were visible in the old `.tv-header` block and became
  invisible everywhere. `main.js` now returns the header slice it already has
  in hand (`header: head`), `deriveMeetingFromTranscript` carries that instead
  of the three typed fields, and `parseTranscriptMeta` — retired one entry
  above — came back to turn it into rows. `CARD_META_FIELDS` is gone with the
  whitelist. **This supersedes the Boundaries line that named the three typed
  fields**; the invariant it existed to protect (no new IPC, no per-card file
  read) is untouched. That block was never presented at a human checkpoint, so
  it is amended here rather than treated as human-owned.
  **KEEP:** rows keyed and ordered as the file writes them; `Meeting:` is now a
  row like any other (the earlier decision to drop it was reversed with the
  whitelist — with no whitelist there is nothing to justify a special case, and
  a viewport-clamped panel can sit well away from the card whose title it would
  have relied on); `Status: PARTIAL` stays out of the panel and inline in the
  transcript.
- **2026-08-25 (review round 1, patch)** — the panel's position was clamped
  from an estimate, `H = 40 + rows.length * 20`. `.meta-val` sets
  `overflow-wrap: anywhere` precisely because Source paths and participant
  lists wrap, so row count says nothing about height: the worst real header in
  the library is 4 lines and renders 320px tall, which the estimate would have
  put 200px off and pushed off-screen. The panel is now appended, measured with
  `getBoundingClientRect()`, then positioned — which also removes the `320` and
  `40vh` constants that duplicated the stylesheet.
- **2026-08-25 (review round 1, patch)** — one Escape closed the panel *and*
  the find bar. The find bar's handler skips itself via `anyOverlayOpen()`, but
  it sits later in the same document listener chain, by which point the panel
  had already been removed and the guard read false. The panel's handler now
  calls `stopImmediatePropagation()` when it actually has a panel to close;
  `#meeting-meta-root` was also added to `anyOverlayOpen()`, which is what stops
  ⌘F opening the find bar underneath an open panel.
- **2026-08-25 (review round 1, patch)** — a file opened from outside the
  transcripts folder (Open, drag-drop, `unlimeety://open?file=`) has no library
  card, so with the header stripped its fields were reachable only by toggling
  to Edit. `transcriptMetaHtml` takes an `inlineRows` option and
  `renderTranscriptView` sets it when `meetings` holds no record for
  `state.filePath`.
- **2026-08-25 (review round 1, patch)** — smaller fixes: the panel is closed
  from `renderMeetings()` (it is body-level and outlived the card it described);
  rows are built when the panel opens rather than captured in the card's
  closure, so an Enhance cannot leave them stale; the redundant `metaPanelOpen`
  flag is gone; the chip carries `aria-expanded` and a `:focus-visible` outline,
  the panel `role="dialog"` with a label, focus moves into it and returns to the
  chip on close; the duplicated `aria-label`/`title` pair is now `title` alone;
  the PARTIAL warning is marked with `⚠` rather than by colour alone.
- **2026-08-25 (review round 1, patch)** — the Verification grep still printed
  output, but only from `desktop/app.js`, an untracked pre-change copy of
  `renderer/app.js` that nothing loads. The check now excludes it.

- **2026-08-25 (implementation)** — `parseTranscriptMeta` was **deleted**, not
  kept as the Code Map said. With rows coming from the meeting record, nothing
  read its `rows` any more, and a 25-line header-text parser whose only live
  output was one warning string is exactly the "function kept in case" the
  Boundaries forbid. It became `transcriptWarning()`, a per-line anchored
  `/^Status:[ \t]*(PARTIAL\b.*)$/m`; `transcriptMetaHtml` was renamed
  `transcriptWarningHtml` to match what it now renders. The gating contract
  (PARTIAL warns, `Status: live (still in progress)` does not) kept its tests;
  the row-parsing cases went with the parser.
- **2026-08-25 (implementation)** — the card panel has **no `Meeting` row**.
  This brushes the "Ask First" on dropping a header field, so it is recorded
  rather than quietly done: `deriveMeetingFromTranscript` consumes the header's
  `Meeting:` as a *fallback* for the filename-derived title and never stores it,
  so a `Meeting` row would have meant carrying a second title field only to
  print the card's own headline back at the reader one line below itself. Every
  other header field is present.
- **2026-08-25 (implementation)** — verification ran against the real app over
  the Chrome DevTools Protocol (`--remote-debugging-port`) on an isolated
  `--user-data-dir`, because `main.js:77`'s single-instance lock refuses a
  second instance while the installed app is open. That covered the five matrix
  rows the Verification section had listed as manual-only (clamping, outside
  click / Escape, no icon in the transcript, no header leak into find-in-note,
  the inline PARTIAL warning).

- **2026-08-25 (follow-up)** — the chip moved out of `.artifact-chips` and up
  beside the meeting title (`.meeting-info`, styled off `.meeting-more`). In
  that row it read as a fifth state indicator next to four chips that report
  what a meeting *has*; the Code Map's `.artifact-chips` anchor is superseded.
  Placement only — the panel, its rows and every decision below are unchanged.

## Design Notes

**Why the panel is click-toggled, not hover-revealed.** The transcript
placement could use a CSS-only `:hover ~` chain because the panel was a sibling
inside a non-clipping pane. `#library-list` is `overflow-y:auto`, so a
card-anchored panel is clipped; escaping means a body-level element, and
chaining hover across two DOM subtrees needs JS enter/leave bookkeeping that a
click toggle does not. The `⋯` menu one row above is already a click popover,
so this matches its neighbour. Keyboard reach comes free — it is a real
`<button>` in the card.

**Why rows come from `m`, not from header text.** The card render path has no
transcript content and must not acquire one for a list of N cards. The list IPC
already parses the header in `main.js`; three fields were simply not being
mapped through. `Status: PARTIAL` is the one field `parseTranscriptHeaderMain`
does not capture — which is why the warning stays in the transcript view rather
than following the icon to the card.

## Verification

**Commands:**

- `cd desktop && npm test` -- expected: all files pass, including
  `renderer-globals.test.js` (it catches a renderer binding shadowing a
  `contextBridge` global — a load-time SyntaxError).
- `rg -n 'status-bar|status-path|status-words|status-lines|statusbar-height|updateStats|updateStatusBar' desktop/ -g '!app.js'` -- expected: no output.

**Manual checks** (`CLAUDE.md`: renderer changes are verified by launching the
app). `cd desktop && npm start`, then:

- No footer anywhere; the transcript pane and the editor reach the window
  bottom in Editor, Record and Live tabs.
- Open a transcribed meeting: no `i` above the first turn.
- Click the `i` chip on that meeting's card: panel opens with the header rows,
  `Model` reads `large-v3`, a long `Source` wraps. Click outside — it closes.
- Scroll the library so a card sits at the bottom edge, open its panel: it is
  fully visible, not clipped by the sidebar.
- Switch theme with the panel open: it follows.
- Cmd+F a word that only appears in a header value: counter reads 0.
- Record something and stop: no console error from the removed
  `updateStatusBar`.
