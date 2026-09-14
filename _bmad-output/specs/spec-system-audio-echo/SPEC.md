---
id: SPEC-system-audio-echo
companions: []
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate.

# Intelligible Speaker-and-System Recordings Without Headphones

## Why

When a user records with speakers instead of headphones and captures both microphone and system audio, the microphone contains a delayed acoustic copy of the system signal. The current direct sum makes the saved WAV unintelligible, blocking transcription and playback for the common no-headphones setup.

## Capabilities

- **CAP-1**
  - **intent:** A user can record microphone and system audio without a delayed loudspeaker copy making the saved WAV unintelligible, while retaining the user's near-field speech and system audio.
  - **success:** A synthetic microphone signal containing near-field speech plus a short delayed system copy has materially less delayed-copy energy after mixing, while the speech and system reference remain present; Record and Live WAV paths use the same behavior.

## Constraints

- Use the already captured digital system-audio stream as the echo reference at the shared audio-mix stage; do not add a cloud service or a new runtime dependency.
- Recordings with only one selected source retain their current path and level behavior; echo processing must not discard frames or block capture callbacks.
- Apple's voice-processing flag remains disabled for this path because the current engine has no audio render graph and enabling it can silence microphone capture.

## Non-goals

- Perfect cancellation for every room, speaker, microphone, or rapidly changing acoustic path.
- Changes to source-selection UI, transcription models, diarization, permissions, or Live per-source transcript behavior.

## Success signal

With speakers active, a saved recording keeps the user's voice and remote/system speech intelligible instead of producing a loud delayed double signal. The deterministic delayed-echo check and the existing test suite pass; real speaker-plus-microphone smoke testing remains the final device-level confirmation.

## Assumptions

- Express mode is sufficient because the failure and desired outcome are explicit.
- The fix covers both Record and Live saved WAV paths because both combine the same microphone and system captures; per-source Live transcript lanes remain unchanged.

## Open Questions

- What speaker volume, microphone distance, and room geometry define the supported acoustic ceiling for acceptance testing?
