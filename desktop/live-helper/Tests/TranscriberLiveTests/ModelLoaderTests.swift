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
        XCTAssertNil(ModelLoader.cachedModelFolder(name: model + "\n", inDir: root.path))
    }

    func testRejectsLegacyUnpinnedCache() throws {
        let root = try makeCache(complete: true, legacy: true)
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertNil(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
    }

    func testRejectsUnfinishedOrDifferentRevisionCache() throws {
        let root = try makeCache(complete: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let marker = try XCTUnwrap(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
            .appendingPathComponent(".snapshot-revision")
        try "main".write(to: marker, atomically: true, encoding: .utf8)
        XCTAssertNil(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
        try FileManager.default.removeItem(at: marker)
        XCTAssertNil(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
    }

    func testRejectsCacheMissingConfiguration() throws {
        let root = try makeCache(complete: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = try XCTUnwrap(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
        try FileManager.default.removeItem(at: folder.appendingPathComponent("config.json"))
        XCTAssertNil(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
    }

    func testCompletedSnapshotIsReusableWithoutNetwork() async throws {
        let root = try makeCache(complete: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = try XCTUnwrap(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
        try FileManager.default.removeItem(at: folder.appendingPathComponent(".snapshot-revision"))
        var downloads = 0
        let downloaded = try await ModelLoader.ensureModel(name: model, inDir: root.path, onProgress: { _ in }) { base, name, progress in
            downloads += 1
            XCTAssertEqual(base, ModelLoader.downloadBase(inDir: root.path))
            XCTAssertEqual(name, self.model)
            progress(0.5)
            return folder
        }
        XCTAssertEqual(downloaded, folder)
        XCTAssertEqual(downloads, 1)
        XCTAssertEqual(ModelLoader.cachedModelFolder(name: model, inDir: root.path), folder)
        var progress: [Double] = []
        let reused = try await ModelLoader.ensureModel(name: model, inDir: root.path, onProgress: { progress.append($0) }) { _, _, _ in
            XCTFail("A completed pinned snapshot must not access the network")
            throw CancellationError()
        }
        XCTAssertEqual(reused, folder)
        XCTAssertEqual(progress, [1.0])
    }

    func testIncompleteSnapshotDoesNotBecomeTrusted() async throws {
        let root = try makeCache(complete: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ModelLoader.downloadBase(inDir: root.path)
            .appendingPathComponent("models/argmaxinc/whisperkit-coreml/\(model)")
        do {
            _ = try await ModelLoader.ensureModel(name: model, inDir: root.path, onProgress: { _ in }) { _, _, _ in folder }
            XCTFail("An incomplete snapshot must fail")
        } catch {
            XCTAssertNil(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
        }
    }

    func testCancelledDownloadDoesNotBecomeTrusted() async throws {
        let root = try makeCache(complete: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = try XCTUnwrap(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
        let marker = folder.appendingPathComponent(".snapshot-revision")
        try FileManager.default.removeItem(at: marker)
        // The Hub may return a folder rather than throw when cancellation wins.
        let task = Task {
            try await ModelLoader.ensureModel(name: model, inDir: root.path, onProgress: { _ in }) { _, _, _ in
                withUnsafeCurrentTask { $0?.cancel() }
                return folder
            }
        }
        do {
            _ = try await task.value
            XCTFail("A cancelled download must fail")
        } catch is CancellationError {
            XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
            XCTAssertNil(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
        }
    }

    func testSnapshotRequiresEveryFileAndPinnedMetadata() throws {
        let root = try makeCache(complete: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let repository = ModelLoader.downloadBase(inDir: root.path)
            .appendingPathComponent("models/argmaxinc/whisperkit-coreml")
        let filename = "\(model)/config.json"
        let metadata = repository.appendingPathComponent(".cache/huggingface/download/\(filename).metadata")
        XCTAssertThrowsError(try ModelLoader.validateSnapshot(root: repository, filenames: []))
        XCTAssertThrowsError(try ModelLoader.validateSnapshot(root: repository, filenames: [filename]))
        try FileManager.default.createDirectory(at: metadata.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "main\netag\n0".write(to: metadata, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try ModelLoader.validateSnapshot(root: repository, filenames: [filename]))
        try "\(ModelLoader.revision)\netag\n0".write(to: metadata, atomically: true, encoding: .utf8)
        try ModelLoader.validateSnapshot(root: repository, filenames: [filename])
        try FileManager.default.removeItem(at: repository.appendingPathComponent(filename))
        XCTAssertThrowsError(try ModelLoader.validateSnapshot(root: repository, filenames: [filename]))
    }

    func testFailedRepairRemovesOldCompletionMarker() async throws {
        let root = try makeCache(complete: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = try XCTUnwrap(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
        let config = folder.appendingPathComponent("config.json")
        try FileManager.default.removeItem(at: config)
        do {
            _ = try await ModelLoader.ensureModel(name: model, inDir: root.path, onProgress: { _ in }) { _, _, _ in
                try "{}".write(to: config, atomically: true, encoding: .utf8)
                throw CancellationError()
            }
            XCTFail("A failed repair must fail")
        } catch is CancellationError {
            XCTAssertNil(ModelLoader.cachedModelFolder(name: model, inDir: root.path))
        }
    }

    private func makeCache(complete: Bool, legacy: Bool = false) throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let folder = (legacy ? root : ModelLoader.downloadBase(inDir: root.path))
            .appendingPathComponent("models/argmaxinc/whisperkit-coreml", isDirectory: true)
            .appendingPathComponent(model, isDirectory: true)
        let names = complete
            ? ["AudioEncoder.mlmodelc", "MelSpectrogram.mlmodelc", "TextDecoder.mlmodelc"]
            : ["AudioEncoder.mlmodelc"]
        for name in names {
            try FileManager.default.createDirectory(at: folder.appendingPathComponent(name, isDirectory: true), withIntermediateDirectories: true)
        }
        if complete {
            for name in ["config.json", "generation_config.json"] {
                try "{}".write(to: folder.appendingPathComponent(name), atomically: true, encoding: .utf8)
            }
            if !legacy {
                try ModelLoader.revision.write(to: folder.appendingPathComponent(".snapshot-revision"), atomically: true, encoding: .utf8)
            }
        }
        return root
    }
}
