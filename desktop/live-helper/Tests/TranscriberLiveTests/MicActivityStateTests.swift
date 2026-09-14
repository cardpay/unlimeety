import XCTest
@testable import unlimeety_live

final class MicActivityStateTests: XCTestCase {
    func testSustainedActivitySchedulesThenReportsOnce() {
        var state = MicActivityState()

        XCTAssertEqual(state.observe(active: true), .schedule)
        XCTAssertNil(state.observe(active: true))
        XCTAssertEqual(state.recheck(active: true), .report)
        XCTAssertNil(state.recheck(active: true))
        XCTAssertNil(state.observe(active: true))
    }

    func testDisappearanceDuringDebounceCancelsAndCanRetry() {
        var state = MicActivityState()

        XCTAssertEqual(state.observe(active: true), .schedule)
        XCTAssertEqual(state.observe(active: false), .cancel)
        XCTAssertNil(state.recheck(active: false))
        XCTAssertEqual(state.observe(active: true), .schedule)
    }

    func testLateAppearanceStartsNormalDebounce() {
        var state = MicActivityState()

        XCTAssertNil(state.observe(active: false))
        XCTAssertEqual(state.observe(active: true), .schedule)
    }

    func testReportedActivityClearsOnce() {
        var state = MicActivityState()

        XCTAssertEqual(state.observe(active: true), .schedule)
        XCTAssertEqual(state.recheck(active: true), .report)
        XCTAssertEqual(state.observe(active: false), .inactive)
        XCTAssertNil(state.observe(active: false))
    }
}
