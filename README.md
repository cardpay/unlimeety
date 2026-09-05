# Unlimeety — private, on-device transcription & summarization

A macOS app that records and transcribes any audio — meetings, calls, interviews, voice notes —
**entirely on your Mac**. Speech recognition and speaker diarization run locally through
WhisperKit / CoreML: no audio ever leaves the machine, no account, no per-minute pricing, no bot
joining your call. Summarization is then done by an LLM of your choice, and that choice can be a
local one too.

**Written entirely by AI** · **on-device** · **free** · **MIT** · **macOS, Apple Silicon**

[![Download Unlimeety for macOS](https://img.shields.io/badge/Download-Unlimeety--arm64.dmg-6C4CF1?style=for-the-badge)](https://github.com/cardpay/unlimeety/releases/latest/download/Unlimeety-arm64.dmg)

![Unlimeety library: meetings grouped by date with work-queue filters, a transcript with speaker turns and a typed note, and the summary rail with action items and decisions — demo data, light theme](docs/screenshot-library-light.png)

A small Chrome extension for Google Meet ships alongside it, but it is one capture path out of
three — the desktop app is where the actual work happens.

---

## Built entirely by AI

Unlimeety is a product built with no human writing code. Not "AI-assisted" — AI-built,
end to end:

| Stage | Who did it |
|---|---|
| Product design, UI, visual language | **Claude Design** |
| Architecture and technical decisions | **Claude Code** |
| Implementation — Electron app, Swift/CoreML helper, Chrome extension | **Claude Code** |
| Code review | **Claude Code** |
| Pre-release security audit and the fixes it produced | **Claude Code** |
| Documentation, including this README | **Claude Code** |

A human stayed in exactly one role: product owner. Stating intent, using the result, saying
*no, do it properly* — and never opening an editor.

**How it was actually run**, because the process is the interesting part:

- **One git worktree per feature.** Agents worked in parallel on isolated checkouts —
  live-audio capture, meeting auto-detection, the light theme, auto-stop at end of call,
  bulk transcription — and each landed as its own merge.
- **A pipeline, not a chat.** Specialised subagents in sequence: architect → implementer →
  reviewer, each with its own context and its own definition of done.
- **A security audit before going public.** A dedicated agent pass audited the whole
  codebase for an open-source release — path traversal, IPC sender validation, key storage,
  the summary write path — and its critical and high findings were fixed before the first
  public commit.
- **~28 000 lines of product code** (JavaScript, Swift, CSS, HTML), plus ~5 900 more of
  tests, from empty directory to a signed and Apple-notarized app in daily use.

This is the part worth taking away: an AI-first engineering loop produced not a demo but a
notarized desktop application with on-device ML, a real transcript library, and a
privacy posture strict enough to publish. At Unlimit, that's what "AI-first" is expected to
mean in practice.

---

## Why it exists

Meeting transcription today usually means a bot joining your call, an account, a per-minute
bill, and your recordings sitting on someone else's server — which is exactly what makes it a
non-starter for a customer call, a salary conversation, a legal review or an incident
post-mortem.

Unlimeety takes the other side of every one of those trade-offs:

|  | Typical SaaS transcriber | Unlimeety |
|---|---|---|
| Where audio goes | Vendor's cloud | Never leaves your Mac |
| Who joins the call | A bot other participants can see | Nobody |
| Account | Required | None |
| Cost | Per minute or per seat | Free, MIT-licensed |
| Works offline | No | Yes, including the summary if you point it at a local model |

The niche it closes: confidential conversations you cannot legally or comfortably send to a
third party — and everything else you'd rather not pay per minute for.

## How it works

Three ways to get a transcript, all landing in the same library:

| | Path | Use it for |
|---|---|---|
| 🎙 | **Live tab** | Any app — Zoom, Teams, Slack huddles, a browser tab, a room. Mic + system audio transcribed in real time, with live speaker diarization. |
| ⏺ | **Record tab** | Records to `.wav` with no live transcription; on **Stop & save** a large-v3 diarized transcription starts on its own, in the language you picked while recording, and an Enhance pass follows it. Also imports existing audio files. |
| 🧩 | **Chrome extension** | Google Meet only. Reuses Meet's own captions (no audio capture at all) and hands the file to the desktop app. |

Whichever path you took, from there it's the same transcript: edit it, bind real names to speakers,
re-transcribe it with a better model, summarize it from one of seven templates, chat with it, draft
the follow-up, export or share it.

---

## What it does

**Live transcription & diarization**

![Live tab: on-device Whisper model picker with size and quality, seven-way language selector, and separate microphone and system-audio toggles](docs/screenshot-live-light.png)

- Microphone and system audio captured together, each toggleable on its own, with live level meters.
- Partial hypotheses appear greyed out and are re-decoded every ~700 ms, then finalized on ~1 s of
  silence — you read the text as it settles, not in chunks.
- Speaker turns via SpeakerKit / pyannote 3.1, re-run every ~30 s while recording: placeholder `S?`
  labels resolve to real turns live, with one authoritative pass on **Stop**.
- Speakers get readable Greek-alphabet names (Alpha, Beta, Gamma, …). Click a speaker chip to bind
  the real name — it is written into both the transcript body and the `Participants:` header.
- Language is a seven-way choice — Russian, English, Serbian, Spanish, German, French or
  **Auto-detect** — shared by the Live tab, the Record tab and the transcribe-settings screen. Your
  last choice is remembered; a fresh install starts on Auto-detect rather than guessing.
- Every live session also writes a lossless `.wav`, paired with the transcript by filename.
- VAD gating plus a hallucination blocklist, so silence doesn't produce `[music]` or "thanks for
  watching".

**Audio ↔ transcript sync, both directions**
- Click any line of the transcript to seek the audio there.
- During playback the current line highlights and follows along.
- Waveform with click-to-seek and playback-speed cycling.

**Automatic meeting detection**
- Notices when a call starts by asking Core Audio whether the input device is in use — it never
  opens the microphone itself and needs no extra permission for this. Music playing doesn't trigger
  it; a conferencing app holding the mic does.
- Recognizes Zoom, Teams, Slack, FaceTime, WhatsApp, Discord, Webex and the major browsers.
- Offers to record from a floating panel that stays visible **above full-screen apps** — including a
  full-screen Zoom call. Title is pre-filled from the calendar event happening right now.
- **Auto-stop when the meeting ends**: detects the call dropping and stops recording after a 15 s
  countdown you can cancel — armed only for a session capturing both microphone *and* system audio,
  since that is what makes it an online call. Both behaviours are on by default; auto-stop is
  switchable from the menu bar and from **Settings → Recording**, auto-detect from the menu bar.
  Answering "Not now" mutes the prompt for five minutes.

**Calendar-aware**
- Reads the current event's title and participants to fill in the transcript header.
- Suggests the right capture mode from the event's conferencing link: Meet / Zoom / Teams / Webex /
  Jitsi / Whereby / BlueJeans / GoToMeeting / Chime → Live tab, no link at all → Record tab for an
  in-person meeting. For Meet it also mentions the Chrome extension as an alternative. It suggests;
  it never starts recording on its own.
- The title prefill re-reads the calendar every time you open the tab and clears itself once the
  meeting is over — but only its own value, never a title you typed, and never on a calendar read
  that failed. All-day and multi-day entries are skipped, so "PTO" cannot beat the real meeting
  inside it; a meeting that ended in the last 15 minutes is still offered.
- Which calendars are read is yours to pick, in **Settings → Calendars**.

**Improving a transcript after the fact**
- Re-transcribe any recording with a larger model straight from the library.
- Batch-transcribe a whole selection of recordings in one go, with an ETA for the batch.
- The transcribe-settings screen opens over the Meetings list rather than dragging you to another
  tab, and closes with ✕, Cancel or Escape. Save named presets, and tune model, language, speaker
  diarization and expected speaker count, merging of adjacent same-speaker turns, initial prompt,
  temperature and the Silero VAD filter.
- Rename speakers, edit text inline, or regenerate the summary.
- The meeting's ⋯ menu carries Summarize, Enhance, Rename, Transcribe / Re-transcribe and three
  separate deletes. An entry that cannot run is greyed out *and says why* on hover — "Not
  transcribed yet", "No spoken turns to enhance", "Transcription is incomplete — re-transcribe
  first".
- **Enhance** (meeting menu, right-click a meeting) runs the configured summarizer model over the
  spoken text to fix recognition errors, punctuation and casing, and to restore domain terms from
  **Settings → Domain glossary** (one term per line; known mishearings after a tab, e.g.
  `PayCore⇥пейкор⇥пей кор`). Your own `Note:` lines are never sent; timestamps and speaker labels
  are sent as anchors but are never rewritten. It **overwrites the transcript in place, with no
  backup** — a part the model answers badly is left exactly as it was, if the whole reply is
  unusable nothing is written at all, and while the note is open **Cancel changes** reverts the
  whole run for the rest of the session. Same provider as summarization, so the same privacy note
  applies.

**Summarize, chat, share**

![Summary result: Obsidian-ready YAML frontmatter with participants, then the summary and action items with their owners — demo data](docs/screenshot-summary-light.png)

- Seven built-in prompt templates — Meeting, Daily, Interview, 1-1, Retro, Project, Negotiations —
  plus your own saved prompts.
- The Meeting template emits Obsidian-ready YAML frontmatter and infers real names from what was
  actually said.
- The summary rail draws every preset's sections structurally, not just the Meeting one — action
  items with owner and due date, decisions, risks, blockers, timelines, status, scorecards; about
  forty section kinds in all, each with its own layout. A heading it does not recognise (a custom
  prompt's, or a translated one) falls back to plain Markdown instead of vanishing.
- **Chat with the transcript** (⌘/) — including a live one that is still growing.
- Draft the follow-up e-mail from summary + transcript.
- Share the summary to Email, Slack (converted to Slack markup), Telegram or the clipboard.
- Export the transcript or the summary to PDF or DOCX; **Save As…** writes the plain-text `.txt`,
  and the summary already lives on disk as Obsidian-ready Markdown.

**Library**
- Grouped by date, full-text search with snippets, live folder watching. Recordings that have no
  transcript yet are ordinary rows in the same list, not a second sidebar.
- Filter by work left to do, each chip carrying its own count: `All`, `To transcribe` (audio with
  no transcript), `To re-transcribe` (has audio and came from a model less accurate than
  `large-v3` — a transcript with no `Model:` line is never queued), `To enhance` (has spoken turns,
  never enhanced), `To summarize` (no summary on disk). A transcript that cannot be read appears
  under `All` only, wearing a single **Couldn't read** badge instead of chips that would be guesses.
- Each card shows which model produced the text and four present/absent chips — audio, transcript,
  Enhance, summary — so one glance answers what a meeting still needs. The ⓘ button opens
  **Transcript details**: every line of the file's header, including ones this app never wrote.
- Delete granularly — just the audio, just the transcript, just the summary, or everything.
- Drag & drop, and double-click in Finder via the `unlimeety://` handler.

**Job queue**

![The Jobs panel open over the library: a running transcription with its progress, a queued Enhance, and a finished summary, each with cancel or dismiss](docs/screenshot-queue-light.png)

- One queue owns every transcribe, enhance and summarize run. Submitting always succeeds — the app
  never refuses work because it is busy.
- Three independent lanes, one job at a time each, so an Enhance never waits behind a transcription.
- The clock in the header counts what is queued or running and turns red when something failed.
  Open it for the list: what is running and how far along, what is waiting, what failed and why —
  with Cancel on anything live and ✕ to dismiss anything finished.

**Appearance**

![The same library in the dark theme, the shipped default](docs/screenshot-library-dark.png)

- Dark, Light or System (follow the OS), in **Settings → Appearance** — alongside the date order
  (day-first / month-first) and the 24- or 12-hour clock every card and header stamp uses.
- Settings in full: Summarizer · Appearance · Calendars · Recording · Domain glossary, with the
  running version at the foot.

**Models**
- Six Whisper variants, 99 languages each: `tiny` (74 MB, ~20× realtime), `base` (142 MB, ~12×),
  `small` (480 MB, ~8×), `medium` and `large-v3 turbo` (1.5 GB, ~4× and ~6×) and `large-v3`
  (2.9 GB, ~3×). Download and delete them from inside the app.
- The Live tab deliberately offers only the three smallest — real-time cares about latency far more
  than the last few percent of accuracy. Everywhere else the default is `large-v3`, and the
  automatic run after **Stop & save** always uses it.

**Notes while you record**
- The Live tab opens a small floating note window that stays above full-screen apps; the Record tab
  keeps the same list inline. Enter drops a note into the transcript as a `[mm:ss] Note:` line.
- `Note` is a reserved label: it is never treated as a speaker, cannot be renamed, and is never sent
  to the model during **Enhance**.
- Notes are mirrored to a `<recording>.notes.json` sidecar, so they survive a re-transcription that
  rewrites the transcript underneath them.

**Odds and ends**
- Lives in the menu bar: close the window and meeting detection keeps working.
- Hotkeys: `⌘S` save, `⌘⇧S` save as, `⌘O` open, `⌘N` new, `⌘K` search the library,
  `⌘F` find inside the open note, `⌘R` Record tab, `⌘/` chat, `⌘⏎` create + summarize.
- `⌘F` searches the transcript *and* the summary rail at once, highlighting matches without touching
  the DOM — so click-to-seek and the follow-along highlight keep working while you search.

---

## Installation (no coding required)

### Step 1. Install the desktop app

1. Download the `.dmg`: [Unlimeety-arm64.dmg](https://github.com/cardpay/unlimeety/releases/latest/download/Unlimeety-arm64.dmg)

   All releases: [github.com/cardpay/unlimeety/releases](https://github.com/cardpay/unlimeety/releases).

   **Requires a Mac with Apple Silicon** (M1 or newer) running macOS 14.2+. Intel Macs are not supported — the on-device transcription helper is built for arm64 only. Check with the Apple menu → **About This Mac**: "Chip" should say *Apple M…*.
2. Double-click the downloaded `.dmg` file
3. Drag **Unlimeety** into the **Applications** folder (or `~/Applications`)
4. Close the `.dmg` window
5. Open **Unlimeety** from Launchpad or Finder

> On first launch macOS briefly verifies the app with Apple ("Verifying Unlimeety…"). This is normal — the app is signed with a Developer ID certificate and notarized by Apple. After verification it opens immediately, with no extra clicks in System Settings required.

### Step 2. Grant macOS permissions (first launch only)

The app needs two permissions for the **Live** tab (real-time on-device transcription). They can be granted later, but it's easier to do up front:

- **Microphone** — to capture your voice.
- **System Audio Recording Only** — to capture audio from Zoom / Meet / Teams / browser tabs. The app
  does not need, and does not ask for, screen recording: grant the *audio-only* variant.

Open **System Settings → Privacy & Security**, find both items in the left rail, and toggle **Unlimeety** on. macOS will ask you to quit and relaunch the app — do it. If system audio recording isn't granted, the Live tab will tell you exactly what to enable.

> If you only use the Chrome extension (captions, not on-device transcription), these permissions are not required.

### Step 3. First launch — Whisper model download

The first time you start a session, Unlimeety downloads the selected Whisper model into `~/Library/Application Support/Unlimeety/models/whisperkit/`. The **Live** tab defaults to `base` (142 MB); everything that transcribes after the fact — the **Record** tab's automatic run and the transcribe-settings screen — uses `large-v3` (2.9 GB), since it is not racing speech and can afford the accuracy. This happens once per model; later sessions reuse the cache. A progress indicator is shown while it downloads — be on Wi-Fi for the first run.

### Step 4. Install the Chrome extension (optional — Google Meet only)

Skip this unless you specifically want the caption-based Meet path; the desktop app handles Meet
through the Live tab like any other call.

1. Download and unzip the extension folder (get it from whoever maintains the project)
2. Open Chrome and go to `chrome://extensions/`
3. Enable the **Developer mode** toggle in the top-right corner
4. Click **Load unpacked**
5. Select the `extenstion` folder (yes, the typo is intentional)
6. The extension will appear in the list — make sure it is enabled

> For convenience, pin the extension: click the puzzle icon to the right of the address bar and click the pin next to **Unlimeety**.

### Step 5. Configure the summarizer (optional)

Transcription is always local. The summarizer model is the one place a cloud service can be involved — and only if you pick one. It serves Summarize, Ask AI, follow-up drafts and **Enhance**, so with a cloud provider the transcript text of those runs leaves the Mac. Four providers, in **Settings → Summarizer**:

- **Claude Code** *(default)* — uses the `claude` CLI installed on your machine. See [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code/overview). If `claude` is not in `PATH`, the app will tell you so on the first run.
- **Ollama** — fully local models, nothing leaves the Mac. Requires a running `ollama serve` at `http://localhost:11434` and a pulled model (default `llama3.1`). The context window is yours to raise, so a small local model does not silently truncate a long transcript.
- **OpenRouter** — paste an API key from [openrouter.ai](https://openrouter.ai/), pick a model (default `anthropic/claude-3.5-sonnet`).
- **OpenAI-compatible** — any base URL that speaks the OpenAI API, for self-hosted or corporate gateways.

API keys are encrypted with Electron `safeStorage` (Keychain on macOS).

### Step 6. Usage

**Capturing** — three independent paths:

- **Live tab** (any app — Zoom, Teams, Meet, a browser, a room): open Unlimeety → **Live** tab → pick language and model → **Start**. Mic and system audio are transcribed and diarized locally; **Stop** saves the transcript plus the `.wav`. Or just wait: if auto-detect is on, Unlimeety offers to start recording the moment a call begins.
- **Record tab**: records to `.wav` without live transcription, so it costs almost nothing while the call runs. Pick the transcription language on the recording screen — thirty seconds in you know which one it is. On **Stop & save** a large-v3 diarized transcription starts automatically and an Enhance pass follows; watch both in the queue panel. There is deliberately no model picker here: the background run is always the most accurate one. The transcribe-settings screen is still there to re-run a recording with different settings, or to transcribe several at once. Also imports existing audio files.

  ![The Record tab's start screen: language, microphone and system-audio toggles, an optional title with calendar prefill, and Start recording](docs/screenshot-record-light.png)
- **Chrome extension** (Google Meet only, uses Meet's captions): join a call → the **Unlimeety** panel appears bottom-right → pick a language (Russian / English / Serbian) → click **record**. On **Save** or when you leave the call, the transcript lands in `~/Downloads/Meet_Transcripts/` and opens in the desktop app. Note that **Auto-start recording is on by default** — it begins the moment the call looks active, and switches Meet's captions on to do it. Untick it in the panel if you want the record button to be the only thing that ever starts a recording.

**Then, in the app:** edit the transcript, bind real names to speakers, re-transcribe with a better
model, **Summarize** into `<name>.summary.md` (YAML frontmatter + Markdown, Obsidian-friendly), chat
with the transcript (`⌘/`), draft the follow-up, export or share it. See
[What it does](#what-it-does) for the full set.

---

## Components

### `desktop/` — Desktop App (Electron + Swift helper)

The main application: capture, on-device transcription and diarization, transcript library, editor,
summarization. Feature list is in [What it does](#what-it-does) above.

Under the hood, everything speech-related runs in a Swift helper process built on
[`argmax-oss-swift`](https://github.com/argmaxinc/argmax-oss-swift) (WhisperKit + SpeakerKit, CoreML)
— which is why the interesting half of the app is Apple-Silicon-only. Electron handles the UI, the
library and the LLM calls.

---

### `extenstion/` — Chrome Extension

A Manifest V3 extension for Google Meet, and only Google Meet. It does no audio capture and no speech
recognition of its own: it reads Meet's own caption panel via `MutationObserver` and writes a
transcript file, then opens it in the desktop app through the `unlimeety://` protocol. It makes zero
network requests. Useful when you'd rather not record audio at all — otherwise the Live tab is
strictly more capable.

Caption language: Russian, English or Serbian. Detects participants and attributes lines to them,
auto-saves when you leave the call. The panel is draggable and collapsible and has its own
auto / light / dark theme toggle. Its Note field takes freeform notes while recording — Enter drops
one into the transcript as a `[time] Note:` line, the same marker the desktop Live and Record tabs
write, so a shared summarizer prompt recognizes either source. The field stays disabled until
recording actually starts.

**Auto-start recording** is a checkbox in that panel, **on by default**: the extension starts
recording as soon as a meeting looks active — which also switches Google Meet's captions on for you,
since captions are what it reads. Turn it off and recording only ever starts from the record button.
Ticking it back on mid-call applies from the next call, not the one you are in; turning it off never
stops a recording already running.

**Saved file format.** The extension writes:
```
Meeting: Weekly sync
Recorded-At: 2026-03-19T14:29:41.320Z
Generated: 2026-03-19T14:52:06.885Z
Participants: Alice, Bob, Carol
Language: English

[2:29:41 PM] Alice:
Let's start with the weekly tasks.

[2:29:48 PM] Bob:
Sounds good, I have an update on the project.

[2:29:56 PM] Note:
ask Bob about the staging rollout date
```

The desktop app writes the same header and adds provenance of its own — `Model:` naming the
WhisperKit model that produced the text, `Enhanced:` once the proofreading pass has run over it
(`Enhance-Attempted:` if it ran and rejected everything), `Source:` for the audio it came from, and
`Status: PARTIAL …` on a transcription that was cut short. The card in the Meetings list turns those
into chips, and the ⓘ panel shows them in full. Its turn timestamps are offsets into the recording
(`[mm:ss]`, or `[hh:mm:ss]` past the hour) rather than wall-clock times, which is what makes every
line clickable to seek the audio.

---

## For developers

### Requirements

**All platforms:**
- Node.js >= 18
- npm

**macOS only** (needed for the Live tab — Swift helper that runs WhisperKit/SpeakerKit):
- macOS 14.2 or newer on Apple Silicon (the `live-helper` package declares `.macOS("14.2")` and builds arm64-only)
- Xcode Command Line Tools (`xcode-select --install`) — provides Swift 5.9+
  - For a fresh install of the full Xcode app: `xcode-select -s /Applications/Xcode.app/Contents/Developer`
- First `swift build` will fetch and compile [`argmax-oss-swift`](https://github.com/argmaxinc/argmax-oss-swift) (WhisperKit + SpeakerKit). Expect 3–10 min and a few hundred MB in `live-helper/.build/`.

> **Windows / Linux** builds skip the Swift helper entirely — the Live tab is macOS-only by design. Editor, library and summarization still work.

### Run the desktop app in dev mode

```bash
cd desktop
npm install

# macOS: build the Swift helper once before the first run (needed only if you use the Live tab in dev)
npm run build:helper

npm start          # or: npm run dev   (opens DevTools)
```

The helper binary lives at `desktop/live-helper/.build/release/unlimeety-live`. Rebuild it with `npm run build:helper` after editing any `*.swift` file under `live-helper/Sources/`.

`npm test` covers the pure modules and the renderer logic sliced out for a `vm` sandbox — no Electron, under a second. `npm run check:layout` is the separate geometry check for the Record and Live start screens and the shared "From calendar" popover: it launches its own Electron and drives it over CDP, so it needs a display and Node 22 or newer, and prints one PASS/FAIL line per case.

`npm run screenshots` regenerates every image this README embeds. It builds an invented library — four meetings, one untranscribed recording, synthesized audio — under a scratch `$HOME`, launches its own Electron against it, and photographs six screens over CDP. Your own transcripts are never read and never appear; the two share their CDP plumbing in `scripts/cdp.mjs`, and it needs the same display and Node 22.

### Build the desktop app

```bash
cd desktop
npm install

# macOS — Apple Silicon (~230 MB installed)
npm run build:mac
# same, explicit:
npm run build:mac:arm64

# Windows / Linux (no Live tab — Swift helper is skipped automatically)
npm run build:win
npm run build:linux
```

Every macOS build runs `npm run build:helper` first (`swift build -c release` inside `live-helper/`) and bundles the resulting binary into `Unlimeety.app/Contents/MacOS/unlimeety-live`. If Swift is not on `PATH`, the macOS build fails fast. The helper is arm64-only, so there is no Intel or universal macOS target.

Artifacts land in `desktop/dist/` as `Unlimeety-arm64.dmg` — the name carries no version, so the `releases/latest/download/...` URL above stays valid across releases.

To install the built app into `~/Applications`:

```bash
cp -r desktop/dist/mac-arm64/Unlimeety.app ~/Applications/
```

### Code signing

The app is signed with a *Developer ID Application* certificate (UNLIMINT EU LTD) with hardened runtime enabled, and both the `.app` and the `.dmg` are notarized by Apple — so users get no "unidentified developer" warning. Building a distributable therefore needs an Apple Developer account and a notarytool keychain profile; see [desktop/RELEASE.md](desktop/RELEASE.md) for the full setup. Without the certificate in the login keychain the `build:helper` step fails at `codesign`; without `APPLE_KEYCHAIN_PROFILE` the build completes but notarization is skipped.

### Load the extension for development

1. `chrome://extensions/` → enable **Developer mode**
2. **Load unpacked** → select the `extenstion/` folder
3. After making changes, click the refresh button on the extension card

### Project structure

```
unlimeety/
├── extenstion/                # Chrome Extension (Manifest V3)
│   ├── manifest.json          # Extension config
│   ├── background.js          # Service worker: storage and download
│   ├── content.js             # Widget and caption capture
│   └── content.css            # Widget styles
└── desktop/                   # Electron app
    ├── main.js                # Main process, every IPC handler
    ├── preload.js             # IPC bridge
    ├── job-queue.js           # transcribe / enhance / summarize scheduler
    ├── transcript-enhance.js  # the Enhance pass and its speaker naming
    ├── glossary.js            # domain-glossary parsing
    ├── summary-frontmatter.js # repairs the YAML models write
    ├── live-helper/           # Swift: WhisperKit, SpeakerKit, mic + calendar
    ├── renderer/              # UI
    │   ├── index.html
    │   ├── app.js
    │   ├── live/  record/  notes/  prompt/
    │   └── style.css
    ├── scripts/               # check:layout, screenshots (Electron over CDP)
    ├── test/                  # node --test, Electron-free
    └── package.json
```

## Security & privacy notes

- **All processing is local by default.** Transcription (WhisperKit) and diarization run
  on-device; the browser extension saves transcripts to local files only and makes no
  network requests.
- **Cloud LLM providers are opt-in.** The default summarization provider is the local
  `claude` CLI, and Ollama is fully local too. If you configure a cloud provider
  (OpenRouter / OpenAI-compatible), transcript text is sent to that provider's API over
  HTTPS — and that is true of every feature sharing the provider, not just Summarize:
  **Enhance**, speaker naming, Ask AI and the follow-up draft all send transcript text
  the same way. Your own `Note:` lines are the exception — Enhance never sends them.
- **API key storage.** Provider API keys are encrypted with Electron `safeStorage`
  (Keychain on macOS, DPAPI on Windows). On Linux systems without a secret service,
  the key falls back to plaintext in the app's `config.json`.
- **ML model integrity.** Whisper/diarization models are downloaded from Hugging Face
  (`argmaxinc/whisperkit-coreml`, `argmaxinc/speakerkit-coreml`) over HTTPS; per-file
  checksum pinning is not implemented.
- **Calendar access.** With calendar integration enabled, the app reads event titles,
  participant names, and — when a name is unavailable — participant e-mail addresses
  to build the transcript header. Which calendars are read is yours to pick in
  **Settings → Calendars**. This data stays local unless a cloud LLM provider is
  configured.
- **Meeting detection opens nothing.** Auto-detect asks Core Audio whether the default
  input device is in use — a property query, not a capture — so it needs no microphone
  permission of its own and can never hear the call it notices.

## License

Released under the [MIT License](./LICENSE).

Third-party components (fonts, npm and SwiftPM dependencies) are listed with their
licenses in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md). Bundled fonts
(Inter, JetBrains Mono) are under the SIL Open Font License 1.1.

## Trademarks

The MIT License covers the source code only. "Unlimeety", the name "Unlimit", and the
Unlimit logo (`extenstion/2025_Unlimit_Sign_black.jpg`) are trademarks of Unlimit Holding EU Ltd
and are **not** licensed under the MIT License. Forks and derivative works
must not use these names or logos in a way that implies endorsement by, or affiliation
with, Unlimit Holding EU Ltd or any member of the Unlimit Group.
