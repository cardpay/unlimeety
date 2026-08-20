- source_spec: `_bmad-output/implementation-artifacts/spec-interrupt-summarize.md`
  summary: A renderer reload can desync `runningSummarize` (renderer) from `summarizeInFlight` (main), producing a confusing generic error on a second summarize attempt instead of an accurate "still running" message.
  evidence: Verified real by edge-case-hunter review + code trace. Root cause (no reload-state-resync mechanism between renderer and main) is pre-existing and applies identically to Enhance's `runningEnhance`/`enhanceInFlight` pair, so it is not introduced by the cancel-summarize change — just newly exposed by its added `summarizeInFlight` guard.

- source_spec: `_bmad-output/implementation-artifacts/spec-interrupt-summarize.md`
  summary: Canceling a claude-code summarize only sends SIGTERM (`proc.kill()`) with no escalation or exit confirmation, and on Windows the child is spawned through a shell, so killing the shell's PID may not kill the actual `claude.cmd` grandchild.
  evidence: Verified real by blind-hunter review. `proc.kill()` is the exact mechanism the pre-existing 5-minute timeout kill already used (`desktop/main.js`, before this change) — the cancel feature reuses it rather than introducing the weakness.

- source_spec: `_bmad-output/implementation-artifacts/spec-interrupt-summarize.md`
  summary: `summarize:run` has no teardown handling for a destroyed or navigating-away renderer window, unlike Enhance's `event.sender.once('destroyed', ...)` / `'did-start-navigation'` listeners — a closed/reloaded window mid-summary leaves the provider call running with no one to receive the result.
  evidence: Verified real by blind-hunter review. `summarize:run` never had this handling before the cancel-summarize change either; not introduced by it.

- source_spec: `_bmad-output/implementation-artifacts/spec-interrupt-summarize.md`
  summary: Opening the Summarize modal on a different file while another file is already being summarized gives no early indication — the user only learns via `modalBusyBanner` after typing a prompt and pressing "Summarize".
  evidence: Verified real by blind-hunter review. 100% pre-existing `modalBusyBanner` behavior; this change only added the same-file early branch and left the different-file case untouched.
