// HazardCard.tsx — the tapped-pin card ("Remove my alert" for your own pin, "Gone" / "Still there" for someone
// else's) and the pass-by "still there?" prompt, as ONE card that looks and sits exactly like the Report panel
// (Jeff, 2026-09-25: "redo the remove pin panel and make it like the other hazard panel and in the same spot same
// opacity. With the new glyph and a bigger remove button"). Same transparent Modal, same anchor above the FAB
// stack, same weather-card floor; the glyph tile wears the kind's category colour (src/hazardPalette.ts).
import React from "react";
import { Image, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassFill, hudTint } from "../Glass";
import { PressableScale } from "../ui/PressableScale";
import { useAppSkin } from "../appSkin";
import { haptics } from "../haptics";
import { hazardPaint } from "../hazardPalette";
import { HAZARD_ART } from "./HazardSheet";
import { COLORS } from "../theme";

export type HazardCardHazard = { id: string; kind: string; reporter_handle?: string; confirms?: number; disputes?: number };

const CARD_W = 376;
const SIDE = 12;
const GAP_ABOVE_STACK = 10;
const TOP_CLEAR = 120;
const CARD_H_GUESS = 170;
const TILE = 64;
const TILE_RADIUS = Math.round(TILE * 0.28);
const BTN_H = 52;
const BTN_RADIUS = Math.round(BTN_H * 0.28);

function rgba(hex: string, a: number): string {
  const h = hex.replace("#", ""); const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export default function HazardCard({ hazard, mode, mine, anchorBottom, onClose, onRemove, onGone, onStillThere }: {
  hazard: HazardCardHazard | null;
  /** detail = a tapped pin; passby = the "still there?" prompt Scout's call brings up. */
  mode: "detail" | "passby";
  mine: boolean;
  /** Distance from the map's bottom edge to the TOP of the FAB stack (map.tsx controlsBottom + fabStackH). */
  anchorBottom: number;
  onClose: () => void;
  onRemove?: () => void;
  onGone?: () => void;
  onStillThere?: () => void;
}) {
  const metal = useAppSkin();
  const { width: winW, height: winH } = useWindowDimensions();
  const [cardH, setCardH] = React.useState(CARD_H_GUESS);
  // Folds itself away after 15 s like the pass-by prompt always has — a card left open must never sit over guidance.
  const onCloseRef = React.useRef(onClose); onCloseRef.current = onClose;
  const hid = hazard?.id ?? null;
  React.useEffect(() => {
    if (!hid) return;
    const t = setTimeout(() => onCloseRef.current(), 15000);
    return () => clearTimeout(t);
  }, [hid, mode]);
  if (!hazard) return null;
  const paint = hazardPaint(hazard.kind);
  const cardW = Math.min(CARD_W, winW - SIDE * 2);
  const bottom = Math.min(anchorBottom + GAP_ABOVE_STACK, Math.max(0, winH - TOP_CLEAR - cardH));
  const title = mode === "passby" ? `${paint.label} ahead — still there?` : paint.label;
  const sub = mode === "passby" ? "Help the crew keep alerts accurate" : `by ${hazard.reporter_handle || "anon"}`;
  const act = (fn?: () => void) => () => { haptics.snap(); fn?.(); };
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent hardwareAccelerated>
      <Pressable testID="hazard-card-backdrop" style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
      <View
        testID={`hazard-card-${mode}`}
        onLayout={(e) => { const h = Math.round(e.nativeEvent.layout.height); if (h > 0 && h !== cardH) setCardH(h); }}
        style={[styles.card, { width: cardW, left: Math.round((winW - cardW) / 2), bottom }]}
      >
        <GlassFill tintColor={hudTint()} style={StyleSheet.absoluteFill} />
        <View style={styles.head}>
          <View style={[styles.tileFace, { borderColor: rgba(paint.bright, 0.7), backgroundColor: rgba(paint.bright, 0.12) }]}>
            <Image source={HAZARD_ART[paint.glyph][metal]} style={[styles.glyph, { tintColor: paint.bright }]} resizeMode="contain" />
          </View>
          <View style={{ flex: 1 }}>
            <Text maxFontSizeMultiplier={1.2} style={styles.title} numberOfLines={2}>{title}</Text>
            <Text maxFontSizeMultiplier={1.2} style={styles.sub} numberOfLines={1}>{sub}</Text>
            {mode === "detail" && (
              <View style={styles.stats}>
                <View style={styles.stat}><Ionicons name="thumbs-up" size={11} color={COLORS.success} /><Text style={[styles.statText, { color: COLORS.success }]}>{hazard.confirms || 1}</Text></View>
                <View style={styles.stat}><Ionicons name="thumbs-down" size={11} color={COLORS.danger} /><Text style={[styles.statText, { color: COLORS.danger }]}>{hazard.disputes || 0}</Text></View>
              </View>
            )}
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={styles.close} accessibilityLabel="Close">
            <Ionicons name="close" size={20} color={COLORS.textDim} />
          </Pressable>
        </View>
        <View style={styles.btnRow}>
          {mine ? (
            <PressableScale testID={`remove-${hazard.id}`} style={[styles.btn, styles.btnRemove]} onPress={act(onRemove)} accessibilityLabel="Remove my alert">
              <Ionicons name="trash" size={19} color="#FF6961" />
              <Text style={[styles.btnText, { color: "#FF6961" }]}>Remove my alert</Text>
            </PressableScale>
          ) : (
            <>
              <PressableScale testID={`${mode === "passby" ? "pass-gone" : "dispute"}-${hazard.id}`} style={[styles.btn, styles.btnGone]} onPress={act(onGone)} accessibilityLabel="Gone">
                <Ionicons name="close-circle" size={19} color="#F4F4F4" />
                <Text style={styles.btnText}>Gone</Text>
              </PressableScale>
              <PressableScale testID={`${mode === "passby" ? "pass-stillthere" : "confirm"}-${hazard.id}`} style={[styles.btn, styles.btnStill]} onPress={act(onStillThere)} accessibilityLabel="Still there">
                <Ionicons name="checkmark-circle" size={19} color="#F4F4F4" />
                <Text style={styles.btnText}>Still there</Text>
              </PressableScale>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // = HazardSheet styles.card (= WeatherHUD styles.forecastCard): floor, hairline, radius, shadow.
  card: {
    position: "absolute", paddingHorizontal: 12, paddingTop: 12, paddingBottom: 12, borderRadius: 16, overflow: "hidden",
    backgroundColor: "rgba(24,24,28,0.66)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.14)",
    ...Platform.select({ ios: { shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } }, android: { elevation: 10 } }),
  },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  tileFace: { width: TILE, height: TILE, borderRadius: TILE_RADIUS, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  glyph: { width: 40, height: 40 },
  title: { color: "#F4F4F4", fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
  sub: { color: "#8E8E93", fontSize: 12, marginTop: 2 },
  stats: { flexDirection: "row", gap: 6, marginTop: 6 },
  stat: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.07)" },
  statText: { fontSize: 11, fontWeight: "700" },
  close: { padding: 4, alignSelf: "flex-start" },
  btnRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  btn: { flex: 1, height: BTN_H, borderRadius: BTN_RADIUS, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: StyleSheet.hairlineWidth },
  btnRemove: { backgroundColor: "rgba(255,69,58,0.18)", borderColor: "rgba(255,69,58,0.55)" },
  btnGone: { backgroundColor: "rgba(255,255,255,0.07)", borderColor: "rgba(255,255,255,0.18)" },
  btnStill: { backgroundColor: "rgba(48,209,88,0.22)", borderColor: "rgba(48,209,88,0.6)" },
  btnText: { color: "#F4F4F4", fontSize: 15, fontWeight: "700", letterSpacing: 0.2 },
});
