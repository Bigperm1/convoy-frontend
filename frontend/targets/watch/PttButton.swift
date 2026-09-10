// targets/watch/PttButton.swift
import SwiftUI

struct PttButton: View {
  @ObservedObject var store: WatchStore
  @StateObject private var rec = PttRecorder()
  var body: some View {
    VStack(spacing: 8) {
      Circle()
        .fill(rec.recording ? Color.red : Color(red: 0.18, green: 0.93, blue: 0.53))
        .frame(width: 96, height: 96)
        .overlay(Image(systemName: "mic.fill").font(.system(size: 36)).foregroundStyle(.black))
        .gesture(DragGesture(minimumDistance: 0)
          .onChanged { _ in if !rec.recording { rec.start() } }
          .onEnded { _ in rec.stop() })
      Text(rec.recording ? "Talking…" : "Hold to talk").font(.caption)
      // The transfer can fail long after the press ended (WatchSession.didFinish) — that is the
      // only signal the driver ever gets that the crew did not hear the clip.
      if let p = store.pttStatus { Text(p).font(.caption2).foregroundStyle(.red) }
      if let e = rec.lastError { Text(e).font(.caption2).foregroundStyle(.red) }
    }
  }
}
