- source_spec: `_bmad-output/implementation-artifacts/spec-interrupt-summarize.md`
  summary: A renderer reload can desync `runningSummarize` (renderer) from `summarizeInFlight` (main), producing a confusing generic error on a second summarize attempt instead of an accurate "still running" message.
  evidence: Verified real by edge-case-hunter review + code trace. Root cause (no reload-state-resync mechanism between renderer and main) is pre-existing and applies identically to Enhance's `runningEnhance`/`enhanceInFlight` pair, so it is not introduced by the cancel-summarize change — just newly exposed by its added `summarizeInFlight` guard.
  resolved: `spec-universal-job-queue.md` removed `runningSummarize`/`summarizeInFlight`/`runningEnhance`/`enhanceInFlight` entirely — the queue in main is now the only source of truth, broadcast to the renderer via `queue:changed`; a renderer reload just re-fetches `queue:list()` and can no longer desync.

- source_spec: `_bmad-output/implementation-artifacts/spec-interrupt-summarize.md`
  summary: Canceling a claude-code summarize only sends SIGTERM (`proc.kill()`) with no escalation or exit confirmation, and on Windows the child is spawned through a shell, so killing the shell's PID may not kill the actual `claude.cmd` grandchild.
  evidence: Verified real by blind-hunter review. `proc.kill()` is the exact mechanism the pre-existing 5-minute timeout kill already used (`desktop/main.js`, before this change) — the cancel feature reuses it rather than introducing the weakness.

- source_spec: `_bmad-output/implementation-artifacts/spec-interrupt-summarize.md`
  summary: `summarize:run` has no teardown handling for a destroyed or navigating-away renderer window, unlike Enhance's `event.sender.once('destroyed', ...)` / `'did-start-navigation'` listeners — a closed/reloaded window mid-summary leaves the provider call running with no one to receive the result.
  evidence: Verified real by blind-hunter review. `summarize:run` never had this handling before the cancel-summarize change either; not introduced by it.

- source_spec: `_bmad-output/implementation-artifacts/spec-interrupt-summarize.md`
  summary: Opening the Summarize modal on a different file while another file is already being summarized gives no early indication — the user only learns via `modalBusyBanner` after typing a prompt and pressing "Summarize".
  evidence: Verified real by blind-hunter review. 100% pre-existing `modalBusyBanner` behavior; this change only added the same-file early branch and left the different-file case untouched.
  resolved: `spec-universal-job-queue.md` removed `modalBusyBanner` and the busy-refusal it backed — Summarize on any file now always submits, and the header panel shows every queued/running job (any file) at all times, not just after a blocked submit.

- source_spec: `_bmad-output/implementation-artifacts/spec-auto-transcribe-enhance-queue.md`
  summary: Add an opt-in "Auto-transcribe after stop" toggle + required language picker to the Record tab's setup screen, which queues the same large-v3 transcribe → Enhance pipeline used by Live's auto re-transcription.
  evidence: The combined spec (Live auto-chain + shared queue + Record-tab UI) measured ~9180 chars / an estimated 2000+ tokens against the 900–1600 target. Human chose [S] Split at the CHECKPOINT 1 token-count gate. The Live auto-chain + shared FIFO queue is a complete, independently shippable feature on its own (satisfies half of the original request); this Record-tab toggle reuses that queue's `record:autoQueueTranscribe` IPC handler and requires no further backend work — implement as a follow-up story once the queue spec has shipped.

- source_spec: `_bmad-output/implementation-artifacts/spec-auto-transcribe-enhance-queue.md`
  summary: Any re-transcription (manual "Re-transcribe…" from the Library, or the new auto-queue) regenerates the transcript title from the wav's filename stem and never threads the Live session's speaker-name overrides (`speakerNames`) or calendar-derived participants into the new pass, so a bound speaker name, a save-time/renamed title, or calendar attendees can be silently reverted.
  evidence: Verified real by blind-hunter + verification-gap review + code trace (`runRecordTranscribeJob` only accepts `opts.participants`, no speaker-name-override param; title is always `path.basename(filePath, ext)`). Root cause is 100% pre-existing in `record:transcribe`/`runRecordTranscribeJob` and identical for the already-shipped manual Library "Re-transcribe…" flow — not introduced by the auto-queue change. Severity is materially higher now though: Live auto-opens the transcript in the editor right after save, and the auto-queue's re-transcription/Enhance run automatically and unattended afterward with no user action, so this now fires by default on every Live session rather than only when a user deliberately opts into re-transcribing.

- source_spec: `_bmad-output/implementation-artifacts/spec-auto-transcribe-enhance-queue.md`
  summary: A manual Transcribe/Enhance click rejected because the auto-queue currently holds `transcriber.proc`/`enhanceInFlight` gets the same generic "A transcription is already running." / "Another transcript is being enhanced." message used for a manual-vs-manual collision, with nothing indicating the blocker is an invisible background job rather than something the user (or another window) started.
  evidence: Verified real by blind-hunter + edge-case-hunter + verification-gap review. The error strings and single-slot guards are pre-existing; this change adds a new, invisible caller of both guards. Worth a message tweak (e.g. distinguish "background auto-transcribe in progress" from "already running") when this area is next touched.
  resolved: `spec-universal-job-queue.md` removed every "already running" refusal — submitting always succeeds and a second job on a busy lane is simply `queued`, visible by type and title in the header panel. There is no more generic rejection message to disambiguate.

- source_spec: `_bmad-output/implementation-artifacts/spec-auto-transcribe-enhance-queue.md`
  summary: `autoPipelineQueue` has no de-duplication (the same file could be queued twice), no cap, no renderer-facing visibility, and no timeout if the underlying helper process hangs — a hang would silently wedge the queue forever with no diagnostics beyond a `console.warn` that never fires (since nothing ever resolves).
  evidence: Verified real by blind-hunter + edge-case-hunter review. Not exploitable today (the only current caller, `live:saveTranscript`, enqueues once per Live session), but the deferred Record-tab toggle story (see the other `record:autoQueueTranscribe` entry above) could plausibly call it more than once for the same file and should account for de-dup; the helper-hang risk is pre-existing (the same guards already gate manual actions) but is exposed with less recoverability once nothing surfaces it to a human.
  resolved: `spec-universal-job-queue.md` replaced `autoPipelineQueue` with `job-queue.js`, which de-dups on `(type, filePath)` and is now fully visible (and cancelable) in the header panel. No cap or hang-timeout was added — out of scope for that spec (no retry/persistence, and a hang is still recoverable via the panel's per-job Cancel, unlike before).

- source_spec: `_bmad-output/implementation-artifacts/spec-auto-transcribe-enhance-queue.md`
  summary: If a transcript is renamed (`transcripts:rename`, which also moves the paired `.wav`) or its `.txt` is deleted while an auto-queue job for it is still pending, the queued job holds the stale pre-rename wav path and either fails silently with "Recording not found" (rename case — no duplicate file is created, the queued path simply no longer exists) or resurrects the just-deleted transcript (delete-transcript-only case, guarded only by `fs.existsSync(wavPath)`).
  evidence: Verified real by blind-hunter + edge-case-hunter review and confirmed by tracing `transcripts:rename` (moves both `.txt` and `.wav`) and the delete-transcript-only handler. Narrow timing window (only matters between a Live "Stop & save" and whenever the queue's ~2s poll finds a free slot), consistent with the spec's own accepted "console-log failures only, no retry" boundary — flagged for awareness, not blocking. Note: iteration 1's added staleness guard on `runRecordTranscribeJob`'s write already closes the sub-case where the delete happens *after* the job starts (snapshot vs. current content differ); only "deleted before the job starts, still deleted at write time" remains open, since both reads see "absent" and nothing looks different.

- source_spec: `_bmad-output/implementation-artifacts/spec-auto-transcribe-enhance-queue.md`
  summary: A manual Enhance click can finish and write the very file a background transcribe job is still processing; the staleness guard then correctly refuses to overwrite it, but that means the background job's multi-minute large-v3 re-transcription is the one discarded, not the manual Enhance.
  evidence: Verified real by verification-gap review round 2 + code trace: `runRecordTranscribeJob`'s snapshot/recheck and `runEnhanceJob`'s write are independent content-staleness checks with no cross-awareness of each other's target file. Not a new race — before the staleness guard existed, the same collision instead silently destroyed the *manual* Enhance's work instead. The guard changes which side loses (favoring the user's own explicit action) rather than eliminating the underlying gap. Reworded after `spec-universal-job-queue.md` (adversarial review round): the race itself is untouched — the transcribe/enhance lanes in `job-queue.js` are deliberately independent, and neither executor checks whether the other is mid-write on the same file — but "silently discarded" is no longer accurate. The discarded job now fails visibly (its own row, its own error text, in the header panel) instead of a `console.warn` no one saw; the collision just isn't prevented.

- source_spec: `_bmad-output/implementation-artifacts/spec-auto-transcribe-enhance-queue.md`
  summary: The auto-queue drains strictly FIFO from `autoPipelineQueue[0]`, so an `enhance` entry queued behind a `transcribe` entry for a *different* file waits for the transcribe job to finish even though enhance uses an independent resource (`enhanceInFlight` vs `transcriber.proc`) and could run concurrently.
  evidence: Verified real by blind-hunter + edge-case-hunter review round 2 + code trace (`setInterval` callback only ever inspects `autoPipelineQueue[0]`). Delay-only (nothing is lost or corrupted), matters once multiple Live sessions/auto jobs can overlap.
  resolved: `spec-universal-job-queue.md` gave every resource its own lane (`transcribe`/`enhance`/`summarize`) in `job-queue.js`, each drained independently — an enhance job never waits behind an unrelated transcribe again.

- source_spec: `_bmad-output/implementation-artifacts/spec-auto-transcribe-enhance-queue.md`
  summary: The existing before-quit flush shows the main window (`showMainWindow()`) whenever a tracked transcribe/enhance run is active, so quitting while a background (auto-chained) job is running still pops the app window back up for a job the user never started.
  evidence: Verified real by blind-hunter review round 2 + code trace of the quit-flush path. Pre-existing behavior, previously only ever correlated with a user-initiated job (so always expected); the auto-queue was the first caller that could set the shared transcribe/enhance in-flight state without any user action, exposing the assumption. Reworded after `spec-universal-job-queue.md`: the auto-queue is no longer "invisible-by-design" — every job it starts has its own row in the header panel — but the before-quit handler still can't tell "a job the user is watching" from "a job that just happens to be running"; it pops the window for either.

- source_spec: `_bmad-output/implementation-artifacts/spec-auto-transcribe-enhance-queue.md`
  summary: `runRecordTranscribeJob`'s final write (both the pre-existing manual `record:transcribe` path and now the auto-queue) is a plain `fs.writeFileSync`, while `runEnhanceJob`'s analogous write uses `writeFileAtomic` — an inconsistency this spec's own iteration-1 staleness guard was explicitly modeled on `runEnhanceJob` but didn't carry the atomicity over.
  evidence: Verified real by blind-hunter review round 2 + code trace. 100% pre-existing (the manual transcribe write was never atomic, before this feature or after) — not introduced by this change, just more relevant now that a background job racing a foreground write is a routine scenario rather than a rare one.

- source_spec: `_bmad-output/implementation-artifacts/spec-universal-job-queue.md`
  summary: Summarize's actual disk write (`api.saveSummary`) happens in the renderer, keyed off the renderer-local `pendingSummarize` map — a renderer reload while a summarize job is queued or running wipes that map, so the job still finishes in main and reports `done`, but nothing ever calls `saveSummary`: the summary is silently lost even though a done summarize job's panel row implies success.
  evidence: Found during adversarial review of `spec-universal-job-queue.md`. `runSummarizeJob` (main) never writes the file itself — only `finishSummarize` (renderer, triggered from `pendingSummarize` when its job reaches a terminal status) calls `api.saveSummary`. Pre-existing shape, not introduced by this spec (the old `runSummarize()`'s `runningSummarize` had the identical gap on a reload), but harder to notice now because the job still shows as finished successfully in the panel with no other status ever surfacing the loss. Cheap partial mitigation applied: the panel's label for a done summarize job was softened from "Summary ready" to "Summary generated" so it no longer implies the file was saved. The underlying loss-on-reload itself is unresolved — not implemented per the reviewer's explicit instruction to record it, not fix it.

- source_spec: `_bmad-output/implementation-artifacts/spec-universal-job-queue.md`
  summary: The Record tab's own recordings context menu (`renderer/record/record.js`'s `openRecordingMenu`) still has no Enhance action — only the library's meeting menu (`renderer/app.js`'s `openMeetingMenu`) does, exactly as CLAUDE.md's own "Known pitfalls" note already flags.
  evidence: Confirmed by code trace while implementing `spec-universal-job-queue.md` — both menus were touched (their transcribe/enhance-based item-disabling now reads the job queue instead of local booleans), but neither gained or lost any menu item. `openRecordingMenu`'s item list (Rename…, (Re-)Transcribe…, Delete audio/transcript/summary) still has no Enhance entry. Out of scope for this spec; still open.

- source_spec: `_bmad-output/implementation-artifacts/spec-meeting-card-date-format.md`
  summary: The Record and Live tabs still format timestamps with their own `toLocaleTimeString` calls and ignore the new date-order / clock preferences.
  evidence: `desktop/renderer/record/record.js` and `desktop/renderer/live/live.js` both call `toLocaleTimeString` directly. Once a user picks 12-hour or month-first in Settings, the Transcripts sidebar follows it and those two tabs do not — a visible inconsistency inside one window. Deliberately out of scope for this spec ("Never: reformatting timestamps outside the Transcripts sidebar"), but worth a follow-up.

- source_spec: `_bmad-output/implementation-artifacts/spec-transcript-meta-info-icon.md`
  summary: `renderer/app.js` still hard-codes the header keys it treats specially (`Model`, `Status`, the `META_LABELS` relabel) with no link to the authoritative writer parser at `main.js:1738-1760`.
  evidence: The date handling was moved to a value-shape test so it needs no sync, but a new header key added in main.js still lands in the meta panel with a raw label and no signal, and neither file points at the other.

- source_spec: `_bmad-output/implementation-artifacts/spec-transcript-meta-info-icon.md`
  summary: `desktop/app.js` is an untracked stale copy of `renderer/app.js` that still emits `<div class="tv-header">`, a class whose CSS no longer exists.
  evidence: Nothing loads it (`renderer/index.html` loads `renderer/app.js`, and package.json build.files has no top-level app.js), so editing it by mistake produces silently dead markup.

- source_spec: `_bmad-output/implementation-artifacts/spec-transcript-meta-info-icon.md`
  summary: The project instructions (AGENTS.md, symlinked as CLAUDE.md) say `npm test` covers only glossary, summary-frontmatter, transcript-enhance and job-queue; the suite now has nine files.
  evidence: Already stale before this change (renderer-globals, speaker-naming, meeting-date-format were missing too); left alone here because a concurrent session is editing the same tree.

- source_spec: `_bmad-output/implementation-artifacts/spec-transcript-meta-info-icon.md`
  summary: `main.js` writes `Generated:` as `new Date().toLocaleString()`, so the meta panel shows it verbatim next to a house-formatted `Recorded` — two date formats in one panel.
  evidence: Confirmed by rendering a real header: `Recorded` reads `25.08.2026, 09:46:40` while `Generated` reads `8/25/2026, 10:15:53 AM`. The panel deliberately shows non-ISO values as written rather than misparsing them; the real fix is to write ISO at `main.js:2135`, `:2948`, `:3894` and `extenstion/background.js:157`, which is an on-disk format change the spec puts under "Ask First".

- source_spec: `_bmad-output/implementation-artifacts/spec-library-workflow-filters.md`
  summary: The library still cannot show a recording that has audio but no transcript yet, so there is no `To transcribe` chip — the user asked for one and it was split out because it is a data-model change, not a filter.
  evidence: `transcripts:list` (main.js:1808) globs `TRANSCRIPTS_FOLDER` for `.txt` only, so an un-transcribed recording in `~/Downloads/Meet_Recordings` never enters `meetings[]`; `deriveMeetingFromTranscript` (renderer/app.js:59-60) additionally drops any item without a `filePath` because `filePath` is the meeting id. Surfacing those recordings means a new list source in main, an id scheme for transcript-less entries, a card whose click/menu cannot open a transcript, and finally makes the `audio_only` status and the already-wired-but-unrendered `audio` filter branch reachable — reviewable and shippable as its own PR. Split at the human's direction ([S] at step-01 multi-goal check, 2026-08-25).
  resolved: `spec-recordings-in-meetings-list.md` shipped the list and the chip — `mergeMeetings` unions `record:list` into `meetings[]`, `deriveMeetingFromRecording` gives a transcript-less row an id (the wav path), the `To transcribe` chip renders the queue, and the Record tab's own recordings sidebar was deleted rather than left as a second list. The `audio_only` status is now reachable; the dormant `audio` filter branch is NOT — it still has no chip (see the entry below).

- source_spec: `_bmad-output/implementation-artifacts/spec-library-workflow-filters.md`
  summary: A transcript that Enhance ran on but declined to change never leaves the `To enhance` queue, so the user re-runs it forever to the same non-result.
  evidence: `runEnhanceJob` skips the `Enhanced:` stamp when the run was cancelled or nothing was applied (`main.js:2372` area), and the filter's only signal is the absence of that stamp. Commit a2578d9 fixed exactly the all-turns-rejected case, so this is a live shape, not a hypothetical. Needs a third state — "tried, nothing to do" — which is a header/IPC change beyond this spec's scope.

- source_spec: `_bmad-output/implementation-artifacts/spec-library-workflow-filters.md`
  summary: A summary written before a later Enhance or Re-transcribe is stale, and `To summarize` (`!hasSummary`) never re-queues it — the `outdated` idea the old filters referenced was never actually implemented.
  evidence: `deriveStatus` (`renderer/app.js:49-54`) never returns `"outdated"`, so the old `transcribed`/`summarized` branches referenced a status that could not occur; removing them did not create this gap, it exposed it. `findExistingSummaryPath` already yields the summary path in main, so the missing datum is its mtime against the transcript's.

- source_spec: `_bmad-output/implementation-artifacts/spec-library-workflow-filters.md`
  summary: Acting on a `To re-transcribe` item switches to the Record tab and loses the active chip, so working a queue of N items costs N trips back to the sidebar and N re-clicks of the filter.
  evidence: The Re-transcribe action leaves the library view (`renderer/app.js:1585-1590` area) and `activeFilter` is renderer state reset by nothing but a click. Pre-existing navigation behaviour, newly annoying now that the chips are queues meant to be worked through rather than archive views.

- source_spec: `_bmad-output/implementation-artifacts/spec-library-workflow-filters.md`
  summary: The dormant `audio` count in `computeFilterCounts` is an inline `if (m.hasAudio)` while every other kind routes through `meetingMatchesFilter`, so the shortcut and its branch can drift apart unnoticed.
  evidence: `renderer/app.js:1349-1358` — three kinds call the predicate, `audio` does not. Kept deliberately untouched by this spec's Never list. Harmless while no chip renders it; a trap for whoever adds the audio chip back.

- source_spec: `_bmad-output/implementation-artifacts/spec-library-workflow-filters.md`
  summary: The work queues do not exclude a meeting that already has a transcribe or enhance job in flight, so it stays counted as pending while its menu item is disabled.
  evidence: `activeJobFor(type, filePath)` (`renderer/app.js:3423`) is what the menu items gate on, but `meetingMatchesFilter` has no access to job state and `renderMeetings` is not re-run on queue events. Wiring it in means coupling the sidebar render to the job queue's change broadcasts — worth doing deliberately, not as a review patch.

- source_spec: `_bmad-output/implementation-artifacts/spec-library-workflow-filters.md`
  summary: An interrupted transcription's `<stem>.partial.txt` shows in the library as an ordinary meeting and never reaches `To re-transcribe`, even though incomplete text is exactly what needs re-running.
  evidence: `transcripts:list` filters on `f.endsWith('.txt')` (`main.js:1842`), which `.partial.txt` also satisfies, so partials enter `meetings[]` like any transcript — `main.js:3603`'s own comment says a partial should not count as a transcript. `main.js:3928` writes `Status: PARTIAL — transcription was interrupted, re-run it for the full text` into the header, but `parseTranscriptHeaderMain` never parses `Status:`, so the renderer cannot see it. A partial transcribed with `large-v3` therefore sits in no queue while being the clearest re-transcribe candidate there is, and can be enhanced and summarized before the full run replaces it. Fixing it means parsing `Status:` into a new list field — an Ask First boundary this spec did not open. Pre-existing: partials showed as normal library entries before this change too.

- source_spec: `_bmad-output/implementation-artifacts/spec-library-workflow-filters.md`
  summary: A read-failed meeting's card still positively asserts "no audio, no summary, transcribed" from fabricated defaults, so the user sees no reason why the row sits in none of the work queues.
  evidence: `readFailed` reaches the meeting object (`renderer/app.js:104`) and is used only to suppress queue membership. The card's artifact chips and status pill (`renderer/app.js:1520-1524`) keep rendering the catch branch's fabricated `hasSummary: false` / `hasAudio: false` as findings. Surfacing it means changing the meeting card, which this spec's Ask First list reserves for the human.

- source_spec: `_bmad-output/implementation-artifacts/spec-library-workflow-filters.md`
  summary: A transcript the user just gave spoken turns to keeps `To enhance` and the Enhance menu item out of date until something re-lists the library — the renderer's `meetings[]` is never refreshed, and no main-side cache invalidation can fix that.
  evidence: The folder watcher suppresses the app's own writes (`main.js:1946-1947` against `lastSelfWrite`), by design, so autosave does not churn the sidebar — and therefore `transcripts:changed` never fires and `loadLibrary` never re-runs. The stale value lives in the renderer, not in main's cache: `writeFileAtomic` renames a fresh temp file and `writeTranscriptFile` uses `writeFileSync`, so mtime always moves and the cache would have re-scanned on the next list anyway (byte length now guards it too). `stampSelfWrite`'s cache eviction was added regardless — it closes the write-that-preserves-mtime case — but it cannot refresh a renderer that never asks again. Making it immediate means a debounced re-list after save, or a renderer-side predicate over the open editor's text; the second would duplicate the very predicate this spec deliberately kept in one place. Attribution corrected after the implementer pushed back on the original diagnosis, which blamed the cache.

- source_spec: `_bmad-output/implementation-artifacts/spec-library-workflow-filters.md`
  summary: The filter set is now spelled in five places, and roughly 90 lines of the new test exist only to police the drift between them; one table driving chips, matching, counts and empty-state text would delete both the duplication and the guard.
  evidence: The chips in `index.html`, the branches in `meetingMatchesFilter`, the keys in `computeFilterCounts`, the kind list in `renderMeetings` and `FILTER_EMPTY_TEXT` all restate the same four filters. `FILTER_EMPTY_TEXT.all` is already dead weight kept alive only by a drift assertion. A `const FILTERS = [{ key, label, title, empty, match }]` rendering the row and driving all four consumers is not the "renderer refactor into modules" the spec's Never list forbids — but it reshapes working code, so it is a deliberate follow-up rather than a review patch.

- source_spec: `_bmad-output/implementation-artifacts/spec-library-workflow-filters.md`
  summary: Acting on a work queue makes the open meeting's card vanish from under the user — finishing Enhance on the meeting you are reading removes it from the active `To enhance` queue mid-session.
  evidence: `renderMeetings` filters purely on `meetingMatchesFilter` (`renderer/app.js:1456-1459`), with no exemption for `activeMeetingId`. Leaving the queue is the correct outcome for the item; the card disappearing while its transcript is open in the editor is the jarring part. Keeping the active meeting pinned regardless of the filter would fix it, at the cost of a row that does not match the chip.

- source_spec: `_bmad-output/implementation-artifacts/spec-transcript-chrome-declutter.md`
  summary: A modal opened by ⌘N/⌘O while the ⋯ meeting menu is up renders underneath it, with the menu's click overlay still swallowing pointer events.
  evidence: `openMeetingMenu` (renderer/app.js) is body-level with a full-screen `.meeting-menu-overlay` and is closed only by that overlay, by Escape, or by picking an item — nothing in the ⌘-shortcut handlers closes it. Pre-existing; the new info panel was given the same treatment for consistency, and both would be fixed by one guard.

- source_spec: `_bmad-output/implementation-artifacts/spec-transcript-chrome-declutter.md`
  summary: `renderTranscriptView`'s wiring of the PARTIAL warning is untested — deleting the one line that calls `transcriptMetaHtml` leaves the whole suite green.
  evidence: The tests eval the marked pure regions; the call site sits outside them and touches `transcriptView.innerHTML`, which needs a DOM. Verified by hand over CDP. Closing it properly means splitting the markup building out of `renderTranscriptView` into the region, leaving the function as the innerHTML assignment.

- source_spec: `_bmad-output/implementation-artifacts/spec-transcript-chrome-declutter.md`
  summary: The marked-region reader `region()` is copy-pasted into both `test/transcript-meta.test.js` and `test/meeting-date-format.test.js`.
  evidence: Both files carry the same regex-and-assert helper. One shared two-line module under `desktop/test/` would cover both, and any third file that needs it.

- source_spec: `_bmad-output/implementation-artifacts/spec-transcript-chrome-declutter.md`
  summary: `desktop/app.js` is an untracked, byte-identical pre-change copy of `renderer/app.js` that nothing loads.
  evidence: `index.html` loads `app.js` relative to `renderer/`, and electron-builder ships `renderer/**`. It still contains the deleted status-bar code, and is the only reason a repo-wide grep for those symbols finds anything. Safe to delete, but it is the user's untracked file.
- source_spec: `_bmad-output/implementation-artifacts/spec-summary-rail-all-presets.md`
  summary: The post-generation result modal still renders every section flat — it has its own two-branch `renderModalSection` (`desktop/renderer/app.js:3752`) that only knows Action Items and pipe tables.
  evidence: The rail now draws 41 section kinds through `RAIL_SECTIONS`, so the same summary reads richly sectioned in the rail and flat in the modal the user sees first. The modal also duplicates `parseTableRows`/`renderTableHtml` with a looser separator regex, and discards prose around a table. Left alone because this spec scopes the work to the right-hand rail.

- source_spec: `_bmad-output/implementation-artifacts/spec-summary-rail-all-presets.md`
  summary: Nested bullets are flattened into siblings by `partitionBullets`, which also inflates the section count badge.
  evidence: `- Roadmap` / `  - Q3 slip` renders as two rows counted as 2. No preset asks for nesting, so this only bites if a model volunteers it.

- source_spec: `_bmad-output/implementation-artifacts/spec-summary-rail-all-presets.md`
  summary: `.rail-brief` in `desktop/renderer/style.css` has had no consumer for some time.
  evidence: The deleted `brief` branch emitted `rail-brief-md`, which never had a rule at all; `.rail-brief` was already dead before this change and was left untouched to keep the diff to the work at hand.

- source_spec: `_bmad-output/implementation-artifacts/spec-recordings-in-meetings-list.md`
  summary: The dedup that stops a wav getting a second card cannot see a transcript whose read failed, nor a transcript paired with more than one wav, so a legacy-stem recording can still be double-carded.
  evidence: `mergeMeetings` (`renderer/app.js`) builds its `claimed` set from `m.audioPath`, which comes from `audioPaths[0]` in `transcripts:list` (`main.js:1808`). The catch branch of that handler (`main.js` fallback row) omits `audioPath` entirely, and `findRelatedAudioPaths` can return several wavs of which only the first survives the IPC. Both cases need a legacy `<base>-YYYYMMDD-HHMMSS.wav` name to bite, since a same-stem wav is already excluded by `hasTranscript`. Fixing it properly means exposing `audioPaths[]` (and pairing the readFailed row) from main rather than re-deriving the legacy regex in the renderer — an `Ask First` main-process change this spec did not open. Found by edge-case-hunter + verification-gap review, 2026-08-26.

- source_spec: `_bmad-output/implementation-artifacts/spec-recordings-in-meetings-list.md`
  summary: A recording currently being captured is an ordinary library row — selectable, batch-deletable — where the Record sidebar it replaces hid itself outright while recording.
  evidence: `record:list` (`main.js:3323`) globs every `.wav` in the folder including the one the helper is still writing, and the deleted rule `body[data-record-phase="recording"] .record-sidebar { display: none }` was what kept it off screen. The library has no equivalent because the renderer's recording state lives in `record.js`'s IIFE and is not exposed to `app.js`; wiring it means a new cross-tab signal, not a review patch. `record:delete` still confirms destructively before unlinking, so the footgun needs a deliberate confirmation. Found by edge-case-hunter review, 2026-08-26.

- source_spec: `_bmad-output/implementation-artifacts/spec-recordings-in-meetings-list.md`
  summary: The batch selection survives a filter or search change, so Delete and Transcribe can act on recordings the user can no longer see.
  evidence: `selectedRecordings` is pruned only against what left the disk (`loadLibrary`), never against what the active chip and search box currently show. The bar's count is the only feedback. Pruning on every render was rejected as the fix: it would silently drop a selection the moment the user typed in the search box. The honest fix is showing which off-screen rows are selected, which is a design decision. `Select all` is already scoped to the visible rows (`selectableVisible`). Found by edge-case-hunter + blind-hunter review, 2026-08-26.

- source_spec: `_bmad-output/implementation-artifacts/spec-recordings-in-meetings-list.md`
  summary: `record:deleteTranscript` and `record:deleteSummary`, plus both preload methods, now have zero renderer callers — the Record-tab card menu was their only one.
  evidence: `grep -rn 'deleteTranscript\|deleteSummary' desktop/renderer/` returns only the library's `transcripts:*` equivalents. The handlers (`main.js:3543`, `main.js:3570`) still exist and are still reachable over IPC. Removing them is a main-process change, which this spec's `Ask First` list reserves. Found by blind-hunter review, 2026-08-26.

- source_spec: `_bmad-output/implementation-artifacts/spec-recordings-in-meetings-list.md`
  summary: `document.body.dataset.recordPhase` is still written by `record.js` and cleared by `live.js`, but no CSS rule reads it any more.
  evidence: The only rule that ever did was `body[data-record-phase="recording"] .record-sidebar`, deleted with the sidebar. `grep -rn 'record-phase' desktop/renderer/` now finds the writes and the comments, no selector. Removing it touches three files for a harmless attribute, so it was left in place with its comment corrected rather than ripped out mid-review.

- source_spec: `_bmad-output/implementation-artifacts/spec-recordings-in-meetings-list.md`
  summary: The Record tab has no way to open the transcribe-settings screen with an empty batch, so model, language and diarization defaults are only editable once at least one recording is picked.
  evidence: `#record-sb-settings` was the only such entry point and went out with the sidebar; the remaining callers of `enterTranscribeSettings` (the import button, and the library's `sendToTranscribeSettings`) always pass a non-empty batch. Listed under this spec's `Ask First`, and the human chose to delete the sidebar entirely with that consequence stated. Re-adding a `Settings…` link to the Record idle screen would close it.

- source_spec: `_bmad-output/implementation-artifacts/spec-recordings-in-meetings-list.md`
  summary: The `audio` branch in `meetingMatchesFilter` and its `counts.audio` are still computed for a chip that does not exist.
  evidence: Pre-existing (`spec-library-workflow-filters.md` recorded the same shortcut), and untouched here: this change added `To transcribe`, which is `hasTranscript === false`, not `hasAudio === true`. The two are different queues — most rows with audio are already transcribed — so the dormant branch was not repurposed. It stays a trap for whoever adds an audio chip back.

- source_spec: `_bmad-output/implementation-artifacts/spec-record-live-parity.md`
  summary: `live:saveTranscript`'s own chained re-transcription overwrites the transcript it just wrote and drops that session's calendar participants.
  evidence: `main.js:3064` calls `queueAutoTranscribe(wavPath, language)` two lines below where `participants` (calendar ∪ speakers) was computed at `main.js:2999-3002` and written into the header at `main.js:3028`. The queued job writes `recordingTranscriptPath(wavPath)` — byte-for-byte the path `live:saveTranscript` wrote at `main.js:3043` — and rebuilds the header from `mergeParticipants([], speakerParticipants)`, so a Live session's attendee names vanish minutes after being saved. Pre-existing: this spec added the optional third parameter but deliberately left the Live caller at two arguments (`Never`: do not touch the Live tab). The fix is that one call site, `queueAutoTranscribe(wavPath, language, calendarParticipants)`.

- source_spec: `_bmad-output/implementation-artifacts/spec-record-live-parity.md`
  summary: Recordings that end without a live Record renderer — a quit during Stop & save, or a helper-crash salvage — are never auto-queued, because the submit lives in the renderer.
  evidence: `record:stop` (`main.js:3352`), the `proc.on('exit')` salvage (`main.js:3329`) and the `before-quit` SIGTERM all produce a transcribable wav, but the queueing decision is taken in `record.js`'s `recordSaved` handler, which needs the renderer alive and the language it holds. Live does the equivalent in main (`main.js:3064`) because main already knows its language. Degrades gracefully — the wav still appears under "To transcribe" in the Meetings list — so it is a gap, not a loss. Closing it means main owning the language (a persisted setting or a renderer-pushed value), which is a design change beyond this story.

- source_spec: `_bmad-output/implementation-artifacts/spec-record-live-parity.md`
  summary: Neither setup screen ever shows real permission state, though main can read it.
  evidence: The deleted `.record-perm-strip` hard-coded "Permissions granted · Microphone ✓ · Screen Recording ✓ · Calendar ✓" with no JS behind it, so removing it retired a lie rather than a feature — but its replacement, Live's `.live-perm-hint`, is equally static and always narrates first launch. `main.js:2630` already calls `systemPreferences.getMediaAccessStatus`; one IPC handler would let both tabs say "Microphone: not granted" when that is the truth.

- source_spec: `_bmad-output/implementation-artifacts/spec-record-live-parity.md`
  summary: A transcript produced with auto-detect records `Language: auto` in its header instead of the language actually detected.
  evidence: `main.js:3966` writes the requested language verbatim and `main.js:1752` parses it back into `info.language`, which the UI shows as the transcript's language. Already reachable through the Live tab's Auto-detect before this change; now reachable from the batch picker too, since `auto` was added there. WhisperKit returns the detected language, so the header could carry the answer rather than the request.

- source_spec: `_bmad-output/implementation-artifacts/spec-record-live-parity.md`
  summary: `record:getFolder` and its `recordApi.getFolder` bridge have no callers.
  evidence: `main.js:3281` and `preload.js:131` exist; `grep -rn 'getFolder' desktop/renderer/` finds no call. Pre-existing — the deleted "SAVE TO" row displayed a hard-coded `~/Downloads/Meet_Transcripts` string (itself wrong: recordings go to `RECORDINGS_FOLDER`, `~/Downloads/Meet_Recordings`, `main.js:12`) and never called the handler. Either wire it or drop both ends.

- source_spec: `_bmad-output/implementation-artifacts/spec-recording-summary-filename-date-suffix.md`
  summary: `defaultRecordingStem`/`defaultSummaryBase` (`desktop/main.js`) have no unit test pinning their filename format, so a future edit could flip the title/timestamp order back without any test failing.
  evidence: `grep -n 'module.exports' desktop/main.js` returns nothing — the whole file is untested in isolation by design. Only `desktop/test/transcript-meta.test.js` touches these filenames, and only as a literal fixture string fed to unrelated parsing logic, so it does not exercise the generator functions at all. Pinning the format would require adding exports, an architectural change beyond this spec's one-line format swap.

- source_spec: `_bmad-output/implementation-artifacts/spec-recording-summary-filename-date-suffix.md`
  summary: `recordingTimestamp()` (`HH-mm DD-MM-YY`) and `formatDateDdMmYy()` (`DD.MM.YY`) stamp recordings and summaries with two different, inconsistent date formats.
  evidence: Pre-existing — both functions used these same formats before this change, just as a leading prefix instead of a trailing suffix; the reorder did not introduce or worsen the inconsistency, only made the two trailing stamps sit visually closer together for a recording and its own summary.
