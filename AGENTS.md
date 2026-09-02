<!-- bmad:context -->
<!-- Verified 2026-08-20 against bcaabda. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## unlimeety

On-device meeting transcription and summarization for macOS: an Electron app in `desktop/`, a Swift
WhisperKit/SpeakerKit helper, and a Chrome extension. `README.md` covers usage, dev setup and layout;
`desktop/RELEASE.md` covers cutting a signed release.

## Policy

- Land every change through a PR from a `feature/*` branch — never push to `main` directly, version
  bumps included.
- Do GitHub work through the `gh` CLI — PRs, releases, tag pushes — not plain git over SSH.
- Never `git add` `desktop/build/icon.ico`, `desktop/build/icon.png`, `store-listing.md` or
  `store-listing.en.md` — they are deliberately kept out of git.
- "Unlimeety", "Unlimit" and `extenstion/2025_Unlimit_Sign_black.jpg` are trademarks outside the MIT
  license — do not carry them into new files or artifacts.

## Where things are

- Electron main process and every IPC handler: `desktop/main.js`; the bridge is `desktop/preload.js`
- Swift live helper, arm64 and macOS 14.2+ only: `desktop/live-helper/`
- Chrome extension: `extenstion/` — the directory name is misspelled, search for it that way
- Cutting a release: follow `desktop/RELEASE.md` step by step, not from memory

## Running and verifying

- Run every npm command from `desktop/`; the repository root has no `package.json`.
- `npm test` (`node --test`, under a second) covers the pure modules (`glossary`,
  `summary-frontmatter`, `transcript-enhance`, `job-queue`) plus renderer logic sliced out of
  `renderer/app.js` into a `vm` sandbox (`library-filters`, `transcript-meta`, `meeting-date-format`,
  `rail-sections`, `speaker-naming`, `renderer-globals`). `main.js` has no tests, and anything in
  `renderer/` that needs a real DOM does not either — verify those by launching the app.
- Verify locally before pushing; there is no CI.
- Node >= 18. The Live tab additionally needs Apple Silicon on macOS 14.2+ and Xcode command line
  tools for `swift build`.

## Conventions that differ from defaults

- Every filesystem path reaching `main.js` passes `canReadPath` / `canWritePath` /
  `summaryDirAllowed`, and user-picked paths are recorded with `registerReadablePath` — a new IPC
  handler touching a path without them is a security regression, not a style slip.
- New `BrowserWindow`s keep `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; the
  renderer CSP lives in `desktop/renderer/index.html`.

## Known pitfalls

- There is one meeting menu now — `openMeetingMenu` in `desktop/renderer/app.js`. The Record tab's
  duplicate went out with its recordings sidebar; recordings without a transcript are ordinary rows
  in the Meetings list, and every action on them goes through a `record:*` IPC handler against the
  wav path rather than a `transcripts:*` one against a `.txt`.
- A renderer script's top-level `const` must never share a name with a `contextBridge` global
  (`transcriber`, `queueApi`, `recordApi`, …) — it is a parse-time SyntaxError that kills the whole
  file silently. `test/renderer-globals.test.js` guards this.

<!-- /bmad:context -->
