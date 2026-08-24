// PremiumBadge + usePaywall — the one badge every locked surface wears, and the
// bus that opens the paywall sheet from anywhere. (Build-80 plan, staged: while
// ENTITLEMENTS_ENFORCED is false nothing in the app renders these.)

import React, { useEffect, useReducer } from "react";
import { Image, StyleSheet, Text, View, type ImageStyle, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import {
  featureTier,
  isUnlocked,
  subscribeEntitlement,
  type PremiumFeature,
} from "./entitlements";
import { skin, tierH, type VisualTier } from "./tierTheme";

/** The tier that would unlock a feature, live across tier changes. */
export function useFeatureTier(feature: PremiumFeature): "premium" | "ultra" {
  useEntitlementVersion();
  return featureTier(feature);
}

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

// ── the H lock ───────────────────────────────────────────────────────────────
// The Hairpin H, cut from the brand mark and re-metalled: SILVER = Premium,
// GOLD = Ultra Premium. Jeff, 2026-08-23 — "as them being the locks."
//
// A padlock says "you can't have this". The H says "this is the part of Hairpin
// you haven't got yet", which is the thing we actually want to sell. Same mark
// the app wears everywhere, in a different metal.
export function TierLock({
  tier,
  size = 22,
  style,
}: {
  tier: "premium" | "ultra";
  size?: number;
  style?: ImageStyle;
}) {
  return (
    <Image
      source={tierH(tier)}
      style={[{ width: size, height: size }, style]}
      resizeMode="contain"
      accessibilityLabel={tier === "ultra" ? "Ultra Premium" : "Premium"}
    />
  );
}

/** Corner-mounted H lock for option tiles and cards. */
export function TierCornerLock({
  tier,
  size = 22,
  style,
}: {
  tier: "premium" | "ultra";
  size?: number;
  style?: ViewStyle;
}) {
  return (
    <View pointerEvents="none" style={[styles.corner, style]}>
      <TierLock tier={tier} size={size} />
    </View>
  );
}

// ── the badge ────────────────────────────────────────────────────────────────
// Metal pill, sized for a corner overlay or a page header. Keep it SMALL — it
// labels, it doesn't shout; the paywall does the selling. `tier` picks the metal
// AND the words: silver/PREMIUM or gold/ULTRA PREMIUM. Before 2026-08-23 there
// was one gold pill reading PREMIUM on both, which told customers the Class
// marker and the exact-car scan were the same purchase.
export function PremiumBadge({
  size = "sm",
  tier = "ultra",
  style,
}: {
  size?: "sm" | "md";
  tier?: "premium" | "ultra";
  style?: ViewStyle;
}) {
  const sm = size === "sm";
  const sk = skin(tier);
  return (
    <LinearGradient
      colors={sk.colors}
      locations={sk.locations}
      start={{ x: 0, y: 0 }}
      end={{ x: 0, y: 1 }}
      style={[styles.pill, sm ? styles.pillSm : styles.pillMd, { borderColor: sk.rim }, style]}
    >
      <Ionicons name="diamond" size={sm ? 8 : 10} color={sk.ink} />
      <Text style={[styles.label, sm ? styles.labelSm : styles.labelMd, { color: sk.ink }]}>
        {sk.label.toUpperCase()}
      </Text>
    </LinearGradient>
  );
}

// Absolute-positioned corner variant for dropping onto option tiles/cards.
export function PremiumCornerBadge({
  tier = "ultra",
  style,
}: {
  tier?: "premium" | "ultra";
  style?: ViewStyle;
}) {
  return (
    <View pointerEvents="none" style={[styles.corner, style]}>
      <PremiumBadge size="sm" tier={tier} />
    </View>
  );
}

// ── page title ───────────────────────────────────────────────────────────────
// Jeff, 2026-08-23: every Ultra Premium page says "Ultra Premium" at the top,
// every Premium page says "Premium". The customer should never have to infer
// which tier a screen belongs to from its colour alone.
export function TierTitle({ tier, style }: { tier: VisualTier; style?: ViewStyle }) {
  const sk = skin(tier);
  if (tier === "brand") return null;
  return (
    <View style={[styles.titleRow, style]}>
      <TierLock tier={tier} size={17} />
      <Text style={[styles.titleText, { color: sk.accent }]}>{sk.label.toUpperCase()}</Text>
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
  label: { fontWeight: "800", letterSpacing: 0.6 },
  labelSm: { fontSize: 8 },
  labelMd: { fontSize: 10 },
  corner: { position: "absolute", top: 6, right: 6, zIndex: 5 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  titleText: { fontSize: 12.5, fontWeight: "800", letterSpacing: 1.6 },
});
