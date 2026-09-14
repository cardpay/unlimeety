---
title: 'Downloadable local Hugging Face summarizer'
type: 'feature'
created: '2026-09-09'
status: 'done'
review_loop_iteration: 0
baseline_commit: '17ac0bf9b46ae426cfab1b369eb4735746dc5d66'
context:
  - '_bmad-output/specs/spec-local-huggingface-summarizer/SPEC.md'
  - '_bmad-output/specs/spec-local-huggingface-summarizer/local-model-delivery.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Private summarization currently requires a configured external CLI, API, or Ollama. A fresh—or formerly default-only—installation also silently uses Claude rather than asking for an explicit privacy and quality choice.

**Approach:** Ship a macOS Apple-Silicon local provider backed by the signed llama.cpp `b10516` arm64 runner (source commit `b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9`; release archive SHA-256 `ee3324327d621026ae80c24031670e65fa62a0b23a3a027dbe2f65f240affd30`) and a bundled, reviewed Qwen3 GGUF catalog. Downloads and inference remain main-process-owned; the first attempted summary/enhance requires a deliberate provider choice, while stored provider selections remain unchanged.

## Boundaries & Constraints

**Always:** Keep dynamic transcript and chat data framed by `framePrompt`, defanged, sent only over the runner's stdin, cancellable, time-bounded, and unwritten until success. The manifest is static code: only its IDs may cross IPC; it owns every repository/revision/file/size/hash/path/argument. Download to a unique app-owned temporary file, preflight `statfs` capacity, stream SHA-256 and byte count, fsync, atomically promote only on an exact match, and remove partials on every failure/cancel. Use `fromMain` on every new model IPC. The catalog is macOS arm64 only: Fast `Qwen3-1.7B-Q8_0` (1,834,426,016 bytes; revision `90862c4b9d2787eaed51d12237eafdfe7c5f6077`; SHA-256 `061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a`; 8 GB RAM), Recommended `Qwen3-4B-Q4_K_M` (2,497,280,256; `bc640142c66e1fdd12af0bd68f40445458f3869b`; `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`; 16 GB), and Quality `Qwen3-8B-Q4_K_M` (5,027,783,488; `7c41481f57cb95916b40956ab2f0b139b296d974`; `d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785`; 24 GB). Benchmark all three before release and disclose measured—not invented—latency, peak memory, language, and quality limits.

**Ask First:** Changing the catalog artifacts, hardware disclosures, llama.cpp pin/licensing, bundled runner entitlements, timeout/context/output caps, adding a platform, allowing an unreviewed redirect host, or changing a saved provider's selection.

**Never:** Accept a renderer path, URL, revision, file name, shell argument, runtime option, remote configuration, plug-in, `trust_remote_code`, cloud fallback, or arbitrary HF repository. Do not change existing Claude, Codex, Ollama, OpenRouter, or OpenAI-compatible behavior; do not ship weights in the installer or build/release/notarize it in this task.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| First provider use | no explicit `summarizer.provider`, including an upgraded default-only profile | chooser blocks model work; Local HF is privacy-recommended, Qwen3-4B is recommended in its Fast/Recommended/Quality catalog; Claude has `Quality · Cloud`, Codex `Speed · Cloud`, Ollama `Local` badges | no provider is silently run |
| Existing selection | stored valid provider | current selection and routes are unchanged | no onboarding prompt |
| Verified download | manifest ID, sufficient space, exact HTTPS artifact | progress then installed/selectable state after atomic promotion | only display-safe status crosses IPC |
| Interrupted, redirected, short, or corrupt download | cancel/network/hash/size/redirect failure | model remains unselectable and retryable | temp and state are removed |
| Local inference | selected installed model; airplane mode | Summarize, Ask AI, follow-up, and Enhance return existing local result shapes | timeout/cancel/no output leaves summaries and transcripts untouched |
| Removal | manifest ID for installed artifact | artifact/state removed; provider cannot be selected until another installed model is chosen | never touches user paths or other providers |

</frozen-after-approval>

## Code Map

- `desktop/main.js:68-120` -- atomic config persistence; add an explicit-choice marker without inferring a choice from the legacy default.
- `desktop/main.js:1220-1391` -- provider schema and sanitized Settings IPC; extend only with a manifest-backed `local-hf` branch.
- `desktop/main.js:1925-2302,2978-3241` -- framed summary/follow-up/Ask/Enhance dispatches; local provider must cover both summary and chat switches and preserve Enhance's no-write guard.
- `desktop/main.js:612-650,3383-3399,3743-3811` -- atomic-write and Whisper-cache precedents; reuse the app-owned cache/progress shape, not the insecure downloader.
- `desktop/preload.js:34-82` -- add narrow local-model operations, never a generic filesystem or process bridge.
- `desktop/renderer/index.html:1150-1225`, `desktop/renderer/app.js:4235,4707,4803,5157-5456`, `desktop/renderer/style.css` -- chooser, Settings catalog/state, badges, and the two initiating flows.
- `desktop/package.json:30-61`, `desktop/RELEASE.md:121-182` -- package a signed arm64 runner alongside the existing helper and document its independent signature verification.
- `desktop/test/prompt-framing.test.js`, `summarizer-key-masking.test.js`, `path-guards.test.js`, `preload-split.test.js` -- existing framing, persistence, trust-boundary, atomic-write, and bridge checks to extend.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/local-model-manifest.js`, `desktop/main.js` -- define and strictly validate the immutable catalog; implement contained state, disk preflight, manual HTTPS redirect validation, streaming verified download/cancel/removal, and fixed signed-runner invocation.
- [x] `desktop/main.js`, `desktop/preload.js` -- add guarded display/status, download/cancel/remove, selection, and local summary/chat IPC; route every existing model operation through the local provider without fallback.
- [x] `desktop/renderer/index.html`, `desktop/renderer/app.js`, `desktop/renderer/style.css` -- add the first-use chooser and Settings catalog with progress, requirements, error/retry/remove states, Local HF recommendation, and approved cloud/local badges.
- [x] `desktop/local-llm/`, `desktop/package.json`, `desktop/RELEASE.md` -- add the pinned `b10516` llama.cpp arm64 runner, verify its release-archive SHA before packaging, and verify its signed binary in the release procedure; no runtime download or model-provided code path.
- [x] `desktop/test/local-models.test.js` and affected existing tests -- cover hostile IPC, manifest rejection, downloader lifecycle, persistence/migration, routing/framing, cancellation, and no-write failures.

**Acceptance Criteria:**
- Given an installed catalog model and no network, when each of the four routes runs, then it returns local output and never invokes another provider.
- Given an existing explicit provider, when the app updates, then its stored selection remains active without a chooser.
- Given a profile without an explicit provider, when it starts Summarize or Enhance, then it must choose before model work begins.
- Given any failed download, when Settings reloads, then the artifact is absent and cannot be selected.

## Spec Change Log

## Design Notes

`summarizer.provider` itself is the migration boundary: its absence has always meant an implicit Claude default but now deliberately means “not chosen.” This cannot distinguish an untouched older profile from a fresh one; the user explicitly chose to show both the new dialog rather than silently preserve that implicit default. The runner takes a fixed manifest-derived model path and fixed options; a purpose-built stdin protocol avoids both shell interpolation and a loopback server.

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: all provider, downloader, bridge, and legacy tests pass.
- `cd desktop && npm run check:layout` -- expected: Settings and chooser layout checks pass.
- `node --check desktop/main.js && node --check desktop/renderer/app.js` -- expected: syntax passes.

**Manual checks (if no fixture runner):**
- On a clean macOS arm64 profile, use every chooser option; confirm badges, persistence, local-model progress, cancellation/retry/removal, and no silent provider substitution.
- After an installed local download, disconnect networking and exercise Summarize, Ask AI, follow-up, and Enhance; then corrupt an artifact and confirm it is rejected before use.

**Results (2026-09-09):**
- `cd desktop && npm test` -- passed: 272 tests, including local HTTPS fixture promotion, allowed/rejected redirects, cancellation, stale-part cleanup, short writes, truncation, wrong-size, and wrong-hash cleanup.
- `node --check main.js && node --check preload.js && node --check renderer/app.js && node --check local-model-download.js && node --check local-llm/fetch-runner.mjs && node --check local-llm/runner-download.mjs` -- passed.
- `git diff --check` -- passed.
- `cd desktop && npm run check:layout` -- passed: 23/23 rows.
- Packaged arm64 runner/download/inference and full manual UI checks remain unverified because build, model download, notarization, and release are explicitly out of scope.

## Suggested Review Order

**Secure local-model boundary**

- Immutable catalog keeps every artifact identity and hardware disclosure out of renderer control.
  [`local-model-manifest.js:5`](../../desktop/local-model-manifest.js#L5)

- Streaming downloader verifies redirects, size, hash, writes, and promotion before availability.
  [`local-model-download.js:23`](../../desktop/local-model-download.js#L23)

- Main process owns platform gating, integrity caching, disk preflight, fixed runner invocation, and guarded IPC.
  [`main.js:1310`](../../desktop/main.js#L1310)

- Existing provider persistence gains an explicit-choice boundary without changing saved selections.
  [`main.js:1275`](../../desktop/main.js#L1275)

**Inference and onboarding**

- Provider dispatch uses the local route for summaries and retains no-fallback result semantics.
  [`main.js:2196`](../../desktop/main.js#L2196)

- Ask AI receives the same explicit-choice guard and dedicated local-chat route.
  [`main.js:2547`](../../desktop/main.js#L2547)

- Narrow preload methods expose model operations, never paths, URLs, arguments, or repository identifiers.
  [`preload.js:50`](../../desktop/preload.js#L50)

- Settings catalog and chooser preserve existing providers while making first use deliberate.
  [`app.js:5178`](../../desktop/renderer/app.js#L5178)

- Provider cards disclose privacy and cloud speed/quality trade-offs at selection time.
  [`index.html:1320`](../../desktop/renderer/index.html#L1320)

**Packaged runtime and evidence**

- Runner fetch follows bounded approved redirects and validates the pinned archive before extraction.
  [`runner-download.mjs:1`](../../desktop/local-llm/runner-download.mjs#L1)

- Packaging prepares, signs, and ships the runner with its dylibs on arm64 macOS builds.
  [`package.json:13`](../../desktop/package.json#L13)

- Focused HTTPS fixtures pin download lifecycle, security boundary, routing, and onboarding regressions.
  [`local-models.test.js:77`](../../desktop/test/local-models.test.js#L77)
