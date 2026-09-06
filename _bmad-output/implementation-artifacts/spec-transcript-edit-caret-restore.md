---
title: 'View->Edit toggle lands the caret on the active segment, not end-of-file'
type: 'bugfix'
created: '2026-09-06'
status: 'done'
route: 'one-shot'
---

# View->Edit toggle lands the caret on the active segment, not end-of-file

## Intent

**Problem:** After a segment is highlighted in the transcript's View mode (by seeking/playback), switching to Edit mode dumps the user at end-of-file instead of the corresponding line — `showEditorTextarea()` never touched the textarea's selection or scroll, so the caret stayed wherever the last full `editor.value =` assignment (file load) had parked it: end-of-text, per the `<textarea>` spec.

**Approach:** Give each rendered segment a `data-idx` matching its position in `parseSegments(content)`, add `segmentOffsets(content)` to map that index back to a raw character offset, and have the View->Edit toggle resolve `lastActiveSeg` (the segment View mode was last showing as active) through that mapping to call `setSelectionRange` + reuse find-in-note.js's existing textarea-scroll-into-view geometry.

## Suggested Review Order

**Offset mapping**

- Entry point: maps a `.tv-seg`'s `data-idx` to a raw-text character offset.
  [`app.js:1044`](../../desktop/renderer/app.js#L1044)

- The toggle's only decision logic, pulled out so it's unit-testable without a real DOM segment.
  [`app.js:1059`](../../desktop/renderer/app.js#L1059)

- `data-idx` written onto each rendered segment, in the same `parseSegments(content)` order `segmentOffsets` assumes.
  [`app.js:1262`](../../desktop/renderer/app.js#L1262)

**Wiring into the toggle**

- Where the caret actually gets moved and scrolled on View->Edit.
  [`app.js:1367`](../../desktop/renderer/app.js#L1367)

- Reused rather than reimplemented: the same mirror-`<div>` geometry find-in-note.js already had for search-match scrolling.
  [`find-in-note.js:311`](../../desktop/renderer/find-in-note.js#L311)

**Tests and docs**

- Unit coverage for `segmentOffsets`/`resolveEditCaretOffset`, including the wall-clock (text-export, no audio) segment case.
  [`segment-offsets.test.js:1`](../../desktop/test/segment-offsets.test.js#L1)

- Cross-call contract (`data-idx` and `segmentOffsets` must share one `content`) recorded as a pitfall.
  [`AGENTS.md:57`](../../AGENTS.md#L57)

- Test-only dedup: three copies of the same region-extraction helper collapsed into one.
  [`find-region.js:1`](../../desktop/test/lib/find-region.js#L1)
