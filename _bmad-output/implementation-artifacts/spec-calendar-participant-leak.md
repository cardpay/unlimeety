---
title: 'Add an explicit non-calendar choice to the calendar picker'
type: 'bugfix'
created: '2026-09-17'
status: 'done'
review_loop_iteration: 1
baseline_commit: '26bb4dc7ad549989a6e4a0e13a4a3e75d6af71c5'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The calendar picker has no explicit way to say that the recording is not tied to a calendar event. A user may intentionally rename a calendar meeting and keep its attendees, but a genuinely non-calendar recording needs a deliberate action that clears both the title and any saved calendar metadata.

**Approach:** Add a synthetic `No calendar meeting` row to the existing calendar drop-down. Selecting it reuses the established flagged-clear payload; the same semantic state is the default shown when no relevant calendar event is available.

## Boundaries & Constraints

**Always:** Preserve participants when the user manually renames a calendar-derived title, including a direct calendar or smart-router pick. Selecting `No calendar meeting` clears the title and participants through the existing explicit `clear: true` contract in both Live and Record. When no eligible event is current, make that row the visual default without mutating a protected typed title. A failed calendar read remains a silent no-op.

**Ask First:** Changing calendar-event ranking, overrun grace, the CalendarBridge wire protocol, the call-detection timing, or any historical transcript.

**Never:** Infer participants from title text, clear attendees merely because the user edits a title, add polling or cached calendar events, or alter the New Transcript modal. Do not write real people, e-mail addresses, or meeting titles into tests.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Renamed calendar meeting | Calendar supplied a title and attendees; user edits only the title | Edited title and the event's attendees are retained for save | N/A |
| Explicit non-calendar selection | User chooses `No calendar meeting` after any prior calendar selection | Live/Record title and participants are both cleared | N/A |
| No eligible event | All events are finished, far away, or absent | The non-calendar row is the pre-selected menu value; existing refresh rules do not erase a protected typed title | N/A |
| Calendar failure | The picker cannot read the calendar | Existing title and participants stay unchanged | Silent existing behavior |
| Direct calendar pick | User picks an event from the normal rows | The event's title and supplied participants replace the prior calendar state | N/A |

</frozen-after-approval>

## Code Map

- `desktop/renderer/calendar-picker.js` — `openPopover()` renders and dispatches menu rows; `currentEvent()` supplies the default; `autoPrefill()` owns the automatic title and its pending-read invalidation. Keep the opt-out for an explicit non-calendar selection in this same owner so a refresh cannot restore a cleared event.
- `desktop/renderer/live/live.js` — `applyCalendarPick({ title, participants, clear })` already clears the title and attendees. Its picker registration and `window.liveTab` need a small routing wrapper so direct calendar choices update the shared prefill owner without changing automatic writes.
- `desktop/renderer/record/record.js` — has the equivalent clear-capable sink; route its calendar-picker choices through the same ownership transition as Live.
- `desktop/test/calendar-prefill.test.js` — VM tests cover picker ownership, popover defaults, and sink functions. Extend them for explicit clear persistence, late reads, keyboard activation, both tab registrations, and the default no-option path.
- Read-only evidence: `desktop/main.js` persists the supplied participant arrays; `desktop/live-helper/Sources/TranscriberLive/CalendarBridge.swift` emits each event's own attendees and has no cache. The new UI choice uses the existing renderer contract rather than altering calendar retrieval.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/renderer/calendar-picker.js` — render a keyboard-operable `No calendar meeting` menu row for opted-in Live/Record callers. It dispatches the existing `{ title: '', participants: [], clear: true }` choice, is the sole default without a current event, and preserves the first-row-only default when duplicate references occur. Add a narrowly scoped prefill operation that invalidates pending reads and keeps this explicit opt-out until a direct calendar choice or fresh-session reset.
- [x] `desktop/renderer/live/live.js` — route calendar-picker and smart-router direct choices through the prefill operation, while retaining the existing sink for automatic writes. Enable the non-calendar row only for Live; a direct event selection must resume normal refresh behavior.
- [x] `desktop/renderer/record/record.js` — route Record's calendar-picker choices through the prefill operation and enable the non-calendar row only there.
- [x] `desktop/test/calendar-prefill.test.js` — cover Live and Record registration, clear payload, keyboard activation, popover closure/reopen, no-event default, duplicate rows, the default no-option behavior, and ordinary event callbacks. Prove that explicit clear survives a later refresh and a late pre-clear read, then that a direct event choice or fresh-session reset re-enables normal prefill.

**Acceptance Criteria:**
- Given a calendar-prefilled recording, when the user renames its title and saves, then the original participants remain available to the existing header path.
- Given any previous calendar selection, when the user selects `No calendar meeting`, then both Live and Record receive the existing clear payload and save no calendar participants.
- Given no eligible event, when the calendar menu opens, then `No calendar meeting` is visibly selected by default and no unrelated past event is selected.
- Given the user explicitly selects `No calendar meeting`, when the tab refreshes or a prior calendar read finishes late, then the cleared title and participants are not restored until they select a calendar event or start a fresh session.
- Given the desktop test suite, when run from `desktop/`, then the new lifecycle regressions and all existing tests pass without dependencies or release artifacts.

## Spec Change Log

- **Finding (step-04, blind-hunter):** the first implementation sent the clear payload directly from the picker, bypassing `autoPrefill`'s ownership and invalidation state. A subsequent refresh or a read already in flight could restore the event the user had explicitly cleared. **Amended:** make the explicit non-calendar choice a current-session opt-out in the existing prefill owner; a direct event choice and the existing fresh-session reset release it. **Known-bad state avoided:** a clear action that immediately repopulates the very participants it promises to remove. **KEEP:** the existing flagged-clear sink contract, manual title-renaming semantics, current event ranking, and the New Transcript exclusion.
- **Finding (step-04, verification-gap and edge-case-hunter):** the first tests injected the picker flag directly and did not prove either production registration, keyboard operation, the false default path, or unique default selection. **Amended:** add focused registration, accessibility, duplicate-reference, and lifecycle coverage. **Known-bad state avoided:** a feature tested only in a synthetic configuration and unavailable in one recording workflow. **KEEP:** the shared picker remains the single rendering point, and normal event payloads remain unchanged.

## Design Notes

`clear: true` remains the one sink contract. The small extra state belongs only in `autoPrefill`, which already owns refresh invalidation: an explicit non-calendar click advances its counter, emits the clear payload, and suppresses refresh until a direct event selection or `reset()` begins a fresh session. This keeps a deliberate current-session opt-out distinct from a failed read, and does not turn a renamed calendar title into an opt-out.

## Verification

**Commands:**
- `node test/calendar-prefill.test.js` (from `desktop/`) — expected: the non-calendar menu/default checks and existing picker lifecycle checks pass.
- `npm test` (from `desktop/`) — expected: full Node suite passes with no new failures.
- `git diff --check` — expected: no whitespace errors.

**Manual checks (if available):**
- Start with a calendar-prefilled setup, choose `No calendar meeting`, record and save, then confirm the generated transcript header has neither the prior title nor its attendees.

## Suggested Review Order

**Explicit non-calendar choice**

- Renders the opt-in action with clear semantics, keyboard support, and a safe default.
  [`calendar-picker.js:193`](../../desktop/renderer/calendar-picker.js#L193)

- Keeps an explicit choice authoritative across late or later calendar refreshes.
  [`calendar-picker.js:344`](../../desktop/renderer/calendar-picker.js#L344)

**Direct-choice routing**

- Sends Live picker and smart-router choices through the prefill owner.
  [`live.js:154`](../../desktop/renderer/live/live.js#L154)

- Gives Record the identical owner transition without changing its sink.
  [`record.js:516`](../../desktop/renderer/record/record.js#L516)

**Regression proof**

- Exercises both tab registrations, renamed-title retention, and clear refresh suppression.
  [`calendar-prefill.test.js:459`](../../desktop/test/calendar-prefill.test.js#L459)

- Covers defaults, duplicate references, regular picks, click, Enter, Space, and reopening.
  [`calendar-prefill.test.js:714`](../../desktop/test/calendar-prefill.test.js#L714)
