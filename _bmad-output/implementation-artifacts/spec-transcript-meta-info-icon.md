---
title: 'Hide the transcript meta header behind a hover-revealed info icon'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '20b3d5575044151281657a23bf5d28fbbffb0dff'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A transcript opens with up to seven lines of machine header —
`Meeting:` / `Recorded-At:` / `Generated:` / `Model:` / `Participants:` /
`Language:` / `Source:` — rendered verbatim above the first turn. It is
reference data nobody reads twice, in monospace, pushing the actual
conversation below the fold on every open.

**Approach:** In view mode, replace that block with a single `i` icon placed
where the block was. Hovering (or keyboard-focusing) it reveals a formatted
panel showing the same fields as labelled rows. The bytes on disk and the
edit-mode textarea keep the header exactly as they are today.

## Boundaries & Constraints

**Always:**

- View mode only — `renderTranscriptView()` / `#transcript-view`. `#editor`
  keeps the raw text and `saveFile()` keeps writing `editor.value` untouched:
  no header is stripped from, or re-attached to, anything that reaches disk.
- A `Status: PARTIAL …` line stays rendered inline, outside the panel. A
  warning that transcription was interrupted must not hide behind a hover.
- Every header line survives into the panel. A line that is not `Key: value`
  becomes a keyless row — nothing is silently dropped.
- The panel opens on pointer hover **and** on keyboard focus of the icon.
- The panel's text must contribute zero matches to find-in-note while closed.
- Reuse what exists: `iconSvg("info")` (`ICON_PATHS.info` is already there),
  `modelLabel()` for the Model row, and the CSS tokens of the existing rail
  tooltip. No tooltip library, no new icon set, no new dependency.

**Ask First:**

- Any change to what `main.js` writes into the header, or to the on-disk
  transcript format.
- Adding click-to-pin behaviour — hover-only was the chosen interaction.

**Never:**

- Do not touch the Record tab or Live tab views, the meeting-card provenance
  chips, or the `.tv-plain` fallback (a transcript with no timecodes has no
  reliable header boundary, so it keeps rendering whole).
- No `<dialog>`, no popover polyfill, no new renderer script file.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full header | all seven keys, timecoded body | `i` icon where the header block was; hover shows rows in header order — `Recorded-At`/`Generated` as localized date-times, `Model` via `modelLabel()` (`large-v3` not `openai_whisper-large-v3`), `Source` wrapping instead of overflowing | N/A |
| Interrupted transcript | header carries `Status: PARTIAL …` | the Status text stays visible beside the icon; remaining keys go in the panel | N/A |
| Pasted transcript | no `[mm:ss]` marker anywhere | unchanged `.tv-plain` render, no icon | N/A |
| No header | content starts at the first turn | no icon, no empty panel | N/A |
| Unparsable header line | free text before the first turn | keyless row in the panel | N/A |
| Find in note | query matches `Daily Sync`, panel closed | zero hits from the panel; the counter and Enter navigation visit only visible transcript text | N/A |

</frozen-after-approval>

## Code Map

- `desktop/renderer/app.js:939` `renderTranscriptView()` — lines 947-948 build
  `<div class="tv-header">`; that is the single replacement point. The header
  boundary is the `firstTcMatch` index already computed at line 940 — reuse it,
  do not re-derive.
- `desktop/renderer/app.js:848` `escHtml`, `:1856` `modelLabel`, `:1880`
  `ICON_PATHS` (has `info`), `:1890` `iconSvg` — reuse points. Declarations
  hoist, so calling `modelLabel` from line 948 is fine.
- `desktop/renderer/app.js:883` `headerParticipants()` — existing precedent for
  header-line parsing (`if (line === "") break`). Read-only; do not refactor.
- `desktop/renderer/style.css:2749` `.tv-header` — replaced by the new
  `.tv-meta*` rules. `desktop/renderer/style.css:1679-1706`
  (`.btn-rail-icon[data-tooltip]::after`) is the house hover-tooltip pattern —
  mirror its `--bg-elevated` / `--border-strong` / `--radius-sm` / `z-index:100`
  / opacity-transition tokens so the panel looks native.
- `desktop/renderer/find-in-note.js:148` `rangesIn()` — `createTreeWalker(root,
  SHOW_TEXT)` with **no** filter, so a hidden panel would still yield hits. The
  `MutationObserver` at `:97` already watches `#transcript-view`, so no wiring
  is needed beyond the filter.
- `desktop/main.js:1738` `parseTranscriptHeader()` — the writer's authoritative
  field list (`Meeting` / `Generated` / `Recorded-At` / `Language` / `Source` /
  `Model` / `Enhanced` / `Participants`). Read-only reference for row labels.
- `desktop/renderer/index.html:233` `#transcript-view` — container only; markup
  is generated, so no HTML change.

## Tasks & Acceptance

**Execution:**

- [x] `desktop/renderer/app.js` -- add a pure header→rows parser and swap the
  `.tv-header` branch of `renderTranscriptView()` for icon + panel markup;
  pull `Status:` out as an inline sibling -- the header is the one thing in
  view mode a reader never needs inline, but the interruption warning is.
- [x] `desktop/renderer/style.css` -- replace `.tv-header` with
  `.tv-meta` / `.tv-meta-btn` / `.tv-meta-panel` / `.tv-meta-row` /
  `.tv-meta-key` / `.tv-meta-val` / `.tv-meta-warn`, revealed on `:hover` and
  `:focus-visible` -- mirroring the rail tooltip keeps it visually native and
  theme-aware in both light and dark.
- [x] `desktop/renderer/find-in-note.js` -- give `rangesIn`'s TreeWalker a
  `NodeFilter` that rejects nodes inside `.tv-meta-panel` -- otherwise a closed
  panel feeds invisible matches into the counter and Enter scrolls to nothing.
- [x] `desktop/test/transcript-meta.test.js` -- new `node --test` file covering
  every I/O matrix row that is reachable without a DOM (full header, `Status:`
  line pulled out, no header, unparsable line, and the panel-skip predicate) --
  the matrix is the contract, and the parser is pure, so it does not need the
  app running to be pinned down.

**Acceptance Criteria:**

- Given a transcript with a full header, when it opens in view mode, then the
  first things under the player are the `i` icon and the first turn — no header
  lines inline.
- Given the icon is focused from the keyboard with no pointer involved, when
  nothing else changes, then the panel is visible.
- Given the panel is open, when the pointer leaves both icon and panel, then it
  hides, leaving no class or attribute state behind.
- Given a transcript is opened in view mode and then saved, when its bytes are
  diffed against the pre-change file, then the header is byte-identical.

## Spec Change Log

- **2026-08-25 (implementation)** — `ICON_PATHS.info` did *not* exist in
  `renderer/app.js` (the Code Map assumed it did), so the feather `info` glyph
  was added as one more entry in that same table — no new icon set, the
  `iconSvg("info")` reuse point holds.
- **2026-08-25 (implementation)** — the test harness reuses
  `meeting-date-format.test.js`'s marked-region + `new Function` pattern
  (`// ── transcript meta ──` markers, `modelLabel` / `formatMeetingStamp`
  injected as parameters) instead of brace-matching extraction: the repo already
  had that mechanism, and it does not break on `opts = {}` in a signature.
- **2026-08-25 (implementation)** — `npm test` is 9 files now, not the 6 the
  Verification section named; the Verification section has been corrected.
- **2026-08-25 (review)** — only `Status: PARTIAL …` goes to the inline warning.
  `renderer/live/live.js:854` writes `Status: live (still in progress)` into
  every Live-saved transcript, so gating on the *key* painted healthy notes
  amber as if transcription had failed. Any other `Status` value — the empty one
  included — is an ordinary panel row, which keeps the "nothing is silently
  dropped" invariant true.
- **2026-08-25 (review)** — dates are reformatted only when the *value* is ISO
  shaped (`/^\d{4}-\d{2}-\d{2}T/`), not when the key is a known date field.
  `Recorded-At` and `Enhanced` are ISO, but `Generated` is written with
  `new Date().toLocaleString()` (`main.js:2135`, `:2948`, `:3894`, and
  `extenstion/background.js:157`), a shape `new Date()` either rejects — mixing
  house-formatted and locale-formatted rows in one panel — or mis-reparses as a
  different instant. Everything else is shown verbatim.
- **2026-08-25 (review)** — the golden markup's `Recorded` label is honoured by
  a display-only `META_LABELS` map; the parsed key stays `Recorded-At`. A bare
  URL header line is a keyless row (it was becoming a row keyed `https`). The
  button carries `aria-describedby` to the panel's id.

## Design Notes

**Test harness.** `renderer/` has no module system (classic `<script>` tags) and
the spec forbids adding a renderer script file or a dependency, so
`transcript-meta.test.js` reads `desktop/renderer/app.js`, extracts the named
pure functions by brace-matching, and `new Function`s them — the same
source-reading approach `renderer-globals.test.js` already uses. Keep the parser
and the find-in-note skip predicate free of DOM access beyond a
`parentElement.closest()` call the test can stub, so they stay testable. The two
matrix rows that are DOM-only (`.tv-plain` fallback, panel visibility) stay in
the manual checklist — jsdom would be a new dependency.

Golden markup (generated, not authored in HTML). `.tv-meta-warn` is absent
when the header has no `Status:` line:

```html
<div class="tv-meta">
  <button class="tv-meta-btn" type="button" aria-label="Transcript details">…info svg…</button>
  <span class="tv-meta-warn">PARTIAL — re-run it for the full text</span>
  <div class="tv-meta-panel" role="tooltip">
    <div class="tv-meta-row"><span class="tv-meta-key">Meeting</span><span class="tv-meta-val">Daily Sync</span></div>
  </div>
</div>
```

## Verification

**Commands:**

- `cd desktop && npm test` -- expected: 9/9 pass (`node --test` discovers every
  file in `desktop/test/`; the count was 6 when this spec was written). Includes
  `renderer-globals.test.js`, which catches a renderer top-level binding
  shadowing a `contextBridge` global (a load-time SyntaxError).

**Manual checks** (no renderer test harness — `CLAUDE.md` says renderer changes
are verified by launching the app). `cd desktop && npm start`, then:

- Transcript with audio: header block gone, `i` icon in its place, hover shows
  the labelled panel, `Model` reads `large-v3`.
- Tab to the icon: panel appears on focus. Switch theme: panel follows it.
- Cmd+F a word only in the header: counter reads 0 while the panel is closed.
- Toggle Edit: raw header back in the textarea. Save, `git diff` the file — no
  change.
- Pasted transcript with no timecodes: renders whole, no icon.

## Suggested Review Order

**What the reader sees instead of the header**

- The one-line swap the whole change exists for: seven header lines become an icon.
  [`app.js:1023`](../../desktop/renderer/app.js#L1023)

- Markup assembly. Note the warning is a sibling *before* the panel, never inside it.
  [`app.js:992`](../../desktop/renderer/app.js#L992)

**Header parsing**

- `Status` is gated on the value, not the key — `live.js:854` writes a healthy one.
  [`app.js:960`](../../desktop/renderer/app.js#L960)

- Dates are reformatted by value shape: only `Recorded-At`/`Enhanced` are ISO, `Generated` is not.
  [`app.js:983`](../../desktop/renderer/app.js#L983)

- Display-only relabel, so the parsed key stays the file's own word.
  [`app.js:954`](../../desktop/renderer/app.js#L954)

**Reveal and layout**

- Hover scope lives on the icon and the panel — not the row, which a warning stretches wide.
  [`style.css:2825`](../../desktop/renderer/style.css#L2825)

- Panel surface: rail-tooltip tokens, `visibility` so it is not hit-tested while closed.
  [`style.css:2792`](../../desktop/renderer/style.css#L2792)

**Search**

- A closed panel must not feed invisible matches into the find counter.
  [`find-in-note.js:152`](../../desktop/renderer/find-in-note.js#L152)

**Tests**

- Marked-region eval: no module system in `renderer/`, so the pure regions are read off disk.
  [`transcript-meta.test.js:1`](../../desktop/test/transcript-meta.test.js#L1)
