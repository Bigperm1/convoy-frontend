// src/CarDriveList.tsx
//
// The phone's face while a HEAD UNIT is navigating (Jeff, 2026-08-16: "when the
// carplay route is connected the phone switches to turn by turn written directions
// in sequential order"). Rendered by map.tsx INSTEAD of ConvoyMapbox whenever
// CarPlay/AA is attached and turn-by-turn is active — the map is on the car screen,
// so the phone showing a second live map buys nothing and costs half the measured
// heat load: unmounting the phone's Mapbox instance kills one of the two ~60 Hz
// camera pumps AND the entire second GL engine (heat probe, 2026-08-15: ~115
// setCamera/s from exactly two per-instance rAF loops).
//
// Deliberately DUMB: no map, no GL, no timers, no animation. Everything live in it
// (current step, distances, ETA) re-renders off the same tbt/coords ticks map.tsx
// already has. The only state is scroll position.

import React, { useEffect, useRef } from "react";
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { GlassFill } from "./Glass";
import { ManeuverArrow, maneuverDir } from "./components/ManeuverArrow";
import { COLORS } from "./theme";
import { NavStep, maneuverVerb, fmtDistanceM, fmtManeuverDist, fmtEtaSec } from "./nav";

const strip = (h?: string) => (h || "").replace(/<[^>]+>/g, "").trim();

export default function CarDriveList(props: {
  steps: NavStep[];
  stepIndex: number;            // tbt.stepIndex — the step the driver is ON; +1 is the upcoming maneuver
  distanceToManeuverM: number;
  distanceRemainingM: number;
  etaSeconds: number;
  arrivalText: string;          // formatted clock time — fmtClock lives in map.tsx
  destinationLabel?: string;
  // Mid-drive reroute offer. The map used to be the tap surface for these (they draw
  // inline on the route line, ConvoyMapbox ~:3173) — with the map unmounted, the
  // voice yes/no still works but a muted driver would have NO way to answer. This
  // banner is that tap fallback.
  offer?: { title: string; subtitle: string } | null;
  onOfferAccept?: () => void;
  onOfferDismiss?: () => void;
  onShowMap: () => void;
  onEnd: () => void;
}) {
  const { steps, stepIndex } = props;
  // The row that matters is the UPCOMING maneuver — same +1 convention as the
  // phone banner and the car strip (map.tsx:4406).
  const upcomingIdx = Math.min(stepIndex + 1, Math.max(0, steps.length - 1));
  const listRef = useRef<FlatList<NavStep>>(null);
  useEffect(() => {
    // Keep the upcoming step in view, one row of context above it. scrollToIndex
    // can throw before first layout on variable-height rows — a missed scroll is
    // cosmetic, never worth a crash.
    try { listRef.current?.scrollToIndex({ index: Math.max(0, upcomingIdx - 1), animated: true, viewPosition: 0 }); } catch {}
  }, [upcomingIdx]);

  return (
    <View style={styles.root} pointerEvents="auto">
      <View style={styles.header}>
        <Text style={styles.onCar}>NAVIGATION IS ON YOUR CAR SCREEN</Text>
        <Text style={styles.eta}>
          {fmtEtaSec(props.etaSeconds)} · {fmtDistanceM(props.distanceRemainingM)} · arrive {props.arrivalText}
        </Text>
        {!!props.destinationLabel && <Text style={styles.dest} numberOfLines={1}>{props.destinationLabel}</Text>}
      </View>
      {!!props.offer && (
        <View style={styles.offer}>
          <View style={styles.rowBody}>
            <Text style={styles.offerTitle}>{props.offer.title}</Text>
            <Text style={styles.offerSub} numberOfLines={1}>{props.offer.subtitle}</Text>
          </View>
          <Pressable onPress={props.onOfferDismiss} style={styles.btnGhostSm} hitSlop={8}>
            <Text style={styles.btnGhostText}>No</Text>
          </Pressable>
          <Pressable onPress={props.onOfferAccept} style={styles.btnGoSm} hitSlop={8}>
            <Text style={styles.btnGoText}>Switch</Text>
          </Pressable>
        </View>
      )}
      <FlatList
        ref={listRef}
        data={steps}
        keyExtractor={(_, i) => String(i)}
        onScrollToIndexFailed={() => {}}
        contentContainerStyle={styles.listPad}
        renderItem={({ item, index }) => {
          const current = index === upcomingIdx;
          const past = index < upcomingIdx;
          return (
            <View style={[styles.row, current && styles.rowCurrent, past && styles.rowPast]}>
              {/* Green square arrow — the EXACT component + colors the banner's
                  maneuver box uses (ManeuverArrow, dark glyph on brand green), so
                  the two can never disagree about a turn's direction. */}
              <View style={styles.arrowBox}>
                <ManeuverArrow dir={maneuverDir(strip(item.html), item.maneuver)} size={20} color="#0B0B0C" />
              </View>
              <View style={styles.rowBody}>
                <Text style={[styles.rowText, current && styles.rowTextCurrent]}>
                  {strip(item.html) || maneuverVerb(item.maneuver)}
                </Text>
              </View>
              <Text style={[styles.rowDist, current && styles.rowDistCurrent]}>
                {current ? fmtManeuverDist(props.distanceToManeuverM) : item.distance_text}
              </Text>
            </View>
          );
        }}
      />
      <View style={styles.footer}>
        <Pressable onPress={props.onShowMap} style={styles.btnGhost} hitSlop={8}>
          <Text style={styles.btnGhostText}>Show map</Text>
        </Pressable>
      </View>
      {/* END — square, candy red, directly under the Hairpin logo and matching its
          exact footprint (mapLogoBacking: 50×50 r14 at right 12, top 52/28 — the
          logo is zIndex 100 so it paints above this screen, which is deliberate).
          Named "End" to match CarPlay/AA. */}
      <Pressable onPress={props.onEnd} style={styles.endSquare} hitSlop={8}>
        {/* The CANDY-APPLE construction, copied exactly from StepDrawer's End circle
            (Jeff, 2026-08-16: "way more premium looking" — the premium is not the hex,
            it's the bright→deep gradient + red-tinted glass sheen + rosy border). */}
        <LinearGradient
          colors={["#FF3B5C", "#E4002B", "#B00020"]}
          locations={[0, 0.5, 1]}
          style={[StyleSheet.absoluteFill, { borderRadius: 14 }]}
        />
        <GlassFill tintColor="#E4002B" style={{ borderRadius: 14, overflow: "hidden" }} />
        <Text style={styles.endSquareText}>End</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Opaque, above the map overlays (they stay mounted beneath; zIndex wins among
  // siblings). Modals/sheets still present above via the native modal layer.
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: COLORS.bg, zIndex: 50, elevation: 50 },
  // paddingRight clears the logo + End column on the right edge.
  header: { paddingTop: Platform.OS === "ios" ? 64 : 40, paddingLeft: 20, paddingRight: 76, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: COLORS.hairline },
  onCar: { color: COLORS.brand, fontSize: 12, fontWeight: "800", letterSpacing: 1.2 },
  eta: { color: "#F4F4F4", fontSize: 22, fontWeight: "800", marginTop: 8 },
  dest: { color: "#9BA1A6", fontSize: 14, fontWeight: "600", marginTop: 2 },
  listPad: { paddingVertical: 8, paddingBottom: 120 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: 20, gap: 12 },
  rowCurrent: { backgroundColor: "rgba(45,236,134,0.08)", borderLeftWidth: 3, borderLeftColor: COLORS.brand },
  rowPast: { opacity: 0.35 },
  // Mirrors the banner's green maneuver box (30×30 r8, brand green, dark glyph).
  arrowBox: { width: 30, height: 30, borderRadius: 8, backgroundColor: COLORS.brand, alignItems: "center", justifyContent: "center" },
  rowBody: { flex: 1, minWidth: 0 },
  rowText: { color: "#D7DBDE", fontSize: 16, fontWeight: "600" },
  rowTextCurrent: { color: "#FFFFFF", fontSize: 18, fontWeight: "800" },
  rowDist: { color: "#9BA1A6", fontSize: 13, fontWeight: "700" },
  rowDistCurrent: { color: COLORS.brand, fontSize: 15, fontWeight: "800" },
  footer: {
    position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", gap: 12,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 34, backgroundColor: COLORS.bg,
    borderTopWidth: 1, borderTopColor: COLORS.hairline,
  },
  btnGhost: { flex: 1, height: 48, borderRadius: 12, borderWidth: 1, borderColor: COLORS.hairlineStrong, alignItems: "center", justifyContent: "center" },
  btnGhostText: { color: "#F4F4F4", fontSize: 16, fontWeight: "700" },
  // Same footprint as mapLogoBacking (50×50 r14, right 12), stacked 8pt beneath it.
  // Container transparent + clipped: the color is the candy gradient child.
  endSquare: {
    position: "absolute", right: 12, top: (Platform.OS === "ios" ? 52 : 28) + 50 + 8,
    width: 50, height: 50, borderRadius: 14, backgroundColor: "transparent",
    overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,90,120,0.9)",
    alignItems: "center", justifyContent: "center", zIndex: 60,
  },
  endSquareText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  offer: {
    flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, marginTop: 10,
    padding: 12, borderRadius: 12, borderWidth: 1, borderColor: COLORS.brandDim,
    backgroundColor: "rgba(45,236,134,0.10)",
  },
  offerTitle: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  offerSub: { color: "#9BA1A6", fontSize: 12, fontWeight: "600", marginTop: 1 },
  btnGhostSm: { height: 38, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: COLORS.hairlineStrong, alignItems: "center", justifyContent: "center" },
  btnGoSm: { height: 38, paddingHorizontal: 16, borderRadius: 10, backgroundColor: COLORS.brand, alignItems: "center", justifyContent: "center" },
  btnGoText: { color: "#04160C", fontSize: 15, fontWeight: "800" },
});
