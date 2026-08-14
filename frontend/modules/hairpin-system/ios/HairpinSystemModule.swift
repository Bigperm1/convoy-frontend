import ExpoModulesCore
import CoreLocation
import WidgetKit
import CarPlay
import UIKit

// Hairpin system integrations (build 65):
//
// 1) CLVISIT VISIT MONITORING — the third-party flavor of Apple Maps' "Visited
//    Places": iOS's own ultra-low-power arrival/departure detection. Delivered
//    even when the app is backgrounded (Always authorization — which Hairpin
//    already requests). JS (src/visitMonitor.ts) forwards arrivals to the
//    backend so the cruise arrival trigger fires with the phone in a pocket.
//    Uses its OWN CLLocationManager: visit monitoring is a separate delegate
//    stream and must not touch expo-location's manager/config.
//
// 2) APP-GROUP SHARED DEFAULTS — the write side of the Hairpin home-screen
//    widget. JS serializes the "next event" payload; the widget extension
//    reads it from UserDefaults(suiteName:) and we poke WidgetKit to redraw.
//
// NOTE: Expo's `Module` base class is NOT an NSObject, so this class cannot
// conform to CLLocationManagerDelegate itself (Swift: "cannot declare
// conformance to 'NSObjectProtocol'" — the exact error that failed the first
// build-65 iOS run). The delegate lives in a small NSObject helper below,
// retained by the module (CLLocationManager.delegate is weak) and forwarding
// visits back through a closure.
public class HairpinSystemModule: Module {
  private var visitManager: CLLocationManager?
  private var visitDelegate: HairpinVisitDelegate?
  // ── CARPLAY FRAME PUMP (build 70) ─────────────────────────────────────────
  // The ONE clock that survives the phone's display powering off.
  //
  // WHY THIS HAS TO BE NATIVE. React Native drives its JS timer pump from
  // `[CADisplayLink displayLinkWithTarget:]` (React/Base/RCTDisplayLink.m:32) —
  // the plain class method, which iOS binds to the BUILT-IN display. Apple DTS
  // (Developer Forums 777989): "If your app's map view rendering is dependent on
  // a CADisplayLink, you should obtain a display link from the CarPlay UIScreen
  // via displayLinkWithTarget:selector:. Otherwise the display link will be
  // driven by the frame rate of the iPhone's builtin display, which will pause
  // while the display is powered off." RN has no CarPlay-screen variant, and
  // RCTTiming's only fallback arms an NSTimer solely for targets over 1 second
  // (kMinimumSleepInterval), so a 33 ms JS ticker never qualifies. Net effect:
  // with the phone asleep, requestAnimationFrame and setInterval both stop, and
  // the car marker cannot interpolate between GPS fixes no matter what JS does.
  //
  // MapboxMaps already does the right thing for its own rendering
  // (MapViewDependencyProvider.swift uses `window.screen.displayLink(...)` with
  // explicit isCarPlay handling), which is why the car map keeps DRAWING — it
  // just has nothing new to draw. This supplies the missing pump: a display link
  // from the head unit's own screen, emitting a frame event to JS, which advances
  // the same ease the JS ticker does.
  private var carLink: CADisplayLink?

  // The head unit's UIScreen, found via the live CarPlay scene. Self-contained on
  // purpose: the app target's own carWindowRef (withConvoyCarPlay.js) is not
  // reachable from this pod.
  private func carPlayScreen() -> UIScreen? {
    for scene in UIApplication.shared.connectedScenes {
      if let cp = scene as? CPTemplateApplicationScene {
        return cp.carWindow.screen
      }
    }
    return nil
  }

  @objc private func carFrame() {
    sendEvent("onCarFrame", [:])
  }

  public func definition() -> ModuleDefinition {
    Name("HairpinSystem")

    Events("onVisit", "onCarFrame")

    // Start the CarPlay-screen frame pump. Idempotent; returns false when there is
    // no CarPlay scene yet so JS can retry on connect.
    Function("startCarFrames") { () -> Bool in
      var ok = false
      DispatchQueue.main.sync {
        if self.carLink != nil { ok = true; return }
        guard let screen = self.carPlayScreen() else { return }
        let link = screen.displayLink(withTarget: self, selector: #selector(self.carFrame))
        guard let link = link else { return }
        // 60 fps (Jeff, 2026-08-14). This was 30 "to match the JS ticker's cadence and the
        // eco frame cap" — and that cap is the reason for a symptom Jeff has reported since
        // this pump shipped: "when the phone screen turns off the carplay/aa was choppy."
        //
        // With the phone display ON, requestAnimationFrame drives the ease at 60 fps. The
        // moment the display sleeps, rAF and setInterval both stop (see the note above) and
        // THIS link becomes the only clock — so the car marker silently dropped from 60 fps
        // to 30 fps at exactly the moment the driver stopped touching the phone. Not a
        // stutter in the data; a halving of the frame rate.
        //
        // The eco/premium split it was matched to has since been removed outright, and a
        // car display presents at 60, so 60 is both the honest match and the fix.
        link.preferredFramesPerSecond = 60
        link.add(to: .main, forMode: .common)
        self.carLink = link
        ok = true
      }
      return ok
    }

    Function("stopCarFrames") {
      DispatchQueue.main.sync {
        self.carLink?.invalidate()
        self.carLink = nil
      }
    }

    // ── REAL MAP-BUTTON SAFE AREA (build 70) ──────────────────────────────────
    // Every inset on the car HUD was hand-measured off ONE 800x480 head-unit photo.
    // iOS actually reports this: CPWindow.mapButtonSafeAreaLayoutGuide is the region
    // NOT covered by CarPlay's own map buttons, per unit and per orientation. Return
    // it as insets so the surface can lay out against what this car really is instead
    // of what one photograph happened to be.
    // Returns nil when there is no CarPlay window (JS then keeps its measured
    // constants), so this is purely additive.
    Function("carMapButtonInsets") { () -> [String: Double]? in
      var out: [String: Double]? = nil
      DispatchQueue.main.sync {
        for scene in UIApplication.shared.connectedScenes {
          guard let cp = scene as? CPTemplateApplicationScene else { continue }
          let win = cp.carWindow
          let b = win.bounds
          guard b.width > 1, b.height > 1 else { return }
          let g = win.mapButtonSafeAreaLayoutGuide.layoutFrame
          guard g.width > 1, g.height > 1 else { return }
          out = [
            "left": Double(g.minX),
            "top": Double(g.minY),
            "right": Double(b.maxX - g.maxX),
            "bottom": Double(b.maxY - g.maxY),
            "width": Double(b.width),
            "height": Double(b.height),
          ]
          return
        }
      }
      return out
    }

    Function("startVisitMonitoring") {
      DispatchQueue.main.async {
        if self.visitManager == nil {
          let delegate = HairpinVisitDelegate { [weak self] payload in
            self?.sendEvent("onVisit", payload)
          }
          let m = CLLocationManager()
          m.delegate = delegate
          self.visitDelegate = delegate // retain — manager.delegate is weak
          self.visitManager = m
        }
        self.visitManager?.startMonitoringVisits()
      }
    }

    Function("stopVisitMonitoring") {
      DispatchQueue.main.async {
        self.visitManager?.stopMonitoringVisits()
      }
    }

    Function("setSharedDefaults") { (suite: String, key: String, json: String) in
      UserDefaults(suiteName: suite)?.set(json, forKey: key)
      if #available(iOS 14.0, *) {
        WidgetCenter.shared.reloadAllTimelines()
      }
    }
  }
}

// NSObject delegate for the visit stream (see NOTE above).
private final class HairpinVisitDelegate: NSObject, CLLocationManagerDelegate {
  private let onVisit: ([String: Any]) -> Void

  init(onVisit: @escaping ([String: Any]) -> Void) {
    self.onVisit = onVisit
    super.init()
  }

  func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
    // CLVisit uses distantPast/distantFuture for unknown bounds — normalize to 0
    // so JS can tell "arrival event" (departure unknown) from "departure event".
    let arrival = visit.arrivalDate == Date.distantPast ? 0 : visit.arrivalDate.timeIntervalSince1970 * 1000
    let departure = visit.departureDate == Date.distantFuture ? 0 : visit.departureDate.timeIntervalSince1970 * 1000
    onVisit([
      "lat": visit.coordinate.latitude,
      "lng": visit.coordinate.longitude,
      "arrivalTs": arrival,
      "departureTs": departure,
      "horizontalAccuracy": visit.horizontalAccuracy,
    ])
  }
}
