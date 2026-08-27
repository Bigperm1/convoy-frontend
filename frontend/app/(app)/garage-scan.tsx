// Garage Scan — the ultra-premium capture guide. "Your actual car. On the map."
//
// The pitch half of the feature; Start Capture hands off to garage-capture.tsx.
//
// The stations are IMPORTED from src/carScan.ts rather than restated here, so
// this screen cannot promise a walk the capture flow does not run. That matters
// because the copy was wrong before: it taught "four ordered 3/4+side views",
// but the 2026-08-23 bake-off winner was reconstructed from four STRAIGHT-ON
// views (Tripo's Multi-view slots are Front/Left/Right/Back and it wants them
// orthogonal). Still four shots — the count was never the error, the ANGLE was.
//
// The rest of the coaching is unchanged and still measured: phone at head height
// tilted slightly down (the map's chase cam looks AT the roof and hood —
// eye-level photos make the model guess the surfaces we show most), 3-4 m back
// on the 1x lens (wide lenses warp proportions — the PoC's one weakness), even
// light.
//
// Design brief: "premium like if Apple built it" — big type, one idea per
// screen-third, the diagram animates the instruction instead of describing it.

import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Circle, Line, Path } from "react-native-svg";
import * as Haptics from "expo-haptics";
import { COLORS } from "../../src/theme";
import { CandyCta } from "../../src/components/CandyCta";

import { TierTitle } from "../../src/PremiumBadge";
import { skin } from "../../src/tierTheme";
import { SCAN_SHOTS, SHOTS_TOTAL } from "../../src/carScan";

// This is an ULTRA PREMIUM page, so it is GOLD, not brand green (Jeff 8/23).
const ULTRA = skin("ultra");

/** The tier fill as an absolute layer, same candy construction in gold. */
function CandyFillAbs() {
  return <LinearGradient colors={ULTRA.colors} locations={ULTRA.locations} style={StyleSheet.absoluteFill} />;
}

// BASE name, not @3x (build-74 failure, 2026-08-27): an explicit density-suffixed
// require resolves in dev Metro but "Unable to resolve module" kills the RELEASE
// export:embed — it killed the first build-74 Android cut. Metro picks @2x/@3x from
// the base name itself.
const TOPDOWN = require("../../assets/vehicles/v3/heavy_metal.png");

const RING = 230;            // orbit diagram outer size
const CAR = 96;              // top-down sprite size inside the ring
// The capture stations, in shooting order — derived from the capture flow itself
// so the pitch and the thing it pitches can never drift apart. Angles are
// screen-space and 0° = straight up, which is also carScan's bearing convention
// (the car's nose in the sprite points up).
const STATIONS = SCAN_SHOTS.map((s) => ({ id: s.id, angle: s.bearing, label: s.label }));

const STEPS: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] = [
  {
    icon: "camera",
    title: "Four shots, one lap",
    body: "Start at the nose and walk clockwise — front, passenger side, rear, driver side. Square-on each time, not on an angle.",
  },
  {
    icon: "phone-portrait",
    title: "Head height, tilted down",
    body: "Hold the phone just above eye level, angled down a touch — the map sees your roof and hood more than anything.",
  },
  {
    icon: "resize",
    title: "Step back, never zoom",
    body: "Three to four metres away on the 1× lens. Wide lenses bend your car's proportions.",
  },
  {
    icon: "partly-sunny",
    title: "Soft light wins",
    body: "Open shade or an overcast sky beats hard sun — glare on the paint hides your car's real lines.",
  },
];

export default function GarageScan() {
  const router = useRouter();

  // ── the orbit ──────────────────────────────────────────────────────────────
  // One slow continuous revolution; the camera dot pauses visually by easing
  // through each station (a single 16s loop with an ease that lingers works out
  // simpler and calmer than four chained segments).
  const orbit = useRef(new Animated.Value(0)).current;
  const [station, setStation] = useState(0);
  const pulse = useRef(new Animated.Value(0)).current;
  const stepAnims = useRef(STEPS.map(() => new Animated.Value(0))).current;
  const ctaGlow = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.timing(orbit, {
        toValue: 1,
        duration: 16000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    ).start();
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ])
    ).start();
    Animated.loop(
      Animated.sequence([
        Animated.timing(ctaGlow, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
        Animated.timing(ctaGlow, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      ])
    ).start();
    // Steps cascade in like an Apple onboarding page.
    Animated.stagger(
      140,
      stepAnims.map((a) =>
        Animated.timing(a, { toValue: 1, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true })
      )
    ).start();
    // Highlight the station nearest the orbiting camera.
    const id = setInterval(() => setStation((s) => (s + 1) % STATIONS.length), 4000);
    return () => clearInterval(id);
  }, []);

  const spin = orbit.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const counterSpin = orbit.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "-360deg"] });
  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] });
  const pulseFade = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });

  const startCapture = () => {
    Haptics.selectionAsync();
    // Straight to the disclaimer, never to the camera. The two-render rule is
    // destructive and has to be read and acknowledged before the first photo.
    router.push("/(app)/garage-consent" as any);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* header */}
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={10}>
            <Ionicons name="chevron-back" size={24} color={COLORS.text} />
          </TouchableOpacity>
          <View style={styles.backBtn} />
          <View style={styles.backBtn} />
        </View>

        <TierTitle tier="ultra" style={styles.tierTitle} />
        <Text style={styles.title}>Garage Scan</Text>
        <Text style={styles.subtitle}>Your actual car. On the map.</Text>

        {/* ── animated capture diagram ───────────────────────────────────── */}
        <View style={styles.diagramWrap}>
          <Svg width={RING} height={RING} style={StyleSheet.absoluteFill as any}>
            {/* orbit path */}
            <Circle
              cx={RING / 2}
              cy={RING / 2}
              r={RING / 2 - 14}
              stroke="rgba(255,231,163,0.20)"
              strokeWidth={1.5}
              strokeDasharray="3 7"
              fill="none"
            />
            {/* soft stage floor */}
            <Circle cx={RING / 2} cy={RING / 2} r={RING / 2 - 52} fill="rgba(224,169,62,0.06)" />
          </Svg>

          {/* capture stations */}
          {STATIONS.map((s, i) => {
            const rad = ((s.angle - 90) * Math.PI) / 180;
            const r = RING / 2 - 14;
            const x = RING / 2 + r * Math.cos(rad);
            const y = RING / 2 + r * Math.sin(rad);
            const active = i === station;
            return (
              <View key={s.id} style={[styles.station, { left: x - 5, top: y - 5 }]}>
                {active && (
                  <Animated.View
                    style={[styles.stationPulse, { transform: [{ scale: pulseScale }], opacity: pulseFade }]}
                  />
                )}
                <View style={[styles.stationDot, active && styles.stationDotActive]} />
              </View>
            );
          })}

          {/* the car */}
          <Image source={TOPDOWN} style={styles.car} resizeMode="contain" />

          {/* orbiting camera */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { transform: [{ rotate: spin }] }]}
          >
            <Animated.View style={[styles.orbiter, { transform: [{ rotate: counterSpin }] }]}>
              <View style={styles.orbiterInner}>
                <Ionicons name="camera" size={13} color="#04150B" />
              </View>
            </Animated.View>
          </Animated.View>
        </View>

        <Text style={styles.stationLabel}>{STATIONS[station].label}</Text>

        {/* ── the height diagram: head-high, tilted down ─────────────────── */}
        <View style={styles.sideDiagram}>
          <Svg width={300} height={96}>
            {/* ground */}
            <Line x1={6} y1={86} x2={294} y2={86} stroke="rgba(255,255,255,0.14)" strokeWidth={1.5} />
            {/* photographer: post + phone held high */}
            <Line x1={40} y1={86} x2={40} y2={30} stroke="rgba(255,255,255,0.45)" strokeWidth={2} strokeLinecap="round" />
            <Path d="M33 20 h14 a3 3 0 0 1 3 3 v6 a3 3 0 0 1 -3 3 h-14 a3 3 0 0 1 -3 -3 v-6 a3 3 0 0 1 3 -3 Z" fill={ULTRA.accent} />
            {/* sightline, gently down onto the car */}
            <Line x1={52} y1={28} x2={222} y2={62} stroke={ULTRA.accent} strokeWidth={1.5} strokeDasharray="4 5" opacity={0.8} />
            {/* car silhouette */}
            <Path
              d="M212 78 q2 -10 14 -11 l10 -9 q10 -8 26 -8 q16 0 24 8 l8 8 q10 2 10 12 l0 4 q0 3 -3 3 l-86 0 q-3 0 -3 -3 Z"
              fill="rgba(255,255,255,0.22)"
            />
            <Circle cx={232} cy={84} r={6} fill="#0C0C0E" stroke="rgba(255,255,255,0.4)" strokeWidth={2} />
            <Circle cx={286} cy={84} r={6} fill="#0C0C0E" stroke="rgba(255,255,255,0.4)" strokeWidth={2} />
          </Svg>
          <Text style={styles.sideDiagramCaption}>Just above eye level · angled slightly down</Text>
        </View>

        {/* ── steps ──────────────────────────────────────────────────────── */}
        <View style={styles.steps}>
          {STEPS.map((s, i) => (
            <Animated.View
              key={s.title}
              style={[
                styles.stepRow,
                {
                  opacity: stepAnims[i],
                  transform: [
                    { translateY: stepAnims[i].interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) },
                  ],
                },
              ]}
            >
              <View style={styles.stepIcon}>
                <CandyFillAbs />
                <Ionicons name={s.icon} size={17} color={ULTRA.ink} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.stepTitle}>{s.title}</Text>
                <Text style={styles.stepBody}>{s.body}</Text>
              </View>
            </Animated.View>
          ))}
        </View>

        {/* ── CTA ────────────────────────────────────────────────────────── */}
        <Animated.View
          style={[
            styles.ctaWrap,
            {
              shadowColor: ULTRA.accent,
              shadowOpacity: ctaGlow.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.5] }),
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 0 },
            },
          ]}
        >
          <CandyCta label="Start Capture" icon="scan" onPress={startCapture} tier="ultra" />
        </Animated.View>
        <Text style={styles.finePrint}>{SHOTS_TOTAL} photos · about three minutes · one rescan included</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  tierTitle: { marginBottom: 6 },
  scroll: { paddingHorizontal: 22, paddingBottom: 48, alignItems: "center" },
  headerRow: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
  backBtn: { width: 40, height: 40, justifyContent: "center" },
  title: { color: COLORS.text, fontSize: 34, fontWeight: "800", letterSpacing: 0.2, marginTop: 6 },
  subtitle: { color: COLORS.textDim, fontSize: 15, marginTop: 4, marginBottom: 22 },

  diagramWrap: { width: RING, height: RING, alignItems: "center", justifyContent: "center" },
  car: { width: CAR, height: CAR, transform: [{ rotate: "0deg" }] },
  station: { position: "absolute", width: 10, height: 10, alignItems: "center", justifyContent: "center" },
  stationDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "rgba(255,255,255,0.28)",
  },
  stationDotActive: { backgroundColor: ULTRA.accent },
  stationPulse: {
    position: "absolute",
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: ULTRA.accent,
  },
  orbiter: { position: "absolute", top: 2, left: RING / 2 - 12, width: 24, height: 24 },
  orbiterInner: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: ULTRA.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.5)",
  },
  stationLabel: {
    color: ULTRA.accent,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginTop: 10,
  },

  sideDiagram: { alignItems: "center", marginTop: 22 },
  sideDiagramCaption: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },

  steps: { alignSelf: "stretch", gap: 16, marginTop: 26 },
  stepRow: { flexDirection: "row", gap: 14, alignItems: "flex-start" },
  stepIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(45,236,134,0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  stepTitle: { color: COLORS.text, fontSize: 15.5, fontWeight: "700" },
  stepBody: { color: COLORS.textDim, fontSize: 13.5, lineHeight: 19, marginTop: 2 },

  ctaWrap: { marginTop: 30, borderRadius: 16, elevation: 8 },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 16,
    paddingVertical: 15,
    paddingHorizontal: 44,
  },
  ctaText: { color: "#04150B", fontSize: 16.5, fontWeight: "800" },
  finePrint: { color: COLORS.textMute, fontSize: 11.5, marginTop: 10 },
});
