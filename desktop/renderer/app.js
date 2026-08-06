/* ─────────────────────────────────────────────────────────────────────────────
 * Unlimeety Desktop — Renderer
 * ─────────────────────────────────────────────────────────────────────────── */

const api = window.transcriber;

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  filePath: null,
  savedContent: "",
  baselineContent: "",
  isDirty: false,
};

// filePath → summary text (survives library re-renders)
const summaryStore = new Map();

// ─── Meeting model ────────────────────────────────────────────────────────────
// A Meeting is the first-class entity used by the redesigned sidebar / editor /
// summary rail. It is derived from a transcript item returned by
// api.listTranscripts(). The renderer-only shim below extends each item with a
// status enum + artifact flags so the new UI can render uniformly. Fields the
// current IPC does not expose (summaryPath, mtime-driven outdated,
// recording/failed states) are left undefined until main.js is extended.
//
// Status derivation, given today's IPC surface:
//   transcribing  — id is in transcribeRunning
//   summarized    — hasSummary === true
//   transcribed   — otherwise (a transcript file exists by definition)
// recording / audio_only / outdated / failed need IPC support and will appear
// once added.

let meetings = [];
let activeMeetingId = null;
let summaryRenderMode = "auto";       // 'auto' | 'structured' | 'markdown'
let contextMenu = null;               // { x, y, meetingId } | null
const summarizeRunning = new Set();   // meetingIds with a summarize job in flight
const transcribeRunning = new Set();  // meetingIds with a transcribe job in flight

function deriveStatus(m) {
  if (transcribeRunning.has(m.id)) return "transcribing";
  if (m.hasSummary) return "summarized";
  if (m.hasTranscript) return "transcribed";
  return "audio_only";
}

// Without a filePath we have no stable id and the matching DOM selector would
// fall back to the empty string, which matches any card without the attribute.
// Skip such items entirely so they never enter `meetings[]`.
function deriveMeetingFromTranscript(item) {
  if (!item || !item.filePath) return null;
  const rawDate = item.createdAt || item.generated || item.mtime;
  const date = rawDate ? new Date(rawDate) : new Date();
  const hasTranscript = Boolean(item.filePath);
  const hasSummary = Boolean(item.hasSummary);
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
    language: item.language,
    progress: undefined,
    failedReason: undefined,
  };
  m.status = deriveStatus(m);
  return m;
}

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
const statusPath = document.getElementById("status-path");
const statusWords = document.getElementById("status-words");
const statusLines = document.getElementById("status-lines");
const saveChip = document.getElementById("save-chip");

// Library DOM refs
const libraryPanel = document.getElementById("library-panel");
const libraryList = document.getElementById("library-list");
const libraryEmpty = document.getElementById("library-empty");
const libraryCount = document.getElementById("library-count");

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
  const audioPath = await api.getAudioPath(filePath);
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

function renderTranscriptView(content) {
  const firstTcMatch = /^\[\d[^\]]*\]/m.exec(content);
  let html = "";
  if (!firstTcMatch) {
    // No timecodes — render the whole text as one pre-wrap block so the user
    // can still read it. They can hit Edit to modify.
    if (content.trim()) html = `<div class="tv-plain">${escHtml(content)}</div>`;
  } else {
    const header = content.slice(0, firstTcMatch.index).trim();
    if (header) html += `<div class="tv-header">${escHtml(header)}</div>`;
    for (const seg of parseSegments(content)) {
      const speaker = seg.speaker ? `<span class="tv-speaker">${escHtml(seg.speaker)}:</span> ` : "";
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
  updateUI();
  updateStats();

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
    updateUI();
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
  updateStats();
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

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStats() {
  const text = editor.value;
  const lines = text === "" ? 0 : text.split("\n").length;
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  statusWords.textContent = `${words.toLocaleString()} words`;
  statusLines.textContent = `${lines.toLocaleString()} lines`;
}

// ─── Library panel ────────────────────────────────────────────────────────────
let libraryOpen = true;
let activeLibraryPath = null;

btnLibrary.addEventListener("click", () => {
  libraryOpen = !libraryOpen;
  libraryPanel.classList.toggle("open", libraryOpen);
  btnLibrary.classList.toggle("active", libraryOpen);
});

async function loadLibrary() {
  const items = await api.listTranscripts();
  meetings = (items || []).map(deriveMeetingFromTranscript).filter(Boolean);
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
let activeFilter = "all";   // 'all' | 'audio' | 'transcribed' | 'summarized'
let searchQuery = "";
let searchDebounceTimer = null;
let contentMatches = new Map(); // filePath -> snippet (from full-text content search)
let searchToken = 0;            // guards against out-of-order async search responses

function meetingMatchesFilter(m, filter) {
  if (filter === "all") return true;
  if (filter === "audio") return m.hasAudio === true;
  if (filter === "transcribed") {
    return m.status === "transcribed" || m.status === "summarized" || m.status === "outdated";
  }
  if (filter === "summarized") return m.status === "summarized" || m.status === "outdated";
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

function computeFilterCounts(list) {
  const counts = { all: list.length, audio: 0, transcribed: 0, summarized: 0 };
  for (const m of list) {
    if (m.hasAudio) counts.audio++;
    if (meetingMatchesFilter(m, "transcribed")) counts.transcribed++;
    if (meetingMatchesFilter(m, "summarized")) counts.summarized++;
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
  // Clear list contents (keep the #library-empty placeholder).
  Array.from(libraryList.children).forEach((el) => {
    if (el.id !== "library-empty") el.remove();
  });

  // Always reflect total count in the header pill.
  libraryCount.textContent = meetings.length ? String(meetings.length) : "";

  // Update filter chip counts (off the unfiltered/unsearched meeting list).
  const counts = computeFilterCounts(meetings);
  for (const kind of ["all", "audio", "transcribed", "summarized"]) {
    const el = document.querySelector(`.filter-count[data-count="${kind}"]`);
    if (el) el.textContent = String(counts[kind]);
  }

  // Apply filter + search.
  const visible = meetings.filter(
    (m) => meetingMatchesFilter(m, activeFilter) && meetingMatchesSearch(m, searchQuery),
  );

  if (!visible.length) {
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

function buildMeetingCard(m) {
  const isActive = m.id === activeMeetingId;
  const card = document.createElement("div");
  card.className = "meeting-card" + (isActive ? " active" : "");
  card.dataset.meetingId = m.id;
  card.dataset.status = m.status;

  // Show a content-match snippet only when the query hit the body but not the
  // title/participants (otherwise the match is already obvious from the card).
  const snippet = contentMatches.get(m.id);
  const metaHay = [m.title, ...(m.participants || [])].join(" ").toLowerCase();
  const showSnippet = searchQuery && snippet && !metaHay.includes(searchQuery);

  card.innerHTML = `
    <span class="meeting-active-bar"></span>
    <div class="meeting-card-row1">
      <span class="meeting-title">${escapeHtml(m.title || "Untitled")}</span>
      <button class="meeting-more" type="button" aria-label="More actions">${iconSvg("more", { size: 14 })}</button>
    </div>
    ${showSnippet ? `<div class="meeting-snippet">${highlightSnippet(snippet, searchQuery)}</div>` : ""}
    <div class="meeting-card-row2">
      <span class="meeting-time tnum">${escapeHtml(formatMeetingTime(m.date))}</span>
      ${m.durationSec ? `<span class="dot">·</span><span class="meeting-duration tnum">${escapeHtml(formatMeetingDuration(m.durationSec))}</span>` : ""}
      ${m.participants?.length ? avatarStackHtml(m.participants, 3) : ""}
    </div>
    ${m.status === "transcribing" ? `
      <div class="meeting-progress">
        <div class="meeting-progress-bar" style="width: ${Math.round((m.progress || 0.4) * 100)}%"></div>
      </div>` : ""}
    <div class="meeting-card-row3">
      ${statusPillHtml(m.status)}
      <div class="artifact-chips">
        <span class="artifact-chip" data-kind="audio" data-present="${m.hasAudio ? "true" : "false"}" title="Audio">${iconSvg("mic", { size: 11 })}</span>
        <span class="artifact-chip" data-kind="transcript" data-present="${m.hasTranscript ? "true" : "false"}" title="Transcript">${iconSvg("text", { size: 11 })}</span>
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

  return card;
}

// ─── Meeting context menu (minimal — full set lands in a later phase) ────────
function closeMeetingMenu() {
  const el = document.getElementById("meeting-menu-root");
  if (el) el.remove();
  contextMenu = null;
}

function openMeetingMenu(x, y, m) {
  closeMeetingMenu();
  contextMenu = { x, y, meetingId: m.id };

  // Clamp so the popover stays on-screen.
  const W = 220;
  const H = 240;
  const left = Math.max(8, Math.min(x, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - H - 8));

  const summarizeLabel = m.hasSummary ? "Re-summarize" : "Summarize";
  const audioDisabled = !m.hasAudio;
  const summaryDisabled = !m.hasSummary;

  const root = document.createElement("div");
  root.id = "meeting-menu-root";
  root.innerHTML = `
    <div class="meeting-menu-overlay"></div>
    <div class="meeting-menu" role="menu" style="left:${left}px;top:${top}px;">
      <button class="meeting-menu-item" data-action="summarize" type="button" role="menuitem">
        <span class="meeting-menu-icon" style="color:var(--accent-lime)">${iconSvg("sparkle", { size: 13 })}</span>
        <span>${escapeHtml(summarizeLabel)}</span>
      </button>
      <button class="meeting-menu-item" data-action="rename" type="button" role="menuitem">
        <span class="meeting-menu-icon">${iconSvg("pencil", { size: 13 })}</span>
        <span>Rename…</span>
      </button>
      <button class="meeting-menu-item" data-action="retranscribe" type="button" role="menuitem" ${audioDisabled ? "disabled" : ""}>
        <span class="meeting-menu-icon">${iconSvg("mic", { size: 13 })}</span>
        <span>Re-transcribe…</span>
      </button>
      <div class="meeting-menu-divider"></div>
      <button class="meeting-menu-item danger" data-action="delete-audio" type="button" role="menuitem" ${audioDisabled ? "disabled" : ""}>
        <span class="meeting-menu-icon">${iconSvg("trash", { size: 13 })}</span>
        <span>Delete audio</span>
      </button>
      <button class="meeting-menu-item danger" data-action="delete-transcript" type="button" role="menuitem">
        <span class="meeting-menu-icon">${iconSvg("trash", { size: 13 })}</span>
        <span>Delete transcript</span>
      </button>
      <button class="meeting-menu-item danger" data-action="delete-summary" type="button" role="menuitem" ${summaryDisabled ? "disabled" : ""}>
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
      } else if (action === "rename") {
        const card = libraryList.querySelector(`[data-meeting-id="${CSS.escape(m.id)}"]`);
        const newTitle = await openRenamePopup(m.title, card?.getBoundingClientRect());
        if (!newTitle || newTitle === m.title) return;
        const result = await api.renameTranscript(m.id, newTitle);
        if (!result?.ok) {
          window.alert(`Couldn't rename: ${result?.error || "unknown error"}`);
          return;
        }
        if (state.filePath === m.id) state.filePath = result.newFilePath;
        if (activeMeetingId === m.id) activeMeetingId = result.newFilePath;
        if (activeLibraryPath === m.id) activeLibraryPath = result.newFilePath;
        summaryStore.delete(m.id);
        loadLibrary();
      } else if (action === "retranscribe") {
        // Re-transcribe lives on the Record tab; hand it the source audio and
        // jump there so the user lands on the transcribe-settings screen.
        if (m.audioPath) {
          document.querySelector('.tab-btn[data-tab="record"]')?.click();
          window.recordTab?.enterTranscribeSettings?.([m.audioPath]);
        }
      } else if (action === "delete-audio") {
        await deleteMeetingArtifact(m, "audio");
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
  if (kind === "audio") {
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
  // Flushing and moving the selection both belong to the file:opened path
  // (flushBeforeReplace, then loadContent → setActiveMeetingId): doing either
  // here as well prompted twice for one click, and left the sidebar pointing at
  // a note that was never opened when the user cancelled.
  await api.openFromLibrary(m.id);
}

// ─── Sidebar formatters ──────────────────────────────────────────────────────
function formatMeetingTime(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return "";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
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

// ─── Tiny inline-SVG icon helper (Lucide-style paths) ────────────────────────
const ICON_PATHS = {
  more:    '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  mic:     '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/>',
  text:    '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="10" x2="20" y2="10"/><line x1="4" y1="14" x2="14" y2="14"/><line x1="4" y1="18" x2="18" y2="18"/>',
  sparkle: '<path d="M12 2l1.6 4.6L18 8l-4.4 1.4L12 14l-1.6-4.6L6 8l4.4-1.4L12 2z" fill="currentColor" stroke="none"/>',
  check:   '<polyline points="20 6 9 17 4 12"/>',
  trash:   '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  pencil:  '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
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

function shouldRenderStructured(md) {
  return /^##\s+(decisions|action items|risks|recommendation|scorecard|tl;dr|participants)\b/im.test(md || "");
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
      const slug = h2[1].toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");
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

  for (const raw of lines) {
    const l = raw.trimEnd();
    if (!l) { flushList(); flushPara(); continue; }
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
    } else if ((m = l.match(/^- (.+)/))) {
      flushPara();
      (listBuf ||= []).push(m[1]);
    } else {
      flushList();
      para.push(l);
    }
  }
  flushList(); flushPara();
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
      ${chip}
    </div>
    ${path ? `<div class="rail-path" title="${path}">${path}</div>` : ""}
  `;
}

function parseSimpleBullets(lines) {
  return (lines || [])
    .map((x) => x.match(/^- (.+)/))
    .filter(Boolean)
    .map((m) => m[1]);
}

// Parse "- [ ] **Owner** — task — *due*" where the checkbox, the **owner** and
// the trailing " — *due*" are each optional and can appear in any combination
// (the model isn't perfectly consistent — e.g. a deadline with no owner).
function parseActionItems(lines) {
  const out = [];
  for (const raw of lines || []) {
    const m = String(raw).trim().match(/^- (.+)$/);
    if (!m) continue;
    let body = m[1].trim().replace(/^\[[ xX]\]\s*/, ""); // strip optional checkbox
    let due = null;
    const dm = body.match(/\s+[—–-]\s+\*([^*]+)\*\s*$/);  // optional trailing " — *due*"
    if (dm) { due = dm[1].trim(); body = body.slice(0, dm.index).trim(); }
    let who = null;
    const wm = body.match(/^\*\*([^*]+)\*\*\s+[—–-]\s+(.+)$/); // optional leading "**owner** — "
    if (wm) { who = wm[1].trim(); body = wm[2].trim(); }
    out.push({ who, what: body, due });
  }
  return out;
}

function renderDecisionsSection(items) {
  if (!items.length) return "";
  const list = items
    .map((d) => `<li><span class="rail-decision-bullet">${iconSvg("check", { size: 10 })}</span><span>${renderMarkdownInline(d)}</span></li>`)
    .join("");
  return `
    <div class="rail-section">
      <div class="rail-section-label">Decisions <span class="rail-section-count">${items.length}</span></div>
      <ul class="rail-list">${list}</ul>
    </div>
  `;
}

function renderRisksSection(items) {
  if (!items.length) return "";
  const list = items
    .map((r) => `<li><span class="rail-risk-bullet" aria-hidden="true">◆</span><span>${renderMarkdownInline(r)}</span></li>`)
    .join("");
  return `
    <div class="rail-section">
      <div class="rail-section-label">Risks <span class="rail-section-count">${items.length}</span></div>
      <ul class="rail-list">${list}</ul>
    </div>
  `;
}

function renderActionItemsSection(cards) {
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
  return `
    <div class="rail-section">
      <div class="rail-section-label">Action items <span class="rail-section-count">${cards.length}</span></div>
      ${items}
    </div>
  `;
}

function renderPlainSection(heading, lines) {
  const text = (lines || []).join("\n").trim();
  if (!text && !heading) return "";
  return `
    <div class="rail-section">
      ${heading ? `<div class="rail-section-label">${escapeHtml(heading)}</div>` : ""}
      <div class="rail-md">${renderMarkdown(text)}</div>
    </div>
  `;
}

function renderScorecardSection(lines) {
  const rows = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith("|")) continue;
    if (/^\|[-:| ]+\|/.test(t)) continue;
    const cells = t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    rows.push(cells);
  }
  if (!rows.length) return "";
  const [header, ...body] = rows;
  const RATING_CLS = { strong: "sc-strong", mixed: "sc-mixed", weak: "sc-weak", "not assessed": "sc-na" };
  const ths = header.map((h) => `<th>${renderMarkdownInline(h)}</th>`).join("");
  const trs = body.map((r) => {
    const tds = r.map((c, i) => {
      if (i === 1) {
        const cls = RATING_CLS[c.toLowerCase()] || "";
        return `<td class="sc-rating ${cls}">${renderMarkdownInline(c)}</td>`;
      }
      return `<td>${renderMarkdownInline(c)}</td>`;
    }).join("");
    return `<tr>${tds}</tr>`;
  }).join("");
  return `
    <div class="rail-section">
      <div class="rail-section-label">Scorecard</div>
      <table class="rail-scorecard"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>
    </div>
  `;
}

function renderRecommendationSection(lines) {
  const text = lines.join("\n").trim();
  if (!text) return "";
  const VERDICTS = [
    ["Strong hire", "verdict-hire-strong"],
    ["Hire", "verdict-hire"],
    ["Lean no", "verdict-lean-no"],
    ["No hire", "verdict-no-hire"],
    ["Insufficient signal", "verdict-signal"],
  ];
  let badge = "";
  let rest = text;
  for (const [v, cls] of VERDICTS) {
    if (text.startsWith(v)) {
      badge = `<span class="rail-verdict ${cls}">${escapeHtml(v)}</span>`;
      rest = text.slice(v.length).replace(/^\s*[—–-]\s*/, "");
      break;
    }
  }
  return `
    <div class="rail-section">
      <div class="rail-section-label">Recommendation</div>
      ${badge}
      ${rest ? `<div class="rail-md rail-rec-body">${renderMarkdown(rest)}</div>` : ""}
    </div>
  `;
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
  // Covers meeting / daily / interview presets without rewriting source files.
  const RAIL_ORDER = ["speaker_mapping", "summary", "tl_dr", "participants", "scorecard", "action_items", "decisions", "recommendation"];
  const orderedSections = [...parsed.sections].sort((a, b) => {
    const ai = RAIL_ORDER.indexOf(a.slug);
    const bi = RAIL_ORDER.indexOf(b.slug);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  for (const sec of orderedSections) {
    if (sec.slug === "decisions") {
      out.push(renderDecisionsSection(parseSimpleBullets(sec.lines)));
    } else if (sec.slug === "action_items") {
      out.push(renderActionItemsSection(parseActionItems(sec.lines)));
    } else if (sec.slug === "risks") {
      out.push(renderRisksSection(parseSimpleBullets(sec.lines)));
    } else if (sec.slug === "scorecard") {
      out.push(renderScorecardSection(sec.lines));
    } else if (sec.slug === "recommendation") {
      out.push(renderRecommendationSection(sec.lines));
    } else if (sec.slug === "brief") {
      const text = (sec.lines || []).join("\n").trim();
      if (!text) continue;
      out.push(`
        <div class="rail-section">
          <div class="rail-section-label">Brief</div>
          <div class="rail-md rail-brief-md">${renderMarkdown(text)}</div>
        </div>
      `);
    } else {
      out.push(renderPlainSection(sec.heading, sec.lines));
    }
  }

  return out.join("");
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
      <p>Summarize this meeting locally — extract decisions, action items, and a brief.</p>
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
    if (!parsed.fallback) {
      summaryRailBody.innerHTML =
        buildRailHeaderHtml(filePath, presetName ? { label: presetName } : { label: "Structured" }) +
        buildStructuredHtml(parsed);
      if (btnRailResummarizeLabel) btnRailResummarizeLabel.textContent = "Re-summarize";
      return;
    }
  }

  summaryRailBody.innerHTML =
    buildRailHeaderHtml(filePath, presetName ? { label: presetName } : { label: "Markdown", muted: true }) +
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
          renderSummaryRail(fp);
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
const btnMeetingNew = document.getElementById("btn-meeting-new");

if (btnMeetingNew) btnMeetingNew.addEventListener("click", openNewModal);

if (meetingSearchInput) {
  meetingSearchInput.addEventListener("input", () => {
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

document.querySelectorAll(".filter-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const filter = chip.dataset.filter;
    if (!filter || filter === activeFilter) return;
    activeFilter = filter;
    document.querySelectorAll(".filter-chip").forEach((c) => {
      c.classList.toggle("active", c.dataset.filter === filter);
    });
    renderMeetings();
  });
});

// Init library
api.watchTranscripts();
loadLibrary();
api.onTranscriptsChanged(loadLibrary);

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showEditor() {
  emptyState.classList.add("hidden");
  editor.classList.remove("hidden");
  editorToolbar.classList.remove("hidden");
  btnSaveAs.disabled = false;
  btnExport.disabled = false;
}

function updateUI() {
  if (!state.filePath) return;
  statusPath.textContent = state.filePath;
}

// ─── Editor events ────────────────────────────────────────────────────────────
editor.addEventListener("input", () => {
  if (!state.isDirty && editor.value !== state.savedContent) setDirty(true);
  else if (state.isDirty && editor.value === state.savedContent)
    setDirty(false);
  scheduleAutosave();
  updateStats();
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
    updateStats();
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
  return !!document.querySelector(".modal-overlay:not(.hidden), .rename-overlay, .spk-rename");
}

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "s") {
    e.preventDefault();
    e.shiftKey ? saveAsFile() : saveFile();
  }
  if (mod && e.key === "o") {
    e.preventDefault();
    openFile();
  }
  if (mod && e.key === "n") {
    e.preventDefault();
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
document.addEventListener("transcript:created", (e) => {
  const filePath = e.detail?.filePath;
  if (!filePath) return;
  document.querySelector('.tab-btn[data-tab="editor"]')?.click();
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
  if (modalBusyBanner) modalBusyBanner.classList.add("hidden");
  summarizeModal.classList.remove("hidden");

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

// ─── Background summarization ────────────────────────────────────────────────
// One job at a time. The modal is just a launcher — the actual run is awaited
// outside the modal's lifetime so the user can keep working.

let runningSummarize = null;

const bgToolbar = document.getElementById("bg-summary-toolbar");
const bgTitle = document.getElementById("bg-summary-title");
const bgSubtitle = document.getElementById("bg-summary-subtitle");
const bgViewBtn = document.getElementById("bg-summary-view");
const bgCloseBtn = document.getElementById("bg-summary-close");
const modalBusyBanner = document.getElementById("modal-busy-banner");

function showBgToolbar(state, title, subtitle) {
  bgToolbar.dataset.state = state;
  bgTitle.textContent = title;
  bgSubtitle.textContent = subtitle || "";
  bgSubtitle.title = subtitle || "";
  bgToolbar.classList.remove("hidden");
}

function hideBgToolbar() {
  bgToolbar.classList.add("hidden");
  bgToolbar.dataset.state = "idle";
  bgViewBtn.classList.add("hidden");
  bgViewBtn.onclick = null;
}

bgCloseBtn.addEventListener("click", () => {
  // While running, the close button just hides the toolbar — work continues.
  hideBgToolbar();
});

async function runSummarize() {
  const filePath = modalCurrentFilePath;
  const instruction = modalPromptInput.value.trim();
  if (!filePath || !instruction) return;

  if (runningSummarize) {
    modalBusyBanner.classList.remove("hidden");
    return;
  }
  modalBusyBanner.classList.add("hidden");

  const titleText = modalTitleEl.textContent || "";
  const meetingTitle = titleText.startsWith("Summarize — ")
    ? titleText.slice("Summarize — ".length)
    : "";
  const folder = getEffectiveFolder();
  const customName = null;

  runningSummarize = { filePath, meetingTitle, instruction, folder, customName };
  showBgToolbar("running", "Summarizing…", meetingTitle);
  bgViewBtn.classList.remove("hidden");
  bgViewBtn.textContent = "View";
  bgViewBtn.onclick = () => {
    // Work is still running — open the modal but keep the toolbar visible.
    openSummarizeModal(filePath, meetingTitle);
  };
  closeSummarizeModal();

  let result;
  try {
    result = await api.summarize(filePath, instruction);
  } catch (err) {
    result = { ok: false, error: err?.message || String(err) };
  }

  runningSummarize = null;

  if (result?.notInstalled) {
    showBgToolbar("error", "Claude Code not found", "Install it or switch provider in Settings");
    bgViewBtn.classList.remove("hidden");
    bgViewBtn.textContent = "Details";
    bgViewBtn.onclick = () => {
      modalErrorText.innerHTML =
        "<strong>Claude Code not found.</strong><br>" +
        "Install it from <strong>claude.ai/code</strong>, or switch the summarizer in <strong>Settings</strong>.";
      modalCurrentFilePath = filePath;
      modalTitleEl.textContent = meetingTitle ? `Summarize — ${meetingTitle}` : "Summarize meeting";
      summarizeModal.classList.remove("hidden");
      showModalView(modalViewError);
      hideBgToolbar();
    };
    return;
  }

  if (!result?.ok) {
    showBgToolbar("error", "Summarization failed", meetingTitle);
    bgViewBtn.classList.remove("hidden");
    bgViewBtn.textContent = "Details";
    bgViewBtn.onclick = () => {
      modalErrorText.textContent = result?.error || "Summarization failed.";
      modalCurrentFilePath = filePath;
      modalTitleEl.textContent = meetingTitle ? `Summarize — ${meetingTitle}` : "Summarize meeting";
      summarizeModal.classList.remove("hidden");
      showModalView(modalViewError);
      hideBgToolbar();
    };
    return;
  }

  const summaryText = result.summary.replace(/^```[a-z]*\n([\s\S]*?)```\s*$/s, '$1').trim();

  summaryStore.set(filePath, summaryText);
  try { localStorage.setItem("summary.prompt." + filePath, activePresetName(instruction)); } catch (_) {}

  if (customName) await api.setSummaryName(filePath, customName);
  api.saveSummary(filePath, summaryText, folder);

  // Reflect the new summary on the matching sidebar card.
  const meeting = getMeetingById(filePath);
  if (meeting) {
    meeting.hasSummary = true;
    meeting.status = deriveStatus(meeting);
    renderMeetings();
  }

  // Re-render the rail if the summarized file is the one currently open.
  if (state.filePath === filePath) renderSummaryRail(filePath);

  showBgToolbar("done", "Summary ready", meetingTitle);
  bgViewBtn.classList.remove("hidden");
  bgViewBtn.textContent = "View";
  bgViewBtn.onclick = () => {
    hideBgToolbar();
    openSummarizeModal(filePath, meetingTitle);
  };
}

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
