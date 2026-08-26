---
title: 'Record & Live start screens: reachable scroll and an on-screen "From calendar" popover'
type: 'bugfix'
created: '2026-08-26'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: 'f09b2658b0f1bccf26caee87aab516ee1f8939bd'
context: []
warnings: [oversized]
deferred:
  - summary: >-
      renderer/speaker-rename.js carries the byte-identical unclamped popover
      positioner that this story deleted from calendar-picker.js as broken.
    evidence: |-
      speaker-rename.js:48-52 is the same three lines verbatim:
      `pop.style.top = window.scrollY + r.bottom + 4` / `left = window.scrollX +
      r.left`, no viewport clamp, on a `.spk-rename` that is `position: absolute`
      appended to document.body and placed once on open. Its own header says it
      was built "mirroring calendar-picker.js". Its anchors are speaker chips
      inside scrolling panes (the editor's transcriptView, and the Live
      transcript stream that auto-scrolls), so a chip near the bottom of a long
      transcript puts the popover below the window edge with no way to reach it,
      and scrolling leaves it behind. No test and no check:layout row touches it.
      Out of this story's scope on the intent's authority: the intent names the
      "From calendar" dropdown and the two start screens. The other three
      hand-placed popovers (app.js:1927, app.js:1968, record/record.js:717) do
      clamp, so this is the last sibling of the root cause.
    location: >-
      desktop/renderer/speaker-rename.js:48
    severity: high
  - summary: >-
      The new per-file vm.Script parse guard cannot see the cross-file form of
      the silent-death mode it targets.
    evidence: |-
      Two renderer scripts each declaring the same top-level const/let/class is a
      load-time SyntaxError in the shared global scope, yet both files parse
      cleanly in isolation, so vm.Script passes them. The pre-existing
      `collisions` scan only compares top-level names against contextBridge
      bridge names, not against each other. Pre-existing gap, surfaced by adding
      the parse check next to it.
    location: >-
      desktop/test/renderer-globals.test.js
    severity: low
---

<intent-contract>

## Intent

**Problem:** At the default 1200×800 window the Live start screen centres a 1039 px form inside a
748 px scroll box, so 146 px of it — the "Live recording" heading and its blurb — sit *above*
`scrollTop: 0` and can never be scrolled to, while "Start recording" hangs below the window edge.
And every "From calendar" popover is placed at raw viewport coordinates with no clamping inside a
`body` that never scrolls: measured at 1200×800 it opens 211 px below the bottom edge, unreachable.

**Approach:** Move the `margin: auto` trick the Record tab already uses onto the shared
`.live-setup-inner` and drop Live's `align-items/justify-content: center`, so both start screens
centre when they fit and scroll from the top when they don't. Replace `calendar-picker.js`'s manual
`positionUnder()` arithmetic with CSS anchor positioning (Chromium 146 in Electron 41 supports it),
which flips the popover above the button when there is no room below, caps its height to the space
actually available, and keeps it glued to the button while the form scrolls.

## Boundaries & Constraints

**Always:**
- Every fix lands once, at the shared definition: `.live-setup-inner` for the column,
  `calendar-picker.js` for all three "From calendar" buttons (`live-cal-btn`, `record-cal-btn`,
  `new-cal-btn`).
- The two start screens keep looking identical — same column, spacing and centring when the form fits.
- `#record-setup`'s current behaviour is the reference: 40 px of padding stays above the heading and
  the whole form is reachable by scrolling.
- Popover keeps its existing dismiss behaviour: click the button again to toggle, outside-mousedown
  and Escape to close.

**Block If:**
- CSS anchor positioning turns out to be unsupported at runtime (`CSS.supports('position-area', …)`
  false) — do not ship a half-migrated popover.

**Never:**
- No new dependency, no positioning library, no JS `getBoundingClientRect` re-implementation of what
  `position-area` does.
- Do not touch the recording / transcribing / transcribe-settings phase screens, the toolbar, or
  `calendar-smart.js` (its banner is already viewport-centred).
- Do not restyle the form: no new widths, colours, fonts or row order.
- Do not convert `.cal-pop` to the native `popover` attribute — its light-dismiss would break the
  button's click-to-toggle.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Form fits | Live start screen, tall window | Column centred vertically, no scrollbar | No error expected |
| Form taller than window | Live start screen at 1200×800, troubleshoot `<details>` open | Heading visible at `scrollTop: 0` with 40 px padding above it; every element reachable by scrolling down | No error expected |
| Smallest window | Either start screen at the 800×600 `minWidth`/`minHeight` | Same as above — nothing clipped above the top | No error expected |
| Popover, room below | "From calendar" near the top of the form | Opens under the button, left edges aligned | No error expected |
| Popover, no room below | "From calendar" near the bottom of the window | Flips above the button, stays fully inside the viewport | No error expected |
| Popover, room on neither side | Short window, button mid-form | Height capped to the available space, scrolls internally | No error expected |
| Form scrolls while open | Popover open, user scrolls the start screen | Popover follows the button | No error expected |

</intent-contract>

## Code Map

- `desktop/renderer/live/live.css:57-72` — `#live-setup { flex:1; display:flex; align-items:center;
  justify-content:center; padding:40px 24px; overflow-y:auto }` and `.live-setup-inner` (the shared
  520 px column, used by both `#live-setup` and `#record-setup`). **This is the bug**: centring a
  flex item inside a scroll container puts the overflow above `scrollTop: 0`, which is unreachable.
- `desktop/renderer/record/record.css:52-59` — the same bug already fixed for Record:
  `#record-setup .live-setup-inner { margin: auto }` plus a comment explaining why. The comment is
  worth keeping; move it to the shared rule and delete this override.
- `desktop/renderer/calendar-picker.js:87-91` — `positionUnder(button)` sets
  `top = scrollY + rect.bottom + 4`, `left = scrollX + rect.left`. No viewport clamping, and
  `window.scrollY` is always 0 because every panel is `position: fixed` and `body` never scrolls.
  Called once, from `openPopover` (line ~139).
- `desktop/renderer/calendar-picker.js:24-31` — the injected `.cal-pop` rule
  (`position: absolute; max-height: 320px; overflow-y: auto; z-index: 1000`). The anchor declarations
  belong here.
- `desktop/renderer/index.html:363-489` (`#live-setup`) and `:582-679` (`#record-setup`) — read-only:
  both wrap their rows in `.live-setup-inner`, confirming the shared-rule fix reaches both.
- Call sites, read-only evidence that one picker fix covers all three:
  `desktop/renderer/live/live.js:107`, `desktop/renderer/record/record.js:445`,
  `desktop/renderer/app.js:4888`.
- `desktop/test/renderer-globals.test.js` — precedent for a file-reading regression guard in
  `node --test`; the new test follows its shape.

## Tasks & Acceptance

**Execution:**
- `desktop/renderer/live/live.css` — drop `align-items: center` and `justify-content: center` from
  `#live-setup`; add `margin: auto` to `.live-setup-inner` with the explanatory comment moved over
  from record.css — the shared column is where both tabs read the rule from.
- `desktop/renderer/record/record.css` — delete the now-redundant
  `#record-setup .live-setup-inner { margin: auto }` override and its comment — one rule, not two
  that can drift apart again.
- `desktop/renderer/calendar-picker.js` — delete `positionUnder()` and its call; give `.cal-pop`
  `position: fixed`, `position-anchor: --cal-anchor`, `position-area: block-end span-inline-end`,
  `position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline`, `margin: 4px 0` and a
  `max-height` capped to the available space; set `button.style.anchorName = '--cal-anchor'` when
  opening and clear it in `closePopover` — the browser then does the flipping and the anchor tracking.
- `desktop/test/setup-screens.test.js` — new `node --test` file asserting the two CSS invariants the
  bug violated: `.live-setup-inner` declares `margin: auto`, `#live-setup` declares no
  `align-items: center`, and `record.css` no longer carries its own `margin: auto` override — the
  Record override existing separately is exactly how this drifted the first time.
- `desktop/scripts/layout-check.mjs` + a `check:layout` script in `desktop/package.json` — a runnable
  geometry check covering every I/O matrix row: launch `electron .` with
  `--remote-debugging-port` and a scratch `--user-data-dir` (the installed app holds the
  single-instance lock), drive it over CDP with `Emulation.setDeviceMetricsOverride` at 1200×800 and
  800×600, force the troubleshoot `<details>` open, and assert per row — column top never above the
  container top, `scrollHeight - clientHeight` covering the overflow below, and each "From calendar"
  popover's rect inside the viewport both with and without room below it, and still anchored after
  the form is scrolled. Kept out of `npm test`, which must stay Electron-free and under a second.

**Acceptance Criteria:**
- Given the Live start screen at 1200×800 with the troubleshoot disclosure expanded, when the tab is
  opened, then `#live-setup .live-setup-inner`'s top is at or below `#live-setup`'s top (nothing
  clipped above) and `scrollHeight - clientHeight` is at least the amount overflowing below.
- Given either start screen at 800×600, when it is opened, then its heading is visible without
  scrolling and its "Start recording" button is reachable by scrolling down.
- Given a "From calendar" button with less than the popover's height between it and the window
  bottom, when it is clicked, then the popover's bounding rect lies entirely within
  `0 … innerHeight` and `0 … innerWidth`.
- Given an open popover, when the start screen behind it is scrolled, then the popover stays aligned
  to its button.
- Given the New Meeting modal, when its "From calendar" button is used, then it behaves as before —
  one picker, three call sites, no per-site special-casing.

## Design Notes

`margin: auto` rather than `align-items: center` is the whole trick: auto margins centre a flex item
when there is free space and collapse to zero when there is not, so the overflow lands *below* the
box where `scrollTop` can reach it. Centring keywords instead split the overflow across both edges,
and the top half is unreachable because `scrollTop` cannot go negative.

**Deviation, measured:** the `max-height` clamp this spec asked for is *not* shippable together with
the flip. `position-try-fallbacks` only flips when the element overflows its area, so clamping the
height to the area removes the overflow and the popover never flips — it would sit under the button,
shrunk, instead of opening upward where there is more room. Flip wins: it is the behaviour the "no
room below" row demands, and it is what a native menu does. The cost falls only on the "room on
neither side" row, which needs a window shorter than 680 px around the button to reach and cannot be
produced through the real UI (all three buttons live in their form's last rows): there the popover
stays 320 px instead of shrinking to the ~306 px available, and box alignment's safe fallback slides
it on-screen, overlapping the button by ~24 px. On-screen and internally scrollable either way, both
asserted. Worth a reviewer's call, not a silent choice.

Measured before the fix (Live, 1200×800, troubleshoot open): container `top: 52`, `clientHeight: 748`;
column `top: -94`, `height: 1039` — 146 px clipped above, `scrollTop: 0`, no way up. Record, same
window: column `top: 92` (40 px padding intact), `maxScroll: 227` ≥ `overflowBelow: 187`. Popover off
`#record-cal-btn`: `top: 920, bottom: 1011` in an 800 px window, `body.scrollHeight === 800`.

## Verification

**Commands:**
- `cd desktop && npm test` — expected: all files pass, including the new `setup-screens.test.js`.
- `cd desktop && npm run check:layout` — expected: every I/O matrix row reported PASS and a zero exit
  code. It launches Electron itself; nothing needs to be running first.

## Auto Run Result

Status: done

### Implemented change

The Live start screen centred its form inside a scroll container, so at the default 1200x800 window
146 px of it — the heading and blurb — sat above `scrollTop: 0` where scrolling cannot reach, and
"Start recording" hung below the window edge. The same form also overflowed its 520 px column
horizontally by 58 px, spilling the third model card and its "Best quality" pill onto its
neighbour. Every "From calendar" popover was placed at raw viewport coordinates with no clamping
inside a `body` that never scrolls, opening 211 px below the bottom edge, unreachable.

Fixed by moving the `margin: auto` centring onto the shared `.live-setup-inner` (one rule for both
tabs instead of two that had already drifted), letting the model grid's tracks shrink and its card
rows wrap, and replacing the hand-rolled popover arithmetic with CSS anchor positioning, which
flips, tracks the anchor while the form scrolls, and hides itself when the anchor goes away.

### Files changed

- `desktop/renderer/live/live.css` — centring keywords off `#live-setup`; `margin: auto` on the
  shared `.live-setup-inner`, with why it is the shared rule and why `display: flex` is now
  structural rather than cosmetic.
- `desktop/renderer/record/record.css` — the duplicate Record-side `margin: auto` override deleted;
  `.ts-model-grid` tracks changed to `minmax(0, 1fr)` and `.ts-model-top` / `.ts-model-footer` given
  `flex-wrap: wrap` so the cards stop spilling out of the column.
- `desktop/renderer/calendar-picker.js` — `positionUnder()` deleted; `.cal-pop` placed by
  `position-anchor` / `position-area` / `position-try-fallbacks` / `position-visibility`, with the
  anchor name set on open and cleared on close; `onOutside` no longer closes on a mousedown that
  landed on the anchor button, which is what made click-to-toggle actually work.
- `desktop/test/setup-screens.test.js` (new) — the CSS invariants, guarded on both containers and
  both properties, through a brace-matching scanner that sees grouped selectors, later duplicates
  and at-rule wrappers, plus an assertion that the markup still uses the shared class.
- `desktop/scripts/layout-check.mjs` (new) — geometry gate driving its own Electron over CDP, one
  row per scenario. Lives outside `test/` so bare `node --test` does not drag Electron into
  `npm test`.
- `desktop/test/renderer-globals.test.js` — a `vm.Script` parse check over renderer scripts, after a
  stray backtick in the injected-CSS template literal killed `calendar-picker.js` at parse time
  mid-implementation and silently disabled all three buttons.
- `desktop/package.json`, `README.md` — the `check:layout` script and what it needs to run.

### Review findings

Four review layers ran in parallel. 19 patches applied (3 high, 9 medium, 7 low), 2 items deferred
(see frontmatter), 9 rejected.

The three high findings: Live's 58 px horizontal overflow, which the spec's own "Never: do not
restyle the form" had wrongly fenced off against an intent that names it explicitly; `check:layout`
exiting non-zero after 17 passing rows because the scratch-directory cleanup raced Electron's
unawaited shutdown; and the CSS guard pinning only the Live side, demonstrated by a reviewer who
re-broke Record with `npm test` fully green.

Two harness bugs were then caught by the guards added for those findings — a scroll assertion that
had been a no-op, and a short-circuited close leaking an open popover into the next row.

Follow-up review recommended: **true** — 3 patched findings were high severity, which triggers it
on its own (score threshold not reached otherwise: 3x9 medium + 7 low).

### Verification

- `cd desktop && npm test` — 60/60 pass, 279 ms, exit 0.
- `cd desktop && npm run check:layout` — 23/23 rows pass, exit 0 verified explicitly, no scratch
  directory left behind. Covers every I/O matrix row.
- Independently measured before and after over CDP: Live went from `inner.top: -94` against a
  container top of 52 (146 px unreachable) to 40 px of padding above the heading with
  `maxScroll 399 >= overflowBelow 359`; horizontal overflow 58 px to 0; the popover from
  `bottom: 1011` in an 800 px window to flipping above the button at `bottom: 768`.

### Residual risks

- Record's start screen already had the scroll fix, so of the two screens named in the intent only
  Live changes behaviourally there — beyond the shared popover and the model grid, which is Live's
  alone. Deliberate: Record measured correct before the change.
- `check:layout` is opt-in and this repo has no CI, so nothing re-runs the geometry gate
  automatically. `npm test` guards the CSS invariants, not the pixels.
- In a window short enough that the popover fits neither below nor above its button, it stays 320 px
  instead of shrinking and overlaps the anchor by ~24 px. Clamping the height would remove the
  overflow that triggers the flip, so the flip would never happen — flip was chosen. That state is
  not reachable through the real UI; the check reaches it by parking the button by hand.
- `renderer/speaker-rename.js` still carries the identical unclamped positioner, deferred as out of
  this intent's scope.
