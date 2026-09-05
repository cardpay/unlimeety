---
title: 'Recordings live in the Meetings list, with a To transcribe queue'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'f2007deb0716074021e6d29b54ea2a247b54ee55'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A recording that has not been transcribed yet exists only in the Record tab's own `RECORDINGS` sidebar, so the app has two meeting lists with two sets of rename/delete/menu code, and the Meetings sidebar cannot answer "what still needs transcribing" at all. `spec-library-workflow-filters.md` deferred exactly this as a data-model change (see `deferred-work.md`, first entry).

**Approach:** Merge un-transcribed recordings into `meetings[]` in the renderer, add a `To transcribe` chip, move the card menu, multi-select and batch CTA onto the Meetings list, and delete the Record tab's sidebar. The Record tab keeps recording and the transcribe-settings screen.

## Boundaries & Constraints

**Always:**
- The merge happens in `loadLibrary()` from the existing `recordApi.list()`; `transcripts:list` keeps globbing `.txt` only.
- A wav already claimed by a transcript row's `audioPath` never gets a second card.
- Every action on an audio-only row goes through the existing `record:*` IPC (`rename`, `delete`, `deleteMany`, `showInFinder`, `transcribe`), never through a `transcripts:*` handler that expects a `.txt` path.
- Batch transcription reuses `window.recordTab.enterTranscribeSettings(paths)` unchanged.
- An action a row cannot support is disabled with a stated reason, matching the existing `reasonTitle` pattern.

**Ask First:**
- Any change to `transcripts:list`, `record:list` or another main-process handler.
- Removing the Record tab's own "Settings…" entry point without replacing it.

**Never:**
- No new IPC handler, no new file, no renderer module split.
- No auto-selecting rows on first appearance (the Record sidebar did; a library must not).
- Audio-only rows must not enter the `To re-transcribe`, `To enhance` or `To summarize` queues.
- Do not touch `modelIsStrong`, `modelWorthRedoing`, or the provenance chip.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Un-transcribed wav | `record:list` row, `hasTranscript: false` | One card, status `Audio only`, audio chip present, transcript/summary chips absent | N/A |
| Transcribed wav | `record:list` row, `hasTranscript: true` | No second card — the transcript row already represents it | N/A |
| Legacy stem mismatch | wav reported `hasTranscript: false` but listed as some transcript's `audioPath` | Dropped; the transcript row wins | N/A |
| `To transcribe` chip | mixed library | Only `hasTranscript === false` rows; count matches | N/A |
| `To summarize` chip | audio-only row present | Row excluded — it has no transcript to summarize | N/A |
| Click audio-only card | card clicked | Row marked active, editor and transcript view hidden, audio player loads the wav, pane says it is not transcribed yet | Missing/unreadable wav: player stays hidden |
| Menu on audio-only row | `⋯` | Transcribe…, Rename…, Show in Finder, Delete audio enabled; Summarize, Enhance, Delete transcript, Delete summary disabled with a reason | IPC `{ok:false}` → alert, list untouched |
| Select + Transcribe | ≥1 audio-only row checked | Record tab opens on the transcribe-settings screen pre-filled with those paths | N/A |
| Select + Delete | ≥1 checked | `record:deleteMany`, selection cleared, library reloaded | Partial failure → alert, reload anyway |
| Recording appears/disappears on disk | `record:listChanged` | Library reloads; selections for gone paths dropped | N/A |
| Rename audio-only row | new title | `record:rename` moves the wav and its notes sidecar; card id follows | `{ok:false}` → alert, no local mutation |

</frozen-after-approval>

## Code Map

- `desktop/renderer/app.js:1384` `loadLibrary()` -- merge point; today `api.listTranscripts()` only.
- `desktop/renderer/app.js:59` `deriveStatus()` -- already returns `audio_only` for `hasTranscript: false`; no change needed.
- `desktop/renderer/app.js:73` `deriveMeetingFromTranscript()` -- sits between `── meeting record ──` markers read verbatim by `test/transcript-meta.test.js`; the new `deriveMeetingFromRecording()` belongs beside it, inside the markers.
- `desktop/renderer/app.js:1425` `meetingMatchesFilter()` -- add `transcribe`; gate `summarize` on `hasTranscript === true`. `retranscribe`/`enhance` already exclude audio-only (`modelWorthRedoing("")` is false, `hasSpokenTurns` false).
- `desktop/renderer/app.js:1464` `FILTER_EMPTY_TEXT`, `:1487` `computeFilterCounts()`, `:1550` the `kind` list in `renderMeetings()` -- the same filter set restated; all four must gain `transcribe`.
- `desktop/renderer/app.js:1589` `buildMeetingCard()` -- add the checkbox for audio-only rows.
- `desktop/renderer/app.js:1728` `openMeetingMenu()` -- branch per row kind; the `retranscribe` action at the bottom already shows the tab-switch + `window.recordTab.enterTranscribeSettings([...])` call to copy.
- `desktop/renderer/app.js:814` `playerShow(filePath)` -- resolves the wav via `api.getAudioPath`; needs a direct-path variant for audio-only rows.
- `desktop/renderer/app.js:1188` `loadContent()`, `:1228` `setActiveMeetingId()`, `:3283` `showEditor()` -- the open path an audio-only click must not take.
- `desktop/renderer/app.js:3277` -- `api.watchTranscripts()` / `onTranscriptsChanged` init; add the `recordApi` pair next to it.
- `desktop/renderer/index.html:156` `.library-filters` -- 4 chips today; `:225` `#audio-player`; `:246` `#empty-state`; `:530` `<aside id="record-sidebar">` (delete whole element).
- `desktop/renderer/record/record.js:930-1170` -- `groupRecordings`, `cardEl`, `renderSidebarList`, `recomputeCta`, `refreshHistory`; `:1180-1340` inline player; `:1340-1380` sidebar bindings; `:1803` `openRecordingMenu`. All sidebar-only except `refreshHistory`, whose `currentItems` still feeds `renderTsScreen()` (`:1441`).
- `desktop/renderer/record/record.css` -- `#record-sidebar`, `.record-sb-*`, `.record-ap`/`.ap-*` rules.
- `desktop/main.js:3323` `record:list` -- returns `filename, filePath, createdAt, mtime, size, hasTranscript, transcriptPath, hasSummary`. Read-only reference; the wav path is the row id.
- `desktop/preload.js:129` `recordApi` -- every method the library needs is already exposed. Read-only.
- `desktop/test/library-filters.test.js:426` -- static drift guard asserting the chip list is exactly `['all','retranscribe','enhance','summarize']`; will fail until updated.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/renderer/app.js` -- add `deriveMeetingFromRecording()` inside the meeting-record markers; merge `recordApi.list()` into `loadLibrary()`, dropping rows with `hasTranscript` or a path already claimed as a transcript's `audioPath`; no global sort -- `groupMeetingsByDate` already orders each bucket -- one list, one source of truth.
- [x] `desktop/renderer/app.js` -- add the `transcribe` filter across `meetingMatchesFilter`, `computeFilterCounts`, `FILTER_EMPTY_TEXT` and `renderMeetings`'s kind list; gate `summarize` on `hasTranscript === true` -- an un-transcribed recording is not "to summarize".
- [x] `desktop/renderer/index.html` -- add the `To transcribe` chip (second, after All) with `title`/`aria-label`/`.filter-count`; add the selection bar above `#library-list` and the audio-only pane in the editor area -- the drift guard requires every chip attribute.
- [x] `desktop/renderer/app.js` -- audio-only click path: mark active, hide editor/transcript view, load the wav straight into `#audio-player`, show the pane -- there is no `.txt` to open.
- [x] `desktop/renderer/app.js` -- per-kind `openMeetingMenu`: Transcribe…, Rename… (`recordApi.rename`), Show in Finder, Delete audio (`recordApi.delete`) for audio-only rows; disable the transcript-bound items with reasons.
- [x] `desktop/renderer/app.js` -- checkbox on audio-only cards, selection bar with Transcribe / Delete / Clear, wired to `enterTranscribeSettings` and `recordApi.deleteMany`; drop selections for vanished paths on reload.
- [x] `desktop/renderer/app.js` -- subscribe to `recordApi.watch()` / `onListChanged` beside the transcripts watcher -- a new recording must appear without a tab switch.
- [x] `desktop/renderer/index.html`, `desktop/renderer/record/record.js`, `desktop/renderer/record/record.css` -- delete `#record-sidebar` and every sidebar-only function, binding, state field and rule; keep `refreshHistory()` reduced to refreshing `currentItems` for the transcribe-settings screen.
- [x] `desktop/test/library-filters.test.js` -- update the chip list and add executed cases for the matrix rows (`To transcribe` membership, `To summarize` exclusion, the three queues rejecting an audio-only row).
- [x] `desktop/test/transcript-meta.test.js` -- pin `deriveMeetingFromRecording`'s field names against a real `record:list` row shape.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- append `resolved:` to the first entry -- it named this spec's exact scope.

**Acceptance Criteria:**
- Given a wav with no transcript, when the app starts, then it appears once in Meetings and nowhere else, and the Record tab shows no recordings list.
- Given a selection of audio-only rows and a click on the batch CTA, when the Record tab opens, then the transcribe-settings screen lists exactly those recordings and starting the batch queues one job each.
- Given the library is filtered to `To transcribe` and the last row is transcribed, when the list reloads, then the placeholder reads "Nothing to transcribe" rather than "No meetings yet".
- Given `npm test` from `desktop/`, when it runs, then all suites pass.

## Design Notes

The merge is renderer-side on purpose: `record:list` already returns every field a card needs, so a main-side union in `transcripts:list` would duplicate the wav scan and change a handler four other call sites depend on.

```js
// loadLibrary()
const [items, recs] = await Promise.all([api.listTranscripts(), recordApi.list()]);
const fromTranscripts = (items || []).map(deriveMeetingFromTranscript).filter(Boolean);
const claimed = new Set(fromTranscripts.map(m => m.audioPath).filter(Boolean));
const fromRecordings = (recs || [])
  .filter(r => !r.hasTranscript && !claimed.has(r.filePath))
  .map(deriveMeetingFromRecording).filter(Boolean);
meetings = [...fromTranscripts, ...fromRecordings];
```

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: every suite passes, including the updated filter drift guard.

**Manual checks:**
- Launch the app with at least one un-transcribed wav in `~/Downloads/Meet_Recordings`: it shows in Meetings as `Audio only`, the `To transcribe` count matches, clicking it plays the audio without opening an editor, and the Record tab has no sidebar.
- Rename and delete that row from its `⋯` menu, and confirm the file on disk followed.

## Suggested Review Order

**The data model — where the second list comes from**

- Entry point: the union the whole feature rests on, and its dedup rule.
  [`app.js:170`](../../desktop/renderer/app.js#L170)

- A transcript-less row's id is the wav path, because that is what every `record:*` handler takes.
  [`app.js:128`](../../desktop/renderer/app.js#L128)

- The only IPC change: none. Two existing lists, joined in the renderer.
  [`app.js:1468`](../../desktop/renderer/app.js#L1468)

- fs.watch fires per write; only the file set is allowed to trigger a reload.
  [`app.js:1463`](../../desktop/renderer/app.js#L1463)

- The watcher that makes recordings appear without a tab switch.
  [`app.js:3605`](../../desktop/renderer/app.js#L3605)

**The queue chip**

- The new branch, plus the `hasTranscript` gate that keeps recordings out of To summarize.
  [`app.js:1555`](../../desktop/renderer/app.js#L1555)

- Chip markup: the drift guard requires title, aria-label and a matching count span.
  [`index.html:158`](../../desktop/renderer/index.html#L158)

**The card and its actions**

- Checkbox gating, and the transcribing pill painted from queue state rather than disk.
  [`app.js:1793`](../../desktop/renderer/app.js#L1793)

- One menu, two row kinds: every disabled item states its own reason.
  [`app.js:1974`](../../desktop/renderer/app.js#L1974)

- No `.txt` to open — play the wav and say why there is no transcript.
  [`app.js:2240`](../../desktop/renderer/app.js#L2240)

- The player split: resolve-from-transcript vs. play-this-path.
  [`app.js:891`](../../desktop/renderer/app.js#L891)

**Batch selection**

- The bar, and why Select all is scoped to what the chip and search actually show.
  [`app.js:1722`](../../desktop/renderer/app.js#L1722)

- Selection bar markup, hidden until something is selected.
  [`index.html:167`](../../desktop/renderer/index.html#L167)

**The Record tab, minus its sidebar**

- All that survives: a refresh that only runs while the settings screen is up.
  [`record.js:905`](../../desktop/renderer/record/record.js#L905)

- The batch entry point the library now feeds, unchanged in shape.
  [`record.js:923`](../../desktop/renderer/record/record.js#L923)

**Styling**

- The audio-only pane sits in flow so the player above it stays visible.
  [`style.css:382`](../../desktop/renderer/style.css#L382)

- Checkbox is transparent, not `display:none` — it stays focusable and named.
  [`style.css:690`](../../desktop/renderer/style.css#L690)

**Tests**

- The dedup rule, including the legacy-stem case that would double-card.
  [`transcript-meta.test.js:313`](../../desktop/test/transcript-meta.test.js#L313)

- A `record:list` row pinned field by field against what main emits.
  [`transcript-meta.test.js:267`](../../desktop/test/transcript-meta.test.js#L267)

- The card, executed: checkbox gate, transcribing pill, size formatting.
  [`library-filters.test.js:458`](../../desktop/test/library-filters.test.js#L458)
