import Foundation
import WhisperKit

// StreamingTranscriber — fed 16 kHz mono Float32 samples, emits text segments
// as JSON lines via Helper.emit, and also surfaces finalized segments to
// LiveSession via `onFinalized` so they can later be relabeled by the batch
// diarizer.
//
// Protocol:
//   • while accumulating samples, we periodically re-decode the buffer and
//     emit the result as `final:false` (grey / italic in the UI);
//   • once a silence gap is detected or the buffer cap is hit, we decode
//     one last time, emit `final:true`, and start a fresh buffer.

actor StreamingTranscriber {
    typealias Segment = LiveSession.FinalizedSegment

    private let source: String
    private let language: String
    private let kit: WhisperKit

    // Called once per finalized text segment, so LiveSession can stash it.
    private let onFinalized: (Segment) async -> Void

    // Rolling PCM buffer (16 kHz mono).
    private var buffer: [Float] = []
    private var segmentStartSample: Int = 0
    private var decodeTask: Task<Void, Never>?
    // Serial chain of finalize-decodes. `feed` must return promptly (its caller
    // is the audio SamplePipe consumer; if it blocks on an inline WhisperKit
    // decode the lossy AsyncStream drops audio buffers). So finalize snapshots
    // the buffer synchronously and appends the heavy decode to this chain, which
    // runs one segment at a time in arrival order. `flush` awaits the tail.
    private var finalizeChain: Task<Void, Never>?
    private var lastPartialEmit = Date(timeIntervalSince1970: 0)
    private var silenceSamples: Int = 0

    private let sampleRate = 16_000
    // A segment is finalized after this much contiguous trailing silence.
    private let silenceThresholdSamples = 16_000          // ~1.0 s
    private let minSpeechSamples        = 16_000 / 2       // ignore buffers < 0.5 s
    private let partialIntervalMs: Double = 700
    private let maxSegmentSamples       = 16_000 * 20      // hard cap at 20 s
    // VAD gate: skip Whisper entirely if the buffer never crossed this peak.
    // Whisper hallucinates `[музыка]` / `[music]` / "Спасибо за просмотр" on
    // pure silence or low-level background hum — keeping it out of the model
    // is the only reliable cure.
    private let speechPeakThreshold: Float = 0.02

    // RMS below which we skip decoding altogether (prevents hallucinations
    // on pure silence buffers).
    private let silenceRmsGate: Float = 0.005

    // Well-known Whisper hallucination phrases. WhisperKit (like whisper.cpp)
    // tends to emit these end-card / boilerplate strings on silence or noise
    // because the underlying model was trained on YouTube subtitles. The
    // entries below are stored ALREADY CANONICALIZED (see `canonicalize`):
    // lowercased, trimmed of trailing punctuation/quotes/brackets, with
    // internal whitespace runs collapsed to single spaces.
    private static let hallucinationPhrases: Set<String> = {
        let raw: [String] = [
            // Russian
            "Продолжение следует",
            "Субтитры подогнал «Студия Линкер»",
            "Субтитры сделал DimaTorzok",
            "Спасибо за просмотр",
            "Спасибо за внимание",
            "Подписывайтесь на канал",
            "Редактор субтитров А.Синецкая Корректор А.Егорова",
            "Субтитры создавал DimaTorzok",
            "ПРОДОЛЖЕНИЕ СЛЕДУЕТ...",
            "Игорь Жуков",
            "Удачи!",
            "Спасибо.",
            "Ставьте лайки",
            "Не забудьте подписаться",
            // English / generic
            "Thank you.",
            "Thanks for watching!",
            "you",
            ".",
            "♪",
            "[Music]",
            "[BLANK_AUDIO]",
        ]
        return Set(raw.map { canonicalize($0) })
    }()

    static func make(
        source: String,
        modelFolder: URL,
        modelName: String,
        language: String,
        onFinalized: @escaping (Segment) async -> Void
    ) async throws -> StreamingTranscriber {
        // `modelFolder` already points at the variant directory containing
        // the `.mlmodelc` files (resolved by `ModelLoader.ensureModel`), so
        // we disable WhisperKit's own download logic.
        let config = WhisperKitConfig(
            model: modelName,
            modelFolder: modelFolder.path,
            verbose: false,
            logLevel: .error,
            prewarm: true,
            load: true,
            download: false
        )
        let kit = try await WhisperKit(config)
        return StreamingTranscriber(
            source: source,
            language: language,
            kit: kit,
            onFinalized: onFinalized
        )
    }

    private init(
        source: String,
        language: String,
        kit: WhisperKit,
        onFinalized: @escaping (Segment) async -> Void
    ) {
        self.source = source
        self.language = language
        self.kit = kit
        self.onFinalized = onFinalized
    }

    // ─── Feed loop ──────────────────────────────────────────────────────────

    func feed(samples: [Float]) async {
        buffer.append(contentsOf: samples)

        let rms = Self.rms(of: samples)
        if rms < 0.01 {
            silenceSamples += samples.count
        } else {
            silenceSamples = 0
        }

        if buffer.count >= maxSegmentSamples {
            finalizeCurrent()
            return
        }

        if silenceSamples >= silenceThresholdSamples &&
           buffer.count > silenceThresholdSamples + minSpeechSamples {
            finalizeCurrent()
            return
        }

        let now = Date()
        if now.timeIntervalSince(lastPartialEmit) * 1000 >= partialIntervalMs {
            lastPartialEmit = now
            schedulePartialDecode()
        }
    }

    func flush() async {
        if !buffer.isEmpty {
            finalizeCurrent()
        }
        decodeTask?.cancel()
        // Wait for every queued finalize-decode (including the one just enqueued)
        // to finish so the last segments are emitted before the session tears down.
        await finalizeChain?.value
    }

    // ─── Decoding ───────────────────────────────────────────────────────────

    private func schedulePartialDecode() {
        decodeTask?.cancel()
        let snapshot = buffer
        let startSec = Double(segmentStartSample) / Double(sampleRate)

        decodeTask = Task { [weak self] in
            guard let self = self else { return }
            await self.decodeAndEmit(samples: snapshot, startSec: startSec, final: false)
        }
    }

    // Synchronous: snapshots and resets the rolling buffer on the actor, then
    // enqueues the (slow) decode onto `finalizeChain` so the caller — ultimately
    // the audio pipe consumer — returns immediately instead of blocking on
    // WhisperKit. Decodes still run one at a time, in arrival order.
    private func finalizeCurrent() {
        decodeTask?.cancel()
        let snapshot = buffer
        let startSec = Double(segmentStartSample) / Double(sampleRate)
        segmentStartSample += buffer.count
        buffer.removeAll(keepingCapacity: true)
        silenceSamples = 0

        if snapshot.count < minSpeechSamples { return }

        let previous = finalizeChain
        finalizeChain = Task { [weak self] in
            await previous?.value
            guard let self = self else { return }
            await self.decodeAndEmit(samples: snapshot, startSec: startSec, final: true)
        }
    }

    private func decodeAndEmit(samples: [Float], startSec: Double, final: Bool) async {
        // Pre-decode silence gates: avoid both wasted compute and the most
        // common Whisper hallucination trigger (decoding near-silence).
        // Peak first — branch-only, rejects truly silent buffers. Then RMS
        // — catches low-level hum that has the occasional sample spike.
        let bufferPeak = Self.peak(of: samples)
        if bufferPeak < speechPeakThreshold {
            Helper.log("filtered hallucination (\(source)): <silence peak=\(bufferPeak)>")
            return
        }
        let bufferRms = Self.rms(of: samples)
        if bufferRms < silenceRmsGate {
            Helper.log("filtered hallucination (\(source)): <silence rms=\(bufferRms)>")
            return
        }

        do {
            let options = DecodingOptions(
                verbose: false,
                task: .transcribe,
                language: language == "auto" ? nil : language,
                temperature: 0.0,
                temperatureFallbackCount: 0,
                withoutTimestamps: true,
                suppressBlank: true,
                compressionRatioThreshold: 2.4,
                logProbThreshold: -1.0,
                noSpeechThreshold: 0.6
            )
            let results = try await kit.transcribe(audioArray: samples, decodeOptions: options)
            let text = results.map { $0.text }.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { return }
            if Self.isNonSpeechMarker(text) { return }

            // Post-decode hallucination denylist: drop boilerplate end-card
            // phrases that Whisper emits on near-silence / noise.
            let canon = Self.canonicalize(text)
            if Self.hallucinationPhrases.contains(canon) {
                Helper.log("filtered hallucination (\(source)): \(text)")
                return
            }

            let durSec = Double(samples.count) / Double(sampleRate)
            let speaker = (source == "mic") ? "Me" : "…"

            Helper.emit([
                "type": "segment",
                "source": source,
                "speaker": speaker,
                "start": startSec,
                "end": startSec + durSec,
                "text": text,
                "final": final
            ])

            if final {
                let seg = LiveSession.FinalizedSegment(
                    start: startSec, end: startSec + durSec,
                    text: text, speaker: speaker
                )
                await onFinalized(seg)
            }
        } catch is CancellationError {
            return
        } catch {
            Helper.log("decode error (\(source)): \(error.localizedDescription)")
        }
    }

    private static func rms(of samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Float = 0
        for s in samples { sum += s * s }
        return (sum / Float(samples.count)).squareRoot()
    }

    private static func peak(of samples: [Float]) -> Float {
        var p: Float = 0
        for s in samples {
            let a = s < 0 ? -s : s
            if a > p { p = a }
        }
        return p
    }

    // Whisper loves to emit bracketed non-speech markers on silence —
    // [музыка], [music], (applause), 【拍手】, etc. If the *entire* decoded
    // text is a single bracketed token, drop it.
    private static func isNonSpeechMarker(_ text: String) -> Bool {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    .trimmingCharacters(in: CharacterSet(charactersIn: ".,!?…"))
        guard let first = s.first, let last = s.last else { return false }
        let openers: Set<Character> = ["[", "(", "{", "（", "【", "《"]
        let closers: Set<Character> = ["]", ")", "}", "）", "】", "》"]
        return openers.contains(first) && closers.contains(last)
    }

    /// Canonicalize a transcript candidate for denylist comparison:
    ///   1. lowercase
    ///   2. strip leading/trailing whitespace
    ///   3. strip trailing punctuation `.?!…` and quote/bracket characters
    ///   4. collapse internal whitespace runs to a single space
    /// This is applied identically to both the decoded text and each
    /// denylist entry so that variants like "Продолжение следует...",
    /// "  продолжение  следует ", and "«Продолжение следует»" all match.
    private static func canonicalize(_ s: String) -> String {
        let trailingStripSet: Set<Character> = [
            ".", "?", "!", "…",
            "\"", "'", "“", "”", "‘", "’", "«", "»",
            "(", ")", "[", "]", "{", "}",
            " ", "\t", "\n", "\r"
        ]
        let leadingStripSet: Set<Character> = trailingStripSet

        let chars = Array(s.lowercased())
        // Trim leading
        var start = 0
        while start < chars.count, leadingStripSet.contains(chars[start]) {
            start += 1
        }
        // Trim trailing
        var end = chars.count
        while end > start, trailingStripSet.contains(chars[end - 1]) {
            end -= 1
        }
        let trimmed = String(chars[start..<end])

        // Collapse internal whitespace runs to single spaces.
        var out = ""
        out.reserveCapacity(trimmed.count)
        var inWS = false
        for ch in trimmed {
            if ch.isWhitespace {
                if !inWS {
                    out.append(" ")
                    inWS = true
                }
            } else {
                out.append(ch)
                inWS = false
            }
        }
        return out
    }
}
