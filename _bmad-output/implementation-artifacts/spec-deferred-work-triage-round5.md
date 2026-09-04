---
title: 'Deferred-work triage, round 5'
type: 'bugfix'
created: '2026-09-04'
status: 'done'
route: 'one-shot'
review_loop_iteration: 0
context: []
---

## Intent

**Problem:** Three more deferred-work.md items: a stale `desktop/app.js` entry that no longer applies to this checkout; `computeFilterCounts`'s `audio` count used an inline `if (m.hasAudio)` instead of the shared `meetingMatchesFilter` predicate every other filter kind routes through; and `currentCalendarTitle()` (main.js) — the calendar-based title prefill used when auto-recording starts — was a naive, unfiltered `.find()` with no duration cap, so an all-day/multi-day calendar entry ("PTO") could beat the real meeting happening inside it, unlike the better-reasoned `currentEvent()` already shipped for the manual calendar picker.

**Approach:** Confirmed the stale-file entry moot in this checkout (no code change). Routed the audio count through `meetingMatchesFilter`. Ported `currentEvent()`'s exact two-phase logic (ongoing-shortest-wins, upcoming-earliest-wins, ongoing always beats upcoming) into `currentCalendarTitle()` as parallel-but-aligned code, since main.js cannot share a module with a renderer script. A blind-hunter review of the first cut caught that it had collapsed both phases into one tie-break, changing real output for a plausible case (a long meeting starting sooner vs. a short one starting later); fixed by mirroring the branching exactly and adding a fixture-driven parity test that runs both implementations side by side.

## Suggested Review Order

**Calendar auto-record prefill**

- The fix, and the comment explaining why a single merged tie-break is wrong.
  [`main.js:4596`](../../desktop/main.js#L4596)

- The cross-reference this fix is aligned against.
  [`calendar-picker.js:112`](../../desktop/renderer/calendar-picker.js#L112)

- A pointer left on the third, still-unfixed implementation.
  [`calendar-smart.js:100`](../../desktop/renderer/calendar-smart.js#L100)

- Parity harness: runs both implementations against shared fixtures instead of trusting the comment alone.
  [`test/current-calendar-title.test.js`](../../desktop/test/current-calendar-title.test.js#L1)

**Smaller fixes**

- Audio count now routes through the shared predicate.
  [`app.js:1677`](../../desktop/renderer/app.js#L1677)
