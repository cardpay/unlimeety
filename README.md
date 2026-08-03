# Unlimeety — Google Meet Transcription

A toolkit for capturing Google Meet captions and working with transcripts: a Chrome extension and a desktop editor app.

## How it works

1. The **Chrome extension** captures captions directly from the Google Meet page in real time
2. On "Save" (or when leaving the call) the transcript is written to `~/Downloads/Meet_Transcripts/`
3. The **desktop app** automatically opens the file for editing and summarization

```
Google Meet  →  Chrome Extension  →  .txt file  →  Desktop App
                                                     ├── Edit
                                                     └── Summarize (Claude)
```

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
- **Screen & System Audio Recording** — to capture audio from Google Meet / Zoom / browser tabs.

Open **System Settings → Privacy & Security**, find both items in the left rail, and toggle **Unlimeety** on. macOS will ask you to quit and relaunch the app — do it. If you don't grant Screen Recording, the Live tab will tell you exactly what to enable.

> If you only use the Chrome extension (captions, not on-device transcription), these permissions are not required.

### Step 3. First launch — Whisper model download

The first time you start a session in the **Live** tab, Unlimeety downloads a Whisper model (~1.5 GB for `large-v3-turbo`, the default) into `~/Library/Application Support/Unlimeety/models/whisperkit/`. This happens once; subsequent sessions reuse the cached model. A progress indicator is shown in the Live tab. Make sure you're on Wi-Fi for the first run.

### Step 4. Install the Chrome extension

1. Download and unzip the extension folder (get it from whoever maintains the project)
2. Open Chrome and go to `chrome://extensions/`
3. Enable the **Developer mode** toggle in the top-right corner
4. Click **Load unpacked**
5. Select the `extenstion` folder (yes, the typo is intentional)
6. The extension will appear in the list — make sure it is enabled

> For convenience, pin the extension: click the puzzle icon to the right of the address bar and click the pin next to **Unlimeety**.

### Step 5. Configure the summarizer (optional)

The desktop app supports three providers for AI summarization. Pick one in **Settings → Summarizer**:

- **Claude Code** *(default)* — uses the `claude` CLI installed on your machine. See [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code/overview). If `claude` is not in `PATH`, the app will tell you so on the first run.
- **OpenRouter** — paste an API key from [openrouter.ai](https://openrouter.ai/), pick a model (default `anthropic/claude-3.5-sonnet`).
- **Ollama** — local models. Requires a running `ollama serve` at `http://localhost:11434` and a pulled model (default `llama3.1`).

### Step 6. Usage

**Capturing a meeting** — two independent paths:

- **Chrome extension** (Google Meet only, uses captions): join a Meet call → the **Unlimeety** panel appears in the bottom-right corner → pick a language (Russian / English / Serbian) → click **record** → captions are captured automatically. On **Save** or when you leave the call, the transcript lands in `~/Downloads/Meet_Transcripts/` and opens in the desktop app.
- **Desktop "Live" tab** (any app — Meet, Zoom, browser, anything that plays audio): open Unlimeety → **Live** tab → pick language and model → press **Start**. Audio is captured from system output + microphone and transcribed locally via WhisperKit. Press **Stop** to save.
- **Desktop "Record" tab**: records audio to a `.wav` file without live transcription. You can transcribe the file later from the library.

**In the app you can:**
- Edit the transcript (Cmd+S / Cmd+Shift+S to save).
- Click **Summarize** — the result is written next to the transcript as `<name>.summary.md` (YAML frontmatter + Markdown body, Obsidian-friendly).
- Delete transcripts, summaries, or paired audio recordings from the library.

---

## Components

### `extenstion/` — Chrome Extension

A Google Meet extension (Manifest V3) that injects a widget panel into the call page.

**Features:**
- Real-time caption capture via MutationObserver
- Caption language selection (Russian, English, Serbian)
- Participant detection and speaker identification
- Auto-save on call exit
- Auto-open transcript in the desktop app via the `unlimeety://` protocol

**Saved file format:**
```
Meeting: Weekly sync
Participants: Alice, Bob, Carol
Language: English
Generated: 2026-03-19, 14:30:00

[14:30:05] Alice:
Let's start with the weekly tasks.

[14:30:12] Bob:
Sounds good, I have an update on the project.
```

---

### `desktop/` — Desktop App (Electron)

A transcript editor with a file library and summarization.

**Features:**
- Transcript library from `~/Downloads/Meet_Transcripts/` grouped by date
- Full-featured text editor (monospace font, word and line count)
- Open files via button, drag & drop, or Finder double-click
- Save / Save As (Cmd+S / Cmd+Shift+S)
- Transcript summarization via Claude Code CLI
- Delete transcripts from the library
- macOS and Windows support
- `unlimeety://` protocol for integration with the extension

**Summarization** requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) to be installed (`claude` in PATH). The result is saved next to the transcript as a `.summary.md` file in Obsidian-compatible format (YAML frontmatter + Markdown body).

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
    ├── main.js                # Main process
    ├── preload.js             # IPC bridge
    ├── renderer/              # UI
    │   ├── index.html
    │   ├── app.js
    │   └── style.css
    └── package.json
```

## Security & privacy notes

- **All processing is local by default.** Transcription (WhisperKit) and diarization run
  on-device; the browser extension saves transcripts to local files only and makes no
  network requests.
- **Cloud LLM providers are opt-in.** The default summarization provider is the local
  `claude` CLI. If you configure a cloud provider (OpenRouter / OpenAI-compatible),
  transcript text is sent to that provider's API over HTTPS.
- **API key storage.** Provider API keys are encrypted with Electron `safeStorage`
  (Keychain on macOS, DPAPI on Windows). On Linux systems without a secret service,
  the key falls back to plaintext in the app's `config.json`.
- **ML model integrity.** Whisper/diarization models are downloaded from Hugging Face
  (`argmaxinc/whisperkit-coreml`, `argmaxinc/speakerkit-coreml`) over HTTPS; per-file
  checksum pinning is not implemented.
- **Calendar access.** With calendar integration enabled, the app reads event titles,
  participant names, and — when a name is unavailable — participant e-mail addresses
  to build the transcript header. This data stays local unless a cloud LLM provider
  is configured.

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
