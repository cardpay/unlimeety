---
title: 'Packaging hardening: electron fuses, entitlement, PDF temp-file'
type: 'bugfix'
created: '2026-09-06'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'f87282c024d1e74a489e313dd72bf7c7dde3fa4f'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The packaged macOS build ships with Electron fuses left at their insecure defaults (`RunAsNode`/CLI-inspect/NODE_OPTIONS enabled, ASAR integrity checks disabled), an unused `disable-library-validation` entitlement that weakens the hardened-runtime protection for no benefit, and a PDF export path (`generatePdf`, `desktop/main.js`) that writes to a predictable filename via a plain `fs.writeFileSync`, plantable by a symlink on a shared `/tmp`.

**Approach:** Add an `electronFuses` block to `desktop/package.json`'s electron-builder config; remove the unused entitlement from `desktop/build/entitlements.mac.inherit.plist`; rewrite `generatePdf`'s temp file to use a `crypto.randomBytes`-derived name opened with `fs.openSync(path, 'wx', 0o600)`, mirroring the existing `writeFileAtomic` `'wx'` convention already in `main.js`.

## Boundaries & Constraints

**Always:** `npm test` stays green (172/172 baseline). The `setWindowOpenHandler`/`will-navigate` guards already in `generatePdf` (shipped PR2 hardening) are preserved untouched. The packaged app must still launch and codesign-verify after the changes — verified with a real `npm run build:mac`, not just unit tests.

**Ask First:** None — every decision below was pre-researched and is recorded in Design Notes; Auto Mode authorizes proceeding without a synchronous human checkpoint.

**Never:** Do not touch `desktop/package.json`'s `"electron"` devDependency version (owned by a parallel `feature/electron-44-upgrade` agent). Do not touch PII, PR3/preload work, or `extenstion/`. Never `git add` `desktop/build/icon.ico`, `desktop/build/icon.png`, `store-listing.md`, `store-listing.en.md`. Do not wrap the PDF temp file in `writeFileAtomic` (no existing target to replace — it is a fresh scratch file) or switch to a `data:` URL (rejected: exported transcripts can be large and mostly Cyrillic, and `encodeURIComponent` inflates such text 3-4x, risking Chromium's practical data-URL size ceiling for a real multi-hour meeting export).

</frozen-after-approval>

## Code Map

- `desktop/package.json` -- `build` config; add sibling `electronFuses` key next to `mac`/`win`/`linux`. `@electron/fuses@1.8.0` already resolves in `package-lock.json:78-93` as an `electron-builder` transitive dep — no new dependency.
- `node_modules/app-builder-lib/out/platformPackager.js:257-321` -- confirms electron-builder's `doAddElectronFuses()` runs immediately before `doSignAfterPack()` ("the fuses MUST be flipped right before signing"); `resetAdHocDarwinSignature` not needed for this pipeline (verify empirically anyway).
- `desktop/build/entitlements.mac.inherit.plist:9-10` -- remove the `com.apple.security.cs.disable-library-validation` key/value pair. Also signs the Swift helper via `package.json`'s `build:helper` script.
- `desktop/main.js:606-633` -- `writeFileAtomic`'s `'wx'`-then-rename pattern to mirror (not call directly — no rename needed for a fresh scratch file).
- `desktop/main.js:708-729` -- `generatePdf`; replace `tmpPath` + `fs.writeFileSync` with a random-name `fs.openSync(path, 'wx', 0o600)` + write + close. No `crypto` import exists yet in `main.js` — add `const crypto = require('crypto');` near the other top-of-file requires.
- `desktop/test/path-guards.test.js` -- `sliceFunction`/`sliceBraces`/vm-parse-check technique for testing `main.js` internals without requiring electron; new test file follows the same shape.
- Verified, no code change: zero native `.node` modules reach the packaged app — sole prod dep `docx@9.7.1` has no sub-dependencies; the only `.node` files anywhere in `node_modules/` belong to `@electron-internal/extract-zip`, electron-builder's own build-time tool (never in the `files` allowlist).

## Tasks & Acceptance

**Execution:**
- [x] `desktop/package.json` -- add `"electronFuses": { "runAsNode": false, "enableNodeCliInspectArguments": false, "enableNodeOptionsEnvironmentVariable": false, "onlyLoadAppFromAsar": true, "enableEmbeddedAsarIntegrityValidation": true, "enableCookieEncryption": true }` as a sibling of `"mac"`/`"win"`/`"linux"` inside `"build"` -- burns the fuses that matter for a signed, TCC-granted app.
- [x] `desktop/build/entitlements.mac.inherit.plist` -- delete the `disable-library-validation` key+value pair -- removes an unused hardened-runtime bypass.
- [x] `desktop/main.js` -- add `crypto` require; rewrite `generatePdf`'s temp-file creation to a random name + `'wx'` open -- closes the symlink-plant window.
- [x] `desktop/test/generate-pdf-tempfile.test.js` (new) -- `mkdtemp`-based test asserting the sliced `generatePdf` source uses `crypto.randomBytes` + `'wx'`, and a runtime check that two sequential temp names never collide and that opening the same name twice with `'wx'` throws `EEXIST` (proves the flag is load-bearing).
- [x] Real build -- `cd desktop && npm run build:mac`, then run the three verification commands below against `dist/mac-arm64/Unlimeety.app`. Result: build exited 0 (`.app` + `.dmg` produced); `@electron/fuses read` shows all six configured fuses in the configured state; `codesign -d --entitlements :-` on `unlimeety-live` shows no `disable-library-validation`, only `allow-jit`/`allow-unsigned-executable-memory`/`personal-information.calendars`; `codesign --verify --deep --strict --verbose=2` walked every nested helper/framework (both Electron helper apps, GPU/Renderer/Plugin helpers, Mantle/Squirrel/ReactiveObjC/Electron Framework) and reported "valid on disk" / "satisfies its Designated Requirement", exit 0 — the entitlement removal did not break any nested component's ability to load its dylibs.

**Acceptance Criteria:**
- Given the built app, when `npx @electron/fuses read --app dist/mac-arm64/Unlimeety.app` runs, then all six configured fuses report their configured state.
- Given the built app, when `codesign -d --entitlements :- .../MacOS/unlimeety-live` runs, then `disable-library-validation` is absent and the command exits 0.
- Given the built app, when `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Unlimeety.app` runs, then it exits 0 (valid on disk).
- Given a concurrent PDF export attempt racing the same temp name, when the second `fs.openSync(..., 'wx')` runs, then it throws instead of following/overwriting.

## Spec Change Log

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: 172+ passing, 0 failing.
- `cd desktop && npm run build:mac` -- expected: exits 0, produces `dist/mac-arm64/Unlimeety.app` (the four AC commands above are then run against it).

**Manual checks (if no CLI):** Full notarized-build smoke and live Live/Record/Calendar UI testing needs real Apple notarization credentials and a human clicking through the app — out of scope for this session; report as incomplete, not silently skipped.
</frozen-after-approval>
