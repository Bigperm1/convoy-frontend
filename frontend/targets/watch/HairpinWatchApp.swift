// targets/watch/HairpinWatchApp.swift
import SwiftUI

@main
struct HairpinWatchApp: App {
  // The session is the root object: it owns the store and activates WCSession at init, before
  // any view exists. No .onAppear activation — see WatchSession.swift.
  @StateObject private var session = WatchSession()
  var body: some Scene {
    WindowGroup {
      TabView {
        TurnCardView(store: session.store)
        PttButton(store: session.store)
      }
      .tabViewStyle(.page)
    }
  }
}
