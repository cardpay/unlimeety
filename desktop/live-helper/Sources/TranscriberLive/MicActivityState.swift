import Foundation

enum MicActivityTransition: Equatable {
    case schedule
    case cancel
    case report
    case inactive
}

struct MicActivityState {
    private(set) var pending = false
    private(set) var reported = false

    mutating func observe(active: Bool) -> MicActivityTransition? {
        if active {
            guard !reported, !pending else { return nil }
            pending = true
            return .schedule
        }

        if pending {
            pending = false
            return .cancel
        }
        if reported {
            reported = false
            return .inactive
        }
        return nil
    }

    mutating func recheck(active: Bool) -> MicActivityTransition? {
        guard pending else { return nil }
        pending = false
        guard active else { return nil }
        reported = true
        return .report
    }
}
