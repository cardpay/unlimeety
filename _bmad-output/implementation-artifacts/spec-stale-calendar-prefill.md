---
title: '"From calendar" prefill goes stale: a finished meeting stays pre-selected'
type: 'bugfix'
created: '2026-09-02'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done
review_loop_iteration: 0
baseline_revision: '2f9e5492fc9958099bf2ae41d3ecb4dc60500812'
baseline_commit: '2f9e5492fc9958099bf2ae41d3ecb4dc60500812'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The "From calendar" prefill keeps offering a meeting that has already ended. With
nothing ongoing or upcoming the popover pre-selects the *oldest* event in its window, and once a
title has been filled into the Live/Record setup field nothing re-reads the calendar — so it
survives until the app restarts, and both the "call detected → Record" prompt and the next recording
inherit the previous meeting's name.

**Approach:** Never treat a finished event as current, and re-read the calendar whenever the Live or
Record setup screen is opened — refreshing the prefill in place while leaving anything the user typed
or picked by hand untouched.

## Boundaries & Constraints

**Always:** a hand-typed or hand-picked title is never overwritten or cleared automatically; the
prompt's title (from `main.js`) beats a stale auto-filled one; missing permission / non-macOS /
helper failure stays a silent no-op that leaves the field alone; calendar reads stay one-shot and
uncached — freshness is the point.

**Ask First:** rebuilding the Swift helper or changing its wire protocol; widening the change to
`renderer/calendar-smart.js` (launch banner, header button).

**Never:** auto-starting a recording or changing when the prompt appears; new dependencies, caching,
or polling timers; touching the `main.js` IPC or `currentCalendarTitle()`'s own window.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| In progress | event now | that event is the pick, pre-selected in the popover | N/A |
| Starting soon | next in 10 min | that event is the pick | N/A |
| All finished | every event ended | no pick, nothing pre-selected, a previously auto-filled title is cleared | N/A |
| Far off | next in 5 h | no pick (outside the cap) | N/A |
| All-day entry | day-long entry + a meeting soon | the meeting wins; the entry alone yields no pick | N/A |
| User typed | hand-typed text in the field | refresh leaves it alone, forever | N/A |
| Prompt vs refresh | refresh in flight when the prompt supplies a title | the prompt's title stands | N/A |
| Unreadable calendar | denied / non-macOS / helper error | no pick, field untouched | swallowed; popover keeps its own message |

</frozen-after-approval>

## Code Map

- `desktop/renderer/calendar-picker.js` -- the picker shared by Live, Record and the New Meeting
  modal. `defaultIndex()` is the popover's pre-selection; its `return 0` fallback is the bug (the
  list is sorted ascending, so index 0 is the window's oldest event). `openPopover()` is the only
  `api.list()` caller.
- `desktop/renderer/live/live.js` -- `applyCalendarPick()` ~L114 is the picker's sink;
  `tabButtons.forEach` ~L311 is the app's only tab-switch listener; `live.onAutoStart` ~L431 holds
  the `!titleInput.value.trim()` guard that refused to replace a stale title; `returnToSetup()` ~L885
  is "New recording" — but `resetRecordingUI()` also runs on Start, so per-session state must not be
  cleared there.
- `desktop/renderer/record/record.js` -- `applyCalendarPick()` ~L492; no tab listener of its own
  (live.js owns the switcher); `state.phase` marks the setup screen; the `recordSaved` case ~L876
  already clears `calendarParticipants` for this same reason.
- Read-only: `calendar-smart.js` `pickEvent()` (same shape, kept independent); `main.js:2815`
  (`calendar:list`) forwards `windowBackMinutes` when finite; `CalendarBridge.swift:24` defaults 120
  back / 480 forward, sorts by start, ships no `isAllDay`; `test/renderer-globals.test.js` parses
  every renderer script in a `vm`.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/renderer/calendar-picker.js` -- replace `defaultIndex()` with `currentEvent()`
      (ongoing, else nearest upcoming within a cap, else `null`), skipping entries longer than 6 h so
      all-day items cannot outrank a meeting; narrow the listed window to 60 min back; add and export
      `current()` and `autoPrefill({ input, onPick })` -- one owner for "which meeting is current", so
      popover and prefill cannot disagree.
- [x] `desktop/renderer/live/live.js` -- `applyCalendarPick`: absent half means "leave alone", empty
      title means "clear"; wire `autoPrefill`, refresh on tab open and in `returnToSetup()`; route
      `onAutoStart` through `put()`; clear `calendarParticipants` / `speakerNames` in
      `returnToSetup()` so a finished session cannot seed the next transcript header.
- [x] `desktop/renderer/record/record.js` -- same `applyCalendarPick` semantics; wire `autoPrefill`
      with its own phase-gated `[data-tab="record"]` listener and refresh after `recordSaved`, beside
      the existing participants clear -- the title names the next WAV.
- [x] `desktop/test/calendar-prefill.test.js` -- new: load the picker in a `vm` over a stubbed
      `window.calendar` and cover the matrix rows above plus the 60-minute window it asks for.

**Acceptance Criteria:**
- Given a setup screen filled for a meeting that has since ended, when its tab is reopened, then the
  finished meeting is gone from the title field.
- Given the prompt is accepted while a stale auto-filled title sits in the field, when Live opens,
  then the field shows the meeting `main.js` reported.
- Given a saved Live session, when the setup screen returns, then no attendees or speaker renames
  carry over.
- Given `npm test` in `desktop/`, then everything passes, `renderer-globals` included.

## Spec Change Log

- **Finding (step-04, `verification-gap` + `edge-case-hunter`, high):** the Execution wording
  "`applyCalendarPick`: absent half means 'leave alone', empty title means 'clear'" made an empty
  string the clear signal. `calendar-smart.js` passes a nameless event's title through raw
  (`ev.title`, which the helper emits as `''`), so its "Go to Live" click could wipe a hand-typed
  title and file the session under `defaultTitle()` — a breach of the frozen **Always** invariant.
  **Amended:** the clear is now an explicit `clear: true` on the pick; an empty title never writes.
  **Known-bad state avoided:** two unrelated callers sharing one indistinguishable signal.
  **KEEP:** the "absent half = leave that half alone" rule (it is what lets main's title-only prompt
  refresh a title without wiping attendees), the single `currentEvent()` owner, and the
  `readCurrent()` `{ ok, pick }` split that keeps an unreadable calendar from clearing the field.
- **Note:** this amendment was applied as a patch with the code in place rather than through a
  step-04 `bad_spec` revert-and-re-derive loopback — the root cause was one signal's encoding, and
  reverting ~150 verified lines to re-derive them would have discarded work the same review had just
  confirmed. `review_loop_iteration` therefore stays at 0. Every other step-04 finding was routed
  normally (patch or `deferred-work.md`).

## Design Notes

`autoPrefill` owns exactly one value — the last title it wrote, trimmed — and touches the field only
while it still holds that value (or nothing). That single rule covers both halves of the bug: it may
replace or clear its own stale title, and can never fight the user. Around it sit three guards, each
for a state the read can land in: a write counter (someone wrote while we awaited the calendar), an
`active()` predicate (the form left the screen — Start was pressed), and `ok` (the calendar could not
be read at all, which is not the same as "nothing is on now" and must never clear anything):

```js
refresh: async () => {
  const seen = writes;
  const { ok, pick } = await readCurrent();
  if (writes !== seen || !usable()) return;
  if (pick) { put(pick); return; }
  if (ok && auto && ours()) { auto = ''; writes++; onPick({ title: '', participants: [], clear: true }); }
}
```

The clear is a flagged `clear: true`, not an empty title: the sinks are also fed by
`calendar-smart.js`, which passes a nameless event's title through raw as `''`.

The 6-hour cut-off stands in for the `isAllDay` flag the helper does not ship; the upgrade path is
noted in the code.

## Verification

**Commands:**
- `npm test` (from `desktop/`) -- expected: all pass, new `test/calendar-prefill.test.js` included.

**Manual checks:**
- `npm start` with a meeting that ended an hour ago plus one starting soon: the popover pre-selects
  the upcoming one; with only finished meetings it pre-selects nothing.
- Fill the Live title from the calendar, leave the tab and return after the meeting ends: empty
  field, not the old name.

## Suggested Review Order

**Which meeting is "current"**

- Entry point: one owner for the pick, and no fallback to the oldest event.
  [`calendar-picker.js:108`](../../desktop/renderer/calendar-picker.js#L108)
- The three cut-offs, each named: listed window, upcoming cap, all-day guard.
  [`calendar-picker.js:91`](../../desktop/renderer/calendar-picker.js#L91)
- The popover now paints the same answer — one `indexOf`, no second rule.
  [`calendar-picker.js:178`](../../desktop/renderer/calendar-picker.js#L178)

**Keeping the field fresh without fighting the user**

- Ownership, the three guards, and the flagged clear.
  [`calendar-picker.js:271`](../../desktop/renderer/calendar-picker.js#L271)
- "Nothing is on now" kept distinct from "the calendar could not be read".
  [`calendar-picker.js:245`](../../desktop/renderer/calendar-picker.js#L245)
- Live's sink: only a flagged clear empties the field; absent halves stay put.
  [`live.js:119`](../../desktop/renderer/live/live.js#L119)
- The screen gate handed to the prefill, re-checked after the calendar read.
  [`live.js:128`](../../desktop/renderer/live/live.js#L128)
- Record's sink and its own tab listener — live.js owns the switcher.
  [`record.js:495`](../../desktop/renderer/record/record.js#L495)

**Where a refresh is triggered**

- Tab open, but only while the setup screen is the one on screen.
  [`live.js:332`](../../desktop/renderer/live/live.js#L332)
- The auto-record prompt's title now routed through the prefill, not past it.
  [`live.js:452`](../../desktop/renderer/live/live.js#L452)
- "New recording": last session's attendees and renames dropped, title refreshed.
  [`live.js:908`](../../desktop/renderer/live/live.js#L908)
- After a stop, whatever came of the recording — the title names the next WAV.
  [`record.js:886`](../../desktop/renderer/record/record.js#L886)

**Tests**

- The pick itself: ongoing, upcoming, all-day, overlap, nameless, garbage dates.
  [`calendar-prefill.test.js:66`](../../desktop/test/calendar-prefill.test.js#L66)
- The two regressions a reviewer should not let rot: padded title, mid-read Start.
  [`calendar-prefill.test.js:176`](../../desktop/test/calendar-prefill.test.js#L176)
- Both sinks sliced out and run — nothing else in the suite executes these files.
  [`calendar-prefill.test.js:307`](../../desktop/test/calendar-prefill.test.js#L307)
