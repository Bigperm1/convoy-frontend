import WidgetKit
import SwiftUI

struct HelloEntry: TimelineEntry { let date: Date }
struct HelloProvider: TimelineProvider {
  func placeholder(in: Context) -> HelloEntry { HelloEntry(date: Date()) }
  func getSnapshot(in: Context, completion: @escaping (HelloEntry) -> Void) { completion(HelloEntry(date: Date())) }
  func getTimeline(in: Context, completion: @escaping (Timeline<HelloEntry>) -> Void) {
    completion(Timeline(entries: [HelloEntry(date: Date())], policy: .never))
  }
}
@main
struct HairpinWatchWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HairpinWatchWidget", provider: HelloProvider()) { _ in Text("H") }
      .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}
