---
title: 'Chrome extension: setting for automatic caption recording start'
type: 'feature'
created: '2026-08-25'
status: 'done'
baseline_commit: 'a2578d972fbacf77efa49430d81ae40ef78cdec2'
review_loop_iteration: 2
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The extension starts recording unconditionally — the 2 s meeting-status poll in `content.js` calls `startRecording()` as soon as a meeting looks active, which also force-enables Meet captions. A user who joined a call they don't want transcribed can only stop it after the fact.

**Approach:** Add a persisted "Auto-start recording" checkbox to the in-meeting widget. On (default, today's behaviour) — the poll auto-starts as now. Off — recording only ever starts from the record button. Stored in `chrome.storage.local`, same as `gmt-theme`.

## Boundaries & Constraints

**Always:**
- Missing stored value → ON, so existing users see no change after update. "Failed read" here means one that throws or reports an error — a callback that never arrives cannot be distinguished from a slow one, so it degrades to manual recording instead (see the matrix).
- The stored value is applied before any auto-start can fire — no race window where the default wins, and a user who ticks the box before the read lands is not overwritten by it.
- **Ticking the box on during a meeting that is already active must not start recording that meeting.** The preference is saved and takes effect from the next meeting; the user has the record button for right now. A checkbox that silently begins recording a live call is the exact surprise this feature exists to prevent.
- "Next meeting" must hold within one page life too. Meet navigates between calls without a document load, so a skip recorded for one meeting must not survive into the next one.
- The meeting-status poll must be armed before any `chrome.*` call and must never be conditional on one. It is the only thing that clears the record button's `disabled` flag, so a storage read that throws or never calls back must still leave a usable widget — and "usable" means the record button's click handler is registered, not merely that the button looks enabled.
- With auto-start off the poll keeps running, so the record button's `disabled` state and tooltip still track meeting activity.
- Record/save/note behave identically in both states.
- `content.css` keys the status dot and label on `:has(#gmt-record-btn:disabled)` and `:has(#gmt-icon-stop[style*="block"])` — new markup must not disturb those.

**Ask First:** touching the auto-*save* paths in `background.js`; adding an options page, popup, permission, or manifest version bump; adding a test *framework* or dependency (hand-rolled stubs in the existing `node --test` style are not a framework).

**Never:** a second setting (auto-save, auto-stop, language memory); `chrome.storage.sync`; changes to transcript format, download path, or `unlimeety://open`; touching `2025_Unlimit_Sign_black.jpg` or carrying the "Unlimeety"/"Unlimit" marks into new files.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| Fresh install, meeting joined | no `gmt-autostart` key | Box checked; auto-starts as today | N/A |
| Off, meeting joined | `gmt-autostart: false` | Box unchecked; nothing starts; button enables, status "Ready" | N/A |
| Off, user clicks record | meeting active | Records normally, captions on | Captions fail → existing `startRecording` abort path |
| Flipped off mid-recording | `isRecording: true` | Persisted for next meeting; running recording NOT stopped | N/A |
| **Flipped on, meeting already active** | not recording, poll alive | **Preference saved; this meeting is NOT recorded. Takes effect next meeting** | N/A |
| Flipped on before meeting active | poll running, meeting not live yet | Auto-starts when the meeting goes live | N/A |
| Ticked mid-meeting, then a new call in the same tab | Meet navigates without a document load | The new call DOES auto-start; the skip applied only to the call that was live at click time | N/A |
| Box ticked while the read is still in flight | read resolves after the click | The user's click wins; the callback does not overwrite it | N/A |
| Storage read throws | orphaned content script | Poll still armed, button still works, auto-start falls back to on | Caught; no listener below it is lost |
| Storage read never calls back | callback dropped | Poll still armed and button usable; auto-start does not fire | Degrades to manual recording |
| Widget reloaded | `gmt-autostart: false` | Box restores unchecked | Read fails → fall back to ON |

</frozen-after-approval>

## Code Map

- `extenstion/content.js:3-9` -- state flags. `autoStartEnabled` (the preference), `autoStartLoaded` (stored value landed or known unreachable), `autoStartSkipPath` (the `location.pathname` of the meeting the user opted out of). A boolean "armed" flag is wrong: Meet changes URL between calls without a document load, so a boolean never re-arms and kills auto-start for the tab's life. Keying on the path re-arms by construction.
- `extenstion/content.js:34-79` -- `injectUI()` template. `.gmt-controls` column: Language select → `.gmt-main-controls` (record+save) → Note input → `.gmt-status`. Checkbox row goes between `.gmt-main-controls` and Note.
- `extenstion/content.js:88-104` -- the poll. **Arm it first, unconditionally.** `btn.disabled = !active` here is the *only* assignment that ever clears the `disabled` set at line ~97; `updateRecordButtonUI` never touches `disabled`. Anything that can stop this interval from being created makes the widget unusable, not merely non-auto-starting.
- `extenstion/content.js:106-131` -- `applyWidgetTheme` + `chrome.storage.local` get/set for `gmt-theme`. `THEME_CYCLE` is a `const` here, so it is in TDZ above this line — don't merge the two storage reads by hoisting. **This read must go through the same guard as the autostart one.** Guarding only the new read moves which line throws, not the outcome: an orphaned content script still loses every listener below, leaving an enabled record button that ignores clicks. Four call sites total (two gets, two sets) — one small helper pair covers them and is a smaller diff than four try/catch blocks.
- `extenstion/content.js:170-199` -- listeners for language/record/save; add the checkbox listener alongside. Every listener registered after a throwing `chrome.*` call is lost, which is why the poll must precede them.
- `extenstion/content.js:394-431` -- `startRecording`/`stopRecording`. **Read-only** — the toggle gates the caller.
- `extenstion/content.css:201-215` -- `.gmt-controls` (flex column, `gap:10px`) and `.gmt-field-label`. New rules go near `#gmt-notes-input`, reusing `--u-*` tokens.
- `extenstion/content.css:14-63` -- the widget root's token block. `color-scheme` is an **inherited** property, so it belongs here on the root, not on the checkbox: one declaration themes the checkbox and fixes `#gmt-language`'s option popup and `#gmt-notes-input`'s caret at the same time. No `--u-scheme` indirection.
- `extenstion/content-light.css:17-45,60-84` -- the two light blocks (`[data-theme="light"]` and the `@media prefers-color-scheme` one scoped to `:not([data-theme="dark"])`). Both need the light `color-scheme`, or theme "auto" on a light OS is missed — the existing `#gmt-language` caret override only covers the first, so don't copy that pattern.
- `extenstion/background.js`, `extenstion/manifest.json` -- **read-only.** `storage` permission already granted; the setting is content-script only.
- `desktop/test/renderer-globals.test.js` -- the house pattern for a framework-free test: bare `node --test` script, plain `assert`. Reuse the shape, but **execute** rather than pattern-match the source.

## Tasks & Acceptance

**Execution:**
- [x] `extenstion/content.js` -- add `storageGet(key, cb)` / `storageSet(obj)` helpers: try/catch around the `chrome.storage.local` call, `chrome.runtime.lastError` read inside the callback, `cb(null)` on failure so the caller applies its own default -- one guard for all four call sites; a guard on only the new read changes which line throws, not the outcome.
- [x] `extenstion/content.js` -- route the `gmt-autostart` and `gmt-theme` gets and sets through them -- the widget must stay usable, i.e. with its click handlers registered, in an orphaned content script.
- [x] `extenstion/content.js` -- add the flags: `autoStartEnabled`, `autoStartLoaded`, `autoStartSkipPath` -- a path, not a boolean, so a new call in the same tab re-arms by construction.
- [x] `extenstion/content.js` -- add a labelled `#gmt-autostart` checkbox (default `checked`, with a `title` naming the next-meeting semantics) between `.gmt-main-controls` and the Note block.
- [x] `extenstion/content.js` -- clear any existing `window.meetingStatusInterval` before arming a new one -- `injectUI` already guards its resize handler against re-injection, so re-entry happens and would otherwise orphan a timer that keeps flipping `disabled`.
- [x] `extenstion/content.js` -- **arm the poll first, outside any callback**, gated on `active && autoStartLoaded && autoStartEnabled && location.pathname !== autoStartSkipPath`.
- [x] `extenstion/content.js` -- `change` listener (null-guarded): set `autoStartEnabled` and `autoStartLoaded`, record `autoStartSkipPath` when turning on during a live meeting, persist via `storageSet` -- decide "live" from the poll's own debounced `!btn.disabled` as well as `isMeetingActive()`, so a transient DOM blip cannot skip the disarm.
- [x] `extenstion/content.css` -- `color-scheme` on the widget root; `.gmt-check` styling plus a `:focus-visible` lime border matching `#gmt-language` and `#gmt-notes-input`.
- [x] `extenstion/content-light.css` -- light `color-scheme` in **both** light blocks.
- [x] `desktop/test/extension-autostart.test.js` -- executing test, wrapped in `node:test` `test()` calls so one failure does not mask the rest. The harness must serve `getElementById` only for ids present in the assigned `innerHTML`, and every case that should complete must assert `injectUI` did not throw.

**Acceptance Criteria:**
- Given no stored `gmt-autostart`, when the widget injects, then the box is checked and no first-run prompt appears.
- Given auto-start off, when the tab reloads, then the box is unchecked and the setting still applies.
- Given auto-start off and the button disabled, when the meeting becomes active, then the button enables and the label switches to "Ready" without recording starting.
- Given auto-start off, when the user clicks record, then lines are captured and saving works as with auto-start on.
- Given the widget collapsed, when expanded, then the box reflects the persisted state and the status dot/label rules behave as before.

## Spec Change Log

- **Trigger (iteration 1):** three independent reviewers converged. Two findings were fatal. (a) Putting the `setInterval` inside the `chrome.storage.local.get` callback made the poll — the record button's only enable path — depend on a `chrome.*` call; a synchronous throw ("Extension context invalidated", routine on a long-lived Meet tab after an extension reload) kills `injectUI` and every listener below it, leaving a rendered but completely dead widget. (b) The frozen matrix had no row for ticking the box on during an already-active meeting; the code silently started recording within 2 s while the comment beside it claimed the opposite.
  **Amended:** the human resolved (b) — the preference takes effect from the *next* meeting, which added a frozen matrix row, a frozen Always constraint, and the `autoStartArmed` flag. For (a) the Code Map and Tasks now require the poll armed first and unconditionally, with the storage read in a `try/catch`. Also added: rows for a read that throws, a read that never returns, and a click racing the read; `color-scheme` moved to the widget root (it is inherited, so the `--u-scheme` token bought nothing and left `#gmt-language`'s popup and `#gmt-notes-input`'s caret unthemed).
  **Known-bad state avoided:** a widget that renders and cannot record at all; and a checkbox that starts recording a live call.
  **KEEP:** the on-by-default read expressed so that absent, `undefined` and a failed read all resolve to on — only an explicit stored `false` turns auto-start off. Keep the poll alive rather than cleared when auto-start is off; it is what unlocks the record button. Keep the toggle free of any effect on a recording in flight. Keep the light `color-scheme` in **both** light blocks — the existing `#gmt-language` caret override covers only `[data-theme="light"]` and misses theme "auto" on a light OS; do not copy that. Keep the test framework-free (`node --test` + `assert`, no jsdom), but make it execute rather than pattern-match: the previous source-text version was demonstrated to pass while the widget was inert, while the poll had been hoisted back out, and while the checkbox-restore line was deleted.

- **Trigger (iteration 2):** round two, again three reviewers, again converging — and this time two of them mutated the code to prove it. (a) The narrow `try/catch` around the new read "changes which line throws, not the outcome": the unguarded `gmt-theme` read twenty lines below still strips every listener in an orphaned content script, so the widget shows an *enabled* record button that ignores clicks — worse than a disabled one. The test asserted the opposite in so many words. (b) `autoStartArmed` as a page-lifetime boolean never re-arms, and Meet changes calls without a document load, so "takes effect from the next meeting" was unimplemented for same-tab transitions. (c) Three test cases were demonstrated worthless: the click-beats-a-slow-read case seeded the stored value *equal* to the clicked value, so it passed with both mechanism lines deleted; the harness's `getElementById` fabricated any id, so deleting the whole checkbox markup block or renaming its id passed; and deleting `clearInterval` from the auto-start branch passed, so a poll re-entering `startRecording` every 2 s would have shipped.
  **Amended:** frozen — narrowed what "failed read" means (a dropped callback is not distinguishable from a slow one and degrades to manual recording), spelled out that "usable widget" means click handlers registered, added the same-tab next-meeting rule and its matrix row. Non-frozen — `autoStartArmed` replaced by `autoStartSkipPath` keyed on `location.pathname`; `storageGet`/`storageSet` helpers covering all four storage call sites; `clearInterval` before arming, for `injectUI` re-entry; disarm decided from the poll's debounced `!btn.disabled` as well as a fresh `isMeetingActive()`; the checkbox listener null-guarded; `:focus-visible`; the `lastError` `console.debug` dropped as dead (a failed `get` calls back with `{}`, which the absent-key path already covers).
  **Known-bad state avoided:** a widget whose record button looks ready and does nothing; auto-start silently dead for a tab's lifetime after one mid-meeting tick; and a test suite green through four separate real regressions.
  **KEEP:** everything in the iteration-1 KEEP list still holds. Additionally: the poll armed before any `chrome.*` call, and never conditional on one. The click-outranks-the-read rule (`if (!autoStartLoaded)` in the callback plus `autoStartLoaded = true` in the change handler) — and its test must use a stored value that DISAGREES with the click, or it proves nothing. The harness must resolve `getElementById` only against ids in the injected markup; fabricating nodes hid a dead-widget regression. Assert `injectUI` did not throw in every case meant to complete.

## Design Notes

State, one job each:

```js
let autoStartEnabled  = true;   // the persisted preference
let autoStartLoaded   = false;  // stored value landed, or known unreachable
let autoStartSkipPath = null;   // location.pathname of the meeting opted out of
```

`autoStartSkipPath` rather than a boolean: Meet moves between calls by changing
the URL without a document load, so a boolean latch never re-arms and kills
auto-start for the tab's whole life. Comparing `location.pathname` at tick time
re-arms by construction and needs no reset path.

`autoStartLoaded` does double duty — the read callback applies its value only
while it is still `false`, and the change handler sets it — so a click before the
read lands wins and cannot be silently reverted.

The disarm reads `!btn.disabled` (what the poll last observed, debounced over
2 s) as well as a fresh `isMeetingActive()`: a single point-in-time DOM probe can
miss while Meet's controls are momentarily unmounted, and missing it means
recording a call the user just opted out of.

`storageGet`/`storageSet` exist because guarding only the new read would move
which line throws without changing the outcome — an orphaned content script would
still lose every listener below the unguarded `gmt-theme` read, leaving a record
button that looks enabled and ignores clicks.

## Verification

**Commands:**
- `node --check extenstion/content.js` -- expected: no output.
- `cd desktop && npm test` -- expected: pass, including `test/extension-autostart.test.js`.

**Manual checks:**
- Load unpacked from `extenstion/`, join a Meet call. Default: box checked, auto-starts, captions on.
- Uncheck, rejoin: no auto-start; button enables; status "Ready". Click record — captions on, lines accumulate.
- Uncheck, then mid-call tick it back on: nothing starts. Leave and rejoin: now it auto-starts.
- Reload the tab: box restores unchecked. Re-check, rejoin: auto-start fires again.
- Cycle the theme button (auto/light/dark) and collapse/expand: the row and the status dot render correctly in each. On the light theme check the Language dropdown popup and the Note field caret too — they are now themed by the same declaration.

## Suggested Review Order

**The auto-start decision**

- Start here: the whole feature is one boolean expression, and every flag exists to make it correct.
  [`content.js:150`](../../extenstion/content.js#L150)

- A path, not a boolean: Meet changes calls without a document load, so a latch would never re-arm.
  [`content.js:11`](../../extenstion/content.js#L11)

- Armed before any `chrome.*` call — the only line that ever unlocks the record button.
  [`content.js:143`](../../extenstion/content.js#L143)

- `!== false` so absent, undefined and errored reads all keep today's behaviour; the guard lets a click win.
  [`content.js:169`](../../extenstion/content.js#L169)

- Records which meeting was opted out of, reading "live" from the poll's debounced state as well as a fresh probe.
  [`content.js:267`](../../extenstion/content.js#L267)

**Surviving an orphaned content script**

- One guard pair for all four storage call sites; guarding just one would move the throw, not fix it.
  [`content.js:22`](../../extenstion/content.js#L22)

- The pre-existing theme read routed through it — otherwise the widget keeps a dead record button.
  [`content.js:196`](../../extenstion/content.js#L196)

- Fire-and-forget `startRecording` would latch `isRecording` true on a throw and wedge the poll.
  [`content.js:151`](../../extenstion/content.js#L151)

**Presentation**

- Native checkbox; the `title` is where the next-meeting semantics are visible to the user.
  [`content.js:108`](../../extenstion/content.js#L108)

- `color-scheme` on the root because it inherits — also themes the select popup and note caret.
  [`content.css:50`](../../extenstion/content.css#L50)

- Light in both blocks: `[data-theme]` alone misses theme "auto" on a light OS.
  [`content-light.css:42`](../../extenstion/content-light.css#L42)

**Verification**

- The harness resolves ids only against injected markup, so markup drift fails instead of passing.
  [`extension-autostart.test.js:71`](../../desktop/test/extension-autostart.test.js#L71)

- The click-versus-read case uses values that disagree; equal values proved nothing.
  [`extension-autostart.test.js:236`](../../desktop/test/extension-autostart.test.js#L236)
