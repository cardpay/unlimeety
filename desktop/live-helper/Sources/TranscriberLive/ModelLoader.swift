import Foundation
import WhisperKit

enum ModelLoader {
    // Keep in sync with WHISPER_MODEL_REVISION beside WHISPER_MODEL_RE in main.js.
    // https://huggingface.co/argmaxinc/whisperkit-coreml/commit/0f63a7800b00dd0226abd051b906c246e1907482
    static let revision = "0f63a7800b00dd0226abd051b906c246e1907482"
    private static let repository = HubApiWrapper.Repo(id: "argmaxinc/whisperkit-coreml")
    private static let completionMarker = ".snapshot-revision"
    private static let requiredModelDirectories = [
        "AudioEncoder.mlmodelc",
        "MelSpectrogram.mlmodelc",
        "TextDecoder.mlmodelc",
    ]

    private static func validName(_ name: String) -> Bool {
        name.range(of: "^openai_whisper-[A-Za-z0-9._-]+$", options: .regularExpression) != nil
            && !name.contains("\n") && !name.contains("\r")
    }

    static func downloadBase(inDir dir: String) -> URL {
        URL(fileURLWithPath: dir, isDirectory: true)
            .appendingPathComponent("revisions", isDirectory: true)
            .appendingPathComponent(revision, isDirectory: true)
    }

    private static func modelFolder(name: String, inDir dir: String) -> URL {
        downloadBase(inDir: dir)
            .appendingPathComponent("models/argmaxinc/whisperkit-coreml", isDirectory: true)
            .appendingPathComponent(name, isDirectory: true)
    }

    private static func hasRequiredFiles(_ folder: URL) -> Bool {
        let files = FileManager.default
        return requiredModelDirectories.allSatisfy({
            var isDirectory: ObjCBool = false
            return files.fileExists(atPath: folder.appendingPathComponent($0, isDirectory: true).path, isDirectory: &isDirectory)
                && isDirectory.boolValue
        }) && ["config.json", "generation_config.json"].allSatisfy({
            var isDirectory: ObjCBool = false
            return files.fileExists(atPath: folder.appendingPathComponent($0).path, isDirectory: &isDirectory)
                && !isDirectory.boolValue
        })
    }

    // Only snapshots completed at our pin may bypass the Hub for offline use.
    // Legacy caches and interrupted downloads must never acquire trust just
    // because the three compiled-model directories happen to exist.
    static func cachedModelFolder(name: String, inDir dir: String) -> URL? {
        guard validName(name) else { return nil }
        let folder = modelFolder(name: name, inDir: dir)
        guard hasRequiredFiles(folder),
              (try? String(contentsOf: folder.appendingPathComponent(completionMarker), encoding: .utf8)) == revision
        else { return nil }
        return folder
    }

    private static func downloadSnapshot(
        base: URL, name: String, onProgress: @escaping (Double) -> Void
    ) async throws -> URL {
        let hub = HubApiWrapper(downloadBase: base, endpoint: "https://huggingface.co", useBackgroundSession: false)
        let matching = ["\(name)/*"]
        // Fetch the pinned inventory explicitly: snapshot's automatic offline
        // fallback can otherwise return a partially populated repository cache.
        let filenames = try await hub.getFilenames(from: repository, revision: revision, matching: matching)
        guard !filenames.isEmpty else { throw WhisperError.modelsUnavailable("No files at pinned model revision") }
        let root = try await hub.snapshot(from: repository, revision: revision, matching: matching) { progress in
            onProgress(progress.fractionCompleted)
        }
        try Task.checkCancellation()
        try validateSnapshot(root: root, filenames: filenames)
        return root.appendingPathComponent(name, isDirectory: true)
    }

    static func validateSnapshot(root: URL, filenames: [String]) throws {
        guard !filenames.isEmpty else { throw WhisperError.modelsUnavailable("Empty pinned model snapshot") }
        for filename in filenames {
            let metadata = root.appendingPathComponent(".cache/huggingface/download/\(filename).metadata")
            guard FileManager.default.fileExists(atPath: root.appendingPathComponent(filename).path),
                  let contents = try? String(contentsOf: metadata, encoding: .utf8),
                  contents.components(separatedBy: .newlines).first == revision
            else { throw WhisperError.modelsUnavailable("Incomplete pinned model snapshot") }
        }
    }

    /// Returns the variant folder, isolated from caches fetched from moving refs.
    static func ensureModel(
        name: String,
        inDir dir: String,
        onProgress: @escaping (Double) -> Void,
        download: (URL, String, @escaping (Double) -> Void) async throws -> URL = downloadSnapshot
    ) async throws -> URL {
        guard validName(name) else { throw WhisperError.modelsUnavailable("Invalid model name") }
        if let cached = cachedModelFolder(name: name, inDir: dir) {
            onProgress(1.0)
            return cached
        }

        let folderURL = downloadBase(inDir: dir)
        try FileManager.default.createDirectory(at: folderURL, withIntermediateDirectories: true)
        let marker = modelFolder(name: name, inDir: dir).appendingPathComponent(completionMarker)
        if FileManager.default.fileExists(atPath: marker.path) {
            try FileManager.default.removeItem(at: marker)
        }

        let downloaded = try await download(folderURL, name, onProgress)
        try Task.checkCancellation()
        guard downloaded == modelFolder(name: name, inDir: dir), hasRequiredFiles(downloaded)
        else { throw WhisperError.modelsUnavailable("Incomplete pinned model snapshot") }
        try revision.write(to: downloaded.appendingPathComponent(completionMarker), atomically: true, encoding: .utf8)
        onProgress(1.0)
        return downloaded
    }
}
