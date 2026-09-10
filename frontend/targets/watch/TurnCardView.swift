// targets/watch/TurnCardView.swift
import SwiftUI

struct TurnCardView: View {
  @ObservedObject var store: WatchStore
  var body: some View {
    VStack(spacing: 6) {
      if let p = store.payload, p.nav.on, !store.isStale {
        Text(p.nav.glyph.isEmpty ? "•" : p.nav.glyph).font(.system(size: 44, weight: .bold))
        Text(fmtDist(p.nav.distM)).font(.title3).monospacedDigit()
        Text(p.nav.street).font(.footnote).multilineTextAlignment(.center).lineLimit(2)
        HStack { Text("ETA \(fmtEta(p.nav.etaS))"); Spacer(); Text("\(p.crew.live) live") }.font(.caption2).foregroundStyle(.secondary)
      } else if store.isStale {
        Text("Waiting for phone").font(.headline)
        Text("Start a drive on your iPhone").font(.caption2).foregroundStyle(.secondary)
      } else {
        Text("No drive").font(.headline)
        Text("\(store.payload?.crew.live ?? 0) crew live").font(.caption2).foregroundStyle(.secondary)
      }
      if store.lastError != nil {
        Text("Phone data unreadable").font(.caption2).foregroundStyle(.red)
      }
    }
    .padding(.horizontal, 6)
  }
  private func fmtDist(_ m: Int) -> String { m >= 1000 ? String(format: "%.1f km", Double(m) / 1000) : "\(m) m" }
  private func fmtEta(_ s: Int) -> String { s >= 3600 ? "\(s / 3600) h \((s % 3600) / 60) min" : "\(max(1, s / 60)) min" }
}
