import Foundation

// Record-only session: capture mic + system audio, mix into a single
// 16 kHz mono WAV. No WhisperKit, no SpeakerKit. Stop closes the file
// and emits its path so the renderer can offer "Transcribe now".
//
// Mixing strategy:
//   Each AudioCapture pushes 16 kHz mono Float32 chunks at roughly real
//   time. We buffer per-source samples and a writer task wakes up every
//   100 ms to drain min(mic, system) frames from both queues, sum them
//   (with peak limiting), and append to the WAV file. The "min" gate keeps
//   the two streams in lock-step; small per-callback rate jitter shows up
//   as bounded latency rather than file-level drift.

actor RecordingSession {
    private let outputURL: URL
    private let useMic: Bool
    private let useSystem: Bool

    private var captures: [AudioCapture] = []
    private var writer: WAVWriter?

    private var micBuffer: [Float] = []
    private var systemBuffer: [Float] = []
    private var drainTask: Task<Void, Never>?
    private var stopped = false

    private let sampleRate: Double = 16_000
    private let drainIntervalNs: UInt64 = 100_000_000  // 100 ms

    init(outputURL: URL, useMic: Bool, useSystem: Bool) {
        self.outputURL = outputURL
        self.useMic = useMic
        self.useSystem = useSystem
    }

    func start() async throws {
        if !useMic && !useSystem {
            throw LiveError.config("no audio sources selected")
        }

        try FileManager.default.createDirectory(
            at: outputURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        writer = try WAVWriter(url: outputURL, sampleRate: sampleRate)

        if useMic {
            // VP off for plain recording: enabling Apple's voice-processing
            // unit flips Bluetooth headsets (e.g. AirPods) from A2DP to
            // HFP/SCO so the system audio the user is listening to drops
            // to narrowband — perceived as "headphones go silent the moment
            // I hit record". Record captures the raw mic; AEC/AGC/NS only
            // matter for Live's ASR path.
            let cap = try MicCapture(
                onSamples: { [weak self] samples in
                    await self?.appendMic(samples)
                },
                echoCancellation: false
            )
            captures.append(cap)
            try await cap.start()
        }
        if useSystem {
            let cap = try SystemAudioCapture { [weak self] samples in
                await self?.appendSystem(samples)
            }
            captures.append(cap)
            try await cap.start()
        }

        startDrainTask()

        Helper.log("recording session started → \(outputURL.path)")
        Helper.emit(["type": "recording"])
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true

        for cap in captures { cap.stop() }
        captures.removeAll()

        drainTask?.cancel()
        _ = await drainTask?.value
        drainTask = nil

        // Flush whatever is left. If one source has more queued than the other,
        // pad the shorter side with zeros so the file ends at the same wall
        // time as the recording itself rather than at the lagging stream.
        await flushFinal()
        writer?.close()
        let frames = writer?.framesWritten ?? 0
        let durationSec = Double(frames) / sampleRate
        writer = nil

        Helper.emit([
            "type": "recordSaved",
            "path": outputURL.path,
            "durationSec": durationSec,
        ])
    }

    // ─── Source callbacks ───────────────────────────────────────────────────

    private func appendMic(_ samples: [Float]) {
        guard !stopped else { return }
        micBuffer.append(contentsOf: samples)
    }

    private func appendSystem(_ samples: [Float]) {
        guard !stopped else { return }
        systemBuffer.append(contentsOf: samples)
    }

    // ─── Writer loop ────────────────────────────────────────────────────────

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

        if useMic && useSystem {
            let take = min(micBuffer.count, systemBuffer.count)
            guard take > 0 else { return }
            writeMixed(micCount: take, systemCount: take)
        } else if useMic {
            guard !micBuffer.isEmpty else { return }
            tryWrite(micBuffer)
            micBuffer.removeAll(keepingCapacity: true)
        } else if useSystem {
            guard !systemBuffer.isEmpty else { return }
            tryWrite(systemBuffer)
            systemBuffer.removeAll(keepingCapacity: true)
        }
    }

    private func flushFinal() async {
        if useMic && useSystem {
            // Drain whatever is symmetric first.
            let common = min(micBuffer.count, systemBuffer.count)
            if common > 0 {
                writeMixed(micCount: common, systemCount: common)
            }
            // Then dump any leftover tail from the longer stream, zero-mixed.
            if !micBuffer.isEmpty {
                tryWrite(micBuffer)
                micBuffer.removeAll(keepingCapacity: false)
            }
            if !systemBuffer.isEmpty {
                tryWrite(systemBuffer)
                systemBuffer.removeAll(keepingCapacity: false)
            }
        } else if useMic && !micBuffer.isEmpty {
            tryWrite(micBuffer)
            micBuffer.removeAll(keepingCapacity: false)
        } else if useSystem && !systemBuffer.isEmpty {
            tryWrite(systemBuffer)
            systemBuffer.removeAll(keepingCapacity: false)
        }
    }

    private func writeMixed(micCount: Int, systemCount: Int) {
        let n = min(micCount, systemCount)
        guard n > 0 else { return }
        var mixed = [Float](repeating: 0, count: n)
        for i in 0..<n {
            // Sum + soft clip to [-1, 1]. Real meeting audio rarely peaks
            // both sources simultaneously, so a halving gain is unnecessary
            // and would noticeably attenuate single-source content.
            var v = micBuffer[i] + systemBuffer[i]
            if v >  1 { v =  1 }
            if v < -1 { v = -1 }
            mixed[i] = v
        }
        micBuffer.removeFirst(n)
        systemBuffer.removeFirst(n)
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
}
