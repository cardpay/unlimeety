---
title: 'Extension hardening for release 1.3.2'
type: 'bugfix'
created: '2026-09-06'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'f87282c024d1e74a489e313dd72bf7c7dde3fa4f'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Chrome extension (`extenstion/`) writes a Meet guest's freely-chosen display name and free-text subtitles straight into the saved transcript with no sanitization. A guest can set their display name to `Note`, `S1`, a Greek-letter placeholder, `Me`, `?`, or `…` and impersonate the desktop app's own reserved note/placeholder handling (`transcript-enhance.js`, `main.js`); embedded `\r`/`\n` or a leading `[` in subtitle text/speaker names can forge a fake `[hh:mm:ss] Speaker:` turn; `background.js` writes the DOM-sourced title/participants into the header with no control-char or length cap; and the panel's own click/change/keydown listeners don't check `event.isTrusted`, so a compromised Meet page script can drive record/save/note/autostart.

**Approach:** Sanitize at the two boundaries where untrusted Meet-page data enters the pipeline — `content.js` (per-subtitle: speaker-shape rename + text/name cleanup) and `background.js` (per-save: header value cleanup) — and reject non-trusted DOM events in the panel's action listeners. Bring two already-fixed desktop call sites (an unescaped `noteLabel` regex, two unescaped CSS attribute selectors) up to the same standard the rest of the codebase already uses, for consistency.

## Boundaries & Constraints

**Always:** Match existing sanitizer shapes already in this codebase rather than inventing new ones — `headerValue` (`desktop/main.js:2102`: strip `[\x00-\x1f\x7f-\x9f]`, collapse whitespace, trim), `isPlaceholderLabel`/`PHONETIC_LETTERS` (`desktop/transcript-enhance.js:138`, `desktop/main.js:2112`) for placeholder shape, `escapeRe` (`desktop/transcript-enhance.js:257`, already used by `spokenIn`) for regex-escaping, `CSS.escape` (already used correctly at `desktop/renderer/app.js:2217`), and `sanitizeFilenameBase`'s `120`-char cap (`desktop/main.js:2599`) for the new length cap. `cd desktop && npm test` stays green after every change.

**Ask First:** None — six independent, low-risk, additive sanitization edits; Auto Mode is active for this session, no checkpoint requires a human.

**Never:** Touch `escapeHtml` / `&#39;` in `desktop/renderer/app.js` (separate parallel task owns it). Touch `main.js` (its `headerValue` and softened Note instruction are reference-only). Touch anything else from `woolly-floating-scone.md` (PII rewrite, Electron bump, packaging/fuses, PR3/preload). Add a build step for the extension — it stays loaded-unpacked.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Guest names themselves `Note` | `processSubtitle('Note', 'hi')` | speaker becomes `Note (guest)` | N/A |
| Guest names themselves `s3` (placeholder shape, lowercase) | `processSubtitle('s3', 'hi')` | speaker becomes `s3 (guest)` | N/A |
| Guest names themselves `Beta 2` (Greek+cycle shape) | `processSubtitle('Beta 2', 'hi')` | speaker becomes `Beta 2 (guest)` | N/A |
| Real name, no collision | `processSubtitle('Иван Петров', 'hi')` | speaker unchanged | N/A |
| Subtitle carries an embedded CRLF + fake marker | `text = 'ok\r\n[00:00] Fake:\nx'` | escaped to `ok\n [00:00] Fake:\nx` (space before `[`, `\r\n`→`\n`) so no new turn is created on save | N/A |
| Background writes a 5000-char DOM title | `saveTranscriptForTab` with `meetingTitle` = 5000 chars | header title capped to 120 chars, control chars/newlines stripped | N/A |
| Page script clicks the save button | `save-btn.click()` dispatched with `isTrusted: false` | listener returns immediately, no `saveTranscript` message sent | N/A |
| Real user clicks the save button | native click (`isTrusted: true`) | behaves exactly as before | N/A |

</frozen-after-approval>

## Code Map

- `extenstion/content.js:52-54` -- `escapeNoteText` — extend to normalize `\r\n?`→`\n` before its existing `^[`→` [` escape; today only called at :313 for typed notes.
- `extenstion/content.js:997-1085` -- `processSubtitle` — add reserved/placeholder-shape rename and apply (extended) `escapeNoteText` to `speaker`/`text` right after `speaker = cleanSpeakerName(speaker)`, before `knownSpeakers.add`/merge logic/`sendMessage`.
- `extenstion/content.js:197,242,267,276,287,302` -- panel listeners (`gmt-autostart` change, `gmt-record-btn` click, `gmt-save-btn` click, `gmt-notes-input` keydown are the ones the audit named as exploitable — record/save/note/autostart abuse). Add `if (!e.isTrusted) return;` as the first line of each (the two `click` handlers currently take no `e` param — add it).
- `extenstion/background.js:138-198` -- `saveTranscriptForTab` — add a local `headerValue`-equivalent (control-char strip, collapse whitespace, trim, cap at 120 chars) mirroring `desktop/main.js:2102`; apply to `meetingTitle` and each `participants[]` entry before building `textContent`.
- `desktop/transcript-enhance.js:629-631` -- `isNoteBlock` — wrap `noteLabel` in the file's existing `escapeRe` (defined :257-259) before building the `RegExp`.
- `desktop/renderer/record/record.js:1296`, `desktop/renderer/live/live.js:613` -- wrap the interpolated `evt.model`/`event.model` in `CSS.escape(...)`, matching `desktop/renderer/app.js:2217`.
- `extenstion/manifest.json` -- bump `"version"` and `"version_name"` to `"1.3.2"`.
- `desktop/test/extension-autostart.test.js` -- existing `new Function(...)`-over-stubs harness for `content.js`; extend with new `test(...)` cases (same file, same pattern per project CLAUDE.md) covering the new rename/escape/isTrusted behavior. `processSubtitle`/`escapeNoteText` aren't exposed by the harness's `return { injectUI }` today — extend that return list.
- `desktop/test/extension-background-header.test.js` -- new sibling file, same `new Function(...)`-over-stubs pattern, this time over `background.js` (a service worker script, also not `require()`-able) -- covers the title/participants length-cap-and-clean matrix row that `content.js`'s own tests cannot reach.

## Tasks & Acceptance

**Execution:**
- [x] `extenstion/content.js` -- normalize CRLF in `escapeNoteText`; add reserved-label detection + rename in `processSubtitle`; apply `escapeNoteText` to `speaker`/`text`; add `isTrusted` guards to the four named listeners -- closes guest impersonation of Note/placeholder labels, forged marker lines via embedded newlines, and synthetic-click control of the panel.
- [x] `extenstion/background.js` -- add capped `headerValue`-equivalent, apply to title/participants -- closes unbounded/control-char DOM data reaching the transcript header.
- [x] `extenstion/manifest.json` -- `version`/`version_name` → `1.3.2`.
- [x] `desktop/transcript-enhance.js` -- `escapeRe(noteLabel)` in `isNoteBlock` -- closes latent regex-injection if `noteLabel` ever stops being the literal `'Note'`.
- [x] `desktop/renderer/record/record.js`, `desktop/renderer/live/live.js` -- `CSS.escape` the two `data-model` selectors -- closes selector breakage/injection from an unescaped model id.
- [x] `desktop/test/extension-autostart.test.js` -- new cases for guest-label rename, CRLF/bracket escaping, isTrusted guards -- pins the behavior above.
- [x] `desktop/test/extension-background-header.test.js` -- new file, same `new Function`-over-stubs technique against `background.js` -- added during the Matrix Test Audit: the I/O matrix's "Background writes a 5000-char DOM title" row had no covering test after the first implementation pass.

**Acceptance Criteria:**
- Given a subtitle from a speaker named `Note`, `S7`, `Gamma`, `Me`, `?`, or `…`, when `processSubtitle` runs, then the speaker sent onward is that label plus ` (guest)`.
- Given subtitle text containing `\r\n` followed by `[`, when `processSubtitle` runs, then the saved line cannot read as a new `[timestamp] Speaker:` turn.
- Given a synthetic (non-trusted) event on the record/save/note-input/autostart controls, when its listener fires, then no `chrome.runtime.sendMessage`/`storageSet` side effect occurs.
- Given a 5000-char or control-char-laden title/participant name from the DOM, when `saveTranscriptForTab` builds the header, then the written value is ≤120 chars with no control characters.
- Given `cd desktop && npm test`, then it exits 0 with no regressions.

## Spec Change Log

## Design Notes

`isReservedSpeakerLabel` in `content.js` is a literal, standalone re-implementation of `transcript-enhance.js`'s `isPlaceholderLabel` + `main.js`'s `PHONETIC_LETTERS` (a content script can't `require()` either) plus the `'Note'` check background.js already reserves — comment the mirroring explicitly so the three copies don't silently diverge. The `(guest)` suffix is chosen over dropping/replacing the label so the transcript stays readable and the collision is visibly broken rather than silently laundered.

**Patches applied during the review loop** (all `patch`-triaged, no spec/intent change): `background.js`'s `headerValue` cap now spreads into an array before slicing (a plain `.slice(0,120)` could split a UTF-16 surrogate pair and later crash `encodeURIComponent`); its `participants` mapping now filters to `typeof === 'string'` first (a non-array/nullish entry could throw or stringify to a literal `"null"`); `processSubtitle` now also flattens a bare embedded newline in `speaker` to a space (only the CRLF/leading-`[` case was originally handled, but the marker line itself must stay single-line regardless of cause); the `gmt-theme-toggle` and `gmt-language` listeners gained the same `isTrusted` guard as the four originally-named ones (both have a real side effect — `storageSet`/live caption-menu manipulation — even though neither was named in the original audit prose); plus three test-only additions (a `CSS.escape` source-text pin, a `PHONETIC_LETTERS` main.js/content.js sync pin, and a metacharacter-bearing `noteLabel` case for `isNoteBlock`) closing coverage gaps the review found without any corresponding code change.

**Review-round disposition summary** (3 parallel layers — blind-hunter, edge-case-hunter, verification-gap — reviewed the full diff): 9 findings triaged `patch` (applied, listed above), 3 triaged `defer` (appended to `_bmad-output/implementation-artifacts/deferred-work.md`: `getParticipants()` not renaming guest-impersonated labels the way `processSubtitle` does; Unicode bidi/zero-width chars surviving every `headerValue`-family sanitizer; transcript-body fields having no length cap unlike the header), 2 triaged `reject` (the extension's `headerValue` cap intentionally diverging from `main.js`'s uncapped one — already documented above as a deliberate choice; the manifest version bump lacking a `-beta` suffix — an explicit instruction for this release, not a defect). No `intent_gap`/`bad_spec` findings — no loopback needed.

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: exits 0, all existing + new cases pass.
- `node -c extenstion/content.js && node -c extenstion/background.js` -- expected: no syntax errors (extension has no build step).

**Manual checks (if no CLI):**
- Load the unpacked extension (`chrome://extensions` → Load unpacked → `extenstion/`), join a test Meet call, rename the guest's display name to `Note` before it speaks, confirm the saved `.txt` shows `[hh:mm:ss] Note (guest):` rather than `Note:`.

## Suggested Review Order

**Guest speaker-label impersonation**

- Entry point: shape-detection for every reserved/placeholder label a guest could claim.
  [`content.js:1020`](../../extenstion/content.js#L1020)

- Where the rename actually applies, before the label reaches `knownSpeakers` or any `sendMessage`.
  [`content.js:1040`](../../extenstion/content.js#L1040)

- CRLF-normalize + leading-`[` escape, now also flattening a bare embedded newline in `speaker`.
  [`content.js:1051`](../../extenstion/content.js#L1051)

- The escape function itself: CRLF→LF normalize was the only change; bracket-escape pre-existed.
  [`content.js:52`](../../extenstion/content.js#L52)

**Header sanitization at the extension's save boundary**

- Capped, surrogate-safe `headerValue`, mirroring `desktop/main.js:2102` plus a length cap it lacks.
  [`background.js:147`](../../extenstion/background.js#L147)

- Applied to title (with an `"Untitled Meeting"` fallback) and to each participant, type-filtered first.
  [`background.js:165`](../../extenstion/background.js#L165)

**Synthetic-event guards on the panel**

- The four listeners the audit named as exploitable (record/save/note/autostart), plus theme/language for the same reason.
  [`content.js:198`](../../extenstion/content.js#L198)

**Consistency fixes elsewhere in the codebase**

- `isNoteBlock` now escapes a caller-supplied `noteLabel` before building its `RegExp`.
  [`transcript-enhance.js:629`](../../desktop/transcript-enhance.js#L629)

- `CSS.escape` on the interpolated model id, matching the existing correct pattern in `app.js:2217`.
  [`record.js:1296`](../../desktop/renderer/record/record.js#L1296)

- Same fix, Live tab's mirrored badge lookup.
  [`live.js:613`](../../desktop/renderer/live/live.js#L613)

- Real release version bump, no `-beta` suffix (this branch is not a beta).
  [`manifest.json:4`](../../extenstion/manifest.json#L4)

**Tests**

- Guest-label rename, CRLF/bracket forgery, and isTrusted-guard cases for all six panel listeners.
  [`extension-autostart.test.js:113`](../../desktop/test/extension-autostart.test.js#L113)

- Header capping/cleaning exercised end-to-end through the real message flow into a decoded `data:` URL.
  [`extension-background-header.test.js:1`](../../desktop/test/extension-background-header.test.js#L1)

- `escapeRe(noteLabel)` proven against an actual metacharacter, not just the inert `'Note'` literal.
  [`transcript-enhance.test.js:69`](../../desktop/test/transcript-enhance.test.js#L69)

- `CSS.escape` source-text pins plus a `PHONETIC_LETTERS` main.js/content.js drift guard.
  [`extension-hardening-misc.test.js:1`](../../desktop/test/extension-hardening-misc.test.js#L1)
