// targets/watch/WatchStore.swift
import Foundation
import WidgetKit

struct WatchNav: Codable { var on: Bool; var glyph: String; var street: String; var distM: Int; var side: String; var etaS: Int; var stepIdx: Int }
struct WatchCrew: Codable { var live: Int }
struct WatchPayload: Codable { var v: Int; var nav: WatchNav; var crew: WatchCrew; var at: Double }

let WATCH_STATE_KEY = "watchState"          // read by the complication too
let WATCH_STALE_MS: Double = 30_000         // mirrors src/watchFeed.ts WATCH_STALE_MS (a constant, not a rule)
// Shared with the complication (targets/watch-widget) — a widget extension has its own container, so UserDefaults.standard would never reach it (same reason the iOS widget uses an App Group).
let WATCH_SUITE = "group.com.sw0rdfisch.convoy.watch"

final class WatchStore: ObservableObject {
  @Published var payload: WatchPayload? = WatchStore.load()
  @Published var linkOk = false
  @Published var lastError: String? = nil   // set on a decode failure in apply(json:); cleared on the next success. load()'s cold-launch miss is NOT an error.

  static func load() -> WatchPayload? {
    guard let raw = (UserDefaults(suiteName: WATCH_SUITE) ?? UserDefaults.standard).string(forKey: WATCH_STATE_KEY), let d = raw.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(WatchPayload.self, from: d)
  }

  @discardableResult
  func apply(json: String) -> Bool {
    guard let d = json.data(using: .utf8), let p = try? JSONDecoder().decode(WatchPayload.self, from: d) else {
      lastError = "decode"   // leave payload untouched — do not clobber the last-known-good state on a bad message
      return false
    }
    lastError = nil
    let crewChanged = p.crew.live != (payload?.crew.live ?? -1)
    payload = p
    (UserDefaults(suiteName: WATCH_SUITE) ?? UserDefaults.standard).set(json, forKey: WATCH_STATE_KEY)
    if crewChanged { WidgetCenter.shared.reloadAllTimelines() }
    return true
  }

  var isStale: Bool {
    guard let p = payload, p.at > 0 else { return true }
    return Date().timeIntervalSince1970 * 1000 - p.at >= WATCH_STALE_MS
  }
}
