---
title: 'Meeting cards show date + time in a user-chosen format'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'a2578d972fbacf77efa49430d81ae40ef78cdec2'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Meeting cards in the Transcripts tab sidebar show only `HH:MM`, so any card outside the
"Today" group gives no idea which day it belongs to, and the hard-coded 24-hour clock ignores users
who read time as 12-hour or write dates month-first.

**Approach:** Show date + time on every card, formatted from two new view preferences — date order
(EU day-first / US month-first) and clock (24-hour / 12-hour) — added to the Settings modal next to
Appearance and persisted in `localStorage`, exactly like the existing theme preference.

## Boundaries & Constraints

**Always:**
- Both preferences are renderer-only view state: `localStorage`, applied live on change (like
  `uds-theme`), never routed through IPC / `main.js` / the summarizer Save-Cancel flow.
- Format via `Intl.DateTimeFormat` with an explicit locale (`en-GB` = day-first, `en-US` =
  month-first) and explicit `hour12`, not hand-rolled string building.
- First run with no stored value resolves the default from the OS locale, so an unconfigured US
  machine gets US defaults.
- Card row 2 stays one line: `.meeting-card-row2` is `white-space: nowrap; overflow: hidden` in a
  260 px sidebar, so the added text must stay compact enough not to push the duration and avatar
  stack out of view.
- An invalid or missing `m.date` still renders an empty string, never `NaN`.

**Ask First:**
- Adding a third option (e.g. ISO `2026-08-25`, or a "Follow system" radio) beyond the four
  US/EU × 12/24 h combinations the user asked for.
- Changing the `Today / Yesterday / Last week / Older` section headers or the sidebar width.

**Never:**
- Touching `main.js`, `preload.js`, or any IPC handler.
- Reformatting timestamps outside the Transcripts sidebar meeting cards (Record tab, Live tab,
  note rows, transcript timecodes, summary front-matter all keep their current format).
- Adding a date library — `Intl` is already available in the renderer.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| EU + 24 h | `2026-08-24T18:14`, order `dmy`, clock `24h` | `24/08/26, 18:14` | N/A |
| US + 12 h | `2026-08-24T18:14`, order `mdy`, clock `12h` | `08/24/26, 6:14 PM` | N/A |
| US + 12 h midnight | `2026-08-24T00:05`, order `mdy`, clock `12h` | `08/24/26, 12:05 AM` — never `0:05 AM` | N/A |
| No stored preference | `localStorage` empty, OS locale `en-US` | Defaults resolve to `mdy` + `12h` | Fall back to `dmy` + `24h` if locale probing throws |
| Bad date | `m.date` undefined / `Invalid Date` | `""` — card renders without the time span content | Guarded, no throw |
| Preference changed | User clicks a radio in Settings | Cards repaint immediately; modal Cancel does not revert it | N/A |

</frozen-after-approval>

## Code Map

- `desktop/renderer/app.js:1716` — `formatMeetingTime(date)`, the hard-coded `HH:MM` formatter. Sole
  caller is `buildMeetingCard` at `:1449` (`<span class="meeting-time tnum">`). This is the only
  place to change for the card output.
- `desktop/renderer/app.js:4066-4090` — theme preference block: `applyTheme()` writes
  `localStorage["uds-theme"]` and the radios apply live via a `change` listener. Copy this shape for
  the two new preferences.
- `desktop/renderer/app.js:4158` — `openSettingsModal()`; line `4164` pre-checks the theme radios
  from `localStorage`. New radios get the same treatment here.
- `desktop/renderer/app.js:4231+` — `saveSettings()` must stay untouched: view preferences persist on
  change, not on Save.
- `desktop/renderer/app.js:1383` — `renderMeetings()`, the repaint entry point to call after a
  preference change.
- `desktop/renderer/index.html:1097-1113` — Settings modal `Appearance` block with the
  `settings-theme` radio group; the new groups go directly after it, reusing `.modal-label`,
  `.settings-provider-group`, `.settings-radio`, `.settings-radio-title`, `.settings-radio-sub`.
- `desktop/renderer/style.css:849-866` — `.meeting-card-row2` (nowrap, overflow hidden), `.tnum`.
  Read-only evidence for the one-line constraint; no CSS change expected.
- `desktop/renderer/theme-init.js` — precedent that only theme needs pre-paint resolution. Date
  format does not; do not add anything here.
- `desktop/test/renderer-globals.test.js` — the only existing renderer test. Renderer scripts are
  classic `<script>` tags with no `module.exports`, so this suite reads their **source** off disk
  rather than requiring them. The new formatter test must use the same read-and-eval approach; do
  not add `module.exports` to `app.js` (it would be dead weight in the browser context).

## Tasks & Acceptance

**Execution:**
- [x] `desktop/renderer/index.html` — add two radio groups after the Appearance group: `Date format`
  (`name="settings-date-order"`, values `dmy` / `mdy`) and `Time format`
  (`name="settings-time-format"`, values `24h` / `12h`), each option labelled with a live example
  (`31/12/26`, `12/31/26`, `18:14`, `6:14 PM`) — so the choice is readable without docs.
- [x] `desktop/renderer/app.js` — replace `formatMeetingTime` with a date+time formatter driven by
  the two stored preferences, with OS-locale-derived defaults; update the `buildMeetingCard` call
  site at `:1449`.
- [x] `desktop/renderer/app.js` — wire the new radios: pre-check them in `openSettingsModal()`,
  persist on `change`, and call `renderMeetings()` so cards repaint live.
- [x] `desktop/test/meeting-date-format.test.js` — new `node --test` file: read
  `renderer/app.js`, eval out the pure formatting helper (one that takes `(date, order, clock)`
  explicitly, so it needs no `localStorage`), and assert every I/O matrix row — both orders, both
  clocks, midnight in 12 h, invalid date.

**Acceptance Criteria:**
- Given a stored preference of EU + 24 h, when the Transcripts sidebar renders, then every card's
  row 2 reads `DD/MM/YY, HH:MM` before the duration and avatars, all still on one visible line.
- Given the Settings modal is open, when the user picks a different date or time radio and closes the
  modal with **Cancel**, then the meeting cards keep the newly picked format and it survives an app
  restart.
- Given `npm test` runs from `desktop/`, then the existing four suites plus the new formatter suite
  pass.

## Design Notes

The formatter splits in two: a pure `(date, order, clock)` helper that only touches `Intl`, and a
thin wrapper that reads the two preferences from `localStorage`. That split is what makes the helper
testable from Node without a DOM.

Two independent 2-value preferences (not one 4-value list) because date order and clock are
orthogonal; a single group of four radios reads worse and does not extend.

2-digit year (`24/08/26`) rather than `24/08/2026`: the sidebar is 260 px with `overflow: hidden`,
and the full year costs two more characters that push the avatar stack off cards carrying both a
duration and participants. The section headers already give the coarse "when".

Shape to follow, mirroring `applyTheme`:

```js
// 'dmy' → day-first (en-GB), 'mdy' → month-first (en-US); hour12 from the clock preference.
const fmt = new Intl.DateTimeFormat(order === "mdy" ? "en-US" : "en-GB", {
  day: "2-digit", month: "2-digit", year: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: clock === "12h",
});
```

## Verification

**Commands:**
- `cd desktop && npm test` — expected: all suites pass, including the new formatter suite.

**Manual checks (if no CLI):**
- `cd desktop && npm start`, open Settings, flip all four combinations: cards repaint immediately,
  stay on one line, Record and Live tabs unchanged.

## Suggested Review Order

**The formatting rule**

- Entry point: the pure formatter, the whole feature in one function.
  [`app.js:1752`](../../desktop/renderer/app.js#L1752)
- Why the clock carries its own locale instead of the date's.
  [`app.js:1731`](../../desktop/renderer/app.js#L1731)
- OS-locale defaults, so an unconfigured machine already reads right.
  [`app.js:1775`](../../desktop/renderer/app.js#L1775)

**Reading the preference**

- Storage access guarded — a throw here would cost the sidebar.
  [`app.js:1794`](../../desktop/renderer/app.js#L1794)
- The one call site: the meeting card's second row.
  [`app.js:1449`](../../desktop/renderer/app.js#L1449)

**Settings UI**

- Two radio groups, sitting with Appearance rather than the summarizer.
  [`index.html:1116`](../../desktop/renderer/index.html#L1116)
- Live apply on change and repaint — deliberately outside Save/Cancel.
  [`app.js:4187`](../../desktop/renderer/app.js#L4187)
- Pre-checking the radios when the modal opens.
  [`app.js:4278`](../../desktop/renderer/app.js#L4278)

**Tests**

- Region eval — the price of testing a classic-script renderer.
  [`meeting-date-format.test.js:1`](../../desktop/test/meeting-date-format.test.js#L1)
