---
title: 'Deferred-work triage, round 6'
type: 'bugfix'
created: '2026-09-04'
status: 'done'
route: 'one-shot'
review_loop_iteration: 0
context: []
---

## Intent

**Problem:** Two more deferred-work.md items: `renderTranscriptView`'s markup-building was untested because it touched a real DOM element directly — deleting the one line that wires in the "PARTIAL — transcription was interrupted" warning used to leave the whole suite green; and the library's de-dup logic only knew a transcript's first related wav (`m.audioPath`), not all of them, so a legacy-stem recording with multiple related wavs — or any transcript whose read failed — could still double-card.

**Approach:** Split `renderTranscriptView`'s pure markup-building into `buildTranscriptViewHtml(content, carded)`, wrapped in a new marked test region, and added a test that wires in the REAL `transcriptMetaHtml` (not a stub) so deleting the wiring line fails it. Exposed `transcripts:list`'s full `audioPaths[]` (both branches, including the read-failed fallback, since path existence doesn't depend on a failed read) and had `mergeMeetings`' claimed-set union all of them via `flatMap`. A blind-hunter review of the first pass found a real gap — no test exercised the actual main.js code that changed, only the renderer's consumption of fixtures that already assumed the fields existed — plus two smaller consistency gaps, all closed in the same pass; one further gap (Re-transcribe/the player still only use the first audioPath) was recorded as a new, separate deferred-work entry rather than fixed, since it is a product decision about what "re-transcribe" means for more than one source wav.

## Suggested Review Order

**PARTIAL-warning wiring**

- The split: markup-building now returns a string, the DOM write is all that's left in `renderTranscriptView`.
  [`app.js:1163`](../../desktop/renderer/app.js#L1163)

- The test, using the real `transcriptMetaHtml` so deletion of the wiring line fails it.
  [`test/transcript-meta.test.js:430`](../../desktop/test/transcript-meta.test.js#L430)

**Multi-wav / read-failed dedup**

- Both `transcripts:list` branches now expose the full `audioPaths` array.
  [`main.js:1978`](../../desktop/main.js#L1978)

- `mergeMeetings`'s claimed-set now unions every related wav, not just the first.
  [`app.js:206`](../../desktop/renderer/app.js#L206)

- Review-round fix: a structural test on the actual main.js source, not just renderer fixtures.
  [`test/transcripts-list-audio-paths.test.js`](../../desktop/test/transcripts-list-audio-paths.test.js#L1)

- Review-round fix: shape parity so a generic `audioPaths` consumer can't crash on a recording-only card.
  [`app.js:170`](../../desktop/renderer/app.js#L170)
