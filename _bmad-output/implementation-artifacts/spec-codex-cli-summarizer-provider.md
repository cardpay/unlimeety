---
title: 'Opt-in Codex CLI summarizer provider'
type: 'feature'
created: '2026-09-09'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'fa2446e4a56c82edbc6203b9c13f5e81017c194a'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Summarization defaults to the non-interactive Claude Code command (`claude -p`), but a user signed in to Codex cannot choose their installed Codex CLI for summaries, Ask AI, follow-up drafts, or Enhance.

**Approach:** Add a `codex-cli` provider that invokes `codex exec` through the existing provider paths. Keep Claude Code as the default. Codex is an explicit opt-in because its current CLI has no tool-disable switch equivalent to Claude's `--tools=`; it must be visibly described as read-only sandboxed, not tool-free.

## Boundaries & Constraints

**Always:** Send all dynamic prompt/transcript/chat text only over stdin, retain `framePrompt` framing and forged-marker defanging, and use a constant Codex argv. Run in a newly created, dedicated empty directory below app user data with `--sandbox read-only`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and `--skip-git-repo-check`; do not pass `--search`, MCP configuration, `--add-dir`, a writable sandbox, approval bypass, or an output-file option. Keep the child environment minimal while preserving only what the CLI needs to locate itself and its existing authentication. Reuse the current timeout, cancellation and empty-output handling; no summary is written until a successful result returns.

**Ask First:** Any attempt to make Codex the default provider, loosen its sandbox/environment, load user/project configuration, enable network search/MCP, or claim the provider is tool-free.

**Never:** Do not add an API key/settings form for Codex, persist a transcript or Codex session, fall back to an unisolated Codex invocation, alter Claude's isolation fallback, or add a dependency. Do not replace the existing generic OpenAI-compatible provider.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Selected Codex provider | Framed transcript and fixed summary instruction | `codex exec` receives one stdin payload; only its non-empty successful final stdout becomes the summary | Existing normalization/save flow applies |
| Prompt injection in transcript | Text requests commands, config access, or a role change | The data markers remain and the child has only a read-only, empty workspace with no loaded rules/configuration | No filesystem write or app configuration access is granted |
| Codex unavailable | `codex` cannot be located | The job fails with a Codex-specific install/switch-provider message | No summary file is written |
| Cancellation or timeout | Job is stopped before completion | The Codex child is terminated through the shared abort path and returns canceled | No summary file is written |
| Ask AI / follow-up / Enhance | Codex selected outside the summary modal | Each route uses the same constrained invocation and framing | No silent fallback to Claude |

</frozen-after-approval>

## Code Map

- `desktop/main.js:1220-1391` -- provider defaults, persisted allow-list and public configuration; `codex-cli` needs no credentials or provider-specific fields.
- `desktop/main.js:1396-1689` -- `findClaude`, constant CLI args, process creation, timeout and abort conventions; add bounded Codex discovery/spawn beside this code without weakening Claude's existing isolation fallback.
- `desktop/main.js:1765-1869` -- `framePrompt`, `runSummarizerProvider`, `runSummarizeJob`; summary, follow-up, and speaker naming already converge here and must dispatch to Codex.
- `desktop/main.js:1975-2139` -- Claude chat rendering and the provider switch; Codex needs the equivalent fixed instruction plus rendered, framed chat turns.
- `desktop/renderer/index.html:1150-1171` -- provider picker; render the explicit opt-in safety limitation next to Codex CLI.
- `desktop/renderer/app.js:4510-4514,4735-4757,5160-5188,5376-5448` -- loading copy, missing-provider error, provider visibility and save path; no new settings section is needed.
- `desktop/test/claude-args.test.js` and `desktop/test/prompt-framing.test.js` -- source-level isolation and every-provider framing conventions to extend; process behavior remains manual-app verification.
- `README.md:289-297,482-514` -- provider and privacy disclosures; Codex must be documented as cloud CLI with the accepted read-only-but-not-tool-free limitation.

## Tasks & Acceptance

**Execution:**
- [x] `desktop/main.js` -- add `codex-cli` to configuration and every summarizer/chat dispatch; implement discovery and a stdin-only `codex exec` runner using the fixed least-privilege argument set, isolated working directory, minimal environment, shared timeout/abort semantics, and provider-specific unavailable error.
- [x] `desktop/renderer/index.html` and `desktop/renderer/app.js` -- expose a Codex CLI radio option, accurate loading/error copy, and an unmissable opt-in warning; preserve the current Claude default and credential-free save flow.
- [x] `desktop/test/codex-args.test.js` -- add focused source assertions for constant argv, stdin-only dynamic data, ephemeral/read-only/config-free invocation, isolated CWD, absence of dangerous flags, and cancel/timeout plumbing.
- [x] `desktop/test/prompt-framing.test.js` -- include Codex in the all-provider framing and chat-dispatch checks.
- [x] `README.md` -- document installation/sign-in prerequisite, cloud-data disclosure, CLI isolation, and the fact that read-only sandboxing is not tool disabling.

**Acceptance Criteria:**
- Given Claude remains unconfigured or installed, when Codex CLI is selected, then summarize, Ask AI, follow-up, and Enhance use Codex rather than silently falling back to Claude.
- Given the provider setting is `claude-code`, when the app starts, then existing Claude behavior and default selection are unchanged.
- Given Codex is selected and a transcript contains a command-like injection, when a summary starts, then the child uses only the fixed constrained invocation and framed stdin data.
- Given Codex is absent, stopped, times out, or returns no final output, when a run ends, then the UI reports the outcome and no summary is saved.

## Spec Change Log

## Design Notes

Codex CLI intentionally receives no prompt argument: the complete fixed instruction plus framed content is written to stdin, avoiding command-line injection and argument-length limits. It starts in an empty app-owned directory, which avoids project context but is not a filesystem read boundary. The provider's UI wording is part of the security contract: Codex can be constrained, but the installed CLI does not expose an equivalent of `--tools=`.

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: all existing and Codex isolation/framing source tests pass.
- `cd desktop && npm run check:layout` -- expected: Settings markup/layout checks pass.

**Manual checks (if no CLI):**
- Select Codex CLI, summarize a synthetic transcript containing a command-injection sentence, and confirm ordinary structured output with no new session rollout and no summary until success.
- Rename/remove Codex from `PATH`, submit a summary, and confirm the Codex-specific error with no `.summary.md` file.
- Start a long Codex run and stop it; confirm cancellation and no output file.

**Results (2026-09-09):**
- `cd desktop && npm test` -- passed: 256 tests, including Codex invocation, cleanup, provider persistence, isolation, and framing checks.
- `node --check desktop/main.js` and `node --check desktop/renderer/app.js` -- passed.
- `git diff --check` -- passed.
- `cd desktop && npm run check:layout` -- Electron aborted with `SIGABRT` before the harness executed its layout rows, so installed-app/manual verification remains pending.

## Suggested Review Order

**Constrained Codex invocation**

- Fixed argv, prompt-injection framing, and explicit residual-risk disclosure keep the boundary honest.
  [`main.js:1496`](../../desktop/main.js#L1496)

- The runner limits environment, output, diagnostics, and temporary workspace lifetime.
  [`main.js:1651`](../../desktop/main.js#L1651)

- Provider dispatch reuses all existing summary, chat, and Enhance flows.
  [`main.js:1918`](../../desktop/main.js#L1918)

**Explicit user choice**

- Codex stays opt-in and explains the CLI's unremovable tool capability.
  [`index.html:1156`](../../desktop/renderer/index.html#L1156)

- Loading and unavailable-provider states distinguish Codex from Claude.
  [`app.js:4510`](../../desktop/renderer/app.js#L4510)

**Verification and disclosure**

- A fake child verifies argv, stdin-only data flow, and recursive cleanup.
  [`codex-args.test.js:55`](../../desktop/test/codex-args.test.js#L55)

- Settings persistence proves the selected provider remains Codex after save.
  [`summarizer-key-masking.test.js:310`](../../desktop/test/summarizer-key-masking.test.js#L310)

- Documentation states cloud transfer and the limits of read-only sandboxing.
  [`README.md:291`](../../README.md#L291)
