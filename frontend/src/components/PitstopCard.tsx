// PitstopCard — the live stopwatch that appears when the car is parked at a gas
// station or a food stop. See src/pitstop.ts for the detection and for why this is
// informational only (the arrival clock already absorbs a stop by itself).
//
// Deliberately styled as its own thing rather than another frosted HUD chip: a pitstop
// is an EVENT, not a readout, so it gets the brand green and a pulsing dot. Same glass
// lift rule as everything else though — `glassLift` (iOS shadow, no Android elevation),
// because an elevation shadow under a translucent surface is what produced the Android
// "two shades" bug.
import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet, Animated, Easing } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { GlassFill, glassLift } from "../Glass";
import { fmtPitstop, type PitstopKind } from "../pitstop";

// Candy red — the SAME red as UpdateReadyPill's banner, so the app has one "attention"
// red rather than two near-misses.
const CANDY_RED = "#E4002B";

const ICON: Record<PitstopKind, any> = {
  gas: "gas-station",
  food: "silverware-fork-knife",
  coffee: "coffee",
  rest: "parking",
};

const TITLE: Record<PitstopKind, string> = {
  gas: "Fuel stop",
  food: "Food stop",
  coffee: "Coffee stop",
  rest: "Pitstop",
};

export default function PitstopCard({
  kind, label, elapsedS, totalS, tint,
}: {
  kind: PitstopKind;
  label: string;
  elapsedS: number;
  totalS: number;
  tint?: string;
}) {
  // Slow pulse on the dot so the card reads as LIVE at a glance, without the
  // attention-grabbing flash of anything safety-related.
  const pulse = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={[styles.wrap, glassLift]}>
      <GlassFill tintColor={tint} style={{ borderRadius: 16, overflow: "hidden" }} />
      <View style={styles.row}>
        <View style={styles.iconWrap}>
          <MaterialCommunityIcons name={ICON[kind] || "parking"} size={20} color="#2DEC86" />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.titleRow}>
            <Animated.View style={[styles.dot, { opacity: pulse }]} />
            <Text style={styles.title} numberOfLines={1}>
              {TITLE[kind] || "Pitstop"}
              {label ? ` · ${label}` : ""}
            </Text>
          </View>
          {totalS > 0 && (
            <Text style={styles.sub} numberOfLines={1}>
              {fmtPitstop(totalS)} stopped this drive
            </Text>
          )}
        </View>
        <Text style={styles.clock}>{fmtPitstop(elapsedS)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(45,236,134,0.45)",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  iconWrap: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(45,236,134,0.14)",
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  // Candy red for the live pulse — same red as the UpdateReadyPill, and it pairs with
  // the running clock below so the two read as one "timer is running" unit.
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: CANDY_RED },
  title: { color: "#FFFFFF", fontSize: 13.5, fontWeight: "700", letterSpacing: -0.2, flexShrink: 1 },
  sub: { color: "#FFFFFF", opacity: 0.75, fontSize: 11, fontWeight: "600", marginTop: 2 },
  // The countdown itself is CANDY RED (Jeff, 2026-07-27) — a pitstop clock is a race
  // clock, and red reads as "time is running" where the brand green read as "all good".
  // Tabular figures so the seconds don't jitter the layout as they tick.
  clock: {
    color: CANDY_RED, fontSize: 22, fontWeight: "800", letterSpacing: -0.5,
    fontVariant: ["tabular-nums"],
  },
});
