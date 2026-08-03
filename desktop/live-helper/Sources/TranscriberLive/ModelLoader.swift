import Foundation
import WhisperKit

// Pre-flight model download via WhisperKit's static `download(...)` API,
// which exposes a Progress callback. The returned URL points at the
// directory containing the actual `.mlmodelc` files (i.e. the variant
// folder inside the HF cache layout). Pass that URL straight into
// `WhisperKitConfig.modelFolder` so WhisperKit doesn't try to look up
// the files in the wrong place.

enum ModelLoader {
    /// Downloads the model variant into `dir` (used as the HF download base)
    /// and returns the absolute filesystem URL of the variant directory.
    /// The download is idempotent: if files already exist on disk, the HF Hub
    /// client serves them from cache and `progress` jumps straight to 1.0.
    static func ensureModel(
        name: String,
        inDir dir: String,
        onProgress: @escaping (Double) -> Void
    ) async throws -> URL {
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
