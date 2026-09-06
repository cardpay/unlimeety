---
title: 'Security: path guards & header sanitization (PR 1)'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '07c34b83e0877786f71d167529c0e276a5df43f8'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Transcript header fields (`Source:`, `Meeting:`, `Participants:`) are attacker-controlled
(voice, extension DOM, calendar invite, pasted text) yet are used as trusted control data: `Source:` feeds
`fs.unlinkSync` via `findRelatedAudioPaths` without a path-containment check, several delete/rename
handlers use `startsWith(FOLDER)` instead of real containment, header writers never strip `\n`/control
chars, and `summary:save`/`overwrite` write through `fs.writeFileSync` (follows a planted symlink).
Net effect: a planted transcript + "Delete meeting" can delete an arbitrary file the user can write.

**Approach:** Gate `Source:`-derived paths through the existing `canReadPath`, replace every
`startsWith(FOLDER)` containment check with the existing `isPathInside` (+`canWritePath` where the
renderer also supplies the write target), sanitize every header writer through one new `headerValue`
helper, switch summary save/overwrite to the existing `writeFileAtomic`, and reject symlinks in the
transcript list/search plus tighten whisper-model-name path joins behind one shared regex.

## Boundaries & Constraints

**Always:** Reuse existing helpers only — `canReadPath`, `canWritePath`, `isPathInside`, `writeFileAtomic`
(all in `desktop/main.js`) — never duplicate path-containment logic. `headerValue` strips
`[\x00-\x1f\x7f]` and collapses whitespace but must NOT touch `:` (`sanitizeFilenameChars` already does
and is unusable here for that reason). Delete confirmation dialogs show `path.basename(...)`, never the
full path. `AUDIO_EXTS` and `WHISPER_MODEL_RE` are each a single shared constant used at every listed call
site, not re-declared per site.

**Ask First:** Nothing — call sites, helper reuse, and constants are fully pinned below.

**Never:** Touch PR 2 scope (Claude Code isolation flags, prompt framing, link/URL/PDF filters — findings
E/F/G) or PR 3 (H). Never touch `transcript-enhance.js` `mergeEnhanced`/chunk framing. Never add a new
dependency. Never change `record:pickAudioFile`'s no-copy-on-import behavior — the resulting
`canReadPath(source)`-after-restart gap for imported audio is an accepted caveat (see Design Notes),
follow-up tracked as PR 3 item 3.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Planted `Source:` header | `.txt` in `TRANSCRIPTS_FOLDER` with `Source: /tmp/victim.wav`, file exists, not `canReadPath` | `findRelatedAudioPaths`/`transcripts:getAudioPath` never return it; card shows no player; Delete meeting only deletes the transcript | N/A |
| Control chars in rename/create title or participants | `newTitle = "A\t\tB   C"` or a participant `"x\ny"` | Header line collapses to one line: `Meeting: A B C`; no new header line is injected | N/A |
| Delete/rename handler given a sibling-folder or traversal path | `.../Meet_Transcripts_evil/x.txt` or `.../Meet_Transcripts/../../x` | `isPathInside` returns false; handler returns `{ok:false}` without touching the filesystem | returned as `{ok:false, error}` |
| Summary save/overwrite target is a symlink | `<title>.summary.md` is a symlink to `~/victim.txt` | `writeFileAtomic` renames a temp file onto the symlink path itself; `~/victim.txt` content unchanged | N/A |
| Symlinked `.txt` inside `TRANSCRIPTS_FOLDER` | entry is a symlink to a file elsewhere | `transcripts:list`/`transcripts:search` skip it (not a real file via `lstatSync`) | N/A |

</frozen-after-approval>

## Code Map

- `desktop/main.js:134` `isPathInside(child, parent)` -- existing containment check, reuse for C.
- `desktop/main.js:182` `canReadPath(p)` -- existing read allow-list (managed folders + explicit grants), reuse for A.
- `desktop/main.js:198` `canWritePath(p)` -- existing write allow-list, reuse for the one C site that writes (`transcripts:rename`).
- `desktop/main.js:520` `writeFileAtomic(target, content)` -- existing atomic/symlink-safe writer, reuse for D.
- `desktop/main.js:1901` `setHeaderLine(content, key, value)` -- wrap call sites with new `headerValue`.
- `desktop/main.js:2138-2166` `findRelatedAudioPaths(transcriptPath)` -- add `canReadPath`+`AUDIO_EXTS` gate on `info.source`.
- `desktop/main.js:2168` `transcripts:getAudioPath` handler -- add `canReadPath` early return.
- `desktop/main.js:2177,2186-2187` `transcripts:delete` -- C fix + basename in dialog `detail`.
- `desktop/main.js:2234,2259,2286,2293` `transcripts:deleteTranscriptOnly/deleteSummaryOnly/deleteAudioOnly` -- C fix + basename in dialogs.
- `desktop/main.js:2334-2346` `transcripts:create` -- `headerValue` on title/participants.
- `desktop/main.js:2660-2674` `transcripts:rename` -- C fix (`isPathInside` + `canWritePath`, pattern at `main.js:2402-2410`) + `headerValue` on `trimmed`.
- `desktop/main.js:2748` `liveModelDir()` region -- add `WHISPER_MODEL_RE` constant near here.
- `desktop/main.js:2989` `live:start` -- validate `opts.model` against `WHISPER_MODEL_RE`.
- `desktop/main.js:3098` `live:downloadModel` -- replace inline regex literal with `WHISPER_MODEL_RE`.
- `desktop/main.js:3162-3193` `live:saveTranscript` -- `headerValue` on `title`, each entry of `names`, and `participants`.
- `desktop/main.js:3707,3735,3766` `record:delete/deleteMany/rename` -- C fix.
- `desktop/main.js:3770-3830` `record:rename` -- `headerValue` on `trimmed`/`titleLine`.
- `desktop/main.js:3896` `record:pickAudioFile` dialog filter list -- lift extensions into shared `AUDIO_EXTS`.
- `desktop/main.js:3935` `runRecordTranscribeJob` -- validate `model` against `WHISPER_MODEL_RE`.
- `desktop/main.js:4119-4141` `runRecordTranscribeJob` header build -- `headerValue` on `title`/`participants`.
- `desktop/main.js:4287` `record:deleteModel` -- replace inline regex literal with `WHISPER_MODEL_RE`.
- `desktop/main.js:1000,1018` `summary:save`/`summary:overwrite` -- `fs.writeFileSync` → `writeFileAtomic`.
- `desktop/main.js:1975-1982` `transcripts:list` -- `fs.statSync(...).isFile()` → `fs.lstatSync(...).isFile()`.
- `desktop/main.js:2063-2073` `transcripts:search` -- same `lstatSync` fix.
- `desktop/main.js:1671-1683,2205-2214,2306` -- not touched here (PR 2/3 scope), listed only as reference for why A matters (renderer never shown a path today, `path.basename` change is dialog-only).

## Tasks & Acceptance

**Execution:**
- [x] `desktop/main.js` -- add `function headerValue(v)` next to `setHeaderLine` (:1901): strip
  `[\x00-\x1f\x7f]+` → space, collapse `\s+` → space, trim -- single reusable sanitizer for every header writer.
- [x] `desktop/main.js` -- add `const AUDIO_EXTS = new Set(['.wav','.mp3','.m4a','.mp4','.aac','.aif','.aiff','.caf','.flac'])` (extensions lifted from the `record:pickAudioFile` dialog filter, :3896) and `const WHISPER_MODEL_RE = /^openai_whisper-[A-Za-z0-9._-]+$/` near `liveModelDir` (:2748).
- [x] `desktop/main.js:2138-2166` `findRelatedAudioPaths` -- guard `info.source` push with
  `canReadPath(info.source) && AUDIO_EXTS.has(path.extname(info.source).toLowerCase())` instead of bare `fs.existsSync`.
- [x] `desktop/main.js:2168` `transcripts:getAudioPath` -- first line `if (!canReadPath(filePath)) return null;`.
- [x] `desktop/main.js:2177,2234,2259,2286,2660,3707,3735,3766` -- replace `startsWith(FOLDER)` with
  `isPathInside(p, FOLDER)`; `transcripts:rename` (:2660) additionally requires `canWritePath(filePath)`
  (mirrors `runEnhanceJob`, :2402-2410) since it's the only one of these that writes.
- [x] `desktop/main.js:2186-2187,2293` delete-confirmation dialogs -- show `path.basename(p)` for every path named in the `detail` string, never the absolute path. (No-op: audited every delete dialog's `detail` string — none interpolates a raw path, they only say "its summary" / "N audio recordings"; the invariant already held.)
- [x] `desktop/main.js:3896` `record:pickAudioFile` dialog filter -- derive `extensions` from `AUDIO_EXTS`
  (e.g. `[...AUDIO_EXTS].map(e => e.slice(1))`) so the picker and `findRelatedAudioPaths`'s gate can never drift apart.
- [x] `desktop/main.js:2334/2340/2342` `transcripts:create`, `:2664` `transcripts:rename`,
  `:3162/3163/3178-3193` `live:saveTranscript` (title, each `names` entry, participants),
  `:3770/3806-3830` `record:rename`, `:4119/4125` `runRecordTranscribeJob` header build -- route
  title/participant values through `headerValue` before writing; each `participants` array entry
  sanitized individually before `join(', ')`.
- [x] `desktop/main.js:1000,1018` `summary:save`/`summary:overwrite` -- `fs.writeFileSync(filePath, text, 'utf-8')` → `writeFileAtomic(filePath, text)`; keep existing `canReadPath`/`summaryDirAllowed` guard as-is (no `canWritePath` -- would block first save into a user-picked Obsidian folder).
- [x] `desktop/main.js:1982,2073` `transcripts:list`/`transcripts:search` -- `fs.statSync(...).isFile()` → `fs.lstatSync(...).isFile()`.
- [x] `desktop/main.js:2989,3098,3935,4287` -- validate/replace model-name checks with `WHISPER_MODEL_RE` (`live:start` gains a new check; `live:downloadModel`/`record:deleteModel` swap their inline regex literal for the constant; `runRecordTranscribeJob` gains a new check).
- [x] `desktop/test/path-guards.test.js` (new) -- `findRelatedAudioPaths` on `fs.mkdtempSync` fixtures: outside-source not returned, `RECORDINGS_FOLDER` wav returned first, in-folder `.txt` not returned, `registerReadablePath`-granted external wav returned; `isPathInside` traversal/sibling-folder/self cases; `writeFileAtomic` over a symlink leaves the symlink's target untouched; source-scan assertions (no bare `startsWith(TRANSCRIPTS|RECORDINGS_FOLDER)` left in `main.js`, summary handlers contain `writeFileAtomic(` not `fs.writeFileSync(`, `WHISPER_MODEL_RE.test(` appears ≥4 times).
- [x] `desktop/test/header-values.test.js` (new) -- `headerValue('a\r\n b\tc\u0000')` → `'a b c'`;
  `setHeaderLine` fed a value containing `\nSource: /etc/passwd` produces a single-line header with no
  injected line; source-slices of `transcripts:create`, `live:saveTranscript`, `runRecordTranscribeJob`
  each contain `headerValue(`.

**Acceptance Criteria:**
- Given a transcript with a forged `Source:` pointing at a file outside managed folders, when the user
  opens "Delete meeting", then that file is never touched and the dialog lists only real artifacts.
- Given a rename/create title containing control characters, when the header is written, then the
  resulting `Meeting:`/`Participants:` line has no embedded newline or control byte.
- Given a delete/rename IPC call with a path outside its managed folder (traversal or sibling folder),
  when the handler runs, then it returns `{ok:false}` and performs no filesystem mutation.
- Given an existing symlink at a summary's target path, when `summary:save`/`overwrite` runs, then the
  symlink's target file is unchanged.

## Design Notes

`record:pickAudioFile` transcribes an imported file in place without copying it into `RECORDINGS_FOLDER`;
`allowedReadPaths` lives only in memory, so after an app restart `canReadPath(source)` is false for that
file. Re-transcribing such a file already fails today (main.js:3931) for the same reason — this spec's `A`
fix (`canReadPath` gate in `findRelatedAudioPaths`) extends the identical, already-accepted behavior to
the player/"Delete audio" path. Persisting the grant across restarts is out of scope, tracked as PR 3
item 3.

`summary:save`/`overwrite` intentionally keep `canReadPath`/`summaryDirAllowed` (not `canWritePath`):
`canWritePath` would reject the very first save into a freshly-picked Obsidian folder outside the managed
folders. `writeFileAtomic`'s `wx`-opened, unpredictably-named temp file plus rename is what actually
defeats a planted symlink (rename replaces the symlink itself rather than following it), so it doesn't
need `canWritePath` to be safe here.

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: all tests green, including the two new files.

**Manual checks (if no CLI):**
- `printf 'Meeting: x\nSource: /tmp/victim.wav\n\n[00:00] A:\nhi\n' > ~/Downloads/Meet_Transcripts/evil.txt; touch /tmp/victim.wav` -- card shows no player; "Delete meeting" dialog lists only "the transcript"; after deleting, `/tmp/victim.wav` still exists.
- Rename a transcript to `"A\t\tB   C"` -- header becomes `Meeting: A B C`.
- DevTools console: `transcriber.deleteTranscript('.../Meet_Transcripts_evil/x.txt')` -- resolves `{ok:false}`.
- `ln -s ~/victim.txt ~/Downloads/Meet_Transcripts/"<Title DD-MM-YY>.summary.md"`, then Summarize + Save --
  `~/victim.txt` unchanged; the summary file itself saves normally; a first save into a picked Obsidian
  folder still succeeds.

## Suggested Review Order

**Source: header trust (finding A -- the core fix)**

- Entry point: a transcript's own `Source:` line is no longer trusted as a path -- gated by the same allow-list plus an audio-extension check.
  [`main.js:2172`](../../desktop/main.js#L2172)

- `transcripts:getAudioPath` gets the identical gate before it ever calls the function above.
  [`main.js:2198`](../../desktop/main.js#L2198)

- `AUDIO_EXTS` -- one shared extension set instead of two lists that could silently drift apart.
  [`main.js:2789`](../../desktop/main.js#L2789)

**Path containment: `startsWith(FOLDER)` to `isPathInside`/`canWritePath` (finding C)**

- `transcripts:rename` is the one delete/rename handler that also writes, so it alone gains `canWritePath` too.
  [`main.js:2692`](../../desktop/main.js#L2692)

- The four `transcripts:delete*` handlers switch to real relative-path containment.
  [`main.js:2207`](../../desktop/main.js#L2207)

- Same swap on the `record:delete`/`deleteMany`/`rename` side.
  [`main.js:3766`](../../desktop/main.js#L3766)

**Header sanitization: `headerValue()` (finding B)**

- The sanitizer itself -- strips control/C1 bytes (including NEL) and collapses whitespace, but never touches `:`.
  [`main.js:1913`](../../desktop/main.js#L1913)

- `live:saveTranscript`'s speaker-name map -- `null`/`undefined` pass through unsanitized so the caller's `|| fallback` still fires.
  [`main.js:3238`](../../desktop/main.js#L3238)

- Title, participants, and language each independently wrapped at every writer -- `transcripts:create`, `live:saveTranscript`, `runRecordTranscribeJob`, `transcripts:rename`/`record:rename`.
  [`main.js:2370`](../../desktop/main.js#L2370)

**Symlink safety: `writeFileAtomic` for summary save/overwrite (finding D)**

- Swapped off a plain `fs.writeFileSync`, which a planted symlink would otherwise follow.
  [`main.js:1000`](../../desktop/main.js#L1000)

**LOW-severity hardening**

- `transcripts:list`/`transcripts:search` skip symlinked `.txt` entries via `lstatSync` instead of a symlink-following `statSync`.
  [`main.js:2000`](../../desktop/main.js#L2000)

- `WHISPER_MODEL_RE` -- one shared allow-list now also gates `live:start` and `runRecordTranscribeJob`, not just the two handlers that already had it.
  [`main.js:3006`](../../desktop/main.js#L3006)

**Tests**

- `findRelatedAudioPaths`/`isPathInside`/`canWritePath`/`writeFileAtomic`/`WHISPER_MODEL_RE` fixtures and source-scans.
  [`test/path-guards.test.js:123`](../../desktop/test/path-guards.test.js#L123)

- `headerValue()` unit cases plus per-call-site sanitization checks for every header writer.
  [`test/header-values.test.js:57`](../../desktop/test/header-values.test.js#L57)
