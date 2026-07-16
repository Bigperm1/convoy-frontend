import ExpoModulesCore
import CoreLocation
import WidgetKit

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
public class HairpinSystemModule: Module, CLLocationManagerDelegate {
  private var visitManager: CLLocationManager?

  public func definition() -> ModuleDefinition {
    Name("HairpinSystem")

    Events("onVisit")

    Function("startVisitMonitoring") {
      DispatchQueue.main.async {
        if self.visitManager == nil {
          let m = CLLocationManager()
          m.delegate = self
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

  public func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
    // CLVisit uses distantPast/distantFuture for unknown bounds — normalize to 0
    // so JS can tell "arrival event" (departure unknown) from "departure event".
    let arrival = visit.arrivalDate == Date.distantPast ? 0 : visit.arrivalDate.timeIntervalSince1970 * 1000
    let departure = visit.departureDate == Date.distantFuture ? 0 : visit.departureDate.timeIntervalSince1970 * 1000
    sendEvent("onVisit", [
      "lat": visit.coordinate.latitude,
      "lng": visit.coordinate.longitude,
      "arrivalTs": arrival,
      "departureTs": departure,
      "horizontalAccuracy": visit.horizontalAccuracy,
    ])
  }
}
