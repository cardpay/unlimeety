---
title: 'Floating panel windows follow the app theme'
type: 'bugfix'
created: '2026-09-02'
status: 'done'
baseline_commit: '2f9e5492fc9958099bf2ae41d3ecb4dc60500812'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Both floating panels — the recording prompt (`renderer/prompt/prompt.html`, shown to
offer recording when a call starts and to count down the auto-stop) and the live-notes widget
(`renderer/notes/notes.html`) — pin `color-scheme: dark` and hardcode dark hex literals, so on the
light theme they float as dark cards over a light desktop.

**Approach:** Load the app's existing `renderer/theme-init.js` in both panels (it reads the
`uds-theme` localStorage preference, shared across the app's `file://` windows) and move their shared
card palette into one new `renderer/panel-theme.css` holding today's dark values as custom-property
defaults plus a `:root[data-theme="light"]` override taken from `renderer/theme-light.css`.

## Boundaries & Constraints

**Always:**
- Dark rendering of both panels stays visually identical — same hex values, same layout.
- Panels keep their transparent background, frameless `type: 'panel'` behavior, `-webkit-app-region`
  drag regions, and `sandbox` / `contextIsolation` window options.
- `panel-theme.css` is the single source of truth for shared colors; panel-only colors stay in that
  panel's inline `<style>` but still resolve through custom properties.
- Light values come from the existing `theme-light.css` palette, not invented colors.
- `theme-init.js` is loaded, never modified or copied.

**Ask First:**
- If the panels cannot read `uds-theme` (storage isolation between `file://` windows), stop and report
  before inventing a main-process IPC theme channel.

**Never:**
- Do not link `style.css` / `live.css` / `theme-light.css` into either panel — only the new
  `panel-theme.css` is shared.
- Do not touch the main window, `main.js`, `preload.js`, or any IPC.
- No live theme-change subscription — panels read the theme at load.
- No CSP change beyond adding `'self'` to `style-src`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Dark preference | `uds-theme` = `dark` or unset | `data-theme="dark"`; both panels render as today | N/A |
| Light preference | `uds-theme` = `light` | `data-theme="light"`; white cards, near-black text, light hovers, soft shadow | N/A |
| System preference | `uds-theme` = `system` | Resolved via `prefers-color-scheme` at window load | N/A |
| Auto-stop mode | prompt `mode: 'autostop'`, light | Countdown text, ✕ and both buttons legible on the light card | N/A |
| Notes collapsed | `body.collapsed`, light | Header-only card keeps light border/shadow, no dark seam | N/A |
| Notes input focus | light, input clicked | Focus ring uses the light accent, not `#5a5aef` | N/A |
| Storage unreadable | localStorage throws / empty | Falls back to dark, no crash | Silent fallback |

</frozen-after-approval>

## Code Map

- `desktop/renderer/prompt/prompt.html` (~110 lines) and `desktop/renderer/notes/notes.html`
  (143 lines) — the whole bug: each opens with `:root { color-scheme: dark; }` and every color in its
  inline `<style>` is a dark literal. They share card, border, title, muted, hover and shadow values;
  the prompt adds its red primary and ghost button, the notes card adds row border, note time, note
  text, input bg/border, placeholder and a `#5a5aef` focus ring. Read both files for the exact values.
- `notes.html` already loads `../notes-list.js` — proof `script-src 'self'` admits a
  sibling-directory script, so `../theme-init.js` needs no CSP change. Both CSPs are
  `default-src 'none'; style-src 'unsafe-inline'; script-src 'self'`, so `style-src` needs `'self'`
  added before a stylesheet can be linked (same-origin only).
- `desktop/renderer/theme-init.js` — the reuse point: reads `uds-theme` (default `dark`), resolves
  `system` via `matchMedia('(prefers-color-scheme: light)')`, sets `documentElement.dataset.theme`;
  built to run from `<head>` before first paint.
- `desktop/renderer/theme-light.css` — light values to borrow: `--bg-surface #ffffff`,
  `--bg-elevated #f1f0ea`, `--bg-hover #e7e5dd`, `--border rgba(28,26,22,0.10)`,
  `--border-strong rgba(28,26,22,0.18)`, `--text-primary #20201c`, `--text-secondary #5a574f`,
  `--text-muted #837f74`, `--accent #6b45e8`, `--border-focus rgba(107,69,232,0.55)`, `--rec #dc2626`;
  line 99 is the established floating-popup light shadow
  `0 12px 32px rgba(28,26,22,0.16), 0 2px 6px rgba(28,26,22,0.06)`.
- `desktop/main.js:4330` `showNotesWindow()`, `:4474` `showPromptWindow()`, `:4611` autostop trigger —
  read-only: both windows are `transparent` and shown with `showInactive()` on `ready-to-show`, so a
  theme applied during load never flashes.
- `desktop/renderer/app.js:4974-4990` `applyTheme()` — read-only: writes the `uds-theme` value.
- `desktop/test/setup-screens.test.js` — pattern to copy: `node --test`, reads renderer files off
  disk, brace-matching CSS rule walk, no DOM. Its header records that a shared fix drifting into
  one-file overrides is a live failure mode in this renderer.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/renderer/panel-theme.css` — new: `:root` defaults holding the panel palette at today's
  dark values (card, border, title, muted, hover, shadow, plus prompt-only and notes-only colors) with
  `color-scheme: dark`, and one `:root[data-theme="light"]` block overriding them from the
  `theme-light.css` values above with `color-scheme: light`.
- [x] `desktop/renderer/prompt/prompt.html` — add `'self'` to `style-src`, load `../theme-init.js` in
  `<head>`, link `../panel-theme.css`, drop its own `:root { color-scheme: dark; }`, and replace every
  color literal in its inline `<style>` with the shared properties.
- [x] `desktop/renderer/notes/notes.html` — same edits, covering its row border, note time, note text,
  input, placeholder and focus ring.
- [x] `desktop/test/panel-theme.test.js` — new `node --test`: both panels link `theme-init.js` and
  `panel-theme.css` and no longer pin `color-scheme: dark`; `panel-theme.css` overrides in its
  `[data-theme="light"]` block every property its `:root` declares; no hex/rgba literal survives in
  either panel's rule bodies. Guards the regression and the one-file drift above.

- [x] `desktop/renderer/theme-init.js` — wrap the `localStorage.getItem` read in try/catch falling
  back to the dark default, so a `<head>` script cannot abort before `data-theme` is set. Human
  authorized overriding the "never modified" constraint (see Spec Change Log).
- [x] `desktop/test/theme-init.test.js` — new `node --test`: runs the script off disk with stubbed
  globals (the `transcript-meta.test.js` pattern) and pins unset/`dark`/`light`/`system`x2 plus the
  throwing-storage fallback — the matrix rows the static CSS test cannot reach.

**Acceptance Criteria:**
- Given `uds-theme` is unset or `dark`, when either panel appears in any of its states, then it is
  visually identical to the current build.
- Given the light theme, when a panel loads, then `documentElement.dataset.theme` is `light` and card,
  text, buttons, ✕, list rows and input all use light-theme colors.
- Given `npm test` from `desktop/`, then the whole suite passes including the new file.

## Spec Change Log

- Matrix audit, before review: the "localStorage throws -> silent fallback" row was unsatisfiable
  under the **Always** constraint "theme-init.js is loaded, never modified" — the script had no
  try/catch and there is nowhere else to put one. Human chose to add the guard rather than narrow the
  row, so that constraint is overridden for this one guard. It does NOT close the same exposure in the
  main window — `app.js`'s own `uds-theme` reads and writes stay unguarded, and the Never list keeps
  the main window out of scope (deferred). Avoided known-bad state: a `<head>` script throwing before `data-theme` is set,
  leaving the page unstyled. KEEP: the guard falls back to the dark default, never to `system`.
- Scope renegotiated by the human before approval: the live-notes widget joined the recording prompt,
  turning a one-file light override into a shared `panel-theme.css` both panels link. Spec
  regenerated under a new file name; no prior content carried over.

## Design Notes

localStorage over a main-process IPC theme: all windows load `file://` in one session, so `uds-theme`
written by the main window is the storage the panels read — `theme-init.js` needs no argument and no
new IPC. Verified explicitly below, since storage isolation would silently leave both panels dark.

One shared stylesheet over a light block per panel: the cards already share seven colors and the same
chrome, and duplicating the override is exactly the drift `setup-screens.test.js` was written after.

```css
:root { color-scheme: dark; --panel-bg: #1b1b22; --panel-border: #2c2c36; /* … */ }
:root[data-theme="light"] {
  color-scheme: light; --panel-bg: #fff; --panel-border: rgba(28,26,22,.10); /* … */
}
```

## Verification

**Commands:**
- `cd desktop && npm test` — expected: all `node --test` files pass, `panel-theme.test.js` included.

**Manual checks (if no CLI):**
- Throwaway Electron harness (scratchpad, not the repo): load `prompt.html`, set
  `localStorage['uds-theme'] = 'light'`, then load `prompt.html` and `notes.html` in fresh windows and
  read back `documentElement.dataset.theme` — expected `light`, proving script and stylesheet both
  pass the panels' CSP and see the shared preference. Repeat with `dark` and with the key removed —
  expected `dark`.
- Screenshot both panels in both themes — prompt in `call` and `autostop`, notes expanded and
  collapsed — and confirm text, borders and focus ring are legible on light.

## Suggested Review Order

**The shared palette — where the design lives**

- Entry point: why the panels get their own palette file, and what it may not do yet.
  [`panel-theme.css:1`](../../desktop/renderer/panel-theme.css#L1)

- Dark defaults are the old literals verbatim, so a panel with no `data-theme` is unchanged.
  [`panel-theme.css:39`](../../desktop/renderer/panel-theme.css#L39)

- Light block. Four commented deviations from a straight `theme-light.css` copy — read those.
  [`panel-theme.css:66`](../../desktop/renderer/panel-theme.css#L66)

- The named ceiling: an open notes widget keeps its theme until reopened.
  [`panel-theme.css:24`](../../desktop/renderer/panel-theme.css#L24)

**Theme resolution — the one piece of logic, now shared with the main window**

- Nothing may throw out of a `<head>` script; every failure lands on dark.
  [`theme-init.js:9`](../../desktop/renderer/theme-init.js#L9)

- Only `light`/`dark`/`system` pass; `matchMedia` is consulted for `system` alone.
  [`theme-init.js:13`](../../desktop/renderer/theme-init.js#L13)

**The panels — mechanical, but the CSP line is the security-relevant one**

- `style-src` gains `'self'` so the stylesheet loads; `default-src 'none'` stays.
  [`notes.html:6`](../../desktop/renderer/notes/notes.html#L6)

- Script before stylesheet, both from the parent directory, before first paint.
  [`notes.html:10`](../../desktop/renderer/notes/notes.html#L10)

- Same two edits on the prompt; the rest of its diff is literal-to-`var()`.
  [`prompt.html:6`](../../desktop/renderer/prompt/prompt.html#L6)

**Tests**

- Colors are checked by property name against a value allowlist — `color: white` fails.
  [`panel-theme.test.js:110`](../../desktop/test/panel-theme.test.js#L110)

- Drift guard: light overrides every default, with an explicit theme-independent allowlist.
  [`panel-theme.test.js:69`](../../desktop/test/panel-theme.test.js#L69)

- CSP floor asserted in both directions, not just the addition.
  [`panel-theme.test.js:136`](../../desktop/test/panel-theme.test.js#L136)

- Resolution table pinned with stubbed globals, including both throwing collaborators.
  [`theme-init.test.js:25`](../../desktop/test/theme-init.test.js#L25)
