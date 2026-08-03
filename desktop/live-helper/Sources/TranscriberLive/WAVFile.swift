import Foundation
import AVFoundation

// Thin wrapper around AVAudioFile for the Record feature.
//
// `WAVWriter`  — opens a .wav for writing as 16-bit PCM mono @ 16 kHz; accepts
//               Float32 sample arrays and lets AVAudioFile do the conversion.
// `WAVReader`  — opens any PCM .wav (any sample rate / channel count / bit
//               depth) and returns the whole file as 16 kHz mono Float32, the
//               format WhisperKit and SpeakerKit expect.

enum WAVError: Error, LocalizedError {
    case openWriteFailed(String)
    case writeFailed(String)
    case openReadFailed(String)
    case readFailed(String)
    case conversionFailed(String)

    var errorDescription: String? {
        switch self {
        case .openWriteFailed(let m):  return "cannot open WAV for writing: \(m)"
        case .writeFailed(let m):       return "WAV write failed: \(m)"
        case .openReadFailed(let m):    return "cannot open WAV for reading: \(m)"
        case .readFailed(let m):        return "WAV read failed: \(m)"
        case .conversionFailed(let m):  return "audio conversion failed: \(m)"
        }
    }
}

final class WAVWriter {
    private let file: AVAudioFile
    private let bufferFormat: AVAudioFormat   // matches what the caller supplies
    private(set) var framesWritten: AVAudioFramePosition = 0
    let url: URL

    /// Opens (or truncates) a .wav at `url` for streaming Float32 mono samples
    /// at `sampleRate`. The on-disk format is 16-bit PCM mono — AVAudioFile
    /// performs the float→int16 conversion as buffers are written.
    init(url: URL, sampleRate: Double = 16_000) throws {
        self.url = url

        let fileSettings: [String: Any] = [
            AVFormatIDKey:           kAudioFormatLinearPCM,
            AVSampleRateKey:         sampleRate,
            AVNumberOfChannelsKey:   1,
            AVLinearPCMBitDepthKey:  16,
            AVLinearPCMIsFloatKey:   false,
            AVLinearPCMIsBigEndianKey: false,
        ]

        guard let fmt = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: false
        ) else {
            throw WAVError.openWriteFailed("cannot build buffer format")
        }
        self.bufferFormat = fmt

        do {
            self.file = try AVAudioFile(forWriting: url, settings: fileSettings)
        } catch {
            throw WAVError.openWriteFailed(error.localizedDescription)
        }
    }

    /// Append a chunk of 16 kHz mono Float32 samples to the file.
    func append(_ samples: [Float]) throws {
        guard !samples.isEmpty else { return }
        guard let buf = AVAudioPCMBuffer(
            pcmFormat: bufferFormat,
            frameCapacity: AVAudioFrameCount(samples.count)
        ), let dst = buf.floatChannelData?[0] else {
            throw WAVError.writeFailed("cannot allocate PCM buffer")
        }
        samples.withUnsafeBufferPointer { src in
            dst.update(from: src.baseAddress!, count: samples.count)
        }
        buf.frameLength = AVAudioFrameCount(samples.count)

        do {
            try file.write(from: buf)
            framesWritten += AVAudioFramePosition(samples.count)
        } catch {
            throw WAVError.writeFailed(error.localizedDescription)
        }
    }

    /// AVAudioFile flushes the header on deallocation; we expose an explicit
    /// close for clarity even though it's a no-op beyond dropping the ref.
    func close() {
        // intentional no-op: AVAudioFile finalizes the file when released.
    }
}

enum WAVReader {
    /// Decode `url` and return the entire signal as 16 kHz mono Float32.
    /// Works for any PCM wav AVAudioFile can open. Files longer than ~6h
    /// will eat a lot of RAM (1h ≈ 220 MB) — fine for this app's use case.
    static func readAsMono16k(url: URL) throws -> [Float] {
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: url)
        } catch {
            throw WAVError.openReadFailed(error.localizedDescription)
        }

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        ) else {
            throw WAVError.conversionFailed("cannot build target format")
        }

        let srcFormat = file.processingFormat
        let totalFrames = file.length
        guard totalFrames > 0 else { return [] }

        // Guard against malformed / hostile inputs before allocating a buffer
        // sized from the file's declared length. A crafted WAV header can claim a
        // far larger frame count than the file physically holds, which would
        // otherwise trigger a multi-GB AVAudioPCMBuffer allocation (OOM) or an
        // Int64→UInt32 (AVAudioFrameCount) overflow trap.
        guard totalFrames <= AVAudioFramePosition(AVAudioFrameCount.max) else {
            throw WAVError.readFailed("audio too large to load (\(totalFrames) frames)")
        }
        let bytesPerFrame = Int(file.fileFormat.streamDescription.pointee.mBytesPerFrame)
        if bytesPerFrame > 0,
           let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
           let fileSize = (attrs[.size] as? NSNumber)?.intValue {
            // +1 frame of slack for header rounding. For compressed inputs
            // mBytesPerFrame is 0, so this PCM-only sanity check is skipped.
            let maxPlausibleFrames = fileSize / bytesPerFrame + 1
            if Int(totalFrames) > maxPlausibleFrames {
                throw WAVError.readFailed("declared length (\(totalFrames) frames) exceeds file size; refusing to allocate")
            }
        }

        // Read the whole file in one shot at its native format, then convert.
        guard let inBuf = AVAudioPCMBuffer(pcmFormat: srcFormat, frameCapacity: AVAudioFrameCount(totalFrames)) else {
            throw WAVError.readFailed("cannot allocate input buffer")
        }
        do {
            try file.read(into: inBuf)
        } catch {
            throw WAVError.readFailed(error.localizedDescription)
        }

        // Fast path: already 16 kHz mono Float32 — just slice out the samples.
        if srcFormat.sampleRate == 16_000,
           srcFormat.channelCount == 1,
           srcFormat.commonFormat == .pcmFormatFloat32,
           let ptr = inBuf.floatChannelData?[0] {
            return Array(UnsafeBufferPointer(start: ptr, count: Int(inBuf.frameLength)))
        }

        // Resample / downmix / re-pack to the target.
        guard let converter = AVAudioConverter(from: srcFormat, to: targetFormat) else {
            throw WAVError.conversionFailed("cannot build converter \(srcFormat) → 16 kHz mono")
        }

        let ratio = targetFormat.sampleRate / srcFormat.sampleRate
        let outCap = AVAudioFrameCount(Double(inBuf.frameLength) * ratio) + 64
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outCap) else {
            throw WAVError.conversionFailed("cannot allocate output buffer")
        }

        var error: NSError?
        var provided = false
        let status = converter.convert(to: outBuf, error: &error) { _, inputStatus in
            if provided {
                inputStatus.pointee = .noDataNow
                return nil
            }
            provided = true
            inputStatus.pointee = .haveData
            return inBuf
        }
        if status == .error || error != nil {
            throw WAVError.conversionFailed(error?.localizedDescription ?? "unknown")
        }
        guard let outPtr = outBuf.floatChannelData?[0] else {
            return []
        }
        return Array(UnsafeBufferPointer(start: outPtr, count: Int(outBuf.frameLength)))
    }
}
