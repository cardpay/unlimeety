---
title: 'PR 3: stop leaking API keys to the renderer, split preload by trust level, fix drag&drop'
type: 'feature'
created: '2026-09-06'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'f87282c024d1e74a489e313dd72bf7c7dde3fa4f'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Finding H (`/Users/v.ovchinnikov/.claude/plans/woolly-floating-scone.md`): `settings:getSummarizer`
hands the renderer decrypted OpenRouter/OpenAI-compatible API keys, which then sit in plaintext in the
Settings DOM; every window (including the notes/prompt companion windows, which share `preload.js` with
the main window) can invoke file/summary/settings/destructive-transcript/record IPC channels with zero
sender check; and drag&drop reads the removed `File.path` (gone since Electron 32), silently breaking it.

**Approach:** Mask the key in both directions of the summarizer settings IPC (`hasKey` instead of the
secret; empty key on save means "leave the stored key alone"), make the Settings key fields write-only.
Split `preload.js` into it plus a new, narrower `preload-panel.js` for the notes/prompt windows (only
`notesApi`/`promptApi`/`themeApi`), and add a `fromMain(e)` sender check to every handler reachable from
the main preload that touches `file:*`, `summary:*`, `settings:*`, or a destructive `transcripts:*`/`record:*`
channel. Fix drag&drop via `webUtils.getPathForFile` exposed through the main preload.

## Boundaries & Constraints

**Always:** `fromMain(e)` fails closed (`mainWindow` null → denied). Every guarded handler keeps its
existing success-path return shape; only the denied branch is new. `readSummarizerConfig()` (internal,
used by the 4 provider call sites) keeps returning the real decrypted key — only the two renderer-facing
handlers (`settings:getSummarizer`, and `setSummarizer`'s response) are masked to `hasKey`. `npm test`
stays green throughout.

**Ask First:** None identified — see Design Notes for the two judgment calls already made (destructive-only
scope for transcripts/record; no "explicitly clear the key" affordance).

**Never:** Do not touch `extenstion/` (separate parallel branch owns finding-4/background.js). Do not
implement the PII git-history rewrite, Electron bump, or packaging/fuses work. Do not add a "clear API key"
UI — out of scope. Item 4 (runChat* consolidation) is optional; implement only if it survives the
judgment call below, otherwise record the decision and stop.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Settings opened with a stored OpenRouter key | `settings:getSummarizer` invoked from main window | `{ openrouter: { hasKey: true, model, baseUrl }, ... }` — no `apiKey` field | N/A |
| Save settings, key field left blank | `setSummarizer({ openrouter: { apiKey: '', ... } })`, a key already stored | stored `apiKeyEnc` unchanged; other fields (model/baseUrl) update | N/A |
| Save settings, key field filled | `setSummarizer({ openrouter: { apiKey: 'sk-new', ... } })` | old key replaced, re-encrypted | N/A |
| Notes window tries a guarded channel | any `file:*`/`summary:*`/`settings:*`/destructive `transcripts:*`/`record:*` invoked with `e.sender !== mainWindow.webContents` | handler's denied-branch value (see Design Notes table), no fs/config mutation | N/A |
| Drag a file onto the main window | drop event with a `File` whose `.path` is `''` (Electron ≥32) | `webUtils.getPathForFile(file)` resolves the real path; editor loads it | N/A |

</frozen-after-approval>

## Code Map

(Line numbers below are post-implementation, from the landed commit — verify by content on any future read,
per this repo's own convention for the plan document these findings came from.)

- `desktop/main.js:1285` `settings:getSummarizer` / `:1239` `readSummarizerConfig` (kept as-is,
  internal) / `:1320` `settings:setSummarizer` — added `publicSummarizerConfig()` masking helper + `fromMain`.
- `desktop/main.js:155` `function fromMain(e)` — added right after `let mainWindow`.
- `desktop/main.js` ~29 handlers to guard: `file:accepted, file:open, file:save, file:saveSync, file:saveAs`;
  `summary:save, summary:overwrite, summary:setName, summary:load`; `settings:getSummaryFolder,
  setSummaryFolder, pickFolder, getGlossary, setGlossary, getSummarizer, setSummarizer, getAutoStop,
  setAutoStop`; destructive `transcripts:delete, deleteTranscriptOnly, deleteSummaryOnly, deleteAudioOnly,
  create, rename, enhance`; destructive `record:delete, deleteMany, rename, deleteModel`. Read-only
  transcripts/record channels (list/search/watch/getAudioPath/openFile/platformOK/start/stop/etc.) are
  NOT guarded (decision recorded in Design Notes).
- `desktop/main.js:4900` `showNotesWindow` / `:5044` `showPromptWindow` — swapped `preload: preload.js` for
  `preload: preload-panel.js`.
- `desktop/preload.js` — add `getPathForFile` (via `webUtils`) to the `transcriber` bridge; keep
  `notesApi`/`promptApi`/`themeApi` (main window's Record tab and theme sync still use them).
- `desktop/preload-panel.js` (new) — `notesApi`/`promptApi`/`themeApi` only, duplicated (not shared/required)
  from preload.js's existing blocks.
- `desktop/renderer/app.js:5253-5289` `openSettingsModal`, `:5295-5369` `saveSettings` — key fields become
  write-only (`value` never set from `cfg`, placeholder + `dataset.hasKey` instead); validation checks
  `dataset.hasKey` before requiring a key.
- `desktop/renderer/app.js:3909-3917` drop handler — `file.path` → `await window.transcriber.getPathForFile(file)`.
- `desktop/test/renderer-globals.test.js` — bridge scan reads both `preload.js` and `preload-panel.js`.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/main.js` -- add `fromMain(e)` near `mainWindow` -- single guard fn, fails closed
- [x] `desktop/main.js` -- add `publicSummarizerConfig()`; rewire `settings:getSummarizer`/`setSummarizer` to use it + guard -- stop leaking decrypted keys; preserve key on empty input
- [x] `desktop/main.js` -- add `fromMain(e)` check as the first line of the ~29 listed handlers -- close the cross-window IPC gap
- [x] `desktop/preload.js` -- expose `getPathForFile` via `webUtils` -- unblocks the drag&drop fix
- [x] `desktop/preload-panel.js` (new) -- `notesApi`/`promptApi`/`themeApi` only -- narrow surface for companion windows
- [x] `desktop/main.js` -- point `showNotesWindow`/`showPromptWindow` at `preload-panel.js`
- [x] `desktop/renderer/app.js` -- settings key fields write-only + `hasKey`-aware validation
- [x] `desktop/renderer/app.js` -- drop handler uses `getPathForFile`
- [x] `desktop/test/renderer-globals.test.js` -- scan bridges from both preload files
- [x] new test files -- `test/preload-split.test.js` (preload-panel.js exact surface, window creation
  wiring, fromMain source-scan across all 29 channels + one execution-level end-to-end proof on
  `transcripts:delete`, drop-handler source-scan) and `test/summarizer-key-masking.test.js`
  (`publicSummarizerConfig`/`preserveApiKeyFields` unit tests + three execution-level end-to-end tests
  against the real `settings:setSummarizer` handler, via the sandboxed-slice + stub `safeStorage`
  technique from `test/config-persistence.test.js`). Also fixed two pre-existing tests
  (`test/delete-prunes-summary-name.test.js`, `test/enhance-confirm.test.js`) whose handler-slicing
  sandboxes needed a `fromMain` stub injected once the guard was added.

**Acceptance Criteria:**
- Given a window whose `webContents` is not `mainWindow`'s, when it invokes any guarded channel, then the
  handler returns its denied value and performs no filesystem/config mutation.
- Given a stored OpenRouter key, when Settings is opened, then the key field is empty and the placeholder/
  UI signals a key is set, and saving with the field still blank preserves the stored key.
- Given Electron ≥32, when a file is dropped onto the main window, then `state.filePath` resolves to a real
  path (not empty), and the editor loads its content.

## Design Notes

**Destructive-only scope for transcripts/record** (judgment call, no synchronous human available): the
plan says "a destructive `transcripts:*`/`record:*` channel" without enumerating which. Guarded:
`delete, deleteTranscriptOnly, deleteSummaryOnly, deleteAudioOnly, create, rename, enhance` (transcripts)
and `delete, deleteMany, rename, deleteModel` (record) — these delete, overwrite, or spend paid API calls.
Left unguarded: read-only/navigational channels (`list, search, watch, getFolder, getAudioPath, openFile`;
`platformOK, start, stop, micStatus, list, watch, showInFinder, pickAudioFile, transcribe,
autoQueueTranscribe, getInstalledModels`) — after the preload split these are moot anyway for notes/prompt
windows (not exposed on their bridge at all), so this is defense-in-depth, not the only barrier.

**No "clear the key" affordance**: empty key on save now always means "keep existing" — there is no
longer a way to explicitly wipe a stored key via Settings (switching provider away is the workaround).
Accepted per the plan's explicit "leave it as is" convention; flagging a UI affordance for explicit clear
is out of scope.

**preload-panel.js duplicates rather than requires** the notes/prompt/theme block from preload.js: both
windows run with `sandbox: true`, and relying on a sandboxed preload's ability to `require()` a second
local CommonJS file is an unproven pattern in this codebase — safer to duplicate ~30 already-working
lines than risk an untested cross-file require path in a security-sensitive file.

**Denied-branch return shapes** (must match each handler's existing success contract so callers don't need
new handling): `null` for `file:open`, `settings:getSummaryFolder`, `settings:getSummarizer`; `''` for
`settings:getGlossary`; `false` for `settings:getAutoStop`; `{ ok: false, error: 'Forbidden' }` for every
other `.handle`; `e.returnValue = { ok: false, error: 'Forbidden' }` for `file:saveSync`; a silent early
`return` for the `.on` listener `file:accepted`.

**Item 4 (optional, runChat* consolidation) — decision: skip.** `runOpenRouter/runOpenAICompat/runOllama`
(summarize-side: single content+instruction, `withCancelFlag`/abort wiring, 300s/600s timeouts, returns
`summary`) and `runChatOpenRouter/OpenAICompat/Ollama` (chat-side: `systemText`+`chat` array, no abort
wiring, returns `reply`) differ enough (abort semantics, timeout messages, return field name) that a real
merge means parameterizing all of that, updating `runSummarizerProvider`'s switch, `chat:ask`'s dispatch,
and two test files (`test/prompt-framing.test.js` slices `runChatOpenRouter` etc. by name). That's a
nontrivial diff for a pure internal refactor with no functional or security payoff on its own, bundled into
a PR already changing IPC trust boundaries. Not implementing. The sibling note "don't send `Source:`/
`Model:` to the cloud provider" is a real, separate, small privacy improvement (confirmed: `runSummarizeJob`
reads the whole file including its header verbatim) but is not part of what this task asked me to build —
flagged separately rather than folded in unasked.

**Adversarial review (blind-hunter, edge-case-hunter, verification-gap; parallel, single round) — disposition:**
- **patch, applied:** `desktop/package.json`'s electron-builder `build.files` allowlist never listed
  `preload-panel.js` — a packaged release would have shipped `showNotesWindow`/`showPromptWindow` pointing
  at a file missing from the asar, silently breaking the notes panel and call-detect prompt in every real
  build while `npm test`/dev `npm start` (source tree, no packaging) showed nothing wrong. Added.
- **patch, applied:** `settings:getSummarizer` had no test pinning that it returns `publicSummarizerConfig()`
  rather than the old `readSummarizerConfig()` — added. The `fromMain(e)` guard's regression coverage was a
  substring check across all 29 channels (would not catch a polarity flip); added two more execution-level
  proofs (`settings:setGlossary`, `record:deleteModel`) alongside the existing `transcripts:delete` one, as a
  representative spot-check rather than 29 full executions. `preload.js`/`preload-panel.js`'s duplicated
  notesApi/promptApi/themeApi blocks had no drift guard — added a method-name-set comparison. The drop
  handler didn't guard an empty `getPathForFile` result — added `if (!filePath) return;` + test (also raised
  independently by edge-case-hunter). `openSettingsModal`'s `hasKey`-ternary tests only checked the token was
  present, not its polarity — tightened to pin the exact `cfg.hasKey ? "1" : ""` expression (full DOM
  execution of `openSettingsModal`/`saveSettings` was judged disproportionate: this repo has no DOM harness
  for the renderer at all, by an existing test's own admission, and both functions touch ~20 DOM elements).
  Code Map's line numbers (drifted post-implementation) were refreshed.
- **defer, appended to `deferred-work.md`:** the guarded-channel scope (`prompts:save`/`delete`,
  `summarize:run`, `chat:ask`, `export:pdf`/`docx`, `followup:draft`/`share` are equally sensitive but sit
  outside file:*/summary:*/settings:*/destructive-transcripts-or-record — pre-existing gap, not introduced
  here, but this PR's own criteria arguably cover them too); `hasKey`'s inability to distinguish "no key" from
  "key present but undecryptable" (pre-existing `decryptApiKey` ambiguity, now the only signal shown).
- **reject:** no logging/counter on a denied `fromMain` call (no established security-event-logging pattern
  in this codebase; scope creep for this PR); a claimed `openai-compatible` key-requirement asymmetry in
  `saveSettings` (false premise — that provider's key was never required, it's labeled "optional" in its own
  UI, both before and after this change).

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: all suites pass, 0 fail (baseline 172/172 before this change)

**Manual checks (if no CLI):**
- Launch the app, open Settings with no key stored → field empty, placeholder default. Enter a key, save,
  reopen Settings → field still empty, placeholder now signals "key set". Change only the model, save →
  key still works on next summarize (no re-entry needed).
- Drag a `.txt` file from Finder onto the main window → it loads (content visible), matching the existing
  "File > Open" path.

## Suggested Review Order

**IPC sender guard (the core trust-boundary fix)**

- Single guard function every gated handler calls; fails closed if `mainWindow` is null.
  [`main.js:155`](../../desktop/main.js#L155)

- Representative gated handler — the guard as the handler's first line, denied branch matches the existing error shape.
  [`main.js:2519`](../../desktop/main.js#L2519)

- Full list of the ~29 gated channels and the destructive-only scope decision for transcripts/record.
  [`preload-split.test.js:137`](../../desktop/test/preload-split.test.js#L137)

**API key exposure (settings:getSummarizer / settings:setSummarizer)**

- `hasKey` replaces the decrypted secret in the renderer-facing shape.
  [`main.js:1263`](../../desktop/main.js#L1263)

- Empty key on save preserves the stored `apiKeyEnc`/`apiKey` instead of wiping it.
  [`main.js:1278`](../../desktop/main.js#L1278)

- Both handlers wired to the masking helper and the sender guard together.
  [`main.js:1285`](../../desktop/main.js#L1285)

**Preload split (main window vs. notes/prompt companion windows)**

- New narrow preload — only notesApi/promptApi/themeApi, duplicated rather than shared (see Design Notes).
  [`preload-panel.js:17`](../../desktop/preload-panel.js#L17)

- `webUtils` added for the drag&drop fix; existing bridges otherwise unchanged.
  [`preload.js:1`](../../desktop/preload.js#L1)

- Companion windows now load the narrow preload instead of the main one.
  [`main.js:4900`](../../desktop/main.js#L4900)

**Renderer: write-only key fields and the drag&drop fix**

- Key fields never pre-filled from `cfg`; `dataset.hasKey` drives the placeholder and later validation.
  [`app.js:5285`](../../desktop/renderer/app.js#L5285)

- Validation only demands a fresh key when none is already stored.
  [`app.js:5321`](../../desktop/renderer/app.js#L5321)

- `webUtils.getPathForFile` replaces the Electron-32-removed `File.path`; bails out on an unresolvable path.
  [`app.js:3909`](../../desktop/renderer/app.js#L3909)

**Peripherals**

- Packaging fix caught by review: `preload-panel.js` was missing from the electron-builder file list.
  [`package.json:29`](../../desktop/package.json#L29)

- Bridge-shadowing test extended to scan both preload files.
  [`renderer-globals.test.js:24`](../../desktop/test/renderer-globals.test.js#L24)

- End-to-end masking/preserve-on-blank-key tests against the real handler.
  [`summarizer-key-masking.test.js:225`](../../desktop/test/summarizer-key-masking.test.js#L225)
