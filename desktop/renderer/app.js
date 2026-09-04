/* ─────────────────────────────────────────────────────────────────────────────
 * Unlimeety Desktop — Renderer
 * ─────────────────────────────────────────────────────────────────────────── */

const api = window.transcriber;
// NOT `const queueApi` — contextBridge exposes `queueApi` as a non-configurable
// property on window, and a top-level lexical binding of the same name in a
// classic script is a SyntaxError that kills this entire file. Same reason
// `api` above is not called `transcriber`.
const jobsApi = window.queueApi;
// Same rule again: `recordApi` is a non-configurable window property, so the
// binding has to be named something else. The library reads recordings through
// it — every un-transcribed wav is a meeting card now.
const recApi = window.recordApi;

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  filePath: null,
  savedContent: "",
  baselineContent: "",
  isDirty: false,
};

// filePath → summary text (survives library re-renders)
const summaryStore = new Map();
// filePath → warning text from the last write. Kept next to the summary itself so
// the rail re-renders it; a banner poked into the DOM after the render is erased
// by the next one while the note on disk stays broken.
const summaryWarnings = new Map();

// ─── Meeting model ────────────────────────────────────────────────────────────
// A Meeting is the first-class entity used by the redesigned sidebar / editor /
// summary rail. It is derived from a transcript item returned by
// api.listTranscripts(). The renderer-only shim below extends each item with a
// status enum + artifact flags so the new UI can render uniformly. Fields the
// current IPC does not expose (summaryPath, recording/failed states) are left
// undefined until main.js is extended.
//
// Status derivation, given today's IPC surface:
//   outdated      — hasSummary === true but summaryOutdated === true (a later
//                   Enhance/Re-transcribe rewrote the transcript since)
//   summarized    — hasSummary === true and not outdated
//   transcribed   — a transcript file exists
//   audio_only    — a recording with no transcript yet (deriveMeetingFromRecording)
// `transcribing` is painted by buildMeetingCard off the job queue, not derived
// here: whether a run is in flight is queue state, not disk state. recording /
// failed still need IPC support and will appear once added.
//
// Fields that drive the sidebar's work-queue chips, never undefined — from
// transcripts:list for a transcript row, and pinned to false by
// deriveMeetingFromRecording for a recording, where their absence is a finding:
//   hasAudio        — re-transcribing is possible at all
//   model           — which model produced it; absent on older/pasted ones
//   enhancedAt      — Enhance has already run
//   enhanceAttemptedAt — Enhance ran but proofreading rejected every part
//                     (speaker naming may still have applied)
//   hasSummary      — a summary exists on disk
//   summaryOutdated — that summary predates a later Enhance/Re-transcribe
//   hasSpokenTurns  — the body holds turns Enhance would act on
//   readFailed      — the transcript could not be read, so every flag above is
//                     a fabricated default rather than a finding

let meetings = [];
let activeMeetingId = null;
let summaryRenderMode = "auto";       // 'auto' | 'structured' | 'markdown'
let contextMenu = null;               // { x, y, meetingId } | null
// No `transcribeRunning` / `summarizeRunning` sets: job state lives in the
// queue (jobsApi), and the cards read it through activeJobFor. The two Sets
// that used to sit here were declared, checked, and never added to.
function deriveStatus(m) {
  if (m.hasSummary) return m.summaryOutdated ? "outdated" : "summarized";
  if (m.hasTranscript) return "transcribed";
  return "audio_only";
}

// Without a filePath we have no stable id and the matching DOM selector would
// fall back to the empty string, which matches any card without the attribute.
// Skip such items entirely so they never enter `meetings[]`.
// ── meeting record (extracted verbatim by test/transcript-meta.test.js) ──
// Pure mapping from one `transcripts:list` row to the record the cards render
// from. Keep it free of the DOM so the test can pin the key names against what
// main.js actually emits — a renamed field here fails silently otherwise.
function deriveMeetingFromTranscript(item) {
  if (!item || !item.filePath) return null;
  const rawDate = item.createdAt || item.generated || item.mtime;
  const date = rawDate ? new Date(rawDate) : new Date();
  const hasTranscript = Boolean(item.filePath);
  const hasSummary = Boolean(item.hasSummary);
  const summaryOutdated = Boolean(item.summaryOutdated);
  const m = {
    id: item.filePath,
    // Display the title from the on-disk filename (stem) rather than the
    // internal "Meeting:" header, so renaming the .txt in Finder is reflected
    // in the UI. In-app renames keep both in sync. Matches how recordings show
    // their filename. Falls back to the header only if the name is somehow empty.
    title: stripMeetPrefix((item.filename || "").replace(/\.txt$/i, "") || item.title || ""),
    project: undefined,
    date: isNaN(date.getTime()) ? new Date() : date,
    durationSec: undefined,
    audioPath: item.audioPath || undefined,
    transcriptPath: item.filePath,
    summaryPath: undefined,
    participants: Array.isArray(item.participants) ? item.participants : [],
    hasAudio: Boolean(item.hasAudio),
    hasTranscript,
    hasSummary,
    summaryOutdated,
    language: item.language,
    // Provenance, straight from the transcript header. Undefined on transcripts
    // written before those lines existed and on pasted ones — the card renders
    // that as unknown rather than assuming anything.
    model: item.model || undefined,
    enhancedAt: item.enhancedAt || undefined,
    enhanceAttemptedAt: item.enhanceAttemptedAt || undefined,
    // Whether the transcript holds anything Enhance would act on, decided in
    // main by the very predicate the Enhance job uses. False on an unreadable
    // transcript, so the "To enhance" filter leaves it out.
    hasSpokenTurns: Boolean(item.hasSpokenTurns),
    // The read itself failed: hasSummary / hasAudio / model above are the
    // fallback's fabricated defaults, so no queue may act on them.
    readFailed: Boolean(item.readFailed),
    // The header block verbatim, for the card's info panel. Not the typed
    // fields above: `parseTranscriptHeaderMain` only knows eight keys, and
    // older extension builds wrote `Started:`, which no whitelist covers.
    header: item.header || "",
    progress: undefined,
    failedReason: undefined,
  };
  m.status = deriveStatus(m);
  return m;
}
// Pure mapping from one `record:list` row to a meeting record. A recording that
// has not been transcribed has no `.txt` to open, so the wav path is its id —
// which is also what every `record:*` handler takes. Kept next to its transcript
// twin so the two field lists stay visibly in sync.
function deriveMeetingFromRecording(item) {
  if (!item || !item.filePath) return null;
  const rawDate = item.createdAt || item.mtime;
  const date = rawDate ? new Date(rawDate) : new Date();
  const m = {
    id: item.filePath,
    // The on-disk stem verbatim — NOT through stripMeetPrefix like the
    // transcript twin. This title is what the rename popup pre-fills, and
    // `record:rename` writes the submitted text straight to the filename: a
    // stripped prefix would silently rename the wav and break its pairing.
    title: (item.filename || "").replace(/\.wav$/i, ""),
    project: undefined,
    date: isNaN(date.getTime()) ? new Date() : date,
    durationSec: undefined,
    // record:list knows the byte size but not the duration — the card shows it
    // so an audio-only row is not left with nothing but a timestamp.
    sizeBytes: Number(item.size) || 0,
    audioPath: item.filePath,
    transcriptPath: null,
    summaryPath: undefined,
    participants: [],
    hasAudio: true,
    // The three flags every work queue reads. False here is a finding, not a
    // default: there is no transcript, so there is nothing to enhance,
    // summarize or re-transcribe from.
    hasTranscript: false,
    hasSummary: false,
    summaryOutdated: false,
    hasSpokenTurns: false,
    language: undefined,
    model: undefined,
    enhancedAt: undefined,
    enhanceAttemptedAt: undefined,
    readFailed: false,
    header: "",
    progress: undefined,
    failedReason: undefined,
  };
  m.status = deriveStatus(m);
  return m;
}

// The union the library renders: every transcript, plus every recording that
// does not have one. Pure, so the dedup rule below is testable without IPC.
function mergeMeetings(transcriptRows, recordingRows) {
  const fromTranscripts = (transcriptRows || []).map(deriveMeetingFromTranscript).filter(Boolean);
  // A legacy recording is "<base>-YYYYMMDD-HHMMSS.wav" while its transcript is
  // "<base>.txt", so `record:list` reports hasTranscript false for a wav that
  // `transcripts:list` already claims as its audio. Without this check that
  // recording gets a second, transcript-less card.
  const claimed = new Set(fromTranscripts.map((m) => m.audioPath).filter(Boolean));
  const fromRecordings = (recordingRows || [])
    .filter((r) => r && !r.hasTranscript && !claimed.has(r.filePath))
    .map(deriveMeetingFromRecording)
    .filter(Boolean);
  // No global sort: groupMeetingsByDate already orders every bucket by newest.
  return [...fromTranscripts, ...fromRecordings];
}
// ── end meeting record ──

function getMeetingById(id) {
  return meetings.find((m) => m.id === id) || null;
}

const PROMPTS = [
  {
    id: "meeting",
    name: "Meeting",
    text: `Summarize this meeting transcript in Obsidian note format.

Output ONLY the following structure — no extra text before or after:

---
categories:
  - "[[Meetings]]"
type:
  - <choose one: 1-1 | retro | Job Interviews | daily | project | regular sync | public talk | informal conversation | negotiations | work_system — based on meeting content>
date: <YYYY-MM-DD from the transcript header, or today if missing>
org:
  - <organization explicitly mentioned in the transcript — one line per org; omit all org lines if none are mentioned>
people:
  - <participant 1>
  - <participant 2>
topics:
---

## Speaker Mapping

- Alpha → <Real Name> (<brief evidence, e.g. "introduced as …" or "called by name at 00:02">) (skip this entire section if no real names can be reliably inferred)

## Summary

<2-4 sentence overview of the meeting>

## Topics

- <topic 1>
- <topic 2>

## Decisions

- <decision 1> (skip this section if none)

## Action Items

- [ ] **<owner>** — <task> — *<deadline>* (format: write "- [ ] **Owner** — task" when an owner is identifiable; append " — *<deadline>*" only if a due date/time was explicitly mentioned, kept short and as said, e.g. *Thu* / *Jun 30* / *by Friday*; if no owner is identifiable, write a plain "- task" line instead; never invent owners or deadlines; skip this section if none)

## Notes

<any important context, open questions, or notable moments (skip this section if none)>

Rules:
- Extract date and participants from the transcript header and content.
- List the main topics discussed under the ## Topics section in the body.
- The topics field in the frontmatter properties must always be left blank (no values).
- type must be exactly one of: 1-1, retro, Job Interviews, daily, project, regular sync, public talk, informal conversation, negotiations, work_system.
- org: list only organizations explicitly named in the transcript; leave the field with no values if none are mentioned.
- Keep bullet points short and factual.
- Do not invent information not present in the transcript.
- Speaker mapping: scan the transcript for clues that reveal the real identity behind pseudonyms (Alpha, Beta, Gamma, …) — introductions, being addressed by name, self-identification, meeting headers, etc. If at least one pseudonym can be resolved, fill the ## Speaker Mapping section listing each resolvable speaker as "- Pseudonym → Real Name (brief evidence)". Omit any pseudonym whose identity cannot be determined. Skip the entire section if no names can be inferred.
- Throughout the summary (all sections and bullet points), refer to identified speakers as "Pseudonym (Real Name)" — e.g. "Alpha (John)". Unresolved pseudonyms stay as-is.
- Language: write the entire summary (all sections and bullet points) in Russian if the transcript is in Russian or mixed; in English only if the transcript is entirely in English.`,
  },
  {
    id: "daily",
    name: "Daily",
    text: `Summarize this meeting transcript in Obsidian note format.

Output ONLY the following structure — no extra text before or after:

---
categories:
  - "[[Meetings]]"
type:
  - daily
date: <YYYY-MM-DD from the transcript header, or today if missing>
org:
  - <organization explicitly mentioned in the transcript — one line per org; omit all org lines if none are mentioned>
people:
  - <participant 1>
  - <participant 2>
topics:
---

## Speaker Mapping

- Alpha → <Real Name> (<brief evidence>) (skip this entire section if no real names can be reliably inferred)

## Summary

<2-4 sentence overview of the sync>

## Participants

### <Pseudonym (Real Name) or just name if known>
- **Done:** <what they completed since last sync>
- **Plans:** <what they're working on next>
- **Blockers:** <problems encountered> (omit if none)
- **Needs help:** <where they need assistance> (omit if none)

### <Person 2>
...

## Topics

- <topic 1>
- <topic 2>

## Decisions

- <decision 1> (skip this section if none)

## Action Items

- [ ] **<owner>** — <task> — *<deadline>* (format: write "- [ ] **Owner** — task" when an owner is identifiable; append " — *<deadline>*" only if a due date/time was explicitly mentioned, kept short and as said, e.g. *Thu* / *Jun 30* / *by Friday*; if no owner is identifiable, write a plain "- task" line instead; never invent owners or deadlines; skip this section if none)

## Notes

<any important context, open questions, or notable moments (skip this section if none)>

Rules:
- Extract date and participants from the transcript header and content.
- List the main topics discussed under the ## Topics section in the body.
- The topics field in the frontmatter properties must always be left blank (no values).
- type is always: daily.
- org: list only organizations explicitly named in the transcript; leave the field with no values if none are mentioned.
- In ## Participants, include every person who spoke; keep each bullet tight (1 sentence max).
- Omit "Blockers" and "Needs help" lines for a person if nothing was mentioned.
- Keep all other bullet points short and factual.
- Do not invent information not present in the transcript.
- Speaker mapping: scan the transcript for clues that reveal the real identity behind pseudonyms (Alpha, Beta, Gamma, …) — introductions, being addressed by name, self-identification, meeting headers, etc. If at least one pseudonym can be resolved, fill the ## Speaker Mapping section listing each resolvable speaker as "- Pseudonym → Real Name (brief evidence)". Omit any pseudonym whose identity cannot be determined. Skip the entire section if no names can be inferred.
- Throughout the summary (all sections and bullet points), refer to identified speakers as "Pseudonym (Real Name)" — e.g. "Alpha (John)". In ## Participants, use "Pseudonym (Real Name)" as the ### sub-heading. Unresolved pseudonyms stay as-is.
- Language: write the entire summary in Russian if the transcript is in Russian or mixed; in English only if the transcript is entirely in English.`,
  },
  {
    id: "interview",
    name: "Interview",
    text: `Summarize this job interview transcript in Obsidian note format.

You are assessing the candidate against a scale-up bar: we want people who are SMART, GET THINGS DONE, have a PROBLEM-SOLVING MINDSET, and a strong TRACK RECORD OF ACHIEVEMENTS (Joel Spolsky's "Guerrilla Guide to Interviewing" + QuantumLight's scale-up-ready profile).

Output ONLY the following structure — no extra text before or after:

---
categories:
  - "[[Meetings]]"
type:
  - Job Interviews
date: <YYYY-MM-DD from the transcript header, or today if missing>
org:
  - <organization explicitly mentioned in the transcript — one line per org; omit all org lines if none are mentioned>
people:
  - <candidate full name>
  - <interviewer 1>
  - <interviewer 2>
candidate: <candidate full name if known, else leave empty>
role: <role being interviewed for, if stated>
recommendation: <Strong hire | Hire | Lean no | No hire | Insufficient signal>
topics:
---

## Speaker Mapping

- Alpha → <Real Name> (<brief evidence>) (skip this entire section if no real names can be reliably inferred)

## TL;DR

<3-5 sentences: overall impression, hire / no-hire lean, the single most important signal (positive or negative).>

## Scorecard

| Criterion | Rating | Evidence |
|---|---|---|
| Smart (raw intelligence, learns fast, thinks in systems) | <Strong / Mixed / Weak / Not assessed> | <1-2 concrete moments from the transcript> |
| Gets things done (ships, owns outcomes, pushes through friction) | <Strong / Mixed / Weak / Not assessed> | <1-2 concrete moments> |
| Problem-solving mindset (breaks down problems, asks for data, digs for root cause, considers trade-offs) | <Strong / Mixed / Weak / Not assessed> | <1-2 concrete moments> |
| Track record of achievements (measurable impact, promotions, led projects, awards, retention signals) | <Strong / Mixed / Weak / Not assessed> | <1-2 concrete moments> |

## Topics

- <topic 1>
- <topic 2>

## Strong answers

- <answer / moment> — <why it's strong: specificity, ownership, measurable outcome, self-awareness, structured thinking, etc.>
- <...>

## Weak / concerning answers

- <answer / moment> — <why it's concerning: vague, rehearsed, surface-level, blame-shifting, no data, jumped to solution without exploring the problem, lack of ownership, etc.>
- <...>

## Hardest problem solved

<Describe the toughest problem the candidate claims to have solved, based on the transcript. Include: the problem itself, their role, what they actually did, the outcome, and how credible / impressive it sounds on the scale-up bar. If nothing substantial surfaced, say so explicitly and note what that implies.>

## Motivation

- **Why this role / company:** <what drives them toward this opportunity, in their own words if possible>
- **Why leaving / left previous role:** <push factors; did the previous company try to retain them?>
- **What energises them:** <kinds of problems, environments, or outcomes they light up about>

## Candidate preferences

<Preferences revealed during the conversation — not just stated, but demonstrated. E.g. autonomy vs structure, IC vs management, product vs platform, remote vs in-office, startup vs large org, team size, tooling. One bullet per preference with a short evidence phrase.>

- <preference> — <evidence>

## Strengths

- <strength> — <evidence>

## Weaknesses / risks

- <weakness or risk> — <evidence; note if they showed self-awareness and a concrete example of improvement, which is itself a positive signal>

## Red flags

- <anything worth flagging: inconsistencies, evasiveness on specifics, inability to quantify impact, no effort by previous employers to retain, missing ownership, cultural misalignment> (skip this section if none)

## Open questions for follow-up

- <specific question the next interviewer should press on, with the reason>

## Recommendation

<Strong hire / Hire / Lean no / No hire / Insufficient signal> — <one short paragraph justifying the call against the four criteria above.>

Rules:
- Extract date, candidate, interviewers, and role from the transcript header and content.
- List the main topics discussed under the ## Topics section in the body.
- The topics field in the frontmatter properties must always be left blank (no values).
- type is always: Job Interviews.
- org: list only organizations explicitly named in the transcript; leave the field with no values if none are mentioned.
- In people, list the candidate first, then interviewers.
- The frontmatter recommendation field must match the final ## Recommendation verdict.
- Be specific and evidence-based. A strong candidate doesn't just "led a project" — they improved a process by 30%, won internal buy-in, scaled the solution across teams. Demand that level of specificity when rating.
- Distinguish between what the candidate claims and what they actually demonstrated in the conversation.
- Reward: structured problem breakdown, proactive data requests, digging into root causes, trade-off awareness, measurable outcomes, fast pace, ownership, honest self-awareness.
- Penalise: surface-level solutions, jumping to suggestions without exploring the problem, vague or rehearsed answers, lack of quantified impact, lack of ownership, no signs the previous company tried to retain them.
- Quote the candidate's own words in short inline quotes when citing evidence.
- If the transcript is too short or not actually an interview, say so in the TL;DR and fill only what you can.
- Do not invent information not present in the transcript.
- Speaker mapping: scan the transcript for clues that reveal the real identity behind pseudonyms (Alpha, Beta, Gamma, …) — introductions, being addressed by name, self-identification, meeting headers, etc. If at least one pseudonym can be resolved, fill the ## Speaker Mapping section listing each resolvable speaker as "- Pseudonym → Real Name (brief evidence)". Omit any pseudonym whose identity cannot be determined. Skip the entire section if no names can be inferred. Use the inferred candidate name to populate the frontmatter candidate: and people: fields.
- Throughout the summary (all sections and bullet points), refer to identified speakers as "Pseudonym (Real Name)" — e.g. "Alpha (John)". Unresolved pseudonyms stay as-is.
- Language: write the entire summary (all sections and bullet points) in Russian if the transcript is in Russian or mixed; in English only if the transcript is entirely in English.`,
  },
  {
    id: "one-on-one",
    name: "1-1",
    text: `Summarize this 1-1 meeting transcript in Obsidian note format.

This is a one-on-one conversation (manager ↔ report or peers). Stay people-focused and candid: capture what each person raised, the feedback exchanged, career and well-being signals, and the agreements made.

Output ONLY the following structure — no extra text before or after:

---
categories:
  - "[[Meetings]]"
type:
  - 1-1
date: <YYYY-MM-DD from the transcript header, or today if missing>
org:
  - <organization explicitly mentioned in the transcript — one line per org; omit all org lines if none are mentioned>
people:
  - <participant 1>
  - <participant 2>
topics:
---

## Speaker Mapping

- Alpha → <Real Name> (<brief evidence>) (skip this entire section if no real names can be reliably inferred)

## Summary

<2-4 sentence overview of the conversation, including its overall tone>

## Discussion

- <topic raised> — <who raised it, if clear, and the gist>
- <topic 2>

## Feedback

- **Given:** <feedback one person gave another — to whom, about what> (omit this line if none)
- **Received:** <feedback the other returned> (omit this line if none)

## Career & growth

<aspirations, growth areas, development plans, promotion/role talk discussed (skip this section if none)>

## Mood / well-being

<how the person is doing — workload, motivation, frustrations, energy (skip this section if none)>

## Decisions

- <decision or agreement reached> (skip this section if none)

## For next 1-1

- <open thread / something to revisit next time> (skip this section if none)

## Action Items

- [ ] **<owner>** — <task> — *<deadline>* (format: write "- [ ] **Owner** — task" when an owner is identifiable; append " — *<deadline>*" only if a due date/time was explicitly mentioned, kept short and as said, e.g. *Thu* / *Jun 30* / *by Friday*; if no owner is identifiable, write a plain "- task" line instead; never invent owners or deadlines; skip this section if none)

## Notes

<any important context, open questions, or notable moments (skip this section if none)>

Rules:
- Extract date and participants from the transcript header and content.
- The topics field in the frontmatter properties must always be left blank (no values).
- type is always: 1-1.
- org: list only organizations explicitly named in the transcript; leave the field with no values if none are mentioned.
- Preserve candor — attribute feedback to whoever gave it; do not soften concerns.
- Keep bullet points short and factual.
- Do not invent information not present in the transcript.
- Speaker mapping: scan the transcript for clues that reveal the real identity behind pseudonyms (Alpha, Beta, Gamma, …) — introductions, being addressed by name, self-identification, meeting headers, etc. If at least one pseudonym can be resolved, fill the ## Speaker Mapping section listing each resolvable speaker as "- Pseudonym → Real Name (brief evidence)". Omit any pseudonym whose identity cannot be determined. Skip the entire section if no names can be inferred.
- Throughout the summary (all sections and bullet points), refer to identified speakers as "Pseudonym (Real Name)" — e.g. "Alpha (John)". Unresolved pseudonyms stay as-is.
- Language: write the entire summary (all sections and bullet points) in Russian if the transcript is in Russian or mixed; in English only if the transcript is entirely in English.`,
  },
  {
    id: "retro",
    name: "Retro",
    text: `Summarize this retrospective transcript in Obsidian note format.

This is a team retrospective. Organise observations honestly into what worked, what didn't, the root causes behind the pain points, and concrete improvements to try next cycle — don't soften real problems.

Output ONLY the following structure — no extra text before or after:

---
categories:
  - "[[Meetings]]"
type:
  - retro
date: <YYYY-MM-DD from the transcript header, or today if missing>
org:
  - <organization explicitly mentioned in the transcript — one line per org; omit all org lines if none are mentioned>
people:
  - <participant 1>
  - <participant 2>
topics:
---

## Speaker Mapping

- Alpha → <Real Name> (<brief evidence>) (skip this entire section if no real names can be reliably inferred)

## Summary

<2-4 sentence overview of the retrospective and the team's overall sentiment>

## What went well

- <positive 1>
- <positive 2>

## What didn't go well

- <pain point 1>
- <pain point 2>

## Root causes

- <pain point> → <underlying cause discussed> (skip this section if none surfaced)

## Decisions

- <decision reached during the retro> (skip this section if none)

## Experiments to try

- <concrete change or experiment to run next cycle> — <expected effect, if stated>

## Action Items

- [ ] **<owner>** — <task> — *<deadline>* (format: write "- [ ] **Owner** — task" when an owner is identifiable; append " — *<deadline>*" only if a due date/time was explicitly mentioned, kept short and as said, e.g. *Thu* / *Jun 30* / *by Friday*; if no owner is identifiable, write a plain "- task" line instead; never invent owners or deadlines; skip this section if none)

## Notes

<any important context, open questions, or notable moments (skip this section if none)>

Rules:
- Extract date and participants from the transcript header and content.
- The topics field in the frontmatter properties must always be left blank (no values).
- type is always: retro.
- org: list only organizations explicitly named in the transcript; leave the field with no values if none are mentioned.
- Distinguish "Experiments to try" (process changes for next time) from concrete "Action Items" (assignable tasks).
- Keep bullet points short and factual.
- Do not invent information not present in the transcript.
- Speaker mapping: scan the transcript for clues that reveal the real identity behind pseudonyms (Alpha, Beta, Gamma, …) — introductions, being addressed by name, self-identification, meeting headers, etc. If at least one pseudonym can be resolved, fill the ## Speaker Mapping section listing each resolvable speaker as "- Pseudonym → Real Name (brief evidence)". Omit any pseudonym whose identity cannot be determined. Skip the entire section if no names can be inferred.
- Throughout the summary (all sections and bullet points), refer to identified speakers as "Pseudonym (Real Name)" — e.g. "Alpha (John)". Unresolved pseudonyms stay as-is.
- Language: write the entire summary (all sections and bullet points) in Russian if the transcript is in Russian or mixed; in English only if the transcript is entirely in English.`,
  },
  {
    id: "project",
    name: "Project",
    text: `Summarize this project / status meeting transcript in Obsidian note format.

This is a project status discussion. Capture where the project stands against plan, what moved forward, and the risks, blockers, and dependencies that need attention.

Output ONLY the following structure — no extra text before or after:

---
categories:
  - "[[Meetings]]"
type:
  - project
date: <YYYY-MM-DD from the transcript header, or today if missing>
org:
  - <organization explicitly mentioned in the transcript — one line per org; omit all org lines if none are mentioned>
people:
  - <participant 1>
  - <participant 2>
topics:
---

## Speaker Mapping

- Alpha → <Real Name> (<brief evidence>) (skip this entire section if no real names can be reliably inferred)

## Summary

<2-4 sentence overview of the project's state and the meeting's focus>

## Status

<overall state vs plan: on track / at risk / blocked — one line on why>

## Progress

- <what was completed or moved forward since the last sync>
- <progress item 2>

## Risks

- <risk> — <likelihood / impact or mitigation, if discussed>

## Blockers & dependencies

- <blocker or external dependency> — <who/what it waits on> (skip this section if none)

## Scope changes

- <added / removed / changed scope> (skip this section if none)

## Milestones & timeline

- <upcoming milestone> — *<date as mentioned>*

## Decisions

- <decision reached> (skip this section if none)

## Action Items

- [ ] **<owner>** — <task> — *<deadline>* (format: write "- [ ] **Owner** — task" when an owner is identifiable; append " — *<deadline>*" only if a due date/time was explicitly mentioned, kept short and as said, e.g. *Thu* / *Jun 30* / *by Friday*; if no owner is identifiable, write a plain "- task" line instead; never invent owners or deadlines; skip this section if none)

## Notes

<any important context, open questions, or notable moments (skip this section if none)>

Rules:
- Extract date and participants from the transcript header and content.
- The topics field in the frontmatter properties must always be left blank (no values).
- type is always: project.
- org: list only organizations explicitly named in the transcript; leave the field with no values if none are mentioned.
- In ## Status, prefer one of: on track / at risk / blocked, followed by a short reason.
- Keep bullet points short and factual.
- Do not invent information not present in the transcript.
- Speaker mapping: scan the transcript for clues that reveal the real identity behind pseudonyms (Alpha, Beta, Gamma, …) — introductions, being addressed by name, self-identification, meeting headers, etc. If at least one pseudonym can be resolved, fill the ## Speaker Mapping section listing each resolvable speaker as "- Pseudonym → Real Name (brief evidence)". Omit any pseudonym whose identity cannot be determined. Skip the entire section if no names can be inferred.
- Throughout the summary (all sections and bullet points), refer to identified speakers as "Pseudonym (Real Name)" — e.g. "Alpha (John)". Unresolved pseudonyms stay as-is.
- Language: write the entire summary (all sections and bullet points) in Russian if the transcript is in Russian or mixed; in English only if the transcript is entirely in English.`,
  },
  {
    id: "negotiations",
    name: "Negotiations",
    text: `Summarize this negotiation transcript in Obsidian note format.

This is a negotiation. Stay neutral and factual: capture each side's positions, what was asked and offered, where parties moved, what was agreed, and what remains open. Attribute positions to the side that holds them — do not take a side.

Output ONLY the following structure — no extra text before or after:

---
categories:
  - "[[Meetings]]"
type:
  - negotiations
date: <YYYY-MM-DD from the transcript header, or today if missing>
org:
  - <organization explicitly mentioned in the transcript — one line per org; omit all org lines if none are mentioned>
people:
  - <participant 1>
  - <participant 2>
topics:
---

## Speaker Mapping

- Alpha → <Real Name> (<brief evidence>) (skip this entire section if no real names can be reliably inferred)

## Summary

<2-4 sentence overview of the negotiation and where it landed>

## Parties & positions

- **<party / side>:** <their stance and underlying interests>
- **<other party>:** <their stance and underlying interests>

## Asks & offers

- <who> asked / offered <what>
- <who> asked / offered <what>

## Concessions / movement

- <where a party moved from its initial position> (skip this section if none)

## Agreed terms

- <term that was settled>

## Open / unresolved points

- <point still needing resolution> — <why / what's blocking agreement>

## Leverage & BATNA notes

- <leverage point, alternative, or walk-away signal observed> (skip this section if none)

## Decisions

- <decision reached> (skip this section if none)

## Action Items

- [ ] **<owner>** — <task> — *<deadline>* (format: write "- [ ] **Owner** — task" when an owner is identifiable; append " — *<deadline>*" only if a due date/time was explicitly mentioned, kept short and as said, e.g. *Thu* / *Jun 30* / *by Friday*; if no owner is identifiable, write a plain "- task" line instead; never invent owners or deadlines; skip this section if none)

## Notes

<any important context, open questions, or notable moments (skip this section if none)>

Rules:
- Extract date and participants from the transcript header and content.
- The topics field in the frontmatter properties must always be left blank (no values).
- type is always: negotiations.
- org: list only organizations explicitly named in the transcript; leave the field with no values if none are mentioned.
- Stay neutral — attribute every position to the party that holds it; never editorialise or pick a winner.
- Keep bullet points short and factual.
- Do not invent information not present in the transcript.
- Speaker mapping: scan the transcript for clues that reveal the real identity behind pseudonyms (Alpha, Beta, Gamma, …) — introductions, being addressed by name, self-identification, meeting headers, etc. If at least one pseudonym can be resolved, fill the ## Speaker Mapping section listing each resolvable speaker as "- Pseudonym → Real Name (brief evidence)". Omit any pseudonym whose identity cannot be determined. Skip the entire section if no names can be inferred.
- Throughout the summary (all sections and bullet points), refer to identified speakers as "Pseudonym (Real Name)" — e.g. "Alpha (John)". Unresolved pseudonyms stay as-is.
- Language: write the entire summary (all sections and bullet points) in Russian if the transcript is in Russian or mixed; in English only if the transcript is entirely in English.`,
  },
];

const DEFAULT_PROMPT = PROMPTS[0].text;

let customPrompts = []; // loaded from disk on init
let selectedCustomPromptId = null; // null = built-in or ephemeral custom

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const editor = document.getElementById("editor");
const emptyState = document.getElementById("empty-state");
const dropOverlay = document.getElementById("drop-overlay");
const btnOpen = document.getElementById("btn-open");
const btnOpenEmpty = document.getElementById("btn-open-empty");
const btnSave = document.getElementById("btn-save");
const btnSaveAs = document.getElementById("btn-save-as");
const editorToolbar = document.getElementById("editor-toolbar");
const btnLibrary = document.getElementById("btn-library");
const saveChip = document.getElementById("save-chip");

// Library DOM refs
const libraryPanel = document.getElementById("library-panel");
const libraryList = document.getElementById("library-list");
const libraryEmpty = document.getElementById("library-empty");
const libraryEmptyText = document.getElementById("library-empty-text");
const libraryCount = document.getElementById("library-count");
const librarySelection = document.getElementById("library-selection");
const librarySelectionLabel = document.getElementById("library-selection-label");
const librarySelectionAll = document.getElementById("library-selection-all");
const audioOnlyState = document.getElementById("audio-only-state");
const audioOnlyTitle = document.getElementById("audio-only-title");

// Audio player DOM refs
const audioPlayer    = document.getElementById("audio-player");
const audioEl        = document.getElementById("audio-el");
const apPlay         = document.getElementById("ap-play");
const apIconPlay     = document.getElementById("ap-icon-play");
const apIconPause    = document.getElementById("ap-icon-pause");
const apWaveform     = document.getElementById("ap-waveform");
const apTime         = document.getElementById("ap-time");
const apSpeed        = document.getElementById("ap-speed");
const transcriptView = document.getElementById("transcript-view");
const btnToggleView  = document.getElementById("btn-toggle-view");

// ─── Audio player ─────────────────────────────────────────────────────────────
// Bail out cleanly if any of the new player elements are missing from the DOM
// (e.g. running against an older index.html). The rest of the editor must keep
// working even without the player.
const PLAYER_OK = !!(audioPlayer && audioEl && apPlay && apIconPlay && apIconPause
  && apWaveform && apTime && apSpeed && transcriptView && btnToggleView);
if (!PLAYER_OK) console.warn("[player] audio player DOM not found, feature disabled");

const SPEEDS = [1, 1.5, 2, 0.75];
const WAVEFORM_BARS = 80;
let speedIdx = 0;
let waveformBars = [];        // current bar DOM nodes
let waveformPlayedIdx = -1;   // last index marked played, for cheap diff
let waveformToken = 0;        // race-protect decoder against rapid track switches

function fmtTime(sec) {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function renderWaveform(peaks) {
  apWaveform.innerHTML = "";
  waveformBars = [];
  for (const p of peaks) {
    const bar = document.createElement("div");
    bar.className = "ap-bar";
    // Map normalized peak (0..1) to a visible height (8%..100%).
    const h = Math.max(8, Math.round(p * 100));
    bar.style.height = `${h}%`;
    apWaveform.appendChild(bar);
    waveformBars.push(bar);
  }
  waveformPlayedIdx = -1;
}

function renderPlaceholderWaveform() {
  // While decoding, show flat-ish bars so the player doesn't look empty.
  const peaks = new Array(WAVEFORM_BARS).fill(0.25);
  renderWaveform(peaks);
}

function updateWaveformProgress(pct) {
  if (!waveformBars.length) return;
  const targetIdx = Math.floor(pct * waveformBars.length);
  if (targetIdx === waveformPlayedIdx) return;
  // Diff: only toggle bars whose state changed.
  if (targetIdx > waveformPlayedIdx) {
    for (let i = Math.max(0, waveformPlayedIdx + 1); i <= targetIdx && i < waveformBars.length; i++) {
      waveformBars[i].classList.add("played");
    }
  } else {
    for (let i = waveformPlayedIdx; i > targetIdx && i >= 0; i--) {
      waveformBars[i].classList.remove("played");
    }
  }
  waveformPlayedIdx = targetIdx;
}

async function buildWaveform(audioPath, numBars) {
  const buf = await fetch(`file://${encodeURI(audioPath)}`).then(r => r.arrayBuffer());
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audio = await ctx.decodeAudioData(buf);
    const data = audio.getChannelData(0);
    const bucket = Math.floor(data.length / numBars);
    const peaks = new Array(numBars);
    for (let i = 0; i < numBars; i++) {
      let max = 0;
      const start = i * bucket;
      const end = start + bucket;
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    const peak = Math.max(...peaks, 0.01);
    return peaks.map(p => p / peak);
  } finally {
    ctx.close();
  }
}

function playerUpdateTime() {
  const cur = audioEl.currentTime, dur = audioEl.duration;
  apTime.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  updateWaveformProgress(dur ? cur / dur : 0);
}

function playerSetPlaying(playing) {
  if (!PLAYER_OK) return;
  apIconPlay.classList.toggle("hidden", playing);
  apIconPause.classList.toggle("hidden", !playing);
}

async function playerShow(filePath) {
  if (!PLAYER_OK) return;
  playerShowPath(await api.getAudioPath(filePath));
}

// An audio-only meeting IS its wav — its id is the path — so there is no
// transcript to resolve the audio from and nothing to await.
function playerShowPath(audioPath) {
  if (!PLAYER_OK) return;
  if (!audioPath) { audioPlayer.classList.add("hidden"); return; }
  audioEl.src = `file://${encodeURI(audioPath)}`;
  audioEl.load();
  playerSetPlaying(false);
  renderPlaceholderWaveform();
  apTime.textContent = "0:00 / 0:00";
  audioPlayer.classList.remove("hidden");

  const myToken = ++waveformToken;
  buildWaveform(audioPath, WAVEFORM_BARS).then(peaks => {
    if (myToken !== waveformToken) return; // stale — another track loaded since
    renderWaveform(peaks);
  }).catch(err => {
    console.warn("[player] waveform decode failed:", err);
  });
}

function playerHide() {
  if (!PLAYER_OK) return;
  audioEl.pause();
  audioEl.src = "";
  playerSetPlaying(false);
  audioPlayer.classList.add("hidden");
  waveformToken++; // invalidate any in-flight decode
}

if (PLAYER_OK) {
  apPlay.addEventListener("click", () => {
    audioEl.paused ? audioEl.play() : audioEl.pause();
  });
  audioEl.addEventListener("play",  () => playerSetPlaying(true));
  audioEl.addEventListener("pause", () => playerSetPlaying(false));
  audioEl.addEventListener("ended", () => { playerSetPlaying(false); updateWaveformProgress(0); });
  audioEl.addEventListener("timeupdate", () => {
    playerUpdateTime();
    if (!transcriptView.classList.contains("hidden")) syncTranscriptToTime(audioEl.currentTime);
  });
  audioEl.addEventListener("loadedmetadata", playerUpdateTime);
  apWaveform.addEventListener("click", (e) => {
    const rect = apWaveform.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audioEl.currentTime = pct * (audioEl.duration || 0);
    updateWaveformProgress(pct);
  });
  apSpeed.addEventListener("click", () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    audioEl.playbackRate = SPEEDS[speedIdx];
    apSpeed.textContent = `${SPEEDS[speedIdx]}×`;
  });
}

// ─── Transcript view ──────────────────────────────────────────────────────────
let lastActiveSeg = null;
let userScrolledAt = 0;

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtTc(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function parseSegments(content) {
  const lines = content.split("\n");
  const segments = [];
  let cur = null;
  // A segment line opens with a bracketed timestamp: either an audio offset
  // "[m:ss]" or a wall-clock time from a text export, e.g. "[1:00:32 PM]".
  const re = /^\[(\d[^\]]*)\]\s*(.*)/;
  for (const line of lines) {
    const match = re.exec(line);
    if (match) {
      if (cur) segments.push(cur);
      const label = match[1].trim();
      const off = /^(\d+):(\d{2})$/.exec(label);
      const t = off ? parseInt(off[1]) * 60 + parseInt(off[2]) : null;
      const rest = match[2].trim();
      const isSpeaker = rest.endsWith(":");
      cur = { t, label, speaker: isSpeaker ? rest.slice(0, -1) : null, text: isSpeaker ? "" : rest };
    } else if (cur) {
      const text = line.trim();
      if (text) cur.text += (cur.text ? " " : "") + text;
    }
  }
  if (cur) segments.push(cur);
  return segments;
}

// Names listed on the transcript's "Participants:" header line (used as
// rename suggestions). Reads only the header block (up to the first blank line).
function headerParticipants(content) {
  for (const line of content.split("\n")) {
    if (line === "") break;
    if (line.startsWith("Participants: ")) {
      return line.slice("Participants: ".length)
        .split(",").map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

// Reserved pseudo-speaker written by the recording UIs for the user's own
// typed notes. Not a real participant: it must not be renameable, and no real
// speaker may be renamed onto it. Sourced from the shared notes module so this
// file and live.js can't drift — but not *depended* on: the Editor tab works
// with no notes UI at all, and a hard reference here would take the whole
// renderer down (this is module top level) if the script order ever changed.
const NOTE_LABEL = window.notesList?.NOTE_LABEL ?? "Note";

// Rename a speaker across the whole transcript: every "[mm:ss] <old>:" line
// becomes "[mm:ss] <new>:", and the Participants header token is swapped (then
// deduped case-insensitively). Matches speakers by string equality, not regex,
// so names with special characters are safe.
function renameSpeakerInText(content, oldName, newName) {
  const tcRe = /^(\[\d[^\]]*\]\s*)(.*)$/;
  const lines = content.split("\n");
  let inHeader = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inHeader) {
      if (line === "") { inHeader = false; continue; }
      if (line.startsWith("Participants: ")) {
        const mapped = line.slice("Participants: ".length)
          .split(",").map(s => s.trim())
          .map(n => (n === oldName ? newName : n)).filter(Boolean);
        const seen = new Set(); const out = [];
        for (const n of mapped) {
          const k = n.toLowerCase();
          if (!seen.has(k)) { seen.add(k); out.push(n); }
        }
        lines[i] = "Participants: " + out.join(", ");
      }
      continue;
    }
    const m = tcRe.exec(line);
    if (!m) continue;
    const rest = m[2];
    if (rest.endsWith(":") && rest.slice(0, -1).trim() === oldName) {
      lines[i] = m[1] + newName + ":";
    }
  }
  return lines.join("\n");
}

// ── transcript meta (extracted verbatim by test/transcript-meta.test.js) ──
// The header block above the first turn is reference data nobody reads twice,
// so view mode drops it entirely and the library card carries an info panel
// instead. This region stays free of the DOM and localStorage — `modelLabel`,
// `formatMeetingStamp` and `escHtml` resolve from the enclosing scope, which
// is what lets the test eval it with stubs for them. Keep the markers in
// place when editing.

// Only ISO values are ours to reformat. `Recorded-At` and `Enhanced` are ISO,
// but `Generated` is written with toLocaleString() (main.js and the extension's
// background.js), and new Date() either rejects that shape outright or
// mis-reparses a US-looking one into a different instant.
const META_ISO = /^\d{4}-\d{2}-\d{2}T/;

// Display labels for keys whose on-disk name is clumsier than it needs to be.
// The parsed key is untouched — this is presentation only.
const META_LABELS = { "Recorded-At": "Recorded" };

// Display form of one header value: raw ids and ISO stamps are what the file
// stores, the panel shows what the rest of the UI shows.
function metaValue(key, value) {
  if (key === "Model") return modelLabel(value);
  if (META_ISO.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return formatMeetingStamp(d);
  }
  return value;
}

// What view mode renders where the header block was. Normally just the
// interruption warning — the rest is one click away on the card. But a file
// opened from outside the transcripts folder (Open, drag-drop, deep link) has
// no card at all, so for those the rows stay inline rather than becoming
// reachable only by toggling to Edit.
function transcriptMetaHtml(header, { inlineRows = false } = {}) {
  const { rows, warn } = parseTranscriptMeta(header);
  const showRows = inlineRows && rows.length;
  if (!warn && !showRows) return "";
  return `<div class="tv-meta">`
    + (warn ? `<span class="tv-meta-warn">${escHtml(warn)}</span>` : "")
    + (showRows ? `<div class="tv-meta-rows">${meetingMetaPanelHtml(rows)}</div>` : "")
    + `</div>`;
}

// Header text → { rows: [{key, value}], warn }. Every line survives: one that
// is not "Key: value" becomes a keyless row rather than being dropped. No
// whitelist — `parseTranscriptHeaderMain` knows eight keys, but older extension
// builds wrote `Started:` and nothing should make a line invisible just because
// no one has typed its name into a table. `warn` is the interrupted-
// transcription notice, pulled out to be rendered inline in the transcript
// where a reader cannot miss it; it is the one line the card panel omits.
function parseTranscriptMeta(header) {
  const rows = [];
  let warn = "";
  for (const line of String(header || "").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    // Key chars only up to the colon, so free text ("draft notes: see below")
    // stays a keyless row instead of being mangled into a labelled one — and a
    // "//" value means the colon belonged to a URL scheme, not to a key.
    const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(text);
    if (!m || m[2].startsWith("//")) { rows.push({ key: "", value: text }); continue; }
    const value = m[2].trim();
    if (m[1] === "Status" && /^PARTIAL\b/.test(value)) { warn = value; continue; }
    rows.push({ key: m[1], value: metaValue(m[1], value) });
  }
  return { rows, warn };
}

// The card's panel rows. Read off the header the library IPC already carried —
// the render path has no file content and must not acquire one per card.
function meetingMetaRows(m) {
  return parseTranscriptMeta(m?.header).rows;
}

function meetingMetaPanelHtml(rows) {
  return rows.map((r) =>
    `<div class="meta-row">`
    + (r.key ? `<span class="meta-key">${escHtml(META_LABELS[r.key] || r.key)}</span>` : "")
    + `<span class="meta-val">${escHtml(r.value)}</span></div>`).join("");
}
// ── end transcript meta ──

function renderTranscriptView(content) {
  const firstTcMatch = /^\[\d[^\]]*\]/m.exec(content);
  let html = "";
  if (!firstTcMatch) {
    // No timecodes — render the whole text as one pre-wrap block so the user
    // can still read it. They can hit Edit to modify.
    if (content.trim()) html = `<div class="tv-plain">${escHtml(content)}</div>`;
  } else {
    const header = content.slice(0, firstTcMatch.index).trim();
    // A transcript in the library carries its header on its card; one opened
    // from elsewhere has no card, so it keeps the rows inline.
    if (header) {
      const carded = meetings.some((mm) => mm.id === state.filePath);
      html += transcriptMetaHtml(header, { inlineRows: !carded });
    }
    for (const seg of parseSegments(content)) {
      // "Note" is the reserved label the recording UIs write for the user's own
      // typed notes — it's not a speaker, so it gets a plain label instead of a
      // rename chip. Renaming it would rewrite every "] Note:" line and
      // permanently break summarize:run's gate on that marker.
      const speaker = seg.speaker
        ? (seg.speaker === NOTE_LABEL
            ? `<span class="tv-note">${escHtml(seg.speaker)}:</span> `
            : `<span class="tv-speaker">${escHtml(seg.speaker)}:</span> `)
        : "";
      // Audio segments carry a seekable offset; text-export segments only have
      // a wall-clock label (no audio to seek), so render them without data-t.
      const seekAttr = seg.t != null ? ` data-t="${seg.t}"` : "";
      const tc = seg.t != null ? fmtTc(seg.t) : seg.label;
      html += `<div class="tv-seg${seg.t != null ? "" : " tv-seg--noseek"}"${seekAttr}>` +
              `<span class="tv-time">${escHtml(tc)}</span>` +
              `<span class="tv-body">${speaker}${escHtml(seg.text)}</span>` +
              `</div>`;
    }
  }
  transcriptView.innerHTML = html;
}

function showTranscriptView() {
  if (!PLAYER_OK) return;
  editor.classList.add("hidden");
  transcriptView.classList.remove("hidden");
  btnSave.classList.remove("btn-edit-active");
  btnSaveAs.classList.remove("btn-edit-active");
  btnToggleView.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit`;
}

function showEditorTextarea() {
  if (!PLAYER_OK) return;
  transcriptView.classList.add("hidden");
  editor.classList.remove("hidden");
  editor.focus();
  btnSave.classList.add("btn-edit-active");
  btnSaveAs.classList.add("btn-edit-active");
  btnToggleView.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> View`;
}

function syncTranscriptToTime(t) {
  const segs = transcriptView.querySelectorAll(".tv-seg");
  let active = null;
  for (const seg of segs) {
    if (parseFloat(seg.dataset.t) <= t) active = seg;
    else break;
  }
  if (active === lastActiveSeg) return;
  if (lastActiveSeg) lastActiveSeg.classList.remove("tv-active");
  if (active) {
    active.classList.add("tv-active");
    if (Date.now() - userScrolledAt > 2000) {
      active.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
  lastActiveSeg = active;
}

if (PLAYER_OK) {
  transcriptView.addEventListener("scroll", () => { userScrolledAt = Date.now(); });

  transcriptView.addEventListener("click", (e) => {
    if (e.target.closest(".tv-speaker")) return; // chip handles its own click
    const seg = e.target.closest(".tv-seg");
    if (!seg || seg.dataset.t === undefined) return; // text-export segs have no seek target
    audioEl.currentTime = parseFloat(seg.dataset.t);
    userScrolledAt = 0;
    if (audioEl.paused) audioEl.play();
  });

  // Click a speaker chip to rename that speaker everywhere in the transcript.
  // Names are baked into the text (and the Participants header); suggestions
  // come from the file's own Participants line.
  transcriptView.addEventListener("click", (e) => {
    const chip = e.target.closest(".tv-speaker");
    if (!chip) return;
    const current = chip.textContent.replace(/:\s*$/, "").trim();
    const suggestions = headerParticipants(editor.value)
      .filter(n => n.toLowerCase() !== current.toLowerCase());
    window.speakerRename?.open({
      anchor: chip,
      current,
      suggestions,
      // Side-effect free: runs before anything is committed (see
      // speaker-rename.js). Renaming a speaker onto the reserved notes label
      // would turn their spoken turns into "[mm:ss] Note:" lines —
      // indistinguishable from the user's own notes, and fed to the summarizer
      // as such.
      validate: (name) => (name.trim() === NOTE_LABEL
        ? `"${NOTE_LABEL}" is reserved for your own typed notes`
        : null),
      onCommit: (name) => {
        if (!name || name === current) return;
        editor.value = renameSpeakerInText(editor.value, current, name);
        renderTranscriptView(editor.value);
        showTranscriptView();
        lastActiveSeg = null;
        setDirty(true);
        // Refresh the sidebar here, not on editor blur: renaming happens from
        // the transcript view, the textarea never has focus, and the rename
        // lands in the Participants: header the meeting cards render.
        autosave().then(() => loadLibrary());
      },
    });
  });

  btnToggleView.addEventListener("click", () => {
    if (editor.classList.contains("hidden")) {
      showEditorTextarea();
    } else {
      renderTranscriptView(editor.value);
      showTranscriptView();
      lastActiveSeg = null;
      if (!transcriptView.classList.contains("hidden")) syncTranscriptToTime(audioEl.currentTime);
    }
  });
}

// ─── Open file ────────────────────────────────────────────────────────────────
async function openFile() {
  const result = await api.openFile();
  if (!result) return;
  loadContent(result.filePath, result.content);
}

function loadContent(filePath, content) {
  // Drop a pending autosave for the note being replaced — its text is already
  // flushed by the callers below, and the timer would fire against the new file.
  clearTimeout(autosaveTimer);
  state.filePath = filePath;
  state.savedContent = content;
  state.baselineContent = content;
  // Through setDirty, not the flag directly: the chip has to be reset too, or a
  // "⚠ Save failed" from the previous note lingers over one that saves fine.
  setDirty(false);

  setActiveMeetingId(filePath);
  renderSummaryRail(filePath);

  editor.value = content;
  showEditor();

  // All meetings render through the transcript-view; Edit toggles to textarea.
  if (PLAYER_OK) {
    renderTranscriptView(content);
    showTranscriptView();
    lastActiveSeg = null;
  }

  // Audio player only when the meeting has an associated WAV.
  const m = getMeetingById(filePath);
  if (m?.hasAudio) playerShow(filePath);
  else playerHide();

  updateCancelBtn();
  // Covers navigating onto a file that already has an Enhance job running
  // (started elsewhere, or queued before this file was opened) — locks the
  // editor immediately rather than waiting for the user's first keystroke to
  // race the run.
  syncEditorReadOnly();
}

// Single source of truth for "which meeting is open".
// Keeps activeMeetingId and activeLibraryPath in sync and reflects the
// selection in the sidebar DOM without rebuilding the list.
function setActiveMeetingId(id) {
  activeMeetingId = id;
  activeLibraryPath = id;
  for (const el of libraryList.querySelectorAll(".meeting-card")) {
    el.classList.toggle("active", el.dataset.meetingId === id);
  }
}

// ─── Save ─────────────────────────────────────────────────────────────────────
// Resolves to whether the write itself succeeded. Callers about to replace the
// buffer must also check editor.value === state.savedContent: a keystroke that
// lands mid-write leaves a remainder this call did not cover.
async function saveFile() {
  if (!state.filePath) return saveAsFile();
  // Snapshot before the await: api.saveFile is an IPC round-trip and the
  // textarea keeps taking keystrokes during it. Marking editor.value saved
  // would strand whatever was typed in that window — the next autosave would
  // see value === savedContent and skip the write.
  const content = editor.value;
  // A rejected invoke (no handler, window torn down mid-flight) has to land on
  // the same path as a refused write, or the chip stays on "Saving…" and the
  // rejection escapes into whatever awaited us.
  let result;
  try {
    result = await api.saveFile(state.filePath, content);
  } catch (err) {
    result = { ok: false, error: err?.message || String(err) };
  }
  if (!result?.ok) {
    console.error("Save failed:", result?.error);
    setSaveChip("error");
    return false;
  }
  state.savedContent = content;
  if (editor.value === content) {
    setDirty(false);
    // Pulse the chip so an autosave the user did not trigger is still visible.
    saveChip.classList.remove("flash");
    void saveChip.offsetWidth; // restart CSS animation
    saveChip.classList.add("flash");
  } else {
    // Typed during the write — stay dirty and commit the remainder.
    setDirty(true);
    scheduleAutosave();
  }
  return true;
}

// Autosave: persist silently whenever there is something new on disk to write.
// Editing is save-by-default — speaker renames save immediately, free text
// saves a beat after the last keystroke and when focus leaves the editor.
let autosaveTimer = null;

async function autosave() {
  clearTimeout(autosaveTimer);
  if (!state.filePath || editor.value === state.savedContent) return true;
  return saveFile();
}

// Typing keeps rescheduling the write, so a pause of AUTOSAVE_DELAY_MS is what
// commits it. Without this, edits only reached disk on blur — the chip claimed
// "Saved" while the buffer was still unwritten, and a crash lost the text.
const AUTOSAVE_DELAY_MS = 1000;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosave, AUTOSAVE_DELAY_MS);
}

// Loading another note overwrites both editor.value and state.savedContent, so
// a write that failed (read-only file, full disk) would take the edits with it
// silently. Ask instead of discarding.
async function flushBeforeReplace() {
  let ok = await autosave();
  // A keystroke that landed during that write left a remainder, and the caller
  // is about to overwrite the buffer (and loadContent cancels the timer that
  // would have committed it) — so commit it here.
  if (ok && editor.value !== state.savedContent) ok = await autosave();
  if (ok && editor.value === state.savedContent) return true;
  return confirm(
    "This transcript could not be saved — the file on disk is still the " +
    "older version.\n\nOpen the other note anyway and lose the unsaved edits?"
  );
}

async function saveAsFile() {
  const content = editor.value;
  const result = await api.saveAsFile(content);
  if (result?.ok) {
    state.filePath = result.filePath;
    state.savedContent = content;
    // Save As establishes a fresh baseline — there is nothing earlier to revert to.
    state.baselineContent = content;
    setActiveMeetingId(result.filePath);
    if (editor.value === content) {
      setDirty(false);
    } else {
      // Typed while the dialog was up — same remainder case as in saveFile.
      setDirty(true);
      scheduleAutosave();
    }
    updateCancelBtn();
  }
  return !!result?.ok;
}

// Revert the transcript to its state when the file was opened this session and
// persist that revert. Undoes every edit made since open (renames + free text).
async function cancelChanges() {
  if (!state.filePath || editor.value === state.baselineContent) return;
  editor.value = state.baselineContent;
  if (PLAYER_OK) {
    renderTranscriptView(editor.value);
    showTranscriptView();
    lastActiveSeg = null;
  }
  await saveFile();
  updateCancelBtn();
}

// ─── Dirty tracking ───────────────────────────────────────────────────────────
function setDirty(dirty) {
  state.isDirty = dirty;
  api.setDirty(dirty);

  setSaveChip(dirty ? "pending" : "saved");
  updateCancelBtn();
}

// The only save indicator in the UI. "Saving…" covers the window between a
// keystroke and the autosave that follows it, so the chip never claims the text
// is on disk before it is.
function setSaveChip(status) {
  saveChip.textContent =
    status === "pending" ? "Saving…" :
    status === "error" ? "⚠ Save failed" :
    "✓ Saved";
  saveChip.classList.toggle("chip-error", status === "error");
  saveChip.classList.toggle("chip-pending", status === "pending");
}

// The former Save button is now "Cancel changes": enabled only while the text
// differs from the snapshot taken when the file was opened.
function updateCancelBtn() {
  btnSave.disabled = !state.filePath || editor.value === state.baselineContent;
}

// ─── Library panel ────────────────────────────────────────────────────────────
let libraryOpen = true;
let activeLibraryPath = null;

btnLibrary.addEventListener("click", () => {
  libraryOpen = !libraryOpen;
  libraryPanel.classList.toggle("open", libraryOpen);
  btnLibrary.classList.toggle("active", libraryOpen);
});

// What the library actually cares about in a recordings list: which files exist
// and whether each has a transcript. Deliberately not size or mtime — a wav
// being recorded into changes both several times a second.
function recordingsSignature(recs) {
  return (recs || []).map((r) => `${r?.filePath}|${r?.hasTranscript ? 1 : 0}`).join("\n");
}
let lastRecordingsSig = null;

async function loadLibrary(prefetchedRecs) {
  // Two sources, one list. `record:list` already returns every field a card
  // needs, so the union happens here rather than inside `transcripts:list` —
  // which would mean a second wav scan and a changed contract for its four
  // other callers.
  const [items, recs] = await Promise.all([
    api.listTranscripts(),
    // A failing recordings scan must cost the recordings, not the whole library.
    prefetchedRecs || (recApi ? recApi.list().catch(() => []) : []),
  ]);
  lastRecordingsSig = recordingsSignature(recs);
  meetings = mergeMeetings(items, recs);
  // Drop selections for recordings that left the disk, so the batch CTA never
  // counts a row nobody can see.
  const present = new Set(meetings.map((m) => m.id));
  for (const id of Array.from(selectedRecordings)) {
    if (!present.has(id)) selectedRecordings.delete(id);
  }
  // The recording on screen is gone from the list. Two very different reasons:
  // its transcription finished (a transcript row now claims that wav), or the
  // file left the disk. Nothing else notices either.
  if (audioOnlyState && !audioOnlyState.classList.contains("hidden")
      && !meetings.some((m) => m.id === activeMeetingId)) {
    const transcribed = meetings.find((m) => m.audioPath === activeMeetingId);
    if (transcribed) {
      // Exactly what the user asked for when they hit Transcribe — open it
      // rather than making them find it again in the list.
      api.openFromLibrary(transcribed.id);
    } else {
      audioOnlyState.classList.add("hidden");
      emptyState.classList.remove("hidden");
      if (PLAYER_OK) playerHide();
      activeMeetingId = null;
      activeLibraryPath = null;
    }
  }
  renderMeetings();
}

// ─── Chat state ───────────────────────────────────────────────────────────────
let chatHistory = [];  // { role: 'user'|'assistant', content: string }[]
// Where to read transcript content from when the user sends a chat message.
// Editor tab: { kind: 'file', filePath } — main reads the .txt from disk.
// Live tab:   { kind: 'live', getTranscript: () => string } — renderer snapshots
// the in-memory transcript on every send so newly-spoken text is included.
let chatTarget = null;

// ─── Sidebar: filter + search state ───────────────────────────────────────────
let activeFilter = "all";   // 'all' | 'transcribe' | 'retranscribe' | 'enhance' | 'summarize' (+ dormant 'audio')
// Meeting ids checked for the batch transcribe CTA. Only audio-only rows can be
// checked, so every id in here is a wav path — exactly what `record:*` takes.
const selectedRecordings = new Set();
let searchQuery = "";
let searchDebounceTimer = null;
let contentMatches = new Map(); // filePath -> snippet (from full-text content search)
let searchToken = 0;            // guards against out-of-order async search responses

// Worth re-transcribing means "not the most accurate model available", so this
// is deliberately NOT modelIsStrong(): that one is `/large/i`, which counts the
// app's own default `large-v3_turbo` as strong and would leave the queue empty
// for everyone who never hand-picked a smaller model — while turbo → large-v3 is
// the one upgrade users actually have. Kept separate because modelIsStrong also
// colours the provenance chip, and that must not change here.
function modelWorthRedoing(id) {
  // modelLabel() already strips the vendor prefix for the provenance chip; its
  // underscore-to-space pass does not change the comparison below.
  const variant = modelLabel(id).trim().toLowerCase();
  // Empty means unknown, not weak — absence of a model line is no evidence.
  // Everything that is not large-v3 proper is: turbo, medium, small, base, tiny.
  // WhisperKit also ships size-suffixed ids ("large-v3_947MB"); that IS the best
  // model, and re-transcribing would only reproduce the same id, so the queue
  // would never clear. Turbo keeps its own suffixed forms and stays in.
  return variant !== "" && !/^large-v3( \d+mb)?$/.test(variant);
}

// The chips answer "what is still waiting", not "what did I already do", so
// every branch below is a queue of work left to do on that meeting.
function meetingMatchesFilter(m, filter) {
  if (filter === "all") return true;
  if (filter === "audio") return m.hasAudio === true;
  // A queue never lists work whose action is known to fail. On a read failure
  // every flag the queues read is the fallback's fabricated default — the
  // summary and audio checks never even ran — so all three exclude the row. It
  // still shows under All, which is the branch above.
  if (m.readFailed === true) return false;
  // The one queue an audio-only row belongs to, and the only queue that is not
  // about improving a transcript that already exists.
  if (filter === "transcribe") return m.hasTranscript === false;
  // Weak model AND re-transcribable: the Re-transcribe menu item is gated on
  // hasAudio too, so without it the queue would list meetings you cannot act on.
  if (filter === "retranscribe") return m.hasAudio === true && modelWorthRedoing(m.model);
  // enhanceAttemptedAt: proofreading rejected every part on an earlier run —
  // a re-run hits the same rejection, so it must not sit in the queue forever.
  if (filter === "enhance") return !m.enhancedAt && !m.enhanceAttemptedAt && m.hasSpokenTurns === true;
  // The hasTranscript gate is what keeps un-transcribed recordings out: they
  // have no summary either, so `!m.hasSummary` alone would sweep every one of
  // them into a queue whose action they cannot run. A summary that predates a
  // later Enhance/Re-transcribe (summaryOutdated) belongs back in the queue
  // too — it exists on disk, but no longer reflects the current transcript.
  if (filter === "summarize") return m.hasTranscript === true && (!m.hasSummary || m.summaryOutdated === true);
  return true;
}

function meetingMatchesSearch(m, q) {
  if (!q) return true;
  const hay = [m.title, ...(m.participants || [])].join(" ").toLowerCase();
  return hay.includes(q) || contentMatches.has(m.id);
}

// Escape a content-search snippet and wrap query occurrences in <mark>,
// preserving the original casing of each match.
function highlightSnippet(snippet, q) {
  if (!q) return escapeHtml(snippet);
  const lower = snippet.toLowerCase();
  const ql = q.toLowerCase();
  let out = "", from = 0, idx;
  while ((idx = lower.indexOf(ql, from)) !== -1) {
    out += escapeHtml(snippet.slice(from, idx));
    out += `<mark>${escapeHtml(snippet.slice(idx, idx + ql.length))}</mark>`;
    from = idx + ql.length;
  }
  return out + escapeHtml(snippet.slice(from));
}

// What the placeholder says when nothing is visible. Read by renderMeetings only;
// the three queue lines are the "you are done" case, not the "nothing here" one.
const FILTER_EMPTY_TEXT = {
  all: "No meetings yet",
  transcribe: "Nothing to transcribe",
  retranscribe: "Nothing to re-transcribe",
  enhance: "Nothing to enhance",
  summarize: "Nothing to summarize",
};

function emptyStateText() {
  if (!meetings.length) return "No meetings yet";
  if (searchQuery) return "No matches";
  return FILTER_EMPTY_TEXT[activeFilter] || "No matches";
}

// Exactly one chip is the selected one. The class is paint; aria-pressed is what
// a screen reader reads, so both move together or the two disagree.
function markActiveChip(filter) {
  document.querySelectorAll(".filter-chip").forEach((c) => {
    const on = c.dataset.filter === filter;
    c.classList.toggle("active", on);
    c.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function computeFilterCounts(list) {
  const counts = { all: list.length, audio: 0, transcribe: 0, retranscribe: 0, enhance: 0, summarize: 0 };
  for (const m of list) {
    if (m.hasAudio) counts.audio++;
    if (meetingMatchesFilter(m, "transcribe")) counts.transcribe++;
    if (meetingMatchesFilter(m, "retranscribe")) counts.retranscribe++;
    if (meetingMatchesFilter(m, "enhance")) counts.enhance++;
    if (meetingMatchesFilter(m, "summarize")) counts.summarize++;
  }
  return counts;
}

function getMeetingTimestamp(m) {
  return m.date instanceof Date ? m.date.getTime() : Date.now();
}

function groupMeetingsByDate(list) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const lastWeekStart = todayStart - 7 * 24 * 60 * 60 * 1000;

  const today = [], yesterday = [], lastWeek = [], older = [];
  for (const m of list) {
    const ts = getMeetingTimestamp(m);
    if (ts >= todayStart) today.push(m);
    else if (ts >= yesterdayStart) yesterday.push(m);
    else if (ts >= lastWeekStart) lastWeek.push(m);
    else older.push(m);
  }
  // newest first within each group
  const byNewest = (a, b) => getMeetingTimestamp(b) - getMeetingTimestamp(a);
  return {
    today: today.sort(byNewest),
    yesterday: yesterday.sort(byNewest),
    lastWeek: lastWeek.sort(byNewest),
    older: older.sort(byNewest),
  };
}

function stripMeetPrefix(title) {
  return (
    title.replace(/^(?:Google[\s_\-]*Meet|GMeet|Meet)[\s_\-]+/i, "").trim() ||
    title
  );
}

// ─── Sidebar render ───────────────────────────────────────────────────────────
function renderMeetings() {
  // The panel is body-level and anchored to a card that is about to be
  // replaced: left open it floats with rows for a card that no longer exists,
  // and its overlay keeps swallowing clicks.
  closeMeetingMeta();

  // Clear list contents (keep the #library-empty placeholder).
  Array.from(libraryList.children).forEach((el) => {
    if (el.id !== "library-empty") el.remove();
  });

  // Always reflect total count in the header pill.
  libraryCount.textContent = meetings.length ? String(meetings.length) : "";

  // Update filter chip counts (off the unfiltered/unsearched meeting list).
  const counts = computeFilterCounts(meetings);
  for (const kind of ["all", "transcribe", "retranscribe", "enhance", "summarize"]) {
    const el = document.querySelector(`.filter-count[data-count="${kind}"]`);
    // `?? 0` so a kind/chip mismatch shows a wrong number rather than painting
    // the literal string "undefined" into the chip.
    if (el) el.textContent = String(counts[kind] ?? 0);
  }

  renderSelectionBar();

  // Apply filter + search. The open meeting stays pinned against the filter
  // (not the search box) — finishing Enhance on the meeting you are reading
  // should not make its card vanish out from under you mid-session.
  const visible = meetings.filter(
    (m) => meetingMatchesSearch(m, searchQuery)
      && (m.id === activeMeetingId || meetingMatchesFilter(m, activeFilter)),
  );

  if (!visible.length) {
    // "No meetings yet" is a lie over a full library whose active queue simply
    // ran dry — and an exhausted queue is the good outcome, not an empty app.
    libraryEmptyText.textContent = emptyStateText();
    libraryEmpty.classList.remove("hidden");
    return;
  }
  libraryEmpty.classList.add("hidden");

  const groups = groupMeetingsByDate(visible);
  const sections = [
    { label: "Today", list: groups.today },
    { label: "Yesterday", list: groups.yesterday },
    { label: "Last week", list: groups.lastWeek },
    { label: "Older", list: groups.older },
  ];

  for (const { label, list } of sections) {
    if (!list.length) continue;
    const header = document.createElement("div");
    header.className = "library-section";
    header.textContent = label;
    libraryList.appendChild(header);
    for (const m of list) libraryList.appendChild(buildMeetingCard(m));
  }
}

// ─── Batch selection ─────────────────────────────────────────────────────────
// The bar is the whole UI for the selection, so it hides at zero rather than
// sitting there saying "0 selected" above a library nobody is batching.
function renderSelectionBar() {
  if (!librarySelection) return;
  const n = selectedRecordings.size;
  librarySelection.classList.toggle("hidden", n === 0);
  if (librarySelectionLabel) {
    librarySelectionLabel.textContent = n === 1 ? "1 recording selected" : `${n} recordings selected`;
  }
  // Hidden once everything selectable on screen is already picked, so the link
  // never sits there doing nothing.
  const all = selectableVisible();
  librarySelectionAll?.classList.toggle("hidden", all.length === 0 || all.every((m) => selectedRecordings.has(m.id)));
}

// The rows a user could tick right now: transcript-less, and past both the
// active chip and the search box. Select all must not reach beyond what is on
// screen — the bar's count is the only feedback there is.
function selectableVisible() {
  return meetings.filter(
    (m) => m.hasTranscript === false
      && meetingMatchesFilter(m, activeFilter)
      && meetingMatchesSearch(m, searchQuery),
  );
}

// Hand the paths to the transcribe-settings screen — the same entry point
// the ⋯ menu's Transcribe… uses, and the same one the removed Record sidebar
// used for its batch CTA. N ≥ 1 is all one case there. enterTranscribeSettings
// itself makes sure the Transcripts tab is the one showing underneath.
function sendToTranscribeSettings(paths) {
  if (!paths.length) return;
  window.recordTab?.enterTranscribeSettings?.(paths);
}

document.getElementById("library-selection-transcribe")?.addEventListener("click", () => {
  const paths = Array.from(selectedRecordings);
  // Cleared before the hand-off, not after: the settings screen owns the batch
  // from here, and a selection left behind would re-send on the next click.
  selectedRecordings.clear();
  renderMeetings();
  sendToTranscribeSettings(paths);
});

document.getElementById("library-selection-delete")?.addEventListener("click", async () => {
  const paths = Array.from(selectedRecordings);
  if (!paths.length) return;
  if (!recApi) return;
  const result = await recApi.deleteMany(paths);
  // Cancelling the confirmation is not a failure and keeps the selection.
  if (result?.canceled) return;
  if (!result?.ok) {
    window.alert(`Couldn't delete the recordings: ${result?.error || "unknown error"}`);
  } else if (result.errors?.length) {
    // ok:true only means *something* was deleted. Reporting the whole batch as
    // gone would leave files on disk the user believes they removed.
    window.alert(`${result.errors.length} of ${paths.length} recordings could not be deleted: ${result.errors[0].error}`);
  }
  // Reload either way: a partial failure still removed some of them.
  selectedRecordings.clear();
  loadLibrary();
});

document.getElementById("library-selection-all")?.addEventListener("click", () => {
  for (const m of selectableVisible()) selectedRecordings.add(m.id);
  renderMeetings();
});

document.getElementById("library-selection-clear")?.addEventListener("click", () => {
  selectedRecordings.clear();
  renderMeetings();
});

function buildMeetingCard(m) {
  const isActive = m.id === activeMeetingId;
  // The transcribe lane keys its jobs on the wav path, which is exactly a
  // recording's id.
  const transcribing = m.hasTranscript === false && Boolean(activeJobFor("transcribe", m.id));
  // Only a recording without a transcript is batch-transcribable, so only those
  // rows get a checkbox — a library-wide multi-select with one applicable
  // action would just be a trap. One already in the transcribe lane is out too:
  // re-submitting it queues the same wav twice, and deleting it kills the run.
  const selectable = m.hasTranscript === false && !transcribing;
  const selected = selectable && selectedRecordings.has(m.id);
  const card = document.createElement("div");
  card.className = "meeting-card" + (isActive ? " active" : "");
  card.dataset.meetingId = m.id;
  // The status a card paints is not always the one derived from disk: a
  // transcribe job in flight is queue state, which deriveStatus cannot see.
  const status = transcribing ? "transcribing" : m.status;
  card.dataset.status = status;

  // Show a content-match snippet only when the query hit the body but not the
  // title/participants (otherwise the match is already obvious from the card).
  const snippet = contentMatches.get(m.id);
  const metaHay = [m.title, ...(m.participants || [])].join(" ").toLowerCase();
  const showSnippet = searchQuery && snippet && !metaHay.includes(searchQuery);
  // Only whether there is anything to show; the rows themselves are built when
  // the panel opens, so they cannot go stale in this closure after an Enhance.
  const hasMeta = Boolean(m.header && m.header.trim());

  card.innerHTML = `
    <span class="meeting-active-bar"></span>
    <div class="meeting-card-row1">
      ${selectable ? `<label class="meeting-pick"><input type="checkbox" ${selected ? "checked" : ""} aria-label="Select ${escapeHtml(m.title || "recording")} for batch transcription" /><span class="meeting-pick-box" aria-hidden="true"></span></label>` : ""}
      <span class="meeting-title">${escapeHtml(m.title || "Untitled")}</span>
      ${hasMeta ? `<button class="meeting-info" type="button" title="Transcript details" aria-expanded="false">${iconSvg("info", { size: 12 })}</button>` : ""}
      <button class="meeting-more" type="button" aria-label="More actions">${iconSvg("more", { size: 14 })}</button>
    </div>
    ${showSnippet ? `<div class="meeting-snippet">${highlightSnippet(snippet, searchQuery)}</div>` : ""}
    <div class="meeting-card-row2">
      <span class="meeting-time tnum">${escapeHtml(formatMeetingStamp(m.date))}</span>
      ${m.durationSec ? `<span class="dot">·</span><span class="meeting-duration tnum">${escapeHtml(formatMeetingDuration(m.durationSec))}</span>` : ""}
      ${!m.durationSec && m.sizeBytes ? `<span class="dot">·</span><span class="meeting-duration tnum">${escapeHtml(formatMeetingSize(m.sizeBytes))}</span>` : ""}
      ${m.participants?.length ? avatarStackHtml(m.participants, 3) : ""}
    </div>
    ${status === "transcribing" ? `
      <div class="meeting-progress">
        <div class="meeting-progress-bar" style="width: ${Math.round((m.progress || 0.4) * 100)}%"></div>
      </div>` : ""}
    <div class="meeting-card-row3">
      ${statusPillHtml(status)}
      <div class="artifact-chips">
        ${modelChipHtml(m)}
        <span class="artifact-chip" data-kind="audio" data-present="${m.hasAudio ? "true" : "false"}" title="Audio">${iconSvg("mic", { size: 11 })}</span>
        <span class="artifact-chip" data-kind="transcript" data-present="${m.hasTranscript ? "true" : "false"}" title="Transcript">${iconSvg("text", { size: 11 })}</span>
        <span class="artifact-chip" data-kind="enhance" data-present="${m.enhancedAt ? "true" : "false"}" title="${escapeHtml(enhancedChipTitle(m.enhancedAt))}">${iconSvg("check", { size: 11 })}</span>
        <span class="artifact-chip" data-kind="summary" data-present="${m.hasSummary ? "true" : "false"}" title="Summary">${iconSvg("sparkle", { size: 11 })}</span>
      </div>
    </div>
  `;

  card.addEventListener("click", () => handleMeetingClick(m));
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openMeetingMenu(e.clientX, e.clientY, m);
  });

  const moreBtn = card.querySelector(".meeting-more");
  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Anchor the menu just below the ⋯ button.
    const r = moreBtn.getBoundingClientRect();
    openMeetingMenu(r.right, r.bottom + 4, m);
  });

  // On the label, not the input: the input is visually replaced by the box span,
  // so the click the user makes never starts on the input. Stopping it only
  // there caught the label's synthetic forward, while the real click had already
  // bubbled to the card and opened the meeting.
  card.querySelector(".meeting-pick")?.addEventListener("click", (e) => {
    e.stopPropagation();
  });
  const pick = card.querySelector(".meeting-pick input");
  pick?.addEventListener("change", (e) => {
    if (e.target.checked) selectedRecordings.add(m.id);
    else selectedRecordings.delete(m.id);
    renderSelectionBar();
  });

  const metaBtn = card.querySelector(".meeting-info");
  metaBtn?.addEventListener("click", (e) => {
    // Without this the card's own handler opens the meeting underneath.
    e.stopPropagation();
    openMeetingMeta(metaBtn, meetingMetaRows(m));
  });

  return card;
}

// ─── Meeting info panel ──────────────────────────────────────────────────────
// A body-level popover rather than a panel inside the card: #library-list is
// `overflow-y: auto`, so anything anchored inside a card is clipped at the
// sidebar edge. Same shape as the ⋯ menu one row above — overlay for the
// outside click, coordinates clamped to the viewport.
function closeMeetingMeta() {
  const root = document.getElementById("meeting-meta-root");
  if (!root) return;
  root.remove();
  const btn = document.querySelector('.meeting-info[aria-expanded="true"]');
  if (btn) {
    btn.setAttribute("aria-expanded", "false");
    // Escape and outside-click both land here; without this, focus is left on
    // a removed subtree and tabbing restarts from the top of the document.
    if (document.activeElement === document.body) btn.focus();
  }
}

function openMeetingMeta(anchor, rows) {
  closeMeetingMeta();
  closeMeetingMenu();
  if (!rows.length) return;

  const root = document.createElement("div");
  root.id = "meeting-meta-root";
  root.innerHTML = `
    <div class="meeting-menu-overlay"></div>
    <div class="meta-panel" id="meeting-meta-panel" role="dialog" aria-label="Transcript details" tabindex="-1">
      ${meetingMetaPanelHtml(rows)}
    </div>
  `;
  document.body.appendChild(root);

  // Measured, not estimated: `.meta-val` wraps long Source paths, so a row
  // count says nothing about the real height, and the width and max-height
  // belong to the stylesheet rather than to a constant that drifts from it.
  const panel = root.querySelector(".meta-panel");
  const a = anchor.getBoundingClientRect();
  const box = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(a.left, window.innerWidth - box.width - 8))}px`;
  panel.style.top = `${Math.max(8, Math.min(a.bottom + 4, window.innerHeight - box.height - 8))}px`;

  anchor.setAttribute("aria-expanded", "true");
  panel.focus();
  root.querySelector(".meeting-menu-overlay").addEventListener("click", closeMeetingMeta);
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !document.getElementById("meeting-meta-root")) return;
  // stopImmediatePropagation, not just closing: the find bar's own Escape
  // handler sits further down this same document listener chain and skips
  // itself via anyOverlayOpen() — which is already false by the time it runs
  // if this one has merely removed the panel. Without it, one Escape closes
  // the panel and throws away the user's search with it.
  e.stopImmediatePropagation();
  closeMeetingMeta();
});

// ─── Meeting context menu (minimal — full set lands in a later phase) ────────
function closeMeetingMenu() {
  const el = document.getElementById("meeting-menu-root");
  if (el) el.remove();
  contextMenu = null;
}

// A disabled menu item says why on hover; an enabled one gets no title at all.
function reasonTitle(reason) {
  return reason ? ` title="${escapeHtml(reason)}"` : "";
}

function openMeetingMenu(x, y, m) {
  closeMeetingMenu();
  closeMeetingMeta();
  contextMenu = { x, y, meetingId: m.id };

  // Clamp so the popover stays on-screen.
  const W = 220;
  const H = 280;
  const left = Math.max(8, Math.min(x, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - H - 8));

  // An audio-only row is a recording with no transcript on disk. Everything
  // that reads or writes a `.txt` is unavailable on it, and every remaining
  // action goes through `record:*` against the wav rather than `transcripts:*`.
  const noTranscript = m.hasTranscript === false;
  const summarizeLabel = m.hasSummary ? "Re-summarize" : "Summarize";
  // Both of these greyed out silently before; a control that does that just
  // looks broken. One string per cause, driving the gate and the tooltip.
  const audioReason = m.hasAudio ? "" : "No audio file for this meeting";
  const summaryReason = m.hasSummary ? "" : "No summary yet";
  // Every one of these changes the file or its name under a run that reads it
  // from disk, and the run would be thrown away at the end.
  const enhancing = Boolean(activeJobFor("enhance", m.id));
  // The chips' invariant applies to the menu too: never offer an action whose
  // failure is already known. On a read-failed row hasSummary/hasAudio are the
  // fallback's fabricated defaults, so Summarize would fail on the same read —
  // and each reason is spelled out, because a control that greys out without
  // saying why just looks broken.
  const summarizeReason = noTranscript ? "Not transcribed yet"
    : m.readFailed ? "Transcript could not be read"
    : "";
  const enhanceReason = noTranscript ? "Not transcribed yet"
    : m.readFailed ? "Transcript could not be read"
    : enhancing ? "Enhance is already running on this transcript"
    : !m.hasSpokenTurns ? "No spoken turns to enhance"
    : "";
  const enhanceDisabled = Boolean(enhanceReason);
  // The same wav is the transcribe queue's job key, so a run already in flight
  // is visible from here.
  const transcribeReason = activeJobFor("transcribe", m.audioPath || m.id)
    ? "A transcription is already running on this recording" : "";
  const transcriptReason = noTranscript ? "Not transcribed yet" : "";

  const root = document.createElement("div");
  root.id = "meeting-menu-root";
  root.innerHTML = `
    <div class="meeting-menu-overlay"></div>
    <div class="meeting-menu" role="menu" style="left:${left}px;top:${top}px;">
      <button class="meeting-menu-item" data-action="summarize" type="button" role="menuitem" ${summarizeReason ? "disabled" : ""}${reasonTitle(summarizeReason)}>
        <span class="meeting-menu-icon" style="color:var(--accent-lime)">${iconSvg("sparkle", { size: 13 })}</span>
        <span>${escapeHtml(summarizeLabel)}</span>
      </button>
      <button class="meeting-menu-item" data-action="enhance" type="button" role="menuitem" ${enhanceDisabled ? "disabled" : ""}${reasonTitle(enhanceReason)}>
        <span class="meeting-menu-icon">${iconSvg("text", { size: 13 })}</span>
        <span>Enhance</span>
      </button>
      <button class="meeting-menu-item" data-action="rename" type="button" role="menuitem" ${enhancing ? "disabled" : ""}>
        <span class="meeting-menu-icon">${iconSvg("pencil", { size: 13 })}</span>
        <span>Rename…</span>
      </button>
      <button class="meeting-menu-item" data-action="retranscribe" type="button" role="menuitem" ${audioReason || enhancing || transcribeReason ? "disabled" : ""}${reasonTitle(transcribeReason || audioReason)}>
        <span class="meeting-menu-icon">${iconSvg("mic", { size: 13 })}</span>
        <span>${noTranscript ? "Transcribe…" : "Re-transcribe…"}</span>
      </button>
      ${noTranscript ? `
      <button class="meeting-menu-item" data-action="reveal" type="button" role="menuitem">
        <span class="meeting-menu-icon">${iconSvg("folder", { size: 13 })}</span>
        <span>Show in Finder</span>
      </button>` : ""}
      <div class="meeting-menu-divider"></div>
      <button class="meeting-menu-item danger" data-action="delete-audio" type="button" role="menuitem" ${audioReason || enhancing ? "disabled" : ""}${reasonTitle(audioReason)}>
        <span class="meeting-menu-icon">${iconSvg("trash", { size: 13 })}</span>
        <span>Delete audio</span>
      </button>
      <button class="meeting-menu-item danger" data-action="delete-transcript" type="button" role="menuitem" ${enhancing || transcriptReason ? "disabled" : ""}${reasonTitle(transcriptReason)}>
        <span class="meeting-menu-icon">${iconSvg("trash", { size: 13 })}</span>
        <span>Delete transcript</span>
      </button>
      <button class="meeting-menu-item danger" data-action="delete-summary" type="button" role="menuitem" ${summaryReason || enhancing ? "disabled" : ""}${reasonTitle(summaryReason)}>
        <span class="meeting-menu-icon">${iconSvg("trash", { size: 13 })}</span>
        <span>Delete summary</span>
      </button>
    </div>
  `;
  document.body.appendChild(root);

  root.querySelector(".meeting-menu-overlay").addEventListener("click", closeMeetingMenu);
  root.querySelectorAll(".meeting-menu-item").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      const action = btn.dataset.action;
      closeMeetingMenu();
      if (action === "summarize") {
        openSummarizeModal(m.id, m.title);
      } else if (action === "enhance") {
        await runEnhance(m);
      } else if (action === "rename") {
        const card = libraryList.querySelector(`[data-meeting-id="${CSS.escape(m.id)}"]`);
        const newTitle = await openRenamePopup(m.title, card?.getBoundingClientRect());
        if (!newTitle || newTitle === m.title) return;
        // Two renames, two handlers: `record:rename` moves the wav and its notes
        // sidecar, `transcripts:rename` moves the .txt and everything paired
        // with it. Both answer { ok, newFilePath }, so the id fixups below are
        // shared.
        const result = noTranscript
          ? await recApi?.rename(m.id, newTitle)
          : await api.renameTranscript(m.id, newTitle);
        if (!result?.ok) {
          window.alert(`Couldn't rename: ${result?.error || "unknown error"}`);
          return;
        }
        if (state.filePath === m.id) state.filePath = result.newFilePath;
        if (activeMeetingId === m.id) activeMeetingId = result.newFilePath;
        if (activeLibraryPath === m.id) activeLibraryPath = result.newFilePath;
        // The batch selection is keyed on the path too, and loadLibrary prunes
        // ids that no longer exist — without this the row silently unticks.
        if (selectedRecordings.delete(m.id)) selectedRecordings.add(result.newFilePath);
        summaryStore.delete(m.id);
        await loadLibrary();
        // The open pane kept the old name, and the player kept a src pointing at
        // a file that has moved.
        const renamed = getMeetingById(result.newFilePath);
        if (noTranscript && renamed && activeMeetingId === renamed.id
            && audioOnlyState && !audioOnlyState.classList.contains("hidden")) {
          if (audioOnlyTitle) audioOnlyTitle.textContent = renamed.title || "Recording";
          playerShowPath(renamed.audioPath);
        }
      } else if (action === "retranscribe") {
        if (m.audioPath) sendToTranscribeSettings([m.audioPath]);
      } else if (action === "reveal") {
        recApi?.showInFinder(m.id);
      } else if (action === "delete-audio") {
        await deleteMeetingArtifact(m, noTranscript ? "recording" : "audio");
      } else if (action === "delete-transcript") {
        await deleteMeetingArtifact(m, "transcript");
      } else if (action === "delete-summary") {
        await deleteMeetingArtifact(m, "summary");
      }
    });
  });
}

// Close the menu on Escape too.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && contextMenu) closeMeetingMenu();
});

async function deleteMeetingArtifact(m, kind) {
  let result;
  if (kind === "recording") {
    // No transcript to resolve the audio from: the meeting id IS the wav.
    result = await recApi?.delete(m.id);
    // The pane and the player are reset by loadLibrary below, which is also
    // what an external delete goes through.
    if (result?.ok) selectedRecordings.delete(m.id);
  } else if (kind === "audio") {
    result = await api.deleteAudioOnly(m.id);
  } else if (kind === "summary") {
    result = await api.deleteSummaryOnly(m.id);
  } else if (kind === "transcript") {
    result = await api.deleteTranscriptOnly(m.id);
  } else {
    return;
  }
  if (result?.canceled) return;
  if (!result?.ok) {
    window.alert(`Couldn't delete the ${kind}: ${result?.error || "unknown error"}`);
    return;
  }

  // Side-effects per kind.
  if (kind === "summary") {
    summaryStore.delete(m.id);
    if (state.filePath === m.id) {
      summaryRail.classList.add("hidden");
    }
  } else if (kind === "transcript") {
    // Deleting the .txt orphans this meeting card — it disappears from the
    // library, mirror the same cleanup as the old combined delete path.
    summaryStore.delete(m.id);
    if (state.filePath === m.id) {
      state.filePath = null;
      state.savedContent = "";
      state.baselineContent = "";
      state.isDirty = false;
      editor.value = "";
      emptyState.classList.remove("hidden");
      editor.classList.add("hidden");
      editorToolbar.classList.add("hidden");
      setDirty(false);
      activeMeetingId = null;
      activeLibraryPath = null;
      summaryRail.classList.add("hidden");
      if (PLAYER_OK) { transcriptView.classList.add("hidden"); playerHide(); }
    }
  }
  // audio-only: nothing to reset in the editor — only hasAudio drops to false.
  // Library watcher will fire fs.watch and trigger loadLibrary(); also do it
  // immediately so the user sees the change without waiting on fs.watch.
  loadLibrary();
}

function openRenamePopup(currentTitle, anchorRect) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "rename-overlay";

    const popup = document.createElement("div");
    popup.className = "rename-popup";

    const input = document.createElement("input");
    input.className = "rename-popup-input";
    input.type = "text";
    input.value = currentTitle;

    const actions = document.createElement("div");
    actions.className = "rename-popup-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "rename-popup-btn";
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";

    const okBtn = document.createElement("button");
    okBtn.className = "rename-popup-btn primary";
    okBtn.type = "button";
    okBtn.textContent = "Rename";

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    popup.appendChild(input);
    popup.appendChild(actions);

    function cleanup() { overlay.remove(); popup.remove(); }
    function confirm() { const v = input.value.trim(); cleanup(); resolve(v || null); }
    function cancel() { cleanup(); resolve(null); }

    cancelBtn.addEventListener("click", cancel);
    okBtn.addEventListener("click", confirm);
    overlay.addEventListener("click", cancel);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); confirm(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });

    document.body.appendChild(overlay);
    document.body.appendChild(popup);

    if (anchorRect) {
      const left = Math.max(8, Math.min(anchorRect.right + 8, window.innerWidth - 296));
      const top = Math.max(8, Math.min(anchorRect.top, window.innerHeight - 80));
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
    } else {
      popup.style.left = `${Math.round((window.innerWidth - 280) / 2)}px`;
      popup.style.top = `${Math.round((window.innerHeight - 80) / 2)}px`;
    }

    input.focus();
    input.select();
  });
}

async function handleMeetingClick(m) {
  if (m.id === activeMeetingId) return;
  // No `.txt` to open: `transcripts:openFile` would fail on a wav path, and
  // there is nothing for the editor to load. Play it instead.
  if (m.hasTranscript === false) return showAudioOnly(m);
  // Flushing and moving the selection both belong to the file:opened path
  // (flushBeforeReplace, then loadContent → setActiveMeetingId): doing either
  // here as well prompted twice for one click, and left the sidebar pointing at
  // a note that was never opened when the user cancelled.
  await api.openFromLibrary(m.id);
}

// Selecting an audio-only recording replaces whatever the editor held, so it
// owes the open transcript the same flush the file:opened path performs.
async function showAudioOnly(m) {
  if (!(await flushBeforeReplace())) return;
  clearTimeout(autosaveTimer);
  state.filePath = null;
  state.savedContent = "";
  state.baselineContent = "";
  setDirty(false);
  editor.value = "";
  editor.classList.add("hidden");
  editorToolbar.classList.add("hidden");
  emptyState.classList.add("hidden");
  summaryRail.classList.add("hidden");
  if (PLAYER_OK) transcriptView.classList.add("hidden");
  setActiveMeetingId(m.id);
  // showEditor() is the only thing that enables these, and nothing turns them
  // back off — they would act on an empty buffer with no path.
  btnSaveAs.disabled = true;
  btnExport.disabled = true;
  if (audioOnlyTitle) audioOnlyTitle.textContent = m.title || "Recording";
  audioOnlyState?.classList.remove("hidden");
  playerShowPath(m.audioPath);
}

document.getElementById("audio-only-transcribe")?.addEventListener("click", () => {
  const m = getMeetingById(activeMeetingId);
  if (m?.audioPath) sendToTranscribeSettings([m.audioPath]);
});

// ─── Sidebar formatters ──────────────────────────────────────────────────────
// Date order and clock are view preferences, stored and applied exactly like
// the theme (see applyTheme): localStorage, live on change, outside the
// summarizer's Save/Cancel flow.
//
// ── date-time formatting (extracted verbatim by test/meeting-date-format.test.js) ──
// Everything between these markers stays free of localStorage and the DOM so the
// test can eval the region under node. Keep the markers in place when editing.
const DATE_ORDER_KEY = "uds-date-order";    // 'dmy' (day first) | 'mdy' (month first)
const TIME_FORMAT_KEY = "uds-time-format";  // '24h' | '12h'

// renderMeetings() reruns on every search keystroke and builds one card per
// meeting, so the formatter pair for each preference combination is built once
// and reused rather than twice per card per repaint.
const meetingFormatterCache = new Map();

function meetingFormatters(order, clock) {
  const key = `${order}|${clock}`;
  let pair = meetingFormatterCache.get(key);
  if (!pair) {
    pair = {
      // The clock keeps its own locale rather than inheriting the date's: en-GB
      // with hour12 renders "06:14 pm" and en-US without it renders "18:14", so
      // mixing them would make AM/PM casing and zero-padding depend on the date
      // preference.
      day: new Intl.DateTimeFormat(order === "mdy" ? "en-US" : "en-GB", {
        day: "2-digit", month: "2-digit", year: "2-digit",
      }),
      time: clock === "12h"
        ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
        : new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }),
    };
    meetingFormatterCache.set(key, pair);
  }
  return pair;
}

function formatMeetingDateTime(date, order, clock) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return "";
  try {
    const f = meetingFormatters(order, clock);
    // ICU 72+ separates the meridiem with U+202F — normalised to a plain space
    // so the card text stays copy-pasteable.
    return `${f.day.format(date)}, ${f.time.format(date).replace(/\u202f/g, " ")}`;
  } catch (_) {
    // A build without usable ICU data would otherwise throw once per card and
    // take the whole sidebar down with it; a bare clock is the better failure.
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
}

// Defaults follow the OS locale so an unconfigured machine already reads right.
function systemDateOrder() {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      day: "2-digit", month: "2-digit", year: "2-digit",
    }).formatToParts(new Date());
    const month = parts.findIndex((p) => p.type === "month");
    const day = parts.findIndex((p) => p.type === "day");
    return month >= 0 && day >= 0 && month < day ? "mdy" : "dmy";
  } catch (_) {
    return "dmy";
  }
}

function systemTimeFormat() {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12
      ? "12h"
      : "24h";
  } catch (_) {
    return "24h";
  }
}
// ── end date-time formatting ──

// Storage access is guarded the same way as the summary-preset reads below: a
// browsing context with site data blocked throws on access rather than
// returning null, and that must not cost the user the sidebar.
function readFormatPref(key, systemDefault) {
  try {
    return localStorage.getItem(key) || systemDefault();
  } catch (_) {
    return systemDefault();
  }
}

function dateOrderPref() {
  return readFormatPref(DATE_ORDER_KEY, systemDateOrder);
}

function timeFormatPref() {
  return readFormatPref(TIME_FORMAT_KEY, systemTimeFormat);
}

function formatMeetingStamp(date) {
  return formatMeetingDateTime(date, dateOrderPref(), timeFormatPref());
}

// An audio-only row has no duration — `record:list` reports bytes, not seconds,
// and deriving seconds from bytes would only be right for wavs this app wrote
// itself. Bytes are a fact; a guessed runtime is not.
function formatMeetingSize(bytes) {
  if (!bytes) return "";
  const kb = bytes / 1024;
  // Below a megabyte the MB form rounds to "0.0 MB", which reads as an empty
  // file — exactly the case (a truncated recording) worth telling apart.
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  const mb = kb / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

function formatMeetingDuration(seconds) {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getAvatarInitials(name) {
  if (!name) return "?";
  if (name === "You") return "Y";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase() || "?";
}

const AVATAR_PALETTE = [
  { bg: "#e87b6b", fg: "#1a0d0a" }, // coral
  { bg: "#e8a85a", fg: "#1a1408" }, // amber
  { bg: "#5ec488", fg: "#08160e" }, // green
  { bg: "#4fb8b8", fg: "#06181a" }, // teal
  { bg: "#5fa8e8", fg: "#06121a" }, // sky
  { bg: "#8a90e8", fg: "#0c0e1f" }, // indigo
  { bg: "#b878d4", fg: "#180a1f" }, // violet
  { bg: "#d96fa8", fg: "#1f0a16" }, // magenta
  { bg: "#d97373", fg: "#1f0a0a" }, // rose
  { bg: "#c4a05a", fg: "#1f1808" }, // mustard
];
function avatarColor(name) {
  const s = String(name || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

function avatarHtml(name, extraClass = "") {
  const c = avatarColor(name);
  const cls = `avatar${extraClass ? " " + extraClass : ""}`;
  const style = `background:${c.bg};color:${c.fg}`;
  return `<span class="${cls}" style="${style}" title="${escapeHtml(name)}">${escapeHtml(getAvatarInitials(name))}</span>`;
}

function avatarStackHtml(names, max = 3) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  const items = shown.map((n) => avatarHtml(n)).join("");
  const overflow = extra > 0
    ? `<span class="avatar avatar-overflow" title="${escapeHtml(names.slice(max).join(", "))}">+${extra}</span>`
    : "";
  return `<div class="avatar-stack">${items}${overflow}</div>`;
}

const STATUS_LABELS = {
  recording: "Recording",
  audio_only: "Audio only",
  transcribing: "Transcribing",
  transcribed: "Transcribed",
  summarized: "Summarized",
  outdated: "Outdated",
  failed: "Failed",
};

function statusPillHtml(status) {
  const label = STATUS_LABELS[status] || status;
  const hasDot = status === "recording" || status === "transcribing" || status === "audio_only";
  return `<span class="status-pill" data-status="${status}">${hasDot ? '<span class="status-dot"></span>' : ""}${escapeHtml(label)}</span>`;
}

// ─── Provenance chips (which model transcribed it, did Enhance run) ──────────
// The header stores the raw WhisperKit id; dropping the vendor prefix and
// unescaping the variant suffix reproduces every label the Record tab's own
// model picker shows ("large-v3 turbo", "medium", "base", …), so there is no
// second table to keep in sync.
function modelLabel(id) {
  return String(id || "").replace(/^openai_whisper-/, "").replace(/_/g, " ");
}

// The `large-*` variants are the accurate ones; everything below them trades
// accuracy for speed. That is the distinction worth seeing from the list — the
// exact variant is in the chip's text and tooltip either way.
function modelIsStrong(id) {
  return /large/i.test(String(id || ""));
}

function modelChipHtml(m) {
  if (!m.model) return "";
  return `<span class="model-chip" data-strong="${modelIsStrong(m.model) ? "true" : "false"}"`
    + ` title="Transcribed with ${escapeHtml(m.model)}">${escapeHtml(modelLabel(m.model))}</span>`;
}

function enhancedChipTitle(enhancedAt) {
  if (!enhancedAt) return "Not enhanced";
  const at = new Date(enhancedAt);
  return isNaN(at.getTime()) ? "Enhanced" : `Enhanced ${at.toLocaleString()}`;
}

// ─── Tiny inline-SVG icon helper (Lucide-style paths) ────────────────────────
const ICON_PATHS = {
  more:    '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  mic:     '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/>',
  text:    '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="10" x2="20" y2="10"/><line x1="4" y1="14" x2="14" y2="14"/><line x1="4" y1="18" x2="18" y2="18"/>',
  sparkle: '<path d="M12 2l1.6 4.6L18 8l-4.4 1.4L12 14l-1.6-4.6L6 8l4.4-1.4L12 2z" fill="currentColor" stroke="none"/>',
  check:   '<polyline points="20 6 9 17 4 12"/>',
  trash:   '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  pencil:  '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  info:    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  folder:  '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
};

function iconSvg(name, opts = {}) {
  const size = opts.size || 14;
  const stroke = opts.stroke || 2;
  const path = ICON_PATHS[name] || "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

// ─── Summary rail (right) ────────────────────────────────────────────────────
const summaryRail = document.getElementById("summary-rail");
const summaryRailBody = document.getElementById("summary-rail-body");
const btnRailResummarize = document.getElementById("btn-rail-resummarize");
const btnRailResummarizeLabel = document.getElementById("btn-rail-resummarize-label");

// Tracks which filePath is currently being awaited for `api.loadSummary`,
// so a quick file-switch doesn't write the stale result into the rail.
let railLoadToken = 0;

// ── rail sections (extracted verbatim by test/rail-sections.test.js) ──
// Everything down to the end marker is pure string work: the seven presets in
// PROMPTS are the only spec for what a summary looks like, and this region turns
// their `##` headings into rail markup. `escapeHtml`, `iconSvg` and `avatarHtml`
// resolve from the enclosing scope — which is what lets the test eval the region
// with stubs for them. Keep the markers in place when editing.

// One heading → one slug, shared by the gate and the parser so the two can never
// disagree about what "recognised" means. Non-letters collapse, digits included,
// so "For next 1-1" is `for_next` and "TL;DR" is `tl_dr`.
function railSlug(heading) {
  return String(heading).toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");
}

// Which render each preset section gets, keyed by slug. The five tone names are
// bullet lists differing only in glyph and colour; the rest name a renderer.
// A heading missing from here — a custom prompt's, or a translated one, since the
// presets print this structure in English and translate only the prose — falls
// through to a labelled plain-markdown section, exactly as it did before.
// Null-prototype: these are looked up with model-written text, and a plain
// object would answer `constructor` (and friends) with an inherited value.
const RAIL_SECTIONS = Object.assign(Object.create(null), {
  // prose. `brief` is no preset's heading — it is kept for summaries saved by
  // an older prompt that emitted "## Brief".
  summary: "plain", tl_dr: "plain", notes: "plain", brief: "plain",
  hardest_problem_solved: "plain", career_growth: "plain", mood_well_being: "plain",
  // dedicated renderers
  speaker_mapping: "map", root_causes: "map", scorecard: "plain",
  action_items: "actions", milestones_timeline: "dated",
  status: "status", participants: "people",
  recommendation: "recommendation",
  // settled / positive
  decisions: "good", agreed_terms: "good", progress: "good",
  what_went_well: "good", strong_answers: "good", strengths: "good",
  // problems
  risks: "bad", red_flags: "bad", what_didn_t_go_well: "bad",
  weak_concerning_answers: "bad", weaknesses_risks: "bad",
  // needs attention, but not yet a problem
  blockers_dependencies: "warn", open_unresolved_points: "warn", scope_changes: "warn",
  // forward-looking
  experiments_to_try: "idea", for_next: "idea",
  open_questions_for_follow_up: "idea", concessions_movement: "idea",
  // plain enumerations
  topics: "neutral", discussion: "neutral", feedback: "neutral", motivation: "neutral",
  candidate_preferences: "neutral", parties_positions: "neutral", asks_offers: "neutral",
  leverage_batna_notes: "neutral",
});

// Structured as soon as one heading is one we know how to draw. Deliberately not
// "has any ## heading": freeform output keeps the plain-markdown path, and a
// preset that skipped Decisions and Action Items still qualifies on the rest.
function shouldRenderStructured(md) {
  for (const m of String(md || "").matchAll(/^##[^\S\r\n]+(.+?)[^\S\r\n]*$/gm)) {
    if (RAIL_SECTIONS[railSlug(m[1])]) return true;
  }
  return false;
}

// Inline markdown → HTML (bold / em / inline code).
function renderMarkdownInline(s) {
  let rest = String(s || "");
  let html = "";
  while (rest.length) {
    let m = rest.match(/^\*\*([^*]+)\*\*/);
    if (m) { html += `<strong>${escapeHtml(m[1])}</strong>`; rest = rest.slice(m[0].length); continue; }
    m = rest.match(/^\*([^*]+)\*/);
    if (m) { html += `<em>${escapeHtml(m[1])}</em>`; rest = rest.slice(m[0].length); continue; }
    m = rest.match(/^`([^`]+)`/);
    if (m) { html += `<code>${escapeHtml(m[1])}</code>`; rest = rest.slice(m[0].length); continue; }
    m = rest.match(/^[^*`]+/);
    if (m) { html += escapeHtml(m[0]); rest = rest.slice(m[0].length); continue; }
    html += escapeHtml(rest[0]); rest = rest.slice(1);
  }
  return html;
}

// Parse a summary into { title, meta, sections: [{slug, heading, lines}] }.
// Sections are kept in source order so the rail renders the whole file —
// known sections (decisions / action_items / risks / brief) get a custom
// render, anything else is shown as plain markdown.
function parseStructured(md) {
  let lines = String(md || "").split("\n");

  // Strip a leading YAML frontmatter block ("--- ... ---") if present —
  // common in Obsidian-preset summaries.
  if (lines[0] && lines[0].trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) lines = lines.slice(end + 1);
  }

  let title = null;
  const meta = [];
  const sections = [];
  let current = null;

  for (const raw of lines) {
    const l = raw.trimEnd();
    if (!title && !current) {
      const m = l.match(/^#\s+(.+)/);
      if (m) { title = m[1]; continue; }
    }
    const h2 = l.match(/^##\s+(.+)/);
    if (h2) {
      const slug = railSlug(h2[1]);
      current = { slug, heading: h2[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (!current && l) meta.push(l);
    else if (current) current.lines.push(l);
  }

  // Fall back to raw text only when there are no ## sections at all (freeform).
  if (!sections.length) {
    return { fallback: true };
  }

  return { title, meta, sections };
}

// Tiny markdown → HTML renderer for the rail (h1/h2/p/list/strong/em/code/blockquote).
function renderMarkdown(md) {
  const lines = String(md || "").split("\n");
  const out = [];
  let listBuf = null;
  let para = [];
  let tableBuf = null;

  const flushList = () => {
    if (listBuf) {
      out.push("<ul>" + listBuf.map((it) => `<li>${renderMarkdownInline(it)}</li>`).join("") + "</ul>");
      listBuf = null;
    }
  };
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${renderMarkdownInline(para.join(" "))}</p>`);
      para = [];
    }
  };
  // Pipe tables reach the rail from more than the interview scorecard, so they
  // belong to the base renderer rather than to one section's special case.
  const flushTable = () => {
    if (!tableBuf) return;
    // A block of pipes that parses to nothing (a stray separator, a bare "|")
    // is still text the model wrote — render it rather than discard it.
    out.push(renderTableHtml(tableBuf) || `<p>${renderMarkdownInline(tableBuf.join(" "))}</p>`);
    tableBuf = null;
  };

  for (const raw of lines) {
    const l = raw.trimEnd();
    if (!l) { flushList(); flushPara(); flushTable(); continue; }
    const piped = l.trimStart();
    if (piped.startsWith("|")) { flushList(); flushPara(); (tableBuf ||= []).push(piped); continue; }
    flushTable();
    let m;
    if ((m = l.match(/^#\s+(.+)/))) {
      flushList(); flushPara();
      out.push(`<h1>${escapeHtml(m[1])}</h1>`);
    } else if ((m = l.match(/^###\s+(.+)/))) {
      flushList(); flushPara();
      out.push(`<h3>${escapeHtml(m[1])}</h3>`);
    } else if ((m = l.match(/^##\s+(.+)/))) {
      flushList(); flushPara();
      out.push(`<h2>${escapeHtml(m[1])}</h2>`);
    } else if ((m = l.match(/^>\s*(.+)/))) {
      flushList(); flushPara();
      out.push(`<blockquote>${renderMarkdownInline(m[1])}</blockquote>`);
    } else if ((m = l.match(RAIL_BULLET_RE))) {
      flushPara();
      (listBuf ||= []).push(m[1]);
    } else {
      flushList();
      para.push(l);
    }
  }
  flushList(); flushPara(); flushTable();
  return out.join("");
}

function buildRailHeaderHtml(filePath, statusChip) {
  const path = filePath ? escapeHtml(filePath) : "";
  const chip = statusChip
    ? `<span class="rail-preset-chip ${statusChip.muted ? "muted" : ""}">${escapeHtml(statusChip.label)}</span>`
    : "";
  return `
    <div class="rail-header">
      <span class="rail-header-sparkle">${iconSvg("sparkle", { size: 14 })}</span>
      <span class="rail-header-title">Summary</span>
      ${path ? `<span class="rail-header-info" title="${path}" aria-label="${path}" role="img">${iconSvg("info", { size: 13 })}</span>` : ""}
      ${chip}
    </div>
  `;
}

// The wrapper every section shares, so a new render kind cannot invent its own
// heading treatment. `count` is omitted for prose sections.
function railSection(label, body, count) {
  if (!body) return "";
  const badge = count ? ` <span class="rail-section-count">${count}</span>` : "";
  return `
    <div class="rail-section">
      ${label ? `<div class="rail-section-label">${escapeHtml(label)}${badge}</div>` : ""}
      ${body}
    </div>
  `;
}

// The one bullet shape the module recognises: "-", "*" or "1." / "1)", indented
// or not. Models are not consistent about which they reach for, and a section
// whose bullets go unrecognised loses its whole layout.
const RAIL_BULLET_RE = /^[ \t]*(?:[-*]|\d+[.)])[ \t]+(.+)$/;

// Bullets and the prose around them, kept apart and kept in place: a lead-in
// sentence stays above the list, a closing note stays below it, and neither is
// dropped or turned into a bullet of its own.
function partitionBullets(lines) {
  const bullets = [];
  const before = [];
  const after = [];
  for (const raw of lines || []) {
    const m = String(raw).match(RAIL_BULLET_RE);
    if (m) { bullets.push(m[1].trim()); continue; }
    (bullets.length ? after : before).push(raw);
  }
  return { bullets, before: before.join("\n").trim(), after: after.join("\n").trim() };
}

// A letter or a digit, in any script — used where a prefix match has to stop at
// a word end. `\b` is defined by [A-Za-z0-9_] and so is blind to Cyrillic.
const RAIL_WORDISH = /[\p{L}\p{N}]/u;

// A trailing " — *Jun 30*". Shared by action items and milestones so a date
// lands in the same pill wherever a preset appends one.
function splitDue(body) {
  const m = String(body).match(/\s+[—–-]\s+\*([^*]+)\*\s*$/);
  if (!m) return { text: String(body).trim(), due: null };
  return { text: String(body).slice(0, m.index).trim(), due: m[1].trim() };
}

// Parse "- [ ] **Owner** — task — *due*" where the checkbox, the **owner** and
// the trailing " — *due*" are each optional and can appear in any combination
// (the model isn't perfectly consistent — e.g. a deadline with no owner).
function parseActionItems(lines) {
  const out = [];
  for (const bullet of partitionBullets(lines).bullets) {
    // checkbox, then the optional trailing " — *due*", then the optional owner
    let { text: body, due } = splitDue(bullet.replace(/^\[[ xX]\]\s*/, ""));
    let who = null;
    const wm = body.match(/^\*\*([^*]+)\*\*\s+[—–-]\s+(.+)$/); // optional leading "**owner** — "
    if (wm) { who = wm[1].trim(); body = wm[2].trim(); }
    out.push({ who, what: body, due });
  }
  return out;
}

// Five tones, one glyph each, so a list of wins never reads like a list of
// risks. `good` keeps the tinted circle the Decisions list has always had.
const RAIL_BULLETS = {
  good:    { cls: "rail-bullet--good", glyph: null },
  bad:     { cls: "rail-bullet--bad", glyph: "◆" },
  warn:    { cls: "rail-bullet--warn", glyph: "▲" },
  idea:    { cls: "rail-bullet--idea", glyph: "→" },
  neutral: { cls: "rail-bullet--neutral", glyph: "•" },
};
const RAIL_TONES = Object.keys(RAIL_BULLETS);

function railBullet(tone) {
  const b = RAIL_BULLETS[tone] || RAIL_BULLETS.neutral;
  const inner = b.glyph ? escapeHtml(b.glyph) : iconSvg("check", { size: 10 });
  return `<span class="rail-bullet ${b.cls}" aria-hidden="true">${inner}</span>`;
}

// Shared body of every list section: the prose the model wrote above the list,
// the list, then the prose below it. Nothing in a section is silently discarded.
function railListSection(heading, items, before, after) {
  const md = (t) => (t ? `<div class="rail-md">${renderMarkdown(t)}</div>` : "");
  return railSection(heading, md(before) + `<ul class="rail-list">${items.join("")}</ul>` + md(after), items.length);
}

function renderBulletSection(heading, lines, tone) {
  const { bullets, before, after } = partitionBullets(lines);
  if (!bullets.length) return renderPlainSection(heading, lines);
  const items = bullets.map((t) => `<li>${railBullet(tone)}<span class="rail-li-text">${renderMarkdownInline(t)}</span></li>`);
  return railListSection(heading, items, before, after);
}

// "— *Jun 30*" on a milestone becomes the same due pill an action item gets.
function renderDatedSection(heading, lines) {
  const { bullets, before, after } = partitionBullets(lines);
  if (!bullets.length) return renderPlainSection(heading, lines);
  const items = bullets.map((b) => {
    const { text, due } = splitDue(b);
    return `<li>${railBullet("neutral")}<span class="rail-li-text">${renderMarkdownInline(text)}</span>`
      + (due ? `<span class="rail-due-pill">${escapeHtml(due)}</span>` : "")
      + `</li>`;
  });
  return railListSection(heading, items, before, after);
}

// "Alpha → Anna (introduced at 00:02)" and "slow deploys → CI runs everything".
// The parenthesised tail is evidence, not part of the mapping.
function parseMapRow(text) {
  const parts = String(text).split(/\s*(?:→|->)\s*/);
  if (parts.length < 2) return null;
  let to = parts.slice(1).join(" → ").trim();
  let note = null;
  const nm = to.match(/\s*\(([^()]*)\)\s*$/);
  if (nm) { note = nm[1].trim(); to = to.slice(0, nm.index).trim(); }
  // "Alpha →" with nothing after it is not a mapping — an empty cell reads as a
  // rendering bug, and the row would still be counted in the badge.
  if (!parts[0].trim() || !to) return null;
  return { from: parts[0].trim(), to, note };
}

function renderMapSection(heading, lines) {
  const { bullets, before, after } = partitionBullets(lines);
  if (!bullets.length) return renderPlainSection(heading, lines);
  const items = bullets.map((b) => {
    const row = parseMapRow(b);
    // No arrow: the model wrote a plain observation, so let it be a plain row.
    // No bullet glyph either — the mapped rows in this same list have none, and
    // one marked row among unmarked ones renders ragged.
    if (!row) return `<li><span class="rail-li-text">${renderMarkdownInline(b)}</span></li>`;
    return `<li><span class="rail-map">`
      + `<span class="rail-map-from">${renderMarkdownInline(row.from)}</span>`
      + `<span class="rail-map-arrow" aria-hidden="true">→</span>`
      + `<span class="rail-map-to">${renderMarkdownInline(row.to)}</span>`
      + (row.note ? `<span class="rail-map-note">${renderMarkdownInline(row.note)}</span>` : "")
      + `</span></li>`;
  });
  return railListSection(heading, items, before, after);
}

// Chip verdicts: match a leading phrase, but only when the line actually ends
// the phrase there. Longest form first, so "заблокировано" wins over the
// shorter stem. Returns null when nothing matches, and the caller falls back to
// prose — which is also what happens to any wording not listed here.
function matchChip(line, table) {
  const head = String(line).trim();
  const lower = head.toLowerCase();
  for (const [word, cls] of table) {
    if (!lower.startsWith(word.toLowerCase())) continue;
    const after = head.slice(word.length);
    // "On tracked to slip" is a sentence, not an on-track status.
    if (after && RAIL_WORDISH.test(after[0])) continue;
    // Strip the separator, then drop a remainder that is only punctuation —
    // "On track." must not leave a paragraph containing just a full stop.
    const rest = after.replace(/^\s*[—–:-]\s*/, "").trim();
    return { label: head.slice(0, word.length), cls, rest: RAIL_WORDISH.test(rest) ? rest : "" };
  }
  return null;
}

// The project preset asks for "on track / at risk / blocked" plus a reason. The
// Russian forms are a best guess at what the preset's "write it in Russian"
// rule produces — a miss costs nothing, the section just stays prose.
const RAIL_STATUS = [
  ["on track", "status-on-track"], ["в графике", "status-on-track"], ["по плану", "status-on-track"],
  ["at risk", "status-at-risk"], ["под угрозой", "status-at-risk"], ["есть риск", "status-at-risk"],
  ["blocked", "status-blocked"], ["заблокировано", "status-blocked"], ["заблокирован", "status-blocked"],
];

function renderStatusSection(heading, lines) {
  const text = (lines || []).join("\n").trim();
  if (!text) return "";
  const [first, ...tail] = text.split("\n");
  const hit = matchChip(first, RAIL_STATUS);
  if (!hit) return renderPlainSection(heading, lines);
  const body = [hit.rest, ...tail].join("\n").trim();
  return railSection(heading,
    `<span class="rail-verdict ${hit.cls}">${escapeHtml(hit.label)}</span>`
    + (body ? `<div class="rail-md rail-rec-body">${renderMarkdown(body)}</div>` : ""));
}

// Daily's Participants is "### Person" then labelled bullets. One card per
// person beats one long blob when six people report in a row.
function parsePeople(lines) {
  const people = [];
  const lead = [];
  let current = null;
  for (const raw of lines || []) {
    const m = String(raw).match(/^###[ \t]+(.+?)[ \t]*$/);
    if (m) { current = { name: m[1], lines: [] }; people.push(current); continue; }
    if (current) current.lines.push(raw);
    else lead.push(raw);
  }
  return { people, lead: lead.join("\n").trim() };
}

function renderPeopleSection(heading, lines) {
  const { people, lead } = parsePeople(lines);
  if (!people.length) return renderPlainSection(heading, lines);
  const cards = people.map((p) => {
    const body = p.lines.join("\n").trim();
    return `<div class="rail-person">`
      + `<div class="rail-person-name">${avatarHtml(p.name)}<span>${renderMarkdownInline(p.name)}</span></div>`
      + (body ? `<div class="rail-md rail-person-body">${renderMarkdown(body)}</div>` : "")
      + `</div>`;
  }).join("");
  const prose = lead ? `<div class="rail-md">${renderMarkdown(lead)}</div>` : "";
  return railSection(heading, prose + cards, people.length);
}

// Any pipe table. The interview scorecard's Rating column is tinted; it is found
// by name so reordering or renaming the column drops the tint instead of
// colouring whichever column happens to sit second.
const RAIL_RATINGS = Object.assign(Object.create(null),
  { strong: "sc-strong", mixed: "sc-mixed", weak: "sc-weak", "not assessed": "sc-na" });

function parseTableRows(lines) {
  const rows = [];
  for (const l of lines || []) {
    const t = String(l).trim();
    if (!t.startsWith("|")) continue;
    if (/^\|[-:| ]+\|?$/.test(t)) continue; // the |---|---| separator
    rows.push(t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  }
  return rows;
}

function renderTableHtml(lines) {
  const rows = parseTableRows(lines);
  if (!rows.length) return "";
  const [header, ...body] = rows;
  const rateCol = header.findIndex((h) => /^rating$/i.test(h));
  const ths = header.map((h) => `<th>${renderMarkdownInline(h)}</th>`).join("");
  const trs = body.map((r) => `<tr>${r.map((c, i) => {
    if (i !== rateCol) return `<td>${renderMarkdownInline(c)}</td>`;
    return `<td class="sc-rating ${RAIL_RATINGS[c.toLowerCase()] || ""}">${renderMarkdownInline(c)}</td>`;
  }).join("")}</tr>`).join("");
  // The rail is 360px wide; a wide table has to be reachable, not clipped.
  return `<div class="rail-table-wrap"><table class="rail-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

function renderActionItemsSection(heading, cards) {
  if (!cards.length) return "";
  const items = cards.map((a) => `
    <div class="rail-action">
      <div class="rail-action-row">
        <span class="rail-checkbox" aria-hidden="true"></span>
        <div class="rail-action-body">${renderMarkdownInline(a.what)}</div>
      </div>
      ${(a.who || a.due) ? `
        <div class="rail-action-footer">
          ${a.who ? `<span class="rail-action-who">${avatarHtml(a.who)}${escapeHtml(a.who)}</span>` : ""}
          ${a.due ? `<span class="rail-due-pill">${escapeHtml(a.due)}</span>` : ""}
        </div>
      ` : ""}
    </div>
  `).join("");
  return railSection(heading, items, cards.length);
}

// A heading the model left empty renders nothing at all: the presets say "skip
// this section if none", and an empty label is worse than a missing one.
function renderPlainSection(heading, lines) {
  const text = (lines || []).join("\n").trim();
  if (!text) return "";
  return railSection(heading, `<div class="rail-md">${renderMarkdown(text)}</div>`);
}

// "No hire" before "Hire" and "Strong hire" before both — matchChip takes the
// first entry that fits, so the longer verdict has to come first or "Hire"
// would swallow "Hire — …" out of "Strong hire — …".
const RAIL_VERDICTS = [
  ["Strong hire", "verdict-hire-strong"],
  ["No hire", "verdict-no-hire"],
  ["Lean no", "verdict-lean-no"],
  ["Insufficient signal", "verdict-signal"],
  ["Hire", "verdict-hire"],
];

function renderRecommendationSection(heading, lines) {
  const text = (lines || []).join("\n").trim();
  if (!text) return "";
  const [first, ...tail] = text.split("\n");
  const hit = matchChip(first, RAIL_VERDICTS);
  // No recognisable verdict: the paragraph is still the recommendation.
  if (!hit) return renderPlainSection(heading, lines);
  const body = [hit.rest, ...tail].join("\n").trim();
  return railSection(heading,
    `<span class="rail-verdict ${hit.cls}">${escapeHtml(hit.label)}</span>`
    + (body ? `<div class="rail-md rail-rec-body">${renderMarkdown(body)}</div>` : ""));
}

function buildStructuredHtml(parsed) {
  const out = [];

  // Title + meta lines (like "**Date:** …", "**Attendees:** …") at the top.
  const headerLines = [];
  if (parsed.title) headerLines.push("# " + parsed.title);
  if (parsed.meta && parsed.meta.length) headerLines.push(...parsed.meta);
  if (headerLines.length) {
    out.push(`<div class="rail-md rail-md-header">${renderMarkdown(headerLines.join("\n"))}</div>`);
  }

  // Display order: pinned sections first, then everything else in source order.
  // The actionable block stays on top for every preset; `status` joins it because
  // a project note is read for its state before anything else.
  const RAIL_ORDER = ["speaker_mapping", "summary", "tl_dr", "status", "participants", "scorecard", "action_items", "decisions", "recommendation"];
  const orderedSections = [...parsed.sections].sort((a, b) => {
    const ai = RAIL_ORDER.indexOf(a.slug);
    const bi = RAIL_ORDER.indexOf(b.slug);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  for (const sec of orderedSections) out.push(renderRailSection(sec));

  return out.join("");
}

// One section → its markup. The registry decides; a slug it does not carry lands
// on renderPlainSection, which is what keeps custom prompts rendering as before.
function renderRailSection(sec) {
  const kind = RAIL_SECTIONS[sec.slug];
  if (RAIL_TONES.includes(kind)) return renderBulletSection(sec.heading, sec.lines, kind);
  switch (kind) {
    case "actions": {
      // Every other kind degrades to plain markdown when its shape does not
      // parse; without this the whole section would vanish from the rail.
      const cards = parseActionItems(sec.lines);
      return cards.length ? renderActionItemsSection(sec.heading, cards) : renderPlainSection(sec.heading, sec.lines);
    }
    case "map": return renderMapSection(sec.heading, sec.lines);
    case "dated": return renderDatedSection(sec.heading, sec.lines);
    case "status": return renderStatusSection(sec.heading, sec.lines);
    case "people": return renderPeopleSection(sec.heading, sec.lines);
    case "recommendation": return renderRecommendationSection(sec.heading, sec.lines);
    default: return renderPlainSection(sec.heading, sec.lines);
  }
}
// ── end rail sections ──

function setSummaryWarning(filePath, warning) {
  if (warning) summaryWarnings.set(filePath, warning);
  else summaryWarnings.delete(filePath);
}

// Sits above the summary body, styled apart from the informational banner below —
// this one says the note will not be indexed, which is not an FYI.
function buildRailWarningHtml(filePath) {
  const warning = summaryWarnings.get(filePath);
  if (!warning) return "";
  return `
    <div class="rail-banner rail-banner--warn">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      ${escapeHtml(warning)}
    </div>`;
}

function buildMarkdownBodyHtml(md) {
  const banner = `
    <div class="rail-banner">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      Freeform summary — rendered as Markdown
    </div>`;
  const { body } = parseFrontmatterFromMd(md);
  return `${banner}<div class="rail-md">${renderMarkdown(body)}</div>`;
}

function buildNoSummaryHtml() {
  return `
    <div class="rail-empty">
      <span class="rail-empty-icon">${iconSvg("sparkle", { size: 22 })}</span>
      <h3>No summary yet</h3>
    </div>
  `;
}

// Main entry — call after the active meeting changes or after a summary lands.
async function renderSummaryRail(filePath) {
  if (!filePath) {
    summaryRail.classList.add("hidden");
    return;
  }
  summaryRail.classList.remove("hidden");

  // Optimistic render: header + loading placeholder while we fetch.
  summaryRailBody.innerHTML = buildRailHeaderHtml(filePath, null);

  // Set Re-summarize button label by what we know up front.
  if (btnRailResummarizeLabel) btnRailResummarizeLabel.textContent = "Summarize";

  const token = ++railLoadToken;

  let summaryText = summaryStore.get(filePath);
  if (!summaryText) {
    try {
      const saved = await api.loadSummary(filePath, null);
      if (saved?.ok) {
        summaryStore.set(filePath, saved.text);
        summaryText = saved.text;
      }
    } catch (_) { /* leave summaryText undefined → no-summary state */ }
  }

  // A faster click may have switched files; drop stale results.
  if (token !== railLoadToken || activeMeetingId !== filePath) return;

  if (!summaryText) {
    summaryRailBody.innerHTML =
      buildRailHeaderHtml(filePath, { label: "Not generated", muted: true }) +
      buildNoSummaryHtml();
    if (btnRailResummarizeLabel) btnRailResummarizeLabel.textContent = "Summarize";
    return;
  }

  // Prefer the name of the preset that produced this summary (saved per file);
  // fall back to the render-mode status for summaries made before this existed.
  let presetName = null;
  try { presetName = localStorage.getItem("summary.prompt." + filePath); } catch (_) {}

  if (shouldRenderStructured(summaryText)) {
    const parsed = parseStructured(summaryText);
    // Empty sections render nothing, so a summary of nothing but headings comes
    // back as an empty string — show the raw markdown rather than a blank rail.
    const structured = parsed.fallback ? "" : buildStructuredHtml(parsed);
    if (structured) {
      summaryRailBody.innerHTML =
        buildRailHeaderHtml(filePath, presetName ? { label: presetName } : { label: "Structured" }) +
        buildRailWarningHtml(filePath) +
        structured;
      if (btnRailResummarizeLabel) btnRailResummarizeLabel.textContent = "Re-summarize";
      return;
    }
  }

  summaryRailBody.innerHTML =
    buildRailHeaderHtml(filePath, presetName ? { label: presetName } : { label: "Markdown", muted: true }) +
    buildRailWarningHtml(filePath) +
    buildMarkdownBodyHtml(summaryText);
  if (btnRailResummarizeLabel) btnRailResummarizeLabel.textContent = "Re-summarize";
}

// Re-summarize button → open the existing modal on the active meeting.
if (btnRailResummarize) {
  btnRailResummarize.addEventListener("click", () => {
    const fp = state.filePath;
    if (!fp) return;
    const m = getMeetingById(fp);
    openSummarizeModal(fp, m?.title || fp.split("/").pop());
  });
}

// Copy summary button → read file from disk and copy raw contents to clipboard.
const btnRailCopy = document.getElementById("btn-rail-copy");
if (btnRailCopy) {
  btnRailCopy.addEventListener("click", async () => {
    const fp = state.filePath;
    if (!fp) return;
    try {
      const saved = await api.loadSummary(fp, null);
      if (!saved?.ok || !saved.text) return;
      await navigator.clipboard.writeText(saved.text);
      const icon = btnRailCopy.querySelector("svg");
      if (icon) {
        btnRailCopy.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
        setTimeout(() => {
          btnRailCopy.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
        }, 1500);
      }
    } catch (_) {}
  });
}

// Edit summary button → swap the rail render for an inline textarea on the
// markdown body. The YAML frontmatter is kept aside verbatim and re-joined on
// save, so editing only ever touches the summary text, never the properties.
const btnRailEdit = document.getElementById("btn-rail-edit");
if (btnRailEdit) {
  btnRailEdit.addEventListener("click", async () => {
    const fp = state.filePath;
    if (!fp) return;

    let summaryText = summaryStore.get(fp);
    if (!summaryText) {
      try {
        const saved = await api.loadSummary(fp, getEffectiveFolder());
        if (saved?.ok && saved.text) {
          summaryStore.set(fp, saved.text);
          summaryText = saved.text;
        }
      } catch (_) { /* no summary → nothing to edit */ }
    }
    if (!summaryText || fp !== state.filePath) return;

    const { frontmatterRaw, body } = splitSummaryFrontmatter(summaryText);

    summaryRailBody.innerHTML =
      buildRailHeaderHtml(fp, { label: "Editing" }) +
      `<div class="rail-edit-actions">
        <button type="button" class="rail-edit-btn" id="rail-edit-cancel">Cancel</button>
        <button type="button" class="rail-edit-btn rail-edit-save" id="rail-edit-save">Save</button>
      </div>
      <textarea class="rail-edit-area" id="rail-edit-area" spellcheck="false"></textarea>`;

    const area = document.getElementById("rail-edit-area");
    area.value = body;
    area.focus();

    document.getElementById("rail-edit-cancel").addEventListener("click", () => {
      renderSummaryRail(fp);
    });

    document.getElementById("rail-edit-save").addEventListener("click", async () => {
      const editedBody = area.value;
      const newText = frontmatterRaw ? frontmatterRaw + "\n" + editedBody : editedBody;
      const btn = document.getElementById("rail-edit-save");
      if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
      try {
        const res = await api.overwriteSummary(fp, newText, getEffectiveFolder());
        if (res?.ok) {
          summaryStore.set(fp, newText);
          // Saved, but the YAML block is unusable — say so instead of letting an
          // unindexable note sit in the vault unnoticed. In the rail, not the
          // background toolbar: that one belongs to the summarize job and may be
          // mid-run on another file. The rail renders it from the warning store,
          // so it survives re-renders and cannot land on another file's rail.
          setSummaryWarning(fp, res.warning);
          if (fp === state.filePath) renderSummaryRail(fp);
        } else if (btn) {
          btn.disabled = false;
          btn.textContent = "Save";
        }
      } catch (_) {
        if (btn) { btn.disabled = false; btn.textContent = "Save"; }
      }
    });
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Follow-Up Draft Modal ────────────────────────────────────────────────────

const followupModal       = document.getElementById("followup-modal");
const followupViewLoading = document.getElementById("followup-view-loading");
const followupViewResult  = document.getElementById("followup-view-result");
const followupViewError   = document.getElementById("followup-view-error");
const followupResultText  = document.getElementById("followup-result-text");
const followupErrorText   = document.getElementById("followup-error-text");

function showFollowupView(name) {
  [followupViewLoading, followupViewResult, followupViewError].forEach((v) => {
    v.classList.toggle("hidden", v.id !== `followup-view-${name}`);
  });
}

function closeFollowupModal() {
  if (followupModal) followupModal.classList.add("hidden");
}

async function openFollowupModal(filePath) {
  if (!followupModal || !filePath) return;
  showFollowupView("loading");
  followupModal.classList.remove("hidden");

  const result = await api.draftFollowup(filePath);

  if (!result?.ok) {
    if (followupErrorText) followupErrorText.textContent = result?.error || "Unknown error.";
    showFollowupView("error");
    return;
  }

  if (followupResultText) followupResultText.value = result.summary || "";
  showFollowupView("result");
}

const btnRailFollowup = document.getElementById("btn-rail-followup");
if (btnRailFollowup) {
  btnRailFollowup.addEventListener("click", () => {
    const fp = state.filePath;
    if (!fp) return;
    openFollowupModal(fp);
  });
}

const followupModalClose = document.getElementById("followup-modal-close");
if (followupModalClose) followupModalClose.addEventListener("click", closeFollowupModal);

const followupBtnErrDone = document.getElementById("followup-btn-err-done");
if (followupBtnErrDone) followupBtnErrDone.addEventListener("click", closeFollowupModal);

if (followupModal) {
  followupModal.addEventListener("click", (e) => {
    if (e.target === followupModal) closeFollowupModal();
  });
}

const followupBtnEmail = document.getElementById("followup-btn-email");
if (followupBtnEmail) {
  followupBtnEmail.addEventListener("click", async () => {
    const text = followupResultText?.value;
    if (!text) return;
    await api.shareFollowup("email", text, false);
  });
}

const followupBtnSlack = document.getElementById("followup-btn-slack");
if (followupBtnSlack) {
  followupBtnSlack.addEventListener("click", async () => {
    const text = followupResultText?.value;
    if (!text) return;
    await api.shareFollowup("slack", text, false);
    makeCopyFeedback(followupBtnSlack, followupBtnSlack.innerHTML);
  });
}

const followupBtnTelegram = document.getElementById("followup-btn-telegram");
if (followupBtnTelegram) {
  followupBtnTelegram.addEventListener("click", async () => {
    const text = followupResultText?.value;
    if (!text) return;
    await api.shareFollowup("telegram", text, false);
    makeCopyFeedback(followupBtnTelegram, followupBtnTelegram.innerHTML);
  });
}

const followupBtnCopy = document.getElementById("followup-btn-copy-followup");
if (followupBtnCopy) {
  followupBtnCopy.addEventListener("click", async () => {
    const text = followupResultText?.value;
    if (!text) return;
    await api.shareFollowup("copy", text, false);
    makeCopyFeedback(followupBtnCopy, followupBtnCopy.innerHTML);
  });
}

// ─── Summary Share Modal ──────────────────────────────────────────────────────

const summaryShareModal    = document.getElementById("summary-share-modal");
const summaryShareText     = document.getElementById("summary-share-text");

function closeSummaryShareModal() {
  if (summaryShareModal) summaryShareModal.classList.add("hidden");
}

async function openSummaryShareModal(filePath) {
  if (!summaryShareModal || !filePath) return;
  let text = summaryStore.get(filePath);
  if (!text) {
    try {
      const saved = await api.loadSummary(filePath, null);
      if (saved?.ok) text = saved.text;
    } catch (_) {}
  }
  if (!text) return;
  if (summaryShareText) summaryShareText.value = text;
  summaryShareModal.classList.remove("hidden");
}

const btnRailShare = document.getElementById("btn-rail-share");
if (btnRailShare) {
  btnRailShare.addEventListener("click", () => {
    const fp = state.filePath;
    if (!fp) return;
    openSummaryShareModal(fp);
  });
}

const summaryShareModalClose = document.getElementById("summary-share-modal-close");
if (summaryShareModalClose) summaryShareModalClose.addEventListener("click", closeSummaryShareModal);

if (summaryShareModal) {
  summaryShareModal.addEventListener("click", (e) => {
    if (e.target === summaryShareModal) closeSummaryShareModal();
  });
}

function makeCopyFeedback(btn, origHTML) {
  btn.classList.add("done");
  btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
  setTimeout(() => { btn.innerHTML = origHTML; btn.classList.remove("done"); }, 1500);
}

// ─── Export to PDF / DOCX ───────────────────────────────────────────────────────
// Transcript export lives behind an "Export" dropdown in the editor toolbar;
// summary export lives inside the Share modal (PDF/DOCX buttons there).
const btnExport = document.getElementById("btn-export");
const exportMenuEditor = document.getElementById("export-menu-editor");

function closeExportMenus() {
  exportMenuEditor?.classList.add("hidden");
}

function toggleExportMenu(menu) {
  const willOpen = menu.classList.contains("hidden");
  closeExportMenus();
  if (willOpen) menu.classList.remove("hidden");
}

// Default download name derived from the open file: "<base>.pdf" for a
// transcript, "<base>-summary.pdf" for a summary (falls back when no file).
function exportDefaultName(kind, ext) {
  const fp = state.filePath;
  let base = fp
    ? fp.split("/").pop().split("\\").pop().replace(/\.[^.]+$/, "")
    : (kind === "summary" ? "summary" : "transcript");
  if (kind === "summary") base += "-summary";
  return `${base}.${ext}`;
}

// A clean derived title for DOCX headings.
function exportTitle() {
  const fp = state.filePath;
  if (!fp) return "";
  return fp.split("/").pop().split("\\").pop().replace(/\.[^.]+$/, "");
}

// Build a self-contained, light-themed HTML document for printToPDF.
function buildExportHtml(kind, text) {
  const bodyHtml = kind === "summary"
    ? `<div class="md">${renderMarkdown(parseFrontmatterFromMd(text).body)}</div>`
    : `<pre class="tr">${escapeHtml(text)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 32px; color: #1a1a1a; background: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 13px; line-height: 1.55; }
    h1 { font-size: 22px; margin: 0 0 12px; }
    h2 { font-size: 17px; margin: 20px 0 8px; }
    h3 { font-size: 14px; margin: 16px 0 6px; }
    p { margin: 0 0 10px; }
    ul { margin: 0 0 10px 20px; padding: 0; }
    li { margin: 2px 0; }
    blockquote { margin: 0 0 10px; padding: 4px 12px; border-left: 3px solid #ccc; color: #555; }
    code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
    /* renderMarkdown emits pipe tables, and this document does not load the
       renderer stylesheet — without these a scorecard prints borderless. */
    table { border-collapse: collapse; width: 100%; margin: 0 0 10px; font-size: 12px; }
    th { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid #999; }
    td { padding: 4px 8px 4px 0; border-bottom: 1px solid #e0e0e0; vertical-align: top; }
    pre.tr { white-space: pre-wrap; word-wrap: break-word;
      font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
  </style></head><body>${bodyHtml}</body></html>`;
}

async function getExportText(kind) {
  if (kind === "transcript") return editor.value || "";
  const fp = state.filePath;
  if (!fp) return "";
  let text = summaryStore.get(fp);
  if (!text) {
    try {
      const saved = await api.loadSummary(fp, null);
      if (saved?.ok) text = saved.text;
    } catch (_) { /* none */ }
  }
  return text || "";
}

// providedText lets the Share modal export exactly what's in its textarea;
// otherwise we fetch the canonical content (editor value / stored summary).
async function exportContent(kind, format, providedText) {
  let text = providedText != null ? providedText : await getExportText(kind);
  if (!text || !text.trim()) return null;
  // Summaries carry a YAML frontmatter block — strip it so both PDF and DOCX
  // render the same clean body.
  if (kind === "summary") text = parseFrontmatterFromMd(text).body;
  if (format === "pdf") {
    return api.exportPdf(buildExportHtml(kind, text), exportDefaultName(kind, "pdf"));
  }
  return api.exportDocx({ kind, text, title: exportTitle(), defaultName: exportDefaultName(kind, "docx") });
}

btnExport?.addEventListener("click", (e) => { e.stopPropagation(); toggleExportMenu(exportMenuEditor); });

exportMenuEditor?.querySelectorAll("[data-export]").forEach((item) => {
  item.addEventListener("click", async () => {
    closeExportMenus();
    const res = await exportContent(item.dataset.export, item.dataset.format);
    if (res?.ok && res.filePath) api.showInFinder(res.filePath);
  });
});

document.addEventListener("click", closeExportMenus);

const summaryShareBtnEmail = document.getElementById("summary-share-btn-email");
if (summaryShareBtnEmail) {
  summaryShareBtnEmail.addEventListener("click", async () => {
    const text = summaryShareText?.value;
    if (!text) return;
    await api.shareFollowup("email", text, true);
    closeSummaryShareModal();
  });
}

const summaryShareBtnSlack = document.getElementById("summary-share-btn-slack");
if (summaryShareBtnSlack) {
  summaryShareBtnSlack.addEventListener("click", async () => {
    const text = summaryShareText?.value;
    if (!text) return;
    await api.shareFollowup("slack", text, true);
    closeSummaryShareModal();
  });
}

const summaryShareBtnTelegram = document.getElementById("summary-share-btn-telegram");
if (summaryShareBtnTelegram) {
  summaryShareBtnTelegram.addEventListener("click", async () => {
    const text = summaryShareText?.value;
    if (!text) return;
    await api.shareFollowup("telegram", text, true);
    closeSummaryShareModal();
  });
}

const summaryShareBtnCopy = document.getElementById("summary-share-btn-copy");
if (summaryShareBtnCopy) {
  summaryShareBtnCopy.addEventListener("click", async () => {
    const text = summaryShareText?.value;
    if (!text) return;
    await api.shareFollowup("copy", text, false);
    makeCopyFeedback(summaryShareBtnCopy, summaryShareBtnCopy.innerHTML);
  });
}

// On a successful save: close the Share modal and reveal the file in Finder.
async function exportFromShareModal(format) {
  const text = summaryShareText?.value;
  if (!text) return;
  const res = await exportContent("summary", format, text);
  if (res?.ok && res.filePath) {
    closeSummaryShareModal();
    api.showInFinder(res.filePath);
  }
}

const summaryShareBtnPdf = document.getElementById("summary-share-btn-pdf");
if (summaryShareBtnPdf) {
  summaryShareBtnPdf.addEventListener("click", () => exportFromShareModal("pdf"));
}

const summaryShareBtnDocx = document.getElementById("summary-share-btn-docx");
if (summaryShareBtnDocx) {
  summaryShareBtnDocx.addEventListener("click", () => exportFromShareModal("docx"));
}

// ─── Sidebar wire-up: New, search, filter chips ──────────────────────────────
const meetingSearchInput = document.getElementById("meeting-search");
const meetingSearchClear = document.getElementById("meeting-search-clear");
const btnMeetingNew = document.getElementById("btn-meeting-new");

if (btnMeetingNew) btnMeetingNew.addEventListener("click", openNewModal);

if (meetingSearchInput) {
  meetingSearchInput.addEventListener("input", () => {
    meetingSearchClear?.classList.toggle("hidden", !meetingSearchInput.value);
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(async () => {
      searchQuery = meetingSearchInput.value.trim().toLowerCase();
      const token = ++searchToken;
      if (searchQuery.length >= 2) {
        const matches = await api.searchTranscripts(searchQuery);
        if (token !== searchToken) return; // a newer query superseded this one
        contentMatches = new Map((matches || []).map((r) => [r.filePath, r.snippet]));
      } else {
        contentMatches = new Map();
      }
      renderMeetings();
    }, 150);
  });
}

if (meetingSearchClear) {
  meetingSearchClear.addEventListener("click", () => {
    meetingSearchInput.value = "";
    meetingSearchInput.dispatchEvent(new Event("input"));
    meetingSearchInput.focus();
  });
}

document.querySelectorAll(".filter-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const filter = chip.dataset.filter;
    if (!filter || filter === activeFilter) return;
    activeFilter = filter;
    markActiveChip(filter);
    renderMeetings();
  });
});

// Init library
api.watchTranscripts();
loadLibrary();
api.onTranscriptsChanged(loadLibrary);
// Recordings are half the library now, so it has to watch their folder too.
// `record:watch` is idempotent in main, so the Record tab starting the same
// watcher costs nothing.
recApi?.watch();
recApi?.onListChanged(async () => {
  // fs.watch fires for every write, so a recording in progress reports a change
  // several times a second for as long as it runs. Only the file set matters
  // here; reloading on a growing wav would re-read every transcript on disk and
  // rebuild the whole list, over and over, for a card that did not change.
  const recs = await recApi.list().catch(() => []);
  if (recordingsSignature(recs) === lastRecordingsSig) return;
  loadLibrary(recs);
});

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showEditor() {
  emptyState.classList.add("hidden");
  audioOnlyState?.classList.add("hidden");
  editor.classList.remove("hidden");
  editorToolbar.classList.remove("hidden");
  btnSaveAs.disabled = false;
  btnExport.disabled = false;
}

// ─── Editor events ────────────────────────────────────────────────────────────
editor.addEventListener("input", () => {
  if (!state.isDirty && editor.value !== state.savedContent) setDirty(true);
  else if (state.isDirty && editor.value === state.savedContent)
    setDirty(false);
  scheduleAutosave();
  updateCancelBtn();
});

// Save-by-default: flush free-text edits to disk when focus leaves the editor,
// and as a safety net when the whole window loses focus (e.g. on quit).
// The watcher no longer reports our own writes, so refresh the sidebar here —
// once per editing session, when the user is done, instead of on every pause.
editor.addEventListener("blur", async () => {
  const hadEdits = !!state.filePath && editor.value !== state.savedContent;
  await autosave();
  if (hadEdits) loadLibrary();
});
window.addEventListener("blur", autosave);

// Teardown is the one place the async path cannot win: on ⌘Q the process can
// exit before an IPC round-trip resolves, so a pending debounce would be lost.
// Write synchronously here instead.
window.addEventListener("beforeunload", () => {
  clearTimeout(autosaveTimer);
  if (!state.filePath || editor.value === state.savedContent) return;
  const result = api.saveFileSync(state.filePath, editor.value);
  if (!result?.ok) console.error("Save on quit failed:", result?.error);
});

editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value =
      editor.value.slice(0, start) + "    " + editor.value.slice(end);
    editor.selectionStart = editor.selectionEnd = start + 4;
    // Assigning editor.value fires no "input" event, so the indent has to
    // register as an edit by hand — otherwise it never reaches disk and the
    // chip keeps claiming "Saved".
    setDirty(true);
    scheduleAutosave();
  }
});

// ─── Button events ────────────────────────────────────────────────────────────
btnOpen.addEventListener("click", openFile);
btnOpenEmpty.addEventListener("click", openFile);
btnSave.addEventListener("click", cancelChanges);
btnSaveAs.addEventListener("click", saveAsFile);
document.getElementById("btn-new-empty").addEventListener("click", openNewModal);

// Ask AI button (summary rail)
document.getElementById("btn-rail-ask-ai").addEventListener("click", () => {
  if (!state.filePath) return;
  const m = getMeetingById(state.filePath);
  openChatModal({ kind: "file", filePath: state.filePath }, m?.title || null);
});
document.getElementById("chat-modal-close").addEventListener("click", closeChatModal);
document.getElementById("chat-send-btn").addEventListener("click", sendChatMessage);
document.getElementById("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});
document.getElementById("chat-modal").addEventListener("click", (e) => {
  if (e.target === document.getElementById("chat-modal")) closeChatModal();
});

// ─── Menu events from main process ───────────────────────────────────────────
api.onMenuNew(() => openNewModal());
api.onMenuOpen(openFile);
api.onMenuSave(saveFile);
api.onMenuSaveAs(saveAsFile);

// ─── Drag & Drop ──────────────────────────────────────────────────────────────
document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dropOverlay.classList.remove("hidden");
});

dropOverlay.addEventListener("dragleave", (e) => {
  if (!dropOverlay.contains(e.relatedTarget))
    dropOverlay.classList.add("hidden");
});

dropOverlay.addEventListener("dragover", (e) => {
  e.preventDefault();
});

dropOverlay.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropOverlay.classList.add("hidden");
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadContent(file.path, reader.result);
  reader.readAsText(file);
});

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

// Anything layered over the editor: the six .modal-overlay modals plus the two
// popovers built in JS (meeting rename, speaker rename).
function anyOverlayOpen() {
  return !!document.querySelector(".modal-overlay:not(.hidden), .rename-overlay, .spk-rename, #meeting-meta-root, #transcribe-flow:not(.hidden)");
}

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "s") {
    e.preventDefault();
    e.shiftKey ? saveAsFile() : saveFile();
  }
  // These three open a modal, body-level like the ⋯ meeting menu's own
  // overlay — which only closes on Escape, an outside click, or picking an
  // item, none of which these shortcuts trigger. Left open, the new modal
  // renders underneath it, still covered by the overlay's click-swallowing
  // div. Closing it here is cheap: it is a popover, not state.
  if (mod && e.key === "o") {
    e.preventDefault();
    if (contextMenu) closeMeetingMenu();
    openFile();
  }
  if (mod && e.key === "n") {
    e.preventDefault();
    if (contextMenu) closeMeetingMenu();
    openNewModal();
  }
  if (mod && e.key === "k") {
    e.preventDefault();
    meetingSearchInput?.focus();
    meetingSearchInput?.select();
  }
  // Find within the open note — only on the Transcripts tab, with a note open
  // and nothing layered on top: modals and popovers are body-level, so the tab
  // stays visible behind them, and stealing focus from the speaker-rename
  // popover would commit a half-typed name on blur. Keyed off e.code so the
  // shortcut also works on a non-Latin layout, where ⌘F reports e.key === "а".
  if (mod && e.code === "KeyF" && !e.shiftKey && !e.altKey && state.filePath &&
      !document.getElementById("editor-container")?.classList.contains("hidden") &&
      !anyOverlayOpen()) {
    e.preventDefault();
    window.findInNote?.open();
  }
  if (mod && e.key === "r" && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    document.querySelector('.tab-btn[data-tab="record"]')?.click();
  }
  if (mod && e.key === "/") {
    e.preventDefault();
    if (state.filePath) {
      if (contextMenu) closeMeetingMenu();
      const m = getMeetingById(state.filePath);
      openChatModal({ kind: "file", filePath: state.filePath }, m?.title || null);
    }
  }
  if (e.key === "Escape" && !document.getElementById("chat-modal").classList.contains("hidden")) {
    closeChatModal();
  }
  // Escape closes the find bar from anywhere — clicking a match to seek the
  // audio moves focus out of the find input, and the shading has to go too.
  // Skipped while anything is layered on top: those have their own Escape
  // listeners, and one keypress must not close both.
  else if (e.key === "Escape" && window.findInNote?.isOpen() && !anyOverlayOpen()) {
    window.findInNote.close();
  }
});

// ─── OS file open (Finder / protocol / recent docs) ──────────────────────────
api.onFileOpened(async (data) => {
  if (!(await flushBeforeReplace())) return;
  // loadContent will sync activeMeetingId/activeLibraryPath + sidebar state.
  loadContent(data.filePath, data.content);
  // Only now does main own this path: window title, dirty marker, recent docs.
  api.fileAccepted(data.filePath);
});

// ─── Record tab finished a transcription (single file, or last of a batch) ───
// Jump to the Transcripts tab and open the freshly created transcript.
document.addEventListener("transcript:created", async (e) => {
  const filePath = e.detail?.filePath;
  if (!filePath) return;
  document.querySelector('.tab-btn[data-tab="editor"]')?.click();
  // Refresh the library first so the new file has a card by the time it opens —
  // otherwise renderTranscriptView's `carded` check (see transcriptMetaHtml)
  // misses it and the meta block renders inline instead of behind the card icon.
  await loadLibrary();
  api.openFromLibrary(filePath);
});

// ─── Summarize Modal ──────────────────────────────────────────────────────────

let modalCurrentFilePath = null;

const summarizeModal = document.getElementById("summarize-modal");
const modalTitleEl = document.getElementById("modal-title");
const modalViewPrompt = document.getElementById("modal-view-prompt");
const modalViewLoading = document.getElementById("modal-view-loading");
const modalViewResult = document.getElementById("modal-view-result");
const modalViewError = document.getElementById("modal-view-error");
const modalLoadingText = document.getElementById("modal-loading-text");
const modalLoadingFooter = document.getElementById("modal-loading-footer");
const modalLoadingStopBtn = document.getElementById("modal-btn-loading-stop");
const modalPromptInput = document.getElementById("modal-prompt-input");
const modalFolderLabel = document.getElementById("modal-folder-label");
const modalResultText = document.getElementById("modal-result-text");
const modalErrorText = document.getElementById("modal-error-text");
const modalPresetSegmented = document.getElementById("modal-preset-segmented");
const modalPromptCounter = document.getElementById("modal-prompt-counter");
const modalChipStrip = document.getElementById("modal-chip-strip");
const modalFooterHint = document.getElementById("modal-footer-hint");

function showModalView(view) {
  [modalViewPrompt, modalViewLoading, modalViewResult, modalViewError].forEach(
    (el) => el.classList.add("hidden"),
  );
  view.classList.remove("hidden");
}

const OVERFLOW_PRESET_IDS = ["retro", "project", "negotiations"];

// Sync aria-selected across all segments. The "More" segment counts as selected
// when the active preset lives in the overflow menu, and shows its name.
function syncPresetSegments(activeId) {
  const inOverflow = OVERFLOW_PRESET_IDS.includes(activeId);
  modalPresetSegmented.querySelectorAll(".preset-segment").forEach((btn) => {
    const id = btn.dataset.presetId;
    const selected = id === "__more" ? inOverflow : id === activeId;
    btn.setAttribute("aria-selected", selected ? "true" : "false");
  });
  const moreLabel = modalPresetSegmented.querySelector(".preset-more-label");
  if (moreLabel) {
    const p = inOverflow ? PROMPTS.find((x) => x.id === activeId) : null;
    moreLabel.textContent = p ? `More · ${p.name}` : "More";
  }
}

function selectModalPreset(presetId, { writeText = true } = {}) {
  syncPresetSegments(presetId);
  if (writeText && presetId !== "custom") {
    const preset = PROMPTS.find((p) => p.id === presetId);
    if (preset) {
      modalPromptInput.value = preset.text;
      updatePromptCounter();
    }
  }
  selectedCustomPromptId = null;
  try {
    localStorage.setItem("summarize.preset", presetId);
  } catch {}
}

function updatePromptCounter() {
  const v = modalPromptInput.value;
  const chars = v.length;
  const lines = v ? v.split("\n").length : 0;
  modalPromptCounter.textContent = `${chars.toLocaleString("en-US")} chars · ${lines} lines`;
}

function detectActivePreset() {
  const v = modalPromptInput.value;
  const match = PROMPTS.find((p) => p.text === v);
  return match ? match.id : "custom";
}

// Display name of a prompt by its text (defaults to the modal's current prompt)
// — stored per summary so the rail badge can show which preset produced it.
function activePresetName(text) {
  const v = (text != null ? text : modalPromptInput.value).trim();
  const builtin = PROMPTS.find((p) => p.text.trim() === v);
  if (builtin) return builtin.name;
  const custom = customPrompts.find((p) => p.text.trim() === v);
  return (custom && custom.name) || "Custom";
}

function renderModalChips(filePath) {
  if (!modalChipStrip) return;
  modalChipStrip.innerHTML = "";
  if (!filePath) return;
  const meeting =
    typeof getMeetingById === "function" ? getMeetingById(filePath) : null;
  const fileBase = filePath.split("/").pop();
  const chips = [];
  if (fileBase) chips.push(`📄 ${fileBase}`);
  if (meeting?.words) chips.push(`${meeting.words.toLocaleString("en-US")} words`);
  if (meeting?.speakers) chips.push(`${meeting.speakers} speakers`);
  if (meeting?.durationSec) {
    const m = Math.floor(meeting.durationSec / 60);
    const s = meeting.durationSec % 60;
    chips.push(`${m}m ${String(s).padStart(2, "0")}s`);
  }
  for (const text of chips) {
    const el = document.createElement("span");
    el.className = "modal-chip";
    el.textContent = text;
    modalChipStrip.appendChild(el);
  }
}

async function refreshFolderLabel() {
  const folder = await api.getSummaryFolder();
  modalFolderLabel.textContent = folder || "next to transcript";
  modalFolderLabel.title = folder || "";
}

function getEffectiveFolder() {
  return null;
}

let promptsReady = null;
async function loadCustomPrompts() {
  try {
    customPrompts = await api.listPrompts();
  } catch {
    customPrompts = [];
  }
  // Custom-prompts CRUD UI removed in redesign; data still loaded for compat.
}

// Fill the prompt textarea with the saved/default preset, without clobbering an
// in-progress prompt. Must run while #modal-view-prompt is visible — assigning
// .value while it's display:none leaves a Chromium <textarea> blank until the
// next edit. Called both on open and when returning to the prompt view from the
// result/error screens (where the modal opened straight into a saved summary and
// the textarea was never populated).
function populateModalPrompt() {
  const savedPreset = (() => {
    try {
      return localStorage.getItem("summarize.preset") || "meeting";
    } catch {
      return "meeting";
    }
  })();
  selectModalPreset(savedPreset, { writeText: false });
  if (!modalPromptInput.value) {
    const preset = PROMPTS.find((p) => p.id === savedPreset);
    modalPromptInput.value = preset ? preset.text : DEFAULT_PROMPT;
  }
  // Re-highlight to match actual textarea content.
  syncPresetSegments(detectActivePreset());
  updatePromptCounter();
}

async function openSummarizeModal(filePath, meetingTitle) {
  if (promptsReady) await promptsReady;
  modalCurrentFilePath = filePath;
  const cleanTitle = meetingTitle ? stripMeetPrefix(meetingTitle) : null;
  modalTitleEl.textContent = cleanTitle
    ? `Summarize — ${cleanTitle}`
    : "Summarize meeting";
  summarizeModal.classList.remove("hidden");

  // The loading footer's Stop button only applies to the in-flight branch
  // below; every other path (cache, disk, reset on next open) keeps it hidden.
  modalLoadingFooter.classList.add("hidden");
  modalLoadingText.textContent = "Reading the transcript…";

  // A job already running on this file wins over cache/disk — the header
  // panel may not be open, and this is then the only way back to it, instead
  // of landing on an empty prompt form mid-run.
  if (activeJobFor("summarize", filePath)) {
    modalLoadingText.textContent = "Summarizing…";
    showModalView(modalViewLoading);
    modalLoadingFooter.classList.remove("hidden");
    return;
  }

  // Try memory cache first
  if (summaryStore.has(filePath)) {
    if (typeof renderModalSummary === "function") {
      renderModalSummary(summaryStore.get(filePath), "");
    } else {
      modalResultText.innerHTML = simpleMarkdown(summaryStore.get(filePath));
    }
    showModalView(modalViewResult);
    return;
  }

  // Try loading from disk
  showModalView(modalViewLoading);
  const saved = await api.loadSummary(filePath, getEffectiveFolder());
  if (saved.ok) {
    summaryStore.set(filePath, saved.text);
    if (typeof renderModalSummary === "function") {
      renderModalSummary(saved.text, "");
    } else {
      modalResultText.innerHTML = simpleMarkdown(saved.text);
    }
    showModalView(modalViewResult);
    return;
  }

  renderModalChips(filePath);
  await refreshFolderLabel();
  showModalView(modalViewPrompt);
  populateModalPrompt();
}

function closeSummarizeModal() {
  summarizeModal.classList.add("hidden");
  modalCurrentFilePath = null;
}

// ─── Chat modal ───────────────────────────────────────────────────────────────

function openChatModal(target, meetingTitle) {
  chatHistory = [];
  chatTarget = target;
  const cleanTitle = meetingTitle ? stripMeetPrefix(meetingTitle) : null;
  document.getElementById("chat-modal-title").textContent = cleanTitle
    ? `Ask — ${cleanTitle}`
    : "Ask about this meeting";
  document.getElementById("chat-messages").innerHTML = "";
  const greeting = target?.kind === "live"
    ? "Hi! Ask me anything about this live meeting — I'll see everything transcribed so far on each question."
    : "Hi! Ask me anything about this meeting — decisions, action items, responsibilities, key topics.";
  appendChatMessage("assistant", greeting);
  document.getElementById("chat-modal").classList.remove("hidden");
  setTimeout(() => document.getElementById("chat-input").focus(), 50);
}

function closeChatModal() {
  document.getElementById("chat-modal").classList.add("hidden");
  chatHistory = [];
  chatTarget = null;
}

function appendChatMessage(role, text) {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = `chat-message chat-message--${role}`;
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = text;
  div.appendChild(bubble);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send-btn");
  const text = input.value.trim();
  if (!text || !chatTarget) return;

  // Resolve the transcript source NOW so the live tab includes anything
  // dictated up to this moment, not just what existed when the modal opened.
  let askPayload;
  if (chatTarget.kind === "file") {
    askPayload = chatTarget.filePath;
  } else if (chatTarget.kind === "live") {
    const snapshot = (chatTarget.getTranscript?.() || "").trim();
    if (!snapshot) {
      appendChatMessage("assistant", "Nothing transcribed yet — speak for a moment and try again.");
      return;
    }
    askPayload = { transcript: snapshot };
  } else {
    return;
  }

  appendChatMessage("user", text);
  chatHistory.push({ role: "user", content: text });
  input.value = "";
  input.disabled = true;
  sendBtn.disabled = true;
  sendBtn.textContent = "…";

  const typingEl = appendTypingIndicator();
  const result = await api.chatAsk(askPayload, chatHistory);
  typingEl.remove();

  input.disabled = false;
  sendBtn.disabled = false;
  sendBtn.textContent = "Ask";
  input.focus();

  if (result.ok) {
    appendChatMessage("assistant", result.reply);
    chatHistory.push({ role: "assistant", content: result.reply });
  } else {
    appendChatMessage("assistant", `Error: ${result.error}`);
    chatHistory.pop();
  }
}

// Bridge for the Live tab — kept narrow so live.js never touches the
// internal chatTarget shape or the editor-tab state.
window.appChat = {
  openLive(title, getTranscript) {
    openChatModal({ kind: "live", getTranscript }, title);
  },
};

function appendTypingIndicator() {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "chat-message chat-message--assistant";
  div.innerHTML = `<div class="chat-bubble chat-typing"><span></span><span></span><span></span></div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}


function simpleMarkdown(text) {
  return `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(text)}</pre>`;
}

// Split a summary into the verbatim YAML frontmatter block and the markdown
// body. Unlike parseFrontmatterFromMd this keeps the frontmatter as raw text so
// editing the body can re-join it untouched (no YAML round-trip).
function splitSummaryFrontmatter(md) {
  const text = String(md || "");
  if (!text.startsWith("---")) return { frontmatterRaw: "", body: text };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { frontmatterRaw: "", body: text };
  const frontmatterRaw = text.slice(0, end + 4); // "---\n<block>\n---"
  const body = text.slice(end + 4).replace(/^\s*\n/, "");
  return { frontmatterRaw, body };
}

function parseFrontmatterFromMd(md) {
  const text = String(md || "");
  if (!text.startsWith("---")) return { frontmatter: null, body: text };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: null, body: text };
  const block = text.slice(4, end).trim();
  const body = text.slice(end + 4).replace(/^\s*\n/, "");
  const rows = [];
  let current = null;
  for (const line of block.split("\n")) {
    // YAML list item under the previous key: "  - value".
    const li = line.match(/^\s+-\s+(.*)$/);
    if (li && current) {
      const v = li[1].trim().replace(/^["'](.*)["']$/, "$1");
      if (v) (current.items ||= []).push(v);
      continue;
    }
    // `key: value` line (top-level only — leading whitespace means continuation).
    const m = line.match(/^([^:\s][^:]*):\s*(.*)$/);
    if (m) {
      const rawVal = m[2].trim();
      // Flatten inline arrays like `tags: [a, b, c]` into items.
      const inline = rawVal.match(/^\[(.*)\]$/);
      current = { key: m[1].trim(), value: inline ? "" : rawVal };
      if (inline) {
        current.items = inline[1]
          .split(",")
          .map((s) => s.trim().replace(/^["'](.*)["']$/, "$1"))
          .filter(Boolean);
      }
      rows.push(current);
    }
  }
  return { frontmatter: rows, body };
}

function renderFrontmatterTable(rows) {
  if (!rows?.length) return "";
  const tagKeys = new Set(["tags", "tag"]);
  const cells = rows
    .map((r) => {
      const isTag = tagKeys.has(r.key.toLowerCase());
      let val;
      if (r.items?.length) {
        const cls = isTag ? "fm-tag" : "fm-chip";
        val = r.items
          .map((it) => `<span class="${cls}">${escapeHtml(it)}</span>`)
          .join(" ");
      } else if (r.value) {
        val = isTag
          ? `<span class="fm-tag">${escapeHtml(r.value)}</span>`
          : escapeHtml(r.value);
      } else {
        val = `<span class="fm-empty">—</span>`;
      }
      return `<tr><td class="fm-key">${escapeHtml(r.key)}</td><td>${val}</td></tr>`;
    })
    .join("");
  return `<table class="fm-table"><tbody>${cells}</tbody></table>`;
}

// Render a markdown table (e.g. the interview Scorecard) into modal styling.
function renderModalTable(lines) {
  const rows = [];
  for (const l of lines || []) {
    const t = l.trim();
    if (!t.startsWith("|")) continue;
    if (/^\|[-:| ]+\|/.test(t)) continue; // separator row
    rows.push(t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  }
  if (!rows.length) return "";
  const [header, ...body] = rows;
  const ths = header.map((h) => `<th>${renderMarkdownInline(h)}</th>`).join("");
  const trs = body
    .map((r) => `<tr>${r.map((c) => `<td>${renderMarkdownInline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="smr-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

function renderModalSection(sec) {
  const heading = `<h3 class="smr-section-heading">${escapeHtml(sec.heading)}</h3>`;
  if (sec.slug === "action_items") {
    const items =
      typeof parseActionItems === "function"
        ? parseActionItems(sec.lines)
        : null;
    if (items?.length) {
      const lis = items
        .map((it) => {
          const who = it.who ? `<strong>${escapeHtml(it.who)}</strong> — ` : "";
          const what = renderMarkdownInline(it.what || "");
          const due = it.due
            ? ` <em style="color:var(--text-muted)">(due: ${escapeHtml(it.due)})</em>`
            : "";
          return `<li><span class="smr-action-checkbox">☐</span> ${who}${what}${due}</li>`;
        })
        .join("");
      return `<section class="smr-section">${heading}<ul class="smr-list">${lis}</ul></section>`;
    }
  }
  // Markdown tables (e.g. the interview Scorecard) get table styling.
  if ((sec.lines || []).some((l) => l.trim().startsWith("|"))) {
    const table = renderModalTable(sec.lines);
    if (table) return `<section class="smr-section">${heading}${table}</section>`;
  }
  // Everything else: full markdown — paragraphs, ### sub-headings, lists,
  // blockquotes, and inline **bold** / *italic* / `code`.
  const body = renderMarkdown((sec.lines || []).join("\n").trim());
  return `<section class="smr-section">${heading}<div class="smr-md">${body}</div></section>`;
}

function renderModalSummary(md, subtitleText) {
  const subtitleEl = document.getElementById("modal-result-subtitle");
  if (subtitleEl) subtitleEl.textContent = subtitleText || "";
  const bodyEl = document.getElementById("modal-result-body");
  const cacheEl = document.getElementById("modal-result-text");
  if (cacheEl) cacheEl.textContent = md || "";
  if (!bodyEl) return;

  const { frontmatter, body } = parseFrontmatterFromMd(md);
  let html = renderFrontmatterTable(frontmatter);

  let structured = null;
  if (typeof parseStructured === "function") {
    const parsed = parseStructured(body);
    if (!parsed.fallback) structured = parsed;
  }
  if (structured) {
    for (const sec of structured.sections) {
      html += renderModalSection(sec);
    }
  } else {
    html += `<pre class="modal-result-text" style="white-space:pre-wrap;margin:0">${escapeHtml(body)}</pre>`;
  }
  bodyEl.innerHTML = html;
}

function buildResultSubtitle(meta) {
  if (!meta) return "";
  const parts = [];
  if (meta.provider) parts.push(meta.provider);
  if (meta.durationMs) parts.push(`${Math.round(meta.durationMs / 1000)}s`);
  if (meta.tokens) parts.push(`${meta.tokens} tokens`);
  return parts.join(" · ");
}

const PROVIDER_LOADING_TEXT = {
  "claude-code": "Claude is reading the transcript…",
  openrouter:   "OpenRouter is reading the transcript…",
  ollama:       "Ollama is reading the transcript…",
};

// ─── Job queue (transcribe / enhance / summarize) ─────────────────────────────
// One queue in main owns every long-running run; this is the panel that shows
// it. Submitting always succeeds — there is no more "already running" refusal
// anywhere below, and no more shared bottom-right toolbar arbitrating Enhance
// against Summarize. `queueJobs` is refreshed on every `queue:changed`
// broadcast and is the single source of truth for "is X running on file Y".
let queueJobs = [];

// jobId → what to do once that job settles (done/failed/canceled). Enhance
// reloads the editor with the result; Summarize saves it to disk — neither
// side effect lives in main, so the renderer still has to run it once the
// job is known to have finished. Keyed by jobId (not filePath) so a re-submit
// of the same file — a fresh job with a fresh id — can't be confused with a
// stale one still being watched.
const pendingEnhance = new Map();
const pendingSummarize = new Map();

function activeJobFor(type, filePath) {
  return queueJobs.find(
    (j) => j.type === type && j.filePath === filePath && (j.status === "queued" || j.status === "running")
  );
}

// Read-only for the duration of an Enhance on the file currently open:
// otherwise a keystroke at the wrong moment either kills the run (the file no
// longer matches what was read) or survives as a dirty buffer whose autosave
// writes the pre-enhance text back over the finished result.
function syncEditorReadOnly() {
  editor.readOnly = Boolean(state.filePath && activeJobFor("enhance", state.filePath));
}

// ─── Header panel ──────────────────────────────────────────────────────────
const queueIndicatorBtn = document.getElementById("queue-indicator-btn");
const queueIndicatorBadge = document.getElementById("queue-indicator-badge");
const queuePanel = document.getElementById("queue-panel");
const queuePanelList = document.getElementById("queue-panel-list");

const JOB_TYPE_LABEL = { transcribe: "Transcribe", enhance: "Enhance", summarize: "Summarize" };

function jobStatusText(job) {
  if (job.status === "queued") return "Waiting…";
  if (job.status === "running") {
    if (job.canceling) return "Stopping…";
    if (job.type === "enhance" && job.progress?.phase === "speakers") {
      return "Identifying speakers…";
    }
    if (job.type === "enhance" && job.progress?.total) {
      return `Enhancing — part ${job.progress.done + 1} of ${job.progress.total}`;
    }
    if (job.type === "transcribe" && job.progress?.label) return job.progress.label;
    return `${JOB_TYPE_LABEL[job.type] || job.type}…`;
  }
  if (job.status === "canceled") return "Stopped";
  if (job.status === "failed") return job.error || "Failed";
  // done — "generated", not "ready": Summarize's actual disk write is a
  // separate renderer-side step (finishSummarize) that can fail or, on a
  // reload, never run at all — this job status only means the model call
  // itself succeeded.
  if (job.type === "enhance") {
    const named = job.result?.namedSpeakers
      ? `, ${job.result.namedSpeakers} speaker${job.result.namedSpeakers > 1 ? "s" : ""} named`
      // Distinct from silence: placeholders were left unnamed on purpose,
      // not indistinguishable from "nothing needed naming".
      : job.result?.speakerNamingFailed
        ? ", speaker naming failed"
        : "";
    return (job.result?.changed === false ? "Nothing to fix" : "Enhanced") + named;
  }
  if (job.type === "summarize") return "Summary generated";
  return "Done";
}

// Cheap, always runs: the indicator/badge must reflect reality even while
// the panel itself is closed (in particular, a background FAILURE has to
// stay visible until dismissed — that's the whole point of this feature).
function renderQueueBadge() {
  const active = queueJobs.filter((j) => j.status === "queued" || j.status === "running");
  const failed = queueJobs.filter((j) => j.status === "failed");
  const showBadge = active.length > 0 || failed.length > 0;
  queueIndicatorBadge.classList.toggle("hidden", !showBadge);
  queueIndicatorBadge.classList.toggle("queue-indicator-badge--danger", active.length === 0 && failed.length > 0);
  queueIndicatorBadge.textContent = String(active.length > 0 ? active.length : failed.length);
}

// Full row rebuild — resets scroll position, so this only runs while the
// panel is actually visible (see renderQueuePanel) or right as it opens.
function renderQueueList() {
  if (!queueJobs.length) {
    queuePanelList.innerHTML = '<li class="queue-panel-empty">Nothing running</li>';
    return;
  }
  const scrollTop = queuePanelList.scrollTop;
  // Most recent first — what's currently happening belongs at the top.
  const ordered = [...queueJobs].sort((a, b) => b.createdAt - a.createdAt);
  queuePanelList.innerHTML = ordered
    .map((job) => {
      const cancelable = job.status === "queued" || (job.status === "running" && !job.canceling);
      const dismissable = !cancelable && job.status !== "running";
      const typeLabel = escapeHtml(JOB_TYPE_LABEL[job.type] || job.type);
      const title = escapeHtml(job.title || job.filePath);
      const actionBtn = cancelable
        ? '<button class="btn btn-ghost queue-job-cancel" data-action="cancel" type="button">Cancel</button>'
        : dismissable
          ? '<button class="btn btn-ghost queue-job-cancel" data-action="dismiss" type="button" title="Dismiss">✕</button>'
          : "";
      const statusText = escapeHtml(jobStatusText(job));
      return `
        <li class="queue-job" data-status="${job.status}" data-job-id="${escapeHtml(job.id)}">
          <div class="queue-job-row1">
            <span class="queue-job-title" title="${title}">${typeLabel} — ${title}</span>
            ${actionBtn}
          </div>
          <div class="queue-job-meta" title="${statusText}">${statusText}</div>
        </li>`;
    })
    .join("");
  queuePanelList.scrollTop = scrollTop;
}

function renderQueuePanel() {
  renderQueueBadge();
  // A progress tick fires this on every chunk of every running job — full
  // innerHTML rebuilds are cheap enough, but resetting scroll position on
  // every one of them while the user is reading the list is not. Only pay
  // for it while the panel is open; openQueuePanel() renders fresh on open.
  if (!queuePanel.classList.contains("hidden")) renderQueueList();
}

queuePanelList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const jobId = btn.closest(".queue-job")?.dataset.jobId;
  if (!jobId) return;
  if (btn.dataset.action === "cancel") jobsApi.cancel(jobId);
  else if (btn.dataset.action === "dismiss") jobsApi.dismiss(jobId);
});

function openQueuePanel() {
  renderQueueList();
  queuePanel.classList.remove("hidden");
  queueIndicatorBtn.setAttribute("aria-expanded", "true");
}
function closeQueuePanel() {
  queuePanel.classList.add("hidden");
  queueIndicatorBtn.setAttribute("aria-expanded", "false");
}
queueIndicatorBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (queuePanel.classList.contains("hidden")) openQueuePanel();
  else closeQueuePanel();
});
document.addEventListener("click", (e) => {
  if (queuePanel.classList.contains("hidden")) return;
  if (queueIndicatorBtn.contains(e.target) || queuePanel.contains(e.target)) return;
  closeQueuePanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !queuePanel.classList.contains("hidden")) closeQueuePanel();
});
// record.js's "View queue" button (idle-screen banner) opens this same panel
// — the mirror of window.recordTab, which app.js calls the other way.
// Deferred by a tick on purpose: the caller's own click is still bubbling
// toward the outside-click handler above, and that handler counts any target
// outside the indicator as "outside" — so opening synchronously opened and
// closed the panel in the same click, which read as the button doing nothing.
window.queuePanel = { open: () => setTimeout(openQueuePanel, 0) };

// ─── Enhance (LLM proofreading pass over the transcript) ─────────────────────
// Overwrites the transcript in place: no diff to confirm, no second copy. The
// safety net is in main — every turn keeps its original marker, and a chunk the
// model mangles is left exactly as it was.
function finishEnhance(info, job) {
  const result = job.result || (job.error ? { ok: false, error: job.error } : { ok: false });
  if (!result.ok) return; // failed/canceled — the panel row already shows why

  // Load the new text straight into the editor rather than reopening the file:
  // the reopen path flushes the editor first, and a keystroke landing during the
  // IPC round-trip would put the pre-enhance buffer back on disk.
  const onScreen = state.filePath === info.filePath;
  const reloaded = onScreen && !state.isDirty && typeof result.content === "string";
  if (reloaded) {
    // Keep the baseline pointing at the pre-Enhance text: "Cancel changes" is the
    // only undo this feature has, and loadContent would move it to the new text.
    const baseline = state.baselineContent;
    loadContent(info.filePath, result.content);
    state.baselineContent = baseline;
    updateCancelBtn();
  }
}

async function runEnhance(m) {
  // flushBeforeReplace, not saveFile: a keystroke landing during the save leaves
  // a remainder that saveFile only schedules, and that autosave would then change
  // the file a second into the run and cost the whole pass.
  if (state.filePath === m.id && !(await flushBeforeReplace())) return;

  let result;
  try {
    result = await api.enhanceTranscript(m.id);
  } catch (err) {
    result = { ok: false, error: err?.message || String(err) };
  }
  if (!result?.ok) {
    console.error("Enhance: could not submit job:", result?.error);
    return;
  }
  pendingEnhance.set(result.jobId, { filePath: m.id, title: m.title });
  // Lock immediately — don't wait for the queue:changed round-trip, or a
  // keystroke in that gap races the run that just started reading this file.
  if (state.filePath === m.id) editor.readOnly = true;
}

// ─── Summarize ────────────────────────────────────────────────────────────────
async function finishSummarize(info, job) {
  const { filePath, meetingTitle, instruction, folder, customName } = info;
  const result = job.result || (job.error ? { ok: false, error: job.error } : { ok: false });
  const modalOnThisFile = !summarizeModal.classList.contains("hidden") && modalCurrentFilePath === filePath;

  if (result?.notInstalled) {
    if (modalOnThisFile) {
      modalErrorText.innerHTML =
        "<strong>Claude Code not found.</strong><br>" +
        "Install it from <strong>claude.ai/code</strong>, or switch the summarizer in <strong>Settings</strong>.";
      showModalView(modalViewError);
    }
    return;
  }
  if (!result?.ok) {
    if (modalOnThisFile) {
      modalErrorText.textContent = result?.canceled
        ? "Summary stopped — nothing was written."
        : (result?.error || "Summarization failed.");
      showModalView(modalViewError);
    }
    return;
  }

  // Fences and frontmatter are already normalized in main (summarize:run).
  const summaryText = result.summary;

  try { localStorage.setItem("summary.prompt." + filePath, activePresetName(instruction)); } catch (_) {}

  if (customName) await api.setSummaryName(filePath, customName);
  const saved = await api.saveSummary(filePath, summaryText, folder);
  if (!saved?.ok) {
    if (modalOnThisFile) {
      modalErrorText.textContent = saved?.error || "Could not save summary.";
      showModalView(modalViewError);
    }
    return;
  }

  // After the write, not before — otherwise a failed save leaves the rail and
  // the result modal rendering a summary that is not on disk.
  summaryStore.set(filePath, summaryText);
  setSummaryWarning(filePath, saved.warning);

  // Reflect the new summary on the matching sidebar card.
  const meeting = getMeetingById(filePath);
  if (meeting) {
    meeting.hasSummary = true;
    meeting.status = deriveStatus(meeting);
    renderMeetings();
  }

  // Re-render the rail if the summarized file is the one currently open.
  if (state.filePath === filePath) renderSummaryRail(filePath);

  // Re-render whatever's on screen for this file — summaryStore is warm now,
  // so this lands straight on the result view.
  if (modalOnThisFile) openSummarizeModal(filePath, meetingTitle);
}

// Shared by the panel's per-job Cancel button and the modal's own Stop button.
function stopSummarizeWithFeedback() {
  const job = activeJobFor("summarize", modalCurrentFilePath);
  if (job) jobsApi.cancel(job.id);
}

async function runSummarize() {
  const filePath = modalCurrentFilePath;
  const instruction = modalPromptInput.value.trim();
  if (!filePath || !instruction) return;

  const titleText = modalTitleEl.textContent || "";
  const meetingTitle = titleText.startsWith("Summarize — ")
    ? titleText.slice("Summarize — ".length)
    : "";
  const folder = getEffectiveFolder();
  const customName = null;

  closeSummarizeModal();

  let result;
  try {
    result = await api.summarize(filePath, instruction);
  } catch (err) {
    result = { ok: false, error: err?.message || String(err) };
  }
  if (!result?.ok) {
    console.error("Summarize: could not submit job:", result?.error);
    return;
  }
  pendingSummarize.set(result.jobId, { filePath, meetingTitle, instruction, folder, customName });
}

// Transcribe and Enhance are the two jobs that write provenance (`Model:` /
// `Enhanced:`) into a transcript header, and Enhance's write suppresses the
// library watcher's own broadcast (main.js stamps lastSelfWrite for it) — so the
// list has to be refreshed from here, or the new chips only appear on the next
// unrelated reload. Terminal jobs stay in the panel until dismissed, so refresh
// on the transition and remember which ids were already handled.
const provenanceSeen = new Set();

// ─── Wiring: one broadcast drives the panel and both finish-handlers ─────────
function onQueueChanged(jobs) {
  queueJobs = jobs;
  renderQueuePanel();
  syncEditorReadOnly();
  const presentIds = new Set(jobs.map((j) => j.id));
  let refreshLibrary = false;
  for (const job of jobs) {
    if (job.status === "queued" || job.status === "running") continue;
    if ((job.type === "transcribe" || job.type === "enhance") && !provenanceSeen.has(job.id)) {
      provenanceSeen.add(job.id);
      refreshLibrary = true;
    }
    if (job.type === "enhance" && pendingEnhance.has(job.id)) {
      const info = pendingEnhance.get(job.id);
      pendingEnhance.delete(job.id);
      finishEnhance(info, job);
    } else if (job.type === "summarize" && pendingSummarize.has(job.id)) {
      const info = pendingSummarize.get(job.id);
      pendingSummarize.delete(job.id);
      finishSummarize(info, job);
    }
  }
  // A job canceled while still queued is dropped outright, not marked
  // (job-queue.js) — it never appears above with a terminal status, so a
  // pending Enhance/Summarize for it would otherwise wait forever with no
  // "stopped" feedback and never clean up its own map entry.
  if (pendingEnhance.size) {
    const canceledJob = { result: { ok: false, canceled: true }, error: null };
    for (const [jobId, info] of pendingEnhance) {
      if (presentIds.has(jobId)) continue;
      pendingEnhance.delete(jobId);
      finishEnhance(info, canceledJob);
    }
  }
  if (pendingSummarize.size) {
    const canceledJob = { result: { ok: false, canceled: true }, error: null };
    for (const [jobId, info] of pendingSummarize) {
      if (presentIds.has(jobId)) continue;
      pendingSummarize.delete(jobId);
      finishSummarize(info, canceledJob);
    }
  }
  // Job ids are never reused, so a dismissed job can be forgotten outright.
  for (const jobId of provenanceSeen) {
    if (!presentIds.has(jobId)) provenanceSeen.delete(jobId);
  }
  // Last: finishEnhance above may have reloaded the editor, and loadLibrary only
  // rebuilds the meetings list, so the order between them does not matter — but
  // one refresh per broadcast does.
  if (refreshLibrary) loadLibrary();
}
jobsApi.onChanged(onQueueChanged);
jobsApi.list().then(onQueueChanged);

// ── Preset segmented control ─────────────────────────────────────────────────
const presetMenu = document.getElementById("modal-preset-menu");
const presetMoreBtn = modalPresetSegmented.querySelector('[data-preset-id="__more"]');

function closePresetMenu() {
  if (!presetMenu) return;
  presetMenu.classList.add("hidden");
  if (presetMoreBtn) presetMoreBtn.setAttribute("aria-expanded", "false");
}
function togglePresetMenu() {
  if (!presetMenu) return;
  if (presetMenu.classList.contains("hidden")) {
    presetMenu.classList.remove("hidden");
    if (presetMoreBtn) presetMoreBtn.setAttribute("aria-expanded", "true");
  } else {
    closePresetMenu();
  }
}

modalPresetSegmented.addEventListener("click", (e) => {
  const item = e.target.closest(".preset-menu-item");
  if (item) {
    selectModalPreset(item.dataset.presetId);
    closePresetMenu();
    return;
  }
  const btn = e.target.closest(".preset-segment");
  if (!btn) return;
  if (btn.dataset.presetId === "__more") {
    togglePresetMenu();
    return;
  }
  selectModalPreset(btn.dataset.presetId);
  closePresetMenu();
});

// Close the overflow menu on outside click or Escape.
document.addEventListener("click", (e) => {
  if (presetMenu && !presetMenu.classList.contains("hidden") && !e.target.closest(".preset-more-wrap")) {
    closePresetMenu();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && presetMenu && !presetMenu.classList.contains("hidden")) {
    closePresetMenu();
  }
});

modalPromptInput.addEventListener("input", () => {
  updatePromptCounter();
  syncPresetSegments(detectActivePreset());
});

// ── Folder picker ─────────────────────────────────────────────────────────────
document
  .getElementById("modal-btn-change-folder")
  .addEventListener("click", async () => {
    const result = await api.setSummaryFolder();
    if (result?.ok) {
      modalFolderLabel.textContent = result.folder;
      modalFolderLabel.title = result.folder;
    }
  });

// ── Modal event listeners ─────────────────────────────────────────────────────
document
  .getElementById("modal-close")
  .addEventListener("click", closeSummarizeModal);
document
  .getElementById("modal-btn-cancel")
  .addEventListener("click", closeSummarizeModal);
document
  .getElementById("modal-btn-done")
  .addEventListener("click", closeSummarizeModal);
document
  .getElementById("modal-btn-err-done")
  .addEventListener("click", closeSummarizeModal);

document
  .getElementById("modal-btn-run")
  .addEventListener("click", runSummarize);

document.getElementById("modal-btn-back").addEventListener("click", () => {
  showModalView(modalViewPrompt);
  populateModalPrompt();
});
// Same job the toolbar's Stop button cancels — the modal is just the other
// way to reach it once the toolbar has been dismissed.
modalLoadingStopBtn.addEventListener("click", () => {
  stopSummarizeWithFeedback();
  closeSummarizeModal();
});
document.getElementById("modal-btn-err-back").addEventListener("click", () => {
  showModalView(modalViewPrompt);
  populateModalPrompt();
});

document.getElementById("modal-btn-copy").addEventListener("click", () => {
  const cached = document.getElementById("modal-result-text");
  const text =
    summaryStore.get(modalCurrentFilePath) ||
    (cached ? cached.textContent : "") ||
    "";
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById("modal-btn-copy");
    btn.textContent = "✓ Copied!";
    setTimeout(() => {
      btn.textContent = "Copy";
    }, 2000);
  });
});

// "Save & open" — save current summary, then reveal in Finder.
const modalBtnSaveOpen = document.getElementById("modal-btn-save-open");
if (modalBtnSaveOpen) {
  modalBtnSaveOpen.addEventListener("click", async () => {
    const filePath = modalCurrentFilePath;
    if (!filePath) return;
    const text = summaryStore.get(filePath);
    if (!text) return;
    try {
      const folder = getEffectiveFolder();
      const res = await api.saveSummary(filePath, text, folder);
      if (!res?.ok) {
        console.error("Save & open: save failed", res?.error);
        return;
      }
      // Same warning the rail editor surfaces. The result view's subtitle is
      // where the user is looking when they click this button, but showInFinder
      // takes the focus out of the app a line later and the next render resets
      // it — so record it on the rail too, where it stays.
      setSummaryWarning(filePath, res.warning);
      if (res.warning) {
        const subtitleEl = document.getElementById("modal-result-subtitle");
        if (subtitleEl) subtitleEl.textContent = res.warning;
      }
      if (filePath === state.filePath) renderSummaryRail(filePath);
      if (res.filePath) {
        await api.showInFinder(res.filePath);
      }
    } catch (err) {
      console.error("Save & open failed", err);
    }
  });
}

// Close on backdrop click or Escape
summarizeModal.addEventListener("click", (e) => {
  if (e.target === summarizeModal) closeSummarizeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !summarizeModal.classList.contains("hidden")) {
    closeSummarizeModal();
  }
});

// ─── New Transcript Modal ────────────────────────────────────────────────────

const newModal = document.getElementById("new-modal");
const newTitleInput = document.getElementById("new-title-input");
const newParticipantsInput = document.getElementById("new-participants-input");
const newContentInput = document.getElementById("new-content-input");
const newModalError = document.getElementById("new-modal-error");

function openNewModal() {
  newTitleInput.value = "";
  newParticipantsInput.value = "";
  newContentInput.value = "";
  newModalError.classList.add("hidden");
  newModalError.textContent = "";
  newModal.classList.remove("hidden");
  setTimeout(() => newTitleInput.focus(), 0);
}

function closeNewModal() {
  newModal.classList.add("hidden");
}

async function createNewTranscript({ openSummarize }) {
  const title = newTitleInput.value.trim();
  const content = newContentInput.value;
  const participants = newParticipantsInput.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!title) {
    newModalError.textContent = "Please enter a title.";
    newModalError.classList.remove("hidden");
    newTitleInput.focus();
    return;
  }
  if (!content.trim()) {
    newModalError.textContent = "Please paste or type the transcript content.";
    newModalError.classList.remove("hidden");
    newContentInput.focus();
    return;
  }

  const result = await api.createTranscript({ title, content, participants });
  if (!result?.ok) {
    newModalError.textContent = result?.error || "Could not create transcript.";
    newModalError.classList.remove("hidden");
    return;
  }

  closeNewModal();

  // Library refreshes via fs.watch; also open the file immediately.
  setActiveMeetingId(result.filePath);
  await api.openFromLibrary(result.filePath);

  if (openSummarize) {
    await loadLibrary();
    openSummarizeModal(result.filePath, title);
  }
}

document
  .getElementById("new-modal-close")
  .addEventListener("click", closeNewModal);
document
  .getElementById("new-modal-cancel")
  .addEventListener("click", closeNewModal);
document
  .getElementById("new-modal-create")
  .addEventListener("click", () => createNewTranscript({ openSummarize: false }));
document
  .getElementById("new-modal-create-summarize")
  .addEventListener("click", () => createNewTranscript({ openSummarize: true }));

// Pre-fill title + participants from the macOS calendar (button hides itself
// on non-macOS via calendarPicker.attach).
window.calendarPicker?.attach({
  button: document.getElementById("new-cal-btn"),
  onPick: ({ title, participants }) => {
    if (title) newTitleInput.value = title;
    if (participants && participants.length) {
      newParticipantsInput.value = participants.join(", ");
    }
  },
});

newModal.addEventListener("click", (e) => {
  if (e.target === newModal) closeNewModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !newModal.classList.contains("hidden")) {
    closeNewModal();
  }
  if (
    (e.metaKey || e.ctrlKey) &&
    e.key === "Enter" &&
    !newModal.classList.contains("hidden")
  ) {
    e.preventDefault();
    createNewTranscript({ openSummarize: true });
  }
});

// ─── Settings Modal ───────────────────────────────────────────────────────────

const settingsModal = document.getElementById("settings-modal");
const settingsError = document.getElementById("settings-error");
const settingsSectionOpenRouter = document.getElementById("settings-section-openrouter");
const settingsSectionOllama = document.getElementById("settings-section-ollama");
const settingsSectionOpenAI = document.getElementById("settings-section-openai");
const settingsOrKey = document.getElementById("settings-or-key");
const settingsOrModel = document.getElementById("settings-or-model");
const settingsOrUrl = document.getElementById("settings-or-url");
const settingsOlUrl = document.getElementById("settings-ol-url");
const settingsOlModel = document.getElementById("settings-ol-model");
const settingsOaiUrl = document.getElementById("settings-oai-url");
const settingsOaiKey = document.getElementById("settings-oai-key");
const settingsOaiModel = document.getElementById("settings-oai-model");
const settingsGlossary = document.getElementById("settings-glossary");
const settingsPresetBtns = document.querySelectorAll(".settings-preset");
const settingsProviderRadios = document.querySelectorAll(
  'input[name="settings-provider"]',
);

function updateSettingsSections() {
  const provider = document.querySelector(
    'input[name="settings-provider"]:checked',
  )?.value;
  settingsSectionOpenRouter.classList.toggle("hidden", provider !== "openrouter");
  settingsSectionOllama.classList.toggle("hidden", provider !== "ollama");
  settingsSectionOpenAI.classList.toggle("hidden", provider !== "openai-compatible");
}

settingsProviderRadios.forEach((r) =>
  r.addEventListener("change", updateSettingsSections),
);

// ─── Theme (view preference) ────────────────────────────────────────────────
// Applied live and persisted to localStorage independently of the summarizer
// Save/Cancel flow. theme-init.js mirrors this resolution on startup to avoid
// a flash of the dark theme before paint.
const settingsThemeRadios = document.querySelectorAll('input[name="settings-theme"]');
const lightThemeMQ = window.matchMedia("(prefers-color-scheme: light)");

function applyTheme(pref) {
  // pref: 'light' | 'dark' | 'system'
  localStorage.setItem("uds-theme", pref);
  const effective = pref === "system" ? (lightThemeMQ.matches ? "light" : "dark") : pref;
  document.documentElement.dataset.theme = effective;
  // The floating notes window is a separate document and only resolves this
  // once at load — tell main so it can relay the change.
  window.themeApi.notifyChanged();
}

settingsThemeRadios.forEach((r) =>
  r.addEventListener("change", () => {
    if (r.checked) applyTheme(r.value);
  }),
);

// While 'system' is selected, follow OS appearance changes live.
lightThemeMQ.addEventListener("change", () => {
  if ((localStorage.getItem("uds-theme") || "dark") === "system") applyTheme("system");
});

// ─── Date & time format (view preferences) ──────────────────────────────────
// Same contract as the theme: picking a radio takes effect immediately and
// survives Cancel — these never travel through the summarizer's Save.
const settingsDateOrderRadios = document.querySelectorAll('input[name="settings-date-order"]');
const settingsTimeFormatRadios = document.querySelectorAll('input[name="settings-time-format"]');

function bindFormatRadios(radios, key) {
  radios.forEach((r) =>
    r.addEventListener("change", () => {
      if (!r.checked) return;
      try { localStorage.setItem(key, r.value); } catch (_) {}
      renderMeetings();
    }),
  );
}

bindFormatRadios(settingsDateOrderRadios, DATE_ORDER_KEY);
bindFormatRadios(settingsTimeFormatRadios, TIME_FORMAT_KEY);

settingsPresetBtns.forEach((btn) =>
  btn.addEventListener("click", () => {
    settingsOaiUrl.value = btn.dataset.url || "";
    // Always switch the model to the preset's, so picking a provider also picks
    // a model that actually exists on it (otherwise a stale model from a prior
    // preset, e.g. an OpenAI id, leaks into Groq/Anthropic requests).
    settingsOaiModel.value = btn.dataset.model || "";
  }),
);

const settingsSectionCalendars = document.getElementById("settings-section-calendars");
const settingsCalendarsList = document.getElementById("settings-calendars-list");

// Populate the calendar picker (macOS only). Unconfigured selection (null) =>
// all calendars checked; otherwise check only the saved ids.
async function loadCalendarsSection() {
  const ok = window.calendar && (await window.calendar.platformOK());
  if (!ok) {
    settingsSectionCalendars.classList.add("hidden");
    return;
  }
  settingsSectionCalendars.classList.remove("hidden");
  settingsCalendarsList.innerHTML = "";

  const [listRes, selected] = await Promise.all([
    window.calendar.listCalendars(),
    window.calendar.getSelected(),
  ]);

  if (!listRes?.ok) {
    const note = document.createElement("div");
    note.className = "settings-radio-sub";
    note.textContent =
      listRes?.reason === "calendar-permission"
        ? "No calendar access. Grant it in System Settings → Privacy & Security → Calendars."
        : listRes?.error || "Could not read calendars.";
    settingsCalendarsList.appendChild(note);
    return;
  }

  const selectedSet = Array.isArray(selected) ? new Set(selected) : null;
  for (const c of listRes.calendars || []) {
    const row = document.createElement("label");
    row.className = "settings-radio";
    row.style.cursor = "pointer";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = c.id;
    cb.checked = selectedSet ? selectedSet.has(c.id) : true;
    const title = document.createElement("span");
    title.className = "settings-radio-title";
    title.textContent = c.title || "(untitled)";
    const sub = document.createElement("span");
    sub.className = "settings-radio-sub";
    sub.textContent = c.account || "";
    row.append(cb, title, sub);
    settingsCalendarsList.appendChild(row);
  }
}

// Checked calendar ids, or undefined when the section isn't rendered (so save
// leaves the stored selection untouched on non-macOS / permission errors).
function collectSelectedCalendarIds() {
  const boxes = settingsCalendarsList.querySelectorAll('input[type="checkbox"]');
  if (!boxes.length) return undefined;
  return Array.from(boxes).filter((b) => b.checked).map((b) => b.value);
}

async function openSettingsModal() {
  const cfg = await api.getSummarizer();
  const provider = cfg?.provider || "claude-code";
  settingsProviderRadios.forEach((r) => {
    r.checked = r.value === provider;
  });
  const theme = localStorage.getItem("uds-theme") || "dark";
  settingsThemeRadios.forEach((r) => {
    r.checked = r.value === theme;
  });
  const dateOrder = dateOrderPref();
  settingsDateOrderRadios.forEach((r) => {
    r.checked = r.value === dateOrder;
  });
  const timeFormat = timeFormatPref();
  settingsTimeFormatRadios.forEach((r) => {
    r.checked = r.value === timeFormat;
  });
  settingsOrKey.value = cfg?.openrouter?.apiKey || "";
  settingsOrModel.value = cfg?.openrouter?.model || "";
  settingsOrUrl.value = cfg?.openrouter?.baseUrl || "";
  settingsOlUrl.value = cfg?.ollama?.baseUrl || "";
  settingsOlModel.value = cfg?.ollama?.model || "";
  settingsOaiUrl.value = cfg?.openaiCompatible?.baseUrl || "";
  settingsOaiKey.value = cfg?.openaiCompatible?.apiKey || "";
  settingsOaiModel.value = cfg?.openaiCompatible?.model || "";
  const autoStopEl = document.getElementById("settings-autostop");
  if (autoStopEl && api.getAutoStop) autoStopEl.checked = await api.getAutoStop();
  settingsGlossary.value = (await api.getGlossary?.()) || "";
  const versionEl = document.getElementById("settings-version");
  if (versionEl && api.getAppVersion) versionEl.textContent = `Unlimeety ${await api.getAppVersion()}`;
  settingsError.classList.add("hidden");
  settingsError.textContent = "";
  updateSettingsSections();
  settingsModal.classList.remove("hidden");
  loadCalendarsSection();
}

function closeSettingsModal() {
  settingsModal.classList.add("hidden");
}

async function saveSettings() {
  const provider = document.querySelector(
    'input[name="settings-provider"]:checked',
  )?.value || "claude-code";

  if (provider === "openrouter" && !settingsOrKey.value.trim()) {
    settingsError.textContent = "OpenRouter requires an API key.";
    settingsError.classList.remove("hidden");
    return;
  }
  if (provider === "ollama" && !settingsOlModel.value.trim()) {
    settingsError.textContent = "Ollama requires a model name.";
    settingsError.classList.remove("hidden");
    return;
  }
  if (provider === "openai-compatible") {
    if (!settingsOaiUrl.value.trim()) {
      settingsError.textContent = "OpenAI-compatible provider requires a base URL.";
      settingsError.classList.remove("hidden");
      return;
    }
    if (!settingsOaiModel.value.trim()) {
      settingsError.textContent = "OpenAI-compatible provider requires a model name.";
      settingsError.classList.remove("hidden");
      return;
    }
  }

  // Before the first write: the glossary is capped in main, and failing after
  // the provider config was already saved leaves the modal open on a half-saved
  // settings screen.
  const savedGlossary = await api.setGlossary(settingsGlossary.value);
  if (!savedGlossary?.ok) {
    settingsError.textContent = savedGlossary?.error || "Could not save the glossary.";
    settingsError.classList.remove("hidden");
    return;
  }

  const payload = {
    provider,
    openrouter: {
      apiKey: settingsOrKey.value.trim(),
      model: settingsOrModel.value.trim(),
      baseUrl: settingsOrUrl.value.trim(),
    },
    ollama: {
      baseUrl: settingsOlUrl.value.trim(),
      model: settingsOlModel.value.trim(),
    },
    openaiCompatible: {
      apiKey: settingsOaiKey.value.trim(),
      model: settingsOaiModel.value.trim(),
      baseUrl: settingsOaiUrl.value.trim(),
    },
  };
  const res = await api.setSummarizer(payload);
  if (!res?.ok) {
    settingsError.textContent = res?.error || "Could not save settings.";
    settingsError.classList.remove("hidden");
    return;
  }

  // Persist the calendar selection (no-op if the section wasn't rendered).
  const calIds = collectSelectedCalendarIds();
  if (calIds !== undefined && window.calendar) {
    await window.calendar.setSelected(calIds);
  }

  const autoStopEl = document.getElementById("settings-autostop");
  if (autoStopEl && api.setAutoStop) await api.setAutoStop(autoStopEl.checked);

  closeSettingsModal();
}

// The documented format is tab-separated, and Tab in a textarea moves focus —
// so without this the format is reachable only by pasting. Same insert-by-hand
// shape as the transcript editor's Tab handler.
settingsGlossary.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || e.shiftKey) return;
  e.preventDefault();
  const { selectionStart: start, selectionEnd: end, value } = settingsGlossary;
  settingsGlossary.value = value.slice(0, start) + "\t" + value.slice(end);
  settingsGlossary.selectionStart = settingsGlossary.selectionEnd = start + 1;
});

document.getElementById("btn-settings").addEventListener("click", openSettingsModal);
document.getElementById("settings-close").addEventListener("click", closeSettingsModal);
document.getElementById("settings-cancel").addEventListener("click", closeSettingsModal);
document.getElementById("settings-save").addEventListener("click", saveSettings);

settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) closeSettingsModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsModal.classList.contains("hidden")) {
    closeSettingsModal();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
promptsReady = loadCustomPrompts();
libraryPanel.classList.add("open");
btnLibrary.classList.add("active");

btnSave.disabled = true;
btnSaveAs.disabled = true;
btnExport.disabled = true;
