// JoinCelebration — the moment you land in a club.
//
// Jeff, 2026-08-29: "When someone joins a group they should get a cool animation
// when joined." It replaced an Alert.alert("Joined", "Welcome to the club") — a
// system dialog, on the one screen in the app where something should feel earned.
//
// DELIBERATELY NO NEW DEPENDENCY. Everything here is `Animated` +
// `react-native-svg` (already shipping, 15.12.1) with `useNativeDriver: true`, so
// the whole thing runs on the UI thread and cannot touch the JS frame budget. That
// matters more than usual right now: there is an OPEN iOS rAF runaway defect, and a
// celebration that added a JS-driven frame loop would be adding fuel to it.
// (`react-native-reanimated` IS installed but has ZERO imports anywhere in the app —
// starting here would set a precedent with no precedent. lottie is not installed and
// adding it would be a native change, i.e. build-bound. Neither is needed.)
//
// Three beats, ~1.6 s total, then it dismisses itself:
//   1. the ring draws itself around the badge  (0 → 620 ms)
//   2. the badge pops in and the club name rises under it  (280 → 900 ms)
//   3. a ring of sparks fans out and fades  (620 → 1400 ms)
//
// Reduce Motion is respected: the whole sequence collapses to a fade. iOS users who
// have asked the OS for less movement get less movement.

import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import Svg, { Circle } from "react-native-svg";
import { skin } from "./tierTheme";
import { COLORS } from "./theme";

// ── The bus (2026-08-29) ─────────────────────────────────────────────────────
// The join call lives inside SearchModal, a sub-component, while the celebration
// has to cover the whole screen — so it takes the same shape as the app's other
// cross-component signals (voiceBus, hailBus, shareBus …): a module-level
// Set<Listener> with emit + subscribe. Nothing global, nothing to tear down wrong.
type JoinListener = (clubName: string) => void;
const joinListeners = new Set<JoinListener>();

/** Fire the celebration. Safe to call from anywhere, including a modal. */
export function celebrateJoin(clubName: string): void {
  joinListeners.forEach((fn) => { try { fn(clubName); } catch {} });
}

export function subscribeJoin(fn: JoinListener): () => void {
  joinListeners.add(fn);
  return () => { joinListeners.delete(fn); };
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;
const SPARKS = 10;

export default function JoinCelebration({
  clubName,
  tier = "ultra",
  onDone,
}: {
  clubName: string;
  /** Clubs are an Ultra surface today; the prop keeps it honest if that changes. */
  tier?: "brand" | "premium" | "ultra";
  onDone: () => void;
}) {
  const sk = skin(tier);
  const ring = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(0)).current;
  const burst = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (alive) setReduceMotion(!!on); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    try { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    const hold = 1500;
    // FAILSAFE. onDone only fires on `finished: true`, and an Animated sequence
    // reports finished:false if anything interrupts it (a re-run of this effect
    // when Reduce Motion resolves, a value touched elsewhere). Without this, an
    // interrupted run would leave a full-screen overlay parked over the hub with
    // nothing left to dismiss it. Generous enough never to cut a healthy run short.
    let done = false;
    const finish = () => { if (!done) { done = true; onDone(); } };
    const failsafe = setTimeout(finish, hold + 3000);
    if (reduceMotion) {
      Animated.sequence([
        Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }),
        Animated.delay(hold),
        Animated.timing(fade, { toValue: 0, duration: 220, useNativeDriver: true }),
      ]).start(({ finished }) => { if (finished) finish(); });
      // Park the rest at their end state so nothing renders half-drawn.
      ring.setValue(1); pop.setValue(1); burst.setValue(0);
      return () => clearTimeout(failsafe);
    }
    Animated.sequence([
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.timing(ring, { toValue: 1, duration: 620, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.sequence([
          Animated.delay(280),
          Animated.spring(pop, { toValue: 1, friction: 5, tension: 90, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.delay(620),
          Animated.timing(burst, { toValue: 1, duration: 780, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ]),
      ]),
      Animated.delay(hold),
      Animated.timing(fade, { toValue: 0, duration: 260, useNativeDriver: true }),
    ]).start(({ finished }) => { if (finished) finish(); });
    return () => clearTimeout(failsafe);
  }, [reduceMotion, ring, pop, burst, fade, onDone]);

  return (
    <Animated.View style={[styles.wrap, { opacity: fade }]} pointerEvents="none">
      <View style={styles.badgeWrap}>
        {/* beat 3 — sparks. Rendered UNDER the badge so they read as coming from behind it. */}
        {!reduceMotion && Array.from({ length: SPARKS }).map((_, i) => {
          const angle = (i / SPARKS) * Math.PI * 2;
          return (
            <Animated.View
              key={i}
              style={[
                styles.spark,
                {
                  backgroundColor: sk.accent,
                  opacity: burst.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0, 1, 0] }),
                  transform: [
                    { translateX: burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(angle) * 92] }) },
                    { translateY: burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.sin(angle) * 92] }) },
                    { scale: burst.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.4, 1, 0.2] }) },
                  ],
                },
              ]}
            />
          );
        })}

        {/* beat 1 — the ring draws itself */}
        <Svg width={128} height={128} viewBox="0 0 128 128" style={StyleSheet.absoluteFill}>
          <Circle cx={64} cy={64} r={RING_R} stroke="rgba(255,255,255,0.10)" strokeWidth={4} fill="none" />
          <AnimatedCircle
            cx={64} cy={64} r={RING_R}
            stroke={sk.accent} strokeWidth={4} fill="none" strokeLinecap="round"
            strokeDasharray={`${RING_C} ${RING_C}`}
            strokeDashoffset={ring.interpolate({ inputRange: [0, 1], outputRange: [RING_C, 0] }) as any}
            transform="rotate(-90 64 64)"
          />
        </Svg>

        {/* beat 2 — the badge pops */}
        <Animated.View
          style={{
            opacity: pop,
            transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) }],
          }}
        >
          <Text style={[styles.tick, { color: sk.accent }]}>✓</Text>
        </Animated.View>
      </View>

      <Animated.View
        style={{
          opacity: pop,
          transform: [{ translateY: pop.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
        }}
      >
        <Text style={styles.title}>You're in</Text>
        <Text style={[styles.club, { color: sk.accent }]} numberOfLines={2}>{clubName}</Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(6,7,9,0.92)",
    gap: 18, zIndex: 999,
  },
  badgeWrap: { width: 128, height: 128, alignItems: "center", justifyContent: "center" },
  spark: { position: "absolute", width: 7, height: 7, borderRadius: 4 },
  tick: { fontSize: 54, fontWeight: "900", lineHeight: 60 },
  title: { color: COLORS.text, fontSize: 24, fontWeight: "800", textAlign: "center" },
  club: { fontSize: 16, fontWeight: "700", textAlign: "center", marginTop: 4, paddingHorizontal: 32 },
});
