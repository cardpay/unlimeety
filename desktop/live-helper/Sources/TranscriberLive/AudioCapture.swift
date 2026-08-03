import Foundation
import AVFoundation
import CoreAudio

// Helper: query the macOS default input device's UID + name so the
// diagnostics panel can show us *which* mic AVAudioEngine is actually
// recording from. A misrouted default (e.g. an Aggregate device with no
// real input) is a classic cause of "everything looks fine but RMS is 0".
private func defaultInputDeviceDescription() -> String {
    var deviceID: AudioDeviceID = 0
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &addr, 0, nil, &size, &deviceID
    )
    guard status == noErr, deviceID != 0 else {
        return "unknown (status=\(status))"
    }

    func stringProperty(_ selector: AudioObjectPropertySelector) -> String? {
        var ref: Unmanaged<CFString>?
        var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var nameAddr = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let s = AudioObjectGetPropertyData(deviceID, &nameAddr, 0, nil, &nameSize, &ref)
        guard s == noErr, let r = ref else { return nil }
        return r.takeRetainedValue() as String
    }

    let name = stringProperty(kAudioObjectPropertyName) ?? "?"
    let uid  = stringProperty(kAudioDevicePropertyDeviceUID) ?? "?"
    return "\(name) (uid=\(uid), id=\(deviceID))"
}

// Resolves the display name of the parent .app bundle that contains this
// helper, so user-facing TCC error messages can reference the correct app
// in System Settings (e.g. "Transcriber" in production, "Electron" in dev).
//
// The helper is shipped at `${parentApp}.app/Contents/Resources/transcriber-live`,
// so we walk three levels up from the executable URL to land on the .app
// bundle, then read its CFBundleName from Info.plist. Anything goes wrong
// (helper invoked outside an app bundle, missing keys, etc.) → fall back to
// the generic literal "this app", which still produces a readable sentence.
private func parentAppDisplayName() -> String {
    let fallback = "this app"
    guard let exec = Bundle.main.executableURL else { return fallback }
    // exec = .../Contents/Resources/transcriber-live → 3 deletions → .../X.app
    let appURL = exec
        .deletingLastPathComponent() // Resources
        .deletingLastPathComponent() // Contents
        .deletingLastPathComponent() // X.app
    guard appURL.pathExtension == "app",
          let bundle = Bundle(url: appURL) else { return fallback }
    if let name = bundle.object(forInfoDictionaryKey: "CFBundleName") as? String,
       !name.isEmpty {
        return name
    }
    if let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String,
       !name.isEmpty {
        return name
    }
    return fallback
}

// Abstract base so LiveSession can treat mic and system identically.
// `start()` is async so both capture paths share one shape; the setup
// itself is synchronous internally but the protocol leaves room to await.
protocol AudioCapture: AnyObject {
    func start() async throws
    func stop()
}

// ─── Decoupling helper: AsyncStream-based sample pipe ───────────────────────
//
// Audio callbacks land on real-time threads (AVAudioEngine HAL thread or the
// SCStream output dispatch queue). Doing `Task { await onSamples(...) }`
// directly inside those callbacks is a footgun: the cooperative pool can be
// busy waking up an actor that's blocked on its first lazy WhisperKit init,
// and the next ~6 audio buffers get dropped or the framework decides there's
// no consumer and stops scheduling callbacks at all (well-known signature on
// macOS — exactly one buffer arrives, then silence).
//
// Pattern: producer (RT callback) calls `pipe.push(samples)`, which yields
// on a non-blocking AsyncStream continuation. A long-lived consumer Task,
// owned by the capture object, drains the stream and awaits the actor. The
// continuation buffers up to N items; if the consumer falls behind we drop
// the oldest sample frames rather than back-pressuring the audio thread.
private final class SamplePipe: @unchecked Sendable {
    private var continuation: AsyncStream<[Float]>.Continuation?
    private var consumer: Task<Void, Never>?
    private let source: String
    // Counters for each step. We only log the first ~10 of each kind so the
    // diagnostics panel stays readable while still telling us exactly where
    // the audio chain breaks.
    private var pushCount: Int = 0
    private var recvCount: Int = 0
    private var returnCount: Int = 0
    private let traceLimit: Int = 12

    init(source: String) { self.source = source }

    func start(onSamples: @escaping ([Float]) async -> Void) {
        let (stream, cont) = AsyncStream<[Float]>.makeStream(
            bufferingPolicy: .bufferingNewest(32)
        )
        self.continuation = cont
        let src = source
        let limit = traceLimit
        self.consumer = Task.detached(priority: .userInitiated) { [weak self] in
            for await samples in stream {
                if let self {
                    self.recvCount += 1
                    if self.recvCount <= limit {
                        Helper.log("[\(src)] pipe.recv #\(self.recvCount) frames=\(samples.count)")
                    }
                }
                await onSamples(samples)
                if let self {
                    self.returnCount += 1
                    if self.returnCount <= limit {
                        Helper.log("[\(src)] pipe.return #\(self.returnCount)")
                    }
                }
            }
            Helper.log("[\(src)] pipe.consumer exited (stream finished)")
        }
    }

    func push(_ samples: [Float]) {
        pushCount += 1
        if pushCount <= traceLimit {
            Helper.log("[\(source)] pipe.push #\(pushCount) frames=\(samples.count)")
        }
        continuation?.yield(samples)
    }

    func stop() {
        continuation?.finish()
        continuation = nil
        consumer?.cancel()
        consumer = nil
    }
}

// ─── Lossless recording tee ─────────────────────────────────────────────────
//
// Unlike SamplePipe (which deliberately drops the oldest frames to protect the
// ASR consumer from back-pressure), this sink NEVER discards audio — a saved
// recording must be a faithful capture of what was played. It is fed
// synchronously from the audio callback (before the lossy pipe) and drained on
// the owning session's actor; the lock guards the two against each other.
//
// This is what makes the WAV independent of ASR latency: even when the system
// consumer stalls for seconds on batch re-diarization, the recording keeps
// every sample. (The lossy-pipe path was the "chipmunk" bug — the WAV inherited
// the pipe's dropped frames and the system track came out short + sped up.)
final class RecordSink: @unchecked Sendable {
    private let lock = NSLock()
    private var samples: [Float] = []
    private var accepting = true

    func append(_ s: [Float]) {
        lock.lock()
        if accepting { samples.append(contentsOf: s) }
        lock.unlock()
    }

    // Stop accepting and drop the backlog. Called when the WAV writer failed to
    // open, so an un-drained sink can't grow unbounded for the whole session.
    func disable() {
        lock.lock(); accepting = false; samples.removeAll(keepingCapacity: false); lock.unlock()
    }

    func count() -> Int {
        lock.lock(); defer { lock.unlock() }
        return samples.count
    }

    func takePrefix(_ n: Int) -> [Float] {
        lock.lock(); defer { lock.unlock() }
        let k = min(n, samples.count)
        guard k > 0 else { return [] }
        let head = Array(samples[0..<k])
        samples.removeFirst(k)
        return head
    }

    func takeAll() -> [Float] {
        lock.lock(); defer { lock.unlock() }
        let all = samples
        samples.removeAll(keepingCapacity: false)
        return all
    }
}

// Small shared helper that emits a real RMS value over stdout no more than
// ~10 times per second per source. The renderer uses this to drive the
// in-topbar level meter, so the user can see at a glance whether audio is
// actually flowing — independent of the (much slower) WhisperKit decoding.
private final class LevelEmitter: @unchecked Sendable {
    private let source: String
    private var lastEmit: TimeInterval = 0
    private var lastDebugLog: TimeInterval = 0
    private var loggedFirstSample = false
    // Rolling stats so the per-second debug log is meaningful even on silent
    // sources (zero buffers are still proof that the callback is firing).
    private var bufCount: Int = 0
    private var maxRms: Float = 0
    private var maxPeak: Float = 0
    private let throttleInterval: TimeInterval = 0.1
    private let debugInterval: TimeInterval = 1.0

    init(source: String) { self.source = source }

    func process(samples: [Float]) {
        if !loggedFirstSample {
            loggedFirstSample = true
            Helper.log("[\(source)] first sample buffer received: \(samples.count) frames")
        }

        guard !samples.isEmpty else { return }

        // Compute RMS + peak once per buffer; cheap.
        var sumSquares: Float = 0
        var peak: Float = 0
        for s in samples {
            sumSquares += s * s
            let a = s < 0 ? -s : s
            if a > peak { peak = a }
        }
        let rms = (sumSquares / Float(samples.count)).squareRoot()

        bufCount += 1
        if rms > maxRms  { maxRms = rms }
        if peak > maxPeak { maxPeak = peak }

        let now = Date().timeIntervalSince1970

        // Throttled audioLevel emission (~10 Hz) for the topbar meter.
        if now - lastEmit >= throttleInterval {
            lastEmit = now
            let level = min(1.0, Double(rms) / 0.3)
            Helper.emit(["type": "audioLevel", "source": source, "level": level])
        }

        // Once a second, log peak/RMS so the renderer's diagnostics panel
        // shows whether the device is actually delivering signal vs silence.
        // This is the difference between "macOS muted us" and "user isn't
        // talking yet" — both look identical without these numbers.
        if now - lastDebugLog >= debugInterval {
            let r = String(format: "%.4f", maxRms)
            let p = String(format: "%.4f", maxPeak)
            Helper.log("[\(source)] window-max rms=\(r) peak=\(p) over \(bufCount) buffers")
            lastDebugLog = now
            bufCount = 0
            maxRms = 0
            maxPeak = 0
        }
    }
}

// ─── Microphone capture via AVAudioEngine ────────────────────────────────────
// 16 kHz mono Float32, which is what WhisperKit expects.

final class MicCapture: AudioCapture, @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let onSamples: ([Float]) async -> Void
    // Optional lossless tee for the WAV recording. Called synchronously on the
    // audio thread before the lossy ASR pipe, so the recording never inherits
    // dropped frames. nil when this capture isn't being recorded.
    private let onRecord: (@Sendable ([Float]) -> Void)?
    private let echoCancellation: Bool
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private let levels = LevelEmitter(source: "mic")
    private let pipe = SamplePipe(source: "mic")
    private var configChangeObserver: NSObjectProtocol?
    // Raw tap counter: this fires before any conversion / pipe / actor hop, so
    // if it stops incrementing the AVAudioEngine itself stopped delivering.
    private var tapCount: Int = 0
    private var convertOkCount: Int = 0
    private let tapTraceLimit: Int = 12

    init(onSamples: @escaping ([Float]) async -> Void,
         onRecord: (@Sendable ([Float]) -> Void)? = nil,
         echoCancellation: Bool = true) throws {
        self.onSamples = onSamples
        self.onRecord = onRecord
        self.echoCancellation = echoCancellation
    }

    func start() async throws {
        // Surface a TCC denial as a real error instead of letting AVAudioEngine
        // run on silence. Electron has already triggered the prompt, so by the
        // time we get here the status should be `.authorized`; if not, abort.
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .denied, .restricted:
            throw LiveError.audio("microphone permission denied — enable \(parentAppDisplayName()) in System Settings → Privacy & Security → Microphone")
        case .notDetermined:
            // Should have been resolved by the parent. Fall through and let
            // the engine surface whatever happens; usually macOS will deliver
            // silence rather than throw, but we log the fact.
            Helper.log("mic auth still .notDetermined at start — parent did not request access?")
        default:
            break
        }

        let input = engine.inputNode

        // Enable Apple's voice-processing audio unit BEFORE we install the
        // tap. Voice processing changes the input node's output format
        // (typically to 48 kHz mono); `installTap` re-queries the format
        // each time, so as long as VP is toggled first it picks up the
        // post-VP format. VP gives us echo cancellation + AGC + noise
        // suppression, the same stack FaceTime/Zoom use to keep speaker
        // output out of the mic. It auto-bypasses when nothing else is
        // rendering through the engine, so it's a no-op when there's
        // nothing to cancel.
        var vpEnabled = false
        if echoCancellation {
            do {
                try input.setVoiceProcessingEnabled(true)
                vpEnabled = true
            } catch {
                Helper.log("mic setVoiceProcessingEnabled failed: \(error.localizedDescription) — continuing without AEC")
            }
        }
        Helper.log("mic voice processing enabled: \(vpEnabled)")

        guard let target = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        ) else {
            throw LiveError.audio("cannot build target format")
        }
        self.targetFormat = target

        // Spin up the consumer Task BEFORE the tap so the first buffer is
        // never dropped by an empty stream.
        pipe.start(onSamples: onSamples)
        installTap(on: input, target: target)

        // macOS posts this when the input device's format changes (e.g. user
        // plugs in AirPods, BT SCO kicks in, output device changes). The old
        // tap is bound to the previous format; if we leave it, samples stop
        // arriving entirely. We tear it down and re-attach with the freshly
        // queried input format, then bounce the engine.
        configChangeObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            guard let self, let target = self.targetFormat else { return }
            Helper.log("mic engine configuration changed; reinstalling tap")
            self.engine.inputNode.removeTap(onBus: 0)
            self.installTap(on: self.engine.inputNode, target: target)
            do {
                try self.engine.start()
            } catch {
                Helper.log("mic engine restart failed: \(error.localizedDescription)")
            }
        }

        // `prepare()` is documented as optional but on macOS some HAL paths
        // are noticeably more reliable when the engine pre-allocates buffers
        // before `start()`.
        engine.prepare()
        try engine.start()
        Helper.log("mic default input device: \(defaultInputDeviceDescription())")
    }

    private func installTap(on input: AVAudioInputNode, target: AVAudioFormat) {
        let inputFormat = input.inputFormat(forBus: 0)
        Helper.log("mic tap install: \(inputFormat.sampleRate) Hz, \(inputFormat.channelCount) ch")
        converter = AVAudioConverter(from: inputFormat, to: target)
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            self.tapCount += 1
            if self.tapCount <= self.tapTraceLimit {
                Helper.log("[mic] tap #\(self.tapCount) frames=\(buffer.frameLength) sr=\(buffer.format.sampleRate) ch=\(buffer.format.channelCount)")
            }
            self.convertAndEmit(buffer: buffer, targetFormat: target)
        }
    }

    func stop() {
        if let obs = configChangeObserver {
            NotificationCenter.default.removeObserver(obs)
            configChangeObserver = nil
        }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        pipe.stop()
    }

    private func convertAndEmit(buffer: AVAudioPCMBuffer, targetFormat: AVAudioFormat) {
        guard let converter = converter else { return }
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let targetFrames = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: targetFrames) else { return }

        var error: NSError?
        var provided = false
        // CRITICAL: do NOT return `.endOfStream` here. That permanently marks
        // the AVAudioConverter as finished, and every subsequent `convert()`
        // returns zero frames — exactly the "first buffer works, then silence"
        // symptom we were hunting. Use `.noDataNow + nil` so the converter
        // simply stops pulling more input for THIS call but stays usable for
        // the next one.
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if provided {
                inputStatus.pointee = .noDataNow
                return nil
            }
            provided = true
            inputStatus.pointee = .haveData
            return buffer
        }

        if status == .error || error != nil {
            Helper.log("mic convert error: \(error?.localizedDescription ?? "?")")
            return
        }

        guard let ptr = out.floatChannelData?[0] else { return }
        let samples = Array(UnsafeBufferPointer(start: ptr, count: Int(out.frameLength)))
        guard !samples.isEmpty else {
            // Defensive: if a converter still produces 0 frames (shouldn't
            // happen with .noDataNow), drop the empty buffer rather than
            // poisoning the rest of the pipeline.
            return
        }

        convertOkCount += 1
        if convertOkCount <= tapTraceLimit {
            Helper.log("[mic] convert ok #\(convertOkCount) outFrames=\(samples.count)")
        }

        levels.process(samples: samples)
        // Lossless tee FIRST: the recording must capture every frame regardless
        // of whether the lossy ASR pipe below drops any.
        onRecord?(samples)
        // Hand off via the AsyncStream pipe instead of spawning ad-hoc Tasks
        // from the RT audio thread — see SamplePipe doc comment.
        pipe.push(samples)
    }
}

// ─── System-audio capture via Core Audio process tap ─────────────────────────
// Requires macOS 14.2+. Captures the system output mixdown through a *private*
// aggregate device built around a `CATapDescription`. This lands the app in the
// lightweight "System Audio Recording Only" privacy category (gated by the
// `NSAudioCaptureUsageDescription` Info.plist key) — NOT "Screen & System Audio
// Recording" — so there is no screen-recording prompt, no admin password, and
// no periodic Tahoe re-consent. Same audio-only result the SCStream path gave,
// without dragging in screen capture.

final class SystemAudioCapture: AudioCapture, @unchecked Sendable {
    private let onSamples: ([Float]) async -> Void
    // Optional lossless tee for the WAV recording — see MicCapture.onRecord.
    private let onRecord: (@Sendable ([Float]) -> Void)?
    private let levels = LevelEmitter(source: "system")
    private let pipe = SamplePipe(source: "system")

    // Core Audio handles. All three are torn down in `cleanup()`.
    private var tapID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?

    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private var sourceFormat: AVAudioFormat?

    // Raw IO-proc counter — fires before any conversion / pipe handoff, so it
    // tells us whether Core Audio itself stopped delivering buffers.
    private var audioOutCount: Int = 0
    private var convertOkCount: Int = 0
    private let traceLimit: Int = 12

    // Single serial queue the IO proc runs on. All mutable state above is
    // touched only on `start()`/`stop()` (main flow) and this queue; the
    // device is started after setup and stopped before teardown, so there is
    // no concurrent access.
    private let ioQueue = DispatchQueue(label: "live.catap.audio", qos: .userInitiated)

    init(onSamples: @escaping ([Float]) async -> Void,
         onRecord: (@Sendable ([Float]) -> Void)? = nil) throws {
        self.onSamples = onSamples
        self.onRecord = onRecord
    }

    func start() async throws {
        guard let target = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        ) else {
            throw LiveError.audio("cannot build target format")
        }
        self.targetFormat = target

        // 1. Describe a global stereo tap that excludes our own process — the
        //    `excludesCurrentProcessAudio` equivalent, so the helper can never
        //    feed its own output back into the transcript.
        var excluded: [AudioObjectID] = []
        if let me = Self.processObject(forPID: getpid()) { excluded = [me] }
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
        desc.name = "TranscriberSystemTap"
        desc.isPrivate = true
        // Keep system playback audible while we tap it — without this the user
        // would stop hearing the meeting.
        desc.muteBehavior = .unmuted

        var status = AudioHardwareCreateProcessTap(desc, &tapID)
        guard status == noErr, tapID != AudioObjectID(kAudioObjectUnknown) else {
            throw LiveError.audio("System Audio Recording permission required — enable \(parentAppDisplayName()) in System Settings → Privacy & Security → System Audio Recording, then relaunch (status=\(status))")
        }

        // 2. Read the tap's stream format (typically 48 kHz stereo Float32) and
        //    build a guaranteed-PCM source format + converter to 16 kHz mono.
        var asbd = AudioStreamBasicDescription()
        var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var fmtAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        status = AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &fmtSize, &asbd)
        guard status == noErr else {
            cleanup()
            throw LiveError.audio("cannot read tap format (status=\(status))")
        }
        let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        guard let srcFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: asbd.mSampleRate,
            channels: asbd.mChannelsPerFrame,
            interleaved: !isNonInterleaved
        ) else {
            cleanup()
            throw LiveError.audio("unsupported tap format")
        }
        self.sourceFormat = srcFormat
        self.converter = AVAudioConverter(from: srcFormat, to: target)
        Helper.log("system tap format: \(asbd.mSampleRate) Hz, \(asbd.mChannelsPerFrame) ch, nonInterleaved=\(isNonInterleaved)")

        // 3. Build a *private* aggregate device wrapping the tap as a sub-tap,
        //    anchored to the current default output device. Private means it
        //    never shows up in other apps' device lists.
        let aggUID = "transcriber-system-tap-\(UUID().uuidString)"
        var aggDict: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "Transcriber System Tap",
            kAudioAggregateDeviceUIDKey as String: aggUID,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceIsStackedKey as String: false,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceTapListKey as String: [
                [kAudioSubTapUIDKey as String: desc.uuid.uuidString]
            ],
        ]
        if let outputUID = Self.defaultOutputDeviceUID() {
            aggDict[kAudioAggregateDeviceMainSubDeviceKey as String] = outputUID
            aggDict[kAudioAggregateDeviceSubDeviceListKey as String] = [
                [kAudioSubDeviceUIDKey as String: outputUID]
            ]
        }

        status = AudioHardwareCreateAggregateDevice(aggDict as CFDictionary, &aggregateID)
        guard status == noErr, aggregateID != AudioObjectID(kAudioObjectUnknown) else {
            cleanup()
            throw LiveError.audio("cannot create aggregate device (status=\(status))")
        }

        // 3a. CRITICAL: rebuild the source format + converter from the rate the
        //     IO proc ACTUALLY delivers. The aggregate runs its IO at the default
        //     output device's rate (e.g. a 24 kHz Bluetooth headset in call mode)
        //     and resamples the tap into it, so frames arrive at THAT rate — not
        //     necessarily the rate kAudioTapPropertyFormat advertised (observed:
        //     tap says 48 kHz, IO proc delivers 24 kHz). Converting with the tap's
        //     rate decimates by the wrong ratio → system track plays sped up
        //     ("chipmunk"). The tap's sub-stream virtual format lies too (it also
        //     reports 48 kHz), so we trust the aggregate's nominal IO rate,
        //     falling back to the output device's nominal rate.
        let realRate = Self.deviceNominalSampleRate(aggregateID)
            ?? Self.defaultOutputDeviceID().flatMap { Self.deviceNominalSampleRate($0) }
        if let realRate, realRate > 0, realRate != asbd.mSampleRate,
           let realSrc = AVAudioFormat(
               commonFormat: .pcmFormatFloat32,
               sampleRate: realRate,
               channels: asbd.mChannelsPerFrame,
               interleaved: !isNonInterleaved
           ) {
            Helper.log("system: IO runs at \(realRate) Hz, not tap's \(asbd.mSampleRate) Hz — rebuilding converter from real device rate")
            self.sourceFormat = realSrc
            self.converter = AVAudioConverter(from: realSrc, to: target)
        }

        // 4. Spin up the consumer before the device so the first buffer is
        //    never dropped, then install + start the IO proc.
        pipe.start(onSamples: onSamples)
        status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, ioQueue) {
            [weak self] _, inInputData, _, _, _ in
            self?.handle(inputData: inInputData)
        }
        guard status == noErr, ioProcID != nil else {
            cleanup()
            pipe.stop()
            throw LiveError.audio("cannot create IO proc (status=\(status))")
        }

        status = AudioDeviceStart(aggregateID, ioProcID)
        guard status == noErr else {
            cleanup()
            pipe.stop()
            throw LiveError.audio("cannot start aggregate device (status=\(status))")
        }
        Helper.log("system audio capture started (core audio tap)")
    }

    func stop() {
        cleanup()
        pipe.stop()
    }

    deinit { cleanup() }

    // Tears down Core Audio objects in reverse order. Idempotent: safe to call
    // from a failed `start()`, from `stop()`, and from `deinit` — guards on the
    // sentinel handles so we never double-destroy or leak a private aggregate
    // device if the helper crashes mid-session.
    private func cleanup() {
        if let proc = ioProcID, aggregateID != AudioObjectID(kAudioObjectUnknown) {
            AudioDeviceStop(aggregateID, proc)
            AudioDeviceDestroyIOProcID(aggregateID, proc)
        }
        ioProcID = nil
        if aggregateID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    // IO proc body: the tap hands us interleaved-or-not Float32 at the device
    // rate; convert to 16 kHz mono and hand off via the pipe. Mirrors the
    // `.noDataNow` converter discipline documented in MicCapture.convertAndEmit.
    private func handle(inputData: UnsafePointer<AudioBufferList>) {
        guard let sourceFormat, let target = targetFormat, let converter else { return }
        let srcList = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
        guard let first = srcList.first, first.mDataByteSize > 0 else { return }

        // Derive frame count from the first buffer. For non-interleaved the
        // format's bytes-per-frame is one Float32 (per channel buffer); for
        // interleaved it already accounts for the channel count.
        let bytesPerFrame = sourceFormat.streamDescription.pointee.mBytesPerFrame
        let frameCount = AVAudioFrameCount(first.mDataByteSize / max(bytesPerFrame, 1))
        guard frameCount > 0 else { return }

        audioOutCount += 1
        if audioOutCount <= traceLimit {
            Helper.log("[system] audio out #\(audioOutCount) frames=\(frameCount)")
        }

        guard let pcm = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: frameCount) else { return }
        pcm.frameLength = frameCount

        // Copy each channel buffer separately — for non-interleaved stereo the
        // tap hands us 2 buffers; a flat memcpy of just the first would drop a
        // channel and corrupt sizes.
        let dstList = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        let count = min(srcList.count, dstList.count)
        for i in 0..<count {
            let s = srcList[i]
            let d = dstList[i]
            let bytes = min(Int(s.mDataByteSize), Int(d.mDataByteSize))
            if let sptr = s.mData, let dptr = d.mData, bytes > 0 {
                memcpy(dptr, sptr, bytes)
            }
        }

        let ratio = target.sampleRate / sourceFormat.sampleRate
        let targetFrames = AVAudioFrameCount(Double(frameCount) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: targetFrames) else { return }

        var error: NSError?
        var provided = false
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if provided {
                inputStatus.pointee = .noDataNow
                return nil
            }
            provided = true
            inputStatus.pointee = .haveData
            return pcm
        }

        if status == .error || error != nil {
            Helper.log("system convert error: \(error?.localizedDescription ?? "?")")
            return
        }

        guard let chanPtr = out.floatChannelData?[0] else { return }
        let samples = Array(UnsafeBufferPointer(start: chanPtr, count: Int(out.frameLength)))
        guard !samples.isEmpty else { return }

        convertOkCount += 1
        if convertOkCount <= traceLimit {
            Helper.log("[system] convert ok #\(convertOkCount) outFrames=\(samples.count)")
        }

        levels.process(samples: samples)
        // Lossless tee FIRST — see MicCapture.convertAndEmit.
        onRecord?(samples)
        pipe.push(samples)
    }

    // ─── Core Audio lookups ──────────────────────────────────────────────────

    // Nominal (IO) sample rate of a device. For our aggregate this is the rate
    // the IO proc actually runs at, which is the ground truth for the converter.
    private static func deviceNominalSampleRate(_ device: AudioObjectID) -> Double? {
        var rate: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &rate) == noErr, rate > 0 else { return nil }
        return Double(rate)
    }

    // AudioObjectID of the current default output device (the aggregate is
    // anchored to it, so its nominal rate is what the aggregate runs at).
    private static func defaultOutputDeviceID() -> AudioObjectID? {
        var deviceID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID) == noErr,
              deviceID != AudioObjectID(kAudioObjectUnknown) else { return nil }
        return deviceID
    }

    // Translates a BSD process id into the AudioObjectID Core Audio uses to
    // identify that process, so we can exclude ourselves from the global tap.
    private static func processObject(forPID pid: pid_t) -> AudioObjectID? {
        var pidVar = pid
        var objID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &addr,
            UInt32(MemoryLayout<pid_t>.size), &pidVar,
            &size, &objID
        )
        guard status == noErr, objID != AudioObjectID(kAudioObjectUnknown) else { return nil }
        return objID
    }

    // UID of the current default output device, so the aggregate stays anchored
    // to whatever the user is actually listening through.
    private static func defaultOutputDeviceUID() -> String? {
        guard let deviceID = defaultOutputDeviceID() else { return nil }

        var uidRef: Unmanaged<CFString>?
        var uidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var uidAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(deviceID, &uidAddr, 0, nil, &uidSize, &uidRef) == noErr,
              let uidRef else { return nil }
        return uidRef.takeRetainedValue() as String
    }
}
