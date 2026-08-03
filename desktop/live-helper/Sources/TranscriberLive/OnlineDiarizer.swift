import Foundation
import SpeakerKit

// BatchDiarizer — accumulates the full system-audio stream during the session
// and runs SpeakerKit's batch `diarize(audioArray:)` on it. The cached
// SpeakerKit instance is created lazily on first use and reused across calls
// so periodic re-diarization (every ~30s during recording) doesn't pay the
// multi-second model-load cost on each tick.
//
// Two entry points:
//   • snapshot()  — diarize the CURRENT buffer without clearing it; used for
//                   periodic progress updates while recording.
//   • finalize()  — same as snapshot(), kept as a name for the stop-time pass.
//   • clear()     — drop the buffer; called explicitly at stop time.
//
// While recording, the UI shows `…` as the placeholder speaker for system
// segments and replaces them with S1/S2/… as periodic updates arrive (and
// once more, authoritatively, after Stop).

actor BatchDiarizer {
    private var buffer: [Float] = []
    private let sampleRate: Int = 16_000
    private let modelDir: String

    // Lazily-created, reused SpeakerKit instance. nil before first use; set
    // on first successful load. If load fails we mark `kitFailed` so we
    // don't keep retrying (and don't keep re-emitting the unavailable
    // event).
    private var kit: SpeakerKit?
    private var kitFailed: Bool = false

    init(modelDir: String) {
        self.modelDir = modelDir
    }

    /// Append a chunk of 16 kHz mono PCM samples to the session buffer.
    func feed(samples: [Float]) {
        buffer.append(contentsOf: samples)
    }

    /// Number of samples currently buffered (used by LiveSession to decide
    /// whether enough audio has accumulated to make a tick worthwhile).
    func bufferedSamples() -> Int {
        buffer.count
    }

    /// Run SpeakerKit on the accumulated buffer WITHOUT clearing it.
    /// Returns a list of (startSec, endSec, label) tuples covering the
    /// audio observed so far. Safe to call repeatedly.
    func snapshot() async -> [(start: Double, end: Double, label: String)] {
        guard buffer.count >= sampleRate / 2 else { return [] } // need at least 0.5s
        guard !kitFailed else { return [] }

        // Lazily load (and cache) the SpeakerKit instance on first call.
        // Use `downloadBase` (not `modelFolder`): setting `modelFolder` tells
        // SpeakerKit "skip download — use this exact path as the resolved
        // model dir". With `downloadBase` it downloads into
        // `<base>/models/argmaxinc/speakerkit-coreml/…` on first run and
        // serves from cache on subsequent runs.
        if kit == nil {
            do {
                let config = PyannoteConfig(
                    downloadBase: modelDir,
                    modelRepo: "argmaxinc/speakerkit-coreml",
                    download: true,
                    load: true,
                    verbose: false,
                    logLevel: .error
                )
                kit = try await SpeakerKit(config)
            } catch {
                kitFailed = true
                Helper.log("diarization init failed: \(error)")
                Helper.emit([
                    "type": "diarizationUnavailable",
                    "message": error.localizedDescription,
                ])
                return []
            }
        }

        guard let kit = kit else { return [] }

        do {
            let result = try await kit.diarize(audioArray: buffer)

            // Map cluster ids to stable S1, S2, ... in order of first
            // appearance.
            var labelMap: [Int: String] = [:]
            var segments: [(Double, Double, String)] = []

            for seg in result.segments {
                let key = seg.speaker.speakerId ?? -1
                if labelMap[key] == nil {
                    labelMap[key] = "S\(labelMap.count + 1)"
                }
                segments.append((Double(seg.startTime), Double(seg.endTime), labelMap[key]!))
            }
            return segments.map { (start: $0.0, end: $0.1, label: $0.2) }
        } catch {
            Helper.log("diarization failed: \(error.localizedDescription)")
            return []
        }
    }

    /// Run SpeakerKit on the accumulated buffer. Returns a list of
    /// (startSec, endSec, label) tuples covering the whole recording.
    /// Equivalent to `snapshot()`; kept as a separate name to make the
    /// stop-time call site read clearly.
    func finalize() async -> [(start: Double, end: Double, label: String)] {
        await snapshot()
    }

    func clear() {
        buffer.removeAll(keepingCapacity: false)
    }
}
