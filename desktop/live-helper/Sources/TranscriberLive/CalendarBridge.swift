import Foundation
import EventKit

// ─── Calendar (EventKit) bridge ─────────────────────────────────────────────
//
// Fetches local calendar events in a window around "now" so the renderer can
// suggest a meeting title + participants for the transcript header, and detect
// the conferencing platform (Meet / Zoom / Teams / …) from any links on the
// event. Also lists the available calendars so the user can pick which ones to
// pull from (e.g. work only, not Family). Triggered by the one-shot
// `listCalendarEvents` / `listCalendars` commands.
//
// Each event carries `urls`: the http(s) links found in event.url / location /
// notes. Only the URLs are shipped (not the notes prose) — the renderer
// classifies the platform from the host, so the allowlist stays tweakable
// without rebuilding this helper.
//
// TCC: the helper has no bundle of its own, so macOS attributes the calendar
// grant to the parent app — the NSCalendars*UsageDescription strings live in
// the app's Info.plist (electron-builder extendInfo). The prompt itself is
// triggered here on the first call, since Electron has no calendar-prompt API.

enum CalendarBridge {
    // Defaults chosen so a meeting that just started (or is about to) is in range.
    static let defaultBackMinutes = 120
    static let defaultForwardMinutes = 480

    // Requests full access (macOS 14+), blocking the command loop until the user
    // answers — these are one-shot queries, nothing else runs. On refusal emits
    // a permission error and returns false.
    private static func ensureAccess(_ store: EKEventStore) -> Bool {
        let sem = DispatchSemaphore(value: 0)
        var granted = false
        var requestError: Error?
        store.requestFullAccessToEvents { ok, err in
            granted = ok
            requestError = err
            sem.signal()
        }
        sem.wait()

        if !granted {
            Helper.emit([
                "type": "error",
                "reason": "calendar-permission",
                "message": "Calendar access denied. Enable Transcriber in System Settings → Privacy & Security → Calendars."
                    + (requestError.map { " (\($0.localizedDescription))" } ?? ""),
            ])
        }
        return granted
    }

    // Emits the list of event calendars so the renderer can offer a picker.
    static func listCalendars() {
        let store = EKEventStore()
        guard ensureAccess(store) else { return }

        let cals = store.calendars(for: .event).sorted {
            ($0.source.title, $0.title).0 == ($1.source.title, $1.title).0
                ? $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
                : $0.source.title.localizedCaseInsensitiveCompare($1.source.title) == .orderedAscending
        }
        let payload: [[String: Any]] = cals.map { c in
            [
                "id": c.calendarIdentifier,
                "title": c.title,
                "account": c.source.title,
            ]
        }
        Helper.emit(["type": "calendars", "calendars": payload])
    }

    // Emits events in [now-back, now+forward]. When calendarIds is non-nil, only
    // those calendars are queried (nil → all). An explicit selection that matches
    // no calendar yields an empty list rather than silently falling back to all.
    static func listEvents(backMinutes: Int, forwardMinutes: Int, calendarIds: [String]?) {
        let store = EKEventStore()
        guard ensureAccess(store) else { return }

        var cals: [EKCalendar]? = nil
        if let ids = calendarIds {
            let set = Set(ids)
            let filtered = store.calendars(for: .event).filter { set.contains($0.calendarIdentifier) }
            if filtered.isEmpty {
                Helper.emit(["type": "calendarEvents", "events": []])
                return
            }
            cals = filtered
        }

        let now = Date()
        let start = now.addingTimeInterval(-Double(backMinutes) * 60)
        let end = now.addingTimeInterval(Double(forwardMinutes) * 60)
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: cals)
        let events = store.events(matching: predicate)
            .sorted { $0.startDate < $1.startDate }

        let iso = ISO8601DateFormatter()
        let payload: [[String: Any]] = events.map { ev in
            [
                "id": ev.eventIdentifier ?? "",
                "title": ev.title ?? "",
                "start": iso.string(from: ev.startDate),
                "end": iso.string(from: ev.endDate),
                "participants": participantNames(of: ev),
                "urls": conferenceURLs(of: ev),
            ]
        }

        Helper.emit(["type": "calendarEvents", "events": payload])
    }

    // http(s) links found on the event (url field + location + notes). Used by
    // the renderer to detect Meet / Zoom / Teams / … and pick a recording mode.
    private static func conferenceURLs(of event: EKEvent) -> [String] {
        var urls: [String] = []
        var seen = Set<String>()

        func keep(_ s: String?) {
            guard let s = s, s.hasPrefix("http://") || s.hasPrefix("https://") else { return }
            if seen.insert(s).inserted && urls.count < 12 { urls.append(s) }
        }

        keep(event.url?.absoluteString)

        // NSDataDetector robustly pulls URLs out of free-form location / notes.
        let blob = [event.location, event.notes].compactMap { $0 }.joined(separator: "\n")
        if !blob.isEmpty,
           let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
            let range = NSRange(blob.startIndex..., in: blob)
            detector.enumerateMatches(in: blob, options: [], range: range) { match, _, _ in
                keep(match?.url?.absoluteString)
            }
        }
        return urls
    }

    // Display names of attendees + organizer, excluding the current user.
    // Falls back to the email (mailto: URL) when no display name is set.
    private static func participantNames(of event: EKEvent) -> [String] {
        var names: [String] = []
        var seen = Set<String>()

        func add(_ p: EKParticipant?) {
            guard let p = p, !p.isCurrentUser else { return }
            let name = displayName(of: p)
            guard !name.isEmpty else { return }
            let key = name.lowercased()
            if seen.insert(key).inserted { names.append(name) }
        }

        add(event.organizer)
        for attendee in event.attendees ?? [] { add(attendee) }
        return names
    }

    private static func displayName(of p: EKParticipant) -> String {
        if let name = p.name, !name.trimmingCharacters(in: .whitespaces).isEmpty {
            return name
        }
        // URL is typically mailto:user@host — strip the scheme for a readable label.
        let raw = p.url.absoluteString
        if let mailto = raw.range(of: "mailto:") {
            return String(raw[mailto.upperBound...])
        }
        return raw
    }
}
