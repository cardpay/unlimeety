---
title: 'Show the recording prompt after three seconds of microphone activity'
type: 'bugfix'
created: '2026-09-08'
status: 'done'
review_loop_iteration: 0
baseline_revision: 'ba723c79aba00af2886dd14a0f7c0566fd838938'
baseline_commit: 'ba723c79aba00af2886dd14a0f7c0566fd838938'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Start recording popup takes too long to appear after a meeting starts. The desktop explicitly requests an eight-second microphone debounce, and the helper uses the same default.

**Approach:** Reduce both values to three seconds, as explicitly requested by the user. The timer starts when the default input device becomes active, rather than from a calendar event's scheduled start.

## Boundaries & Constraints

**Always:** Preserve cancellation when microphone activity ends, revalidation of an external input process, recording and enabled-state checks, and the existing dismissal cooldown. Keep the helper protocol example consistent with its default.

**Ask First:** Changes to detection criteria, automatic recording, or release packaging/publication.

**Never:** Change auto-stop timing, popup layout, calendar matching, or the browser extension. Include personal data in source or artifacts.

</frozen-after-approval>

## Code Map

- `desktop/main.js` — `startCallMonitor()` sent `monitorMic` with an explicit eight-second debounce at the baseline revision. `handleMonitorEvent()` forwards `micActive` directly to the existing popup guards.
- `desktop/live-helper/Sources/TranscriberLive/main.swift` — protocol example and `monitorMic` dispatch fallback also specified eight seconds at the baseline revision; an explicit supplied debounce overrides that fallback.
- Read-only: `desktop/live-helper/Sources/TranscriberLive/MicActivityMonitor.swift` — `evaluate()` schedules a DispatchWorkItem using the supplied debounce, cancels pending activation on inactivity, and rechecks external input before emitting `micActive`. No additional intentional delay appears in the popup path.
- Read-only: `desktop/main.js` — `showPromptWindow()` shows the nonactivating panel at `ready-to-show`. OS scheduling, process enumeration, and renderer startup can add latency beyond the configured debounce.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/main.js` — send `debounceSec: 3` to reduce the active application delay.
- [x] `desktop/live-helper/Sources/TranscriberLive/main.swift` — change the fallback and protocol example to three seconds for consistency.
- [x] Run the existing desktop suite and syntax check; inspect the complete diff and the timer-to-popup path. Avoid adding tests that merely assert constant text for this low-impact parameter change.

**Acceptance Criteria:**
- Given an enabled monitor and sustained microphone use by another application, when monitoring starts, then the desktop configures a three-second activation debounce.
- Given a helper monitor command without an explicit debounce, when it is handled, then the fallback is three seconds.
- Given microphone activity stops during the debounce, when the monitor evaluates inactivity, then existing pending-activation cancellation remains intact.
- Given recording is active, detection is disabled, or dismissal cooldown is active, when micActive arrives, then existing popup suppression remains intact.

## Spec Change Log

## Verification

- From `desktop/`, run `node --check main.js` and `npm test`; expect success.
- Run `git diff --check`; expect no whitespace errors.
- Inspect all monitorMic debounce references for agreement. A constant-only change requires no Swift release build.
- A real-call popup measurement requires macOS microphone activity and a running app with these sources. Report any missing runtime measurement explicitly; three seconds is a debounce setting, not a strict wall-clock rendering deadline.

**Implementation results:** `node --check main.js`, `npm test` (248 passed), and `git diff --check` passed. An existing local Swift helper accepted an explicit three-second command and logged `mic monitor started (debounce=3.0s)` before being stopped. No audio was captured. The new fallback was inspected in source; no Swift rebuild or real-call popup timing measurement was performed.

**Protocol smoke reproduction:** From `desktop/`, spawn `./live-helper/.build/release/unlimeety-live` with piped stdin/stdout/stderr, write `{"cmd":"monitorMic","debounceSec":3}` followed by a newline, wait for the stderr initialization log above, then write `{"cmd":"stopMonitor"}` followed by a newline and close stdin. This existing binary verifies the explicit protocol parameter only, not the edited fallback.

**Review outcome:** Three independent review layers completed. Clarified baseline values in the Code Map and made the helper smoke reproduction explicit. No source changes were required. Missing real-call timing and rebuilt-fallback coverage remain explicitly reported limitations; constant-mirroring regression tests were intentionally not added for this parameter-only change. A pre-existing no-retry attribution path was deferred for separate investigation.

## Suggested Review Order

- Reduce the desktop-requested activation debounce to three seconds.
  [main.js:5057](../../desktop/main.js#L5057)

- Keep omitted-field helper commands consistent with the desktop.
  [main.swift:176](../../desktop/live-helper/Sources/TranscriberLive/main.swift#L176)

- Align the protocol example with the new default.
  [main.swift:23](../../desktop/live-helper/Sources/TranscriberLive/main.swift#L23)
