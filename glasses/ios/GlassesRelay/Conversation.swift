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
    /// Bridge just asked something ("Go ahead.", "Ready to send it?"), so what's said next, until then, is an answer
    /// and doesn't need to start with "Bridge".
    private var invitedUntil = Date.distantPast

    /// Settings > "Read back what I said". On: the relay reads your words back ("Ready to send it?") and waits for a yes.
    /// Off: your words go straight to the agents, so wait for a longer pause before sending.
    static var readBack: Bool {
        get { UserDefaults.standard.object(forKey: "readBack") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "readBack") }
    }
    /// Settings > "Only answer to \"Bridge\"". On: while listening, speech is ignored unless it starts with "Bridge"
    /// (or answers a question Bridge just asked), so talk around you isn't sent to your agents.
    static var wakeWord: Bool {
        get { UserDefaults.standard.object(forKey: "wakeWord") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "wakeWord") }
    }
    /// Settings > "Answer without \"Bridge\"": seconds after Bridge asks something during which the answer needn't start
    /// with "Bridge". Long enough to answer, short enough that later talk around you isn't sent; 0 always needs it.
    static let answerWindows: [TimeInterval] = [0, 10, 20, 30, 60]
    static var answerWindow: TimeInterval {
        get { UserDefaults.standard.object(forKey: "answerWindow") as? TimeInterval ?? 30 }
        set { UserDefaults.standard.set(newValue, forKey: "answerWindow") }
    }
    /// Settings > "Hang up after quiet": seconds of silence before Bridge hangs up; 0 waits for "goodbye".
    static let hangUpChoices: [TimeInterval] = [25, 60, 5 * 60, 15 * 60, 0]
    static var hangUpAfter: TimeInterval {
        get { UserDefaults.standard.object(forKey: "hangUpAfter") as? TimeInterval ?? 25 }
        set { UserDefaults.standard.set(newValue, forKey: "hangUpAfter") }
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
    /// Natural voice: OpenAI text-to-speech from the PC relay (when it has a key), or Amazon Polly from Bridge Cloud
    /// (Bridge Pro). Off by default, so replies are spoken by the phone voice and no text goes out to be spoken.
    /// Except for Bridge Pro users who already heard it on Bridge Cloud before the switch existed: theirs starts on.
    static var naturalVoice: Bool {
        get {
            if let on = UserDefaults.standard.object(forKey: "naturalVoice") as? Bool { return on }
            return UserDefaults.standard.bool(forKey: "naturalVoiceBefore") && Store.shared.isPro
        }
        set { UserDefaults.standard.set(newValue, forKey: "naturalVoice") }
    }
    /// Once, at launch: notes whether this install was already on Bridge Cloud when the switch arrived. Whether it
    /// had Pro then is noted by noteProForNaturalVoice, since StoreKit hasn't answered yet at launch.
    static func noteNaturalVoiceBefore() {
        let d = UserDefaults.standard
        guard d.object(forKey: "naturalVoiceBefore") == nil else { return }
        d.set(d.object(forKey: "naturalVoice") == nil && d.string(forKey: "relayURL") == Relay.cloudAddress, forKey: "naturalVoiceBefore")
    }
    /// Once, on StoreKit's first answer after that: only an install that had Pro then was hearing the natural voice,
    /// so one that buys Pro later starts with it off like everyone else.
    static func noteProForNaturalVoice(_ pro: Bool) {
        let d = UserDefaults.standard
        guard !d.bool(forKey: "naturalVoiceProNoted") else { return }
        d.set(true, forKey: "naturalVoiceProNoted")
        if !pro { d.set(false, forKey: "naturalVoiceBefore") }
    }
    /// True while the session is on A2DP; the next listen switches back to the glasses' mic.
    private var onHiFi = false
    private var micRetries = 0
    /// Switched back from A2DP, but the glasses' HFP link may not be up yet: don't listen on a stale route.
    private var awaitingHFP = false
    /// Between begin and end. A photo answer (look) speaks outside a conversation, on whatever session iOS has.
    private var conversing = false
    private var retry: Task<Void, Never>?

    /// Pause after you stop talking before your turn is sent.
    private var endOfTurn: TimeInterval { Self.readBack ? 1.4 : 2.0 }
    /// While an agent is working, stay on the line at least this long for its answer.
    private let agentHangup: TimeInterval = 15 * 60
    /// Agent messages older than this are not read out when a conversation starts.
    private let maxBacklogAge = 30 * 60

    override init() {
        super.init()
        synth.delegate = self
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            // A route change (e.g. HFP renegotiating 8k↔16k) stops the engine; rebuild the tap on the new format.
            // With read-back on, what was heard so far is read back before anything is sent, so keep it rather
            // than throw it away with a restart. Without read-back it would go out cut short, so restart.
            Task { @MainActor in
                guard let self, self.phase == .listening else { return }
                if !self.heard.isEmpty && Self.readBack { self.finishTurn() } else { self.restartListening() }
            }
        }
    }

    // MARK: lifecycle

    func begin(trigger: Trigger) {
        guard phase == .idle else { return }
        phase = .thinking
        self.trigger = trigger
        micRetries = 0
        onHiFi = false
        awaitingHFP = false
        conversing = true
        invitedUntil = .distantPast   // a window left from the last conversation doesn't carry over
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
            // Answering an agent's call is answering it, whether or not its message ended in a question.
            if trigger == .call { invitedUntil = Date().addingTimeInterval(Self.answerWindow) }
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
            conversing = false
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
        if let hfp = session.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) {
            try session.setPreferredInput(hfp)
            onHiFi = false   // only once the glasses' mic is back, so a failed switch is tried again
            if report { status = "Using \(hfp.portName)" }
        } else if report {
            status = "Glasses mic not found — using phone mic"
        }
    }

    /// Playback only, so iOS routes to the glasses over A2DP. Not in an agent call: CallKit owns that session.
    private func useHiFiOutput() async {
        guard Self.hiFiSpeech, conversing, trigger != .call, !onHiFi else { return }
        // Only with the glasses' mic connected: without it there's nothing to switch back to, and the phone's speaker
        // or mic is already full quality.
        let session = AVAudioSession.sharedInstance()
        guard session.availableInputs?.contains(where: { $0.portType == .bluetoothHFP }) == true else { return }
        do {
            try session.setCategory(.playback, mode: .spokenAudio)
            onHiFi = true
            // setCategory returns before the A2DP stream runs; speaking now would clip a short line.
            await Self.awaitRoute(timeout: 1.5) { route in route.outputs.contains { $0.portType == .bluetoothA2DP } }
        } catch { status = "High-quality speech failed: \(error.localizedDescription)" }
    }

    /// Waits until the current route passes `ready`, checking every 100 ms, or until the timeout.
    private static func awaitRoute(timeout: TimeInterval, _ ready: (AVAudioSessionRouteDescription) -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !ready(AVAudioSession.sharedInstance().currentRoute), Date() < deadline {
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    // MARK: listening

    private func startListening() {
        // A route change (the switch back from A2DP) can restart listening while a retry is queued; never run two.
        stopListening()
        heard = ""
        phase = .listening
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer?.supportsOnDeviceRecognition == true { req.requiresOnDeviceRecognition = true }
        request = req

        if onHiFi {
            var failure: String?
            do { try useGlassesMic(report: false) } catch { failure = error.localizedDescription }
            if !onHiFi { awaitingHFP = true }
            // Still no glasses mic after a few tries (none connected, or it keeps refusing): listen on the phone.
            if onHiFi && micRetries >= 3 {
                onHiFi = false
                status = failure.map { "Glasses mic failed (\($0)) — using phone mic" } ?? "Glasses mic not found — using phone mic"
            }
        }
        // The glasses are listed as an input before their HFP link is up, and until it is the engine reports the
        // old route's format. Listening then would be restarted by the route change just as you start talking.
        if awaitingHFP {
            if AVAudioSession.sharedInstance().currentRoute.inputs.contains(where: { $0.portType == .bluetoothHFP }) || micRetries >= 8 {
                awaitingHFP = false
                micRetries = 0
            } else {
                micRetries += 1
                restartSoon(after: 0.25); return
            }
        }
        let input = engine.inputNode
        // Right after switching back from A2DP the glasses' mic can briefly be missing or have no format; retry soon.
        guard !onHiFi, input.outputFormat(forBus: 0).sampleRate > 0 else {
            micRetries += 1
            if micRetries >= 3 { status = "Mic unavailable, still trying" }
            restartSoon(); return
        }
        micRetries = 0
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak req] buffer, _ in
            req?.append(buffer)
        }
        engine.prepare()
        do { try engine.start() } catch {
            // Often a route still settling (just back from A2DP); retry like the cases above.
            status = "Mic failed: \(error.localizedDescription)"
            micRetries += 1
            restartSoon(); return
        }

        task = recognizer?.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor in
                // Only the current session: a cancelled one still calls back once.
                guard let self, self.phase == .listening, self.request === req else { return }
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

    private func restartSoon(after delay: TimeInterval = 1) {
        stopListening()
        retry = Task {
            try? await Task.sleep(for: .seconds(delay))
            if !Task.isCancelled, phase == .listening { startListening() }
        }
    }

    private func stopListening() {
        retry?.cancel(); retry = nil   // a restart that already happened makes a queued retry stale
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
                guard let self, self.phase == .listening, self.heard.isEmpty, Self.hangUpAfter > 0 else { return }
                let limit = self.awaitingAgent ? max(self.agentHangup, Self.hangUpAfter) : Self.hangUpAfter
                if Date().timeIntervalSince(self.lastActivity) > limit {
                    #if APP_STORE
                    self.end(saying: "I'll hang up. Say Hey Siri, talk to Bridge when you need me.")
                    #else
                    self.end(saying: "I'll hang up. Say Hey Meta, start Bridge when you need me.")
                    #endif
                }
            }
        }
    }

    // MARK: a turn

    private func finishTurn() {
        guard phase == .listening else { return }
        let raw = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        stopListening()   // never listen while speaking, or the recognizer hears the reply
        guard !raw.isEmpty else { startListening(); return }
        let invited = Date() < invitedUntil
        invitedUntil = .distantPast
        var said = raw
        if Self.wakeWord, !invited {
            // Not for Bridge: drop it without a word, and don't count it as activity, so talk around you neither
            // reaches the agents nor keeps the line open.
            guard let rest = Self.afterWakeWord(raw) else {
                status = "Ignored: start with \"Bridge\""
                startListening(); return
            }
            said = rest
        } else if Self.wakeWord, let rest = Self.afterWakeWord(raw, answering: true) {
            said = rest   // "Bridge, yes" as an answer; but "Bridge the gap..." is the answer itself
        }
        lastActivity = Date()
        // Just "Bridge": ask, and take the next thing said without the wake word.
        guard !said.isEmpty || !Self.wakeWord else {
            Task {
                await say("Yes?")
                startListening()
            }
            return
        }
        let text = said
        transcript.append(("You", text))

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

    /// "Bridge, what's the status?" → "what's the status?"; nil when no sentence starts with "Bridge" (or "Hey Bridge").
    /// Talk just before it in the same breath is dropped ("...see you then. Bridge, what's new?" → "what's new?"),
    /// but "the bridge was closed" is not a call. Tolerates the recognizer's punctuation and capitals; just "Bridge" gives "".
    /// `answering`: only a leading "Bridge," set off by punctuation, so an answer like "Bridge the gap" is kept whole.
    nonisolated static func afterWakeWord(_ text: String, answering: Bool = false) -> String? {
        let pattern = try! NSRegularExpression(pattern: answering ? #"^\W*(?:(?:hey|ok|okay)\W+)?bridge(?:[,.!?:;]+\s*|\s*$)"#
                                                                  : #"(?:^|[.!?]\s+)\W*(?:(?:hey|ok|okay)\W+)?bridge\b\W*"#,
                                               options: [.caseInsensitive])
        guard let m = pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).first,
              let r = Range(m.range, in: text) else { return nil }
        return String(text[r.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
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
        // A question invites an answer without "Bridge", from when it's finished being said. Anything else leaves an
        // earlier invitation alone: an agent's message read out after "Ready to send it?" mustn't eat your "yes".
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let invites = line.hasSuffix("?") || line == "Go ahead."
        defer { if invites { invitedUntil = Date().addingTimeInterval(Self.answerWindow) } }
        await useHiFiOutput()
        // The natural voice when it's turned on in Settings: from the relay when it has a key, or from Bridge Cloud with
        // Bridge Pro; otherwise (or on any failure) the phone's voice. Without Pro the cloud would refuse, so don't wait for it to.
        if Self.naturalVoice, !Relay.shared.isCloud || Store.shared.isPro,
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
