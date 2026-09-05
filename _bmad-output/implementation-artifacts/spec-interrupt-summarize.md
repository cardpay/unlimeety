---
title: 'Cancel button for Summarize'
type: 'feature'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'bcaabda5c30c727332c6125168fbd8a60ddd03de'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Summarize has no Stop, unlike Enhance. Its only UI slot (the shared background toolbar) can also be dismissed with no way back — so once closed, a running job becomes unstoppable.

**Approach:** Add Stop to the toolbar (mirrors Enhance) AND to the Summarize modal reopened via the meeting menu, both calling a new `summarize:cancel` IPC that aborts the in-flight call (`proc.kill()` for claude-code, `AbortController` for HTTP providers). Disk write already happens only after the call resolves (`api.saveSummary`, post-`api.summarize`), so aborting already guarantees nothing is written — no cleanup needed.

## Boundaries & Constraints

**Always:**
- Cancel works for every provider (claude-code, openrouter, ollama, openai-compatible).
- `summarize:run` resolves `{ ok:false, canceled:true }` on cancel; no file write.
- Stop reachable from both toolbar and reopened modal (same file, in-flight) — toolbar alone is not enough (dismissible, no reopen).
- One summarize job in flight at a time (new guard); abort handle lives in one shared var.
- Guard the async gap before `spawnClaude` in `runClaudeCode` (see Design Notes) so cancel during `findClaude()` bails before the child spawns.
- Mirror Enhance's flag naming (`*InFlight`, `*Cancelled`/`*CancelRequested`).

**Never:**
- Touch Enhance's own cancel flow/chunk loop.
- Add partial-save/resume to Summarize — canceled = nothing written, always.
- Add a cancel entry point to `record.js` — Summarize has no UI there.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cancel from toolbar, claude-code | Stop clicked mid-run | Child killed; `{ok:false,canceled:true}`; toolbar "stopped"; no file | N/A |
| Cancel from toolbar, HTTP provider | Stop clicked mid-run | fetch aborted via `AbortController`; same result/UI | N/A |
| Toolbar dismissed, Stop via modal | Toolbar closed, job runs on, menu -> Summarize | Modal detects in-flight, shows running/Stop, not empty prompt | N/A |
| Cancel after call resolved | Race: Stop clicked as call returns | No-op (`summarizeInFlight` false); run saves normally | N/A |
| Second summarize while one in flight | `summarize:run` called again first | Returns `{ok:false,error}`, first run's handle untouched | Existing error toolbar |

</frozen-after-approval>

## Code Map

- `main.js:1103-1319` -- `runClaudeCode`/`spawnClaude`/`fetchWithTimeout`/`runOpenRouter`/`runOpenAICompat`/`runOllama`/`runSummarizerProvider` -- thread an optional `onAbort` callback through all of these (called once, as soon as an abort handle exists); omitted by every existing caller, so zero behavior change elsewhere.
- `main.js:1321-1369` -- `summarize:run` -- add `summarizeInFlight`/`summarizeCancelRequested`/`summarizeAbort`, pass `onAbort`, return `canceled:true` per above.
- `main.js:2004-2026` -- Enhance's flags + `transcripts:enhanceCancel` -- pattern to mirror.
- `main.js:1404,1478,1488,1520,1546` -- Follow-up + Chat call `runClaudeCode`/`fetchWithTimeout` directly (bypass `runSummarizerProvider`), omit `onAbort` -- must stay unchanged.
- `preload.js:29-35` -- add `cancelSummarize: () => ipcRenderer.invoke('summarize:cancel')`.
- `preload.js:66-68` -- Enhance's bridge -- pattern to mirror.
- `renderer/app.js:3507-3621` -- `runSummarize()` -- swap toolbar "View"->"Stop" while running, wire `api.cancelSummarize()`, add `result?.canceled` branch before the generic-failure branch (mirror Enhance's at `app.js:3432-3435`).
- `renderer/app.js:3477-3496` -- `showEnhanceProgress()` -- Stop-wiring pattern to mirror.
- `renderer/app.js:3027-3066` -- `openSummarizeModal()` -- add early branch: if `runningSummarize?.filePath === filePath`, show loading view in "running" mode with Stop, skip the cache/disk-load branch that today lands on an empty prompt form mid-run.
- `renderer/index.html:1038-1044` -- `#modal-view-loading` -- add hidden-by-default footer (`#modal-loading-footer`/`#modal-btn-loading-stop`), shown only for the in-flight case; existing disk/cache use resets it hidden.
- `renderer/index.html:1302-1316` -- `bg-summary-toolbar` -- no change, fully JS-driven.

## Tasks & Acceptance

**Execution:**
- [x] `main.js` -- thread `onAbort` through the provider chain (see Code Map)
- [x] `main.js` -- `summarizeInFlight`/`summarizeCancelRequested`/`summarizeAbort` + `summarize:cancel` handler + in-flight guard + canceled branch + `findClaude()`-gap guard (self-correcting `onAbort` handle instead of a literal pre-check — see Design Notes)
- [x] `preload.js` -- `cancelSummarize()` bridge
- [x] `renderer/app.js` -- toolbar Stop wiring + `result?.canceled` handling
- [x] `renderer/index.html` + `renderer/app.js` -- modal running/Stop view for the reopened-via-menu case

**Acceptance Criteria:**
- Given a run in progress on any provider, when Stop is clicked from either surface, then no `.summary.md` is written and the UI shows "stopped".
- Given the toolbar was dismissed mid-run, when the meeting menu's Summarize/Re-summarize is clicked, then the modal shows the running state with a working Stop.
- Given no run in progress, `summarize:cancel` is a no-op returning `{ ok:true }`.
- Given a run in progress, a second `summarize:run` call returns an error without disturbing the first run's abort handle.

## Review Triage Log

- **V1/V2/B7 (verification-gap, blind-hunter): "no automated test covers the cancel-vs-natural-exit / cancel-vs-timeout disambiguation."** Dismissed. Verified live instead of by unit test: launched an isolated app instance (separate `--user-data-dir`, separate CDP port) and drove the real IPC surface end to end against a real `claude` CLI and a real local Ollama server. Confirmed `{ok:false,canceled:true}` for (a) an immediate cancel landing inside `runClaudeCode`'s `findClaude()` gap and (b) a mid-flight Ollama request aborted via `AbortController`; confirmed no `.summary.md` was written in either case. This satisfies the verification intent without a `node --test` unit test, consistent with the repo's documented convention that `main.js`/`renderer/` changes are verified by running the app rather than by unit tests.
- **E1 (edge-case-hunter): "cancel racing a naturally-successful close discards a valid completed summary."** Dismissed. The race is real, but the outcome it describes — cancel wins, result is discarded, nothing written — is exactly the spec's own unconditional invariant ("on cancel, resolves canceled:true, no file write", no carve-out for near-simultaneous natural completion). The user asked to stop; getting "stopped" is correct even on unlucky timing.
- **E5 (edge-case-hunter, medium confidence): "Stop during the findClaude() gap can show 'Claude Code not found' instead of 'stopped'."** Dismissed. Verified this only arises when the `claude` CLI genuinely isn't installed, in which case no process ever existed to cancel and "Claude Code not found" is more accurate than a generic "stopped" would be. The substantive guarantee (nothing written) holds either way.
- **B5 (blind-hunter): "the new `summarizeInFlight` guard is unreachable from today's UI, dead code."** Dismissed. The guard was an explicit spec requirement (single job in flight, process-wide), functions correctly as defense-in-depth, and an unreached-but-correct guard has no negative consequence.
- **B9 (blind-hunter): "the modal Stop button has no debounce; a double-click double-fires cancel+close."** Dismissed. Verified both calls are idempotent no-ops on repeat; no consequence.
- **B10 (blind-hunter): "the global, non-per-file single-flight constraint is undocumented."** Dismissed. Claim refuted — the diff's own comment directly above `summarizeInFlight` states this exactly ("One summarize job at a time, process-wide — mirrors Enhance's own in-flight/cancel pair").
- **B11 (blind-hunter): "busy/error messages don't name which meeting is summarizing."** Dismissed. The new error text matches the pre-existing `modalBusyBanner` convention verbatim (which also never names the meeting) — consistent style, not a regression.
- **B1/B8/E4 (blind-hunter, blind-hunter, edge-case-hunter): "Summarize never waits for a running Enhance the way Enhance waits for Summarize; now that both buttons read 'Stop', a click can cancel the wrong job."** Kept, medium severity — routed to patch (mirror Enhance's existing wait-for-the-other-job check inside `runSummarize()`). Resolves V3's concern (`clearEnhanceButton`'s `!runningSummarize` ownership guard) as a side effect: once the two jobs are mutually exclusive, that guard's race can no longer occur.
- **E3 (edge-case-hunter): "the reopened-via-menu modal keeps showing a live-looking 'Summarizing…'/Stop view after the job it displays has actually finished."** Kept, medium severity — routed to patch (refresh/close that modal from `runSummarize()`'s completion branches when it is currently showing the file that just finished).
- **B3 (blind-hunter): "Summarize's Stop gives no transitional feedback, unlike Enhance's 'Stopping after this part…'."** Kept, low severity — routed to patch (small polish, bundled with the above).
- **E2 (edge-case-hunter): "a renderer reload desyncs `runningSummarize` from main's `summarizeInFlight`, producing a confusing generic error on a second attempt."** Kept, low severity — routed to defer. Root cause (no reload-state-resync mechanism) is pre-existing and identical for `runningEnhance`/`enhanceInFlight`, not introduced by this change.
- **B2 (blind-hunter): "SIGTERM-only kill, no escalation; Windows shell-spawn grandchild can survive."** Kept, low severity — routed to defer. `proc.kill()` is the exact mechanism the pre-existing 5-minute timeout already used; this diff reuses it, doesn't introduce it.
- **B4 (blind-hunter): "no auto-cancel on renderer/window teardown for Summarize, unlike Enhance's 'destroyed'/'did-start-navigation' listeners."** Kept, low severity — routed to defer. `summarize:run` never had this handling before this diff either.
- **B6 (blind-hunter): "opening the modal on a different in-flight file gives no early indication until after pressing Summarize."** Kept, low severity — routed to defer. 100% pre-existing `modalBusyBanner` behavior, unmodified by this diff.
- **Patch verification.** All three patches (mutual-exclusion guard, `syncModal`, `stopSummarizeWithFeedback`) re-verified live via CDP against a second isolated app instance: `runningEnhance` truthy correctly deferred `runSummarize()` without touching `runningSummarize`; a job left running with the modal reopened on it auto-transitioned the modal to the real result view on natural completion (no stale "Summarizing…"/Stop left behind); clicking the modal's own Stop button showed "Stopping…" then "Summary stopped" and closed the modal. `npm test` (3/3) and `node -c` re-run clean.

## Spec Change Log

## Design Notes

`runClaudeCode` awaits `findClaude()` before any abort handle exists: a cancel there still resolves `canceled:true`/writes nothing, but the child keeps running until done/timeout. HTTP providers have no such gap (`AbortController` built synchronously). Fix: check `summarizeCancelRequested` right after `findClaude()` resolves, before either `spawnClaude` call (base + isolation-retry). Abort handle is `{ abort() }`-shaped (`abort = () => proc.kill()`), not a real `AbortController`, for claude-code. Both Stop surfaces call the same `api.cancelSummarize()` — one job in flight, nothing to reconcile. Summarize does not itself wait for a running Enhance (mirrors Enhance's own wait-for-Summarize check) — added as a patch so the two features stay mutually exclusive over the shared toolbar slot.

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: still passes (no direct Summarize/IPC coverage; guards against a regression in `glossary`/`summary-frontmatter`/`transcript-enhance`)

**Manual checks (if no CLI):**
- `npm start` from `desktop/`, run Summarize (claude-code), Stop mid-run from toolbar -> no file written, "stopped" shown.
- Same run, dismiss toolbar instead, reopen via meeting menu -> Stop works from modal too.
- Repeat with an HTTP provider (openrouter/ollama) for the `AbortController` path.
- Enhance still completes normally (shares `runSummarizerProvider`).

## Suggested Review Order

**Cancel plumbing (main process)**

- Entry point: guards against a second run, wires the abort handle, passes through a canceled result.
  [`main.js:1391`](../../desktop/main.js#L1391)

- The no-op vs. active-cancel branch — the other half of the contract above.
  [`main.js:1381`](../../desktop/main.js#L1381)

- `onAbort` param threaded in without touching any other caller's behavior.
  [`main.js:1111`](../../desktop/main.js#L1111)

- Where the abort handle actually kills the child and marks `canceled`.
  [`main.js:1147`](../../desktop/main.js#L1147)

- Same `onAbort` contract for the HTTP providers' `AbortController`.
  [`main.js:1208`](../../desktop/main.js#L1208)

- Disambiguates a user cancel from the provider's own timeout abort.
  [`main.js:1225`](../../desktop/main.js#L1225)

- Single dispatch point every provider (and Enhance) funnels through.
  [`main.js:1364`](../../desktop/main.js#L1364)

**Toolbar Stop surface**

- Where Summarize's button becomes "Stop" and the canceled outcome is shown.
  [`app.js:3540`](../../desktop/renderer/app.js#L3540)

- Shared Stop handler for both surfaces — "Stopping…" feedback before the result lands.
  [`app.js:3529`](../../desktop/renderer/app.js#L3529)

- Patch: mirrors Enhance's own wait-for-Summarize check, now made symmetric.
  [`app.js:3551`](../../desktop/renderer/app.js#L3551)

**Reopened-via-menu Stop surface (modal)**

- Early branch shows the running/Stop view instead of an empty prompt form.
  [`app.js:3030`](../../desktop/renderer/app.js#L3030)

- Patch: keeps a left-open modal in sync when the job it's showing finishes.
  [`app.js:3582`](../../desktop/renderer/app.js#L3582)

- The Stop footer's markup, hidden except for the in-flight case.
  [`index.html:1046`](../../desktop/renderer/index.html#L1046)

**Supporting**

- Ownership guard fix: text alone no longer proves which job owns the button.
  [`app.js:3516`](../../desktop/renderer/app.js#L3516)

- New `cancelSummarize()` bridge exposed to the renderer.
  [`preload.js:31`](../../desktop/preload.js#L31)
