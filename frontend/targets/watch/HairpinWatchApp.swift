// targets/watch/HairpinWatchApp.swift
import SwiftUI

@main
struct HairpinWatchApp: App {
  @StateObject private var store = WatchStore()
  @State private var session: WatchSession? = nil
  var body: some Scene {
    WindowGroup {
      TabView {
        TurnCardView(store: store)
        PttButton()
      }
      .tabViewStyle(.page)
      .onAppear { if session == nil { session = WatchSession(store: store) } }
    }
  }
}
