---
id: SPEC-local-huggingface-summarizer
companions:
  - local-model-delivery.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate.

# Downloadable Local Hugging Face Summarizer

## Why

Users should be able to summarize privately without installing Ollama, configuring an API key, or relying on a developer CLI. The app already downloads Whisper models for on-device transcription; a similarly direct local-model experience makes private summarization a usable product path rather than a manual setup exercise.

## Capabilities

- **CAP-1**
  - **intent:** A user can select a downloaded local model and summarize, ask questions, draft follow-ups, and Enhance without sending transcript or chat text to a network service.
  - **success:** After a supported model is installed, all four existing summarizer routes return local output while the device is offline.

- **CAP-2**
  - **intent:** A user can explicitly download, inspect, select, and remove a supported local model without using a terminal.
  - **success:** Settings reports the model's size, hardware requirement, download/verification progress, installed state, and actionable failure state; removal makes it unavailable to select.

- **CAP-3**
  - **intent:** The app accepts only reviewed model artifacts and never treats model metadata as executable instructions.
  - **success:** A download is usable only after its pinned revision, filename, size, and SHA-256 match the bundled manifest; cancellation, interruption, or verification failure leaves no selectable model.

## Constraints

- The provider works after an explicit download without an API key, Ollama, an external CLI, or a cloud fallback.
- Only a bundled reviewed manifest may identify Hugging Face artifacts; arbitrary repositories, URLs, model-provided code, remote configuration, and `trust_remote_code`-style behavior are forbidden.
- Downloads require explicit user action, preflight available disk space, use an app-owned directory, and use a temporary file plus atomic promotion only after verification.
- Local inference remains in the existing trusted main-process provider path; preserve `framePrompt` data framing, forged-marker defanging, cancellation, timeout, and no-write-until-success behavior.
- Existing Claude, Codex, Ollama, and OpenAI-compatible settings and behavior remain unchanged; no provider is silently substituted.
- The renderer cannot supply model paths, shell arguments, repository identifiers, or executable options to the main process.

## Non-goals

- Supporting arbitrary Hugging Face models, custom model URLs, model training, or model conversion.
- Bundling a multi-gigabyte LLM in the application installer.
- Replacing the existing Ollama provider or changing any cloud provider's privacy contract.
- Claiming quality, language coverage, or platform support beyond the benchmarked initial catalog entry.

## Success signal

A fresh supported-device user downloads one reviewed model from Settings, selects it, disconnects from the network, and successfully uses Summarize, Ask AI, follow-up drafts, and Enhance with no terminal or credential setup. A corrupted or interrupted download never becomes selectable.

## Assumptions

- The initial catalog can contain one model if its requirements and installed state are accurately disclosed.

## Open Questions

- Which embedded inference runtime and packaging/license strategy should serve the first macOS Apple-Silicon release: MLX, llama.cpp, or another reviewed runtime?
- Which exact Hugging Face model revision, quantization, minimum RAM, download size, and quality benchmark define the initial catalog entry?
- Is the embedded local provider macOS Apple-Silicon-only at launch, or must Windows/Linux be supported in the same release?
