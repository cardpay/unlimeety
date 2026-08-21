---
title: 'Auto-queue transcribe → enhance after a Live recording'
type: 'feature'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 1
context: []
baseline_commit: '315e5b1245fc01db2f67fc9136af6abf1229980d'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** After a Live session ends, the streaming transcript is never automatically re-run through a bigger batch model or Enhanced, even though both are one-click manual actions today from the Library menu.

**Approach:** On every Live "Stop & save", background-queue a `large-v3` re-transcription (language inherited from that session, speaker count auto). Any transcription that finishes cleanly — this Live-triggered one, a manual "Transcribe"/"Re-transcribe…" click, or a batch run — queues an Enhance pass over its own result. One small in-process FIFO queue in `main.js` reuses the existing manual `record:transcribe` / `transcripts:enhance` handler logic verbatim (parameterizing their hardcoded event-sink) and waits for the existing single-slot guards instead of erroring when busy. Also expose the queue's transcribe entry point as a new `record:autoQueueTranscribe` IPC handler — unused by any UI yet, but the hook a later Record-tab toggle (tracked in `deferred-work.md`) will call.

## Boundaries & Constraints

**Always:**
- The Live-triggered pipeline's transcribe step is always `openai_whisper-large-v3`, `diarize: true`, `numberOfSpeakers` unset (auto). A manual Transcribe/Re-transcribe run keeps using whatever model/settings the user picked on the transcribe-settings screen — only its *Enhance chaining* is new, not its transcribe parameters.
- Language for the Live-triggered pipeline comes from the Live session's own `language` (as already passed into `live:saveTranscript`) — no new UI.
- Enhance is queued after ANY transcribe job that finishes cleanly (not partial/interrupted, not discarded by the staleness guard) — whether that job was manual (single click, "Re-transcribe…", or a batch run) or the Live-triggered auto-queue entry.
- Auto-queued jobs reuse the exact same core logic as the existing manual handlers (same validation, chunking, fail-closed merge) — no duplicated logic.
- `record:autoQueueTranscribe`'s `filePath` goes through `canReadPath` per project convention.

**Ask First:** none — resolved defaults below are reviewable at the plan checkpoint via [E] Edit.

**Never:**
- Never persist the queue across app restarts, and never build a visible progress/queue UI for it — console-log failures only.
- Never surface auto-job progress on the `record:event` / `transcripts:enhanceProgress` channels the interactive UI listens on — would misleadingly animate Record/Library screens for a file nobody is looking at.
- Do not build any Record-tab UI in this pass — deferred (see `deferred-work.md`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Live stop, happy path | Live session ends, wav written | `large-v3`/auto-speakers transcribe queued with that session's language, then Enhance queued on success | N/A |
| Manual job already running | User is mid manual Transcribe/Enhance when an auto job is queued | Auto job waits (polls) for the slot instead of failing | N/A |
| Auto transcribe fails/partial | Helper crash or interrupted run | No Enhance is queued | Logged via `console.warn` |
| Wav missing at Live save time | `live.outputPath` falsy or file gone | Nothing queued | N/A |
| `record:autoQueueTranscribe` called with a bad path | `filePath` outside managed folders / missing | `{ok:false}`, nothing queued | Same `canReadPath` gate as `record:transcribe` |
| Manual "Transcribe"/"Re-transcribe…" finishes cleanly | User-initiated single or batch transcribe succeeds | Enhance is queued for the resulting transcript, same as the Live-triggered path | N/A |
| Manual transcribe is cancelled or interrupted | User clicks Cancel, or a partial/`.partial.txt` run | No Enhance is queued | N/A |
| Staleness guard discards a transcribe write | File changed since the job started (any caller) | No Enhance is queued (nothing fresh to enhance) | `{ok:false, error:'Transcript changed...'}` |

</frozen-after-approval>

## Code Map

- `desktop/main.js:2743-2838` (`live:saveTranscript`) -- has `language`/`wavPath` in hand; add the enqueue call before its success `return`.
- `desktop/main.js:3474-3714` (`record:transcribe`) -- extract to a named function taking a `sendEvent` callback (hardcodes `recordSendToRenderer` at ~3513, 3533, 3538); `ipcMain.handle` keeps the real callback, the queue passes a no-op.
- `desktop/main.js:2113-2259` (`transcripts:enhance`) -- extract to a named function taking a `sender` object instead of `event.sender` (~5 usages); `ipcMain.handle` keeps `event.sender`, the queue passes a silent shim.
- `desktop/main.js:2094-2095, 3478` (`enhanceInFlight` / `transcriber.proc`) -- existing single-slot guards the queue polls against.
- `desktop/main.js:31` (`mainWindow`) -- backs the silent shim's `isDestroyed`.
- New: FIFO array + drain loop near `transcriber`/`enhanceInFlight` (~line 2095); new `ipcMain.handle('record:autoQueueTranscribe', ...)` near `record:stop` (main.js:3080).

## Tasks & Acceptance

**Execution:**
- [ ] `desktop/main.js` -- extract `runRecordTranscribeJob(opts, sendEvent)` and `runEnhanceJob(filePath, sender)` from the two existing handlers; wire `ipcMain.handle` to call them with today's real callbacks -- lets the auto-queue reuse them with a silent sink, zero logic duplication.
- [ ] `desktop/main.js` -- add the FIFO queue (`enqueueAutoPipeline(filePath, language)` + drain loop polling the two busy-flags every 2s, pushing an `enhance` job after a successful `transcribe` job) -- the actual chaining mechanism.
- [ ] `desktop/main.js` -- call `enqueueAutoPipeline(wavPath, language)` at the end of `live:saveTranscript` when `wavPath` exists -- the Live entry point.
- [ ] `desktop/main.js` -- add `ipcMain.handle('record:autoQueueTranscribe', ...)` validating `filePath` via `canReadPath` AND `process.platform === 'darwin'` (same platform gate `record:transcribe` has, checked at this entry point rather than one queue-drain cycle later) -- the reusable hook for the deferred Record-tab UI.
- [ ] `desktop/main.js` -- inside `runRecordTranscribeJob`, before its final `fs.writeFileSync(transcriptPath, ...)`, add a staleness guard mirroring `runEnhanceJob`'s own (main.js, the `current !== original` check before its write): capture the target transcript file's content (or absence) at job start, and if the file now differs just before writing (edited, renamed away, or deleted), skip the write, return `{ok:false, error:'Transcript changed since transcription started — nothing was written.'}`, and do not chain Enhance. Applies to both the auto-queue and the existing manual `record:transcribe` caller, since it's the same shared function -- prevents the auto-queue's background write from racing the editor's autosave (Live auto-opens the transcript immediately after save, so this is a likely path, not a rare one) or clobbering a rename/delete that happened while the job was queued.
- [ ] `desktop/main.js` -- reword the auto-queue's introductory comment: only a job still sitting in `autoPipelineQueue` (not yet dequeued) is lost on quit/crash; a job already running when quit begins goes through the existing `transcriber`/`enhanceInFlight` quit-flush behavior (wait, then mark partial/interrupted) exactly like any other manual run -- the current wording overstates what's actually lost.

**Acceptance Criteria:**
- Given a Live session with language `en`, when the user clicks Stop & save, then a `large-v3`/auto-speaker transcribe job runs against that session's wav and, on success, an Enhance pass runs against the resulting transcript — with no manual action.
- Given a manual Enhance is in flight, when an auto-queued transcribe job's Enhance step comes up, then it waits for the slot rather than being dropped or erroring.
- Given `record:autoQueueTranscribe` is invoked directly (e.g. from DevTools) with a valid recording path, then the same transcribe → Enhance pipeline is queued for it.
- Given a transcript file changes (edited, renamed, or deleted) between a transcribe job starting and its write, then no write happens, no Enhance is chained, and the guard behaves identically whether the caller was the auto-queue or the existing manual `record:transcribe`.
- Given a user manually clicks "Transcribe" or "Re-transcribe…" (single file or as part of a batch) and it finishes cleanly, then an Enhance pass is queued for the resulting transcript exactly as it would be for the Live-triggered path.

**Execution (added after human renegotiation, post-ship):**
- [x] `desktop/main.js` -- move the "queue an Enhance job" step from the auto-queue's own `.then()` callback into `runRecordTranscribeJob`'s clean-success return path, so it fires for every caller (manual single/batch transcribe, "Re-transcribe…", and the auto-queue) rather than only the auto-queue's own transcribe entries.

## Spec Change Log

- **Renegotiation (post-ship, human-directed):** user asked whether a manual re-transcription also chains to Enhance, and confirmed the desired scope covers *any* manual transcription (first-time or re-transcribe, single or batch), not just re-transcribes of an already-existing file.
  **Amended:** removed the frozen "Never auto-chain Enhance after existing manual Transcribe/Re-transcribe/batch flows" boundary; Intent, Boundaries, and I/O matrix updated to reflect that any clean transcribe success chains Enhance regardless of caller.
  **Avoids:** re-implementing a scope the human explicitly asked to broaden.
  **KEEP:** the Live-triggered pipeline's own transcribe parameters (`openai_whisper-large-v3`, `diarize:true`, auto speakers, language from the Live session) are unchanged and still apply only to that path — a manual transcribe keeps using whatever the transcribe-settings screen has configured. Only the *Enhance-chaining* behavior was broadened, not the Live pipeline's own model/language defaults.

- **Finding (review, iteration 1, `bad_spec`):** `runRecordTranscribeJob`'s write had no staleness check, unlike `runEnhanceJob`'s existing before/after content guard — and because Live auto-opens the just-saved transcript in the editor, the auto-queue's background write is likely (not rare) to race the editor's autosave, silently losing either the user's edit or the improved batch transcript depending on timing.
  **Amended:** added a Task requiring a staleness guard on `runRecordTranscribeJob`'s write (mirrors `runEnhanceJob`'s pattern), plus two small `patch`-tier tasks (platform check on `record:autoQueueTranscribe`, clearer quit/crash comment) folded into the same pass since a full re-implementation was already required.
  **Avoids:** silent data loss on the single highest-likelihood race this feature introduces.
  **KEEP:** everything else from iteration 0 was sound and should be re-derived unchanged — the extraction of `runRecordTranscribeJob`/`runEnhanceJob` taking a callback/sender parameter, the `setInterval`-based drain gating strictly on the queue head's own resource guard (not both guards together), the `silentEnhanceSender` shim, and hardcoding `openai_whisper-large-v3`/`diarize:true`/auto-speakers with no new UI. Findings about lost speaker-name overrides/participants/title, confusing busy-error messages, queue de-dup/cap/visibility, and the rename/delete race were triaged as pre-existing or out-of-scope and logged to `deferred-work.md` instead of amending this spec.

## Design Notes

Busy-flag poll (2s) is a deliberate `ponytail:` simplification — no event-driven wakeup, no persistence, a not-yet-started queued job is lost on quit/crash — matching every other in-memory job state already in this file (`transcribingPaths`, `pendingBatchTargets`, `enhanceInFlight`). Silent sink for the reused enhance job:
```js
const silentEnhanceSender = {
  send() {}, once() {}, on() {}, off() {},
  isDestroyed() { return !mainWindow || mainWindow.isDestroyed(); },
};
```

Implement as a `setInterval(..., 2000)` drain tick rather than a while-loop, gating strictly on the *queue head's own* resource (`transcriber.proc` for a `transcribe` head, `enhanceInFlight` for an `enhance` head) instead of blocking on both guards together — an unrelated manual Enhance shouldn't stall a queued transcribe job, or vice versa. Required behavior (manual job in flight → matching auto step waits for its slot) must still hold.

Staleness guard shape (mirrors `runEnhanceJob`): read the transcript path's current content (or note it doesn't exist) right when the job starts running, and immediately before the write, re-check the same path — if content differs (or existence flipped), bail without writing.

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: still green (smoke check; no touched module is under test).
- `node --check main.js` -- expected: syntax OK.

**Manual checks (if no CLI):**
- Run a short Live session in a non-default language, Stop & save; confirm a second transcribe pass overwrites the transcript with better accuracy and an Enhance pass follows, with no UI interaction. Then repeat while a manual Enhance on another file is in flight — confirm the auto-queued Enhance waits instead of erroring or dropping.
- Edit the just-opened Live transcript (or let autosave fire) while its background re-transcription is still running; confirm the staleness guard skips the write rather than the two racing.

## Suggested Review Order

**Queue mechanism**

- Entry point: the FIFO array and why it's polled rather than pushed/awaited — sets up every other stop.
  [`main.js:2106`](../../desktop/main.js#L2106)

- Drain tick gates each queued step on only its own resource, so an unrelated manual job never wrongly blocks it.
  [`main.js:2129`](../../desktop/main.js#L2129)

- `enqueueAutoPipeline` — the only way anything lands in the queue; deliberately takes no other parameters.
  [`main.js:2125`](../../desktop/main.js#L2125)

**Shared job extraction (reuse over duplication)**

- `runEnhanceJob` takes a `sender`-shaped param instead of `event.sender`, so a silent shim can stand in for a real window.
  [`main.js:2174`](../../desktop/main.js#L2174)

- The manual `transcripts:enhance` handler is now a one-line delegate to the extracted function.
  [`main.js:2322`](../../desktop/main.js#L2322)

- `runRecordTranscribeJob` takes a `sendEvent` callback instead of calling `recordSendToRenderer` directly.
  [`main.js:3558`](../../desktop/main.js#L3558)

- The manual `record:transcribe` handler is now a one-line delegate to the extracted function.
  [`main.js:3830`](../../desktop/main.js#L3830)

**Staleness guard (added after review-loop iteration 1)**

- Snapshots the canonical transcript's content at job start, before the (possibly minutes-long) transcription runs.
  [`main.js:3591`](../../desktop/main.js#L3591)

- Re-checks against that snapshot right before the write; bails without writing (and without chaining Enhance) if it changed.
  [`main.js:3787`](../../desktop/main.js#L3787)

**Entry points**

- Live "Stop & save" is the one automatic trigger — queues with the session's own language, guarded on the wav still existing.
  [`main.js:2897`](../../desktop/main.js#L2897)

- `record:autoQueueTranscribe` — not called by any UI yet; the hook the deferred Record-tab toggle will use.
  [`main.js:3174`](../../desktop/main.js#L3174)
