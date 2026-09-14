---
title: 'Beta integration policy and personal-data commit guard'
type: 'feature'
created: '2026-09-08'
status: 'done'
review_loop_iteration: 0
baseline_commit: '0a7438f9e3f229d7046921fe9cb8a550b405ec64'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The repository documents a direct feature-to-main PR flow, while the desired delivery flow is local integration into `beta`. It also relies on an optional manual grep before push, which cannot stop personal data from entering a local commit.

**Approach:** Document one beta-first integration and release policy, and ship installable Git hooks backed by a dependency-free scanner. The scanner checks staged paths/content and commit messages for a hashed denylist of the reported incident indicators plus a hashed corporate-email-domain indicator, without retaining their plaintext values in the repository.

## Boundaries & Constraints

**Always:** Completed `feature/*` branches merge locally into `beta` without a PR; `beta` may be pushed. Only `beta` may open a PR to `main`. A pre-release build, notarization, upload, tag, or GitHub release requires the user's explicit request for that release. The scanner reads staged index content rather than working-tree files, blocks matching file names as well as text, permits synthetic `@example.com` fixtures, and exits non-zero before a violating commit is created. Both hook entry points call the same Node scanner. All stored denylist indicators are one-way SHA-256 digests of normalized candidates; no real name, internal meeting title, or corporate address/domain is added as plaintext.

**Ask First:** Expanding the denylist beyond the incident indicators, allowing a bypass, scanning commit history or untracked files, or adding a hosted/remote secret-management dependency.

**Never:** Create PRs into `beta`, publish a pre-release automatically, rewrite history, scan or log unstaged personal data, block every email/name-like string, or put real personal data into source, tests, documentation, specs, comments, commit messages, or fixtures.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Clean staged code | Synthetic text and `@example.com` addresses | `pre-commit` succeeds | N/A |
| Corporate address | Staged path or content contains an address with the protected domain | `pre-commit` fails and identifies only the file/path and rule class | Commit is stopped without echoing sensitive text |
| Incident indicator | Staged content, filename, or commit message contains a normalized blocked candidate | Relevant hook fails without printing the candidate | Commit is stopped |
| Empty or binary staged file | No text candidate can be decoded | Scanner completes safely without false detection | Treat as non-text; preserve Git's normal commit behavior |
| Fresh clone/worktree | Versioned hooks exist but `core.hooksPath` is unset | Installer configures local hooks path and reports success | Exit non-zero outside a Git worktree |
| Beta release work | Beta is ready but no explicit release request exists | Documentation instructs no build, tag, upload, or release publication | Wait for user request |

</frozen-after-approval>

## Code Map

- `AGENTS.md` -- durable contributor policy; replace direct feature-to-main PR rule and retain the personal-data prohibition outside the managed context block.
- `desktop/RELEASE.md` -- release and beta-pre-release procedures; align branch entry points and insert the explicit-user-request gate before any publication action.
- `.githooks/pre-commit` / `.githooks/commit-msg` -- tracked executable Git entry points; staged data and final commit messages need distinct hooks.
- `scripts/check-personal-data.js` -- shared Node-only scanner; read index blobs/paths or a supplied message file, normalize candidates, compare SHA-256 digests, and emit safe diagnostics.
- `scripts/personal-data-denylist.json` -- opaque, versioned SHA-256 digests and rule labels; never plaintext indicators.
- `scripts/install-git-hooks.sh` -- explicit post-clone/worktree installer for `core.hooksPath=.githooks`; Git does not install tracked hooks itself.
- `desktop/test/personal-data-guard.test.js` -- node:test coverage for scanner modes, hook wiring, installer contract, and safe diagnostics.

## Tasks & Acceptance

**Execution:**
- [x] `AGENTS.md` and `desktop/RELEASE.md` -- document the beta integration, beta push, main PR, and explicit-release-request rules -- prevent workflow drift.
- [x] `.githooks/pre-commit`, `.githooks/commit-msg`, and `scripts/install-git-hooks.sh` -- add executable, dependency-free hook installation and entry points -- cover staged data and commit messages in every configured local worktree.
- [x] `scripts/check-personal-data.js` and `scripts/personal-data-denylist.json` -- implement normalized hashed matching for the protected domain and incident indicators, with only safe diagnostics -- stop concrete leaks without committing plaintext data.
- [x] `desktop/test/personal-data-guard.test.js` -- execute every matrix scenario and assert hook/installer contracts -- make the guard regression-proof.

**Acceptance Criteria:**
- Given a feature is complete, when following repository policy, then it merges locally into `beta`, and a PR is only opened from `beta` to `main`.
- Given a staged candidate or commit message matches a protected digest, when Git invokes the relevant hook, then the commit fails without printing the sensitive candidate.
- Given a clean staged fixture or `@example.com` address, when the pre-commit hook runs, then it succeeds.
- Given `npm test` runs from `desktop/`, when the guard is implemented, then all existing and new tests pass.

## Spec Change Log

## Design Notes

The denylist is intentionally narrow. Generic detection of people and meeting titles would both miss real data and reject synthetic fixtures. Digest comparison keeps the incident values out of the repository while still catching case/whitespace-normalized forms. A pre-commit hook cannot inspect the final message; `commit-msg` calls the same scanner against Git's message file.

## Verification

**Commands:**
- `cd desktop && npm test` -- expected: all tests, including the personal-data guard, pass.
- `git diff --check` -- expected: no whitespace errors.
- `scripts/install-git-hooks.sh && git config --local --get core.hooksPath` -- expected: `.githooks` is configured for this repository.

**Manual checks (if no CLI):**
- Review a release procedure from a beta checkout and confirm it stops before publication until an explicit user request exists.

## Suggested Review Order

**Policy and release boundaries**

- Establishes the durable beta-first integration and explicit-release authorization rules.
  [`AGENTS.md:66`](../../AGENTS.md#L66)

- Puts the authorization gate before every release-publication instruction.
  [`RELEASE.md:5`](../../desktop/RELEASE.md#L5)

**Commit-time enforcement**

- Scans staged index blobs and commit messages using opaque, normalized digest matching.
  [`check-personal-data.js:18`](../../scripts/check-personal-data.js#L18)

- Installs hooks safely without replacing an independently configured hook path.
  [`install-git-hooks.sh:4`](../../scripts/install-git-hooks.sh#L4)

- Keeps the protected indicators as versioned SHA-256 digests only.
  [`personal-data-denylist.json:1`](../../scripts/personal-data-denylist.json#L1)

**Regression coverage**

- Exercises scanner edge cases and real Git hook rejection without sensitive fixtures.
  [`personal-data-guard.test.js:74`](../../desktop/test/personal-data-guard.test.js#L74)
