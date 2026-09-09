import XCTest
@testable import unlimeety_live

final class ModelLoaderTests: XCTestCase {
    private let model = "openai_whisper-base"

    func testReturnsCompleteCachedModelWithoutAHubRequest() throws {
        let root = try makeCache(complete: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let folder = try XCTUnwrap(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
        XCTAssertEqual(folder.lastPathComponent, model)
    }

    func testRejectsIncompleteOrUnsafeCachePaths() throws {
        let root = try makeCache(complete: false)
        defer { try? FileManager.default.removeItem(at: root) }

        XCTAssertNil(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
        XCTAssertNil(ModelLoader.cachedModelFolder(name: "../outside", inDir: root.path))
    }

    private func makeCache(complete: Bool) throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let folder = root
            .appendingPathComponent("models/argmaxinc/whisperkit-coreml", isDirectory: true)
            .appendingPathComponent(model, isDirectory: true)
        let names = complete
            ? ["AudioEncoder.mlmodelc", "MelSpectrogram.mlmodelc", "TextDecoder.mlmodelc"]
            : ["AudioEncoder.mlmodelc"]
        for name in names {
            try FileManager.default.createDirectory(at: folder.appendingPathComponent(name, isDirectory: true), withIntermediateDirectories: true)
        }
        return root
    }
}
