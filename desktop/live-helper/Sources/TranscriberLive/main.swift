import Foundation

// ─── JSON line protocol ─────────────────────────────────────────────────────
//
// stdin  (Electron → helper): one JSON object per line
//   live mode:
//     {"cmd":"start","model":"large-v3-turbo","modelDir":"/abs/path",
//      "language":"ru","sources":["mic","system"],
//      "outputPath":"/abs/.../recording.wav",   // optional: tee audio to WAV
//      "autoStopOnMeetingEnd":true}              // optional: watch for call end
//   record-only mode:
//     {"cmd":"record","outputPath":"/abs/.../recording.wav",
//      "sources":["mic","system"],"autoStopOnMeetingEnd":true}   // optional
//   transcribe a saved file:
//     {"cmd":"transcribeFile","path":"/abs/.../recording.wav",
//      "model":"large-v3-turbo","modelDir":"/abs/path","language":"ru"}
//   list calendar events around now (one-shot; no session started):
//     {"cmd":"listCalendarEvents","windowBackMinutes":120,"windowForwardMinutes":480,
//      "calendarIds":["…"]}   // optional: restrict to these calendars (omit = all)
//   list available calendars (one-shot):
//     {"cmd":"listCalendars"}
//   watch for a call starting (mic held open by another app); long-lived:
//     {"cmd":"monitorMic","debounceSec":8}
//     {"cmd":"stopMonitor"}
//   common:
//     {"cmd":"stop"}
//
// stdout (helper → Electron): one JSON object per line
//   {"type":"ready"}
//   {"type":"calendarEvents","events":[{"id","title","start","end","participants":[...],"urls":[...]}]}
//   {"type":"calendars","calendars":[{"id","title","account"}]}
//   {"type":"modelDownload","progress":0.42}
//   {"type":"recording"}                       — live OR record mode
//   {"type":"recordSaved","path":"...","durationSec":42.3}
//   {"type":"transcribeStarted","path":"..."}
//   {"type":"loaded","durationSec":...,"samples":...}
//   {"type":"transcribing"}
//   {"type":"segment","source":"mic|system","speaker":"Me|S?|S1|S2|…",
//    "start":12.4,"end":14.0,"text":"...","final":true}
//   {"type":"diarizing"}
//   {"type":"diarizationComplete","segments":[...]}
//   {"type":"micActive","app":"Zoom","bundleId":"us.zoom.xos","pid":123}
//   {"type":"micInactive"}
//   {"type":"meetingEnded"}                     — auto-stop: conferencing app released the mic
//   {"type":"meetingResumed"}                   — auto-stop: a process re-acquired the mic
//   {"type":"error","message":"..."}
//   {"type":"stopped"}
//
// stderr is reserved for debug logging only; Electron mirrors it to the
// diagnostics panel.

enum Helper {
    static let stdoutQueue = DispatchQueue(label: "helper.stdout")

    static func emit(_ event: [String: Any]) {
        stdoutQueue.async {
            guard let data = try? JSONSerialization.data(withJSONObject: event, options: []) else { return }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A])) // \n
        }
    }

    static func log(_ msg: String) {
        FileHandle.standardError.write(Data("[live-helper] \(msg)\n".utf8))
    }
}

// ─── Start (live) command payload ───────────────────────────────────────────

struct StartCommand: Decodable {
    let cmd: String
    let model: String
    let modelDir: String
    let language: String
    let sources: [String]
    let outputPath: String?
    let autoStopOnMeetingEnd: Bool?
}

struct RecordCommand: Decodable {
    let cmd: String
    let outputPath: String
    let sources: [String]
    let autoStopOnMeetingEnd: Bool?
}

// Stand-alone model download. Issued from the renderer's model picker
// so the user can pre-fetch a WhisperKit variant without starting a
// real session. Emits modelDownload progress events and a final
// modelDownloaded; on failure surfaces an error event.
struct DownloadModelCommand: Decodable {
    let cmd: String
    let model: String
    let modelDir: String
}

// One-shot calendar query. Optional window bounds (minutes) around "now";
// defaults applied in CalendarBridge when absent.
struct ListCalendarEventsCommand: Decodable {
    let cmd: String
    let windowBackMinutes: Int?
    let windowForwardMinutes: Int?
    let calendarIds: [String]?
}

// Long-lived microphone watcher. Optional debounce (seconds) before a
// detected call is reported; default applied when absent.
struct MonitorMicCommand: Decodable {
    let cmd: String
    let debounceSec: Double?
}

// ─── Command loop ───────────────────────────────────────────────────────────

final class CommandLoop {
    private var liveSession: LiveSession?
    private var recordSession: RecordingSession?
    private var fileTranscriber: FileTranscriber?
    private var micMonitor: MicActivityMonitor?
    private var meetingWatcher: MeetingEndWatcher?

    func run() {
        Helper.emit(["type": "ready"])

        while let line = readLine() {
            guard let data = line.data(using: .utf8),
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let cmd = raw["cmd"] as? String
            else {
                Helper.emit(["type": "error", "message": "invalid command: \(line)"])
                continue
            }

            switch cmd {
            case "start":
                guard let start = try? JSONDecoder().decode(StartCommand.self, from: data) else {
                    Helper.emit(["type": "error", "message": "invalid start payload"])
                    continue
                }
                handleStartLive(start)

            case "record":
                guard let rec = try? JSONDecoder().decode(RecordCommand.self, from: data) else {
                    Helper.emit(["type": "error", "message": "invalid record payload"])
                    continue
                }
                handleStartRecord(rec)

            case "transcribeFile":
                guard let cmd = try? JSONDecoder().decode(TranscribeFileCommand.self, from: data) else {
                    Helper.emit(["type": "error", "message": "invalid transcribeFile payload"])
                    continue
                }
                handleTranscribeFile(cmd)

            case "downloadModel":
                guard let dl = try? JSONDecoder().decode(DownloadModelCommand.self, from: data) else {
                    Helper.emit(["type": "error", "message": "invalid downloadModel payload"])
                    continue
                }
                handleDownloadModel(dl)

            case "listCalendarEvents":
                let cal = try? JSONDecoder().decode(ListCalendarEventsCommand.self, from: data)
                CalendarBridge.listEvents(
                    backMinutes: cal?.windowBackMinutes ?? CalendarBridge.defaultBackMinutes,
                    forwardMinutes: cal?.windowForwardMinutes ?? CalendarBridge.defaultForwardMinutes,
                    calendarIds: cal?.calendarIds
                )

            case "listCalendars":
                CalendarBridge.listCalendars()

            case "monitorMic":
                let mon = try? JSONDecoder().decode(MonitorMicCommand.self, from: data)
                handleMonitorMic(debounceSec: mon?.debounceSec ?? 8)

            case "stopMonitor":
                micMonitor?.stop()
                micMonitor = nil

            case "stop":
                handleStop()

            default:
                Helper.emit(["type": "error", "message": "unknown cmd: \(cmd)"])
            }
        }

        // stdin closed → treat as stop
        handleStop()
    }

    // ─── Live ──────────────────────────────────────────────────────────────

    private func handleStartLive(_ cmd: StartCommand) {
        if liveSession != nil || recordSession != nil || fileTranscriber != nil {
            Helper.emit(["type": "error", "message": "session already running"])
            return
        }
        let s = LiveSession(config: cmd)
        liveSession = s
        maybeStartMeetingWatcher(autoStop: cmd.autoStopOnMeetingEnd, sources: cmd.sources)
        Task {
            do {
                try await s.start()
            } catch {
                Helper.emit(["type": "error", "message": "start failed: \(error.localizedDescription)"])
                self.liveSession = nil
                self.meetingWatcher?.stop()
                self.meetingWatcher = nil
            }
        }
    }

    // ─── Record ────────────────────────────────────────────────────────────

    private func handleStartRecord(_ cmd: RecordCommand) {
        if liveSession != nil || recordSession != nil || fileTranscriber != nil {
            Helper.emit(["type": "error", "message": "session already running"])
            return
        }
        let url = URL(fileURLWithPath: cmd.outputPath)
        let useMic    = cmd.sources.contains("mic")
        let useSystem = cmd.sources.contains("system")
        let s = RecordingSession(outputURL: url, useMic: useMic, useSystem: useSystem)
        recordSession = s
        maybeStartMeetingWatcher(autoStop: cmd.autoStopOnMeetingEnd, sources: cmd.sources)
        Task {
            do {
                try await s.start()
            } catch {
                Helper.emit(["type": "error", "message": "record failed: \(error.localizedDescription)"])
                self.recordSession = nil
                self.meetingWatcher?.stop()
                self.meetingWatcher = nil
            }
        }
    }

    // ─── Auto-stop: watch for the online meeting ending ────────────────────────
    // Only arm when recording BOTH mic and system (an active online meeting).
    // mic-only (offline) and system-only (passive webinar) never auto-stop.
    private func maybeStartMeetingWatcher(autoStop: Bool?, sources: [String]) {
        guard autoStop == true,
              sources.contains("mic"), sources.contains("system") else { return }
        let w = MeetingEndWatcher()
        meetingWatcher = w
        w.start()
    }

    // ─── Transcribe a saved file ───────────────────────────────────────────

    private func handleTranscribeFile(_ cmd: TranscribeFileCommand) {
        if liveSession != nil || recordSession != nil || fileTranscriber != nil {
            Helper.emit(["type": "error", "message": "session already running"])
            return
        }
        let t = FileTranscriber(config: cmd)
        fileTranscriber = t
        Task {
            await t.run()
            self.fileTranscriber = nil
        }
    }

    // ─── Pre-fetch a WhisperKit model ───────────────────────────────────────
    // Idempotent: ModelLoader.ensureModel returns the existing folder if the
    // model is already on disk. Emits modelDownload {progress} on the way
    // and modelDownloaded on success.

    private func handleDownloadModel(_ cmd: DownloadModelCommand) {
        if liveSession != nil || recordSession != nil || fileTranscriber != nil {
            Helper.emit(["type": "error", "message": "session already running"])
            return
        }
        Task {
            do {
                _ = try await ModelLoader.ensureModel(
                    name: cmd.model,
                    inDir: cmd.modelDir,
                    onProgress: { pct in
                        Helper.emit(["type": "modelDownload", "progress": pct])
                    }
                )
                Helper.emit(["type": "modelDownloaded", "model": cmd.model])
            } catch {
                Helper.emit(["type": "error", "message": "download failed: \(error.localizedDescription)"])
            }
        }
    }

    // ─── Monitor microphone activity (call detection) ──────────────────────
    // Idempotent: restarts the watcher if already running with new settings.

    private func handleMonitorMic(debounceSec: Double) {
        micMonitor?.stop()
        let m = MicActivityMonitor(debounceSec: debounceSec)
        micMonitor = m
        m.start()
    }

    // ─── Stop (routes to whichever session is active) ──────────────────────

    private func handleStop() {
        micMonitor?.stop()
        micMonitor = nil
        meetingWatcher?.stop()
        meetingWatcher = nil

        if let s = liveSession {
            Task {
                await s.stop()
                Helper.emit(["type": "stopped"])
                self.liveSession = nil
            }
            return
        }
        if let s = recordSession {
            Task {
                await s.stop()
                Helper.emit(["type": "stopped"])
                self.recordSession = nil
            }
            return
        }
        if let t = fileTranscriber {
            Task {
                await t.cancel()
                // FileTranscriber emits its own "stopped" after returning.
                self.fileTranscriber = nil
            }
            return
        }
        // Nothing to stop — silent no-op.
    }
}

CommandLoop().run()
