import SwiftUI

/// How to use Bridge, opened from the main screen's question mark.
struct HelpView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Getting started") {
                    #if APP_STORE
                    // No glasses toolkit in this build (appstore.yml), so it starts at signing in.
                    HelpItem("1. Sign in", "In Settings, sign in with Apple. Your agents run in Bridge Cloud, so there's nothing else to set up. Demo gives sample replies so you can try it first.")
                    HelpItem("2. Start talking", "Tap Talk, say \"Hey Siri, talk to Bridge\", or use the Action Button. Bridge says \"Go ahead\" when it's listening. AirPods or any Bluetooth headset keep your hands free.")
                    #else
                    HelpItem("1. Connect your glasses", "In Settings, tap Connect to Meta AI and approve Bridge in the Meta AI app. Then tap Allow camera if you want photos.")
                    HelpItem("2. Connect your PC", "In Settings, choose My PC and enter your relay's address and VOICE_TOKEN, then tap Save and test. Demo gives sample replies so you can try it first.")
                    HelpItem("3. Start talking", "Say \"Hey Meta, start Bridge\", or tap Talk. Bridge says \"Go ahead\" when it's listening.")
                    #endif
                }
                Section("Talking to your agents") {
                    HelpItem("Say \"Bridge\" first", "While Bridge is listening, start what you say with \"Bridge\": \"Bridge, what's the status?\" Anything else is ignored, so people talking around you aren't sent to your agents. Right after Bridge says \"Go ahead\" or asks you something, just answer (Settings > Voice sets how long you have, or turns this off). Say \"Bridge\" on its own and it asks \"Yes?\"")
                    HelpItem("Start a task", "Begin with \"in\" and the project's name: \"Bridge, in trading bot, add a stop-loss check.\"")
                    HelpItem("Read-back", "With Read back on, Bridge reads your message back like Siri does: \"Here's your message to Claude for trading bot, ... Ready to send it?\" Say \"send\" or \"yes\" to send it, \"change it\" to say it differently, or \"cancel\" or \"no\". Nothing is sent until you say yes. Turn it off in Settings to send after a 2-second pause instead.")
                    HelpItem("Answers", "While a conversation is open, your agents' replies are read to you as they arrive. Answer a yes-or-no question with \"yes\".")
                    #if APP_STORE
                    HelpItem("Calls from your agents", "With Bridge Cloud, an agent that has something for you rings like a phone call when headphones are connected. Answer it to hear the message and reply. Otherwise you get a notification. Turn it off in Settings > Calls.")
                    #endif
                    HelpItem("Finish", "Say \"Bridge, goodbye\" or \"Bridge, hang up\" (just \"goodbye\" works if \"Only answer to Bridge\" is off). Bridge also hangs up after a quiet spell (set how long, or Never, in Settings > Voice), and waits longer while an agent is working.")
                }
                #if !APP_STORE
                Section("Photos (Bridge Pro)") {
                    HelpItem("Ask about what you see", "Say \"Bridge, what am I looking at?\" or \"Bridge, look at this, what does the error say?\", or tap Look.")
                    HelpItem("Give a photo to an agent", "Say \"Bridge, send this to trading bot, fix this error.\"")
                    HelpItem("Privacy", "Photos are only taken when you ask, and are deleted once they're answered.")
                }
                #endif
                Section("Siri and Shortcuts") {
                    #if APP_STORE
                    HelpItem("Siri", "Say \"Hey Siri, talk to Bridge\" to start a conversation.")
                    HelpItem("Shortcuts", "Talk and Ask are in the Shortcuts app under Bridge. Use them with the Action button or automations.")
                    #else
                    HelpItem("Siri", "Say \"Hey Siri, talk to Bridge\" to start a conversation without the glasses.")
                    HelpItem("Shortcuts", "Talk, Ask and Look are in the Shortcuts app under Bridge. Use them with the Action button or automations.")
                    #endif
                }
                Section("If something isn't working") {
                    #if APP_STORE
                    HelpItem("Bridge can't hear you", "Make sure your headset is connected to your phone over Bluetooth. Bridge uses its microphone when it can, and the phone's otherwise.")
                    #else
                    HelpItem("Bridge can't hear you", "Make sure the glasses are connected to your phone over Bluetooth. Bridge uses the glasses microphone when it can, and the phone's otherwise.")
                    #endif
                    #if APP_STORE
                    HelpItem("Bridge can't reach Bridge Cloud", "Check that your phone is online and you're signed in. Then tap Test in Settings, under Connection.")
                    #else
                    HelpItem("\"Couldn't reach your PC\"", "Check that the relay is running and that your phone is on the same Tailscale network. Then use Save and test in Settings.")
                    #endif
                    #if !APP_STORE
                    HelpItem("Photos don't work", "In Settings, tap Allow camera, then Test photo. The glasses must be on and nearby.")
                    #endif
                    #if APP_STORE
                    Link("More help on the website", destination: URL(string: "https://talktobridge.com/support.html")!)
                    #else
                    Link("More help on GitHub", destination: URL(string: "https://github.com/stephen3303/bridge-relay#readme")!)
                    #endif
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
