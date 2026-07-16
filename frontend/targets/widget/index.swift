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
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

@main
struct HairpinWidgets: WidgetBundle {
  var body: some Widget {
    NextEventWidget()
  }
}
