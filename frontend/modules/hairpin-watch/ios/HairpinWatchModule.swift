import ExpoModulesCore
import WatchConnectivity

// Hairpin Apple Watch link (build 77) — the phone's ONE WCSession owner.
//
// The watch is a companion: the phone runs the drive and pushes state here; the watch only
// draws and plays. Two channels: updateApplicationContext (latest state, delivered whenever
// the watch app next runs — cheap, last-writer-wins) and sendMessage (live, only while the
// watch app is reachable). PTT comes BACK as a file (transferFile) — the file is only valid
// inside the delegate callback, so it is copied to tmp before JS hears about it.
//
// NOTE: Expo's `Module` is not an NSObject, so the delegate lives in an NSObject helper
// (same trap as HairpinSystemModule's CLLocationManagerDelegate).
public class HairpinWatchModule: Module {
  private var delegate: HairpinWatchDelegate?

  private func state() -> [String: Any] {
    guard WCSession.isSupported() else {
      return ["supported": false, "paired": false, "appInstalled": false, "reachable": false, "activation": 0]
    }
    let s = WCSession.default
    return ["supported": true, "paired": s.isPaired, "appInstalled": s.isWatchAppInstalled,
            "reachable": s.isReachable, "activation": s.activationState.rawValue]
  }

  public func definition() -> ModuleDefinition {
    Name("HairpinWatch")
    Events("onWatchState", "onWatchFile", "onWatchMessage")

    OnCreate {
      guard WCSession.isSupported() else { return }
      let d = HairpinWatchDelegate()
      d.onChange = { [weak self] in
        guard let self = self else { return }
        self.sendEvent("onWatchState", self.state())
      }
      d.onFile = { [weak self] payload in self?.sendEvent("onWatchFile", payload) }
      d.onMessage = { [weak self] json in self?.sendEvent("onWatchMessage", ["json": json]) }
      self.delegate = d
      WCSession.default.delegate = d
      WCSession.default.activate()
    }

    Function("getState") { () -> [String: Any] in self.state() }

    Function("updateContext") { (json: String) -> Bool in
      guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return false }
      do { try WCSession.default.updateApplicationContext(["json": json]); return true } catch { return false }
    }

    Function("sendMessage") { (json: String) -> Bool in
      guard WCSession.isSupported(), WCSession.default.isReachable else { return false }
      WCSession.default.sendMessage(["json": json], replyHandler: nil, errorHandler: nil)
      return true
    }
  }
}

final class HairpinWatchDelegate: NSObject, WCSessionDelegate {
  var onChange: (() -> Void)?
  var onFile: (([String: Any]) -> Void)?
  var onMessage: ((String) -> Void)?

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) { onChange?() }
  func sessionDidBecomeInactive(_ session: WCSession) { onChange?() }
  func sessionDidDeactivate(_ session: WCSession) { session.activate() }
  func sessionReachabilityDidChange(_ session: WCSession) { onChange?() }
  func sessionWatchStateDidChange(_ session: WCSession) { onChange?() }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    if let json = message["json"] as? String { onMessage?(json) }
  }

  func session(_ session: WCSession, didReceive file: WCSessionFile) {
    // The file is deleted when this callback returns — copy first.
    let dst = FileManager.default.temporaryDirectory.appendingPathComponent("watch-ptt-\(Int(Date().timeIntervalSince1970 * 1000)).m4a")
    do {
      try? FileManager.default.removeItem(at: dst)
      try FileManager.default.copyItem(at: file.fileURL, to: dst)
      let meta = file.metadata ?? [:]
      onFile?(["path": dst.path, "kind": (meta["kind"] as? String) ?? "ptt", "ms": (meta["ms"] as? Double) ?? 0])
    } catch {
      onFile?(["path": "", "kind": "error", "ms": 0])
    }
  }
}
