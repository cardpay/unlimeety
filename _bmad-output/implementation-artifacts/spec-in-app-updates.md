---
title: 'Channel-isolated in-app updates'
type: 'feature'
created: '2026-10-17'
status: 'done'
baseline_commit: '4f2651203ed5cfc82aeea1eddde9f4dcecb195ed'
review_loop_iteration: 1
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Users need in-app same-channel updates.

**Approach:** Main owns discovery, scheduling and explicit installation. Pin `electron-updater@6.8.9` behind a custom provider. Load authoritative CAP-1–4 and acceptance companions from `_bmad-output/specs/spec-in-app-updates/` before implementation.

## Boundaries & Constraints

**Always:** macOS arm64; semantic maximum; strict stable/beta isolation; consistent tag/manifest/payload; integrity and publisher verification before replacement. Preserve data, signing, sandbox, filesystem guards and DMG links. Persist uniform 6–10-hour deadlines; overdue recovery gets one 0–5-minute jitter. Manual checks coalesce, honor rate limits and retain scheduled deadlines. Download and install require separate user actions. Idle never authorizes installation.

**Ask First:** Specific release builds, notarization, upload, tags/publication; frozen-intent changes.

**Never:** Ordinary-quit installation, forced restart, channel switching, downgrade, credentials, telemetry, background service, other-platform/extension updates, renderer-selected URLs/paths, or unrelated edits.

## I/O & Edge-Case Matrix

| State | Behavior |
|---|---|
| Releases interleaved across pages | Greatest eligible same-channel semantic version; reject drafts/inconsistent flags |
| Missing/malformed metadata or incompatible ZIP | Unavailable/incomplete; never claim up-to-date or cross channels |
| Offline/rate limit/clock change/repeated wake | Persist deadlines, bounded attempts, no catch-up burst |
| Interrupted/corrupt download; wrong version/signature | Actionable failure; preserve current app |
| Starting/active/stopping/saving session; queued/running job; dirty input | Block installation with reason; require another explicit click |
| Idle and explicit install | Reserve against new work, obtain successful save/readiness, recheck, stage/restart |
| Failed save/readiness timeout/renderer loss | Abort before native staging |
| Development, mounted/translocated/read-only or unsupported app | Explain restriction; never replace |

</frozen-after-approval>

## Code Map

- `desktop/main.js`: `fromMain`; timed-out quit flush is unsafe for updates. Session starts await permissions before assigning proc; saves outlast helper exit. Use queue.list() and app.whenReady.
- `desktop/renderer/app.js`: autosave can retain dirty remainders; flushBeforeReplace allows discard. Neither proves readiness.
- `desktop/preload.js` versus `desktop/preload-panel.js`: main/companion trust boundary; `desktop/renderer/notes-list.js`: note drafts.
- `desktop/package.json`: DMG target, package allowlist, builder locked at 26.15.3.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/update-service.js` — injected clock/random state machine; atomic persistence, scheduling, coalescing, server deadlines and recovery.
- [x] `desktop/update-provider.js` — bounded paginated lookup, semantic/channel/metadata/assets, trusted redirects and candidate-bound custom provider.
- [x] `desktop/update-mac.js` — disable auto-download/install-on-quit/downgrade/deltas. Validate ZIP hash, paths, bundle identity/version/arm64; revalidate cache. Enforce native publisher checks and safe install location. Clean retry listeners.
- [x] `desktop/main.js`, `desktop/preload.js`, `desktop/renderer/app.js`, `desktop/renderer/notes-list.js`, `desktop/preload-panel.js` — sender-checked actions/token-bound readiness; track start-through-save sessions, jobs and pending writes/downloads. Reserve against new work/editing; save without discard, reject cross-window drafts; recheck before staging. Abort on failure/timeout/loss; preserve ordinary quit.
- [x] `desktop/renderer/updates.js`, `desktop/renderer/index.html`, `desktop/renderer/style.css` — accessible version/channel/status/progress, check/download/retry/install/later and quiet availability indicator.
- [x] `desktop/package.json`, `desktop/package-lock.json`, `desktop/scripts/verify-update-release.mjs`, `desktop/RELEASE.md` — pin/package runtime modules; add ZIP, channel manifests and app-update.yml/cache config while retaining DMGs. Verify version/channel/architecture/hash offline. Document draft-first uploads, bootstrap/native checks; no implicit publication.
- [x] `desktop/test/update-*.test.js`, `desktop/scripts/layout-check.mjs` — synthetic acceptance matrix, fake clocks/network, pinned-adapter behavior, lifecycle races, save failures, retries and ordinary-quit non-staging.

**Acceptance Criteria:**
- Given either channel, when checked, then discovery/scheduling match the source matrices.
- Given a download, when ordinary quit or failed readiness occurs, then native staging never starts.
- Given busy/dirty work, when install is requested, then preserve work and require another click.
- Given signed versions, when native tests run, then prove both-channel restart, rejection, recovery and data preservation.

## Spec Change Log

- Iteration 1: independent review found unsupported builder `zip` configuration, unprotected summary drafts, dead proxy retries, unsafe unlocking after nonterminal native staging timeout, case/Unicode ZIP aliases, missing OS compatibility, unbounded preparation/network operations, lost rate deadlines, missing cache restoration and renderer coverage. The implementation was preserved at `/private/tmp/in-app-updates-iteration-0/` and reverted before re-derivation. KEEP strict channel selection, injected scheduler, signature/hash validation, sender/token gate, source fixtures and existing successful layout coverage. Preserve all source intent and ordinary recording/quit behavior.

### Re-derivation requirements

- Packaging: use only builder 26.15.3 schema-supported naming (versioned ZIP plus unchanged DMG); execute its configuration validator without building.
- Readiness: include summary-rail edits and every supported draft; test actual updates renderer prepare/release and production main/notes participant wiring, not only helper substitutions. Keep progress accessible outside inert editing regions.
- Native commitment: finish bounded/cancellable preparation before starting Squirrel. Once staging starts, retain the exclusive reservation until a terminal native event; a watchdog must never report cancellation and unlock while late staging can still succeed. Handle renderer loss/quit during commitment explicitly without admitting fresh work. Native retry must recreate its proxy or require initialization through download; test the real serving lifecycle and delayed native events.
- ZIP validation: resolve case-folded Unicode-normalized aliases and reject ambiguous collisions before extraction. Verify manifest kernel minimum and payload LSMinimumSystemVersion against the running OS before staging; include unsupported-OS fixtures.
- Bounds: apply a total deadline across redirects/body streaming and all pre-staging validation, abort subprocesses and clean partial files. Preserve accumulated rate deadlines on every discovery failure and account for backward clock changes without permanent suppression.
- Cache: persist the candidate/cache relationship, restore downloaded readiness only after fresh validation on restart, and never download or stage automatically merely to restore it.
- Keep every reviewer finding accounted for in tests and verification evidence. Native signed-release demonstrations remain pending authorization.

## Design Notes

Q1: 6.8.9 with autoInstallOnAppQuit=false defers native staging. Downloaded does not mean publisher-verified. Finish readiness before quitAndInstall; native staging can subsequently apply on quit.

Evidence: [pinned source](https://github.com/electron-userland/electron-builder/tree/electron-updater%406.8.9/packages/electron-updater/src) (MacUpdater.ts, providerFactory.ts); [v26 requirements](https://www.electron.build/v26/docs/features/auto-update/). Native behavior remains a release-dependent verification gate.

## Verification

From desktop/: npm test; npm run check:layout; verifier fixtures. Root: git diff --check. Signed stable/beta replacement, sleep/resume and recovery remain pending explicitly authorized native testing.


## Implementation verification result

Implementation and independent review are complete. The full suite passed 389/389 tests with zero skips; real Electron layout passed 32/32 rows. Builder schema validation ran without building. All accepted review findings were fixed and regression-tested; no deferred findings remain. See [verification and review audit](in-app-updates-verification.md).

Native signed stable-to-stable and beta-to-beta replacement, actual restart/data preservation and physical sleep/resume are NOT verified. These require separately authorized release builds. This status records implementation completion, not the source specification's release-dependent success signal.

## Suggested Review Order

**Update lifecycle**

- Follow main-owned state through discovery, explicit actions and shutdown commitment.
  [update-service.js:20](../../desktop/update-service.js#L20)

- Inspect activity reservation and sender-checked wiring before trusting renderer readiness.
  [main.js:5841](../../desktop/main.js#L5841)

**Trust and installation**

- Validate every release, channel, manifest and payload binding before offering an update.
  [update-provider.js:97](../../desktop/update-provider.js#L97)

- Review signature, archive and OS checks before native staging can begin.
  [update-mac.js:121](../../desktop/update-mac.js#L121)

- Native commitment retains reservation; terminal failure requires explicit recovery.
  [update-mac.js:369](../../desktop/update-mac.js#L369)

- Token-bound readiness rejects drafts, lost windows and failed saves.
  [update-readiness.js:6](../../desktop/update-readiness.js#L6)

**User actions**

- Read accessible state transitions and distinct download/install actions.
  [updates.js:34](../../desktop/renderer/updates.js#L34)

**Supporting checks**

- Inspect failure fixtures, real proxy behavior and late native events.
  [update-mac.test.js:125](../../desktop/test/update-mac.test.js#L125)

- Exercise production renderer actions and preserve draft ownership.
  [update-renderer.test.js:78](../../desktop/test/update-renderer.test.js#L78)

- Packaging and offline verification retain existing DMG links.
  [verify-update-release.mjs:63](../../desktop/scripts/verify-update-release.mjs#L63)

- Release-dependent verification remains behind explicit authorization.
  [RELEASE.md:318](../../desktop/RELEASE.md#L318)
