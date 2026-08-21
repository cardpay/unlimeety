---
title: 'One visible job queue for every long-running operation'
type: 'feature'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
baseline_commit: '678dea0617d446f0aed1b0856615e922f807e01a'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every long-running operation owns a private single-slot guard and refuses work when busy — `summarizeInFlight` (`main.js:1393`), `enhanceInFlight` (`main.js:2189`), `transcriber.proc` (`main.js:3566`), plus three renderer refusals (`app.js:3408`, `3415`, `3549-3552`) where Enhance and Summarize fight over one shared toast. The user is told to wait instead of having the work accepted. The one real queue, `autoPipelineQueue` (`main.js:2106-2165`), is invisible by design — no progress, no errors, `console.warn` only — so its Live→re-transcribe→Enhance chain looks broken even when it runs.

**Approach:** One job queue in the main process owns every transcribe, enhance and summarize run. Submitting always succeeds and returns a job id; jobs run one at a time per resource lane (transcribe / enhance / summarize), so independent lanes never block each other. Main broadcasts the queue on every state change; a header indicator expands into a job list showing what runs, what waits, and what failed and why, with per-job cancel.

## Boundaries & Constraints

**Always:**
- Submitting a job always succeeds. No handler may reject work because something else is running.
- One running job per lane; lanes are independent (an Enhance never waits behind an unrelated transcribe).
- Executors stay `runRecordTranscribeJob`, `runEnhanceJob` and the `summarize:run` body — the queue schedules them, it does not reimplement them.
- A submit whose `(type, filePath)` is already queued or running returns that job instead of adding a second.
- Every failure carries its error text into the queue state and the panel; `console.warn`-only reporting is removed.
- Cancel works on queued jobs (drop) and running jobs (route to that lane's existing cancel: helper stdin `stop`, `enhanceCancelled`, `summarizeAbort`).
- Auto-queued Live jobs are ordinary visible jobs — `silentEnhanceSender` goes away.
- Paths keep passing `canReadPath` / `canWritePath` / `isPathInside` as today.

**Ask First:** none.

**Never:**
- Never persist the queue across restarts, and never retry — a failed job stays failed until re-submitted.
- Never run two jobs in one lane concurrently: the WhisperKit helper and the summarizer provider are single-slot.
- Do not change transcription models, parameters, or the Swift helper.
- Do not add settings or per-job configuration UI.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lane busy | Enhance running, user enhances another transcript | Second job accepted as `queued`, starts when the first ends | N/A |
| Cross-lane | Transcribe running, user clicks Summarize | Summarize starts at once; both visible as running | N/A |
| Duplicate | Same file+type already queued or running | Existing job id returned, queue length unchanged | N/A |
| Batch | User selects N recordings, confirms | N jobs enqueued at once, drained in order, each visible | One failure leaves the rest running |
| Live save | Live session saved with a wav | `transcribe` job, then `enhance` on its result — both visible | Error text shown in the panel |
| Cancel queued | Cancel a waiting job | Removed before it starts; nothing written | N/A |
| Cancel running | Cancel the running job | Lane's existing cancel path runs; job ends canceled | Partial output as today |
| Failure | Missing model, provider error, staleness refusal | Job marked `failed` with its error; lane continues | Error visible in panel |

</frozen-after-approval>

## Code Map

- `main.js:1374-1466` -- summarize: `summarizeInFlight` 1377, `summarizeCancelRequested`/`summarizeAbort` 1378-1379, refusal 1393, `summarize:cancel` 1381, `summarize:run` 1391. No progress channel today.
- `main.js:2090-2325` -- enhance: flags 2094-2095, refusal 2189, `runEnhanceJob(filePath, sender)` 2177, `sender` drives `transcripts:enhanceProgress` 2230 and teardown 2218-2219/2321, `transcripts:enhanceCancel` 2167, `transcripts:enhance` 2325.
- `main.js:2106-2172` -- `autoPipelineQueue` to delete: array 2119, `silentEnhanceSender` 2123, `enqueueAutoPipeline` 2128, 2s poll 2132-2165. Producers: `live:saveTranscript` 2900, `record:autoQueueTranscribe` 3177-3184, self-chained enhance 3831.
- `main.js:2988-3855` -- transcribe: `transcriber` 2995-3003, refusal 3566, `runRecordTranscribeJob(opts, sendEvent)` 3562, `recordSendToRenderer` 3005 → `record:event` 3007, `record:transcribe` 3839, `record:cancelTranscribe` 3841.
- `main.js:193-259` -- quit flush: `noteSessionFlushed(slot)` 205, slots `live`/`record`/`transcriber`; enhance has its own `before-quit` 2104. Read-only context: keep current behavior for an already-running job.
- `preload.js` -- namespaces `transcriber` 3, `live` 84, `recordApi` 112, `notesApi` 154. Copy `notesApi.onChanged` 166-170 (returns a disposer). Preload *is* the channel allow-list; a channel exists only if hardcoded here.
- `renderer/index.html` -- CSP 6 forbids inline scripts. `<header id="toolbar">` 16-81 sits outside every `.tab-panel`, so `#toolbar-right` 60 is visible from all tabs; it holds a dead hidden `#btn-summarize` 71-78 and the precedent indicators `#recording-indicator`/`#live-recording-indicator` 50-57. Surfaces to remove: `#bg-summary-toolbar` 1307-1322, `#record-trans-queue` 924.
- `renderer/style.css` -- reuse, do not invent: `.meeting-menu`/`.meeting-menu-overlay` 1044-1114 (popover), `.status-pill[data-status]` 929-996, `.meeting-progress-bar` 904-918, `.bg-summary-toolbar[data-state]` icons 2363-2460, indicator button 112-130.
- `renderer/app.js` -- loads before `live.js`/`record.js` (`index.html:1340-1347`), so it hosts the panel. `runningSummarize` 3366, `showBgToolbar`/`hideBgToolbar` 3375-3388, `runningEnhance` 3399, refusals 3408/3415/3549-3552, `runEnhance` result + in-editor reload 3458-3490, `showEnhanceProgress` 3495, `api.cancelEnhance()` 3511, `loadLibrary` 1270, `transcript:created` listener 2870-2875.
- `renderer/record/record.js` -- `runBatchTranscribe` 1350-1400 (renderer-side sequential loop to remove), `updateTranscribeQueue`/`clearTranscribeQueue` 851-883, `startTranscription` 793, progress via `api.onEvent` 676.
- `renderer/app.js:1476-1541` and `renderer/record/record.js:1791-1870` -- the two meeting menus (template-string vs manual DOM); both disable items from an `enhancing` boolean the queue replaces. Keep them in step.
- `renderer/live/live.js:223-237` -- `switchTab` lives here; 415-425 dispatches `transcript:created`.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- entries 2, 14, 26, 30, 42 describe defects this resolves; mark them resolved when done.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/job-queue.js` -- new module: job records `{id, type, filePath, title, status, progress, error}` plus `submit` / `cancel` / `list` and a lane-aware drain driven by completion, not a timer -- pure logic, no Electron imports, so it is unit-testable.
- [x] `desktop/test/job-queue.test.js` -- `node --test` coverage of the pure-scheduling matrix rows: lane independence, duplicate collapse, cancel-while-queued, failure not stalling a lane, FIFO within a lane.
- [x] `desktop/main.js` -- delete `autoPipelineQueue`/`silentEnhanceSender`; wire the three executors in as lane runners; turn `summarize:run`, `transcripts:enhance`, `record:transcribe` into submit-and-return-jobId handlers with refusals removed; add `queue:list`/`queue:cancel` and a `queue:changed` broadcast; route enhance chunk progress and transcribe events into the job's `progress`.
- [x] `desktop/preload.js` -- add a `queue` namespace (`list`, `cancel`, `onChanged` returning a disposer) -- the panel's only bridge.
- [x] `desktop/renderer/index.html` -- add the header indicator in `#toolbar-right` and a static container for the job list; remove `#bg-summary-toolbar` and `#record-trans-queue`.
- [x] `desktop/renderer/style.css` -- style the panel from the existing primitives; retire the unused `.bg-summary-*` rules.
- [x] `desktop/renderer/app.js` -- drop `runningEnhance`/`runningSummarize` and the three refusals; submit jobs, render the panel from `queue:changed`, keep the post-enhance in-editor reload by acting on the finished job's result.
- [x] `desktop/renderer/record/record.js` -- replace `runBatchTranscribe`'s loop with one submit per file; delete `updateTranscribeQueue`/`clearTranscribeQueue`.

**Acceptance Criteria:**
- Given a running job in any lane, when the user triggers any other long-running action, then it is accepted and no "already running" message appears anywhere in the app.
- Given jobs in the queue, when the user switches tabs, then the panel and its contents stay visible and identical.
- Given a failed job, when the user opens the panel, then that job's own error text is readable without devtools.
- Given a Live "Stop & save" with a saved wav, when the session ends, then a transcribe job and its chained enhance job both appear and run to completion.
- Given `npm test` in `desktop/`, when it runs, then existing suites and the new job-queue suite pass.

## Design Notes

Lanes, not one global slot: transcribe is bounded by the WhisperKit helper process, enhance and summarize by their provider calls. Independent lanes are what makes "never refuse" honest — a global slot would still serialize everything and merely hide the wait.

Executors keep their signatures; the queue supplies the sink that replaces the removed silent shim:

```js
const sink = (job) => ({
    send: (_ch, p) => updateProgress(job, p),
    once() {}, on() {}, off() {},
    isDestroyed: () => false,
});
```

`isDestroyed: () => false` is deliberate: a queued job outlives the window that submitted it, and teardown-on-navigation belonged to a renderer-owned run.

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: all suites pass, including the new job-queue tests.

**Manual checks:**
- `npm start`: start an Enhance, then immediately a Summarize and a Transcribe — all accepted, three rows in the panel, no error.
- Queue two Enhance jobs on different transcripts — the second shows `queued`, then runs.
- Cancel a queued job and a running job from the panel.
- Finish a Live session with audio — the re-transcribe job and then the chained enhance job appear.
