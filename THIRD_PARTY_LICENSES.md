# Third-Party Licenses

Unlimeety is released under the MIT License (see [`LICENSE`](./LICENSE)).
It bundles or depends on the third-party components listed below, each under its own
license. All of them are permissive (MIT / ISC / BSD / Apache-2.0 / BlueOak) or the
SIL Open Font License; none impose copyleft obligations on this project.

## Fonts — SIL Open Font License 1.1

Bundled font files are licensed under the SIL Open Font License, Version 1.1.
The full license text ships alongside the fonts:

- [`desktop/renderer/fonts/OFL.txt`](./desktop/renderer/fonts/OFL.txt)
- [`extenstion/fonts/OFL.txt`](./extenstion/fonts/OFL.txt)

| Font | Copyright | Upstream |
|------|-----------|----------|
| Inter | Copyright (c) The Inter Project Authors | https://github.com/rsms/inter |
| JetBrains Mono | Copyright (c) The JetBrains Mono Project Authors | https://github.com/JetBrains/JetBrainsMono |

## npm — shipped in the desktop app

| Package | License | Notes |
|---------|---------|-------|
| docx | MIT | .docx export (`desktop/package.json` runtime dependency) |
| electron | MIT | Application runtime |
| ffmpeg (inside Electron) | LGPL-2.1 | Ships as a dynamically linked `libffmpeg.dylib` inside the Electron framework. Standard Electron build without GPL codecs (no `--enable-gpl`). Not vendored into this repository. |

## npm — development only (not shipped)

| Package | License | Notes |
|---------|---------|-------|
| electron-builder (and its dependency tree) | MIT / ISC / BSD-2-Clause / BSD-3-Clause / Apache-2.0 / BlueOak-1.0.0 | Build tooling only. `jszip` (transitive) is dual-licensed `MIT OR GPL-3.0-or-later`; used here under the MIT option. |

## Swift (SwiftPM) — desktop live-helper

| Package | License | Notes |
|---------|---------|-------|
| argmaxinc/argmax-oss-swift (WhisperKit, SpeakerKit) | MIT | On-device transcription and diarization |
| apple/swift-argument-parser | Apache-2.0 | CLI argument parsing |
| huggingface/swift-transformers | Apache-2.0 | Transitive dependency of argmax-oss-swift |

Apache-2.0 components are used in accordance with the Apache License, Version 2.0;
their copyright and NOTICE information is preserved by this attribution.

## ML model weights

Speech-recognition and speaker-diarization model weights (e.g. Whisper `large-v3-turbo`)
are **not** included in this repository or in the source distribution. They are downloaded
at runtime on first launch. If model weights are ever redistributed together with a binary
build of the application, their individual licenses must be reviewed separately.
