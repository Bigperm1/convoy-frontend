// HazardSheet.tsx — the phone's Report sheet: the head unit's Report grid, on the phone (Jeff, 2026-09-24:
// "WHERE IS THE HAZARDS BUTTON ON THE PHONE?" — the panel had shipped for CarPlay / Android Auto only, and the
// phone's own Police/Hazard drawer had been dormant since the police FAB became Crew on 07-23: reporting was voice-only).
//
// FOUR SURFACES: the tiles ARE the head unit's (src/carplay/hazardPanel.ts HAZARD_TILES, the report kinds only —
// the phone keeps its compass FAB, so no compass tile here), the art is the same direction-B Apple-symbol glyph
// set in the driver's metal (assets/carplay-glyphs/report), the shape is the Hairpin square (DESIGN.md § Shape:
// radius ≈ 28 % of height). A tile reports at the car's position from 5 s ago through map.tsx's reportHazard —
// the same POST /hazards the voice intents use — and closes the sheet; the confirmation is the ReportToast pill.
import React, { useEffect, useRef } from "react";
import { Animated, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import Glass from "../Glass";
import { PressableScale } from "../ui/PressableScale";
import { useAppSkin } from "../appSkin";
import { haptics } from "../haptics";
import { HAZARD_TILES, type HazardKind, type HazardGlyph } from "../carplay/hazardPanel";
import type { VisualTier } from "../tierTheme";

/** The report glyphs per metal — the same PNGs the head unit bakes into carButtonIcons.ts. */
export const HAZARD_ART: Record<Exclude<HazardGlyph, "hz_camera" | "hz_compass">, Record<VisualTier, number>> = {
  hz_police:  { brand: require("../../assets/carplay-glyphs/report/police_green.png"),  premium: require("../../assets/carplay-glyphs/report/police_silver.png"),  ultra: require("../../assets/carplay-glyphs/report/police_gold.png"),  diamond: require("../../assets/carplay-glyphs/report/police_diamond.png") },
  hz_crash:   { brand: require("../../assets/carplay-glyphs/report/crash_green.png"),   premium: require("../../assets/carplay-glyphs/report/crash_silver.png"),   ultra: require("../../assets/carplay-glyphs/report/crash_gold.png"),   diamond: require("../../assets/carplay-glyphs/report/crash_diamond.png") },
  hz_hazard:  { brand: require("../../assets/carplay-glyphs/report/hazard_green.png"),  premium: require("../../assets/carplay-glyphs/report/hazard_silver.png"),  ultra: require("../../assets/carplay-glyphs/report/hazard_gold.png"),  diamond: require("../../assets/carplay-glyphs/report/hazard_diamond.png") },
  hz_traffic: { brand: require("../../assets/carplay-glyphs/report/traffic_green.png"), premium: require("../../assets/carplay-glyphs/report/traffic_silver.png"), ultra: require("../../assets/carplay-glyphs/report/traffic_gold.png"), diamond: require("../../assets/carplay-glyphs/report/traffic_diamond.png") },
};
/** The map button's own art: the hazard triangle in the metal (the head unit's car-hazards button). */
export const HAZARD_FAB_ART = HAZARD_ART.hz_hazard;

const REPORT_TILES = HAZARD_TILES.filter((t): t is typeof t & { kind: HazardKind; glyph: keyof typeof HAZARD_ART } => t.kind != null && t.glyph in HAZARD_ART);
const TILE = 76;                      // pt; the Hairpin square radius is 28 % of it
const TILE_RADIUS = Math.round(TILE * 0.28);

export default function HazardSheet({ visible, onClose, onReport }: {
  visible: boolean;
  onClose: () => void;
  onReport: (kind: HazardKind) => void;
}) {
  const metal = useAppSkin();
  const y = useRef(new Animated.Value(40)).current;
  useEffect(() => {
    if (!visible) { y.setValue(40); return; }
    // Enter: a short critically-damped settle from just below (DESIGN.md §11.2 — no bounce, nothing was thrown).
    Animated.spring(y, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 260, mass: 1 }).start();
  }, [visible, y]);
  if (!visible) return null;
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable testID="hazard-sheet-backdrop" style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <Animated.View style={[styles.sheetWrap, { transform: [{ translateY: y }] }]}>
          {/* Stop backdrop taps inside the panel */}
          <Pressable onPress={() => {}} testID="hazard-sheet">
            <Glass radius={26}>
              <View style={styles.inner}>
                <Text maxFontSizeMultiplier={1.2} style={styles.title}>Report</Text>
                <View style={styles.row}>
                  {REPORT_TILES.map((t) => (
                    <PressableScale
                      key={t.id}
                      testID={`report-${t.kind}`}
                      style={styles.tile}
                      accessibilityLabel={`Report ${t.title}`}
                      onPress={() => { haptics.snap(); onReport(t.kind); }}
                    >
                      <View style={styles.tileFace}>
                        <Image source={HAZARD_ART[t.glyph][metal]} style={styles.glyph} resizeMode="contain" />
                      </View>
                      <Text maxFontSizeMultiplier={1.2} style={styles.label}>{t.title}</Text>
                    </PressableScale>
                  ))}
                </View>
                <Text maxFontSizeMultiplier={1.2} style={styles.hint}>Pinned where you were 5 seconds ago. The crew sees it right away.</Text>
              </View>
            </Glass>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.42)" },
  sheetWrap: { paddingHorizontal: 12, paddingBottom: 28 },
  inner: { paddingTop: 16, paddingBottom: 14, paddingHorizontal: 14 },
  title: { color: "#F4F4F4", fontSize: 20, fontWeight: "700", letterSpacing: -0.2, textAlign: "center", marginBottom: 14 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  tile: { flex: 1, alignItems: "center", gap: 8 },
  tileFace: {
    width: TILE, height: TILE, borderRadius: TILE_RADIUS,
    backgroundColor: "rgba(255,255,255,0.07)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.16)",
    alignItems: "center", justifyContent: "center",
  },
  glyph: { width: 46, height: 46 },
  label: { color: "#E5E5EA", fontSize: 13, fontWeight: "600" },
  hint: { color: "#8E8E93", fontSize: 12, textAlign: "center", marginTop: 14 },
});
