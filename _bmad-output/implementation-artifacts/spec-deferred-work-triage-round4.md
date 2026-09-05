---
title: 'Deferred-work triage, round 4'
type: 'bugfix'
created: '2026-09-04'
status: 'done'
route: 'one-shot'
review_loop_iteration: 0
context: []
---

## Intent

**Problem:** Three more independent, bounded items from `deferred-work.md`: `defaultRecordingStem`/`defaultSummaryBase` had no unit test pinning their title-before-timestamp filename order; the main window's own `uds-theme` localStorage reads/writes were unguarded, so a storage exception could break the Settings modal or the theme radio entirely rather than just fail to persist; and an interrupted/partial transcription (`<stem>.partial.txt`) never reached the "To re-transcribe" queue because `parseTranscriptHeaderMain` never parsed the `Status: PARTIAL` header line it was already given.

**Approach:** Pin the filename order with a source-sliced test (no main.js changes needed). Add `readThemePref()`/`writeThemePref()` mirroring the existing `readFormatPref()` guard shape, and point all three call sites at them. Parse `Status:` into a new `interrupted` boolean on `parseTranscriptHeaderMain`'s output, and use it in `meetingMatchesFilter`'s `retranscribe`/`enhance`/`summarize` branches and the meeting-card menu's reasons. A blind-hunter review of the first pass found the `interrupted` fix was dead on arrival — `deriveMeetingFromTranscript` never copied the field onto the meeting record — plus a handful of smaller gaps, all closed in the same pass.

## Suggested Review Order

**Interrupted transcripts reach the re-transcribe queue**

- The critical fix: `deriveMeetingFromTranscript` must copy `interrupted` through, or the filter logic below never fires.
  [`app.js:118`](../../desktop/renderer/app.js#L118)

- `Status: PARTIAL` parsed into a boolean, with a cross-reference to the renderer's own independent check of the same value.
  [`main.js:1838`](../../desktop/main.js#L1838)

- The filter logic: retranscribe gains it, enhance/summarize exclude it.
  [`app.js:1601`](../../desktop/renderer/app.js#L1601)

- Same reasoning applied to the meeting-card menu, not just the queue chip.
  [`app.js:2054`](../../desktop/renderer/app.js#L2054)

**Main-window theme storage guard**

- The two guarded helpers, mirroring the existing `readFormatPref()` shape.
  [`app.js:5014`](../../desktop/renderer/app.js#L5014)

**Tests**

- The wiring-gap regression test — asserts the exact copy step that broke.
  [`test/transcript-meta.test.js:245`](../../desktop/test/transcript-meta.test.js#L245)

- Filename-order pinning, no main.js changes required.
  [`test/default-filenames.test.js`](../../desktop/test/default-filenames.test.js#L1)

- Storage-failure coverage for the new theme guard.
  [`test/theme-pref-guard.test.js`](../../desktop/test/theme-pref-guard.test.js#L1)
