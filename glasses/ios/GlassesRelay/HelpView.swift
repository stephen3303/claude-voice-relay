import SwiftUI

/// How to use Bridge, opened from the main screen's question mark.
struct HelpView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Getting started") {
                    HelpItem("1. Connect your glasses", "In Settings, tap Connect to Meta AI and approve Bridge in the Meta AI app. Then tap Allow camera if you want photos.")
                    #if APP_STORE
                    HelpItem("2. Choose a connection", "Sign in with Apple to use Bridge Cloud, or connect your own PC running the Bridge relay. Demo gives sample replies so you can try it first.")
                    #else
                    HelpItem("2. Connect your PC", "In Settings, choose My PC and enter your relay's address and VOICE_TOKEN, then tap Save and test. Demo gives sample replies so you can try it first.")
                    #endif
                    HelpItem("3. Start talking", "Say \"Hey Meta, start Bridge\", or tap Talk. Bridge says \"Go ahead\" when it's listening.")
                }
                Section("Talking to your agents") {
                    HelpItem("Start a task", "Begin with \"in\" and the project's name: \"In trading bot, add a stop-loss check.\"")
                    HelpItem("Read-back", "With Read back on, Bridge reads your message back like Siri does: \"Here's your message to Claude: ... Ready to send it?\" Say \"send\" or \"yes\" to send it, \"change it\" to say it differently, or \"cancel\" or \"no\". Nothing is sent until you say yes. Turn it off in Settings to send after a 2-second pause instead.")
                    HelpItem("Answers", "While a conversation is open, your agents' replies are read to you as they arrive. Answer a yes-or-no question with \"yes\".")
                    #if APP_STORE
                    HelpItem("Calls from your agents", "With Bridge Cloud, an agent that has something for you rings like a phone call when glasses or headphones are connected. Answer it to hear the message and reply. Otherwise you get a notification. Turn it off in Settings > Calls.")
                    #endif
                    HelpItem("Finish", "Say \"goodbye\" or \"hang up\". Bridge also hangs up after a quiet spell, and waits longer while an agent is working.")
                }
                Section("Photos (Bridge Pro)") {
                    HelpItem("Ask about what you see", "Say \"What am I looking at?\" or \"Look at this, what does the error say?\", or tap Look.")
                    HelpItem("Give a photo to an agent", "Say \"Send this to trading bot, fix this error.\"")
                    HelpItem("Privacy", "Photos are only taken when you ask, and are deleted once they're answered.")
                }
                Section("Siri and Shortcuts") {
                    HelpItem("Siri", "Say \"Hey Siri, talk to Bridge\" to start a conversation without the glasses.")
                    HelpItem("Shortcuts", "Talk, Ask and Look are in the Shortcuts app under Bridge. Use them with the Action button or automations.")
                }
                Section("If something isn't working") {
                    HelpItem("Bridge can't hear you", "Make sure the glasses are connected to your phone over Bluetooth. Bridge uses the glasses microphone when it can, and the phone's otherwise.")
                    HelpItem("\"Couldn't reach your PC\"", "Check that the relay is running and that your phone is on the same Tailscale network. Then use Save and test in Settings.")
                    HelpItem("Photos don't work", "In Settings, tap Allow camera, then Test photo. The glasses must be on and nearby.")
                    Link("More help on the website", destination: URL(string: "https://stephen3303.github.io/claude-voice-relay/support.html")!)
                }
            }
            .navigationTitle("Help")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

private struct HelpItem: View {
    let title: String, text: String
    init(_ title: String, _ text: String) { self.title = title; self.text = text }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.headline)
            Text(text).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}
