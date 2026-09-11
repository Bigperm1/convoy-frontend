import WidgetKit
import SwiftUI

// Hairpin home-screen widget.
//
// SMALL / MEDIUM (build 65+) — "Next up": the next event/cruise you're attending with a
// live countdown; tapping opens the Hub. Data comes from the shared App Group defaults
// (key "nextEvent"), written by the app (src/widgetFeed.ts) whenever the user's events
// load or change. No networking here — widgets render instantly from the last snapshot.
//
// FULL PAGE (iOS 27 `systemExtraLargePortrait`, design approved 2026-09-11) — the crew
// page: snapshot map, the crew ring row, and a next-cruise card that SWAPS to the
// Departure-IQ "leave by" countdown when there is one for today. See the COMPILE GATE
// note on `NextEventWidget.families`: the family is invisible to the Xcode 26 SDK, so
// today's EAS builds are byte-for-byte identical to build 78 (small + medium only).
//
// Extra payload keys are all OPTIONAL and read as absent on any build whose app half
// hasn't shipped yet — the full-page view degrades to the map-less, crew-less layout
// rather than breaking.

private let SUITE = "group.com.sw0rdfisch.convoy"
private let KEY = "nextEvent"
private let KEY_CREW = "crew"
private let KEY_LEAVE = "leaveBy"

// ── model ─────────────────────────────────────────────────────────────────────

struct CrewMember: Identifiable {
  let id = UUID()
  let handle: String
  let status: String      // "live" | "driving" | "parked"
  let km: Double?
  let tier: String?       // "gold" | "silver" | nil
}

struct NextEventEntry: TimelineEntry {
  let date: Date
  let title: String?
  let startAt: Date?
  let kind: String
  let venue: String
  // full-page extras (absent on older app builds)
  var crew: [CrewMember] = []
  var crewLive: Int = 0
  var mapFile: String? = nil
  var leaveBy: Date? = nil
  var leaveDest: String = ""
  var leaveDriveMin: Int = 0
}

private func defaults() -> UserDefaults? { UserDefaults(suiteName: SUITE) }

private func obj(_ key: String) -> [String: Any]? {
  guard let raw = defaults()?.string(forKey: key), let d = raw.data(using: .utf8),
        let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
  return o
}

private func readEntry() -> NextEventEntry {
  var title: String? = nil
  var start: Date? = nil
  var kind = "event"
  var venue = ""
  if let o = obj(KEY) {
    title = o["title"] as? String
    if let ms = o["startAt"] as? Double, ms > 0 { start = Date(timeIntervalSince1970: ms / 1000) }
    kind = (o["kind"] as? String) ?? "event"
    venue = (o["venueLabel"] as? String) ?? ""
  }
  // A past event is stale — treat as none (the app rewrites on next open).
  if let s = start, s < Date().addingTimeInterval(-3 * 3600) {
    title = nil; start = nil; kind = "event"; venue = ""
  }
  var e = NextEventEntry(date: Date(), title: title, startAt: start, kind: kind, venue: venue)

  // crew — stale after 30 min rather than showing a dead convoy as live
  if let c = obj(KEY_CREW) {
    let at = (c["at"] as? Double) ?? 0
    if at > 0 && Date().timeIntervalSince1970 - at / 1000 < 30 * 60 {
      e.crewLive = (c["live"] as? Int) ?? 0
      e.mapFile = c["map"] as? String
      if let ms = c["members"] as? [[String: Any]] {
        e.crew = ms.prefix(5).map {
          CrewMember(handle: ($0["h"] as? String) ?? "",
                     status: ($0["s"] as? String) ?? "parked",
                     km: $0["km"] as? Double,
                     tier: $0["tier"] as? String)
        }
      }
    }
  }
  // leave-by — only while it is still ahead of us (plus a short grace)
  if let l = obj(KEY_LEAVE), let ms = l["at"] as? Double, ms > 0 {
    let at = Date(timeIntervalSince1970: ms / 1000)
    if at > Date().addingTimeInterval(-15 * 60) {
      e.leaveBy = at
      e.leaveDest = (l["dest"] as? String) ?? ""
      e.leaveDriveMin = (l["driveMin"] as? Int) ?? 0
    }
  }
  return e
}

struct Provider: TimelineProvider {
  func placeholder(in context: Context) -> NextEventEntry {
    NextEventEntry(date: Date(), title: "Sunday cruise", startAt: Date().addingTimeInterval(86_400), kind: "cruise", venue: "Waterfront")
  }
  func getSnapshot(in context: Context, completion: @escaping (NextEventEntry) -> Void) {
    completion(readEntry())
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<NextEventEntry>) -> Void) {
    // The countdown text self-updates (relative date style); refresh the entry
    // hourly so stale/past events age out even if the app isn't opened.
    completion(Timeline(entries: [readEntry()], policy: .after(Date().addingTimeInterval(3600))))
  }
}

// ── palette (mirrors src/theme.ts + src/tierTheme.ts) ─────────────────────────

private let hairpinGreen = Color(red: 45 / 255, green: 236 / 255, blue: 134 / 255)
private let hairpinAmber = Color(red: 255 / 255, green: 159 / 255, blue: 10 / 255)
private let hairpinGrey  = Color(red: 128 / 255, green: 128 / 255, blue: 128 / 255)
private let hairpinElev  = Color(red: 12 / 255, green: 12 / 255, blue: 14 / 255)
private let hairpinGold  = Color(red: 212 / 255, green: 175 / 255, blue: 55 / 255)
private let hairpinSilver = Color(white: 0.75)
private let hairline = Color.white.opacity(0.08)

private func ringColor(_ status: String) -> Color {
  status == "live" ? hairpinGreen : status == "driving" ? hairpinAmber : hairpinGrey
}
private func tierColor(_ t: String?) -> Color? {
  t == "gold" ? hairpinGold : t == "silver" ? hairpinSilver : nil
}

/// The crew map snapshot the app renders into the App Group container. nil until the
/// app half ships — the full-page view then draws its placeholder instead of a map.
private func mapImage(_ file: String?) -> Image? {
  guard let file, !file.isEmpty,
        let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SUITE) else { return nil }
  let url = dir.appendingPathComponent(file)
  guard let data = try? Data(contentsOf: url), let ui = UIImage(data: data) else { return nil }
  return Image(uiImage: ui)
}

// ── full-page pieces ──────────────────────────────────────────────────────────

private struct CrewDot: View {
  let m: CrewMember
  var body: some View {
    VStack(spacing: 5) {
      ZStack {
        Circle().fill(Color(white: 0.16)).frame(width: 42, height: 42)
        Image(systemName: m.status == "parked" ? "car.fill" : "car.side.fill")
          .font(.system(size: 16, weight: .bold))
          .foregroundColor(m.status == "parked" ? hairpinGrey : .white)
        Circle().stroke(ringColor(m.status), lineWidth: 2.5).frame(width: 46, height: 46)
        if let t = tierColor(m.tier) {
          Circle().stroke(t, lineWidth: 1.5).frame(width: 52, height: 52).opacity(0.9)
        }
        if m.status != "parked" {
          Circle().fill(ringColor(m.status)).frame(width: 9, height: 9)
            .overlay(Circle().stroke(Color.black, lineWidth: 2))
            .offset(x: 17, y: 15)
        }
      }
      Text(m.handle).font(.system(size: 9, weight: .bold))
        .foregroundColor(m.status == "parked" ? hairpinGrey : .white)
        .lineLimit(1)
    }
    .frame(width: 56)
  }
}

private struct PageHeader: View {
  let live: Int
  var body: some View {
    HStack(spacing: 7) {
      ZStack {
        RoundedRectangle(cornerRadius: 7, style: .continuous).fill(hairpinGreen).frame(width: 24, height: 24)
        Text("H").font(.system(size: 15, weight: .black, design: .rounded)).foregroundColor(.black)
      }
      Text("HAIRPIN").font(.system(size: 13, weight: .black)).tracking(1.6).foregroundColor(.white)
      Spacer()
      if live > 0 {
        HStack(spacing: 5) {
          Circle().fill(hairpinGreen).frame(width: 7, height: 7)
          Text("\(live) LIVE").font(.system(size: 11, weight: .heavy)).tracking(0.6).foregroundColor(hairpinGreen)
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(Capsule().fill(hairpinGreen.opacity(0.14)))
        .overlay(Capsule().stroke(hairpinGreen.opacity(0.35), lineWidth: 1))
      }
    }
  }
}

private struct MapPanel: View {
  let file: String?
  var body: some View {
    ZStack {
      if let img = mapImage(file) {
        img.resizable().aspectRatio(contentMode: .fill)
        LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .center, endPoint: .bottom)
      } else {
        hairpinElev
        VStack(spacing: 7) {
          Image(systemName: "map").font(.system(size: 24, weight: .semibold)).foregroundColor(hairpinGrey)
          Text("Open Hairpin to load the crew map")
            .font(.system(size: 11, weight: .semibold)).foregroundColor(hairpinGrey)
        }
      }
    }
    .frame(height: 232)
    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(hairline, lineWidth: 1))
  }
}

/// The next-cruise card, which SWAPS to the Departure-IQ "leave by" countdown when the
/// app has written one that is still ahead of us (Jeff, 2026-09-11: "same layout,
/// sharper when it matters").
private struct HeadlineCard: View {
  let entry: NextEventEntry
  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      if let leave = entry.leaveBy {
        HStack(spacing: 6) {
          Image(systemName: "clock.badge.exclamationmark.fill")
            .font(.system(size: 11, weight: .bold)).foregroundColor(hairpinGreen)
          Text("LEAVE BY").font(.system(size: 10, weight: .heavy)).tracking(0.9).foregroundColor(hairpinGrey)
          Spacer()
          if entry.leaveDriveMin > 0 {
            Text("\(entry.leaveDriveMin) MIN DRIVE").font(.system(size: 10, weight: .bold)).foregroundColor(hairpinGrey)
          }
        }
        Text(leave, style: .time)
          .font(.system(size: 34, weight: .black)).foregroundColor(hairpinGreen).lineLimit(1).minimumScaleFactor(0.6)
        HStack(spacing: 6) {
          Text(leave, style: .relative).font(.system(size: 15, weight: .heavy)).foregroundColor(.white).lineLimit(1)
          Spacer()
          if !entry.leaveDest.isEmpty {
            Text(entry.leaveDest).font(.system(size: 11, weight: .semibold)).foregroundColor(hairpinGrey).lineLimit(1)
          }
        }
      } else if let title = entry.title, let start = entry.startAt {
        HStack(spacing: 6) {
          Image(systemName: entry.kind == "cruise" ? "car.fill" : "calendar")
            .font(.system(size: 11, weight: .bold)).foregroundColor(hairpinGreen)
          Text(entry.kind == "cruise" ? "NEXT CRUISE" : "NEXT EVENT")
            .font(.system(size: 10, weight: .heavy)).tracking(0.9).foregroundColor(hairpinGrey)
          Spacer()
          Text(start, style: .date).font(.system(size: 10, weight: .bold)).foregroundColor(hairpinGrey).lineLimit(1)
        }
        Text(title).font(.system(size: 19, weight: .bold)).foregroundColor(.white).lineLimit(1)
        HStack(spacing: 6) {
          Text(start, style: .relative)
            .font(.system(size: 24, weight: .heavy)).foregroundColor(hairpinGreen).lineLimit(1).minimumScaleFactor(0.6)
          Spacer()
          if !entry.venue.isEmpty {
            Text(entry.venue).font(.system(size: 11, weight: .semibold)).foregroundColor(hairpinGrey).lineLimit(1)
          }
        }
      } else {
        HStack(spacing: 6) {
          Image(systemName: "flag.checkered").font(.system(size: 11, weight: .bold)).foregroundColor(hairpinGreen)
          Text("NO UPCOMING RUNS").font(.system(size: 10, weight: .heavy)).tracking(0.9).foregroundColor(hairpinGrey)
        }
        Text("Plan one in the Hub").font(.system(size: 17, weight: .bold)).foregroundColor(.white)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(13)
    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(hairpinElev))
    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
      .stroke(entry.leaveBy != nil ? hairpinGreen.opacity(0.28) : hairline, lineWidth: 1))
  }
}

/// iOS 27 full page. Tap targets are `Link`s (iOS 14+ in widgets) rather than
/// AppIntents — every destination here just opens the app, so there is no extension
/// to add and nothing new to register. Routes are the ones src/deepLinks.ts already
/// parses: `comms/transmit`, `crew`, `go?to=`.
private struct FullPageView: View {
  let entry: NextEventEntry

  private var driveURL: URL? {
    let dest = entry.leaveBy != nil ? entry.leaveDest : entry.venue
    guard !dest.isEmpty,
          let q = dest.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return nil }
    return URL(string: "convoy://go?to=\(q)")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      PageHeader(live: entry.crewLive)
      Link(destination: URL(string: "convoy://crew")!) { MapPanel(file: entry.mapFile) }
      if entry.crew.isEmpty {
        Text("No crew out right now")
          .font(.system(size: 12, weight: .semibold)).foregroundColor(hairpinGrey)
          .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 14)
      } else {
        Link(destination: URL(string: "convoy://crew")!) {
          HStack(spacing: 0) {
            ForEach(entry.crew) { CrewDot(m: $0) }
          }
          .frame(maxWidth: .infinity)
        }
      }
      Link(destination: URL(string: "convoy://hub")!) { HeadlineCard(entry: entry) }
      Spacer(minLength: 0)
      HStack(spacing: 9) {
        Link(destination: URL(string: "convoy://comms/transmit")!) {
          HStack(spacing: 7) {
            Image(systemName: "mic.fill").font(.system(size: 14, weight: .bold))
            Text("Comms").font(.system(size: 15, weight: .heavy))
          }
          .foregroundColor(.black).frame(maxWidth: .infinity).padding(.vertical, 13)
          .background(RoundedRectangle(cornerRadius: 15, style: .continuous).fill(hairpinGreen))
        }
        if let d = driveURL {
          Link(destination: d) {
            Image(systemName: "location.north.fill").font(.system(size: 15, weight: .bold))
              .foregroundColor(.white).frame(width: 52).padding(.vertical, 13)
              .background(RoundedRectangle(cornerRadius: 15, style: .continuous).fill(Color(white: 0.14)))
          }
        }
      }
    }
  }
}

// ── small / medium (UNCHANGED from build 65 — do not restyle) ─────────────────

private struct CompactView: View {
  let entry: NextEventEntry
  var body: some View {
    Group {
      if let title = entry.title, let start = entry.startAt {
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 6) {
            Image(systemName: entry.kind == "cruise" ? "car.fill" : "calendar")
              .font(.system(size: 13, weight: .bold))
              .foregroundColor(hairpinGreen)
            Text(entry.kind == "cruise" ? "NEXT CRUISE" : "NEXT EVENT")
              .font(.system(size: 10, weight: .heavy))
              .tracking(0.8)
              .foregroundColor(.gray)
          }
          Text(title)
            .font(.system(size: 16, weight: .bold))
            .foregroundColor(.white)
            .lineLimit(2)
          Text(start, style: .relative)
            .font(.system(size: 20, weight: .heavy))
            .foregroundColor(hairpinGreen)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
          if !entry.venue.isEmpty {
            Text(entry.venue)
              .font(.system(size: 11, weight: .semibold))
              .foregroundColor(.gray)
              .lineLimit(1)
          }
          Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      } else {
        VStack(spacing: 6) {
          Image(systemName: "flag.checkered")
            .font(.system(size: 22, weight: .bold))
            .foregroundColor(hairpinGreen)
          Text("No upcoming runs")
            .font(.system(size: 13, weight: .bold))
            .foregroundColor(.white)
          Text("Plan one in the Hub")
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(.gray)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
  }
}

struct HairpinWidgetView: View {
  var entry: NextEventEntry
  @Environment(\.widgetFamily) private var family

  /// True only for the iOS 27 full-page family. The enum case cannot be NAMED under the
  /// Xcode 26 SDK, hence the same compile gate as `NextEventWidget.families`.
  private var isFullPage: Bool {
    #if compiler(>=6.4) && canImport(WidgetKit, _version: 749)
    if #available(iOS 27.0, *) { return family == .systemExtraLargePortrait }
    #endif
    return false
  }

  var body: some View {
    Group {
      if isFullPage { FullPageView(entry: entry) } else { CompactView(entry: entry) }
    }
    .containerBackground(for: .widget) { Color.black }
    // The whole-widget tap stays the Hub on small/medium. On the full page the inner
    // Links own their regions, and this is the fallback for the gaps between them.
    .widgetURL(URL(string: "convoy://hub"))
  }
}

struct NextEventWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HairpinNextEvent", provider: Provider()) { entry in
      HairpinWidgetView(entry: entry)
    }
    .configurationDisplayName("Next up")
    .description("Your next Hairpin event or cruise, counting down.")
    .supportedFamilies(Self.families)
  }

  /// ⛔ COMPILE GATE — do not "simplify" this, and do not drop either half.
  /// In the **iOS 26 SDK** `systemExtraLargePortrait` is `@available(visionOS 26.0, *)` +
  /// `@available(iOS, unavailable)`, so merely NAMING it in an iOS build fails to compile:
  /// "'systemExtraLargePortrait' is unavailable in iOS". A runtime `if #available(iOS 27.0, *)`
  /// alone does NOT help — measured, it still fails under Xcode 26. Only the iOS 27 SDK
  /// re-declares it `@available(iOS 27.0, macOS 27.0, visionOS 26.0, *)`.
  ///
  /// MEASURED MATRIX (2026-09-11, `swiftc -target arm64-apple-ios17.0 -emit-sil`; local
  /// Xcode 26.6 = Swift 6.3.3 / iOS 26.5 SDK, Xcode 27.0b = Swift 6.4 / iOS 27.0 SDK):
  ///
  ///   gate                               6.3.3+iOS26   6.4+iOS27   6.4+iOS26
  ///   compiler(>=6.4) alone              closed        OPEN        COMPILE ERROR  <- breaks
  ///   canImport(WidgetKit,_version:749)  closed        OPEN        closed
  ///   BOTH (what ships here)             closed        OPEN        closed
  ///
  /// Why BOTH: `canImport(_version:)` is the SDK-accurate half — WidgetKit's user-module-version
  /// is 664.5.28.100 in the iOS 26.5 SDK and 749.0.2 in the iOS 27.0 SDK, so 749 is the real
  /// discriminator. `compiler(>=6.4)` is kept for the parse exemption a `compiler()` condition
  /// buys: the false branch is lexed but never parsed, so future syntax in there can never break
  /// an older toolchain. `compiler()` ALONE is unsafe — Apple ships Swift minor bumps inside Xcode
  /// POINT releases (13.3->5.6, 14.3->5.8, 15.3->5.10, 16.3->6.1, 26.4->6.3), each with an
  /// unchanged SDK major, so "Swift 6.4 + iOS 26 SDK" is a real shape: the column that errors above.
  /// WARNING: an earlier pass rejected `canImport` after testing `_version: 27`. That was a
  /// MEASUREMENT ERROR, not a property of the mechanism — both SDKs' module versions are >= 27, so
  /// both branches were taken. Use the MODULE version, never the OS version.
  ///
  /// The inner `if #available(iOS 27.0, *)` is still required even under Xcode 27, because this
  /// target deploys to iOS 17.
  /// NOTE: this gate does NOT open by itself on EAS. `eas.json` uses `image: "auto"`, which selects
  /// by Expo SDK version rather than by newest, so builds stay on an Xcode 26 image until either the
  /// Expo SDK moves or the profile pins an Xcode 27 image. Pinning it is the deliberate one-line
  /// step that turns this family on.
  static var families: [WidgetFamily] {
    var f: [WidgetFamily] = [.systemSmall, .systemMedium]
    #if compiler(>=6.4) && canImport(WidgetKit, _version: 749)
    if #available(iOS 27.0, *) { f.append(.systemExtraLargePortrait) }
    #endif
    return f
  }
}

@main
struct HairpinWidgets: WidgetBundle {
  var body: some Widget {
    NextEventWidget()
  }
}
