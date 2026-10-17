# Current integration and release constraints

Evidence inspected on 2026-10-17:

| Source | Finding and implementation implication |
|---|---|
| `desktop/package.json` | Electron 44, electron-builder 26, macOS arm64 DMG target, no updater dependency or configuration. Add updater runtime files to the packaged file allowlist if introduced. |
| `desktop/main.js`, `desktop/preload.js` | `app:version` already exposes the installed version. Main owns update discovery, validation, scheduling, and installation; expose only narrow status/action IPC through preload. Preserve path and sandbox guards. |
| `desktop/main.js` quit handling | Existing `before-quit` flushing has a timeout followed by quit. An update must not interpret that timeout as a successful save. Gate installation before invoking updater shutdown and recheck active work in main. |
| `desktop/RELEASE.md` | Existing signed/notarized macOS release procedure and destination remain authoritative. Stable and beta have distinct DMG names; preserve stable download URLs and beta prerelease flags. Windows/Linux scripts exist but have no shipped release path. |
| GitHub Releases via read-only `gh api` | `v1.7.2-beta` is a prerelease with a desktop DMG and extension ZIP; `v1.7.1` is stable with a desktop DMG. Neither inspected release includes a desktop update ZIP or channel metadata. An extension ZIP is not an app update payload. |

The customization-referenced `project-context.md` is absent. Current `AGENTS.md` and inspected source/release files supply the project context instead.

## Updater and publication contract

The [electron-builder v26 auto-update documentation](https://www.electron.build/v26/docs/features/auto-update/) requires a macOS ZIP and update metadata for its updater flow. If this integration is selected, add these alongside existing DMGs, using the signed/notarized application as the update payload. Publish all referenced assets before making the release discoverable, and verify manifest versions, filenames, architecture, and hashes against uploaded assets.

The [channel documentation](https://www.electron.build/v26/docs/tutorials/release-using-channels/) notes special GitHub channel behavior. Do not assume a beta channel setting or `allowPrerelease` alone excludes stable or other prereleases. Explicitly verify strict channel selection with the pinned implementation. Avoid introducing a separate release service.

Stable eligibility requires a non-prerelease version and a published release with its prerelease flag false. Beta eligibility requires a `beta` prerelease identifier (including numbered beta versions) and the release prerelease flag true. Ignore drafts and other prerelease identifiers; reject inconsistent tag, manifest, and payload versions. Use semantic ordering rather than dates, strings, or whichever release appears first. Bind download and installation to the verified candidate.

Missing update metadata/payload is an unavailable update with an actionable state, not proof that the installed app is current. Do not silently fall back to another channel. Only verified compatible payloads can enter the installation state.

Download from the configured release source, supporting legitimate asset redirects without trusting arbitrary renderer input. Validate integrity and publisher signature; failed validation must prevent replacement. Keep credentials out of distributed binaries. Offline, rate-limit, download, permission, and installation failures must leave the current installation usable and expose retry or recovery guidance.

Installation must preserve user data and model caches. Respect unsupported install locations such as mounted DMGs: provide actionable guidance instead of reporting success or attempting unsafe replacement. Verify native updater behavior on ordinary quit as well as explicit install/restart; downloaded payloads must not silently install on quit under assumption A2.

## Bootstrap and evidence boundary

Existing installations without an updater require one manual installation of the first updater-enabled build. Publishing extra assets cannot add an updater to an already installed binary.

Implementation should update `desktop/RELEASE.md` with the chosen payload/manifest generation and verification steps. End-to-end validation requires two explicitly authorized signed versions per channel. This specification neither performs nor authorizes that release work. Unit checks cannot establish native replacement, signing, restart, or data preservation on macOS.
