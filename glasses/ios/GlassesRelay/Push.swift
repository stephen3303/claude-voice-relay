// App Store build only: agent calls and notifications come from Bridge Cloud (not in the public relay repo).
#if APP_STORE
import AVFoundation
import CallKit
import PushKit
import UIKit
import UserNotifications

/// How an agent starts a conversation (cloud/api/push.mjs). Signed in to Bridge Cloud, the app gives
/// the cloud two push tokens and keeps it told whether headphones or glasses are connected:
/// - with a headset connected and calls allowed, the agent's message arrives as an incoming call
///   (VoIP push, CallKit). Answering it, on the lock screen or with a tap on the glasses or AirPods,
///   opens a conversation that reads the message aloud.
/// - otherwise it's a notification. Tapping it (or Talk) opens Bridge and starts the conversation;
///   if Bridge is already open and a headset is connected, the conversation starts by itself.
@MainActor
final class Push: NSObject, ObservableObject {
    static let shared = Push()

    /// Settings > "Agents can call me". Off: agents' messages come as notifications only.
    @Published var callsAllowed = UserDefaults.standard.object(forKey: "agentCalls") as? Bool ?? true {
        didSet { UserDefaults.standard.set(callsAllowed, forKey: "agentCalls"); upload() }
    }
    @Published var status = ""

    static let category = "AGENT_MESSAGE"
    private static let talkAction = "TALK"

    private let voip = PKPushRegistry(queue: .main)
    private let provider: CXProvider
    private let callController = CXCallController()
    private var token: String?
    private var voipToken: String?
    /// What the cloud last accepted, so route changes that change nothing send nothing.
    private var lastUpload: String? {
        get { UserDefaults.standard.string(forKey: "pushUploaded") }
        set { UserDefaults.standard.set(newValue, forKey: "pushUploaded") }
    }
    /// The agent call in progress, if any, whether it was answered, and what it carries (shown as a
    /// notification if nobody answers).
    private var call: UUID?
    private var answered = false
    private var ringing: (from: String, text: String)?
    /// An unanswered call rings this long, then becomes a notification.
    private static let ringTimeout: TimeInterval = 30
    private var uploading = false
    private var uploadAgain = false
    private var started = false

    /// Identifies this phone to the cloud, so a reinstall or a second phone gets its own entry.
    private static let deviceID: String = {
        if let id = UserDefaults.standard.string(forKey: "pushDevice") { return id }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: "pushDevice")
        return id
    }()

    private override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = false
        provider = CXProvider(configuration: config)
        super.init()
    }

    /// At launch, from the app delegate: iOS only delivers VoIP pushes to an app that sets up
    /// PushKit every time it starts.
    func start() {
        guard !started else { return }
        started = true
        provider.setDelegate(self, queue: .main)
        voip.delegate = self
        voip.desiredPushTypes = [.voIP]
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories([UNNotificationCategory(
            identifier: Self.category,
            actions: [UNNotificationAction(identifier: Self.talkAction, title: "Talk", options: [.foreground])],
            intentIdentifiers: [])])
        // Glasses or AirPods connecting or going away changes whether the agent should call or notify.
        NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in Push.shared.upload() }
        }
        refresh()
    }

    /// Ask for notifications and a token once signed in to Bridge Cloud, then tell the cloud.
    func refresh() {
        guard Account.shared.signedIn, Relay.shared.isCloud else { upload(); return }
        Task {
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
            if !granted { status = "Notifications are off for Bridge. Turn them on in Settings to hear from agents." }
            UIApplication.shared.registerForRemoteNotifications()
        }
        upload()
    }

    func gotToken(_ data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        upload()
    }

    /// Headphones, glasses or a car: somewhere a call can be answered without the phone in hand.
    static var headsetConnected: Bool {
        let handsFree: Set<AVAudioSession.Port> = [.bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .headphones, .headsetMic, .carAudio]
        let session = AVAudioSession.sharedInstance()
        return session.currentRoute.outputs.contains { handsFree.contains($0.portType) }
            || (session.availableInputs ?? []).contains { handsFree.contains($0.portType) }
    }

    /// Sends this phone's tokens and headset state to the cloud when they change; removes the phone
    /// when not using Bridge Cloud. One request at a time, always for the latest state, so a register
    /// and an unregister can't arrive out of order.
    func upload() {
        uploadAgain = true
        guard !uploading else { return }
        uploading = true
        Task {
            defer { uploading = false }
            while uploadAgain {
                uploadAgain = false
                guard let session = Keychain.read(Account.sessionKey) else { return }
                let using = Account.shared.signedIn && Relay.shared.isCloud
                // Signed in but the tokens haven't arrived yet (every launch): wait for them, don't unregister.
                if using && token == nil && voipToken == nil { continue }
                let headset = Self.headsetConnected
                let key = using ? "\(token ?? "")|\(voipToken ?? "")|\(headset)|\(callsAllowed)" : "off"
                // nil: never registered (a failure leaves it as it was), so there's nothing to remove.
                if key == lastUpload || (key == "off" && lastUpload == nil) { continue }
                do {
                    if using {
                        var body: [String: Any] = ["device": Self.deviceID, "headset": headset, "calls": callsAllowed]
                        #if APP_STORE
                        body["env"] = "production"   // TestFlight and the App Store; the cloud retries the other if wrong
                        #else
                        body["env"] = "sandbox"
                        #endif
                        if let token { body["token"] = token }
                        if let voipToken { body["voipToken"] = voipToken }
                        try await Self.cloud("POST", "api/push/register", session: session, body: body)
                    } else {
                        try await Self.cloud("DELETE", "api/push/register?device=\(Self.deviceID)", session: session)
                    }
                    lastUpload = key
                } catch {
                    // Left as it was, so the next change or launch tries again.
                    status = "Couldn't reach Bridge Cloud for calls: \(error.localizedDescription)"
                    ErrorReporting.report(error, "push register")
                    return
                }
            }
        }
    }

    /// Signing out: the phone stops getting this account's calls.
    func unregister(session: String) {
        lastUpload = nil
        Task { try? await Self.cloud("DELETE", "api/push/register?device=\(Self.deviceID)", session: session) }
    }

    /// The Test call button: the cloud waits ten seconds (time to lock the phone), then rings like an agent.
    func testCall() async {
        guard let session = Keychain.read(Account.sessionKey) else { status = "Sign in to Bridge Cloud first."; return }
        lastUpload = nil
        upload()
        status = Self.headsetConnected && callsAllowed
            ? "Calling in 10 seconds. Lock your phone if you like."
            : "Sending a notification in 10 seconds. Connect glasses or headphones to get a call instead."
        do { try await Self.cloud("POST", "api/push/test", session: session, body: ["delay": 10], timeout: 30) }
        catch { status = "Test call failed: \(error.localizedDescription)"; ErrorReporting.report(error, "test call") }
    }

    private static func cloud(_ method: String, _ path: String, session: String, body: [String: Any]? = nil, timeout: TimeInterval = 15) async throws {
        do { try await Relay.shared.cloud(method, path, session: session, body: body, timeout: timeout) }
        catch Relay.Failure.http(401) {
            // The session is no longer valid: sign out, as Account does, rather than keep failing.
            if Keychain.read(Account.sessionKey) == session { Account.shared.signOut() }
            throw Relay.Failure.http(401)
        }
    }

    // MARK: agent calls

    /// Every VoIP push must become a reported call, or iOS stops delivering them. So a call that
    /// can't be taken (no headset, calls off, or already talking) is reported and ended at once.
    private func incoming(from: String, text: String, completion: @escaping () -> Void) {
        let id = UUID()
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: from)
        update.localizedCallerName = from == "Bridge" ? "Bridge" : "Bridge: \(from)"
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false

        // A stale registration can outlive signing out (the unregister needs a valid session): ring nothing then.
        let signedIn = Account.shared.signedIn && Relay.shared.isCloud
        let talking = (call != nil && answered) || GlassesController.shared.conversation.phase != .idle
        let canTake = signedIn && !talking && call == nil && callsAllowed && Self.headsetConnected
        if canTake { call = id; answered = false; ringing = (from, text) }
        provider.reportNewIncomingCall(with: id, update: update) { error in
            Task { @MainActor in
                if error != nil {
                    if self.call == id { self.clearCall() }
                    if signedIn { self.notifyLocally(from: from, text: text) }
                } else if !canTake {
                    // Talking: the open conversation reads the message. Otherwise leave it as a notification.
                    self.provider.reportCall(with: id, endedAt: nil, reason: talking ? .answeredElsewhere : .unanswered)
                    if signedIn && !talking { self.notifyLocally(from: from, text: text) }
                } else {
                    try? await Task.sleep(for: .seconds(Self.ringTimeout))
                    if self.call == id && !self.answered {
                        self.provider.reportCall(with: id, endedAt: nil, reason: .unanswered)
                        self.missed()
                    }
                }
                if !canTake && signedIn { self.upload() }   // the cloud had a stale headset state
            }
            completion()
        }
    }

    /// Declined or not answered: the message shouldn't vanish, so it becomes a notification.
    private func missed() {
        if let ringing { notifyLocally(from: ringing.from, text: ringing.text) }
        clearCall()
    }

    private func clearCall() {
        call = nil
        answered = false
        ringing = nil
    }

    private func notifyLocally(from: String, text: String) {
        let content = UNMutableNotificationContent()
        content.title = from
        content.body = text
        content.sound = .default
        content.categoryIdentifier = Self.category
        content.interruptionLevel = .timeSensitive
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    /// The conversation ended (goodbye, or it hung up on silence): hang up the call too.
    private func conversationEnded() {
        guard let id = call else { return }
        clearCall()
        callController.request(CXTransaction(action: CXEndCallAction(call: id))) { _ in }
    }

    /// Notification tapped, or Bridge open with a headset when one arrives.
    private func startConversation() {
        let conversation = GlassesController.shared.conversation
        guard conversation.phase == .idle, call == nil else { return }
        conversation.begin(trigger: .button)
    }
}

extension Push: PKPushRegistryDelegate {
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        let hex = credentials.token.map { String(format: "%02x", $0) }.joined()
        MainActor.assumeIsolated {   // PushKit calls back on the main queue (PKPushRegistry(queue: .main))
            voipToken = hex
            upload()
        }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        MainActor.assumeIsolated {
            voipToken = nil
            upload()
        }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                                  for type: PKPushType, completion: @escaping () -> Void) {
        let from = payload.dictionaryPayload["from"] as? String ?? "Bridge"
        let text = payload.dictionaryPayload["text"] as? String ?? "An agent wants to talk."
        MainActor.assumeIsolated { incoming(from: from, text: text, completion: completion) }
    }
}

extension Push: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        MainActor.assumeIsolated {
            clearCall()
            GlassesController.shared.conversation.end(saying: nil)
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        MainActor.assumeIsolated {
            // Set the category before CallKit activates the session, so the glasses' mic (HFP) is in the route.
            try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
            if action.callUUID == call { answered = true }
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated {
            let conversation = GlassesController.shared.conversation
            conversation.onEnded = { [weak self] in self?.conversationEnded() }
            conversation.begin(trigger: .call)
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        MainActor.assumeIsolated {
            // Hung up from the call screen or the headset. If the conversation ended first, it's already idle.
            let wasOurs = call == action.callUUID
            if wasOurs { if answered { clearCall() } else { missed() } }   // declined: keep the message
            let conversation = GlassesController.shared.conversation
            if wasOurs, conversation.phase != .idle { conversation.end(saying: nil) }
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {}
}

extension Push: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let isAgent = notification.request.content.categoryIdentifier == Push.category
        Task { @MainActor in
            // Bridge is open and a headset is connected: just start talking instead of showing a banner.
            if isAgent, Push.headsetConnected, GlassesController.shared.conversation.phase == .idle {
                self.startConversation()
                completionHandler([])
            } else {
                completionHandler(isAgent && GlassesController.shared.conversation.phase != .idle ? [] : [.banner, .sound, .list])
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let open = response.notification.request.content.categoryIdentifier == Push.category
            && [UNNotificationDefaultActionIdentifier, Push.talkAction].contains(response.actionIdentifier)
        Task { @MainActor in
            if open { self.startConversation() }
            completionHandler()
        }
    }
}

/// Push tokens arrive through the app delegate, which SwiftUI apps only get by adopting one.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Push.shared.start()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Push.shared.gotToken(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Push.shared.status = "Notifications unavailable: \(error.localizedDescription)"
    }
}
#endif
