# Acceptance and verification

All version examples below are synthetic fixtures.

## Channel discovery — CAP-1

| Installed | Available releases | Expected |
|---|---|---|
| `2.0.0` stable | `2.0.1` stable, `2.1.0-beta.1` beta | Offer `2.0.1` only. |
| `2.0.0-beta.1` beta | `2.0.0-beta.2` beta, `2.0.0` stable | Offer `2.0.0-beta.2` only. |
| `2.0.0-beta.2` beta | `2.0.0` stable only | No same-channel update; never promote to stable. |
| `2.0.0` stable | equal/older stable, newer beta or draft | No eligible update. |
| `2.0.0-beta.2` beta | `2.0.0-beta.10`, newer alpha/RC | Offer beta.10; use semantic prerelease ordering. |
| Either | Other channel is newest by date or appears first | Search eligible releases, including subsequent pages when necessary. |
| Either | Invalid version, mismatched tag/metadata, incorrect prerelease flag, wrong architecture | Reject candidate; never install it. |
| Either | Newer same-channel release lacks update assets | Report unavailable/incomplete update; do not claim up-to-date or switch channels. |

## Scheduling — CAP-2, assumption A1

Persist the next due timestamp. After each scheduled attempt, choose a fresh independent uniform delay between 6 and 10 hours (mean 8 hours). First launch without saved state schedules the same delay. This targets three checks per 24 running hours on average, not exactly three per calendar day.

- Restart before the due time retains the deadline instead of restarting the interval.
- Launch/resume after a missed deadline schedules at most one check with 0–5 minutes of random delay, then resumes the normal schedule. Multiple wake events cannot enqueue duplicate checks.
- Fully quitting stops execution; do not wake the computer or install a background checking service. Clock changes must not create a loop or permanently disable scheduling.
- Offline/server errors count as attempts. Respect server retry/rate-limit deadlines and avoid immediate automatic retry loops.
- Manual checks give immediate feedback, coalesce with an in-flight check, respect rate limits, and do not postpone the existing scheduled deadline.
- Use an injected clock/random source to verify interval bounds, persistence, wake behavior, and distribution without waiting in real time. Verify native sleep/resume behavior separately.

## User flow and safe installation — CAP-3, CAP-4

1. Settings shows installed version/channel, Check for updates, and checking/up-to-date/error status. Background discovery presents a noninterrupting update indication.
2. An eligible update shows its version and offers download or later. Download starts only on user action, reports progress, and supports retry after failure.
3. A completed verified download offers install/restart or later. Persist readiness where the updater supports it; downloading is not permission to silently install on normal quit.
4. Active Record/Live sessions, transcription or processing jobs, and unsaved edits block installation with a reason. Recheck immediately before replacement, even if work started after the UI became ready. The user finishes/saves work and explicitly invokes installation again.
5. A failed save or shutdown timeout prevents update replacement. Exercise the existing quit handlers together with the updater to ensure neither bypasses the other nor enters a restart loop.
6. A successful install relaunches the selected same-channel version, clears stale update prompts, and preserves settings, recordings, transcripts, notes, summaries, and downloaded model caches.

## Failure and release validation

- Exercise offline operation, rate limiting, interrupted download, corrupted payload, invalid publisher signature, missing assets, insufficient space, unwritable install location, and failed replacement. Show actionable failure state and keep the previous app usable; never mark an unsuccessful install complete.
- Verify normal quit after download does not silently install, and later cancellation does not force a restart. Verify no updater replacement runs from a development launch or unsupported mounted/read-only location.
- Confirm new release metadata references the actual uploaded app payload, architecture, version, and hash. Keep stable DMG links intact and beta releases marked as prereleases.
- Run relevant existing tests and renderer/layout checks for the eventual implementation; use synthetic fixture data. No app code changed in this spec-only operation.
- On macOS, demonstrate signed installed old-to-new updates separately for stable and beta, with an opposite-channel release also available. Verify relaunch version, native signature acceptance, user-data preservation, and recovery. These release-dependent demonstrations remain pending explicit authorization for the required builds/releases.
