// ScoutIntents.swift — "Hey Siri, ask Scout …" → Convoy's agentic voice endpoint.
//
// Injected into the main app target by plugins/withScoutSiri.js at prebuild.
// In-app App Intents (iOS 16+): no extension target needed. Siri collects the
// spoken question, we POST it to /api/voice/agent with the user's stored JWT,
// and Siri SPEAKS the agent's reply — which is how the steering-wheel voice
// button reaches Scout (the wheel button always summons Siri; this is the
// sanctioned hand-off). Client actions (navigate etc.) are Phase 2 — v1 tells
// the driver to open Convoy when the agent queued one.

import AppIntents
import Foundation

@available(iOS 16.0, *)
struct AskScoutIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Scout"
    static var description = IntentDescription(
        "Ask Convoy's Scout co-driver anything — convoy status, nearby hazards, or the road ahead."
    )
    // Run in-process without foregrounding the app; Siri voices the reply.
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Question", requestValueDialog: "What would you like to ask Scout?")
    var question: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Scout \(\.$question)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let speech = await ScoutSiriAgent.ask(question: question)
        return .result(dialog: IntentDialog(stringLiteral: speech))
    }
}

@available(iOS 16.0, *)
struct ConvoyAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskScoutIntent(),
            phrases: [
                "Ask Scout in \(.applicationName)",
                "Ask \(.applicationName) Scout",
                "Talk to Scout in \(.applicationName)",
            ],
            shortTitle: "Ask Scout",
            systemImageName: "mic.fill"
        )
    }
}

enum ScoutSiriAgent {
    // Mirrors src/api.ts: EXPO_PUBLIC_BACKEND_URL fallback (intentionally
    // hardcoded there too) + the /api prefix.
    static let apiBase = "https://convoy-backend-j9q1.onrender.com/api"

    static func ask(question: String) async -> String {
        guard let token = readToken() else {
            return "Open Convoy and sign in first — then I can help from here."
        }
        guard let url = URL(string: apiBase + "/voice/agent") else {
            return "Something went wrong reaching Convoy."
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // The Render backend cold-sleeps; give it room to wake + run the agent.
        req.timeoutInterval = 55
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": question])
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return "Scout couldn't reach the convoy service right now — try again in a moment."
            }
            if let speech = obj["speech"] as? String, !speech.isEmpty {
                return speech
            }
            if let actions = obj["actions"] as? [[String: Any]], !actions.isEmpty {
                return "Done — open Convoy to see it on the map."
            }
            return "Scout heard you, but didn't have an answer for that."
        } catch {
            return "Scout couldn't reach the convoy service right now — try again in a moment."
        }
    }

    // The RN app keeps its JWT in AsyncStorage under "convoy_token" (src/api.ts).
    // Small AsyncStorage values live inline in RCTAsyncLocalStorage_V1/manifest.json
    // under Application Support — readable here without any RN bridge.
    static func readToken() -> String? {
        let fm = FileManager.default
        guard let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        var candidates = [appSupport.appendingPathComponent("RCTAsyncLocalStorage_V1/manifest.json")]
        if let bundleId = Bundle.main.bundleIdentifier {
            candidates.append(
                appSupport.appendingPathComponent(bundleId).appendingPathComponent("RCTAsyncLocalStorage_V1/manifest.json")
            )
        }
        for url in candidates {
            if let data = try? Data(contentsOf: url),
               let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
               let tok = json["convoy_token"], !tok.isEmpty {
                return tok
            }
        }
        return nil
    }
}
