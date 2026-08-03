import Foundation
import WhisperKit
import SpeakerKit

// Transcribe a saved WAV with WhisperKit + diarize it with SpeakerKit, all
// in batch mode. Emits the same event shapes the renderer already handles
// (`modelDownload`, `segment` with `final:true`, `diarizing`,
// `diarizationComplete`, `stopped`) so the UI can be largely reused.

struct TranscribeFileCommand: Decodable {
    let cmd: String
    let path: String
    let model: String
    let modelDir: String
    let language: String
    // Optional knobs from the Record tab settings. All optional so older
    // payloads (without these fields) decode unchanged and keep prior behaviour.
    let diarize: Bool?            // run speaker diarization (default: true)
    let numberOfSpeakers: Int?    // expected speaker count; nil = auto-detect
    let initialPrompt: String?    // bias spelling of proper nouns / jargon
    let temperature: Float?       // decoder temperature (default: 0.0)
    let vadFilter: Bool?          // VAD-based chunking to skip silence
}

actor FileTranscriber {
    private let config: TranscribeFileCommand
    private var cancelled = false

    init(config: TranscribeFileCommand) {
        self.config = config
    }

    func run() async {
        do {
            try await runInner()
            Helper.emit(["type": "stopped"])
        } catch {
            Helper.emit(["type": "error", "message": "transcribe failed: \(error.localizedDescription)"])
            Helper.emit(["type": "stopped"])
        }
    }

    func cancel() {
        cancelled = true
    }

    private func runInner() async throws {
        Helper.emit(["type": "transcribeStarted", "path": config.path])

        // 1. Load audio.
        let url = URL(fileURLWithPath: config.path)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw LiveError.audio("recording not found at \(config.path)")
        }
        Helper.log("file transcribe: loading \(url.path)")
        let samples = try WAVReader.readAsMono16k(url: url)
        if samples.isEmpty {
            throw LiveError.audio("recording is empty")
        }
        let durationSec = Double(samples.count) / 16_000.0
        Helper.emit(["type": "loaded", "durationSec": durationSec, "samples": samples.count])

        if cancelled { return }

        // 2. Download / load the WhisperKit model.
        let modelFolder = try await ModelLoader.ensureModel(
            name: config.model,
            inDir: config.modelDir,
            onProgress: { pct in
                Helper.emit(["type": "modelDownload", "progress": pct])
            }
        )
        if cancelled { return }

        let kit = try await WhisperKit(WhisperKitConfig(
            model: config.model,
            modelFolder: modelFolder.path,
            verbose: false,
            logLevel: .error,
            prewarm: true,
            load: true,
            download: false
        ))
        if cancelled { return }

        // 3. Batch transcribe with timestamps. WhisperKit chunks the audio
        //    internally into 30 s windows and stitches them. We emit each
        //    returned segment immediately so the UI can stream them in.
        Helper.emit(["type": "transcribing"])

        // Initial prompt → conditioning tokens (biases spelling of proper
        // nouns and jargon). Same recipe as Argmax's TranscribeCLI: prefix a
        // space, then drop any special tokens the encoder might emit.
        var promptTokens: [Int]? = nil
        if let prompt = config.initialPrompt?.trimmingCharacters(in: .whitespacesAndNewlines),
           !prompt.isEmpty, let tokenizer = kit.tokenizer {
            promptTokens = tokenizer.encode(text: " " + prompt)
                .filter { $0 < tokenizer.specialTokens.specialTokenBegin }
        }

        // VAD filter (Silero) maps to WhisperKit's VAD chunking. Leave nil when
        // the field is absent (old payloads) to preserve prior behaviour.
        let chunkingStrategy: ChunkingStrategy? = config.vadFilter.map { $0 ? .vad : ChunkingStrategy.none }

        let options = DecodingOptions(
            verbose: false,
            task: .transcribe,
            language: config.language == "auto" ? nil : config.language,
            temperature: config.temperature ?? 0.0,
            withoutTimestamps: false,
            promptTokens: promptTokens,
            suppressBlank: true,
            chunkingStrategy: chunkingStrategy
        )

        let results = try await kit.transcribe(audioArray: samples, decodeOptions: options)
        if cancelled { return }

        // Flatten and emit. Speaker label starts as "…" — filled in after
        // diarization, same convention as live mode.
        var segs: [LiveSession.FinalizedSegment] = []
        for r in results {
            for s in r.segments {
                let start = Double(s.start)
                let end   = Double(s.end)
                let text  = Self.cleanText(s.text)
                if text.isEmpty { continue }
                segs.append(LiveSession.FinalizedSegment(
                    start: start, end: end, text: text, speaker: "…"
                ))
                Helper.emit([
                    "type": "segment",
                    "source": "system",
                    "speaker": "…",
                    "start": start,
                    "end": end,
                    "text": text,
                    "final": true,
                ])
            }
        }

        // 4. Diarize the same buffer to get speaker time ranges, then relabel.
        //    A diarization failure (model missing, network down, etc.) must
        //    not throw away the transcript — emit the text we have and
        //    continue with the placeholder speaker labels. When the user
        //    turned diarization off, skip the whole pass and keep placeholders.
        if config.diarize ?? true {
            Helper.emit(["type": "diarizing"])
            let speakerRanges: [(start: Double, end: Double, label: String)]
            do {
                speakerRanges = try await diarize(samples: samples)
            } catch {
                Helper.emit([
                    "type": "diarizationFailed",
                    "message": error.localizedDescription,
                ])
                speakerRanges = []
            }
            if cancelled { return }

            relabel(segments: &segs, using: speakerRanges)
        }

        let payload: [[String: Any]] = segs.map { s in
            [
                "start":   s.start,
                "end":     s.end,
                "text":    s.text,
                "speaker": s.speaker,
            ]
        }
        Helper.emit(["type": "diarizationComplete", "segments": payload])
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    private func diarize(samples: [Float]) async throws -> [(start: Double, end: Double, label: String)] {
        guard samples.count >= 8000 else { return [] } // < 0.5 s — skip
        // See note in OnlineDiarizer: use `downloadBase`, not `modelFolder`,
        // so SpeakerKit actually fetches the model on first run.
        let kit = try await SpeakerKit(PyannoteConfig(
            downloadBase: config.modelDir,
            modelRepo: "argmaxinc/speakerkit-coreml",
            download: true,
            load: true,
            verbose: false,
            logLevel: .error
        ))
        // Honour the user's expected-speaker count when given; nil = auto.
        let options = PyannoteDiarizationOptions(numberOfSpeakers: config.numberOfSpeakers)
        let result = try await kit.diarize(audioArray: samples, options: options)
        var labelMap: [Int: String] = [:]
        var ranges: [(Double, Double, String)] = []
        for seg in result.segments {
            let key = seg.speaker.speakerId ?? -1
            if labelMap[key] == nil {
                labelMap[key] = "S\(labelMap.count + 1)"
            }
            ranges.append((Double(seg.startTime), Double(seg.endTime), labelMap[key]!))
        }
        return ranges.map { (start: $0.0, end: $0.1, label: $0.2) }
    }

    private func relabel(
        segments: inout [LiveSession.FinalizedSegment],
        using ranges: [(start: Double, end: Double, label: String)]
    ) {
        guard !ranges.isEmpty else { return }
        for i in 0..<segments.count {
            let s = segments[i]
            var best: (overlap: Double, label: String) = (0, s.speaker)
            for r in ranges {
                let overlap = max(0, min(s.end, r.end) - max(s.start, r.start))
                if overlap > best.overlap {
                    best = (overlap, r.label)
                }
            }
            segments[i].speaker = best.label
        }
    }

    // Whisper meta-tokens leak into segment.text when `withoutTimestamps:
    // false`. They look like `<|startoftranscript|>`, `<startoftranscript>`,
    // `<ru>`, `<transcribe>`, `<0.00>`, `<|notimestamps|>`, etc. — anything
    // shaped like `<...>` with optional pipes, no whitespace inside, no
    // angle brackets nested. Strip them all and collapse the leftover spaces.
    private static let tokenRegex: NSRegularExpression = {
        // The `try!` is justified: the pattern is a compile-time constant.
        return try! NSRegularExpression(pattern: #"<\|?[^<>|\s]*\|?>"#, options: [])
    }()

    private static func cleanText(_ raw: String) -> String {
        let range = NSRange(raw.startIndex..., in: raw)
        let stripped = tokenRegex.stringByReplacingMatches(
            in: raw, options: [], range: range, withTemplate: ""
        )
        // Collapse runs of whitespace that the strip left behind.
        let collapsed = stripped
            .replacingOccurrences(of: "\u{00A0}", with: " ")
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return collapsed
    }
}
