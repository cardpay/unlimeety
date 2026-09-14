---
title: 'Auto-record keeps the selected calendar event participants'
type: 'bugfix'
created: '2026-09-08'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'e9abde2620ef36fad4e82339052cbfb9fe695f08'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Today's auto-recorded meeting inherited the participants of a prior event with the same title. It saved the old attendee list instead of the selected event's list, which makes the transcript header and downstream speaker naming unreliable.

**Approach:** Preserve the EventKit-selected event's participant list through the auto-record IPC route instead of reducing the selection to a title. The existing calendar-prefill race protection will then receive authoritative participants in its first write, rather than preserving an older same-title array.

## Boundaries & Constraints

**Always:** The selected event's participants replace any existing participants even when its title equals a previous event's title. The main-process auto-record selector and renderer calendar picker keep their current selection and timing rules; the selected EventKit event remains the authoritative source. Existing manual calendar-pick behavior remains unchanged.

**Ask First:** Adding a new persisted event-identity field or changing which event wins when simultaneous equal-title calendar events are otherwise indistinguishable.

**Never:** Altering EventKit participant extraction, fabricating participants from a title, updating historical transcripts, or changing the Record-tab/manual-picker flow merely for parity.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Same title, different event | Stale prefill for “Weekly sync” has `[old-a@example.com, old-b@example.com]`; current selected EventKit event has `[current-a@example.com, current-b@example.com]` | Auto-start replaces the state with the current array; the saved transcript header uses that array | N/A |
| Current event has no participants | Main selector returns its current title and empty participant list | Auto-start clears stale participants instead of retaining them | N/A |
| Concurrent calendar refresh | A picker refresh is already pending when auto-start arrives | The auto-start write carries the selected participants; later stale refresh handling cannot restore a prior same-title list | Preserve existing stale-result discard behavior |
| Indistinguishable events | Two events are equally eligible under the existing selector | Keep its current deterministic/EventKit-order selection | User can choose explicitly in the calendar picker |

</frozen-after-approval>

## Code Map

- `desktop/main.js` -- `currentCalendarTitle()` / `triggerAutoRecord()` choose the active EventKit record, but currently forward only `{ title }` on `live:autoStart`; retain and forward the selected record's participants.
- `desktop/preload.js` -- calendar IPC currently forwards EventKit records faithfully; expected to remain read-only for this fix unless its existing payload types need matching documentation.
- `desktop/renderer/live/live.js` -- `live:autoStart` receives the main-process payload and calls `calPrefill.put`; pass the supplied participant array to that state sink.
- `desktop/renderer/calendar-picker.js` -- `autoPrefill().put()` retains old participants for a same-title title-only write and uses a write counter to discard an earlier refresh; reuse the participant-aware path without changing manual selection semantics.
- `desktop/live-helper/Sources/TranscriberLive/CalendarBridge.swift` -- EventKit serialization and `participantNames()` already provide organizer/attendees correctly; no change.
- `desktop/test/current-calendar-title.test.js` -- source-sliced selector coverage; extend equal-title fixtures to assert the selected record retains its participant array.
- `desktop/test/calendar-prefill.test.js` -- VM coverage for prefill races and both picker sinks; add the same-title auto-start replacement and pending-refresh cases.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/main.js` -- change the auto-record selection/IPC payload to carry the selected EventKit participants alongside its title -- auto-record must not discard authoritative metadata before the renderer receives it.
- [x] `desktop/renderer/live/live.js` -- send auto-start participants to `calPrefill.put()` -- a same-title current event must replace, not inherit, participant state.
- [x] `desktop/test/current-calendar-title.test.js` -- cover a selected equal-title event with a distinct participant array -- pin metadata retention in the main-process selection route.
- [x] `desktop/test/calendar-prefill.test.js` -- cover same-title replacement, an empty current array, and a pending refresh -- prove stale participants cannot survive the auto-start race.

**Acceptance Criteria:**
- Given a previous and current calendar event with the same title and different participant arrays, when auto-record starts for the current selection, then the final header contains only the current selection's participants.
- Given a current selected event without attendees, when auto-record starts after a populated same-title prefill, then the saved state has no inherited participants.
- Given the full test suite is run from `desktop/`, when the fix is present, then all existing and new tests pass.

## Spec Change Log

## Design Notes

The defect is a metadata-loss boundary, not an EventKit parsing failure: calendar records already carry attendees through IPC, while `triggerAutoRecord()` collapses the record to a title. A title-only `put()` intentionally treats identical titles as the same selection and keeps the old attendee array; it also supersedes the asynchronous refresh that could have corrected it. Carrying the selected participants in that first write makes the existing race policy safe without broadening the event-identity model.

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: every test passes, including the new equal-title participant and prefill-race coverage.

**Manual checks (if no CLI):**
- Create or modify two calendar events with the same title and different attendees, auto-record the current one, and confirm its transcript `Participants:` header matches the selected event only.

## Suggested Review Order (implementation)

**Authoritative calendar metadata**

- Preserve the selected event's participant array across the main-process IPC boundary.
  [`main.js:5167`](../../desktop/main.js#L5167)

- Keep the existing selector while returning its complete selected-event metadata.
  [`main.js:5180`](../../desktop/main.js#L5180)

**Renderer prefill handoff**

- Send the authoritative participant array into the participant-aware prefill write.
  [`live.js:461`](../../desktop/renderer/live/live.js#L461)

**Regression coverage**

- Exercise participant retention, empty arrays, deterministic ties, and the IPC payload.
  [`current-calendar-title.test.js:188`](../../desktop/test/current-calendar-title.test.js#L188)

- Prove same-title replacement and stale-refresh discard at the prefill sink.
  [`calendar-prefill.test.js:268`](../../desktop/test/calendar-prefill.test.js#L268)

## Suggested Review Order

**Calendar metadata boundary**

- Forward selected EventKit metadata without reducing it to a title.
  [`main.js:5167`](../../desktop/main.js#L5167)

- Normalize every no-event or malformed attendee result to an explicit empty array.
  [`main.js:5217`](../../desktop/main.js#L5217)

**Live prefill**

- Feed authoritative attendees through the existing participant-aware state sink.
  [`live.js:461`](../../desktop/renderer/live/live.js#L461)

**Regression coverage**

- Exercise equal-title, upcoming, loading-window, and IPC payload selection paths.
  [`current-calendar-title.test.js:200`](../../desktop/test/current-calendar-title.test.js#L200)

- Execute the Live callback against the real prefill sink and race guard.
  [`calendar-prefill.test.js:285`](../../desktop/test/calendar-prefill.test.js#L285)
