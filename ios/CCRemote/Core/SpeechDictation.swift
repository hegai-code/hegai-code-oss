import Foundation
import Observation
import Speech
import AVFoundation
import os
import CCRemoteKit

/// Peak audio level between UI samples; short syllables cannot fall between ticks.
///
/// The tap runs on an audio thread that must never touch a `@MainActor` object,
/// and publishing every buffer (~47/s) would be pointless churn anyway. It parks
/// the peak RMS here; the meter timer picks it up at screen rate.
private final class LevelBox: @unchecked Sendable {
    private let value = OSAllocatedUnfairLock(initialState: Float(0))
    func write(_ v: Float) { value.withLock { $0 = max($0, v) } }
    func takePeak() -> Float { value.withLock { let peak = $0; $0 = 0; return peak } }
}

/// Writes the tapped audio to an m4a for the hub's `/transcribe`.
///
/// The tap runs on a realtime audio thread, so it must not do the AAC encode and the disk
/// write itself: it copies the buffer and hands it to a serial utility queue
/// (`write`), with a bounded backlog — past `maxPending` buffers the tap drops instead of
/// waiting. Nothing here may throw out of the tap, and a failed or dropped write only costs
/// the file (the live recognizer is unaffected).
/// `AVAudioFile.write(from:)` requires the buffer in the file's processing
/// format, so the file is opened with the INPUT's sample rate and channel
/// count (no rate conversion) and a mismatching buffer is skipped.
private final class RecordingBox: @unchecked Sendable {
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "net.hegai.ccremote.dictation-file", qos: .utility)
    // `file`, `frames` — only on `queue` once recording has started (and in `init`).
    private var file: AVAudioFile?
    private var frames: AVAudioFramePosition = 0
    private var rate: Double = 0
    // `pending`, `closed` — under `lock`.
    private var pending = 0
    private var closed = false
    /// ~1.5 s of audio at 1024 frames / 44.1 kHz; a slower disk loses file audio, not tap time.
    private static let maxPending = 64
    let url: URL

    init?(format: AVAudioFormat) {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("dictation-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: Int(format.channelCount),
            AVEncoderBitRateKey: format.channelCount == 1 ? 48_000 : 64_000
        ]
        guard let file = try? AVAudioFile(forWriting: url, settings: settings,
                                          commonFormat: .pcmFormatFloat32, interleaved: false)
        else { return nil }
        self.url = url
        self.file = file
        self.rate = format.sampleRate
    }

    /// Audio thread. Never throws, never waits for disk or the encoder.
    func write(_ buffer: AVAudioPCMBuffer) {
        // Cheap early-out before paying for the copy.
        lock.lock()
        let room = !closed && pending < Self.maxPending
        lock.unlock()
        guard room, let copy = Self.copy(buffer) else { return }
        // Count AND enqueue under one lock hold: `close()` flips `closed` under the same
        // lock before its `queue.sync`, so a buffer either was refused here or is already
        // on the queue ahead of that sync and gets written. Releasing the lock between
        // `pending += 1` and `queue.async` let `close()` slip in and drop the buffer.
        // `async` only enqueues; it does not wait for the encoder or the disk.
        lock.lock()
        defer { lock.unlock() }
        guard !closed, pending < Self.maxPending else { return }
        pending += 1
        queue.async { [self] in
            writeNow(copy)
            finishOne()
        }
    }

    private func finishOne() {
        lock.lock()
        pending -= 1
        lock.unlock()
    }

    /// The tap's buffer belongs to the engine once the block returns, so the queue gets its own.
    private static func copy(_ source: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let from = source.floatChannelData,
              let copy = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: source.frameLength),
              let to = copy.floatChannelData else { return nil }
        copy.frameLength = source.frameLength
        let bytes = Int(source.frameLength) * MemoryLayout<Float>.size
        for channel in 0..<Int(source.format.channelCount) { memcpy(to[channel], from[channel], bytes) }
        return copy
    }

    /// On `queue`.
    private func writeNow(_ buffer: AVAudioPCMBuffer) {
        guard let file else { return }
        guard buffer.format.sampleRate == file.processingFormat.sampleRate,
              buffer.format.channelCount == file.processingFormat.channelCount else { return }
        do {
            try file.write(from: buffer)
            frames += AVAudioFramePosition(buffer.frameLength)
        } catch {
            self.file = nil // stop writing; the partial file is judged at close
        }
    }

    /// Waits for the queued writes, releases the file (AVAudioFile finalizes the m4a on
    /// deallocation) and returns the recorded length in seconds. The tap is already removed
    /// by the callers; `closed` turns away anything still in flight.
    func close() -> Double {
        lock.lock()
        closed = true
        lock.unlock()
        return queue.sync {
            file = nil
            return rate > 0 ? Double(frames) / rate : 0
        }
    }
}

/// The recognition request the tap feeds. The tap is installed once per
/// recording, but the request behind it is replaced when Speech ends a task
/// while the person is still talking (`SpeechDictation.restartIfStillRecording`).
private final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    /// Puts `request` behind the tap and ends the one it replaces, under the
    /// same lock as `append`: no buffer can reach a request after its end.
    func replace(with request: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock(); defer { lock.unlock() }
        let old = self.request
        self.request = request
        if let old, old !== request { old.endAudio() }
    }
    /// Audio thread. `append` only queues the buffer, so holding the lock is cheap.
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        request?.append(buffer)
    }
}

/// Keeps the whole dictation when Speech starts its hypothesis over.
///
/// `bestTranscription` is meant to hold everything said so far, but after a
/// pause the recognizer can begin a fresh utterance and report only that —
/// the composer then showed (and, when the hub was out of reach, sent) the
/// last stretch alone: 25.10.2026 a minute of dictation went out as its tail.
/// A restart is a hypothesis that is shorter than the previous one AND begins
/// with different words; a revision of the same utterance keeps its opening
/// words, and a growing one is not shorter. When in doubt it keeps both: a
/// repeated phrase costs less than a lost one, and the hub's recognition of
/// the recording replaces this text anyway.
struct UtteranceJoiner: Equatable {
    private(set) var committed = ""
    private var current = ""

    var text: String { Self.join(committed, current) }

    /// The full text after Speech reported `partial`.
    mutating func take(_ partial: String) -> String {
        if Self.restarted(from: current, to: partial) { commit() }
        current = partial
        return text
    }

    /// The current utterance is final; whatever comes next starts a new one.
    mutating func commit() {
        committed = Self.join(committed, current)
        current = ""
    }

    static func restarted(from previous: String, to next: String) -> Bool {
        let before = words(previous), after = words(next)
        guard before.count >= 2, !after.isEmpty, next.count < previous.count else { return false }
        let k = min(2, after.count)
        return Array(before.prefix(k)) != Array(after.prefix(k))
    }

    private static func words(_ s: String) -> [String] {
        s.lowercased()
            .split(whereSeparator: { $0.isWhitespace })
            .map { $0.trimmingCharacters(in: .punctuationCharacters) }
            .filter { !$0.isEmpty }
    }

    private static func join(_ a: String, _ b: String) -> String {
        let a = a.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = b.trimmingCharacters(in: .whitespacesAndNewlines)
        if a.isEmpty { return b }
        if b.isEmpty { return a }
        return a + " " + b
    }
}

/// Speech-to-text for the composer's dictation control.
///
/// Tap to start, tap to stop — the ChatGPT shape, NOT hold-to-talk. That matters
/// beyond taste: a press-and-hold gesture resolves its permission request
/// asynchronously, so an ordinary tap released before the callback returned left
/// the recognizer torn down with nothing on screen to explain it. On the phone
/// this looked exactly like a dead button, because a microphone button is a thing
/// people click.
@MainActor
@Observable
final class SpeechDictation {
    private(set) var transcript = ""
    private(set) var recording = false
    /// Covers permission, recording and final recognition, keeping the control mounted.
    private(set) var active = false
    private(set) var finalizing = false
    private var completion: CheckedContinuation<String?, Never>?
    private var finishTimeout: Task<Void, Never>?
    private var recognitionDrain: Task<Void, Never>?
    private(set) var errorText: String?
    /// Recent audio levels, oldest first, 0…1 — the waveform's data.
    private(set) var levels: [Float] = []
    /// The finished audio file of the last recording (m4a), nil in fixture mode,
    /// after cancel, or once `takeRecording()` handed it over. Whoever takes it
    /// owns the file and must delete it.
    private(set) var recordingURL: URL?
    private(set) var recordedSeconds: Double = 0
    private var recorder: RecordingBox?

    var isAvailable: Bool { recognizer?.isAvailable ?? false }

    private let recognizer = SpeechDictation.deviceRecognizer()
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let requestBox = RequestBox()
    /// Bumped per recognition task, so a task replaced mid-recording cannot
    /// write into the one after it (its own cancel error arrives late).
    private var taskGeneration = 0
    private var taskStarted = Date.distantPast
    private var restarts = 0
    private var joiner = UtteranceJoiner()
    private var inputTapInstalled = false
    private var audioSessionActive = false
    private let level = LevelBox()
    private var meter: Task<Void, Never>?
    /// Bumped on every start/cancel so a permission callback from an older tap
    /// cannot resurrect the recognizer after the user has already stopped it.
    private var generation = 0
    private static let barCount = 56
    private static let glossary = [
        "Hegai Code", "cc-remote", "Claude Code", "Codex", "ChatGPT", "Mac mini", "TestFlight",
        "Forgejo", "iOS", "Android", "Telegram", "деплой", "задеплой", "хаб", "агент",
        "композер", "смоук", "стейдж", "вычитка"
    ]
    private let log = Logger(subsystem: "net.hegai.ccremote", category: "speech")

    /// A recognizer for the language the SPEAKER uses, which is not the same as
    /// `Locale.current`: that is the *app's* locale, and this app ships English
    /// only (`DEVELOPMENT_LANGUAGE = en`, no `CFBundleLocalizations`). So the
    /// no-argument `SFSpeechRecognizer()` built an English recognizer on a Russian
    /// phone and transcribed Russian speech into nonsense. `preferredLanguages` is
    /// the device's own order and ignores what the bundle happens to be localized
    /// into.
    private static func deviceRecognizer() -> SFSpeechRecognizer? {
        let supported = SFSpeechRecognizer.supportedLocales()
        for tag in Locale.preferredLanguages {
            let wanted = Locale(identifier: tag)
            if let exact = supported.first(where: { $0.identifier == wanted.identifier }),
               let r = SFSpeechRecognizer(locale: exact) {
                return r
            }
            // ru → ru-RU: the speaker's language matters, the region rarely does.
            guard let code = wanted.language.languageCode?.identifier else { continue }
            if let byLanguage = supported.first(where: { $0.language.languageCode?.identifier == code }),
               let r = SFSpeechRecognizer(locale: byLanguage) {
                return r
            }
        }
        return SFSpeechRecognizer() ?? SFSpeechRecognizer(locale: Locale(identifier: "en_US"))
    }

    /// Which language dictation will actually listen in — surfaced so a wrong one
    /// is visible instead of arriving as garbled text.
    var localeIdentifier: String { recognizer?.locale.identifier ?? "—" }

    /// The whole public surface: one tap in, one tap out.
    func toggle() {
        if active { stop() } else { begin() }
    }

    func clearError() { errorText = nil }

    /// Hands the recording file to the caller (who deletes it after use).
    func takeRecording() -> URL? {
        defer { recordingURL = nil }
        return recordingURL
    }

    /// Deletes an untaken recording.
    private func discardRecording() {
        if let recorder { _ = recorder.close(); try? FileManager.default.removeItem(at: recorder.url); self.recorder = nil }
        if let url = recordingURL { try? FileManager.default.removeItem(at: url) }
        recordingURL = nil
        recordedSeconds = 0
    }

    /// Files a crash or kill left behind.
    private static func sweepOldRecordings() {
        let dir = FileManager.default.temporaryDirectory
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        for name in names where name.hasPrefix("dictation-") && name.hasSuffix(".m4a") {
            let url = dir.appendingPathComponent(name)
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            if let modified, Date().timeIntervalSince(modified) > 3600 { try? FileManager.default.removeItem(at: url) }
        }
    }

    // MARK: Start

    private func begin() {
        guard !active else { return }
        active = true
        errorText = nil
        transcript = ""
        joiner = UtteranceJoiner()
        restarts = 0
        levels = []
        generation += 1
        discardRecording()
        Self.sweepOldRecordings()
        #if DEBUG
        // Deterministic UI acceptance without microphone/network permissions.
        if ProcessInfo.processInfo.environment["CC_DICTATION_FIXTURE"] == "1" {
            recording = true
            levels = (0..<Self.barCount).map {
                let db: Float = -48 + Float(($0 * 13) % 29)
                return SpeechMeter.level(rms: pow(10, db / 20))
            }
            transcript = "Проверка голосового сообщения"
            if ProcessInfo.processInfo.environment["CC_DICTATION_LIVE_FIXTURE"] == "1" {
                let mine = generation
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(2))
                    guard let self, self.generation == mine, self.recording else { return }
                    self.transcript += ". Текст появляется во время записи, пока я продолжаю говорить."
                    try? await Task.sleep(for: .seconds(2))
                    guard self.generation == mine, self.recording else { return }
                    self.transcript += String(repeating: " Проверяю длинную диктовку и перенос строк.", count: 8)
                        + " Последние слова видны."
                }
            }
            return
        }
        #endif
        let mine = generation
        Task { [weak self] in
            guard let self else { return }
            let granted = await self.authorize()
            // The user may have tapped again while the permission sheet was up.
            guard self.generation == mine, self.active else { return }
            guard granted else { self.active = false; return }
            self.startEngine()
        }
    }

    /// Speech + microphone. Each refusal names itself: a silent `false` here is
    /// indistinguishable from a dead button.
    private func authorize() async -> Bool {
        let speech = await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
        }
        guard speech == .authorized else {
            errorText = "Разрешите распознавание речи в Настройках."
            return false
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            errorText = "Разрешите доступ к микрофону в Настройках."
            return false
        }
        return true
    }

    private func startEngine() {
        guard let recognizer else {
            fail("Распознавание речи недоступно на этом устройстве.")
            return
        }
        guard recognizer.isAvailable else {
            // Server-side recognition needs the network; the on-device model needs
            // a download that iOS schedules on its own.
            fail("Распознавание речи сейчас недоступно — проверьте сеть.")
            return
        }
        guard activateSession() else { return }
        audioSessionActive = true

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        // A zero-rate format means the route isn't up (another app holds the mic).
        // Installing a tap with it throws an ObjC exception no `catch` here absorbs.
        guard format.sampleRate > 0 else {
            fail("Микрофон занят другим приложением.")
            deactivateSession()
            return
        }
        let box = level
        let rec = RecordingBox(format: format)
        recorder = rec
        let feed = requestBox
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            feed.append(buffer)
            box.write(Self.rms(of: buffer))
            rec?.write(buffer)
        }
        inputTapInstalled = true
        engine.prepare()
        do { try engine.start() } catch {
            log.error("engine: \(error.localizedDescription)")
            fail("Не удалось включить микрофон.")
            input.removeTap(onBus: 0)
            inputTapInstalled = false
            discardRecording()
            deactivateSession()
            return
        }
        recording = true
        log.info("dictation listening in \(self.localeIdentifier, privacy: .public)")
        Haptics.rigid()
        startMeter()
        startRecognition(recognizer)
    }

    /// One recognition task over the running tap. Speech ends a task on its
    /// own — a final result after a pause, "no speech" after a silence — and
    /// that used to end the whole dictation while the person was still
    /// speaking into it. Now, while recording, a new task takes over the same
    /// audio and the text so far is kept; only `stop()` ends the dictation.
    private func startRecognition(_ recognizer: SFSpeechRecognizer) {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // Punctuation and a small glossary help the on-device text, which is
        // the preview and the fallback when the hub's recognition fails.
        req.addsPunctuation = true
        req.contextualStrings = Self.glossary
        // The live text is only a preview (the hub transcribes the recording): where the
        // device can do it, keep it off the network and off Apple's servers.
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        requestBox.replace(with: req)
        taskGeneration += 1
        taskStarted = Date()
        let mine = generation, mineTask = taskGeneration
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor in
                guard let self, self.generation == mine, self.taskGeneration == mineTask, self.active else { return }
                if let result {
                    self.transcript = self.joiner.take(result.bestTranscription.formattedString)
                    if result.isFinal {
                        if self.restartIfStillRecording(recognizer) { return }
                        self.complete(success: true)
                        return
                    }
                }
                guard let error else { return }
                self.log.error("recognition: \(error.localizedDescription)")
                if Self.isBenign(error), self.restartIfStillRecording(recognizer) { return }
                if !Self.isBenign(error) { self.errorText = "Не удалось распознать речь. Текст сохранён для проверки." }
                self.complete(success: false)
            }
        }
    }

    /// Speech ended its task but the person is still recording: keep the text
    /// and listen on. A task that died within a second, or too many of them,
    /// is a recognizer that is not working — then the dictation ends as it
    /// always did (the recording still goes to the hub).
    private func restartIfStillRecording(_ recognizer: SFSpeechRecognizer) -> Bool {
        guard recording, !finalizing, restarts < 40,
              Date().timeIntervalSince(taskStarted) >= 1, recognizer.isAvailable else { return false }
        restarts += 1
        joiner.commit()
        transcript = joiner.text
        let old = task
        startRecognition(recognizer) // ends the old request under the tap's lock

        old?.cancel()
        log.info("recognition restarted mid-dictation (\(self.restarts))")
        return true
    }

    // MARK: Stop

    /// End audio, but keep recognition alive until its final result arrives.
    @discardableResult
    func stop() -> String {
        guard active, !finalizing else { return transcript }
        guard recording else { cancel(); return transcript }
        finalizing = true
        stopAudio()
        #if DEBUG
        if ProcessInfo.processInfo.environment["CC_DICTATION_FIXTURE"] == "1" {
            let mine = generation
            finishTimeout = Task { [weak self] in
                let delay = ProcessInfo.processInfo.environment["CC_DICTATION_SLOW_FINAL_FIXTURE"] == "1" ? 2500 : 1000
                try? await Task.sleep(for: .milliseconds(delay))
                guard let self, !Task.isCancelled, self.generation == mine else { return }
                if ProcessInfo.processInfo.environment["CC_DICTATION_FINAL_FIXTURE"] == "1" {
                    self.transcript += " и последние слова"
                }
                let failed = ProcessInfo.processInfo.environment["CC_DICTATION_ERROR_FIXTURE"] == "1"
                if failed { self.errorText = "Не удалось распознать речь. Текст сохранён для проверки." }
                self.complete(success: !failed)
            }
            return transcript
        }
        #endif
        // Keep Speech and AVAudioSession alive while queued audio settles.
        // Signal end-of-audio now; request task completion after the grace period
        // only if Speech has not already returned its final result.
        request?.endAudio()
        let mine = generation
        recognitionDrain = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard let self, !Task.isCancelled, self.generation == mine, self.finalizing else { return }
            self.task?.finish()
        }
        finishTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard let self, !Task.isCancelled, self.generation == mine else { return }
            self.errorText = "Распознавание не завершилось. Проверьте сохранённый текст перед отправкой."
            self.complete(success: false)
        }
        return transcript
    }

    /// Auto-send must use the final result, never the last partial hypothesis.
    func finish() async -> String? {
        guard active, completion == nil else { return nil }
        return await withCheckedContinuation { continuation in
            completion = continuation
            stop()
        }
    }

    func cancel() {
        generation += 1
        complete(success: false)
        discardRecording()
    }

    private func stopAudio() {
        meter?.cancel(); meter = nil
        levels = []
        if engine.isRunning { engine.stop() }
        if inputTapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            inputTapInstalled = false
        }
        closeRecording()
        recording = false
    }

    /// Idempotent (`stop()` and `complete()` both land here). A recording too
    /// short to hold speech is dropped rather than uploaded.
    private func closeRecording() {
        guard let rec = recorder else { return }
        recorder = nil
        let seconds = rec.close()
        if seconds >= 0.4 {
            recordingURL = rec.url
            recordedSeconds = seconds
        } else {
            try? FileManager.default.removeItem(at: rec.url)
        }
    }

    private func complete(success: Bool) {
        active = false
        finalizing = false
        stopAudio()
        finishTimeout?.cancel(); finishTimeout = nil
        recognitionDrain?.cancel(); recognitionDrain = nil
        task?.cancel(); task = nil
        request = nil
        requestBox.replace(with: nil)
        if audioSessionActive { deactivateSession() }
        let waiter = completion
        completion = nil
        waiter?.resume(returning: success ? transcript : nil)
    }

    // MARK: Meter

    /// Samples the level box at ~20 Hz into a fixed-width history. A timer rather
    /// than a per-buffer publish: the waveform only needs to look alive, and the
    /// main actor should not be woken 47 times a second to be told so.
    private func startMeter() {
        meter?.cancel()
        levels = Array(repeating: 0, count: Self.barCount)
        meter = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
                guard let self, !Task.isCancelled, self.recording else { return }
                var next = self.levels
                if !next.isEmpty { next.removeFirst() }
                next.append(self.level.takePeak())
                self.levels = next
            }
        }
    }

    /// RMS mapped onto a decibel-ish curve, because a linear meter on speech sits
    /// near zero and the bars barely move.
    private nonisolated static func rms(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0] else { return 0 }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<count { sum += channel[i] * channel[i] }
        let rms = (sum / Float(count)).squareRoot()
        return SpeechMeter.level(rms: rms)
    }

    /// Speech reports "nobody said anything" and "you cancelled me" through the
    /// same channel as real breakage. These are the routine ones, by the codes
    /// Apple actually emits (`kAFAssistantErrorDomain`); everything else still
    /// reaches the user.
    private nonisolated static func isBenign(_ error: Error) -> Bool {
        let e = error as NSError
        if e.domain == "kAFAssistantErrorDomain" {
            return [203, 216, 301, 1110, 1700].contains(e.code)
        }
        return e.domain == NSCocoaErrorDomain && e.code == NSUserCancelledError
    }

    private func fail(_ message: String) {
        active = false
        errorText = message
    }

    // MARK: Audio session

    /// `.duckOthers` is only legal on `playback` / `playAndRecord` / `multiRoute`
    /// — pairing it with `.record` makes `setCategory` throw, which is how the mic
    /// button came to do nothing at all. Ask for the combination that is valid,
    /// and fall back to a bare `.record` rather than giving up on dictation.
    private func activateSession() -> Bool {
        // macOS has no `AVAudioSession` — the audio engine talks to the default
        // input device directly, so there is no session to negotiate.
        #if os(macOS)
        return true
        #else
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .measurement,
                                    options: [.duckOthers, .defaultToSpeaker, .allowBluetooth])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            return true
        } catch {
            log.warning("audio session (playAndRecord): \(error.localizedDescription)")
        }
        do {
            try session.setCategory(.record, mode: .measurement)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            return true
        } catch {
            log.error("audio session: \(error.localizedDescription)")
            fail("Не удалось получить доступ к микрофону.")
            return false
        }
        #endif
    }

    private func deactivateSession() {
        audioSessionActive = false
        #if !os(macOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}

/// A voice meter, not a recording-gain control. Silence stays quiet; ordinary
/// speech (-35…-20 dBFS) uses most of the visual range before digital clipping.
enum SpeechMeter {
    static func level(rms: Float) -> Float {
        guard rms.isFinite, rms > 0 else { return 0 }
        let db = 20 * log10(rms)
        let normalized = min(1, max(0, (db + 55) / 35))
        return pow(normalized, 0.7)
    }
}
