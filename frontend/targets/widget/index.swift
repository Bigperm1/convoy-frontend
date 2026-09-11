import WidgetKit
import SwiftUI

// Hairpin "Next up" widget — shows the next event/cruise you're attending with
// a live countdown; tapping opens the Hub. Data comes from the shared App Group
// defaults (key "nextEvent"), written by the app (src/widgetFeed.ts) whenever
// the user's events load or change. No networking here — widgets should render
// instantly from the last snapshot.

private let SUITE = "group.com.sw0rdfisch.convoy"
private let KEY = "nextEvent"

struct NextEventEntry: TimelineEntry {
  let date: Date
  let title: String?
  let startAt: Date?
  let kind: String
  let venue: String
}

private func readEntry() -> NextEventEntry {
  var title: String? = nil
  var start: Date? = nil
  var kind = "event"
  var venue = ""
  if let raw = UserDefaults(suiteName: SUITE)?.string(forKey: KEY),
     let data = raw.data(using: .utf8),
     let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
    title = obj["title"] as? String
    if let ms = obj["startAt"] as? Double, ms > 0 {
      start = Date(timeIntervalSince1970: ms / 1000)
    }
    kind = (obj["kind"] as? String) ?? "event"
    venue = (obj["venueLabel"] as? String) ?? ""
  }
  // A past event is stale — treat as none (the app rewrites on next open).
  if let s = start, s < Date().addingTimeInterval(-3 * 3600) {
    return NextEventEntry(date: Date(), title: nil, startAt: nil, kind: "event", venue: "")
  }
  return NextEventEntry(date: Date(), title: title, startAt: start, kind: kind, venue: venue)
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

private let hairpinGreen = Color(red: 45 / 255, green: 236 / 255, blue: 134 / 255)

struct HairpinWidgetView: View {
  var entry: NextEventEntry
  @Environment(\.widgetFamily) private var family

  // Full-page (iOS 27 systemExtraLargePortrait) gets its own scale. Everything else
  // keeps the build-66 small/medium layout untouched.
  private var isFullPage: Bool {
    #if compiler(>=6.4) && canImport(WidgetKit, _version: 749)
    if #available(iOS 27.0, *) { return family == .systemExtraLargePortrait }
    #endif
    return false
  }

  var body: some View {
    Group {
      if let title = entry.title, let start = entry.startAt {
        VStack(alignment: .leading, spacing: isFullPage ? 14 : 6) {
          HStack(spacing: 6) {
            Image(systemName: entry.kind == "cruise" ? "car.fill" : "calendar")
              .font(.system(size: isFullPage ? 20 : 13, weight: .bold))
              .foregroundColor(hairpinGreen)
            Text(entry.kind == "cruise" ? "NEXT CRUISE" : "NEXT EVENT")
              .font(.system(size: isFullPage ? 15 : 10, weight: .heavy))
              .tracking(0.8)
              .foregroundColor(.gray)
          }
          Text(title)
            .font(.system(size: isFullPage ? 34 : 16, weight: .bold))
            .foregroundColor(.white)
            .lineLimit(2)
          Text(start, style: .relative)
            .font(.system(size: isFullPage ? 52 : 20, weight: .heavy))
            .foregroundColor(hairpinGreen)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
          if !entry.venue.isEmpty {
            Text(entry.venue)
              .font(.system(size: isFullPage ? 20 : 11, weight: .semibold))
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
    .containerBackground(for: .widget) { Color.black }
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
