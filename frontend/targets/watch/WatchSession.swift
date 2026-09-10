// targets/watch/WatchSession.swift
import Foundation
import WatchConnectivity
import WatchKit

// Receives the phone's state and tap commands. NO distance or speed comparison lives here —
// the phone decides (src/watchTaps.ts); this plays the haptic it is told to play.
final class WatchSession: NSObject, WCSessionDelegate {
  private let store: WatchStore
  init(store: WatchStore) {
    self.store = store
    super.init()
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    DispatchQueue.main.async { self.store.linkOk = activationState == .activated }
    if let json = session.receivedApplicationContext["json"] as? String {
      applyAndReportFailure(json: json)
    }
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    if let json = applicationContext["json"] as? String { applyAndReportFailure(json: json) }
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    guard let json = message["json"] as? String, let d = json.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
    if let tap = obj["tap"] as? String {
      let side = (obj["side"] as? String) ?? "generic"
      play(tap: tap, side: side)
    } else {
      applyAndReportFailure(json: json)
    }
  }

  // Applies on main (WatchStore's @Published writes expect it) and, on a decode failure,
  // tells the phone so it isn't silently stuck showing stale/no data.
  private func applyAndReportFailure(json: String) {
    DispatchQueue.main.async {
      let ok = self.store.apply(json: json)
      if !ok, WCSession.default.isReachable {
        WCSession.default.sendMessage(["json": "{\"err\":\"decode\"}"], replyHandler: nil, errorHandler: nil)
      }
    }
  }

  private func play(tap: String, side: String) {
    let type: WKHapticType
    switch side {
    case "left": type = .navigationLeftTurn
    case "right": type = .navigationRightTurn
    default: type = .navigationGenericManeuver
    }
    DispatchQueue.main.async { WKInterfaceDevice.current().play(type) }
    if tap == "now" {   // the at-the-turn tap is doubled so it reads differently from the heads-up
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { WKInterfaceDevice.current().play(type) }
    }
  }
}
