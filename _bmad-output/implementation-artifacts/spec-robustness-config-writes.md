---
title: 'Robustness: config writes, collisions, and resource bookkeeping (PR 4)'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'b138db6be3a1c7b8242c3c5cd4ab74edff881ad1'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `main.js` loses data and burns resources under ordinary conditions, not attack:
`writeConfig` is a plain `writeFileSync` (a crash mid-write corrupts `config.json`, silently taking
`apiKeyEnc`/custom prompts/glossary/`summaryNames` with it) and `readConfig` cannot tell "first run"
from "corrupt file" apart; Live and Record pick the same untitled wav filename when started in the
same minute; most transcript writers bypass the already-correct `writeFileAtomic`; `transcripts:list`
reads every file up to three times and never caps size; a decode of a multi-hour recording's waveform
can OOM the renderer; a rename can silently desync a transcript from its wav/summary; the job queue
re-serializes a full transcript's `content` to the renderer on every unrelated progress tick; Enhance
has no chunk-count cap; Windows `spawn` with `shell:true` mis-parses a `claude.cmd` path containing a
space; an uncaught exception/rejection skips every quit-time flush; and several smaller bookkeeping
leaks (`contentIndex`, `summaryNames`, `live.stderrBuf`) grow unbounded or misbehave at the edges.

**Approach:** Make every config/transcript write atomic and crash-safe (reuse the existing
`writeFileAtomic`, never invent a second write path), close the collision/desync races with the
narrowest state check available (an in-memory reservation, or `uniqueFilePath`'s bump), cap what gets
read/held/re-sent instead of processing unbounded input, and reuse the existing before-quit flush path
for fatal-error handling instead of adding a parallel shutdown path.

## Boundaries & Constraints

**Always:** Reuse `writeFileAtomic` (`main.js`, already correct: `wx`-opened random temp name, fsync,
rename-over-symlink) for every write this spec touches — never a second atomic-write helper. Preserve
every existing IPC handler's `{ok, ...}` return shape; add fields, never repurpose one. Windows
`shell:true` quoting only wraps `claudePath`, not `args` (args stay constant flags, already
injection-safe). `enhanceCancelled`/quit-flush changes must not alter behavior for the already-shipped
live/record quit-flush slots.

**Ask First:** Nothing new — every mechanism below is pinned (constants, thresholds, exact call sites).

**Never:** Touch PR 1/2 (already shipped: path guards, header sanitizing, Claude Code isolation, prompt
framing) or PR 3 (key exposure, preload split, sender validation — separate, later). Never add a new
dependency. Never change `job-queue.js`'s scheduling semantics (lane independence, `MAX_TERMINAL_JOBS`,
dedup) — only what a settled job's `result` retains. Never touch `.notes.json` size capping or the
watcher's debounce max-wait — real findings, but not in this PR's committed fix list (recorded as
deferred-work, not silently dropped).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `config.json` has truncated/corrupt JSON | Any `readConfig()` call | Returns `{}`; bad file renamed to `config.json.corrupt` (clobbering an older one); one `dialog.showErrorBox` | Never re-attempted per call — ENOENT on the next read |
| Live and Record both start untitled in the same minute | `live:start` then `record:start` (or reverse) | Second one's wav gets a `(2)` suffix, not the same path | N/A |
| A wav is 0 bytes or shorter than a WAV header | `queueAutoTranscribe(path, ...)` | Returns `null`; `record:autoQueueTranscribe` surfaces `{ok:false, error:'...'}`; `live:saveTranscript`'s fire-and-forget call is a silent no-op | N/A |
| Enhance's target file has 500+ chunks | `transcripts:enhance(filePath)` (no `confirmed` flag) | Returns `{ok:false, needsConfirmation:true, chunks:N}` instead of submitting | Renderer re-invokes with `confirmed:true` after asking |
| A renderer.write leaves `newAudioPath`/`newSummaryPath` already occupied | `transcripts:rename`/`record:rename` | Sibling is renamed to a bumped `(2)` name, never left un-renamed | N/A |
| An uncaught exception fires mid-Live-session | Any synchronous throw in main | `app.quit()` is called once, re-entering the existing before-quit flush (shows window, `triggerAutoStop`, waits up to `QUIT_FLUSH_TIMEOUT_MS`) | A second fatal error during the same flush is a no-op (already quitting) |

</frozen-after-approval>

## Code Map

- `main.js:63-77` `configPath`/`readConfig`/`writeConfig` — `readConfig` single catch swallows both ENOENT and corrupt JSON; `writeConfig` plain `writeFileSync`. `writeFileAtomic` (`:520`) already exists and is reused, not reinvented; `dialog` is already imported at the top of the file.
- `main.js:34-53` `queueAutoTranscribe` — no size floor before queuing; called by `live:saveTranscript` (fire-and-forget) and `record:autoQueueTranscribe` (`:3747`, whose renderer caller already renders `res.error` — `renderer/record/record.js:898-908`).
- `main.js:3097-3223` `live:start`, `main.js:3646-3715` `record:start` — each computes `defaultRecordingStem`/collision suffix independently via a bare `fs.existsSync` loop; neither checks the other's `live.outputPath`/`recorder.outputPath` (both objects already declared file-wide, `live` at `:2853`, `recorder` at `:3511`). `defaultRecordingStem`/`defaultRecordingPath` live at `:3601-3612`.
- `main.js:549-570` `writeTranscriptFile`, `:601-615` `file:saveAs`, `:2453-2481` `transcripts:create`, `:3313-3432` `live:saveTranscript`, `:3838-3844` `flushNotesSidecar`, `:3925-4020` `record:rename` (three raw writes: transcript, `.partial.txt`, and inside its rename fallbacks) — all use `fs.writeFileSync` directly; `canWritePath` (`:198`) is already defined and used elsewhere (`runEnhanceJob`) as the model to follow for `transcripts:create`/`live:saveTranscript`'s computed path.
- `main.js:2081-2154` `transcripts:list`, plus `readTranscriptInfoSync` (`:840`), `summaryFilePath`/`findExistingSummaryPath` (`:852`, `:891`), `findRelatedAudioPaths` (`:2248`) — each independently re-reads the same transcript's first 512 bytes and/or re-scans `RECORDINGS_FOLDER`; blank-line split uses plain `'\n\n'` (breaks on CRLF transcripts); no size cap. `spokenTurnsIndex`/`contentIndex` prune pattern already exists at `:2144-2149` for `spokenTurnsIndex` only.
- `renderer/app.js:831` `WAVEFORM_BARS`, `:881-904` `buildWaveform` — fetches the whole wav into an `ArrayBuffer` then `decodeAudioData`; `playerShowPath` (`:925`) already calls `renderPlaceholderWaveform()` before `buildWaveform` and already `.catch()`es a decode failure, so a thrown size-guard degrades to the placeholder for free.
- `main.js:2790-2847` `transcripts:rename`, `:3925-4020` `record:rename` — sibling wav/summary/`.partial.txt` renames silently no-op via `if (!fs.existsSync(newPath))` instead of bumping; `uniqueFilePath` (`:2443`) is the existing bump helper, reused as-is.
- `job-queue.js:33-49` `toPublic`, `:189-221` `runJob`'s completion `.then()` — `result.content` (set by `runEnhanceJob`, `main.js:2768`) stays on `job.result` through every later `emit()`; `renderer/app.js:4600-4617` `finishEnhance` is the only reader, and only once, at the transition where the job first appears terminal.
- `main.js:2522-2776` `runEnhanceJob`, `:2785-2788` `transcripts:enhance` handler — no chunk-count cap; `enhance.chunkBlocks`/`splitTranscript`/`parseBlocks`/`spokenTargets` (`transcript-enhance.js:832-844` exports) are cheap enough to call once more, pre-submission, to count chunks. `preload.js:72` `enhanceTranscript`, `renderer/app.js:4619-4639` `runEnhance` are the two other layers.
- `main.js:1336-1359` `spawnClaude` — `spawn(claudePath, args, {..., shell: process.platform === 'win32'})`; `claudePath` is unquoted, `args` are constant flags only (unaffected).
- `main.js:262-317` the main before-quit flush handler (`quitting`/`quitFlushing`/`quitFlushPending`/`quitFlushDone` declared `:232-243`) — nothing calls `process.on('uncaughtException'/'unhandledRejection')`; `app.quit()` is what the flush itself calls at `:315`, so routing a fatal error through the same call re-enters this exact handler.
- `main.js:2489-2505` the standalone `enhanceCancelled` before-quit listener — sets the flag unconditionally with no un-set if the quit never actually completes; `mainWindow.on('close', ...)` (`:383-391`) already gates its own prevention on the same `quitting` flag, which is the existing precedent this fix follows (`'will-quit'` as the "did it really happen" signal).
- `main.js:3097-3223` `live:start`'s `proc.stderr.on('data', ...)` (`:3175-3189`), `main.js:3247-3311` `live:downloadModel`'s (`:3296`), `main.js:3614-3642` `spawnHelperWithJsonStdout`'s (`:3634-3640`) — all three unconditionally `process.stderr.write(d)`; `live.stderrBuf` (`:2857` field, `:3154`/`:3180` writes) is appended to and never read anywhere in the file.
- `main.js` — 19 identical `error: err.message` (or `err.message`-only) sites returning a raw fs/spawn error to a renderer-facing `{ok:false}` (e.g. `:568, 584, 613, 658, 744, 1010, 1028, 1054, 2374, 2400, 2479, 2771, 2845, 3221, 3430, 3884, 4018, 4076, 4387, 4464`, plus child-process `'error'` handlers at `:1396, 3045, 3051, 3299, 3308`) plus 3 literal `Live helper binary not found at ${helper}` strings (`:3113, 3257, 3617`) — all leak an absolute path.
- `main.js:2294-2339` `transcripts:delete` — never prunes `cfg.summaryNames[filePath]` after a successful delete, so the entry (and, if a future transcript is ever saved at the identical path, its inherited custom summary name) lives forever.

## Tasks & Acceptance

**Execution:**
- [x] `main.js:67-77` — `readConfig` splits its try into a read (ENOENT/other → `{}`) and a `JSON.parse` (failure → clobber-then-rename the bad file to `config.json.corrupt`, `dialog.showErrorBox`, return `{}}`, never write anything back itself); `writeConfig` becomes `writeFileAtomic(configPath(), JSON.stringify(data, null, 2))`.
- [x] `main.js:34-53` `queueAutoTranscribe` — `fs.statSync(filePath)` (missing/error → return `null`), skip queuing when `stat.size <= 44`; `main.js:3747-3758` `record:autoQueueTranscribe` — return `{ok:false, error:'Recording is empty or too short to transcribe.'}` when `queueAutoTranscribe` returns `null`.
- [x] `main.js` — add `function isRecordingPathTaken(p)` near `defaultRecordingStem` (`:3601`) returning `p === live.outputPath || p === recorder.outputPath || fs.existsSync(p)`; use it in both `live:start`'s (`:3131`) and `record:start`'s (`:3667`) collision `while` loops in place of the bare `fs.existsSync`.
- [x] `main.js:549-570, 601-615, 2453-2481, 3313-3432, 3838-3844, 3925-4020` — every listed `fs.writeFileSync` on transcript/summary/notes-sidecar content becomes `writeFileAtomic`; `transcripts:create`'s and `live:saveTranscript`'s computed `filePath` each get a `canWritePath` check (mirroring `runEnhanceJob`) returning the existing `{ok:false, error:'Refusing to write to a path outside the managed folders.'}` shape before the write (on the `live:saveTranscript` failure path, mirror its catch block's cleanup: `noteSessionFlushed('live')`, `live.outputPath = null`, `mainWindow?.webContents.send('record:listChanged')`).
- [x] `main.js:840-907` `readTranscriptInfoSync`/`summaryFilePath`/`findExistingSummaryPath`, `main.js:2248-2286` `findRelatedAudioPaths` — add optional trailing params (`preReadHead`, and for the latter also `preReadRecordingFiles`) used instead of a fresh disk read/`readdirSync` when provided; every other existing call site (unchanged, one arg) keeps reading from disk exactly as today.
- [x] `main.js:2081-2154` `transcripts:list` — read `RECORDINGS_FOLDER` once per call (`try`/`catch` → `[]`); add a `> 20 * 1024 * 1024`-byte size branch that skips the body read (`readFailed:true`, real `audioPaths`/`hasAudio` computed from `findRelatedAudioPaths(filePath, null, recordingFiles)`); in the normal branch, split the header on `raw.match(/\r?\n\r?\n/)` instead of `indexOf('\n\n')`, and pass `head`/`recordingFiles` into `findExistingSummaryPath`/`findRelatedAudioPaths`; leave the existing `catch (err)` branch's `findRelatedAudioPaths(filePath)` call (one arg) untouched (existing regex test pins its exact shape); extend the existing `spokenTurnsIndex` prune loop to also delete stale `contentIndex` keys against the same `listed` set.
- [x] `renderer/app.js:831` — add `const WAVEFORM_MAX_BYTES = 300 * 1024 * 1024;`; `:881-904` `buildWaveform` — read `content-length` off the `fetch()` response and `throw` before calling `.arrayBuffer()` when it exceeds the cap (the existing `.catch()` in `playerShowPath` already leaves the placeholder waveform up).
- [x] `main.js:2790-2847` `transcripts:rename`, `:3925-4020` `record:rename` — every sibling rename (wav, summary, transcript-from-wav-rename, `.partial.txt`) computes its plain new path, and only calls `uniqueFilePath(dir, base, ext)` for a bumped name when that plain path already exists and differs from the source; the rename itself always executes (never silently skipped) unless source === computed destination.
- [x] `job-queue.js:189-221` `runJob`'s completion `.then()` — after the post-settle `emit()`, if `job.result` has a `content` string property, replace `job.result` with a shallow copy omitting it (so the one broadcast where the job first appears terminal still carries it, and every later one doesn't).
- [x] `main.js:2785-2788` `transcripts:enhance` — accept a second `confirmed` argument; when falsy, read the file and cheaply compute `enhance.chunkBlocks(enhance.spokenTargets(enhance.parseBlocks(enhance.splitTranscript(original).body), NOTE_LABEL)).length`; if `> 200`, return `{ok:false, needsConfirmation:true, chunks}` instead of submitting (a read/parse error here falls through to the normal submit, matching what the real run would surface anyway). `preload.js:72` `enhanceTranscript` forwards a second arg. `renderer/app.js:4619-4639` `runEnhance` accepts `confirmed = false`; on `needsConfirmation`, `window.confirm(...)` naming the chunk count and, if accepted, recurses with `confirmed:true`.
- [x] `main.js:1351-1359` `spawnClaude`'s `spawn(...)` call — first argument becomes `process.platform === 'win32' ? `"${claudePath}"` : claudePath`.
- [x] `main.js` (near `:317`, after the main before-quit handler) — add `process.on('uncaughtException', ...)`/`process.on('unhandledRejection', ...)` both calling one `handleFatalError` that logs, then (guarded by a module-level `fatalErrorHandled` flag so a second fatal error mid-flush is a no-op) calls `app.quit()` — re-entering the existing before-quit flush, no parallel shutdown path.
- [x] `main.js:2505` the standalone `enhanceCancelled` before-quit listener — add `app.on('will-quit', () => { quitReallyHappening = true; })` and, inside the existing listener, `setTimeout(() => { if (!quitReallyHappening) enhanceCancelled = false; }, QUIT_FLUSH_TIMEOUT_MS + 2000)`.
- [x] `main.js:3175-3189, 3296, 3634-3640` — gate all three `process.stderr.write(d)` calls behind `if (process.env.TRANSCRIBER_LIVE_DEBUG)`; drop `live.stderrBuf` entirely (`:2857` field, `:3154`/`:3180` writes).
- [x] `main.js` — add `function describeFsError(err)`: takes `String(err.message || err)`, finds the first `" '"`, and if present, slices it off and strips the trailing `,\s*\w+` (syscall name) it leaves behind; returns the message untouched when no such quote exists. Replace every `err.message` listed in the Code Map's leak-site bullet with `describeFsError(err)`; reword the 3 `Live helper binary not found at ${helper}` strings to drop the path.
- [x] `main.js:2294-2339` `transcripts:delete` — capture `tryUnlink(filePath)`'s return value; on success, delete `cfg.summaryNames[filePath]` (if present) and `writeConfig(cfg)`.
- [x] `test/config-persistence.test.js` (new) — mkdtemp-backed sandbox (`configPath`/`readConfig`/`writeConfig`/`writeFileAtomic` sliced, stub `app`/`dialog`): missing file → `{}`, no dialog; truncated JSON → `{}`, dialog called once, `config.json.corrupt` holds the original bad bytes; a second corruption overwrites the first `.corrupt`, not left stuck; `writeConfig` then `readConfig` round-trips.
- [x] `test/wav-collision.test.js` (new) — slice `isRecordingPathTaken` with stub `live`/`recorder`/`fs`: a path matching either object's `outputPath` is taken even when `fs.existsSync` would say no; an on-disk file is still taken with both `outputPath`s null.
- [x] `test/path-guards.test.js` — add a case: a dangling symlink at a `uniqueFilePath`-picked path makes `canWritePath` return `false` (not "free").
- [x] `test/job-queue.test.js` — extend: a settled job's `result.content` is present in the broadcast at the transition to terminal and absent from a broadcast triggered by a later, unrelated job's progress tick; `cancel()` on a lane whose registered `cancel` throws does not throw itself and leaves the job `canceling`.

**Acceptance Criteria:**
- Given a `config.json` truncated by a simulated crash, when any setting is next read, then the app starts with defaults instead of crashing, and the corrupted bytes survive on disk as `config.json.corrupt`.
- Given Live and Record both started untitled inside the same clock minute, when their wav collision loops run, then the two output paths differ.
- Given an Enhance target with 300 chunks, when `transcripts:enhance` is invoked without `confirmed`, then no job is submitted and `needsConfirmation` is returned.
- Given a rename whose sibling target name is already taken by an unrelated file, when `transcripts:rename`/`record:rename` runs, then the sibling is still renamed (to a bumped name), never left behind under its old name.
- Given an unhandled promise rejection while a Live session is recording, when it fires, then `app.quit()` is invoked exactly once and the existing flush (window shown, auto-stop triggered) runs.

## Design Notes

**Scope, not multi-goal:** this spans ~18 fixes across `main.js`/`job-queue.js`/`renderer/app.js`/`preload.js`,
but all of them serve one goal — main.js's persistence and bookkeeping degrade gracefully instead of
losing data or leaking resources — and the plan document that scoped this exact fix list already
committed it to ship as one PR (`feature/robustness-config-writes`, after PR 1/2, before PR 3). Splitting
further would fragment a single review pass over one cohesive concern into arbitrary slices with no
independent product value. Two items visible in the source finding table are deliberately **not** in this
PR's scope even though they're adjacent: `.notes.json`'s unbounded `JSON.parse` and the library watcher's
debounce lacking a max-wait — both real, neither in the plan's own committed fix-list sentence, so they go
to `deferred-work.md` rather than being silently fixed or silently dropped.

**Token budget:** this spec is well over the nominal 900-1600 token target. Checkpoint 1's [S]/[K] choice
is resolved as **[K] Keep full spec** — consistent with this same branch's two prior specs
(`spec-security-paths-headers.md`, `spec-security-model-isolation.md`), both of which also exceeded the
target for the same reason (a human-pre-scoped security/robustness pass with a fixed, non-negotiable item
list). Splitting here would just re-litigate a scoping decision already made in the source plan.

**Sibling-rename bump vs. warning:** the source finding offered two options ("bump via `uniqueFilePath`
or `{ok:true, warning}`"). Bump was chosen: it requires no renderer change (the existing `{ok, newFilePath}`
contract is untouched) and it actually closes the desync rather than just reporting it — a warning field
the renderer doesn't currently read would ship silently ignored.

**`describeFsError`'s scope:** the 19 `err.message` sites chosen are exactly the ones already spelled
`error: err.message` (or an equivalent bare `err.message` in a `finish(...)`/`resolve(...)`/`errors.push(...)`
call) — every provider-error site (OpenRouter/Ollama/OpenAI-compatible) uses a distinct template-literal
format (`` `OpenRouter request failed: ${err.message}` ``) and is deliberately left alone, since
`describeFsError`'s quote-stripping heuristic is tuned for Node's `CODE: reason, syscall 'path'` shape and
could otherwise mangle a legitimate quoted token in a provider's own error text.

## Spec Change Log

## Verification

**Commands:**
- `cd desktop && npm test` — expected: 100% green, including the new/extended files listed above.

**Manual checks (if no CLI):**
- Start a Live session and a Record session (no titles) within the same minute — two distinct wav
  filenames, not one clobbered by the other.
- Open a transcript with 300+ turns and click Enhance — a confirmation prompt names the chunk count
  before submitting.
- Rename a transcript to a title whose derived filename already exists in the folder — the renamed
  transcript, its wav, and its summary all move together, none left under the old name.

## Suggested Review Order

**Config crash-safety (the HIGH finding)**

- `readConfig` now tells ENOENT apart from corrupt JSON, and never writes anything back itself.
  [`main.js:73`](../../desktop/main.js#L73)
- The old `.corrupt` is cleared first — `fs.renameSync` silently overwrites on POSIX but throws on Windows.
  [`main.js:93`](../../desktop/main.js#L93)
- `writeConfig` now goes through the existing crash-safe `writeFileAtomic`, never a bare `writeFileSync`.
  [`main.js:117`](../../desktop/main.js#L117)

**Live/Record wav collision**

- One shared reservation check closes the same-minute collision neither tab's own `existsSync` loop could see.
  [`main.js:3857`](../../desktop/main.js#L3857)

**Non-atomic writers moved onto `writeFileAtomic`**

- `transcripts:list`'s size/CRLF/single-read hardening — the densest concentration of this PR's perf fixes.
  [`main.js:2185`](../../desktop/main.js#L2185)
- `transcripts:enhance` gained the same `canReadPath` guard `runEnhanceJob` already applies, plus a chunk-count precheck that estimates from size above 2 MB rather than ever parsing a huge file.
  [`main.js:2985`](../../desktop/main.js#L2985)
- Sibling rename (wav/summary/`.partial.txt`) now always bumps via `uniqueFilePath` instead of silently skipping on a name collision.
  [`main.js:3013`](../../desktop/main.js#L3013)
- Same bump logic on the Record-tab side.
  [`main.js:4173`](../../desktop/main.js#L4173)
- `transcripts:delete` prunes the matching `summaryNames` entry only once the transcript is actually gone.
  [`main.js:2447`](../../desktop/main.js#L2447)

**Fatal-error and quit-flush hardening**

- An uncaught exception/unhandled rejection now re-enters the existing before-quit flush instead of crashing past it; a `process.exit` backstop guards against the flush itself never resolving.
  [`main.js:390`](../../desktop/main.js#L390)
- `enhanceCancelled` self-heals if `will-quit` never actually follows a `before-quit` (an aborted/vetoed quit) — the reset timer is re-armed, not stacked, on a repeated attempt.
  [`main.js:2675`](../../desktop/main.js#L2675)
- `queue.cancel()` no longer trusts a lane's `cancel()` to stay synchronous and non-throwing.
  [`job-queue.js:259`](../../desktop/job-queue.js#L259)

**Windows spawn quoting and error-message path leaks**

- `claudePath` is quoted only under `shell:true` (Windows) — a `claude.cmd` path containing a space used to mis-parse.
  [`main.js:1441`](../../desktop/main.js#L1441)
- `describeFsError` strips a real Node errno path/syscall, gated tightly enough to leave an unrelated error (e.g. a `TypeError`) untouched.
  [`main.js:133`](../../desktop/main.js#L133)

**Resource bookkeeping**

- A settled job's `result.content` is only ever broadcast once, at the transition to terminal — not re-serialized on every sibling job's progress tick.
  [`job-queue.js:226`](../../desktop/job-queue.js#L226)
- `queueAutoTranscribe`'s WAV-header size floor, shared by both auto-transcribe callers.
  [`main.js:34`](../../desktop/main.js#L34)
- `buildWaveform` skips decoding a recording large enough to OOM the renderer, degrading to the placeholder instead.
  [`renderer/app.js:886`](../../desktop/renderer/app.js#L886)
- Helper stderr mirroring is gated behind `TRANSCRIBER_LIVE_DEBUG` again; `live.stderrBuf` (never read) is gone.
  [`main.js:3409`](../../desktop/main.js#L3409)

**Peripherals: new/extended tests**

- `test/config-persistence.test.js`, `test/wav-collision.test.js`, `test/describe-fs-error.test.js`, `test/fatal-error-quit.test.js`, `test/enhance-confirm.test.js`, `test/delete-prunes-summary-name.test.js` (new); `test/job-queue.test.js`, `test/path-guards.test.js`, `test/record-auto-transcribe.test.js`, `test/library-filters.test.js` (extended).
  [`test/config-persistence.test.js:1`](../../desktop/test/config-persistence.test.js#L1)
