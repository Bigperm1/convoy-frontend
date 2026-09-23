// showroom/UpNextCard.tsx — the ONE "Up next" card (2026-09-22). Never a pop-up: it sits under the
// button and says what the next rung adds and costs. It is a paywall surface, so it wears the FEATURE's
// metal and H (useFeatureTier in the caller), never the page's (DESIGN.md §4, §7).
// For Ultra it is the scan tray instead — "+ Scan another car" — which goes to the scan flow, never a
// paywall.

import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { skin, type VisualTier } from "../../tierTheme";
import { withAlpha } from "../../appSkin";
import { TierLock } from "../../PremiumBadge";
import type { UpNext } from "./tier";

export default function UpNextCard({ copy, variant, metal, lockTier, onPress }: {
  copy: UpNext;
  variant: "upsell" | "scan";
  /** upsell: the next rung's metal (from useFeatureTier) · scan: the page metal. */
  metal: VisualTier;
  /** The H that states the rung (upsell only). */
  lockTier?: "premium" | "ultra";
  onPress: () => void;
}) {
  const sk = skin(metal);
  if (variant === "scan") {
    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onPress}
        style={[styles.card, styles.scanCard, { borderColor: withAlpha(sk.accent, 0.45) }]}
        accessibilityRole="button"
      >
        <View style={[styles.plus, { borderColor: withAlpha(sk.accent, 0.45) }]}>
          <Ionicons name="add" size={22} color={sk.accent} />
        </View>
        <View style={styles.text}>
          <Text style={styles.title}>{copy.title}</Text>
          <Text style={styles.body}>{copy.body}</Text>
        </View>
      </TouchableOpacity>
    );
  }
  return (
    <TouchableOpacity activeOpacity={0.9} onPress={onPress} accessibilityRole="button">
      <View style={[styles.card, { borderColor: withAlpha(sk.accent, 0.6) }]}>
        <LinearGradient
          colors={[withAlpha(sk.accent, 0.1), "rgba(0,0,0,0)"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0.7, y: 0.9 }}
          style={StyleSheet.absoluteFill}
        />
        {lockTier ? <TierLock tier={lockTier} size={40} /> : null}
        <View style={styles.text}>
          <Text style={[styles.label, { color: sk.accent }]}>{copy.label}</Text>
          <Text style={styles.title}>{copy.title}</Text>
          <Text style={styles.body}>{copy.body}</Text>
        </View>
        <LinearGradient
          colors={sk.colors}
          locations={sk.locations}
          style={[styles.cta, { borderColor: sk.rim }]}
        >
          <Text style={[styles.ctaText, { color: sk.ink }]}>{copy.cta}</Text>
        </LinearGradient>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    overflow: "hidden",
  },
  scanCard: { borderStyle: "dashed" },
  plus: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { flex: 1, gap: 2 },
  label: { fontSize: 10, fontWeight: "800", letterSpacing: 1.4 },
  title: { fontSize: 15, fontWeight: "700", color: "#F4FDFF" },
  body: { fontSize: 12, lineHeight: 16, color: "#8FA6B8" },
  cta: {
    height: 32,
    borderRadius: 16,
    paddingHorizontal: 12,
    borderWidth: 1,
    justifyContent: "center",
    overflow: "hidden",
  },
  ctaText: { fontSize: 13, fontWeight: "800" },
});
