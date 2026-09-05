---
title: 'Deferred-work triage, round 2'
type: 'bugfix'
created: '2026-08-27'
status: 'done'
route: 'one-shot'
review_loop_iteration: 0
context: []
---

## Intent

**Problem:** Four bounded, independently-real bugs sat open in `deferred-work.md` after the first triage pass (commit bffb1fb): an Enhance run that rejects every proofreading part but still renames speakers writes to disk with no signal that it was ever attempted, so it re-queues forever; a modal opened by ⌘N/⌘O/⌘/ while the ⋯ meeting menu is up renders underneath its click-swallowing overlay; and neither the Record nor the Live setup screen shows real Microphone permission state, only a permanently-static "first launch" hint.

**Approach:** Fix each at its root cause with the smallest correct change — a distinct `Enhance-Attempted:` header stamp (never `Enhanced:`) plus a filter-predicate update; a targeted `closeMeetingMenu()` call in the three shortcut branches that actually open something; and a new `micPermissionStatus()` IPC round-trip consumed by both setup screens, re-checked on every return to the idle screen rather than once at load. A fifth candidate (Re-transcribe losing the active filter chip) turned out already fixed by a later, unrelated spec — verified and annotated, no code changed for it.

## Code Map

- `desktop/main.js` -- `parseTranscriptHeaderMain`, `runEnhanceJob`'s stamping branch, new `micPermissionStatus()` + two IPC handlers
- `desktop/preload.js` -- `live.micStatus` / `recordApi.micStatus` bridges
- `desktop/renderer/app.js` -- `enhance` filter predicate, meeting-record shape, the global `keydown` listener's modal-opening branches
- `desktop/renderer/live/live.js`, `desktop/renderer/record/record.js` -- `refreshMicStatus()`, wired into initial load and every return to the setup screen
- `desktop/renderer/index.html`, `desktop/renderer/live/live.css` -- the mic-status element and its denied-state color
- `desktop/test/library-filters.test.js` -- direct `parseTranscriptHeaderMain` coverage, `enhanceAttemptedAt` filter case

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: all suites pass (61/61 at last run)

**Manual checks (if no CLI):**
- Open the ⋯ meeting menu, press ⌘N — the menu closes and New Transcript opens on top, not underneath.
- On the Record or Live setup screen, the permission hint now leads with a real "Microphone: granted."/"Microphone: not granted." line before the static first-launch copy.

## Suggested Review Order

**Enhance stuck in "To enhance" forever**

- Root cause and the fix: a rejected-every-part run now gets its own stamp, never `Enhanced`.
  [`main.js:2510`](../../desktop/main.js#L2510)

- The new header key parsed into `enhanceAttemptedAt` — an off-by-one here (19 vs 20) was the first bug review caught.
  [`main.js:1819`](../../desktop/main.js#L1819)

- Filter predicate now excludes the new state too, so the queue actually clears.
  [`app.js:1571`](../../desktop/renderer/app.js#L1571)

- Direct coverage of the parser, added because the queue-level test alone would not have caught the slice-length bug.
  [`library-filters.test.js:762`](../../desktop/test/library-filters.test.js#L762)

**Modal rendering under the meeting-menu overlay**

- Each shortcut that actually opens something now closes the menu first — narrowed from an initial blanket guard after review flagged it as too broad.
  [`app.js:3758`](../../desktop/renderer/app.js#L3758)
  [`app.js:3763`](../../desktop/renderer/app.js#L3763)
  [`app.js:3788`](../../desktop/renderer/app.js#L3788)

**Real microphone permission status**

- The single source of truth, deliberately Microphone-only — Screen Recording's OS API is known to lie right after a fresh grant.
  [`main.js:2707`](../../desktop/main.js#L2707)

- Two IPC handlers, one per tab, matching this file's existing per-tab convention.
  [`main.js:2739`](../../desktop/main.js#L2739)
  [`main.js:3491`](../../desktop/main.js#L3491)

- Live's refresh: re-run on load, on return-to-setup, and on a failed Start — the last one is what a first cut missed.
  [`live.js:336`](../../desktop/renderer/live/live.js#L336)

- Record's refresh, hooked into the shared `showSection('idle')` instead of a one-off call.
  [`record.js:357`](../../desktop/renderer/record/record.js#L357)
  [`record.js:398`](../../desktop/renderer/record/record.js#L398)

**Peripherals**

- `deferred-work.md` -- resolution notes for all five entries this pass touched, including the one that needed no code.
