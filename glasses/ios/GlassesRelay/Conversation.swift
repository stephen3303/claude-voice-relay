import AVFoundation
import Speech

/// Hands-free loop: listen through the glasses mic → relay read-back step → speak the answer → listen again.
/// While a conversation is open, anything your agents say (the relay's inbox) is read aloud too.
/// Ends when you say "goodbye", or after a stretch of silence (longer while an agent is working).
@MainActor
final class Conversation: NSObject, ObservableObject {
    /// .call: an agent rang and the user answered (Push.swift); CallKit owns the audio session.
    enum Trigger { case glasses, button, call }
    enum Phase: String { case idle = "Idle", listening = "Listening", thinking = "Thinking", speaking = "Speaking" }

    @Published var phase: Phase = .idle
    /// Kept across launches (last 200 lines).
    @Published var transcript: [(who: String, text: String)] = Conversation.loadTranscript() {
        didSet {
            if transcript.count > 200 { transcript.removeFirst(transcript.count - 200) }
            UserDefaults.standard.set(transcript.map { ["who": $0.who, "text": $0.text] }, forKey: "transcript")
        }
    }
    private static func loadTranscript() -> [(who: String, text: String)] {
        let saved = UserDefaults.standard.array(forKey: "transcript") as? [[String: String]] ?? []
        return saved.compactMap { d in d["who"].flatMap { w in d["text"].map { (who: w, text: $0) } } }
    }
    @Published var status = ""
    /// Takes a photo with the glasses; set by GlassesController.
    var takePhoto: (() async throws -> Data)?
    /// Called once when this conversation is over; an agent call hangs up its CallKit call here.
    var onEnded: (@MainActor () -> Void)?
    private var trigger: Trigger = .button

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
    private var player: AVAudioPlayer?
    private var announcements: [String] = []
    private var lastActivity = Date()
    /// Set after "Sent.": an agent is working, so stay on the line for its answer.
    private var awaitingAgent = false

    /// Settings > "Read back what I said". On: the relay repeats your words and waits for "send it".
    /// Off: your words go straight to the agents, so wait for a longer pause before sending.
    static var readBack: Bool {
        get { UserDefaults.standard.object(forKey: "readBack") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "readBack") }
    }
    /// The phone voice picked in Settings (an AVSpeechSynthesisVoice identifier); empty means the best installed one.
    static var voiceID: String {
        get { UserDefaults.standard.string(forKey: "voiceID") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "voiceID") }
    }
    /// Speak over A2DP, Bluetooth's music-quality link, instead of the call-quality HFP link the glasses' mic needs.
    /// The glasses take a moment to switch each way, so replies start and listening resumes a little later.
    static var hiFiSpeech: Bool {
        get { UserDefaults.standard.object(forKey: "hiFiSpeech") as? Bool ?? false }
        set { UserDefaults.standard.set(newValue, forKey: "hiFiSpeech") }
    }
    /// True while the session is on A2DP; the next listen switches back to the glasses' mic.
    private var onHiFi = false

    /// Pause after you stop talking before your turn is sent.
    private var endOfTurn: TimeInterval { Self.readBack ? 1.4 : 2.0 }
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
        self.trigger = trigger
        Task {
            guard await Self.permissionsGranted() else { status = "Mic or speech permission denied"; end(saying: nil); return }
            do { try configureAudioForGlasses() } catch { status = "Audio setup failed: \(error.localizedDescription)"; end(saying: nil); return }
            // Let the Bluetooth route settle before relying on it (Meta's guidance: ~2s).
            try? await Task.sleep(for: .seconds(trigger == .glasses ? 2 : 0.5))
            lastActivity = Date()
            awaitingAgent = false
            startWatchdog()
            inboxTask = Task { await pollInbox() }
            // An agent called: its message (read from the inbox) is the greeting.
            if trigger != .call { await say("Go ahead.") }
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
            // In a call, CallKit deactivates the session when the call ends.
            if trigger != .call { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
            let ended = onEnded
            onEnded = nil
            ended?()
            await Relay.shared.stoppedListening()
        }
    }

    // MARK: audio routing

    private func configureAudioForGlasses() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        if trigger != .call { try session.setActive(true) }   // CallKit activates it for a call
        try useGlassesMic()
    }

    /// `report` is off when switching back after a reply, so the status line keeps naming the voice.
    private func useGlassesMic(report: Bool = true) throws {
        let session = AVAudioSession.sharedInstance()
        // HFP is the only Bluetooth profile that carries the glasses' microphone.
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        onHiFi = false   // only once it worked, so a failed switch back is tried again on the next listen
        if let hfp = session.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) {
            try session.setPreferredInput(hfp)
            if report { status = "Using \(hfp.portName)" }
        } else if report {
            status = "Glasses mic not found — using phone mic"
        }
    }

    /// Playback only, so iOS routes to the glasses over A2DP. Not in an agent call: CallKit owns that session.
    private func useHiFiOutput() {
        guard Self.hiFiSpeech, trigger != .call, !onHiFi else { return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            onHiFi = true
        } catch { status = "High-quality speech failed: \(error.localizedDescription)" }
    }

    // MARK: listening

    private func startListening() {
        heard = ""
        phase = .listening
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer?.supportsOnDeviceRecognition == true { req.requiresOnDeviceRecognition = true }
        request = req

        if onHiFi { try? useGlassesMic(report: false) }
        let input = engine.inputNode
        // Right after switching back from A2DP the mic can briefly have no format; try again in a moment.
        guard input.outputFormat(forBus: 0).sampleRate > 0 else { restartSoon(); return }
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
            if Self.wantsPhoto(text), !Store.shared.isPro {
                reply = Store.Locked.needsPro.localizedDescription
            } else if Self.wantsPhoto(text), let takePhoto {
                await say("Taking a picture.")
                phase = .thinking
                do { reply = try await Relay.shared.photo(try await takePhoto(), said: text) }
                catch { reply = error.localizedDescription; ErrorReporting.report(error, "photo") }
                // The camera session can disturb the Bluetooth audio route; put the glasses mic back.
                try? configureAudioForGlasses()
            } else {
                do { reply = try await Relay.shared.say(Self.forRelay(text), readBack: Self.readBack) }
                catch {
                    reply = "I couldn't reach your PC. \(error.localizedDescription)"
                    ErrorReporting.report(error, "say")
                }
            }
            if reply.hasPrefix("Sent") { awaitingAgent = true }
            transcript.append(("Relay", reply))
            await say(reply)
            await announcePending()
            lastActivity = Date()
            startListening()
        }
    }

    /// The main screen's Look button: one photo and its spoken answer, outside a conversation.
    func look(question: String = "What am I looking at?") {
        guard phase == .idle else { return }
        guard Store.shared.isPro else { status = Store.Locked.needsPro.localizedDescription; return }
        guard let takePhoto else { status = "The glasses camera isn't ready."; return }
        phase = .thinking
        Task {
            let reply: String
            do { reply = try await Relay.shared.photo(try await takePhoto(), said: question) }
            catch { reply = error.localizedDescription; ErrorReporting.report(error, "look") }
            transcript.append(("You", question))
            transcript.append(("Relay", reply))
            await say(reply)
            phase = .idle
        }
    }

    /// "In trading bot, add a check" starts a task, as the Shortcut's "task:" prefix does.
    /// Anything else (send it, yes, status, an answer to an agent) goes through as said.
    nonisolated static func forRelay(_ text: String) -> String {
        text.range(of: #"^(in|on)\s"#, options: [.regularExpression, .caseInsensitive]) != nil ? "task: \(text)" : text
    }

    /// "Look at this, ...", "take a picture", "what am I looking at", "send this to <project>, ..."
    nonisolated static func wantsPhoto(_ text: String) -> Bool {
        text.range(of: #"^(take a (picture|photo)|look at (this|that)|what am i looking at|what('s| is) (this|that)\b|(send|show|give) (this|it|that)( photo| picture)? to )"#,
                   options: [.regularExpression, .caseInsensitive]) != nil
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
        useHiFiOutput()
        // Natural voice from the relay when it has a key, or from Bridge Cloud with Bridge Pro; otherwise (or on any
        // failure) the phone's voice. Without Pro the cloud would refuse, so don't wait for it to.
        if !Relay.shared.isCloud || Store.shared.isPro,
           let mp3 = try? await Relay.shared.speech(text), let player = try? AVAudioPlayer(data: mp3) {
            player.delegate = self
            self.player = player
            status = Relay.shared.isCloud ? "Voice: Bridge Cloud (natural)" : "Voice: relay (natural)"
            await withCheckedContinuation { c in
                speechDone = c
                if !player.play() { speechDone?.resume(); speechDone = nil }
            }
            self.player = nil
            return
        }
        let u = AVSpeechUtterance(string: text)
        u.voice = Self.bestVoice()
        status = "Voice: \(u.voice.map(Self.label) ?? "none")"
        u.rate = 0.5
        await withCheckedContinuation { c in
            speechDone = c
            awaitedUtterance = u
            synth.speak(u)
        }
    }

    /// The voice picked in Settings, else: the default en-US voice is the robotic compact one, so prefer the best installed one
    /// (Premium, then Enhanced); download more in Settings > Accessibility > Spoken Content > Voices.
    static func bestVoice() -> AVSpeechSynthesisVoice? {
        if !voiceID.isEmpty, let picked = AVSpeechSynthesisVoice(identifier: voiceID) { return picked }
        let english = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "en-US" }
        return english.max { $0.quality.rawValue < $1.quality.rawValue }
            ?? AVSpeechSynthesisVoice(language: "en-US")
    }

    /// English voices on the phone, best first, for the picker in Settings.
    static var voices: [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
            .sorted { ($1.quality.rawValue, $0.name) < ($0.quality.rawValue, $1.name) }
    }

    /// "Ava (premium)", with the region when it isn't US English.
    static func label(_ v: AVSpeechSynthesisVoice) -> String {
        let q = ["default", "enhanced", "premium"][max(0, min(v.quality.rawValue - 1, 2))]
        return v.language == "en-US" ? "\(v.name) (\(q))" : "\(v.name) (\(q), \(v.language))"
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

extension Conversation: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully ok: Bool) {
        Task { @MainActor in self.speechDone?.resume(); self.speechDone = nil }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ p: AVAudioPlayer, error: Error?) {
        Task { @MainActor in self.speechDone?.resume(); self.speechDone = nil }
    }
}
