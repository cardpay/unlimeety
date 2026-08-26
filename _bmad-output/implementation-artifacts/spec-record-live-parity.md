---
title: 'Record tab: Live-style start screen + in-recording language picker that auto-transcribes on stop'
type: 'feature'
created: '2026-08-26'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'a9ed6d3384b56552ae2c831bb1004a20cd1da25b'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Record tab's start screen was designed independently from Live's and reads as a
different app (uppercase kicker sections, green permissions box, dead "Change…" folder button, 620px
column) where Live uses a quiet 520px `live-row` form. And stopping a recording drops the user on the
idle screen with the file merely parked under "To transcribe" — every recording needs a manual trip
through the batch settings screen just to pick a language.

**Approach:** Rebuild `#record-setup` on Live's existing setup classes (already globally loaded),
minus Live's Model block — the Record tab gets no model control at all. Add a language segmented
control to the recording-in-progress screen bound to `state.batchSettings.language`, unify all three
language pickers on one seven-option set, and have `recordSaved` fire the already-built but never-wired
`record:autoQueueTranscribe` hook, which queues a hard `large-v3` diarized run and chains an Enhance
pass over its result.

## Boundaries & Constraints

**Always:**
- Reuse Live's classes (`.live-setup-inner`, `.live-row`, `.live-label`, `.live-perm-hint`,
  `.live-perm-troubleshoot`); do not clone their rules under new `record-*` names.
- Reuse `record:autoQueueTranscribe` (main.js **3374**) / `queueAutoTranscribe` (main.js **31–41**)
  for the on-stop run. Its hardcoded `openai_whisper-large-v3` and `diarize: true` are the intended
  behaviour, and the Enhance chain that every transcribe job gets (main.js **4029**) is wanted.
- One language set everywhere: `ru en sr es de fr auto`, same order, in all three pickers
  (`#live-language`, `#ts-lang-seg`, the new recording-screen one). The dead `data-lang="more"`
  button goes.
- One language notion on the Record side: the new picker writes `state.batchSettings.language` through
  the existing `onBatchSettingsChanged()` + `applyBatchSettingsToScreen()` path, so both Record
  pickers stay in sync and the choice keeps persisting to `localStorage`.
- Calendar-picked participants must not be silently lost on the auto path: pass
  `state.calendarParticipants` through as an optional third argument, defaulting to `[]` so
  `live:saveTranscript`'s existing two-argument call (main.js **3060**) is unaffected.
- Every element id `record.js` holds a ref to survives, or its ref goes in the same edit. Ids stay
  unique — the copied troubleshoot block gets `record-`-prefixed ids.

**Ask First:**
- Gating auto-transcribe-on-stop behind an opt-out toggle.
- Any Live change beyond swapping its language row's buttons.
- Any change to `queueAutoTranscribe`'s hardcoded model or diarize flag.

**Never:**
- No model control anywhere on the Record tab outside `#record-transcribe-settings` — that screen
  stays the only place a model is chosen, and the auto path ignores it by design.
- No Language row on the Record *start* screen; the picker lives on the recording screen, where the
  user can already hear which language is being spoken.
- Do not route the on-stop run through `record:transcribe` / `startTranscription` /
  `buildTranscribeOpts` — those stay exactly as they are, serving the manual batch flow.
- No new dependency, no new `BrowserWindow`, no CSP change.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|---|---|---|---|
| Stop, any phase | `recordSaved` with a path, `sr` picked mid-recording | `api.autoQueueTranscribe(path, 'sr', participants)` submits one `transcribe` job with `large-v3` + diarize; lane completion chains `enhance` | Handler returns `{ok:false,error}` on a non-darwin / unreadable path → surface on `#record-setup-error`, do not throw |
| Visible section after stop | `phase === 'recording'` | Idle screen, `#record-trans-active-banner` lit from the queue broadcast with its View queue button | N/A |
| Stop while another section is up | `phase` is `transcribing` / `transcribeSettings` | Job still submitted; visible section NOT yanked (existing guard keeps `showSection` scoped to `'recording'`) | Failed job shows in the header queue panel |
| Auto-stop (meeting ended) | `autoStop` → `stopAndSave()` | Same path — the submit hangs off `recordSaved`, not the button handler | N/A |
| `auto` selected | `batchSettings.language === 'auto'` | Job carries `'auto'`; helper passes `nil` to WhisperKit, which detects | N/A |
| Language set on the batch screen | `batchSettings.language === 'de'` | Recording screen's picker opens with `de` active, and vice versa | N/A |
| Legacy persisted `'more'` | `localStorage` from a build where "More…" existed | No segment highlighted; job sends `'more'` and the helper falls back to its own default | Not repaired — one stale value, self-heals on the next pick |
| `recordSaved` with no path | `event.path` and `state.outputPath` both empty | Unchanged: back to idle, no job submitted | N/A |

</frozen-after-approval>

## Code Map

- `desktop/renderer/index.html` — mirror `#live-setup` **346–486**, skipping its Model block
  (**368–405**): take `.live-setup-inner`, `.live-row` + `.live-label`, `.live-perm-hint` **444–448**,
  `.live-perm-troubleshoot` **449–467**, `.live-setup-actions` **476–482**. Rebuild `#record-setup`
  **572–632**. Recording screen `#record-recording` **635–685** (`.record-rec-hero` 664–684: waveform
  668, `.record-file-card` 669–674, footer 685). Language pickers to unify: `#live-language`
  **415–420** (4 buttons now), `#ts-lang-seg` **816–825** (6 + dead `More…`).
- `desktop/renderer/record/record.css` — `#record-setup` **42–47** and `.record-setup-scroll`
  **49–58** repoint at `#live-setup` / `.live-setup-inner` (live.css **57–72**). Orphaned by the
  rebuild: **60–91** (`.record-setup-title`, `.record-kbd`, `.record-setup-desc`, `.record-section*`),
  **145–174** (`.record-folder-*`), **176–199** (`.record-perm-strip` and friends), **211–216**
  (`.record-action-row`). `.ts-seg-wrap` / `.ts-seg` **909–936** already work on any screen;
  `.ts-seg.is-dim` **936** goes with the `More…` button.
- `desktop/renderer/record/record.js` — refs **28–75**; `state.batchSettings` **136–147**;
  `state.calendarParticipants` **~133**; `onBatchSettingsChanged()` **~227**;
  `applyBatchSettingsToScreen()` **1096–1132** (language loop 1110–1114); `#ts-lang-seg` handler
  **1190–1201** (pattern to copy; its `lang === 'more'` guard goes); `recordSaved` **701–715** — the
  one behavioural edit, right after `state.outputPath = event.path || state.outputPath`;
  `openScreenSettingsBtn` **330**; dead folder handler **1258–1263**.
- `desktop/preload.js` **137–151** — the `recordApi` block; needs one line exposing
  `record:autoQueueTranscribe`, which has **no** bridge today (grep: the channel appears only in
  main.js). Follow the `transcribe:` line's shape at **147**.
- `desktop/main.js` — `queueAutoTranscribe` **31–41** (hardcodes `openai_whisper-large-v3`,
  `diarize: true`, `numberOfSpeakers` undefined → auto-detect); handler **3374–3381** (darwin gate +
  `canReadPath`); existing two-arg caller in `live:saveTranscript` **3060**; the unconditional Enhance
  chain **4025–4030**. Both need a third `participants` parameter, defaulted so **3060** is unchanged;
  the extra field rides in `extra` alongside `filePath` the same way `record:transcribe` passes it.
- `desktop/renderer/live/live.js` **208–218** — `#live-language` click handler, already generic over
  `data-lang`, so new buttons need no JS change. **243–257** — `live-copy-tcc-cmd` clipboard handler to
  mirror for the Record copy of the troubleshoot block.
- Read-only evidence that omitted knobs match the batch screen's own defaults, so the auto path is not
  a quietly different transcription: `live-helper/Sources/TranscriberLive/FileTranscriber.swift`
  **103** (`config.vadFilter.map { … }` → nil when absent) plus
  `.build/checkouts/argmax-oss-swift/Sources/WhisperKit/Core/WhisperKit.swift` **906** (only
  `case (true, .vad)` chunks, so nil == VAD off, matching `batchSettings.vadFilter === false`), **109**
  (`temperature ?? 0.0`), **108** (`language == "auto" ? nil`), **148** (`diarize ?? true`). The single
  real divergence: `numberOfSpeakers` is auto-detected instead of the batch screen's default `3`.
- `desktop/renderer/live/live.css` **57–107, 238–320** — classes reused as-is.
- `desktop/test/renderer-globals.test.js` — the existing pattern for a test that reads renderer source
  files directly; the new markup-invariant test follows it.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/main.js` — give `queueAutoTranscribe` and the `record:autoQueueTranscribe` handler an
  optional third `participants` argument (sanitised to an array of strings, default `[]`) passed into
  `extra`. Rationale: the auto path is now the primary path, and dropping calendar participants would
  silently gut the Record tab's calendar pre-fill.
- [x] `desktop/preload.js` — expose `autoQueueTranscribe: (filePath, language, participants) => …` on
  `recordApi`, matching the `transcribe:` line's shape and comment style.
- [x] `desktop/renderer/index.html` — rebuild `#record-setup`'s inner markup on `.live-setup-inner` /
  `.live-row` / `.live-label`: h2, a `.live-muted` blurb naming the save folder and saying
  transcription starts on stop with large-v3, rows for Sources and Title (no Model row, no Language
  row), Live's `.live-perm-hint` (keeping `#record-open-screen-settings`), a `record-`-id'd copy of
  `.live-perm-troubleshoot`, then `.live-setup-actions` with Start + Import.
  `#record-trans-active-banner` stays the first child. Drop the SAVE TO row (`#record-folder-label`,
  `#record-btn-change-folder`) — Live has no such row and the button is a `console.warn` no-op.
  Rationale: parity is structural, not a repaint.
- [x] `desktop/renderer/index.html` — add a `Transcribe in` label + `#record-rec-lang-seg`
  `.ts-seg-wrap` to `.record-rec-hero` between the waveform and `.record-file-card`; set all three
  pickers to the same seven `data-lang` buttons `ru en sr es de fr auto`, dropping
  `data-lang="more"`. Rewrite `.record-rec-footer`'s copy: on Stop & save, a large-v3 diarized
  transcription starts automatically in the chosen language, then an Enhance pass. Rationale: one
  language vocabulary app-wide, and the picker sits where the user can hear what is being spoken.
- [x] `desktop/renderer/record/record.css` — repoint `#record-setup` at Live's centred layout, delete
  the orphaned rules listed in the Code Map, add only `.record-rec-lang` / `.record-rec-lang-label`.
- [x] `desktop/renderer/record/record.js` — add a `recLangSeg` ref, a click handler copying the
  `#ts-lang-seg` one (minus its `'more'` guard), and a second loop in `applyBatchSettingsToScreen()`
  so both Record pickers track `batchSettings.language`; apply settings when entering the recording
  section. In `recordSaved`, when a path exists, `await api.autoQueueTranscribe(path,
  state.batchSettings.language, state.calendarParticipants)` and show its `error` on
  `#record-setup-error`; leave the existing `if (state.phase === 'recording') showSection('idle')`
  guard alone. Drop the dead folder handler; wire the Record troubleshoot Copy button. Rationale: the
  submit is the whole behavioural change — no new state, no new options plumbing.
- [x] `desktop/test/language-pickers.test.js` — new `node --test` file reading `renderer/index.html`
  and asserting all three language containers list the identical seven `data-lang` values in the same
  order, and that no `data-lang="more"` survives. Rationale: three copies of one vocabulary is exactly
  the invariant that rots silently.
- [x] `desktop/test/record-auto-transcribe.test.js` — added during implementation, not planned here.
  The `recordSaved` edit turned out to have two extractable pure parts (`autoTranscribeArgs`,
  `paintLangSegs`, in an `// ── auto-transcribe ──` region), so the matrix rows about paths, languages
  and picker sync are covered by executing real code rather than by manual inspection; the rows that
  are pure wiring (the section guard, `autoStop`, the queue-driven banner) are asserted on source.

**Acceptance Criteria:**
- Given the Record tab is idle, when compared with Live's setup screen, then both render one centred
  520px column of `.live-row` groups with the same label typography, permission hint and troubleshoot
  disclosure — no uppercase kickers, no green permission box, no folder row — and Record shows neither
  a Model nor a Language row.
- Given a recording is in progress, when a language is picked on the recording screen and the batch
  transcribe-settings screen is then opened, then it shows the same language selected, and the reverse
  holds too.
- Given a language was picked on the recording screen, when the recording is stopped, then no manual
  step follows: a transcribe job appears in the header queue panel carrying that language and
  `openai_whisper-large-v3`, and on its success an `enhance` job follows for the same transcript.
- Given the batch screen's model is set to something other than large-v3, when a recording is stopped,
  then the auto run still uses `openai_whisper-large-v3` and the batch screen's own choice is
  untouched.
- Given a calendar event was picked before recording, when the auto run finishes, then the transcript
  carries its `Participants:` line.
- Given `npm test` from `desktop/`, when it completes, then every test passes.

## Spec Change Log

- **Human edit at CHECKPOINT 1 (pre-approval), round 1.** Findings: the Record start screen must not
  carry a model control (Live's Model block is skipped, not mirrored) and every language picker must
  offer six languages plus `auto`. Amended: added the language-set unification across `#live-language`
  / `#ts-lang-seg` / the new picker, relaxed the "never touch Live" boundary to its language row.
  KEEP: reusing Live's existing CSS classes rather than cloning them; `batchSettings.language` as the
  single language state.
- **Human edit at CHECKPOINT 1 (pre-approval), round 2.** Findings: round 1 wrongly dropped the forced
  model and wrongly rejected the existing `record:autoQueueTranscribe` hook — large-v3 must be hard,
  the hook must be reused, and the Enhance chain is wanted. Amended: the on-stop run goes through
  `record:autoQueueTranscribe` (its main-process hardcode is now the point, not a defect); removed the
  planned `buildTranscribeOpts(filePath, overrides)` argument and the `startTranscription` /
  phase-routing task along with the routing helper and its test; added a preload bridge task (the
  channel had none), a `participants` pass-through, and a markup-invariant test instead. Avoids the
  known-bad state of a second parallel transcribe-submit path in the renderer when a wired one already
  exists. KEEP: no per-call options override, and `record:transcribe` / `startTranscription` left
  untouched for the manual batch flow.

- **Human reversal after shipping.** The frozen `Never` block said "No Language row on the Record
  *start* screen; the picker lives on the recording screen" and `Ask First` listed adding one as a
  product decision. The human made it: "вдруг я заранее знаю, на каком языке будем говорить". The
  start screen now carries a fourth picker, `#record-setup-lang-seg`, in the row position Live gives
  Language. No new state and no new logic — `record.js` gained a `langSegs` list that the init paint,
  `applyBatchSettingsToScreen()` and the shared click handler all spread, so a fifth picker would be
  one edit rather than four. That frozen sentence is now historical; this entry, not the block, is the
  current answer. KEEP: `batchSettings.language` as the single language state, and one handler for
  every picker.

## Design Notes

Why the recording screen and not the start screen: at start you often don't know which language the
call will be held in; thirty seconds in you do. The picker is deliberately the *only* language control
the Record flow needs — hence binding it to `batchSettings.language` instead of a third piece of state.

Why the on-stop run deliberately ignores the batch screen's settings: the two paths answer different
questions. The auto path is "always give me the best transcript, unattended" — hence a hardcoded
`large-v3`, diarize on, speakers auto-detected. `#record-transcribe-settings` stays the place to
override any of that for a specific batch. Language is the one knob that must be shared, because it is
the one the user learns during the call.

## Verification

**Commands:**
- `cd desktop && npm test` — expected: all `node --test` files pass, new one included.
- `cd desktop && grep -o 'id="[^"]*"' renderer/index.html | sort | uniq -d` — expected: no output.
- `cd desktop && grep -c 'data-lang="more"' renderer/index.html` — expected: 0.
- Every `$('…')` in `record.js` still resolves to an id in `index.html` — expected: no misses.

**Manual checks:**
- `npm start` from `desktop/`: Record and Live setup screens side by side — same column width, label
  style, permission hint, troubleshoot disclosure; Record has neither Model nor Language row.
- Record a few seconds, switch language mid-recording, Stop & save: the header queue panel shows a
  transcribe job immediately, the idle screen's "Transcription in progress" banner is lit, and an
  Enhance job follows the transcribe.
- Pick `auto`, record speech, stop: the transcript's `Language:` header reads `auto` and the text is in
  the spoken language.
- Pick a calendar event, record, stop: the finished transcript carries a `Participants:` line.
- Record, open the batch settings screen from the Meetings list, then stop: the settings screen stays
  put and the job shows in the header queue panel.

## Suggested Review Order

**The behavioural change: Stop & save now queues a transcription**

- Start here — the whole feature is this one case: leave the screen, then submit.
  [`record.js:778`](../../desktop/renderer/record/record.js#L778)

- What gets submitted, and the two reasons it submits nothing at all.
  [`record.js:268`](../../desktop/renderer/record/record.js#L268)

- The reused hook: model and diarization are fixed here, not in the renderer.
  [`main.js:34`](../../desktop/main.js#L34)

- Platform gate, path confinement, participants coercion — the trust boundary.
  [`main.js:3382`](../../desktop/main.js#L3382)

- The bridge that did not exist; the channel had no renderer side at all.
  [`preload.js:151`](../../desktop/preload.js#L151)

**One language, three pickers**

- Single painter for both Record pickers, `aria-checked` included.
  [`record.js:303`](../../desktop/renderer/record/record.js#L303)

- One click handler for both, so a second copy cannot drift from the first.
  [`record.js:1295`](../../desktop/renderer/record/record.js#L1295)

- The new picker, on the recording screen where the language is actually known.
  [`index.html:698`](../../desktop/renderer/index.html#L698)

- Live gains Spanish/German/French; the dead `More…` button goes.
  [`index.html:417`](../../desktop/renderer/index.html#L417)

- The batch picker gains `auto`, which the Swift side already understood.
  [`index.html:852`](../../desktop/renderer/index.html#L852)

**Start screen rebuilt on Live's form**

- Live's column, minus its Model and Language rows; SAVE TO and its no-op gone.
  [`index.html:582`](../../desktop/renderer/index.html#L582)

- `margin: auto`, not centering: a centered scroll container clips its own top.
  [`record.css:47`](../../desktop/renderer/record/record.css#L47)

- The banner now lives in a 520px column, so it is a box, not a full-width strip.
  [`record.css:1220`](../../desktop/renderer/record/record.css#L1220)

- Only the row is local; the pills are the shared `.ts-seg` styles.
  [`record.css:296`](../../desktop/renderer/record/record.css#L296)

**Copy that had to stop over-promising**

- Says where the wav goes, and that Enhance may leave the machine.
  [`index.html:590`](../../desktop/renderer/index.html#L590)

- Same correction on the recording screen's footer.
  [`index.html:724`](../../desktop/renderer/index.html#L724)

- Record's own troubleshoot Copy button; label restores from a constant.
  [`record.js:392`](../../desktop/renderer/record/record.js#L392)

**Tests and docs**

- Executes the real helpers, then pins the wiring no in-process test can reach.
  [`record-auto-transcribe.test.js:1`](../../desktop/test/record-auto-transcribe.test.js#L1)

- Holds the three pickers to one vocabulary, roles and all.
  [`language-pickers.test.js:1`](../../desktop/test/language-pickers.test.js#L1)

- README still described record-now-transcribe-later, and a `⌘R` with no handler.
  [`README.md:86`](../../README.md#L86)
