---
title: 'Copy file path in meeting card menu'
type: 'feature'
created: '2026-09-06'
status: 'done'
review_loop_iteration: 0
context: []
route: 'one-shot'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The meeting card's context menu (`openMeetingMenu`) had no way to get the on-disk path of a meeting's file — a user who needs it (e.g. to attach the transcript elsewhere, or paste it into another tool) had no built-in way to grab it.

**Approach:** Add a "Copy file path" item to the menu, present on every row (transcribed or audio-only), that copies `m.id` — the same path every other per-row action (rename, delete, reveal) already keys on — to the clipboard.

</frozen-after-approval>

## Suggested Review Order

**Menu item**

- Entry point: new button, unconditional on every row (unlike the audio-only-only `reveal` item above it).
  [`app.js:2236`](../../desktop/renderer/app.js#L2236)

- Click handler: copies `m.id` to the clipboard, swallowing a rejected write the same way `btnRailCopy` does elsewhere in this file.
  [`app.js:2303`](../../desktop/renderer/app.js#L2303)

- New shared icon path, reused from two pre-existing inline copy-icon SVGs elsewhere in the file (not refactored — see deferred-work.md).
  [`app.js:2718`](../../desktop/renderer/app.js#L2718)

**Popover sizing**

- Clamp height bumped by one row now that every menu variant renders one more button than before.
  [`app.js:2169`](../../desktop/renderer/app.js#L2169)

**Tests**

- Pins the item as present and never disabled, on both the transcribed and audio-only menu variants.
  [`library-filters.test.js:493`](../../desktop/test/library-filters.test.js#L493)

