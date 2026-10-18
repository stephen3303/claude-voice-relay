import AVFoundation
import Speech

/// Hands-free loop: listen through the glasses mic → relay read-back step → speak the answer → listen again.
/// While a conversation is open, anything your agents say (the relay's inbox) is read aloud too.
/// Ends when you say "goodbye", or after a stretch of silence (longer while an agent is working).
@MainActor
final class Conversation: NSObject, ObservableObject {
    enum Trigger { case glasses, button }
    enum Phase: String { case idle = "Idle", listening = "Listening", thinking = "Thinking", speaking = "Speaking" }

    @Published var phase: Phase = .idle
    @Published var transcript: [(who: String, text: String)] = []
    @Published var status = ""

    private let engine = AVAudioEngine()
    private let synth = AVSpeechSynthesizer()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?
    private var watchdog: Timer?
    private var inboxTask: Task<Void, Never>?
    private var heard = ""
    private var speechDone: CheckedContinuation<Void, Never>?
    private var awaitedUtterance: AVSpeechUtterance?
    private var announcements: [String] = []
    private var lastActivity = Date()
    /// Set after "Sent.": an agent is working, so stay on the line for its answer.
    private var awaitingAgent = false

    /// Pause after you stop talking before your turn is sent.
    private let endOfTurn: TimeInterval = 1.4
    /// Hang up after this much silence, or the longer one while an agent is working.
    private let idleHangup: TimeInterval = 25
    private let agentHangup: TimeInterval = 15 * 60
    /// Agent messages older than this are not read out when a conversation starts.
    private let maxBacklogAge = 30 * 60

    override init() {
        super.init()
        synth.delegate = self
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            // A route change (e.g. HFP renegotiating 8k↔16k) stops the engine; rebuild the tap on the new format.
            Task { @MainActor in if self?.phase == .listening { self?.restartListening() } }
        }
    }

    // MARK: lifecycle

    func begin(trigger: Trigger) {
        guard phase == .idle else { return }
        phase = .thinking
        Task {
            guard await Self.permissionsGranted() else { status = "Mic or speech permission denied"; phase = .idle; return }
            do { try configureAudioForGlasses() } catch { status = "Audio setup failed: \(error.localizedDescription)"; phase = .idle; return }
            // Let the Bluetooth route settle before relying on it (Meta's guidance: ~2s).
            try? await Task.sleep(for: .seconds(trigger == .glasses ? 2 : 0.5))
            lastActivity = Date()
            awaitingAgent = false
            startWatchdog()
            inboxTask = Task { await pollInbox() }
            await say("Go ahead.")
            await announcePending()
            startListening()
        }
    }

    func end(saying goodbye: String? = "Talk soon.") {
        Task {
            stopListening()
            watchdog?.invalidate()
            inboxTask?.cancel(); inboxTask = nil
            if let goodbye { await say(goodbye) }
            phase = .idle
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    // MARK: audio routing

    private func configureAudioForGlasses() throws {
        let session = AVAudioSession.sharedInstance()
        // HFP is the only Bluetooth profile that carries the glasses' microphone.
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        try session.setActive(true)
        if let hfp = session.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) {
            try session.setPreferredInput(hfp)
            status = "Using \(hfp.portName)"
        } else {
            status = "Glasses mic not found — using phone mic"
        }
    }

    // MARK: listening

    private func startListening() {
        heard = ""
        phase = .listening
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer?.supportsOnDeviceRecognition == true { req.requiresOnDeviceRecognition = true }
        request = req

        let input = engine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak req] buffer, _ in
            req?.append(buffer)
        }
        engine.prepare()
        do { try engine.start() } catch { status = "Mic failed: \(error.localizedDescription)"; return }

        task = recognizer?.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor in
                guard let self, self.phase == .listening else { return }
                if let result {
                    self.heard = result.bestTranscription.formattedString
                    self.armSilenceTimer()
                    if result.isFinal { self.finishTurn() }
                } else if error != nil {
                    // Recognition gives up after a quiet spell; keep the line open by starting a fresh one.
                    if self.heard.isEmpty { self.restartSoon() } else { self.finishTurn() }
                }
            }
        }
    }

    private func restartListening() {
        stopListening()
        startListening()
    }

    private func restartSoon() {
        stopListening()
        Task {
            try? await Task.sleep(for: .seconds(1))
            if phase == .listening { startListening() }
        }
    }

    private func stopListening() {
        silenceTimer?.invalidate()
        task?.cancel(); task = nil
        request?.endAudio(); request = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private func armSilenceTimer() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: endOfTurn, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.finishTurn() }
        }
    }

    private func startWatchdog() {
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.phase == .listening, self.heard.isEmpty else { return }
                let limit = self.awaitingAgent ? self.agentHangup : self.idleHangup
                if Date().timeIntervalSince(self.lastActivity) > limit {
                    self.end(saying: "I'll hang up. Say Hey Meta, start Bridge when you need me.")
                }
            }
        }
    }

    // MARK: a turn

    private func finishTurn() {
        guard phase == .listening else { return }
        let text = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        stopListening()   // never listen while speaking, or the recognizer hears the reply
        guard !text.isEmpty else { startListening(); return }
        transcript.append(("You", text))
        lastActivity = Date()

        // Recognizer output can carry capitals and trailing punctuation ("Goodbye.").
        let lower = text.lowercased().trimmingCharacters(in: .punctuationCharacters.union(.whitespaces))
        if ["goodbye", "good bye", "stop listening", "that's all", "hang up"].contains(where: { lower.hasSuffix($0) }) {
            end(); return
        }
        Task {
            phase = .thinking
            let reply: String
            do { reply = try await Relay.shared.say(Self.forRelay(text)) }
            catch { reply = "I couldn't reach your PC. \(error.localizedDescription)" }
            if reply.hasPrefix("Sent") { awaitingAgent = true }
            transcript.append(("Relay", reply))
            await say(reply)
            await announcePending()
            lastActivity = Date()
            startListening()
        }
    }

    /// "In trading bot, add a check" starts a task, as the Shortcut's "task:" prefix does.
    /// Anything else (send it, yes, status, an answer to an agent) goes through as said.
    static func forRelay(_ text: String) -> String {
        text.range(of: #"^(in|on)\s"#, options: [.regularExpression, .caseInsensitive]) != nil ? "task: \(text)" : text
    }

    // MARK: agent messages

    private func pollInbox() async {
        let d = UserDefaults.standard
        while !Task.isCancelled {
            do {
                let knownBoot = d.double(forKey: "inboxBoot")
                let inbox = try await Relay.shared.inbox(after: knownBoot == 0 ? 0 : d.integer(forKey: "inboxLast"))
                if Task.isCancelled { return }
                if inbox.boot != knownBoot {
                    // The relay restarted, so its ids did too: ask again from the start of its buffer.
                    d.set(inbox.boot, forKey: "inboxBoot"); d.set(0, forKey: "inboxLast")
                    if knownBoot != 0 { continue }
                }
                d.set(inbox.last, forKey: "inboxLast")
                let fresh = inbox.messages.filter { $0.age <= maxBacklogAge }.map(\.text)
                guard !fresh.isEmpty else { continue }
                announcements += fresh
                awaitingAgent = false
                lastActivity = Date()
                // Interrupt only an empty listen; mid-sentence or mid-reply, it's read before the next listen.
                if phase == .listening && heard.isEmpty {
                    stopListening()
                    await announcePending()
                    if phase != .idle { startListening() }
                }
            } catch {
                if Task.isCancelled { return }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private func announcePending() async {
        while !announcements.isEmpty {
            let text = announcements.removeFirst()
            transcript.append(("Agent", text))
            await say(text)
        }
    }

    // MARK: speech out

    private func say(_ text: String) async {
        phase = .speaking
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: "en-US")
        u.rate = 0.52
        await withCheckedContinuation { c in
            speechDone = c
            awaitedUtterance = u
            synth.speak(u)
        }
    }

    fileprivate func finished(_ u: AVSpeechUtterance) {
        guard u === awaitedUtterance else { return }
        awaitedUtterance = nil
        speechDone?.resume(); speechDone = nil
    }

    private static func permissionsGranted() async -> Bool {
        let mic = await AVAudioApplication.requestRecordPermission()
        let speech = await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
        return mic && speech
    }
}

extension Conversation: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in self.finished(u) }
    }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        Task { @MainActor in self.finished(u) }
    }
}
