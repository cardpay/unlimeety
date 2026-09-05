---
title: 'Show which model transcribed a transcript and whether Enhance ran'
type: 'feature'
created: '2026-08-24'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '1387badfff76e00ae0806dbc590f9a96ca6000c1'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A finished transcript records nothing about how it was produced. The
Transcripts list cannot tell a `tiny`-model Live draft from a `large-v3` re-run,
nor a raw ASR dump from one already proofread by Enhance — so work gets redone, or
uncleaned text gets trusted.

**Approach:** Record provenance in the transcript's own plain-text header — a
`Model:` line from each transcription writer, an `Enhanced:` line stamped by the
Enhance pass — expose both through `transcripts:list`, and render them on the
meeting card as a model-name chip (strong `large-*` vs light) plus an `Enhanced`
chip beside the existing audio/transcript/summary chips.

## Boundaries & Constraints

**Always:**
- Provenance lives in the header, in the existing `Key: value` shape used by
  `Meeting:` / `Recorded-At:` / `Generated:` / `Language:` / `Source:`.
- `Model:` stores the raw WhisperKit id (`openai_whisper-large-v3`); label and
  tier are derived in the renderer.
- `Enhanced:` means "went through Enhance", so a pass that changed no text still
  stamps it — while the queue row still reports "Nothing to fix".
- Header writes stay lossless: body byte-identical, existing lines untouched.
- A missing line renders as unknown, never as a guess.

**Ask First:**
- Storing provenance anywhere other than header lines (sidecar, DB, filename).
- Backfilling provenance into existing transcripts.

**Never:** no backfill/migration; no new IPC channel or filesystem path; no change
to the transcript body, the Record tab's list, or the summary format; no new
sidebar filter, sort, or search over these fields.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Transcribe (record or Live) | run on `openai_whisper-large-v3` / `openai_whisper-base` | header gains `Model: <id>`; chip reads `large-v3` (strong) / `base` (light). A re-run over the same `.txt` (`queueAutoTranscribe`) replaces the line | model unknown → no line, no chip |
| Enhance applied ≥1 part | proofread text differs | `Enhanced: <ISO>` stamped, chip lights up | N/A |
| Enhance found nothing | every part came back identical | still stamped and written; queue row still says "Nothing to fix" | N/A |
| Enhance failed or file went stale | all parts unusable, or file changed mid-run | no stamp, no write | existing error paths unchanged |
| Re-enhance | header already has `Enhanced:` | line replaced, never duplicated | N/A |
| Legacy or pasted transcript | neither line present (`transcripts:create`) | no model chip; enhance chip stays dimmed (`data-present="false"`) | N/A |
| Header-less transcript | content starts at the first `[mm:ss] Speaker:` marker | stamp prepended as its own header block before the body | N/A |

</frozen-after-approval>

## Code Map

- `desktop/main.js:1739` `parseTranscriptHeaderMain` — only header reader; add
  `Model: `→`info.model`, `Enhanced: `→`info.enhancedAt`. `transcripts:list`
  (`:1800`) already spreads `...info`.
- `desktop/main.js:1758` `setHeaderLine` — replace-only, cannot add a new line.
- `desktop/main.js:2440` `live` state — does not keep the session model;
  `live:start` builds it at `:2695` (`opts?.model || 'large-v3-turbo'`).
- `desktop/main.js:2913` Live writer `headerLines`; `:3852` record-transcribe
  writer `headerLines`, model already in scope as `model` (`:3662`).
- `desktop/main.js:2196`–`2341` Enhance runner: `splitTranscript` → `header`,
  `assembleTranscript(header, blocks)` at `:2341`, and `changed` decided by
  `updated === original` at `:2342` — compare the un-stamped assembly, then stamp.
- `desktop/main.js:2114` `transcripts:create` — manual paste, no model; leave.
- `desktop/transcript-enhance.js:241/406/428` `splitTranscript` /
  `assembleTranscript` / `matchLineEndings` — header/body contract; endings are
  normalized after assembly, so a stamp may use `\n`. Exports at `:435`.
- `desktop/renderer/app.js:58` `deriveMeetingFromTranscript` — add `model`,
  `enhancedAt`. `:1454` card `artifact-chips`. `:1790` `ICON_PATHS` already has
  `check`.
- `desktop/renderer/app.js:3673` `onQueueChanged` — the refresh hook: the Enhance
  write stamps `lastSelfWrite` (`main.js:2347`) and `transcripts:watch` (`:1891`)
  suppresses `transcripts:changed` for it, so the chip would not appear on its
  own. `loadLibrary()` (`:1280`) only rebuilds the list — safe to call.
- `desktop/renderer/style.css:998`–`1041` `.artifact-chip[data-kind=…]` — pattern
  the new styles follow.
- `desktop/renderer/record/record.js:80` model→label table — read-only evidence
  that stripping `openai_whisper-` and turning `_` into a space reproduces every
  shipped label. Separate script; do not import.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/transcript-enhance.js` -- add and export pure
  `stampHeaderLine(header, key, value)`: replace an existing `Key: …` line, else
  append after the last non-empty header line, else (empty/whitespace header)
  return a standalone header block -- upsert semantics `setHeaderLine` lacks,
  unit-testable as a pure string function.
- [x] `desktop/test/transcript-enhance.test.js` -- cover `stampHeaderLine`:
  insert, replace on re-enhance, empty header, CRLF header -- the only new branches.
- [x] `desktop/main.js` -- keep the session model on `live`; write `Model: <id>` in
  both writers; stamp `Enhanced: <ISO>` in the Enhance runner without changing its
  `changed` verdict; parse both lines in `parseTranscriptHeaderMain` -- one file
  holds every writer and the only reader.
- [x] `desktop/renderer/app.js` -- carry `model`/`enhancedAt` into the Meeting
  shim, derive label + tier, render both chips, and `loadLibrary()` on a terminal
  transcribe/enhance job -- a self-suppressed write must still reach the UI.
- [x] `desktop/renderer/style.css` -- style the `enhance` chip and the model chip's
  strong/light tiers, following the existing chip rules.

**Acceptance Criteria:**
- Given a header with no `Model:` line, when the library loads, then the card shows
  no model chip and nothing errors.
- Given Enhance finishes on a transcript not open in the editor, when its job goes
  terminal, then the enhance chip turns present with no manual refresh.
- Given a transcribed and enhanced transcript, when it is opened in the editor,
  then the visible header carries both lines and the body is unchanged.

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: all suites pass, new `stampHeaderLine`
  cases included.
- `cd desktop && node --check main.js && node --check renderer/app.js` -- expected:
  no syntax errors.

**Manual checks:**
- `npm start` from `desktop/`: transcribe a short recording — the card shows the
  right model chip and tier, and the enhance chip lights up on its own when the
  chained Enhance job finishes; the opened transcript carries both header lines.
- A transcript from before this change still lists, opens and summarizes, with no
  model chip and a dimmed enhance chip.

## Suggested Review Order

**Where provenance is written**

- The two lines this whole change exists to produce; record path is unconditional.
  [`main.js:3895`](../../desktop/main.js#L3895)

- Live records the session's own model — a re-transcribe later replaces the line.
  [`main.js:2953`](../../desktop/main.js#L2953)

- The judgement call: a cancelled or nothing-proofread run gets no stamp.
  [`main.js:2366`](../../desktop/main.js#L2366)

- Upsert with the header's blank separator line kept intact.
  [`transcript-enhance.js:441`](../../desktop/transcript-enhance.js#L441)

**Where it is read and shown**

- Reader gains two branches; `transcripts:list` already forwards the whole object.
  [`main.js:1754`](../../desktop/main.js#L1754)

- Raw id in, short label out — no second copy of the picker's table.
  [`app.js:1801`](../../desktop/renderer/app.js#L1801)

- Model chip renders only when known; enhance chip always, dimmed when absent.
  [`app.js:1464`](../../desktop/renderer/app.js#L1464)

- Provenance reaches the card unguessed: absent header line stays undefined.
  [`app.js:86`](../../desktop/renderer/app.js#L86)

**Why the list refreshes itself**

- Enhance's write silences the watcher, so the queue drives the reload.
  [`app.js:3714`](../../desktop/renderer/app.js#L3714)

**Peripherals**

- Stamp cases: insert, replace, empty header, CRLF, lossless round-trip.
  [`transcript-enhance.test.js:346`](../../desktop/test/transcript-enhance.test.js#L346)

- Text chip can outgrow a 260px sidebar where icons could not.
  [`style.css:1047`](../../desktop/renderer/style.css#L1047)
