import Foundation
import CoreAudio

// ─── Microphone-activity monitor ─────────────────────────────────────────────
//
// Detects when a *call* starts so the app can offer to record it — the same
// trick Granola/meetily use. The distinguishing signal is **microphone input
// being held open by some process**, NOT audio playback:
//
//   • Spotify / YouTube → only render to the output device → mic stays idle.
//   • Zoom / Teams / Meet / FaceTime / WhatsApp / Slack huddle → open the mic
//     for input AND play the far end → mic is running.
//
// We enumerate Core Audio's process list (macOS 14+) and use each process's
// `kAudioProcessPropertyIsRunningInput` state. This identifies the app holding
// the mic without depending on the selected default input device.
//
// This is a HAL property query only — we never open the microphone — so it
// needs no TCC microphone grant. Recording itself still uses the existing
// mic/system-audio permissions.
//
// Emitted protocol events:
//   {"type":"micActive","app":"Zoom","bundleId":"us.zoom.xos","pid":123}
//   {"type":"micInactive"}
//
// A debounce window suppresses brief blips (Siri, "test your mic" probes) and
// gives the conferencing app time to actually start input before we prompt.

final class MicActivityMonitor {
    private let debounce: TimeInterval
    private let queue = DispatchQueue(label: "helper.micmonitor")
    // ponytail: <=2s discovery latency; add per-process listeners if lower latency is needed.
    private let pollInterval: TimeInterval = 2.0

    private var state = MicActivityState()
    private var pendingActivation: DispatchWorkItem?
    private var stopped = false

    // Friendly names for common apps; anything else falls back
    // to the bundle id (Electron can prettify further if it wants).
    static let knownApps: [String: String] = [
        "us.zoom.xos": "Zoom",
        "com.microsoft.teams": "Microsoft Teams",
        "com.microsoft.teams2": "Microsoft Teams",
        "com.tinyspeck.slackmacgap": "Slack",
        "com.apple.FaceTime": "FaceTime",
        "net.whatsapp.WhatsApp": "WhatsApp",
        "com.hnc.Discord": "Discord",
        "com.cisco.webexmeetingsapp": "Webex",
        "com.google.Chrome": "Chrome",
        "com.apple.Safari": "Safari",
        "org.mozilla.firefox": "Firefox",
        "com.microsoft.edgemac": "Microsoft Edge",
        "com.brave.Browser": "Brave",
    ]

    private var processListAddr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    init(debounceSec: Double) {
        self.debounce = max(0, debounceSec)
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    func start() {
        guard #available(macOS 14.0, *) else {
            Helper.log("mic monitor: requires macOS 14+, not starting")
            return
        }
        queue.async { [weak self] in
            guard let self else { return }
            // A process-list update catches process creation/destruction; the
            // poll catches input state changes on an existing process.
            AudioObjectAddPropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject),
                &self.processListAddr,
                self.queue
            ) { [weak self] _, _ in
                self?.evaluate()
            }
            self.schedulePoll()
            self.evaluate()
            Helper.log("mic monitor started (debounce=\(self.debounce)s)")
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.stopped = true
            self.pendingActivation?.cancel()
            self.pendingActivation = nil
            AudioObjectRemovePropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject),
                &self.processListAddr,
                self.queue
            ) { _, _ in }
            Helper.log("mic monitor stopped")
        }
    }

    // ─── Poll loop ───────────────────────────────────────────────────────────

    private func schedulePoll() {
        queue.asyncAfter(deadline: .now() + pollInterval) { [weak self] in
            guard let self, !self.stopped else { return }
            self.evaluate()
            self.schedulePoll()
        }
    }

    // ─── State machine ─────────────────────────────────────────────────────────

    private func evaluate() {
        guard !stopped else { return }
        let app = Self.activeInputApp()
        switch state.observe(active: app != nil) {
        case .schedule:
            guard let app else { return }
            Helper.log("mic monitor: activation pending for \(app.name)")
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.pendingActivation = nil
                let app = Self.activeInputApp()
                let transition = self.state.recheck(active: app != nil)
                Helper.log("mic monitor: activation recheck for \(app?.name ?? "none") \(transition == .report ? "active" : "inactive")")
                guard transition == .report, let app else { return }
                Helper.emit(["type": "micActive", "app": app.name, "bundleId": app.bundleId, "pid": Int(app.pid)])
                Helper.log("mic monitor: activation emitted for \(app.name)")
            }
            pendingActivation = work
            queue.asyncAfter(deadline: .now() + debounce, execute: work)
        case .cancel:
            pendingActivation?.cancel()
            pendingActivation = nil
            Helper.log("mic monitor: pending activation cancelled")
        case .inactive:
            Helper.emit(["type": "micInactive"])
            Helper.log("mic monitor: activity cleared")
        case nil, .report:
            break
        }
    }

    // ─── Core Audio lookups ────────────────────────────────────────────────────

    // Enumerates the audio process list (macOS 14+) and returns the first
    // process — other than ourselves — that is currently running input.
    private static func activeInputApp() -> (pid: pid_t, bundleId: String, name: String)? {
        var listAddr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &listAddr, 0, nil, &dataSize) == noErr,
              dataSize > 0 else { return nil }

        let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
        var objects = [AudioObjectID](repeating: AudioObjectID(kAudioObjectUnknown), count: count)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &listAddr, 0, nil, &dataSize, &objects) == noErr else {
            return nil
        }

        let ownPID = getpid()
        for obj in objects {
            guard processBool(obj, kAudioProcessPropertyIsRunningInput) else { continue }
            let pid = processPID(obj)
            if pid == ownPID { continue }
            let bundleId = processBundleID(obj) ?? ""
            return (pid, bundleId, friendlyName(for: bundleId))
        }
        return nil
    }

    // Browsers and Electron apps hold the mic in a media/GPU subprocess whose
    // bundle id is the parent's plus a suffix (e.g. "com.google.Chrome.helper",
    // "com.tinyspeck.slackmacgap.helper"). Match the longest known prefix so
    // those still resolve to "Chrome" / "Slack"; otherwise fall back to the id.
    static func friendlyName(for bundleId: String) -> String {
        if bundleId.isEmpty { return "приложение" }
        if let exact = knownApps[bundleId] { return exact }
        for (id, name) in knownApps where bundleId.hasPrefix(id + ".") {
            return name
        }
        return bundleId
    }

    static func processBool(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Bool {
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value) == noErr else { return false }
        return value != 0
    }

    static func processPID(_ obj: AudioObjectID) -> pid_t {
        var pid: pid_t = -1
        var size = UInt32(MemoryLayout<pid_t>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyPID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &pid) == noErr else { return -1 }
        return pid
    }

    static func processBundleID(_ obj: AudioObjectID) -> String? {
        var ref: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyBundleID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &ref) == noErr,
              let ref else { return nil }
        let s = ref.takeRetainedValue() as String
        return s.isEmpty ? nil : s
    }
}
