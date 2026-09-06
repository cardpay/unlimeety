---
title: 'Transcript search scrolls to the match in Edit mode'
type: 'bugfix'
created: '2026-09-06'
status: 'done'
route: 'one-shot'
---

# Transcript search scrolls to the match in Edit mode

## Intent

**Problem:** In Edit mode, the transcript's Find bar (⌘F) correctly locates and selects a match inside the `#editor` textarea, but never scrolls the textarea to reveal it — `setSelectionRange()` sets the selection without scrolling, unlike the DOM-`Range`-based path used in normal (View) mode.

**Approach:** Add a scroll-to-offset routine for the textarea case that mirrors the existing DOM-geometry approach: an offscreen `<div>` clone (copying every text-affecting CSS property, sized from `clientWidth` to exclude the scrollbar) measures where the match's line actually falls, then `goto()` scrolls `#editor` to center it — the same centering rule already used for the View-mode `Range` path.

## Suggested Review Order

- Entry point: the scroll routine itself, and why a plain DOM measurement can't work for a `<textarea>`'s internal text.
  [`find-in-note.js:218`](../../desktop/renderer/find-in-note.js#L218)

- Wiring: `goto()`'s `"ta"` branch now scrolls before handing focus back to the find input.
  [`find-in-note.js:258`](../../desktop/renderer/find-in-note.js#L258)
