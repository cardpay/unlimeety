---
title: 'Detect active calls from Core Audio process input state'
type: 'bugfix'
created: '2026-09-09'
status: 'done'
review_loop_iteration: 0
baseline_revision: 'fa2446e4a56c82edbc6203b9c13f5e81017c194a'
baseline_commit: 'fa2446e4a56c82edbc6203b9c13f5e81017c194a'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** With auto-detect enabled, the installed 1.6.2 helper can report `ready` and `mic monitor started` during a spoken Google Meet call without ever emitting `micActive`. The monitor currently makes a default-input-device running flag a prerequisite for both activation and the delayed recheck, and it has no future observation path after a process-attribution race.

**Approach:** Detect any non-helper Core Audio process with an active input stream as the generic call signal, re-evaluate it from the process list and a small poll, and retain the existing three-second debounce and Electron-side prompt guards. Add only enough diagnostics and state-level coverage to prove the monitor schedules, emits, and clears its pending state without relying on a physical microphone in tests.

## Boundaries & Constraints

**Always:** Keep the detector app-agnostic; retain `debounceSec: 3`, duplicate-prompt suppression, cooldown, recording guards, `micInactive`, and existing auto-stop behavior. Preserve the helper JSON protocol and macOS 14.2+ graceful degradation. Emit diagnostics that identify state transitions without recording audio or adding personal meeting data.

**Ask First:** Replacing the installed application, building/signing/notarizing/releasing it, changing detection to automatic recording, or changing prompt UI/product semantics.

**Never:** Add a browser, Meet, calendar, URL, or known-app-name eligibility rule; weaken Core Audio self-process exclusion; alter unrelated working-tree files; publish or tag a release.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Call begins | A non-helper Core Audio process has `IsRunningInput` true | Schedule one `micActive` after sustained three-second activity | Duplicate observations do not add timers |
| Attribution becomes visible late | Initial poll sees no holder; a later process-list observation sees one | Start the normal debounce rather than remaining silent | Log the transition for live diagnosis |
| Call ends during debounce | Holder disappears before delayed recheck | Cancel the pending activation and emit no `micActive` | Preserve `micInactive` behavior after an active report |
| Helper holds input | Only the helper process reports active input | Do not treat it as a call | Self PID remains excluded |

</frozen-after-approval>

## Code Map

- `desktop/main.js:5049-5082` -- Sends the explicit three-second monitor command and maps only `micActive`/`micInactive` to the existing prompt logic. It is read-only for this fix: auto-detect, recording, cooldown, and duplicate-window guards already satisfy the product constraints.
- `desktop/main.js:5361-5367,5391,5402` -- Tray and lifecycle start/stop the long-lived monitor; no app-specific caller exists.
- `desktop/live-helper/Sources/TranscriberLive/main.swift:174-180,296-300` -- Owns the protocol command and monitor lifecycle; its omitted debounce fallback is already three seconds and must remain so.
- `desktop/live-helper/Sources/TranscriberLive/MicActivityMonitor.swift:29-272` -- Root-cause location. `DeviceIsRunningSomewhere` on only the default input device gates scheduling and delayed emission, while `activeInputApp()` already queries the correct generic `kAudioProcessPropertyIsRunningInput` signal. Its device listener cannot retry a failed attribution while device state remains unchanged.
- `desktop/live-helper/Sources/TranscriberLive/MeetingEndWatcher.swift:61-97,135-165` -- Reusable Core Audio pattern: process-list listener plus two-second poll because an input-state flip may not mutate the process list. It also confirms non-self process input is the shared generic signal.
- `desktop/live-helper/Package.swift` -- Has only the executable target; add the smallest Swift test target only if needed to execute isolated state logic without Core Audio hardware.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/live-helper/Sources/TranscriberLive/MicActivityMonitor.swift` -- Make the non-self active-input process query the activation authority, replace the default-device listener with process-list observation plus a bounded light poll, and log pending/recheck/emitted transitions. Preserve cancellation, one-report-per-active-call, and the emitted payload shape.
- [x] `desktop/live-helper/Sources/TranscriberLive/MicActivityState.swift` and `desktop/live-helper/Tests/TranscriberLiveTests/MicActivityStateTests.swift` -- Extract only the hardware-independent schedule/cancel/report transition decision and test sustained activity, disappearance during debounce, late appearance, and duplicate activity.
- [x] `desktop/live-helper/Package.swift` -- Register the minimal test target required for the isolated Swift state test, without changing executable dependencies or packaging.
- [x] `desktop/test/*` (only if an existing test harness directly covers a changed Node contract) -- Do not add brittle source-text assertions; retain the existing Electron behavior as verified by the desktop suite.

**Acceptance Criteria:**
- Given any external application holding a microphone input stream, when the helper observes it continuously for three seconds, then it emits one `micActive` with the existing payload fields regardless of the default input device selection.
- Given the external process becomes observable after monitor startup, when a process-list event or poll discovers it, then the normal debounce starts without needing a default-device state change.
- Given the process releases input before delayed validation, when the delayed check runs, then no `micActive` is emitted and a later call can still schedule a new debounce.
- Given an app is already recording, auto-detect is disabled, the prompt is open, or dismissal cooldown is active, when `micActive` arrives, then Electron retains its existing suppression behavior.
- Given a physical device is unavailable to tests, when the extracted state transitions are tested, then the suite detects regressions in schedule, cancel, retry, and single-emission decisions without opening the microphone.

## Spec Change Log

## Design Notes

The process-input property answers the actual cross-app question: whether another process owns an active input stream. The prior device-wide default-input property is neither an attribution source nor a reliable trigger for per-app input transitions. The MeetingEndWatcher already uses the process-list listener and poll pattern because process membership and input state are separate Core Audio changes; reuse that event strategy, not a Meet-specific exception.

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: all existing desktop tests pass.
- `cd desktop && npm run check:layout` -- expected: layout check passes unchanged.
- `cd desktop/live-helper && swift test` -- expected: the isolated state transitions pass without accessing audio hardware.
- `git diff --check` -- expected: no whitespace errors.

**Manual checks:**
- If safe and without replacing the installed app, run the existing packaged helper against a live microphone-active call and capture only `ready`, monitor diagnostics, and `micActive` timestamps. Report the exact observed events and timing; a source rebuild is not a substitute for the packaged-helper verification.

**Implementation results:** `npm test` passed (248/248), `npm run check:layout` passed (23/23), `swift build` passed, and `git diff --check` passed. The isolated state transitions passed in a compiled assert smoke check. The registered XCTest target could not run because this Mac's Command Line Tools lack `XCTest`; no application was installed or replaced. A six-second packaged-helper probe emitted `ready` and `mic monitor started (debounce=3.0s)`, but no `micActive`; no microphone-active call was confirmed at probe time.

## Suggested Review Order

**Core Audio detection**

- Use the per-process input signal and retry observations without default-device coupling.
  [`MicActivityMonitor.swift:67`](../../desktop/live-helper/Sources/TranscriberLive/MicActivityMonitor.swift#L67)

- Keep debounce cancellation, single emission, and diagnostics in one serial state transition path.
  [`MicActivityMonitor.swift:117`](../../desktop/live-helper/Sources/TranscriberLive/MicActivityMonitor.swift#L117)

- Preserve the shared auto-stop detector's identical per-process semantics.
  [`MeetingEndWatcher.swift:12`](../../desktop/live-helper/Sources/TranscriberLive/MeetingEndWatcher.swift#L12)

**Regression coverage**

- Isolate schedule, cancellation, retry, and one-shot reporting from Core Audio hardware.
  [`MicActivityState.swift:11`](../../desktop/live-helper/Sources/TranscriberLive/MicActivityState.swift#L11)

- Exercise the state transitions in the Swift package test target.
  [`MicActivityStateTests.swift:5`](../../desktop/live-helper/Tests/TranscriberLiveTests/MicActivityStateTests.swift#L5)

- Register the minimal package test target without changing helper dependencies.
  [`Package.swift:36`](../../desktop/live-helper/Package.swift#L36)

**Local workspace hygiene**

- Keep user-requested local release/design artifacts out of version control.
  [`.gitignore:54`](../../.gitignore#L54)
