---
title: 'Transcribe-settings screen moves to the Transcripts tab, gets a close (✕)'
type: 'refactor'
created: '2026-08-27'
status: 'done'
review_loop_iteration: 0
context: []
route: 'one-shot'
---

## Intent

**Problem:** The transcribe-settings / transcribing screens were nested inside the Record tab's panel, so every entry point — all of which live on the Transcripts tab (library selection, per-recording "Transcribe…", an audio-only meeting's "Transcribe…") — force-jumped the user to the Record tab to show them. The screen's only way out was a "Record › N recordings" breadcrumb at the top or a Cancel button that needed scrolling to reach.

**Approach:** Moved `#record-transcribe-settings` and `#record-transcribing` out of `#record-container` into a new top-level `#transcribe-flow` overlay (same fixed viewport box, shown over whichever tab is active) so the screen now opens on the Transcripts tab instead of forcing a tab switch. Deleted the "Record ›" breadcrumb entirely and added a close (✕) button to the header, wired to the same cleanup path as the existing Cancel button. Closed the resulting gap where a manual tab switch (toolbar click, ⌘R, the recording-indicator pill) could leave the overlay pinned on top of the wrong tab, by having the shared `switchTab()` close it first. Gave the overlay `role="dialog"`/`aria-modal`, an accessible name on the new close button, initial focus on open, and an Escape-to-close handler, matching this app's other modals.

## Suggested Review Order

**Where the screen now lives**

- Entry point — the flow now opens on top of whichever tab launched it, always ends on Transcripts.
  [`record.js:1067`](../../desktop/renderer/record/record.js#L1067)

- The overlay's own box: fixed, same rect as the three tab panels, explicit `z-index` so DOM order isn't load-bearing.
  [`record.css:27`](../../desktop/renderer/record/record.css#L27)

- Markup relocated out of `#record-container`, breadcrumb deleted, close button + dialog semantics added.
  [`index.html:758`](../../desktop/renderer/index.html#L758)

**Closing it from anywhere**

- Root-cause fix: any tab switch closes a pending batch config like Cancel, or just hides an in-flight transcription (job keeps running in the queue).
  [`record.js:381`](../../desktop/renderer/record/record.js#L381)

- `switchTab()` calls the above first, before touching panel visibility — covers the toolbar, ⌘R, and the recording-indicator pills in one place.
  [`live.js:223`](../../desktop/renderer/live/live.js#L223)

- Escape now closes the overlay too, matching every other dismissible surface in the app.
  [`record.js:388`](../../desktop/renderer/record/record.js#L388)

- Shared cancel logic the footer Cancel button, the new ✕, and tab-switch-away all now funnel through.
  [`record.js:652`](../../desktop/renderer/record/record.js#L652)

**Callers no longer need to switch tabs themselves**

- `sendToTranscribeSettings` dropped its own `.tab-btn[data-tab="record"]` click — `enterTranscribeSettings` owns that now.
  [`app.js:1750`](../../desktop/renderer/app.js#L1750)

- `anyOverlayOpen()` now counts the new overlay, so ⌘F (find in note) doesn't fire underneath it.
  [`app.js:3729`](../../desktop/renderer/app.js#L3729)
