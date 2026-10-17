# In-app updates implementation verification

Date: 2026-10-17

Baseline: `4f2651203ed5cfc82aeea1eddde9f4dcecb195ed`

## Result and boundary

The implementation is complete and reviewed. Final `npm test` passed **389/389**, zero skipped/cancelled; real Electron `npm run check:layout` passed **32/32**. Builder 26.15.3 schema validation passed without packaging. Runtime pins, `git diff --check` and the existing personal-data guard passed.

No release build, signing, notarization, upload, tag, publication or installed-application replacement was performed. Native signed stable/beta replacement, actual restart, data preservation and physical sleep/resume remain pending separately authorized testing. Fake native events establish JavaScript behavior, not native installation success.

Local run logs: `/private/tmp/in-app-updates-review-patch-tests.log`, `/private/tmp/in-app-updates-review-patch-layout.log`.

## Matrix audit

Every implementation matrix row has executed passing coverage:

| Matrix concern | Executed coverage |
|---|---|
| Interleaved releases, channels, semantic maximum, malformed versions | `desktop/test/update-provider.test.js`: channel fixtures, later-page selection, flags, metadata, canonical build metadata |
| Missing or incompatible metadata/ZIP | Provider incomplete-assets fixtures; `update-release.test.js`: real ZIP fixtures, identity/version/architecture/hash failures |
| Offline, rate limits, clock changes, repeated wake | `update-service.test.js`: persisted deadlines, jitter/coalescing, clock jumps and transient persistence recovery; provider redirect/deadline fixtures |
| Interrupted/corrupt download and publisher failure | `update-mac.test.js`: strict transport, cancellation, cache revalidation and native failures; `update-release.test.js`: signature-command rejection and extraction cleanup |
| Starting/active/stopping/saving work, jobs and drafts | `update-integration.test.js`: actual IPC lifetime/busy gate; `update-renderer.test.js`: actual prepare/release, summary/chat/dialog/note/title ownership |
| Explicit idle install | `update-service.test.js`: separate actions, reservation/recheck and confirmed-shutdown retention; `update-mac.test.js`: real pinned proxy recreation and delayed native events |
| Save failure, timeout and renderer loss | `update-readiness.test.js`: sender/token validation, all window-loss events, timeout, pre-commit abort and post-commit retention |
| Development/mounted/read-only/unsupported location | `update-mac.test.js`: development/platform/architecture/mounted guards; filesystem/publisher failures fail before native staging |

Tests that invoke code-signing commands use synthetic command results. Permission, disk and save failures are injected; real replacement and disk-full recovery remain part of the native release matrix.

## Independent review disposition

The first review identified missing implementation details in the non-frozen plan (`bad_spec`, high). Code was preserved and reverted, the plan was amended outside frozen intent, and the implementation was re-derived. Strict channels, scheduling, integrity checks and existing successful test coverage were retained.

| Finding group | Severity/category | Resolution |
|---|---|---|
| Unsupported ZIP configuration | High, bad_spec | Supported macOS naming with DMG override; actual builder schema test |
| Summary/editor/notes readiness and production participant wiring | High, bad_spec | Draft guards and actual renderer/main wiring tests |
| Proxy retries and late native completion | High, bad_spec | Recreated proxy, explicit commitment, terminal-event handling and retained reservation |
| Case/Unicode ZIP aliases and missing OS compatibility | High, bad_spec | Pre-extraction alias checks and kernel/bundle minimum validation |
| Preparation/network bounds and discarded rate deadlines | Medium, bad_spec | Shared cancellation budgets, bounded subprocesses/transport and deadline propagation |
| Cache restoration, backward clocks and accessible progress | Medium, bad_spec | Revalidated persisted candidate, translated deadlines and non-inert activity status |
| Native unavailable event; release before confirmed shutdown; closing committed window | High, patch | Terminal unavailable handling, reservation through `quit`, close guard |
| Unbounded pinned cache hash/proxy setup and unused response bodies | Medium, patch | Signal-aware pinned cache lookup, total budget, late-event guards and destroyed unused bodies |
| Safe polling contracts and successful redirect rate limits | Medium, patch | Explicit safe reads and deadline aggregation with streaming fixtures |
| Generated calendar titles, persistence recovery and semantic build metadata | Medium, patch | Existing user-title ownership, scheduler rearming and canonical semantic parsing |
| Missing action transitions and vertical layout coverage | Medium, patch | Actual click/state tests and 32 production-state layout rows |

No accepted findings remain unresolved and no pre-existing findings were deferred. Cancellation after native commitment is deliberately not claimed: Squirrel exposes no cancellation contract. Saved work stays reserved until a terminal native result or confirmed quit; the watchdog reports delay without unlocking. This prevents a late staged update from silently applying after fresh work was admitted.

## Release follow-up

Follow `desktop/RELEASE.md` only after a specific release is authorized. Existing binaries without this updater require a one-time manual installation. Publish ZIP/manifest assets alongside the existing DMG through a verified draft release. Exercise old-to-new stable and beta installations with the opposite channel available, publisher rejection, ordinary quit after Download/Later, failed replacement, actual relaunch version, and unchanged user-data/cache contents.
