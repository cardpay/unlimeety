import Foundation
import AVFoundation

// Orchestrates one live-transcription session:
//   • starts audio capture (mic + system)
//   • loads WhisperKit (downloading the chosen model if absent)
//   • pipes audio chunks into per-source StreamingTranscriber instances
//   • accumulates the full system-audio stream in BatchDiarizer so, at stop
//     time, SpeakerKit can label each time range with a stable speaker id
//   • optionally tees the same audio into a WAV on disk (when config.outputPath
//     is set) — mirrors RecordingSession so Live now leaves both transcript
//     and audio on disk, paired by stem
//   • emits JSON events via Helper.emit

actor LiveSession {
    private let config: StartCommand
    private var captures: [AudioCapture] = []
    private var transcribers: [String: StreamingTranscriber] = [:]
    private var diarizer: BatchDiarizer?
    // All finalized system-audio text segments, in emission order, so we can
    // rewrite their speaker labels after batch diarization completes.
    private var systemFinalized: [FinalizedSegment] = []
    private var stopped = false
    // Periodic re-diarization task, spawned at start() and cancelled at
    // stop(). It re-runs SpeakerKit every ~30s on the buffer-so-far and
    // emits diarizationUpdate events so the UI flips placeholder labels
    // to S1/S2/… while recording is still in progress.
    private var diarTickerTask: Task<Void, Never>?
    private static let diarTickInterval: UInt64 = 30 * 1_000_000_000 // 30s in ns
    private static let diarMinSamples: Int = 16_000 * 10 // ~10s of 16 kHz mono

    // ─── Optional WAV tee ───────────────────────────────────────────────────
    // When config.outputPath is set, the audio captures tee every sample into
    // these LOSSLESS sinks (fed synchronously on the audio thread, BEFORE the
    // lossy ASR pipe). A writer task drains them every 100 ms and appends to a
    // 16 kHz mono WAV. Feeding the WAV from the lossy pipe's consumer instead
    // was the "chipmunk" bug: when the system consumer stalled on batch
    // re-diarization the pipe dropped frames, so the system track came out
    // short + sped up while the mic track stayed full length.
    private let outputURL: URL?
    private var writer: WAVWriter?
    private let micRec: RecordSink?
    private let systemRec: RecordSink?
    private var drainTask: Task<Void, Never>?
    private let wavSampleRate: Double = 16_000

    struct FinalizedSegment {
        let start: Double
        let end: Double
        let text: String
        var speaker: String
    }

    init(config: StartCommand) {
        self.config = config
        if let p = config.outputPath, !p.isEmpty {
            self.outputURL = URL(fileURLWithPath: p)
            // Lossless sinks exist only when we're recording to disk. Created
            // per-source so the captures can tee straight into them.
            self.micRec = config.sources.contains("mic") ? RecordSink() : nil
            self.systemRec = config.sources.contains("system") ? RecordSink() : nil
        } else {
            self.outputURL = nil
            self.micRec = nil
            self.systemRec = nil
        }
    }

    func start() async throws {
        let modelFolder = try await loadModels()

        let wantMic    = config.sources.contains("mic")
        let wantSystem = config.sources.contains("system")

        if !wantMic && !wantSystem {
            throw LiveError.config("no audio sources selected")
        }

        if wantMic {
            let trans = try await StreamingTranscriber.make(
                source: "mic",
                modelFolder: modelFolder,
                modelName: config.model,
                language: config.language,
                onFinalized: { _ in /* mic segments need no post-processing */ }
            )
            transcribers["mic"] = trans
            // VP off: enabling Apple's voice-processing audio unit on an
            // AVAudioEngine that has no active output graph silences the
            // input on macOS 13+ (the unit can't compute a reference signal
            // and bypasses the mic instead of passing it through). Record
            // already does this for a different reason; both paths now match.
            let cap = try MicCapture(
                onSamples: { [weak self] pcm in
                    await self?.feedMic(samples: pcm)
                },
                onRecord: micRec.map { sink in { @Sendable samples in sink.append(samples) } },
                echoCancellation: false
            )
            // Retain the capture in `self.captures` BEFORE the suspension
            // point of `cap.start()`. Otherwise `cap` is only kept alive by
            // a local `let` while the actor awaits, and a misbehaving task
            // executor could in theory drop it on resume.
            captures.append(cap)
            try await cap.start()
        }

        if wantSystem {
            diarizer = BatchDiarizer(modelDir: config.modelDir)
            let trans = try await StreamingTranscriber.make(
                source: "system",
                modelFolder: modelFolder,
                modelName: config.model,
                language: config.language,
                onFinalized: { [weak self] seg in
                    await self?.recordSystemFinal(seg: seg)
                }
            )
            transcribers["system"] = trans
            let cap = try SystemAudioCapture(
                onSamples: { [weak self] pcm in
                    await self?.feedSystem(samples: pcm)
                },
                onRecord: systemRec.map { sink in { @Sendable samples in sink.append(samples) } }
            )
            captures.append(cap)
            try await cap.start()
        }

        // Open the optional WAV writer after captures are up but before we
        // emit "recording": if WAV creation fails we want to surface it before
        // the UI flips to "Recording" state. Failures here are non-fatal — we
        // emit an error event and continue with transcription only.
        if let url = outputURL {
            do {
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                writer = try WAVWriter(url: url, sampleRate: wavSampleRate)
                startDrainTask()
                Helper.log("WAV tee enabled → \(url.path)")
            } catch {
                writer = nil
                // No writer ⇒ no drain task. Disable the sinks so the captures'
                // tee stops accumulating audio nobody will ever drain.
                micRec?.disable()
                systemRec?.disable()
                Helper.emit([
                    "type": "error",
                    "message": "wav writer init failed: \(error.localizedDescription)",
                ])
            }
        }

        Helper.log("session started with sources: \(config.sources.joined(separator: ","))")
        // Signal the renderer that everything is initialised and audio is
        // flowing; the UI uses this to flip from "Loading…" to "Recording".
        Helper.emit(["type": "recording"])

        // Kick off periodic re-diarization if we have a system source.
        if wantSystem {
            startDiarTicker()
        }
    }

    // Spawn a background task that re-diarizes the buffer-so-far every
    // ~30s. Cancelled in stop().
    private func startDiarTicker() {
        diarTickerTask?.cancel()
        diarTickerTask = Task { [weak self] in
            while true {
                do {
                    try await Task.sleep(nanoseconds: LiveSession.diarTickInterval)
                } catch {
                    return // cancelled
                }
                guard let self else { return }
                if Task.isCancelled { return }
                await self.diarTick()
            }
        }
    }

    private func diarTick() async {
        if stopped { return }
        guard let diar = diarizer else { return }

        // Skip if we don't have enough audio yet — diarization on <10s of
        // signal isn't useful and just burns CPU.
        let samples = await diar.bufferedSamples()
        if samples < LiveSession.diarMinSamples { return }

        let speakerRanges = await diar.snapshot()
        if speakerRanges.isEmpty { return }
        if stopped { return }

        relabel(segments: &systemFinalized, using: speakerRanges)

        let payload: [[String: Any]] = systemFinalized.map { s in
            [
                "start": s.start,
                "end":   s.end,
                "text":  s.text,
                "speaker": s.speaker,
            ]
        }
        Helper.emit(["type": "diarizationUpdate", "segments": payload])
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true

        // Cancel the periodic re-diarization ticker before we tear anything
        // down so it doesn't race with the final pass below.
        diarTickerTask?.cancel()
        diarTickerTask = nil

        // Stop the WAV drain task before stopping captures so we don't keep
        // pulling samples that nobody will read; the final flush below picks
        // up whatever made it into the buffers before captures stopped.
        drainTask?.cancel()
        _ = await drainTask?.value
        drainTask = nil

        // Stop audio inputs so no new samples arrive.
        for cap in captures { cap.stop() }

        // Flush in-flight transcription (emits any remaining text segments).
        for (_, trans) in transcribers {
            await trans.flush()
        }

        // Drain any residual mic/system samples to the WAV before we tear
        // diarization down. After this the writer is finalised and we emit
        // recordSaved so main.js / the UI know the audio is on disk.
        if writer != nil {
            flushFinal()
            let frames = writer?.framesWritten ?? 0
            let durationSec = Double(frames) / wavSampleRate
            let savedPath = outputURL?.path ?? ""
            writer?.close()
            writer = nil
            Helper.emit([
                "type": "recordSaved",
                "path": savedPath,
                "durationSec": durationSec,
            ])
        }

        // Run batch diarization on the full system buffer, re-label segments
        // in place, and emit a diarization-complete event so the renderer
        // (and the save step in main.js) can use the final speaker labels.
        if let diar = diarizer {
            Helper.emit(["type": "diarizing"])
            let speakerRanges = await diar.finalize()
            relabel(segments: &systemFinalized, using: speakerRanges)

            let payload: [[String: Any]] = systemFinalized.map { s in
                [
                    "start": s.start,
                    "end":   s.end,
                    "text":  s.text,
                    "speaker": s.speaker,
                ]
            }
            Helper.emit(["type": "diarizationComplete", "segments": payload])
            await diar.clear()
        }

        captures.removeAll()
        transcribers.removeAll()
        diarizer = nil
    }

    private func feedMic(samples: [Float]) async {
        guard !stopped else { return }
        // The WAV recording is teed losslessly inside MicCapture (via micRec),
        // BEFORE the lossy ASR pipe — it never depends on this consumer. Here we
        // only feed the transcriber, which tolerates dropped frames.
        await transcribers["mic"]?.feed(samples: samples)
    }

    private func feedSystem(samples: [Float]) async {
        guard !stopped else { return }
        // WAV is teed losslessly in SystemAudioCapture (via systemRec); this
        // consumer feeds only ASR. Stalling here on re-diarization can no longer
        // shorten the recording — that asymmetry was the "chipmunk" bug.
        await diarizer?.feed(samples: samples)
        await transcribers["system"]?.feed(samples: samples)
    }

    private func recordSystemFinal(seg: FinalizedSegment) async {
        systemFinalized.append(seg)
    }

    // Assign a speaker label to each text segment based on maximum time
    // overlap with the diarization ranges.
    private func relabel(
        segments: inout [FinalizedSegment],
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

    // ─── WAV tee plumbing ───────────────────────────────────────────────────
    // Mirrors RecordingSession's pattern: a detached task drains mic/system
    // queues every 100 ms, mixing into a single mono signal when both sources
    // are active. The "min(mic, system)" lock-step keeps the two streams in
    // sync; small per-callback jitter shows up as bounded latency rather than
    // file-level drift.

    private func startDrainTask() {
        drainTask = Task.detached(priority: .userInitiated) { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000)
                await self?.drainChunk()
            }
        }
    }

    private func drainChunk() {
        guard writer != nil else { return }

        if let micRec, let systemRec {
            let take = min(micRec.count(), systemRec.count())
            guard take > 0 else { return }
            writeMixed(mic: micRec.takePrefix(take), system: systemRec.takePrefix(take))
        } else if let micRec {
            let s = micRec.takeAll()
            if !s.isEmpty { tryWrite(s) }
        } else if let systemRec {
            let s = systemRec.takeAll()
            if !s.isEmpty { tryWrite(s) }
        }
    }

    private func flushFinal() {
        guard writer != nil else { return }

        if let micRec, let systemRec {
            let common = min(micRec.count(), systemRec.count())
            if common > 0 {
                writeMixed(mic: micRec.takePrefix(common), system: systemRec.takePrefix(common))
            }
            // After the symmetric part, dump whichever side has a tail left so
            // the WAV ends at the same wall time as the recording itself rather
            // than at the lagging stream.
            let micTail = micRec.takeAll()
            if !micTail.isEmpty { tryWrite(micTail) }
            let sysTail = systemRec.takeAll()
            if !sysTail.isEmpty { tryWrite(sysTail) }
        } else if let micRec {
            let s = micRec.takeAll()
            if !s.isEmpty { tryWrite(s) }
        } else if let systemRec {
            let s = systemRec.takeAll()
            if !s.isEmpty { tryWrite(s) }
        }
    }

    private func writeMixed(mic: [Float], system: [Float]) {
        let n = min(mic.count, system.count)
        guard n > 0 else { return }
        var mixed = [Float](repeating: 0, count: n)
        for i in 0..<n {
            // Sum + soft clip. Real meeting audio rarely peaks both sources
            // simultaneously, so a halving gain is unnecessary and would
            // attenuate single-source content.
            var v = mic[i] + system[i]
            if v >  1 { v =  1 }
            if v < -1 { v = -1 }
            mixed[i] = v
        }
        tryWrite(mixed)
    }

    private func tryWrite(_ samples: [Float]) {
        do {
            try writer?.append(samples)
        } catch {
            Helper.log("WAV append error: \(error.localizedDescription)")
            Helper.emit(["type": "error", "message": "wav write failed: \(error.localizedDescription)"])
        }
    }

    // ─── Model pre-flight ───────────────────────────────────────────────────

    private func loadModels() async throws -> URL {
        try await ModelLoader.ensureModel(
            name: config.model,
            inDir: config.modelDir,
            onProgress: { pct in
                Helper.emit(["type": "modelDownload", "progress": pct])
            }
        )
    }
}

enum LiveError: Error, LocalizedError {
    case config(String)
    case audio(String)
    case model(String)

    var errorDescription: String? {
        switch self {
        case .config(let m): return "config: \(m)"
        case .audio(let m):  return "audio: \(m)"
        case .model(let m):  return "model: \(m)"
        }
    }
}
