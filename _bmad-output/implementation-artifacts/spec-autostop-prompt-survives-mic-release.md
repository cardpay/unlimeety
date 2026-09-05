---
title: 'Auto-stop prompt survives the late mic release'
type: 'bugfix'
created: '2026-09-03'
status: 'done'
route: 'one-shot'
---

# Auto-stop prompt survives the late mic release

## Intent

**Problem:** The "Meeting ended" countdown overlay vanished on its own — reproducibly when a Google Meet call ran in its own Chrome window and that window was closed. The call-detect monitor's `micInactive` handler tore down the prompt window unconditionally, even though that window belonged to the auto-stop countdown; the countdown then kept running unseen and stopped the recording anyway. It only bit when our own capture was not holding the mic, which is why it looked intermittent.

**Approach:** Route the call-detect teardown paths through `closeCallPrompt()`, which stops at a running auto-stop countdown. Hardened the shared window while in there: `showPromptWindow()` closes any existing panel before creating a new one, and the `closed` handler only nulls the handle it owns — otherwise a replaced panel could be orphaned always-on-top with nothing left to close it.

## Suggested Review Order

1. [The guard itself](../../desktop/main.js:4614) — does "a countdown is running" correctly mean "this window is not call-detect's to close"?
2. [Call-detect teardown paths](../../desktop/main.js:4479) — `stopCallMonitor` and [`micInactive`](../../desktop/main.js:4490) now defer to the guard.
3. [Single-panel invariant](../../desktop/main.js:4502) — close-before-show, plus the [identity-checked `closed` handler](../../desktop/main.js:4552).

Verified: `node --check desktop/main.js`, `npm test` (64/64). `main.js` has no test coverage by project convention — the Meet-window-close scenario needs a live meeting to confirm end to end.
