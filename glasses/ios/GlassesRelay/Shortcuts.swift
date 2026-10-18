import AppIntents

/// Shortcuts and Siri actions. They show up in the Shortcuts app under Bridge, and work with
/// "Hey Siri, talk to Bridge", the Action Button, and automations.

struct TalkToBridge: AppIntent {
    static let title: LocalizedStringResource = "Talk to Bridge"
    static let description = IntentDescription("Start a hands-free conversation with your Claude agents through your glasses.")
    static let openAppWhenRun = true   // the conversation needs the app's audio session

    @MainActor func perform() async throws -> some IntentResult {
        GlassesController.shared.conversation.begin(trigger: .glasses)
        return .result()
    }
}

struct AskBridge: AppIntent {
    static let title: LocalizedStringResource = "Ask Bridge"
    static let description = IntentDescription(
        "Send a message to your PC relay and get its reply, with the same read-back as the glasses. Start with \"in <project>,\" to begin a task, then send \"yes\" when it asks \"Ready to send it?\"")

    @Parameter(title: "Message", requestValueDialog: "What should I send?")
    var message: String

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        try await Store.shared.requirePro()
        let reply = try await Relay.shared.say(Conversation.forRelay(message))
        return .result(value: reply, dialog: "\(reply)")
    }
}

struct LookWithBridge: AppIntent {
    static let title: LocalizedStringResource = "Look with Bridge"
    static let description = IntentDescription(
        "Take a photo with your glasses and hear what Claude sees. Start with \"send this to <project>\" to give it to an agent.")
    static let openAppWhenRun = true   // the glasses camera is reached through the running app

    @Parameter(title: "Question", default: "What am I looking at?")
    var question: String

    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let jpeg = try await GlassesController.shared.capturePhoto()
        let reply = try await Relay.shared.photo(jpeg, said: question)
        return .result(value: reply, dialog: "\(reply)")
    }
}

struct BridgeShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: TalkToBridge(),
                    phrases: ["Talk to \(.applicationName)", "Start \(.applicationName)"],
                    shortTitle: "Talk", systemImageName: "waveform")
        AppShortcut(intent: AskBridge(),
                    phrases: ["Ask \(.applicationName)", "Send to \(.applicationName)"],
                    shortTitle: "Ask", systemImageName: "text.bubble")
        AppShortcut(intent: LookWithBridge(),
                    phrases: ["Look with \(.applicationName)", "What am I looking at with \(.applicationName)"],
                    shortTitle: "Look", systemImageName: "camera")
    }
}
