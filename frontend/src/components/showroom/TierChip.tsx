// showroom/TierChip.tsx — the header's right-hand chip (2026-09-22).
// FREE / SILVER / GOLD in that metal — the word is the fact, the metal only reinforces it (DESIGN.md §3).
// Ultra's chip is the scan allowance instead: one pip per included scan, lit while it is unused.

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { skin } from "../../tierTheme";
import SkinSheen from "../SkinSheen";
import { withAlpha } from "../../appSkin";
import { ULTRA } from "../../pricing";
import type { GarageTier } from "../../garageCars";
import { garageMetal, TIER_WORD } from "./tier";

export default function TierChip({ tier, scansLeft }: { tier: GarageTier; scansLeft: number }) {
  const sk = skin(garageMetal(tier));
  if (tier === "ultra") {
    const total = ULTRA.includedScansPerYear;
    const left = Math.max(0, Math.min(total, scansLeft));
    return (
      <View
        style={[styles.scanChip, { borderColor: withAlpha(sk.accent, 0.35), backgroundColor: withAlpha(sk.accent, 0.08) }]}
        accessibilityLabel={`Ultra — ${left} of ${total} scans left this year`}
      >
        <View style={styles.pips}>
          {Array.from({ length: total }, (_, i) => (
            <View
              key={i}
              style={[
                styles.pip,
                i < left ? { backgroundColor: sk.accent } : { borderWidth: 1, borderColor: sk.accent },
              ]}
            />
          ))}
        </View>
        <Text style={[styles.scanText, { color: sk.accent }]}>{total} scans</Text>
      </View>
    );
  }
  return (
    <LinearGradient
      colors={sk.colors}
      locations={sk.locations}
      style={[styles.chip, { borderColor: sk.rim }]}
    >
      <SkinSheen sk={sk} />
      <Text style={[styles.word, { color: sk.ink }]}>{TIER_WORD[tier]}</Text>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  chip: {
    height: 28,
    borderRadius: 14,
    paddingHorizontal: 12,
    borderWidth: 1,
    justifyContent: "center",
    overflow: "hidden",
  },
  word: { fontSize: 11, fontWeight: "800", letterSpacing: 1.4 },
  scanChip: {
    height: 28,
    borderRadius: 14,
    paddingHorizontal: 10,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pips: { flexDirection: "row", gap: 4 },
  pip: { width: 8, height: 8, transform: [{ rotate: "45deg" }] },
  scanText: { fontSize: 12, fontWeight: "700" },
});
