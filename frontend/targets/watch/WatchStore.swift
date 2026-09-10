// targets/watch/WatchStore.swift
import Foundation
import WidgetKit

struct WatchNav: Codable { var on: Bool; var glyph: String; var street: String; var distM: Int; var side: String; var etaS: Int; var stepIdx: Int }
struct WatchCrew: Codable { var live: Int }
struct WatchPayload: Codable { var v: Int; var nav: WatchNav; var crew: WatchCrew; var at: Double }

let WATCH_STATE_KEY = "watchState"          // read by the complication too
let WATCH_STALE_MS: Double = 30_000         // mirrors src/watchFeed.ts WATCH_STALE_MS (a constant, not a rule)
// Shared with the complication (targets/watch-widget) — a widget extension has its own container, so the default (unsuited) domain would never reach it (same reason the iOS widget uses an App Group). A nil suite is a broken entitlement, not a fallback case — it surfaces as lastError = "suite".
let WATCH_SUITE = "group.com.sw0rdfisch.convoy.watch"

final class WatchStore: ObservableObject {
  @Published var payload: WatchPayload? = WatchStore.load()
  @Published var linkOk = false
  @Published var lastError: String? = nil   // set on a decode failure in apply(json:); cleared on the next success. load()'s cold-launch miss is NOT an error.
  // Set by WatchSession when a PTT file transfer finishes with an error; nil when it succeeded.
  // The wrist is the only place a failed clip can be surfaced — the phone never saw it.
  @Published var pttStatus: String? = nil

  private static func suite() -> UserDefaults? { UserDefaults(suiteName: WATCH_SUITE) }

  static func load() -> WatchPayload? {
    guard let ud = WatchStore.suite(), let raw = ud.string(forKey: WATCH_STATE_KEY), let d = raw.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(WatchPayload.self, from: d)
  }

  @discardableResult
  func apply(json: String) -> Bool {
    guard let ud = WatchStore.suite() else { lastError = "suite"; return false }
    guard let d = json.data(using: .utf8), let p = try? JSONDecoder().decode(WatchPayload.self, from: d) else {
      lastError = "decode"   // leave payload untouched — do not clobber the last-known-good state on a bad message
      return false
    }
    lastError = nil
    // The complication draws BOTH the crew count and the drive state, so a drive starting or
    // ending has to reload it too — crew alone left a stale "no drive" face for a whole drive.
    let crewChanged = p.crew.live != (payload?.crew.live ?? -1)
    let navChanged = p.nav.on != (payload?.nav.on ?? false)
    payload = p
    ud.set(json, forKey: WATCH_STATE_KEY)
    if crewChanged || navChanged { WidgetCenter.shared.reloadAllTimelines() }
    return true
  }

  var isStale: Bool {
    guard let p = payload, p.at > 0 else { return true }
    return Date().timeIntervalSince1970 * 1000 - p.at >= WATCH_STALE_MS
  }
}
