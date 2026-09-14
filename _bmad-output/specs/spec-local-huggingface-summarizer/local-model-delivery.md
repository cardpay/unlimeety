# Local Model Delivery Contract

## Model manifest

The application ships a static reviewed manifest. Each entry contains only: stable model ID, display name, Hugging Face repository, immutable revision, allowed filename, expected byte size, SHA-256, format, minimum RAM, supported platforms, and concise quality/language disclosure. The renderer receives a display-only projection; the main process owns all artifact coordinates and paths.

The first catalog entry is selected only after a reproducible local quality, latency, memory, and license review. Adding or changing an entry requires a code-reviewed manifest update and matching automated validation; it is never fetched from Hugging Face at runtime.

## Download and lifecycle

1. Settings displays only manifest entries relevant to the current platform and reports download size and required RAM before download.
2. The user explicitly starts a download. Main process preflights sufficient free space, creates an app-owned model directory, and downloads over HTTPS to a unique temporary file.
3. Main process verifies exact size and SHA-256 before atomically promoting the file to its manifest-derived destination. Installed state is written only after promotion.
4. Cancellation, process failure, a non-HTTPS response, a redirect outside the expected artifact location, size mismatch, or checksum mismatch removes the temporary file and reports a non-selectable failure.
5. Removal is an explicit Settings action. It removes only the manifest-derived installed artifact and its local state; it never deletes user-selected folders or other provider state.

## Inference boundary

The embedded runtime is launched only from a bundled, reviewed binary or framework chosen before implementation. It receives fixed options selected by the app and dynamic transcript/chat data through an in-memory API or standard input, never shell interpolation or model-controlled argv. It cannot initiate model downloads, load plug-ins, execute model-provided code, access arbitrary paths supplied by the renderer, or switch to a cloud provider.

The local provider returns the same `{ ok, summary }` / `{ ok, reply }` shape as existing providers. Existing `framePrompt` framing remains before provider dispatch; framing is defense in depth, not a reason to loosen the manifest or process boundary.

## Verification

- Unit-test manifest validation: reject unknown fields, mutable revisions, non-HTTPS endpoints, unsupported formats, path traversal, invalid sizes, and invalid hashes.
- Unit-test the downloader with a local fixture: successful hash promotion; cancellation, truncation, wrong size, and wrong hash leave no installed model or temporary artifact.
- Unit-test provider routing so a selected local model reaches Summarize, Ask AI, follow-up, and Enhance without falling back to another provider.
- Test renderer/main IPC validation: hostile model IDs, paths, URLs, and options cannot reach filesystem, downloader, or runner calls.
- Manually verify on a supported fresh machine: download progress, low-disk failure, retry after interruption, model removal, and all four routes in airplane mode.
- Benchmark and record the initial model's quality, latency, peak memory, and license before adding it to the shipping manifest.
