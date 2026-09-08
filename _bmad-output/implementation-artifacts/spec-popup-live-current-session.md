---
title: 'Popup opens Live with the current session metadata'
type: 'bugfix'
created: '2026-09-08'
status: 'done'
review_loop_iteration: 0
baseline_revision: 'cfba0cd56c9d252d8ef569c9a611740682d96675'
baseline_commit: 'cfba0cd56c9d252d8ef569c9a611740682d96675'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Accepting Start Recording in the call-detection popup can open Live with a previous meeting's title. Existing freshness fixes remain present, but a title entered manually or supplied directly by the calendar picker or smart banner survives the completed session. Automatic prefill then treats that old title as a protected edit and rejects the current event supplied by the popup.

**Approach:** Scope title ownership to one recording session. Starting a fresh setup after a completed or explicitly discarded session clears the old title and prefill state before requesting fresh calendar metadata. Keep protection for manual edits within the current setup and for metadata belonging to an active or unsaved recording.

## Boundaries & Constraints

**Always:** Preserve current-session manual input during ordinary tab visits and background refreshes. Clear previous-session title, participants, and speaker overrides together at the existing fresh-session boundary. Invalidate reads started before that boundary. The popup's current title and explicit participant array must win over a refresh already in flight when its payload arrives. Existing permission and failed-save protections remain intact.

**Ask First:** Changing event-ranking rules, automatically starting audio capture, rebuilding the Swift helper, or packaging a release.

**Never:** Modify historical transcripts, introduce polling or persistent event identity, broaden this fix into Record-tab behavior, or change the calendar wire protocol. Use synthetic fixtures only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Previous calendar pick | Saved session used a directly picked title; popup supplies a current event | Fresh Live setup shows current title and participants | N/A |
| Previous manual title | Saved session used a typed title; New recording is opened | Previous title is cleared; fresh calendar data may fill the new setup | N/A |
| Same title, new attendees | Current popup event shares the previous title | Only the current participant array remains, including an empty array | N/A |
| Current setup edit | User edits an unsaved setup title and revisits Live | Their current edit remains protected | N/A |
| Old read completes late | A calendar refresh began before the session reset | Old result cannot restore prior metadata | Ignore invalidated read |
| Popup races refresh | Tab entry starts a refresh; current popup payload then arrives | Popup metadata remains authoritative | Ignore superseded read |
| No current event | Fresh setup receives no usable calendar event | Title and participants remain empty; existing timestamp fallback applies at recording/save | N/A |
| Unreadable calendar | Fresh setup cannot read calendar | No previous-session metadata returns | Preserve existing silent failure handling |
| Active or unsaved session | Loading, recording, saving, failed save, or crash recovery | Tab entry and popup do not reset that session's metadata | Preserve recovery path |

</frozen-after-approval>

## Code Map

- `desktop/renderer/calendar-picker.js` — `autoPrefill()` owns the last automatic title and a write counter. `ours()` rejects values written directly by other routes. Add an explicit session reset that invalidates pending reads and clears title/participants through the existing flagged-clear sink.
- `desktop/renderer/live/live.js` — `applyCalendarPick()` is used directly by manual picker and `window.liveTab`; `returnToSetup()` currently clears participants and speaker names but retains title. Invoke the session reset here before `refresh()`. Do not reset in `resetRecordingUI()`, which also runs when starting capture.
- `desktop/renderer/live/live.js` — tab click handler invokes `returnToSetup()` only after `state.finished`; `live.onAutoStart` clicks that tab before applying the popup payload. Execute these actual handlers in regression tests.
- `desktop/test/calendar-prefill.test.js` — existing VM picker loader and source-sliced Live callback harness cover automatic ownership and IPC races, but do not exercise previous direct picks through the completed-session transition.
- Read-only: `desktop/main.js` `currentCalendarTitle()` and `triggerAutoRecord()` already forward current title and participants. `desktop/renderer/calendar-smart.js` supplies direct picks. Swift queries are fresh; no cache change is needed.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/test/calendar-prefill.test.js` — reproduce a direct calendar pick followed by successful completion and popup acceptance using the real lifecycle handlers; demonstrate failure before the fix.
- [x] `desktop/renderer/calendar-picker.js` — add a session reset operation that clears owned state and invalidates pending refreshes while preserving existing ordinary refresh behavior.
- [x] `desktop/renderer/live/live.js` — call reset at the fresh-session boundary before the calendar read; update stale comments about popup metadata.
- [x] `desktop/test/calendar-prefill.test.js` — cover the matrix, including preservation of current-session edits, same-title participant replacement, no-event/error outcomes, and late reads across reset.

**Acceptance Criteria:**
- Given a completed recording whose title came from any supported input route, when the user accepts a new call popup, then Live displays the current event rather than the completed session's metadata.
- Given a current setup or an active/unsaved recording, when Live is revisited, then its protected title remains unchanged.
- Given the regression and full desktop suites, when run with the fix, then all checks pass without new dependencies or release artifacts.

## Spec Change Log

## Design Notes

The earlier fix protects direct selections for the entire renderer lifetime. This change narrows that lifetime to the recording session. Clearing only the DOM value is insufficient: a pre-reset asynchronous read could still populate the new empty field. Reset must advance the existing invalidation counter before fresh queries begin.

## Verification

**Commands:**
- From `desktop/`, `node test/calendar-prefill.test.js` — demonstrate the lifecycle regression before the change, then pass after the fix.
- From `desktop/`, `npm test` — all renderer, calendar selector, and existing module checks pass.

**Manual checks:**
- In a local development app, finish a recording with a synthetic manually selected title, then accept a popup for a different current calendar event. Confirm the new setup metadata and preserve an unsaved manual edit on an ordinary tab round trip. Report separately if a real macOS/EventKit check is unavailable.

**Implementation verification (2026-09-08):**
- Before the renderer fix, `node test/calendar-prefill.test.js` exited 1 at the real lifecycle regression: `picker: popup replaces the completed session title`; actual `Previous review`, expected `Current review`.
- After the fix, `node test/calendar-prefill.test.js` passed (`calendar-prefill: ok`). `npm test` passed all 248 tests with zero failures or skips.
- The VM harness executes the production calendar sink, Start callback, stop/save callback, Live tab callback, popup callback, New recording/discard callback, and session reset functions. Audio, filesystem, and DOM painting are stubbed; fixtures are synthetic.
- Coverage includes previous direct selections (the picker and smart banner share the sink), manual and automatic titles, successful completion, current manual edits, same-title changed/empty attendees, popup/refresh ordering, pre-reset reads resolving late, fresh calendar data, no events, denied/thrown calendar reads, timestamp fallback, explicit discard, loading, active capture, saving, failed save, and crash recovery.
- Local Electron smoke check passed using a separate scratch profile (`node /tmp/live-session-smoke.mjs`, ephemeral untracked harness): actual DOM manual draft survived a Live revisit; a previous direct pick was cleared by the actual New recording handler, with setup shown again.
- A real recording followed by popup acceptance against macOS EventKit has not been performed. Automated callback coverage does not establish that end-to-end result.

**Review fixes (2026-09-08):**
- Kept fresh-session clearing independent of the optional calendar picker by falling back to the existing flagged-clear sink. The absence regression failed before this patch (`Previous review` instead of an empty title) and passes with it.
- Added a pending-query regression where a new manual title equals the previous session's automatic title. An in-memory mutation omitting `auto = ''` fails this test (`Different suggestion` instead of `Shared title`), confirming coverage of ownership reset itself.
- Extended the completed direct-pick popup regression through a second capture and save: both receive the current title, and the save receives only current participants and no previous speaker overrides.
- After review fixes, `node test/calendar-prefill.test.js` passed, `npm test` passed all 248 tests with zero failures or skips, and `git diff --check` passed.

## Suggested Review Order

**Fresh-session boundary**

- Clear completed-session metadata while retaining current-session edit protection.
  [live.js:913](../../desktop/renderer/live/live.js#L913)

- Invalidate earlier reads and release ownership before the next calendar refresh.
  [calendar-picker.js:329](../../desktop/renderer/calendar-picker.js#L329)

**Popup handoff**

- Apply authoritative popup metadata after tab entry resets the completed session.
  [live.js:461](../../desktop/renderer/live/live.js#L461)

**Regression coverage**

- Exercise production lifecycle callbacks with synthetic calendar and recording bridges.
  [calendar-prefill.test.js:88](../../desktop/test/calendar-prefill.test.js#L88)

- Verify popup metadata reaches the next capture and saved transcript.
  [calendar-prefill.test.js:224](../../desktop/test/calendar-prefill.test.js#L224)
