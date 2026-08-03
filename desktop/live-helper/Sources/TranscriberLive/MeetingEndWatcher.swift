import Foundation
import CoreAudio

// ─── Meeting-end watcher ─────────────────────────────────────────────────────
//
// Auto-stops a *mic + system* recording when the online meeting ends. The
// distinguishing signal is the same one MicActivityMonitor uses to detect a
// call starting — a conferencing app holding the **microphone** open — but read
// in the opposite direction: when no such app holds the mic anymore, the
// meeting is over.
//
// Crucial difference from MicActivityMonitor: that monitor keys off the whole
// input device (kAudioDevicePropertyDeviceIsRunningSomewhere). That signal is
// useless here, because the recording helper itself opens the mic (sources
// include "mic"), so the device always reads "in use" and never flips. Instead
// we track the **per-process** input state (kAudioProcessPropertyIsRunningInput)
// and exclude our own PID — so our own capture doesn't mask the conferencing
// app releasing the mic.
//
// Lifecycle: armed only if a conferencing app is already holding the mic within
// the first few seconds of the session (i.e. this really is an online meeting).
// If none appears in that window, the watcher gives up silently — nothing to
// auto-stop. Once armed it reports:
//
//   {"type":"meetingEnded"}     — no other process holds the mic anymore
//   {"type":"meetingResumed"}   — a process re-acquired the mic (e.g. reconnect)
//
// The 15-second grace + user "keep recording" affordance lives in the Electron
// main process; this watcher fires meetingEnded immediately on release and
// meetingResumed immediately on re-acquire, so main can cancel its countdown.
//
// macOS 14+ only (process-list API). On older systems it never arms and the
// recording stops only manually — same graceful degrade as MicActivityMonitor.

final class MeetingEndWatcher {
    private let queue = DispatchQueue(label: "helper.meetingwatch")
    private let pollInterval: TimeInterval = 2.0
    // ~6 s (3 polls) after start to spot the conferencing app before giving up.
    private let armWindowPolls = 3

    private var stopped = false
    private var armed = false           // a conferencing app was seen at least once
    private var meetingActive = false   // last reported state (true = call live)
    private var pollsWithoutArm = 0

    private var processListAddr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    func start() {
        guard #available(macOS 14.0, *) else {
            Helper.log("meeting watcher: requires macOS 14+, not arming")
            return
        }
        queue.async { [weak self] in
            guard let self else { return }
            // Re-evaluate when the audio process list changes (apps acquiring /
            // releasing input, or quitting). A light poll covers the case where
            // kAudioProcessPropertyIsRunningInput flips without the *list*
            // changing — we don't attach a per-process listener for every app.
            AudioObjectAddPropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject),
                &self.processListAddr,
                self.queue
            ) { [weak self] _, _ in self?.evaluate() }

            self.schedulePoll()
            self.evaluate()
            Helper.log("meeting watcher started")
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.stopped = true
            AudioObjectRemovePropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject),
                &self.processListAddr,
                self.queue
            ) { _, _ in }
            Helper.log("meeting watcher stopped")
        }
    }

    // ─── Poll loop ─────────────────────────────────────────────────────────────

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
        let holder = Self.firstNonSelfInputHolder()
        let active = holder != nil

        if !armed {
            if active {
                armed = true
                meetingActive = true
                let name = holder.map { MicActivityMonitor.friendlyName(for: $0.bundleId) } ?? "?"
                Helper.log("meeting watcher armed (mic held by \(name))")
            } else {
                pollsWithoutArm += 1
                if pollsWithoutArm >= armWindowPolls {
                    // No conferencing app at session start → not an online
                    // meeting we can track. Give up quietly.
                    Helper.log("meeting watcher: no call detected, disarming")
                    stop()
                }
            }
            return
        }

        // Armed: report transitions only.
        if active && !meetingActive {
            meetingActive = true
            Helper.emit(["type": "meetingResumed"])
        } else if !active && meetingActive {
            meetingActive = false
            Helper.emit(["type": "meetingEnded"])
        }
    }

    // ─── Core Audio lookup ───────────────────────────────────────────────────────
    // Returns the first process — other than ourselves — currently running
    // input, or nil if none. Mirrors MicActivityMonitor.activeInputApp but is
    // duplicated here so we never restrict to "known" apps for the
    // active/ended decision (any non-self mic holder keeps the meeting alive).
    private static func firstNonSelfInputHolder() -> (pid: pid_t, bundleId: String)? {
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
            guard MicActivityMonitor.processBool(obj, kAudioProcessPropertyIsRunningInput) else { continue }
            let pid = MicActivityMonitor.processPID(obj)
            if pid == ownPID { continue }
            let bundleId = MicActivityMonitor.processBundleID(obj) ?? ""
            return (pid, bundleId)
        }
        return nil
    }
}
