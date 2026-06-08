// AlertToast.tsx — transient toast pills surfaced over the map.
//
// Two flavors share the same look but stack so they don't collide:
//   - ReportToast    bottom: 160 (dark) — Police/Hazard report confirmation
//   - MusicToast     bottom: 210 (green) — Convoy admin's broadcast track
//
// Both ignore pointer events so the map underneath stays interactive.

import React from "react";
import { View, Text, StyleSheet } from "react-native";

export function ReportToast({ kind }: { kind: "police" | "road" | null }) {
  if (!kind) return null;
  return (
    <View pointerEvents="none" style={styles.toast}>
      <Text style={styles.toastText}>
        {kind === "police" ? "🛡 Police reported" : "⚠️ Hazard reported"}
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

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    bottom: 160,
    alignSelf: "center",
    backgroundColor: "rgba(28,28,30,0.92)",
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 22,
    zIndex: 9999,
  },
  toastText: { color: "#F4F4F4", fontSize: 14, fontWeight: "600" },
});
