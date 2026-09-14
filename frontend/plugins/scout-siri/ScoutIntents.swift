// ScoutIntents.swift — "Hey Siri, ask Scout …" → Convoy's agentic voice endpoint.
//
// Injected into the main app target by plugins/withScoutSiri.js at prebuild.
// In-app App Intents (iOS 16+): no extension target needed. Siri collects the
// spoken question, we POST it to /api/voice/agent with the user's stored JWT,
// and Siri SPEAKS the agent's reply — which is how the steering-wheel voice
// button reaches Scout (the wheel button always summons Siri; this is the
// sanctioned hand-off). Client actions (navigate etc.) are Phase 2 — v1 runs none of them.
//
// ── BUILD 79 (2026-09-14): NO REPLY SENDS THE DRIVER TO THE PHONE, AND EVERY RUN LEAVES A RECEIPT ──
// This intent is the only way to reach Scout from the car today, so its replies are car copy.
// Two replies broke the CarPlay Developer Guide p.4, guideline 2 ("Never instruct people to pick up
// their iPhone to perform a task … alerts or messages must not include wording that asks people to
// manipulate their iPhone"): the no-token reply told the driver to open the app and sign in, and the
// actions reply told them to open the app to see the map — which also claimed an action this v1
// intent never runs. Both now state the condition only; scripts/trap-check.py rule
// car-copy-sends-driver-to-the-phone keeps the old wording out. ⚠ PROVISIONAL COPY — Jeff's OK.
// Receipt: ScoutSiriAgent.note writes convoy.siri.scout.v1 to the App Group; the next app launch
// reports it as a `siri-scout n= ok= http= why= prot=` row (src/crashBreadcrumb.ts reportSiriScout).

import AppIntents
import Foundation
import UIKit

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

    // Same App Group + read-once pattern as the CarPlay host markers (plugins/withConvoyCarPlay.js
    // DIAG_SUITE). `n` counts runs since JS last cleared the marker, so one row can stand for several.
    static let diagSuite = "group.com.sw0rdfisch.convoy"
    static let diagKey = "convoy.siri.scout.v1"
    static func note(ok: Bool, http: Int, why: String, prot: Bool) {
        let defaults = UserDefaults(suiteName: diagSuite)
        var n = 1
        if let prev = defaults?.string(forKey: diagKey), let data = prev.data(using: .utf8),
           let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let pn = o["n"] as? Int {
            n = pn + 1
        }
        let obj: [String: Any] = ["ts": Date().timeIntervalSince1970 * 1000, "n": n, "ok": ok, "http": http, "why": why, "prot": prot ? 1 : 0]
        if let data = try? JSONSerialization.data(withJSONObject: obj), let json = String(data: data, encoding: .utf8) {
            defaults?.set(json, forKey: diagKey)
        }
    }

    static func ask(question: String) async -> String {
        // false = protected data unavailable: the phone is locked with a passcode. ALWAYS true on a
        // phone with no passcode ("if content protection is not enabled" — UIKit docs), so prot=1
        // never proves the phone was unlocked.
        let prot = await MainActor.run { UIApplication.shared.isProtectedDataAvailable }
        guard let token = readToken() else {
            // readToken() folds "signed out" and "the AsyncStorage manifest is unreadable" into nil.
            // With protected data unavailable the manifest may simply be locked, so don't tell a
            // signed-in driver they are signed out (review correction 8, 2026-09-14).
            note(ok: false, http: -1, why: prot ? "no-token" : "locked", prot: prot)
            return prot
                ? "You're not signed in to Hairpin yet, so Scout can't answer."
                : "Your Hairpin account isn't available yet, so Scout can't answer."
        }
        guard let url = URL(string: apiBase + "/voice/agent") else {
            note(ok: false, http: -2, why: "url", prot: prot)
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
                note(ok: false, http: (resp as? HTTPURLResponse)?.statusCode ?? -3, why: "http", prot: prot)
                return "Scout couldn't reach the convoy service right now — try again in a moment."
            }
            if let speech = obj["speech"] as? String, !speech.isEmpty {
                note(ok: true, http: http.statusCode, why: "speech", prot: prot)
                return speech
            }
            if let actions = obj["actions"] as? [[String: Any]], !actions.isEmpty {
                note(ok: true, http: http.statusCode, why: "actions", prot: prot)
                // v1 runs no client action (header), so do not claim one happened.
                return "Scout can't do that from Siri yet."
            }
            note(ok: true, http: http.statusCode, why: "empty", prot: prot)
            return "Scout heard you, but didn't have an answer for that."
        } catch {
            note(ok: false, http: -4, why: "net", prot: prot)
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
