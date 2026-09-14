import XCTest
@testable import unlimeety_live

final class AcousticEchoCancellerTests: XCTestCase {
    func testRemovesDelayedSystemCopyAndKeepsNearFieldSignal() {
        let sampleRate = 16_000
        let delay = 1_280 // 80 ms
        let count = sampleRate * 3
        var system = [Float](repeating: 0, count: count)
        var nearField = [Float](repeating: 0, count: count)
        for i in 0..<count {
            system[i] = Float(sin(Double(i) * 0.071) * 0.35 + sin(Double(i) * 0.013) * 0.2)
            nearField[i] = Float(sin(Double(i) * 0.037) * 0.18)
        }

        var mic = nearField
        for i in delay..<count {
            mic[i] += system[i - delay] * 0.7
        }

        let canceller = AcousticEchoCanceller(sampleRate: sampleRate)
        var mixed: [Float] = []
        for start in stride(from: 0, to: count, by: 1_600) {
            let end = min(start + 1_600, count)
            mixed += canceller.process(mic: Array(mic[start..<end]), system: Array(system[start..<end]))
        }

        let measuredFrom = sampleRate * 2
        var beforeEnergy = 0.0
        var afterEnergy = 0.0
        var nearDot = 0.0
        var cleanedEnergy = 0.0
        var nearEnergy = 0.0
        for i in measuredFrom..<count {
            let originalEcho = Double(mic[i] - nearField[i])
            let cleanedMic = Double(mixed[i] - system[i])
            let remainingEcho = cleanedMic - Double(nearField[i])
            beforeEnergy += originalEcho * originalEcho
            afterEnergy += remainingEcho * remainingEcho
            nearDot += cleanedMic * Double(nearField[i])
            cleanedEnergy += cleanedMic * cleanedMic
            nearEnergy += Double(nearField[i]) * Double(nearField[i])
        }

        XCTAssertLessThan(afterEnergy, beforeEnergy * 0.35)
        XCTAssertGreaterThan(nearDot / (cleanedEnergy * nearEnergy).squareRoot(), 0.7)
    }
}
