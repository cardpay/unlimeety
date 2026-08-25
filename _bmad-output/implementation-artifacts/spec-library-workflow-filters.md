---
title: 'Library filters for work left to do: re-transcribe, enhance, summarize'
type: 'feature'
created: '2026-08-25'
status: 'done'
baseline_commit: 'a2578d972fbacf77efa49430d81ae40ef78cdec2'
review_loop_iteration: 1
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Meetings sidebar filters on archive state — `Transcribed`, `Summarized` — which answers "what did I already do", not "what is still waiting". Nothing shows which meetings came from a weak model, never went through Enhance, or still have no summary.

**Approach:** Replace the two archive chips with three work-queue chips — `To re-transcribe`, `To enhance`, `To summarize` — derived from fields the transcript list already carries, plus one new list field reporting whether a transcript contains spoken turns.

## Boundaries & Constraints

**Always:**

- The chip row ends up as exactly `All`, `To re-transcribe`, `To enhance`, `To summarize`. `All` stays first and stays the default `activeFilter`.
- **Worth re-transcribing means "not the most accurate model available".** `large-v3` proper is the target; `large-v3-turbo` trades accuracy for speed and therefore belongs in the queue, as does every smaller variant. The filter gets its own predicate for this. `modelIsStrong()` keeps its current `/large/i` meaning and its current callers — the provenance chip's colour must not change as a side effect of adding a filter.
- `To re-transcribe` also requires `hasAudio`, mirroring the Re-transcribe menu item's own gate: a meeting that cannot be re-transcribed must not sit in a queue of things to re-transcribe.
- `To enhance` uses the same predicate the Enhance job uses (`enhance.spokenTargets`), so the filter can never list a transcript Enhance would refuse. The Enhance menu item is gated on the same field, so the filter and the action tell one story.
- **A queue never lists work whose action is known to fail.** A transcript whose read failed is reported as such and excluded from all three queues; it still appears under `All`. Its `hasSummary` / `hasAudio` / `model` are fabricated defaults, not findings, so no queue may act on them.
- The new list fields come from content `transcripts:list` already reads — no second `readFileSync`, no new IPC channel. Because `loadLibrary` re-runs on every watcher event, including after each autosave, the spoken-turns answer is cached per file and keyed on `mtime`; a full re-parse of the library on every keystroke's autosave is not acceptable.
- Chip counts stay computed off the unfiltered, unsearched list.
- Every chip states its own criterion in a `title`, and selection is exposed to assistive tech — these are filter toggles, not tabs.

**Ask First:**

- Any change to the meeting card, or to `main.js` beyond the list fields, the per-file cache and the read-failure flag named above.
- Any CSS change to the chip row.
- Any change to `modelIsStrong()` itself or to its existing callers.

**Never:**

- No `To transcribe` chip and no audio-without-transcript entries — deferred, separate spec.
- Do not remove or rewire the dormant `audio` branch in `meetingMatchesFilter` / `computeFilterCounts`.
- No new dependency, no test framework, no renderer refactor into modules.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Weak model, audio present | `model: 'openai_whisper-medium'`, `hasAudio: true` | Listed under `To re-transcribe` | N/A |
| Default turbo model, audio present | `model: 'openai_whisper-large-v3_turbo'`, `hasAudio: true` | Listed — turbo is not the most accurate model | N/A |
| Weak model, no audio | `model: 'openai_whisper-base'`, `hasAudio: false` | Not listed — cannot be re-transcribed | N/A |
| Best model | `model: 'openai_whisper-large-v3'` | Not listed — nothing to gain | N/A |
| Unknown model | `model: null` | Not listed — absence is not evidence of a weak model | N/A |
| Never enhanced, has spoken turns | `enhancedAt: null`, `hasSpokenTurns: true` | Listed under `To enhance` | N/A |
| Never enhanced, no spoken turns | `enhancedAt: null`, `hasSpokenTurns: false` | Not listed — Enhance would refuse it | N/A |
| Already enhanced | `enhancedAt` set | Not listed under `To enhance` | N/A |
| No summary on disk | `hasSummary: false` | Listed under `To summarize` | N/A |
| Transcript unreadable | `transcripts:list` catch branch | Still listed under `All`; `readFailed: true`, `hasSpokenTurns: false` | Excluded from all three queues; neither field ever undefined |
| Spoken-turns parse throws | `raw` readable, `parseBlocks` throws | Row keeps title, model, `enhancedAt`, `hasAudio`, date; only `hasSpokenTurns` falls back to `false` | Own `try`, so one odd body cannot collapse the row into the catch fallback |
| Unchanged file, second list call | same `mtime` as the cached entry | Cached `hasSpokenTurns` reused, body not re-parsed | N/A |
| Filter matches nothing | every transcript enhanced | Chip count `0`; the placeholder says the queue is empty, never "no meetings yet" in a non-empty library | N/A |

</frozen-after-approval>

## Code Map

- `desktop/main.js:1808` — `transcripts:list`. `raw` is read at :1820 and only its head parsed; add `hasSpokenTurns` from that same `raw`. The catch branch at :1833 returns a reduced item and must carry the field too.
- `desktop/main.js:8` — `enhance = require('./transcript-enhance')`, already in scope; `NOTE_LABEL` is module-level (:1445, :2258).
- `desktop/transcript-enhance.js:241,261,434` — `splitTranscript` → `parseBlocks` → `spokenTargets(blocks, NOTE_LABEL)`, all exported at :478. `main.js:2258` already calls it this exact way — copy that shape.
- `desktop/renderer/app.js:59` — `deriveMeetingFromTranscript`; carry `hasSpokenTurns` next to `model` / `enhancedAt` (:86-87).
- `desktop/renderer/app.js:1300` — `activeFilter` and its union comment.
- `desktop/renderer/app.js:1306` — `meetingMatchesFilter`; three new branches.
- `desktop/renderer/app.js:1336` — `computeFilterCounts`; counts object and loop.
- `desktop/renderer/app.js:1392` — `renderMeetings`; the hardcoded `["all","audio","transcribed","summarized"]` kind list that writes `.filter-count` text.
- `desktop/renderer/app.js:1806` — `modelIsStrong(id)`, `/large/i`. Reuse.
- `desktop/renderer/index.html:148-153` — the `.library-filters` markup to edit.
- Read-only, no change needed: `style.css:674-713` (`.library-filters` is already `flex-wrap: wrap` in a 304px panel); `app.js:2708-2718` (chip wire-up is generic over `data-filter`).
- `desktop/test/renderer-globals.test.js` — house precedent for reading renderer source as text in a test. It regex-scans only; it has no `vm` sandbox and no function slicing, so do not claim it as precedent for those.
- `desktop/main.js:1858-1886` — `contentIndex`, an existing `Map` keyed on `filePath` and revalidated against `mtime`. Copy this cache shape for the spoken-turns flag rather than inventing another.
- `desktop/main.js:3707` — the default transcription model is `openai_whisper-large-v3_turbo`; `renderer/record/record.js:158` and `main.js:36` default to `openai_whisper-large-v3`. Both must land on the intended side of the new predicate.
- `desktop/renderer/app.js:1533` — the `Enhance` menu item in `openMeetingMenu`; the `Re-transcribe` item just below it shows the house way to disable an action (`audioDisabled`).
- `desktop/renderer/app.js:1417-1420` + `desktop/renderer/index.html:159` — `libraryEmpty` and its placeholder markup; currently filter-unaware.
- `desktop/renderer/app.js:2720-2729` — the chip click handler that toggles `.active`; the same loop is where a selection attribute belongs.
- `desktop/renderer/app.js:26-40` — the canonical "Meeting model" comment block: the field inventory and the status-derivation notes both go stale with this change.
- `README.md:164` — "Filter by state: audio only / transcribed / summarized / outdated", the only user-facing description of this feature.

## Tasks & Acceptance

**Execution:**

Iteration 1 (landed, keep):

- [x] `desktop/main.js` — in `transcripts:list`, compute `hasSpokenTurns` via `enhance.spokenTargets(enhance.parseBlocks(enhance.splitTranscript(raw).body), NOTE_LABEL).length > 0` and include it in the returned item; add `hasSpokenTurns: false` to the catch branch.
- [x] `desktop/renderer/app.js` — carry `hasSpokenTurns` in `deriveMeetingFromTranscript`; add the three branches to `meetingMatchesFilter`; extend `computeFilterCounts` and the kind list in `renderMeetings`; update the `activeFilter` comment.
- [x] `desktop/renderer/index.html` — replace the `transcribed` and `summarized` chips with the three new ones, `All` first and active; fix the stale "Audio chip lands in Phase 4" comment above the row.
- [x] `desktop/test/library-filters.test.js` — new `node --test` file, two parts. (a) Behavioral: read `renderer/app.js` as text, slice out the `modelIsStrong` and `meetingMatchesFilter` function sources, load them into a `vm` sandbox (`vm.runInNewContext`), and assert one case per row of the I/O & Edge-Case Matrix above. This keeps `app.js` a plain classic script — no `module.exports`, no new renderer file — and follows the house pattern of `test/renderer-globals.test.js`, which already reads renderer source as text. Fail loudly if either function cannot be found by name. Lift `computeFilterCounts` into the same sandbox to cover the "filter matches nothing" row's count of `0` (its empty-state placeholder is DOM and stays a manual check). (b) Static drift guard: every `data-filter` value in `index.html` has a branch in `meetingMatchesFilter` and a `.filter-count[data-count]` span; every kind in `renderMeetings`' list is a real chip; and the `transcripts:list` catch branch in `main.js` literally carries `hasSpokenTurns: false` — the one matrix row no in-process test can exercise.

Iteration 2 (from review):

- [x] `desktop/main.js` — give the spoken-turns computation its own `try` so a `parseBlocks` throw costs only that flag, not the row's title / model / `enhancedAt` / `hasAudio` / date. Cache the answer per `filePath` keyed on `mtime`, in the shape `contentIndex` (:1858) already uses. Add `readFailed` to both branches: `false` on the success path, `true` in the catch.
- [x] `desktop/renderer/app.js` — carry `readFailed` in `deriveMeetingFromTranscript` and exclude a read-failed meeting from all three queue branches. Add the filter's own weak-model predicate — every model except `large-v3` proper counts, turbo included — leaving `modelIsStrong()` and its callers untouched. Guard the count write with `counts[kind] ?? 0` so a kind/chip mismatch can never paint the literal string `undefined`. Make the `libraryEmpty` placeholder filter-aware: an exhausted queue must not read "no meetings yet" over a full library. Gate the `Enhance` menu item (:1533) on `hasSpokenTurns`, the way `Re-transcribe` is gated on audio. Update the "Meeting model" comment block (:26-40) for the new fields.
- [x] `desktop/renderer/index.html` — drop `role="tablist"` / `role="tab"` (these are filter toggles, not tabs) and expose selection via `aria-pressed`, toggled in the same click-handler loop that toggles `.active`. Give every chip a `title` naming its criterion.
- [x] `README.md:164` — replace the stale filter list with the four chips that now exist.
- [x] `desktop/test/library-filters.test.js` — close the gaps a mutation pass found: deleting `hasSpokenTurns` from the `transcripts:list` success path, or deleting the renderer's pass-through, or dropping a kind from `renderMeetings`' list all left the suite green. Assert the success-path field, scoping the `main.js` source checks to the `transcripts:list` handler rather than to any `catch` in the file. Slice `deriveMeetingFromTranscript` into the sandbox and assert an IPC-shaped item keeps `hasSpokenTurns` and `readFailed`. Assert chips and kinds are equal as sets, both directions. Scope the `data-filter` scrape to the `.library-filters` row and anchor the kind-list regex to the `.filter-count` loop. Validate each sliced function parses (`new vm.Script`) before evaluating it, so a brace inside a string cannot mis-slice silently. Cover the new matrix rows — turbo, best model, read-failed across all three queues — plus `activeFilter` defaulting to `"all"` and the search-plus-filter acceptance criterion. Exercise the real predicate against temp-file fixtures (a transcript with turns, a notes-only one, marker-less prose) through the same `enhance.*` chain `main.js` calls. Fix the header comment's claim about `renderer-globals.test.js`.

**Acceptance Criteria:**

- Given a mixed library, when the sidebar renders, then each chip's count equals the number of meetings that chip's filter matches across the whole unfiltered library — independent of the active chip and the search box.
- Given the user clicks a chip, when the list re-renders, then only matching meetings show, still grouped by date, and the clicked chip is the only one with `.active`.
- Given a search query is typed while a work-queue chip is active, when the list re-renders, then filter and search both apply and the chip counts do not change.
- Given `npm test` in `desktop/`, when the suite completes, then every test passes including the new one.

## Spec Change Log

### Iteration 1 — 2026-08-25

**Triggering findings.** Review round 1 (blind-hunter, edge-case-hunter, verification-gap):

1. *Intent gap, frozen block.* `modelIsStrong()` is `/large/i`, and the app's default transcription model is `openai_whisper-large-v3_turbo` (`main.js:3707`). Reusing that predicate made `To re-transcribe` empty for every user who never hand-picked a smaller model, and made turbo → `large-v3` — the one upgrade users actually have — the single case the queue could never surface. The human resolved it: worth re-transcribing means "not the most accurate model available", so turbo belongs in the queue, and `modelIsStrong()` keeps its meaning so the provenance chip does not change colour as a side effect.
2. *Performance, sanctioned by the human.* `loadLibrary` is wired to the folder watcher and re-runs after every autosave, rename, delete and job completion, so parsing every transcript body per list call turned into a full-library re-parse on each keystroke's autosave — 418 ms measured over 633 real transcripts against a ~120 ms header-only baseline. Fixed by a per-file `mtime`-keyed cache, the shape `contentIndex` already uses.
3. *Queue integrity, sanctioned by the human.* The `transcripts:list` catch branch fabricates `hasSummary: false`, so an unreadable transcript entered `To summarize` — including one whose summary exists on disk but whose check never ran. Two reviewers found this independently. Fixed by a `readFailed` flag all three queues exclude.
4. *Blast radius.* The new computation sat inside the pre-existing `try`, so a `parseBlocks` throw on one odd body discarded that row's title, participants and `recordedAt`-derived date — metadata that survived before.
5. *Verification.* A mutation pass demonstrated three silent holes: deleting `hasSpokenTurns` from the success path, deleting the renderer's pass-through, or dropping a kind from `renderMeetings`' list each left `npm test` green while the `To enhance` chip went permanently dead.

**What was amended.** Frozen block: the weak-model rule, the "a queue never lists work whose action is known to fail" invariant, the caching requirement, the menu-gating clause, and the chip-affordance clause; three matrix rows added and two rewritten. Non-frozen: Code Map gained the cache, default-model, menu, placeholder, comment-block and README anchors; a second iteration of Execution tasks was appended.

**Known-bad state avoided.** Shipping a chip that reads `0` for almost every real library while claiming to surface re-transcription work, and a test suite that would have reported success through the exact regressions that kill the feature.

**KEEP — must survive re-derivation.**

- The `hasSpokenTurns` approach itself: computed in main, from the `raw` already read, through the very `enhance.spokenTargets(parseBlocks(splitTranscript(raw).body), NOTE_LABEL)` chain `runEnhanceJob` gates on. Parity with the Enhance job is the point; do not substitute a cheaper look-alike predicate.
- `To re-transcribe` requiring `hasAudio`, and unknown `model` counting as not-weak.
- Chip counts computed off the unfiltered, unsearched list in `computeFilterCounts`, with every new kind routed through `meetingMatchesFilter` rather than an inline shortcut.
- The dormant `audio` branch and its count, untouched.
- Testing renderer functions by slicing them out of `app.js` into a `vm` sandbox — `app.js` stays a plain classic script with no exports and no new renderer file.
- The comments explaining *why* each branch is shaped the way it is; they carry the reasoning the labels cannot.

**Correction to a claim in this entry's own reasoning.** Finding 2 above justified the cache partly on autosave re-parsing the library per keystroke. That premise is wrong: the folder watcher suppresses the app's own writes (`main.js:1946-1947`, against `lastSelfWrite` stamped at :500, :532, :2415), so autosave never reaches `loadLibrary`. The cache decision stands on the rest — a measured 854 ms cold list over 633 transcripts, plus a re-list after every transcribe/enhance/summarize job and every external folder change — but the frozen block's wording ("re-runs on every watcher event, including after each autosave") overstates it. Left as the human wrote it rather than silently edited; recorded here instead. The same fact produced a real defect, patched in iteration 3: the cached flag goes stale exactly when the user has just added spoken turns, so the entry is dropped on self-write.

**Process note.** The code was not reverted before re-derivation, as the loopback rule prescribes. Iteration 1's diff was correct for everything outside the five findings above, the human had already resolved every open decision, and a literal revert would have thrown away work that the re-derivation was going to reproduce line for line. The iteration-1 tasks are marked `[x]` and listed under "keep"; iteration 2 is additive.

### Round 2 — 2026-08-25 (patches only, no loopback)

Three reviewers ran again over the amended code. Nothing landed in `intent_gap` or `bad_spec`, so `review_loop_iteration` stays at 1 and the frozen block is untouched. The findings split into 26 patches, applied as iteration 3, and 5 deferrals recorded in `deferred-work.md`.

The patches worth naming, because each one is a defect the first two iterations left standing: a failed spoken-turns scan was cached as a genuine "no turns" and stuck until mtime changed; `${err.message}` on a non-Error throw escaped the inner `try` and collapsed the row anyway, defeating the guard added in iteration 2; the read-failure invariant was applied to the chips but not to the menu, so `Summarize` stayed enabled on a row that cannot be read; and the cached flag went stale precisely when the user had just added the first spoken turns, leaving Enhance greyed out.

The tests took the heaviest fire, and deserved it. Round 2 demonstrated four more mutations that kept the suite green: deleting the empty-state call site or its DOM id, breaking the Enhance gate while leaving its tooltip intact, inverting the predicate itself (unreachable by any test, because `main.js` requires `electron`), and replacing the `aria-pressed` ternary with a constant. The predicate moved into `transcript-enhance.js` so the parity claim this whole feature rests on can actually be executed rather than grepped.

## Design Notes

Unknown model counts as "not weak". `model` is absent on every transcript written before that header line existed and on every pasted one, so treating absence as weak would dump most of an older library into the chip; the provenance chip already renders that case as unknown and the filter agrees with it.

`hasSpokenTurns` is computed in main because the renderer never holds the body of a meeting it has not opened, and reusing `spokenTargets` keeps one shared definition of "has something to enhance" with `runEnhanceJob`.

## Verification

**Commands:**

- `cd desktop && npm test` — expected: all tests pass, including `library-filters.test.js`.
- `cd desktop && node --check main.js && node --check renderer/app.js` — expected: no syntax errors.

**Manual checks:**

- Launch (`cd desktop && npm start`), open the Meetings sidebar: four chips on at most two rows in the 304px panel, `All` active.
- Click each chip: the list narrows, counts stay put, no console errors.
- A `large-*` transcript is absent from `To re-transcribe`; a `medium`/`base` one with audio is present.

## Suggested Review Order

**What "work left to do" means**

- Start here: the three queue predicates, and the read-failure guard that sits above them.
  [`app.js:1344`](../../desktop/renderer/app.js#L1344)

- Why this is not `modelIsStrong()`: turbo is the default, so reusing it left the queue permanently empty.
  [`app.js:1330`](../../desktop/renderer/app.js#L1330)

**The one new fact the queues needed**

- The predicate itself, moved here so a test can execute it instead of grepping for it.
  [`transcript-enhance.js:447`](../../desktop/transcript-enhance.js#L447)

- Cached per file on mtime plus byte length; a failed scan is deliberately not cached.
  [`main.js:1822`](../../desktop/main.js#L1822)

- Eviction against the listing, so a reused path cannot serve the previous file's flag.
  [`main.js:1895`](../../desktop/main.js#L1895)

- Fabricated defaults are labelled as such, not passed off as findings.
  [`main.js:1885`](../../desktop/main.js#L1885)

- Suppressing the watcher means nothing else invalidates what we cached about that file.
  [`main.js:1960`](../../desktop/main.js#L1960)

- The renderer carries both fields as strict booleans, never undefined.
  [`app.js:101`](../../desktop/renderer/app.js#L101)

**The chips**

- Four chips replace two: filter toggles, not tabs, each stating its own criterion.
  [`index.html:156`](../../desktop/renderer/index.html#L156)

- Counts come off the unfiltered list, so a chip never lies about how much is left.
  [`app.js:1406`](../../desktop/renderer/app.js#L1406)

- An exhausted queue is the good outcome; it must not read "No meetings yet".
  [`app.js:1390`](../../desktop/renderer/app.js#L1390)

- Selection lives in aria-pressed; the class is paint only.
  [`app.js:1398`](../../desktop/renderer/app.js#L1398)

**Making the menu agree with the chips**

- One reason string drives both the disabled state and the tooltip, so the action never lies about why.
  [`app.js:1594`](../../desktop/renderer/app.js#L1594)

**Peripherals**

- Executes real code rather than grepping source: three rounds of mutation testing shaped this file.
  [`library-filters.test.js:1`](../../desktop/test/library-filters.test.js#L1)

- The only user-facing description of the feature, including the two exclusions people will hit.
  [`README.md:164`](../../README.md#L164)
