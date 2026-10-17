---
id: SPEC-in-app-updates
companions:
  - brownfield.md
  - acceptance.md
  - ../../../AGENTS.md
sources: []
---

# Channel-isolated in-app updates

## Why

Desktop users need to discover and install new GitHub releases without checking the release page or replacing the application manually. Beta installations must stay on beta; stable installations must stay on stable.

## Capabilities

- **CAP-1**
  - **intent:** Discover newer compatible releases for the installed update channel.
  - **success:** Select the greatest eligible semantic version from the existing GitHub Releases destination; exclude drafts, other channels, equal/older versions, malformed versions, and incompatible payloads.
- **CAP-2**
  - **intent:** Discover updates automatically about three times daily, preferably at random times.
  - **success:** A continuously running installation averages three randomized checks per day; restarts preserve the schedule and sleep/offline recovery never replays missed checks in a burst.
- **CAP-3**
  - **intent:** Let users discover, download, and initiate installation of an update from the app.
  - **success:** The app exposes version/channel, check status, availability, download progress, retry, and install/restart or later actions; successful installation requires no manual DMG replacement.
- **CAP-4**
  - **intent:** Update safely while preserving meeting work and local data.
  - **success:** Installation waits for safe conditions and explicit user action, relaunches into the selected version, and preserves settings, recordings, transcripts, notes, summaries, and model caches; failure leaves the current installation usable.

## Constraints

- Keep the existing GitHub Releases destination and stable DMG links documented in `desktop/RELEASE.md`.
- Enforce beta-to-beta and stable-to-stable selection using semantic versions and consistent release metadata; never silently cross channels or downgrade.
- Preserve signing/notarization, renderer isolation, narrow IPC, filesystem guards, personal-data protection, and release/integration policies in the adopted `AGENTS.md`.
- Verify payload integrity and publisher identity before replacement; do not ship GitHub credentials or accept arbitrary renderer-provided download URLs or installation paths.
- New update payloads and metadata are required; this specification authorizes no build, notarization, upload, tag, or release.

## Non-goals

- Channel switching, extension self-update, Windows/Linux updates, rollback UI, delta-update optimization, telemetry, and staged rollout.
- Forced restarts, installation during active meeting work, or a background agent that checks while the app is fully quit.

## Success signal

For each channel, an installed signed updater-enabled version discovers a newer same-channel GitHub release and updates through the app into that version. Opposite-channel releases are ignored, failed updates remain recoverable, and existing meeting data survives. Scheduler and failure cases pass the companion acceptance matrix.

## Assumptions

- **A1:** “About three daily” means an average while running: random 6–10 hour intervals, persisted across restarts, with one jittered overdue check after resume. Manual checks are additional. Details are in `acceptance.md`.
- **A2:** Download and installation require user action; Settings provides a manual check and version/channel status. No silent installation on normal quit.
- **A3:** Initial scope is the currently shipped signed macOS arm64 desktop app.
- **A4:** Installation waits for recording, transcription, processing, and unsaved edits to finish/save; becoming idle does not itself authorize installation.

## Open Questions

- **Q1 — implementation verification:** Which updater/provider integration and channel manifests satisfy strict beta isolation, publisher verification, and deferred macOS installation with the pinned dependencies? Prove these behaviors before declaring delivery complete; `electron-updater` is a candidate, not a mandated choice.
