---
title: 'Deferred-work triage, round 3'
type: 'bugfix'
created: '2026-09-04'
status: 'done'
route: 'one-shot'
review_loop_iteration: 0
context: []
---

## Intent

**Problem:** Four independent, root-caused bugs sat open in `deferred-work.md`: an actively-recording wav shows in the library as an ordinary selectable/batch-deletable row; Ollama calls have no way to raise the context window a small local model silently truncates against; the post-generation result modal renders every summary section flat instead of the rail's 41-kind layout; and `record:deleteTranscript`/`record:deleteSummary` are dead IPC handlers with zero renderer callers since an earlier spec deleted their only caller.

**Approach:** Fix each at its root cause — filter `record:list` and broadcast around the in-memory `outputPath` state main already tracks for Record and Live; thread a new user-set `contextTokens` setting through a shared `ollamaOptions()` request-options builder; swap the modal to call the rail's own `buildStructuredHtml()`/`renderRailSection()` and delete the now-dead two-branch duplicate plus its CSS; remove the two orphaned handlers and their preload bridges. A blind-hunter review of the first pass caught a real regression it introduced (a failed Live save would hide its recording forever) plus a redundant broadcast, a lost visual divider, unbounded/fractional input, and a missing unit test — all closed in the same pass.

## Suggested Review Order

**Recording-in-progress hidden from the library**

- Entry point: the actual filter — a wav either in-flight object still points at is excluded before it can become a row.
  [`main.js:3572`](../../desktop/main.js#L3572)

- Every site that clears `outputPath` also tells the renderer to re-poll, so the row reappears the instant it's safe to select.
  [`main.js:3222`](../../desktop/main.js#L3222)

- The redundant second broadcast on a normal Stop was removed — the persistent `exit` listener already covers it.
  [`main.js:3527`](../../desktop/main.js#L3527)

- Review-round fix: a failed Live save no longer strands the wav hidden forever.
  [`main.js:3203`](../../desktop/main.js#L3203)

**Ollama context-size (`num_ctx`) knob**

- The shared builder both Ollama call sites route through — blank/invalid means no `options` key, unchanged default behavior.
  [`main.js:1448`](../../desktop/main.js#L1448)

- One validated-int helper backs both the settings sanitizer and the request builder, with a shared upper bound.
  [`main.js:1028`](../../desktop/main.js#L1028)

- Persistence: the new field round-trips through `settings:setSummarizer` alongside the existing Ollama fields.
  [`main.js:1129`](../../desktop/main.js#L1129)

- Settings UI: field, populate-on-open, and save payload for the new input.
  [`app.js:4966`](../../desktop/renderer/app.js#L4966)

- Review-round fix: reject fractional/out-of-range input outright instead of silently flooring it.
  [`app.js:5169`](../../desktop/renderer/app.js#L5169)

- The `<input>` itself, with the same `max` as the main-process cap.
  [`index.html:1198`](../../desktop/renderer/index.html#L1198)

**Result modal reuses the rail's section renderer**

- The one-line swap: the modal's now-deleted two-branch renderer is replaced by the rail's own structured-HTML builder.
  [`app.js:4299`](../../desktop/renderer/app.js#L4299)

- Review-round fix: a modal-scoped divider restores the visual separation the deleted `.smr-section` used to draw, without touching the rail's own (borderless) look.
  [`style.css:2260`](../../desktop/renderer/style.css#L2260)

**Dead IPC handler removal**

- `record:deleteTranscript`/`record:deleteSummary` and their preload bridges are gone together, leaving nothing orphaned on either side.
  [`preload.js:140`](../../desktop/preload.js#L140)

**Tests**

- New coverage for `ollamaOptions()`'s four edge cases (unset, valid, out-of-range, fractional), added because none existed.
  [`test/ollama-options.test.js`](../../desktop/test/ollama-options.test.js#L1)
