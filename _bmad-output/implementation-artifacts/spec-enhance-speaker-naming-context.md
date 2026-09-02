---
title: 'Enhance speaker naming: full names from the participant list'
type: 'bugfix'
created: '2026-09-02'
status: 'done'
review_loop_iteration: 2
baseline_commit: '2f9e5492fc9958099bf2ae41d3ecb4dc60500812'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** On the newest transcript (`Unified onboarding 15-04 01-09-26.txt`) Enhance named 1 of 11 placeholders while Summarize named 8 — reading the same file. Two causes, both measured: (a) `speakerEvidence` strides over a body of 41530 chars against a 40000 budget, dropping the only turns that say "Инесс"; (b) `nameIsAttested` demands every part of a name be spoken aloud, so every full name is rejected — surnames live only in the `Participants:` emails (`i.saridi@unlimit.com`), never in speech. Summarize wins because it reads the file whole and cites those emails as evidence.

**Approach:** Give the naming pass the context Summarize already has — the whole body instead of a stride, the glossary, and a participant list the model is told may be emails — then let the participant emails supply the *surname* of a name whose given part was actually heard, so `Beta` becomes `Инесса Сариди (Beta)` rather than being dropped.

## Boundaries & Constraints

**Always:** A name must be attested before it is written, and email binding never attests on its own — at least one part of the name must be spoken in the body (the existing rule, unchanged), and every remaining part must bind to exactly one participant entry. Binding requires each unspoken part, of two characters or more, to match a distinct segment of that one email's local part; a partial, ambiguous, or sub-two-character match attests nothing. Failure of the naming pass stays non-fatal: placeholders remain and proofreading still runs. The written form keeps the placeholder: `Инесса Сариди (Beta)`.

**Ask First:** Raising the evidence budget past 120000 chars, or removing the cap entirely. Marking a name as uncertain in the marker itself (a new marker shape every transcript reader would have to learn).

**Never:** Touching the proofreading pass, its chunking, or its length/Cyrillic gates. Letting the model return markers. Deriving a name from a role, a topic, or an unbound email. Writing a name no part of which was heard. Adding a transliteration or Levenshtein dependency — the repo already has one Levenshtein in `glossary.js`. Real colleagues' names in shipped prompt text or fixtures.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Surname from email | `Beta -> Инесса Сариди`; "Инесс" spoken, `i.saridi@` listed | Accepted; marker becomes `Инесса Сариди (Beta)` | N/A |
| Nothing spoken | `Beta -> Ирина Сариди`; `i.saridi@` listed, no part spoken | Rejected — binding never attests alone | Placeholder kept |
| Transliteration drift | `Delta -> Сергей Проскуряков`; "Сергей" spoken, `s.proskuriakov@` (`ya`/`ia`, distance 1) | Accepted within the fuzzy budget | N/A |
| Ambiguous binding | `Beta -> Инесса Сариди`; both `i.saridi@` and `a.saridi@` listed | Rejected — more than one participant binds | Placeholder kept |
| Wrong surname pairing | `Gamma -> Ольга Сариди`; "Оля" spoken, `o.zhukova@` and `i.saridi@` listed | Rejected — no single email matches the unspoken part | Placeholder kept |
| Sub-two-char part | `Beta -> Х Сариди`; "Сариди" binds | Rejected — a one-character part binds to nothing | Placeholder kept |
| Body fits budget | body 41530 chars, default budget | Whole body sent, no turn dropped or truncated | N/A |
| Body over budget | body 400000 chars | Every turn present, long turns trimmed in the middle; output within the cap | N/A |
| Empty glossary | glossary `''` | Prompt unchanged, no empty block and no stray heading | N/A |

</frozen-after-approval>

## Code Map

- `desktop/transcript-enhance.js` -- the naming pass. `speakerEvidence` (stride to replace), `DEFAULT_EVIDENCE_CHARS = 40000` (raise), `nameIsAttested` + `spokenIn` + `MAX_INFLECTION_CHARS` (bind only the *unspoken* parts), `SPEAKER_PROMPT`. `parseSpeakerNames` writes the model's unfiltered string, so a part-length rule must gate acceptance, not just the parts it inspects. `MAX_NAME_WORDS = 3` already admits a full name. `displaySpeaker`/`renameSpeakers` already produce the wanted form — leave them.
- `desktop/transcript-enhance.js` `renameParticipantsLine` -- dedupes by string, so `i.saridi@…, Beta` becomes `i.saridi@…, Инесса Сариди (Beta)` — one person twice. Binding knows which entry matched.
- `desktop/glossary.js` -- `withinDistance(a, b, max)` is the repo's Levenshtein; export and reuse. `fuzzyBudget` is the shape to mirror for segment compares. `render`'s heading ("restore these spellings when the transcript mangles them") is written for proofreading and is wrong for a pass that must answer only `Placeholder -> Name`.
- `desktop/main.js:2316` `runEnhanceJob` -- naming pass at 2356-2389 already passes the `Meeting:` title and participants; `readConfig().glossary` is read at 2405 for proofreading only. Heed the deliberate rule at 2420-2423: glossary terms match **spoken text only**, never the rendered chunk, or a term that is also a surname matches every chunk.
- `desktop/test/speaker-naming.test.js` -- 213 lines of existing gates; extend, do not rewrite. Two fixture traps found in review: `TIMESTAMP` accepts at most a two-digit hour, so a generated `[100:00]` marker never parses; and a periodic filler (`'слово '.repeat(n)`) makes a "tail survived" assertion pass with the tail gone.
- Read-only evidence: `~/Downloads/Meet_Transcripts/Unified onboarding 15-04 01-09-26.txt` (body 41530 chars, 165 turns) and its summary in `2 - Areas/Unlimit/meetings/daily/` (8 placeholders resolved, citing the emails).

## Tasks & Acceptance

**Execution:**
- [ ] `desktop/glossary.js` -- export `withinDistance` -- one Levenshtein in the repo, not two.
- [ ] `desktop/transcript-enhance.js` -- add a Cyrillic→Latin table and `translit()` (fold diacritics too, so `Müller` is not reduced to `mller`); extend `nameIsAttested` so a name passes when at least one part is spoken in the body AND every remaining part of two characters or more binds to exactly one participant entry, each to a distinct segment of that entry's local part -- the surname exists only in the email, but a name nothing attests in speech must never be written.
- [ ] `desktop/transcript-enhance.js` -- raise `DEFAULT_EVIDENCE_CHARS` to 120000 and replace `speakerEvidence`'s stride with per-turn middle-trimming that keeps every turn and honours the cap at every budget -- a stride drops the turn that names someone; a real meeting now goes through whole. Leave a `ponytail:` marker on any lossy fallback that survives.
- [ ] `desktop/transcript-enhance.js` -- extend `SPEAKER_PROMPT`: participants may be email addresses, and reading a surname off an address is legitimate evidence *for a given name you heard* -- otherwise the model keeps answering with a bare given name. Synthetic example names only.
- [ ] `desktop/transcript-enhance.js` -- teach `renameParticipantsLine` to drop the participant entry a name was bound to -- otherwise the header lists the same person as both an address and a name.
- [ ] `desktop/main.js` -- hoist the `readConfig().glossary` read above the naming pass; select against the turns' **spoken text**, not the rendered evidence, and give the naming block its own heading -- the proofreading imperative must not be the last thing a naming prompt says, and matching marker lines both mis-selects and, at 120000 chars, spends seconds on the main process.
- [ ] `desktop/test/speaker-naming.test.js` -- cover every I/O Matrix row, and pin the shipped default: a ~42000-char body must come back untrimmed from `speakerEvidence(blocks, noteLabel)` with no explicit budget -- reverting the constant to 40000 currently keeps the suite green, which is the original bug reinstated silently.

**Acceptance Criteria:**
- Given the failing transcript's body and participant list, when the naming pass runs with a reply naming `Beta -> Инесса Сариди` and `Gamma -> Ольга Жукова`, then both are accepted (their given names are spoken) and their markers read `Инесса Сариди (Beta)` and `Ольга Жукова (Gamma)`.
- Given that same list and a body naming nobody, when the model answers any full name, then nothing is written and every placeholder survives.
- Given a transcript already carrying `Инесса Сариди (Beta)`, when Enhance runs again, then that speaker is no longer a placeholder and is left alone.
- Given `node --test` in `desktop/`, when the suite runs, then every existing gate still passes.

## Spec Change Log

- **Finding:** All three review layers independently verified that email binding attested a name with nothing spoken — on a body naming no one, `Beta -> Ирина Сариди` and `Beta -> Игорь Сариди` both bound to `i.saridi@` and were written, and `Мария Кузнецов` bound to `m.kuznetsova@` at one edit. The model was choosing a given name from a single initial.
  **Amended:** The frozen `Always` clause changed from "either spoken **or** bound" to "at least one part spoken **and** every remaining part bound to exactly one entry", with a two-character floor per bound part; `Never` gained "writing a name no part of which was heard" and the ban on real colleagues' names in shipped text; the matrix gained the nothing-spoken, ambiguous-binding and sub-two-character rows. Renegotiated with the human, who chose the strict reading.
  **Known-bad state avoided:** A real colleague's name stamped onto the turns of a different person who may never have spoken — the one outcome the module header promises cannot happen ("the worst case is a placeholder left alone, never an invented person").
  **KEEP:** The transliteration table and its calibration (14 of 15 surnames at distance 0, `Проскуряков` at 1) were right and must survive. So must binding a name to a *single* entry rather than to the list, per-turn middle-trimming over a stride, water-filling so short turns survive whole, and reusing `glossary.withinDistance` instead of a second Levenshtein.

## Design Notes

The transliteration table is calibrated against one real meeting's 16 participant addresses: 14 surnames land at distance 0, `Проскуряков`→`proskuryakov` vs `proskuriakov` at 1. Exact equality is therefore wrong, and a fuzzy budget of ~2 for segments of 5+ chars (`glossary.fuzzyBudget`'s shape) is right. Do not widen it: at two edits `Кузнецов`/`Кузнецова` are already one person's two spellings, and a third reaches a different colleague.

```
"Инесс" spoken + Инесса Сариди vs i.saridi@              -> given name heard, saridi binds  ACCEPT
nothing spoken + Ирина Сариди  vs i.saridi@              -> binding alone attests nothing   REJECT
"Оля" spoken   + Ольга Сариди  vs o.zhukova@, i.saridi@  -> unspoken part binds neither     REJECT
```

**Accepted limitation.** A given name and a surname drawn from the *same* address can still be the wrong pairing, because `initial.surname` cannot distinguish two given names sharing an initial. Observed live: the model answered `Валерий Шило` for a speaker the transcript really does address as "Валерий", taking the surname from `v.shilo@unlimit.com` — which belongs to Виктор Шило, while Валерий is the recorder, whose own address is not on the participant list at all. The summarize pass makes the identical error on the same file, so it is a model-level pairing judgement, not something either pass can catch mechanically. The user reviewed this and accepted the risk rather than narrowing output to spoken-only surnames. Do not add heuristics for it; what code *can* enforce — one part spoken, every part fitting one single entry, no entry claimed twice — is enforced.

Per-turn trimming beats the stride at equal budget: at 40000 the stride kept 18922 chars and lost "Инесс"; trimming keeps 26717 and every naming cue but one. At 120000 the body passes untouched.

## Verification

**Commands:**
- `cd desktop && node --test` -- expected: all suites pass, including the extended `speaker-naming.test.js`.
- `cd desktop && sed -i '' 's/EVIDENCE_CHARS = 120000/EVIDENCE_CHARS = 40000/' transcript-enhance.js; node --test; sed -i '' 's/EVIDENCE_CHARS = 40000/EVIDENCE_CHARS = 120000/' transcript-enhance.js` -- expected: the suite FAILS while the constant is lowered, and passes again after the second `sed` restores it. A green run in the middle means the default is still unpinned. The restore is a `sed` round trip on purpose: `git checkout --` here would discard uncommitted work.

**Manual checks (if no CLI):**
- Re-run Enhance on a copy of `Unified onboarding 15-04 01-09-26.txt` with its placeholders restored, and confirm the markers and the `Participants:` line carry full names in `Name (Label)` form, with no address left beside the name bound to it.

## Suggested Review Order

**Who a name belongs to (the safety boundary)**

- Start here: the two-stage rule — which address binds, then whose name it is.
  [`transcript-enhance.js:421`](../../desktop/transcript-enhance.js#L421)

- Exactly one address may bind, or nothing does; ambiguity fails closed.
  [`transcript-enhance.js:394`](../../desktop/transcript-enhance.js#L394)

- An initial corroborates a heard name but may never supply one — hence the flag.
  [`transcript-enhance.js:373`](../../desktop/transcript-enhance.js#L373)

- Equal length plus one substitution: a gender ending must not bind a stranger.
  [`transcript-enhance.js:357`](../../desktop/transcript-enhance.js#L357)

- Cyrillic→Latin, calibrated on 16 real addresses; Serbian letters included.
  [`transcript-enhance.js:323`](../../desktop/transcript-enhance.js#L323)

**Evidence: the whole meeting instead of a stride**

- The measured budget; the number is pinned by a test, not a guess.
  [`transcript-enhance.js:88`](../../desktop/transcript-enhance.js#L88)

- Every turn survives; length comes out of monologue middles, not turn count.
  [`transcript-enhance.js:213`](../../desktop/transcript-enhance.js#L213)

- Water-filling, so the short turn that names someone stays whole.
  [`transcript-enhance.js:191`](../../desktop/transcript-enhance.js#L191)

- Below the elision width, return nothing rather than an unmarked cut.
  [`transcript-enhance.js:176`](../../desktop/transcript-enhance.js#L176)

**What the model is told**

- Prompt assembly, so an empty glossary leaves no stray heading.
  [`transcript-enhance.js:117`](../../desktop/transcript-enhance.js#L117)

- A reference heading, not the proofreading imperative, for a pass that answers names.
  [`glossary.js:152`](../../desktop/glossary.js#L152)

- One config read for both passes; terms selected from spoken text only.
  [`main.js:2384`](../../desktop/main.js#L2384)

- Scan cap: the naming pass matches a bounded slice, not the whole file.
  [`main.js:2301`](../../desktop/main.js#L2301)

**Keeping the header honest**

- The bound address becomes the name, so nobody is listed twice.
  [`transcript-enhance.js:529`](../../desktop/transcript-enhance.js#L529)

**Peripherals**

- The repo's one Levenshtein, now shared across the module boundary.
  [`glossary.js:172`](../../desktop/glossary.js#L172)

- Matrix rows, boundary rejections, and the mutation-caught budget pin.
  [`speaker-naming.test.js`](../../desktop/test/speaker-naming.test.js)
