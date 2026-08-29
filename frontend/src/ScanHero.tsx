// ScanHero — the three states of the Garage "Your car" page that are NOT a model:
//
//   placeholder  →  3D is unlocked but no scan exists yet. An animated invitation,
//                   not dead text ("have a placeholder when the 3D is purchased" —
//                   Jeff, 2026-08-29).
//   building     →  a scan is submitted and the pipeline is rendering. A clock-style
//                   countdown ring anchored to carScanSubmittedAt. The estimate is
//                   HONEST guesswork (the measured render is ~4-6 min end to end), so
//                   when it runs out we do NOT pretend: the ring hands over to a
//                   pulsing "still building" state and the poll keeps checking.
//   ready        →  the one-shot celebration overlay: tells the driver what actually
//                   happened ("this is your marker on the map now") the FIRST time
//                   their car lands. Dismiss persists via settings.carScanCelebrated.
//
// The model itself (CarHero3D / the map marker) is rendered elsewhere — this file is
// only the states around it. Everything is gold on purpose: the scan is the Ultra
// feature, and DESIGN.md's rule is one metal per page.

import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import Svg, { Circle } from "react-native-svg";
import { skin } from "./tierTheme";
import { COLORS } from "./theme";
import { CandyCta } from "./components/CandyCta";

const GOLD = skin("ultra");

// The countdown's promise. Measured 2026-08-29 on the first real scan: generate ~3 min
// + two converts ~1 min + publish seconds. 6 minutes is the honest middle — long enough
// that most scans beat the clock (a countdown that regularly overruns reads as broken),
// short enough that the driver isn't staring at a 15-minute wall.
const SCAN_ESTIMATE_MS = 6 * 60 * 1000;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Animated invitation: 3D unlocked, no car yet. */
export function ScanPlaceholder() {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });
  const glow = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.6] });
  return (
    <View style={styles.fill}>
      <Animated.View style={[styles.pulseRing, { transform: [{ scale }], opacity: glow }]} />
      <Animated.View style={{ transform: [{ scale }] }}>
        <MaterialCommunityIcons name="car-sports" size={64} color={GOLD.accent} />
      </Animated.View>
      <Text style={styles.title}>Your car belongs here</Text>
      <Text style={styles.hint}>Four photos. A few minutes. Then it's your marker on the map.</Text>
    </View>
  );
}

/** Clock-style countdown while the pipeline renders. Anchored to submittedAt (ISO). */
export function ScanCountdown({ submittedAt }: { submittedAt?: string | null }) {
  // Lazy useState, NOT a render-time fallback: recomputing Date.now() on each 1 s
  // tick would pin elapsed at ~0 and freeze the ring at full forever (review find,
  // 2026-08-29). Captured once, the clock runs its full length and hands over to the
  // overtime state even with a missing/garbled stamp or a future-skewed clock.
  const [startMs] = useState(() => {
    const t = submittedAt ? Date.parse(submittedAt) : NaN;
    return Number.isFinite(t) && t <= Date.now() ? t : Date.now();
  });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, now - startMs);
  const remaining = SCAN_ESTIMATE_MS - elapsed;
  const overtime = remaining <= 0;

  // Overtime pulse — the honest "this one's taking longer" state.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!overtime) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [overtime, pulse]);

  const R = 74;
  const C = 2 * Math.PI * R;
  const frac = overtime ? 0 : remaining / SCAN_ESTIMATE_MS;
  const mm = Math.floor(Math.max(0, remaining) / 60000);
  const ss = Math.floor((Math.max(0, remaining) % 60000) / 1000);

  return (
    <View style={styles.fill}>
      <View style={{ width: 176, height: 176, alignItems: "center", justifyContent: "center" }}>
        <Svg width={176} height={176} viewBox="0 0 176 176">
          {/* dial */}
          <Circle cx={88} cy={88} r={R} stroke="rgba(224,169,62,0.18)" strokeWidth={7} fill="none" />
          {/* remaining arc, clock-style from 12 o'clock */}
          <AnimatedCircle
            cx={88} cy={88} r={R}
            stroke={GOLD.accent}
            strokeWidth={7}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${C} ${C}`}
            strokeDashoffset={C * (1 - frac)}
            transform="rotate(-90 88 88)"
          />
        </Svg>
        <View style={styles.clockCenter}>
          {overtime ? (
            <Animated.View style={{ opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }), alignItems: "center" }}>
              <Ionicons name="hammer" size={26} color={GOLD.accent} />
              <Text style={styles.clockOver}>still building</Text>
            </Animated.View>
          ) : (
            <>
              <Text style={styles.clockTime}>{mm}:{String(ss).padStart(2, "0")}</Text>
              <Text style={styles.clockUnder}>building</Text>
            </>
          )}
        </View>
      </View>
      <Text style={styles.title}>Building your car</Text>
      <Text style={styles.hint}>
        {overtime
          ? "Taking longer than usual — it'll appear the moment it's done."
          : "Rebuilding it in 3D from your four photos."}
      </Text>
    </View>
  );
}

/** One-shot "it's done, here's what that means" overlay. Parent persists the dismiss. */
export function ScanReadyOverlay({ onDismiss }: { onDismiss: () => void }) {
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 420, easing: Easing.out(Easing.back(1.4)), useNativeDriver: true }).start();
  }, [enter]);
  return (
    <Animated.View
      style={[styles.readyWrap, { opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] }]}
      pointerEvents="box-none"
    >
      <View style={styles.readyCard}>
        <Ionicons name="checkmark-circle" size={34} color={GOLD.accent} />
        <Text style={styles.readyTitle}>Your car is built</Text>
        <Text style={styles.readyBody}>
          It's live everywhere, right now — spinning here in your Garage, and it's your
          marker on the map and on CarPlay. No restart needed.
        </Text>
        <CandyCta label="Show me the map" onPress={onDismiss} height={44} tier="ultra" />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: 8 },
  pulseRing: {
    position: "absolute",
    width: 168, height: 168, borderRadius: 84,
    borderWidth: 1.5, borderColor: GOLD.rim,
  },
  title: { color: COLORS.text, fontSize: 17, fontWeight: "800", marginTop: 10 },
  hint: { color: COLORS.textDim, fontSize: 13, textAlign: "center", paddingHorizontal: 36, lineHeight: 18 },
  clockCenter: { position: "absolute", alignItems: "center" },
  clockTime: { color: COLORS.text, fontSize: 34, fontWeight: "800", fontVariant: ["tabular-nums"] },
  clockUnder: { color: GOLD.accent, fontSize: 11, fontWeight: "700", letterSpacing: 2, textTransform: "uppercase" },
  clockOver: { color: GOLD.accent, fontSize: 11, fontWeight: "700", letterSpacing: 1.5, textTransform: "uppercase", marginTop: 4 },
  readyWrap: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  readyCard: {
    backgroundColor: "rgba(11,12,14,0.94)",
    borderColor: GOLD.rim, borderWidth: 1, borderRadius: 18,
    paddingHorizontal: 20, paddingVertical: 18,
    alignItems: "center", gap: 8, maxWidth: 300,
  },
  readyTitle: { color: COLORS.text, fontSize: 18, fontWeight: "800" },
  readyBody: { color: COLORS.textDim, fontSize: 13, textAlign: "center", lineHeight: 19, marginBottom: 6 },
});
