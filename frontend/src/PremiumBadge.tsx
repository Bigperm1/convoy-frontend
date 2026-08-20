// PremiumBadge + usePaywall — the one badge every locked surface wears, and the
// bus that opens the paywall sheet from anywhere. (Build-80 plan, staged: while
// ENTITLEMENTS_ENFORCED is false nothing in the app renders these.)

import React, { useEffect, useReducer } from "react";
import { StyleSheet, Text, View, ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import {
  isUnlocked,
  subscribeEntitlement,
  type PremiumFeature,
} from "./entitlements";

// ── paywall bus (same Set<Listener> pattern as voiceBus) ─────────────────────
type PaywallListener = (feature: PremiumFeature) => void;
const paywallListeners = new Set<PaywallListener>();
export function openPaywall(feature: PremiumFeature) {
  paywallListeners.forEach((l) => l(feature));
}
export function subscribePaywall(fn: PaywallListener): () => void {
  paywallListeners.add(fn);
  return () => paywallListeners.delete(fn);
}

// Re-render callers when the tier changes.
export function useEntitlementVersion(): number {
  const [v, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeEntitlement(bump), []);
  return v;
}

// Returns unlocked-state for a feature, live across tier changes.
export function useFeature(feature: PremiumFeature): boolean {
  useEntitlementVersion();
  return isUnlocked(feature);
}

// ── the badge ────────────────────────────────────────────────────────────────
// Gold pill, sized for a corner overlay. Keep it SMALL — it labels, it doesn't
// shout; the paywall does the selling.
export function PremiumBadge({
  size = "sm",
  style,
}: {
  size?: "sm" | "md";
  style?: ViewStyle;
}) {
  const sm = size === "sm";
  return (
    <LinearGradient
      colors={["#F6D77A", "#E0A93E", "#B97F1F"]}
      start={{ x: 0, y: 0 }}
      end={{ x: 0, y: 1 }}
      style={[styles.pill, sm ? styles.pillSm : styles.pillMd, style]}
    >
      <Ionicons name="diamond" size={sm ? 8 : 10} color="#3A2A05" />
      <Text style={[styles.label, sm ? styles.labelSm : styles.labelMd]}>PREMIUM</Text>
    </LinearGradient>
  );
}

// Absolute-positioned corner variant for dropping onto option tiles/cards.
export function PremiumCornerBadge({ style }: { style?: ViewStyle }) {
  return (
    <View pointerEvents="none" style={[styles.corner, style]}>
      <PremiumBadge size="sm" />
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.35)",
  },
  pillSm: { paddingHorizontal: 6, paddingVertical: 2, gap: 3 },
  pillMd: { paddingHorizontal: 9, paddingVertical: 3.5, gap: 4 },
  label: { color: "#3A2A05", fontWeight: "800", letterSpacing: 0.6 },
  labelSm: { fontSize: 8 },
  labelMd: { fontSize: 10 },
  corner: { position: "absolute", top: 6, right: 6, zIndex: 5 },
});
