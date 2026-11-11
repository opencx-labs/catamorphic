import AVFoundation
import Foundation
import Speech

private let sampleRate = 16_000.0
private let maximumSamples = 16_000 * 60

private struct HelperFailure: Error {
    let code: String
    let message: String
}

private struct Transcript {
    let text: String
    let confidence: Double
    static let empty = Transcript(text: "", confidence: 0)
}

private func logConfidence(_ probability: Double) -> Double {
    log(max(0.000001, min(1, probability)))
}

private func noSpeech(_ error: Error) -> Bool {
    let error = error as NSError
    // Documented in SFSpeechRecognitionTask.h in Apple's Speech SDK.
    return error.domain == "kAFAssistantErrorDomain" && error.code == 1110
}

private func emit(_ object: [String: Any], status: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    exit(status)
}

private func complete(_ transcript: Transcript) -> Never {
    emit(["protocol": 1, "ok": true, "text": transcript.text, "confidence": transcript.confidence])
}

private func preview(_ text: String) {
    if let data = try? JSONSerialization.data(withJSONObject: [
        "protocol": 1, "type": "partial", "text": text.trimmingCharacters(in: .whitespacesAndNewlines)
    ], options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}

/** The existing audio page streams PCM; this helper never opens a microphone. */
private func liveAudio() -> AsyncThrowingStream<AVAudioPCMBuffer, Error> {
    AsyncThrowingStream { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                var pending = Data()
                var total = 0
                while let chunk = try FileHandle.standardInput.read(upToCount: 16_384), !chunk.isEmpty {
                    total += chunk.count
                    guard total <= maximumSamples * MemoryLayout<Float>.size else {
                        throw HelperFailure(code: "audio_too_long", message: "Dictate in stretches of up to one minute, then try again.")
                    }
                    pending.append(chunk)
                    let bytes = pending.count - pending.count % MemoryLayout<Float>.size
                    if bytes == 0 { continue }
                    let count = bytes / MemoryLayout<Float>.size
                    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
                          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
                          let channel = buffer.floatChannelData?[0] else {
                        throw HelperFailure(code: "audio_format", message: "macOS could not prepare dictation audio.")
                    }
                    pending.prefix(bytes).copyBytes(to: UnsafeMutableRawBufferPointer(start: channel, count: bytes))
                    pending.removeFirst(bytes)
                    buffer.frameLength = AVAudioFrameCount(count)
                    for index in 0..<count where !channel[index].isFinite {
                        throw HelperFailure(code: "invalid_audio", message: "The microphone returned invalid audio. Try dictating again.")
                    }
                    continuation.yield(buffer)
                }
                guard pending.isEmpty else {
                    throw HelperFailure(code: "invalid_audio", message: "The audio was incomplete. Try dictating again.")
                }
                continuation.finish()
            } catch { continuation.finish(throwing: error) }
        }
    }
}

private func watchLifetime(preparing: Bool) -> DispatchSourceTimer {
    let parent = getppid()
    let deadline = DispatchTime.now() + .seconds(preparing ? 300 : 90)
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    timer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
    timer.setEventHandler {
        // A worker that crashed cannot dispose its subprocess. Process teardown
        // releases its Speech task; no audio or temporary files remain behind.
        if getppid() != parent { exit(0) }
        if DispatchTime.now() >= deadline {
            emit(["protocol": 1, "ok": false, "error": [
                "code": "timeout",
                "message": preparing
                    ? "macOS speech preparation timed out. Check your internet connection and try enabling voice again."
                    : "macOS speech recognition timed out. Try dictating again."
            ]], status: 1)
        }
    }
    timer.resume()
    return timer
}

private func readAudio() throws -> AVAudioPCMBuffer? {
    // Bound the input before allocating its float buffer, including malformed callers.
    var data = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: 65_536), !chunk.isEmpty {
        data.append(chunk)
        if data.count > maximumSamples * MemoryLayout<Float>.size {
            throw HelperFailure(code: "audio_too_long", message: "Dictate in stretches of up to one minute, then try again.")
        }
    }
    guard data.count % MemoryLayout<Float>.size == 0 else {
        throw HelperFailure(code: "invalid_audio", message: "The audio was incomplete. Try dictating again.")
    }
    let count = data.count / MemoryLayout<Float>.size
    if count == 0 { return nil }
    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
          let channel = buffer.floatChannelData?[0] else {
        throw HelperFailure(code: "audio_format", message: "macOS could not prepare dictation audio. Restart Work and try again.")
    }
    data.copyBytes(to: UnsafeMutableRawBufferPointer(start: channel, count: data.count))
    buffer.frameLength = AVAudioFrameCount(count)
    var power = 0.0
    for index in 0..<count {
        let sample = channel[index]
        guard sample.isFinite else {
            throw HelperFailure(code: "invalid_audio", message: "The microphone returned invalid audio. Try dictating again.")
        }
        power += Double(sample) * Double(sample)
    }
    // Do not ask for permissions or wake a recognizer for silence.
    return power / Double(count) <= 0.0000000001 ? nil : buffer
}

private func convert(_ input: AVAudioPCMBuffer, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
    if input.format == format { return input }
    let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * format.sampleRate / input.format.sampleRate)) + 256
    guard let converter = AVAudioConverter(from: input.format, to: format),
          let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
        throw HelperFailure(code: "audio_format", message: "macOS could not convert dictation audio. Restart Work and try again.")
    }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, inputStatus in
        if supplied {
            inputStatus.pointee = .endOfStream
            return nil
        }
        supplied = true
        inputStatus.pointee = .haveData
        return input
    }
    guard error == nil, status != .error, output.frameLength > 0 else {
        throw HelperFailure(code: "audio_format", message: "macOS could not convert dictation audio. Try dictating again.")
    }
    return output
}

@available(macOS 26.0, *)
private func transcriberLocale(_ locale: Locale) async -> Locale? {
    guard SpeechTranscriber.isAvailable else { return nil }
    return await SpeechTranscriber.supportedLocale(equivalentTo: locale)
}

@available(macOS 26.0, *)
private func makeTranscriber(locale: Locale, live: Bool = false) -> SpeechTranscriber {
    SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: live ? [.volatileResults] : [], attributeOptions: [.transcriptionConfidence])
}

@available(macOS 26.0, *)
private func transcribeLive(locale: Locale) async throws -> Transcript {
    let transcriber = makeTranscriber(locale: locale, live: true)
    guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
        throw HelperFailure(code: "assets_required", message: "macOS needs to prepare its speech recognition language. Try voice again while connected to the internet.")
    }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        throw HelperFailure(code: "audio_format", message: "macOS could not prepare speech recognition.")
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let results = Task { () throws -> Transcript in
        var committed = ""
        var pending = ""
        for try await result in transcriber.results {
            let text = String(result.text.characters)
            if result.isFinal {
                committed += text
                pending = ""
            } else { pending = text }
            preview(committed + pending)
        }
        return Transcript(text: committed.trimmingCharacters(in: .whitespacesAndNewlines), confidence: 0)
    }
    do {
        let inputs = liveAudio().map { AnalyzerInput(buffer: try convert($0, to: format)) }
        if let lastSample = try await analyzer.analyzeSequence(inputs) {
            try await analyzer.finalizeAndFinish(through: lastSample)
        } else { await analyzer.cancelAndFinishNow() }
        return try await results.value
    } catch {
        await analyzer.cancelAndFinishNow()
        results.cancel()
        throw error
    }
}

/** Older Macs can finalize an OS recognition segment during a held pause.
 * Start the next recognition request; only stdin EOF ends the person's hold. */
@MainActor
private final class LegacyLiveRecognition {
    private var task: SFSpeechRecognitionTask?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var generation = 0
    private var ended = false
    private var committed = ""
    private var pending = ""
    private var failure: Error?
    private var completion: CheckedContinuation<Transcript, Error>?

    func run(locale: Locale) async throws -> Transcript {
        try await authorizeLegacy()
        let recognizer = try legacyRecognizer(locale: locale)
        begin(recognizer)
        for try await buffer in liveAudio() {
            if let failure { throw failure }
            request?.append(buffer)
        }
        if let failure { throw failure }
        ended = true
        return try await withCheckedThrowingContinuation { continuation in
            completion = continuation
            request?.endAudio()
        }
    }

    private func begin(_ recognizer: SFSpeechRecognizer) {
        generation += 1
        let mine = generation
        let input = SFSpeechAudioBufferRecognitionRequest()
        input.shouldReportPartialResults = true
        input.taskHint = .dictation
        input.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        request = input
        task = recognizer.recognitionTask(with: input) { result, error in
            Task { @MainActor in
                guard mine == self.generation else { return }
                if let result {
                    self.pending = result.bestTranscription.formattedString
                    preview(self.committed + self.pending)
                    if result.isFinal {
                        self.commit(recognizer)
                        return
                    }
                }
                if let error {
                    if noSpeech(error) { self.commit(recognizer) }
                    else {
                        self.failure = error
                        self.completion?.resume(throwing: error)
                        self.completion = nil
                    }
                }
            }
        }
    }

    private func commit(_ recognizer: SFSpeechRecognizer) {
        let text = (committed + pending).trimmingCharacters(in: .whitespacesAndNewlines)
        pending = ""
        if ended {
            completion?.resume(returning: Transcript(text: text, confidence: 0))
            completion = nil
        } else {
            committed = text.isEmpty ? "" : text + " "
            begin(recognizer)
        }
    }
}

@available(macOS 26.0, *)
private func prepareTranscriber(locale: Locale) async throws {
    let transcriber = makeTranscriber(locale: locale)
    // Only Apple's inventory manages these shared OS assets. No Work model files.
    do {
        if let installation = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await installation.downloadAndInstall()
        }
        guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
            throw HelperFailure(code: "assets_unavailable", message: "macOS could not prepare speech recognition for \(locale.localizedString(forIdentifier: locale.identifier) ?? locale.identifier). Connect to the internet, enable Dictation in System Settings > Keyboard, then try again.")
        }
    } catch let failure as HelperFailure {
        throw failure
    } catch {
        throw HelperFailure(code: "assets_unavailable", message: "macOS could not prepare its speech recognition language. Check your internet connection, enable Dictation in System Settings > Keyboard, then try again. \(error.localizedDescription)")
    }
}

@available(macOS 26.0, *)
private func transcribe(_ input: AVAudioPCMBuffer, locale: Locale) async throws -> Transcript {
    let transcriber = makeTranscriber(locale: locale)
    guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
        throw HelperFailure(code: "assets_required", message: "macOS needs to prepare its speech recognition language. Turn voice off and on while connected to the internet, then try again.")
    }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: input.format) else {
        throw HelperFailure(code: "audio_format", message: "macOS could not prepare its speech recognition language. Turn voice off and on, then try again.")
    }
    let audio = try convert(input, to: format)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let results = Task { () throws -> Transcript in
        var text = ""
        var sum = 0.0
        var weight = 0
        for try await result in transcriber.results {
            text += String(result.text.characters)
            for run in result.text.runs {
                if let confidence = run.transcriptionConfidence, confidence.isFinite {
                    let length = result.text[run.range].characters.count
                    sum += logConfidence(confidence) * Double(length)
                    weight += length
                }
            }
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return Transcript(text: trimmed, confidence: trimmed.isEmpty || weight == 0 ? 0 : sum / Double(weight))
    }
    do {
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        continuation.yield(AnalyzerInput(buffer: audio))
        continuation.finish()
        if let lastSample = try await analyzer.analyzeSequence(stream) {
            try await analyzer.finalizeAndFinish(through: lastSample)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        return try await results.value
    } catch {
        await analyzer.cancelAndFinishNow()
        results.cancel()
        if noSpeech(error) { return .empty }
        throw error
    }
}

@MainActor
private func authorizeLegacy() async throws {
    let status = SFSpeechRecognizer.authorizationStatus()
    let resolved: SFSpeechRecognizerAuthorizationStatus
    if status == .notDetermined {
        resolved = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
    } else {
        resolved = status
    }
    switch resolved {
    case .authorized: return
    case .restricted:
        throw HelperFailure(code: "speech_restricted", message: "Speech recognition is restricted on this Mac. Check Screen Time or your organization's device settings.")
    default:
        throw HelperFailure(code: "speech_permission", message: "Allow Work in System Settings > Privacy & Security > Speech Recognition, then try dictating again.")
    }
}

@MainActor
private func legacyRecognizer(locale: Locale) throws -> SFSpeechRecognizer {
    guard let recognizer = SFSpeechRecognizer(locale: locale) else {
        throw HelperFailure(code: "unsupported_locale", message: "macOS does not support speech recognition for \(locale.identifier). Choose a supported Dictation language in System Settings > Keyboard.")
    }
    guard recognizer.isAvailable else {
        throw HelperFailure(code: "speech_unavailable", message: "Apple speech recognition is unavailable. Check your internet connection and Dictation in System Settings > Keyboard, then try again.")
    }
    return recognizer
}

@MainActor
private final class LegacyRecognition {
    private var task: SFSpeechRecognitionTask?
    private var continuation: CheckedContinuation<Transcript, Error>?

    func run(input: AVAudioPCMBuffer, locale: Locale) async throws -> Transcript {
        try await authorizeLegacy()
        let recognizer = try legacyRecognizer(locale: locale)
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = false
        request.taskHint = .dictation
        // Prefer Apple's on-device recognition where this Mac and language support it.
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            task = recognizer.recognitionTask(with: request) { result, error in
                Task { @MainActor in
                    if let result, result.isFinal {
                        let best = result.bestTranscription
                        let text = best.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                        let segments = best.segments
                        let sum = segments.reduce(0.0) { $0 + logConfidence(Double($1.confidence)) }
                        self.finish(.success(Transcript(text: text, confidence: text.isEmpty || segments.isEmpty ? 0 : sum / Double(segments.count))))
                    } else if let error {
                        self.finish(noSpeech(error) ? .success(.empty) : .failure(error))
                    }
                }
            }
            request.append(input)
            request.endAudio()
        }
    }

    private func finish(_ result: Result<Transcript, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        task?.cancel()
        task = nil
        continuation.resume(with: result)
    }
}

@main
private struct SpeechRecognitionMain {
    @MainActor
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--version"] {
            print("work-speech-recognition 1")
            return
        }
        let watchdog = watchLifetime(preparing: arguments.contains("--prepare"))
        defer { watchdog.cancel() }
        do {
            var locale = Locale.current
            var prepare = false
            var streaming = false
            var index = 0
            while index < arguments.count {
                switch arguments[index] {
                case "--prepare": prepare = true
                case "--stream": streaming = true
                case "--locale":
                    index += 1
                    guard index < arguments.count, !arguments[index].isEmpty else {
                        throw HelperFailure(code: "arguments", message: "A speech recognition language is required.")
                    }
                    locale = Locale(identifier: arguments[index])
                default: throw HelperFailure(code: "arguments", message: "Unsupported speech recognition option.")
                }
                index += 1
            }
            if prepare {
                if #available(macOS 26.0, *), let supported = await transcriberLocale(locale) {
                    try await prepareTranscriber(locale: supported)
                } else {
                    try await authorizeLegacy()
                    _ = try legacyRecognizer(locale: locale)
                }
                complete(.empty)
            }
            if streaming {
                if #available(macOS 26.0, *), let supported = await transcriberLocale(locale) {
                    complete(try await transcribeLive(locale: supported))
                }
                complete(try await LegacyLiveRecognition().run(locale: locale))
            }
            guard let input = try readAudio() else { complete(.empty) }
            if #available(macOS 26.0, *), let supported = await transcriberLocale(locale) {
                complete(try await transcribe(input, locale: supported))
            }
            complete(try await LegacyRecognition().run(input: input, locale: locale))
        } catch {
            let failure = error as? HelperFailure ?? HelperFailure(code: "recognition_failed", message: "macOS could not transcribe this audio. Try again. \(error.localizedDescription)")
            emit(["protocol": 1, "ok": false, "error": ["code": failure.code, "message": failure.message]], status: 1)
        }
    }
}
