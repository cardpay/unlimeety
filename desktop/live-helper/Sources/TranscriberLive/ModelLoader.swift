import Foundation
import WhisperKit

// Pre-flight model download via WhisperKit's static `download(...)` API,
// which exposes a Progress callback. The returned URL points at the
// directory containing the actual `.mlmodelc` files (i.e. the variant
// folder inside the HF cache layout). Pass that URL straight into
// `WhisperKitConfig.modelFolder` so WhisperKit doesn't try to look up
// the files in the wrong place.

enum ModelLoader {
    private static let requiredModelDirectories = [
        "AudioEncoder.mlmodelc",
        "MelSpectrogram.mlmodelc",
        "TextDecoder.mlmodelc",
    ]

    // A fully downloaded WhisperKit variant is already executable offline.
    // Avoid calling the Hub client in that case: its metadata lookup can fail
    // before it discovers the cache when the device has no network connection.
    static func cachedModelFolder(name: String, inDir dir: String) -> URL? {
        guard name.range(of: "^openai_whisper-[A-Za-z0-9._-]+$", options: .regularExpression) != nil else {
            return nil
        }
        let folder = URL(fileURLWithPath: dir, isDirectory: true)
            .appendingPathComponent("models/argmaxinc/whisperkit-coreml", isDirectory: true)
            .appendingPathComponent(name, isDirectory: true)
        let files = FileManager.default
        guard requiredModelDirectories.allSatisfy({
            var isDirectory: ObjCBool = false
            return files.fileExists(atPath: folder.appendingPathComponent($0, isDirectory: true).path, isDirectory: &isDirectory)
                && isDirectory.boolValue
        }) else { return nil }
        return folder
    }

    /// Downloads the model variant into `dir` (used as the HF download base)
    /// and returns the absolute filesystem URL of the variant directory.
    /// The download is idempotent: if files already exist on disk, the HF Hub
    /// client serves them from cache and `progress` jumps straight to 1.0.
    static func ensureModel(
        name: String,
        inDir dir: String,
        onProgress: @escaping (Double) -> Void
    ) async throws -> URL {
        if let cached = cachedModelFolder(name: name, inDir: dir) {
            onProgress(1.0)
            return cached
        }

        let folderURL = URL(fileURLWithPath: dir, isDirectory: true)
        try FileManager.default.createDirectory(at: folderURL, withIntermediateDirectories: true)

        let modelFolder = try await WhisperKit.download(
            variant: name,
            downloadBase: folderURL,
            useBackgroundSession: false,
            from: "argmaxinc/whisperkit-coreml",
            progressCallback: { progress in
                onProgress(progress.fractionCompleted)
            }
        )
        onProgress(1.0)
        return modelFolder
    }
}
