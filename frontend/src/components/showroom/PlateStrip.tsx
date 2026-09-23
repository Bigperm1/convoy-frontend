// showroom/PlateStrip.tsx — the licence plate under the stage (2026-09-22).
//
// The CALL SIGN moved here from its own form field: it is the name every other driver sees on the map,
// so it reads as the car's plate. Tapping the plate opens Customize, where it is edited and saved
// (the old explicit-Save path: settings + PUT /auth/profile {handle} + refresh()).

import React from "react";
import { Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { skin, type VisualTier } from "../../tierTheme";

export type PlateFact = { value: string; label: string };

export default function PlateStrip({ callSign, metal, facts, onPress }: {
  callSign: string;
  metal: VisualTier;
  facts: PlateFact[];
  onPress: () => void;
}) {
  const sk = skin(metal);
  const sign = callSign.trim();
  return (
    <View style={styles.row}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onPress}
        style={[styles.plate, { borderColor: sk.accent }]}
        accessibilityRole="button"
        accessibilityLabel={sign ? `Call sign ${sign}. Change it in Customize` : "Set your call sign"}
      >
        <Text style={styles.plateTop}>HAIRPIN</Text>
        <Text style={[styles.plateSign, !sign && styles.plateEmpty]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
          {sign ? sign.toUpperCase() : "SET YOURS"}
        </Text>
      </TouchableOpacity>
      {facts.slice(0, 2).map((f) => (
        <View key={f.label} style={styles.fact}>
          <Text style={styles.factValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{f.value}</Text>
          <Text style={styles.factLabel} numberOfLines={1}>{f.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 16, paddingTop: 12 },
  plate: {
    width: 112,
    height: 42,
    borderRadius: 6,
    borderWidth: 2,
    backgroundColor: "#F4FDFF",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  plateTop: { fontSize: 7, fontWeight: "700", letterSpacing: 1, color: "#5B6770" },
  plateSign: {
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: 2,
    color: "#0B0C0E",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  plateEmpty: { fontSize: 12, letterSpacing: 1, color: "#5B6770" },
  fact: { flexShrink: 1 },
  factValue: { fontSize: 13, fontWeight: "700", color: "#F4FDFF" },
  factLabel: { fontSize: 11, color: "#6F8597" },
});
