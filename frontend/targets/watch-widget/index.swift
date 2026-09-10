// targets/watch-widget/index.swift — crew-live count on the watch face.
import WidgetKit
import SwiftUI

struct CrewEntry: TimelineEntry { let date: Date; let live: Int; let driving: Bool }

private func readCrew() -> CrewEntry {
  var live = 0, driving = false
  if let raw = UserDefaults(suiteName: "group.com.sw0rdfisch.convoy.watch")?.string(forKey: "watchState"), let d = raw.data(using: .utf8),
     let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
    live = ((obj["crew"] as? [String: Any])?["live"] as? Int) ?? 0
    driving = ((obj["nav"] as? [String: Any])?["on"] as? Bool) ?? false
  }
  return CrewEntry(date: Date(), live: live, driving: driving)
}

struct CrewProvider: TimelineProvider {
  func placeholder(in: Context) -> CrewEntry { CrewEntry(date: Date(), live: 3, driving: false) }
  func getSnapshot(in: Context, completion: @escaping (CrewEntry) -> Void) { completion(readCrew()) }
  func getTimeline(in: Context, completion: @escaping (Timeline<CrewEntry>) -> Void) {
    completion(Timeline(entries: [readCrew()], policy: .after(Date().addingTimeInterval(15 * 60))))
  }
}

struct CrewView: View {
  @Environment(\.widgetFamily) var family
  let entry: CrewEntry
  var body: some View {
    switch family {
    case .accessoryInline: Text("Hairpin · \(entry.live) live")
    case .accessoryRectangular:
      VStack(alignment: .leading) { Text("Hairpin").font(.headline); Text("\(entry.live) crew live\(entry.driving ? " · driving" : "")").font(.caption) }
    default:
      ZStack { AccessoryWidgetBackground(); VStack { Text("\(entry.live)").font(.title2.bold()); Text("live").font(.system(size: 9)) } }
    }
  }
}

@main
struct HairpinWatchWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HairpinWatchWidget", provider: CrewProvider()) { CrewView(entry: $0) }
      .configurationDisplayName("Crew live")
      .description("How many of your convoy are live.")
      .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}
