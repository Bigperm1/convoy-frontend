// AlertToast.tsx — transient toast pills surfaced over the map.
//
// Two flavors share the same look but stack so they don't collide:
//   - ReportToast    bottom: 160 (dark) — Police/Hazard report confirmation
//   - MusicToast     bottom: 210 (green) — Convoy admin's broadcast track
//
// Both ignore pointer events so the map underneath stays interactive.

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { hazardPaint } from "../hazardPalette";

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ReportPill — the report confirmation, UNDER the crew/version pill and dressed exactly like it (map.tsx
// styles.liveOverlay), tinted with the reported kind's category colour (Jeff, 2026-09-25: "make this appear under the
// version pill with the same look as the version but the same colour as the hazard selected"). Replaces the old
// bottom-of-screen ReportToast for reports.
export function ReportPill({ kind }: { kind: string | null }) {
  if (!kind) return null;
  const p = hazardPaint(kind);
  return (
    <View pointerEvents="none" testID="report-pill" style={[styles.pill, { backgroundColor: rgba(p.bright, 0.30), borderColor: p.bright }]}>
      <View style={[styles.pillDot, { backgroundColor: p.bright }]} />
      <Text maxFontSizeMultiplier={1} style={styles.pillText}>{p.label} reported</Text>
    </View>
  );
}

export function ReportToast({ kind }: { kind: string | null }) {
  if (!kind) return null;
  // All four kinds POST /hazards accepts (2026-09-24: the Report sheet reports crash + traffic too).
  const label = kind === "police" ? "🛡 Police reported" : kind === "accident" ? "🚗 Crash reported" : kind === "traffic" ? "🚦 Traffic reported" : "⚠️ Hazard reported";
  return (
    <View pointerEvents="none" style={styles.toast}>
      <Text style={styles.toastText}>
        {label}
      </Text>
    </View>
  );
}

export function MusicToast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View
      pointerEvents="none"
      style={[styles.toast, { bottom: 210, backgroundColor: "rgba(29,185,84,0.95)" }]}
    >
      <Text style={styles.toastText} numberOfLines={1}>{message}</Text>
    </View>
  );
}

// HailToast — surfaced when a peer hails this device (either via OS push or
// WebSocket fallback). Pinned higher than MusicToast so a Hail isn't visually
// buried by an ongoing track broadcast. Bright red gradient for urgency.
export function HailToast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View
      pointerEvents="none"
      style={[styles.toast, { bottom: 260, backgroundColor: "rgba(255,59,48,0.95)" }]}
    >
      <Text style={styles.toastText} numberOfLines={1}>{message}</Text>
    </View>
  );
}

// InfoToast — generic dark explanatory pill (e.g. "AI route is still learning…").
// Wraps over up to 3 lines and accepts a `bottom` so callers can float it ABOVE an
// open sheet instead of behind it.
export function InfoToast({ message, bottom = 160 }: { message: string | null; bottom?: number }) {
  if (!message) return null;
  return (
    <View pointerEvents="none" style={[styles.toast, styles.infoToast, { bottom }]}>
      <Text style={[styles.toastText, styles.infoToastText]} numberOfLines={3}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // = map.tsx styles.liveOverlay, colour aside.
  pill: {
    alignSelf: "center", marginTop: 6,
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 9, paddingVertical: 3,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    zIndex: 5,
  },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { color: "#F4F4F4", fontSize: 10, fontWeight: "600", letterSpacing: 0.2 },
  toast: {
    position: "absolute",
    bottom: 160,
    alignSelf: "center",
    backgroundColor: "rgba(28,28,30,0.92)",
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 11,
    zIndex: 9999,
  },
  toastText: { color: "#F4F4F4", fontSize: 14, fontWeight: "600" },
  infoToast: { maxWidth: 340 },
  infoToastText: { textAlign: "center", fontWeight: "500", lineHeight: 19 },
});
