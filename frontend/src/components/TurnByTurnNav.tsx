// TurnByTurnNav.tsx — Google-Maps-style turn-by-turn overlay.
//
// Replaces the old right-edge NavigationPanel "pull tab" drawer (which the
// user disliked) with the familiar, always-visible layout every nav app uses:
//
//   ┌─────────────────────────────────────┐
//   │  ⬅  200 m                            │   ← top maneuver banner
//   │      Turn left onto Main St          │      (big, never hides)
//   └─────────────────────────────────────┘
//
//                  (live map)
//
//   ┌──────┐                  ┌──────────────────────────┐
//   │ 64   │                  │ 12 min · 8.4 km    [End]  │  ← bottom bar
//   │ km/h │                  └──────────────────────────┘
//   └──────┘
//
// The turn-by-turn ENGINE stays in map.tsx (useTurnByTurn). This component is
// pure presentation — it receives the computed maneuver/distance/eta as props.
//
// Speed pill reuses the proven EMA + hold smoothing from the old Speedometer so
// GPS stutter doesn't make the number flicker.

import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform, Animated } from "react-native";
import { Ionicons } from "@expo/vector-icons";

const YELLOW = "#FFD60A";
const OVER_RED = "#FF3B30";
const HOLD_MS = 800;
const EMA_ALPHA = 0.45;
// Grace buffer (km/h) before the speedometer flags you as speeding, so a GPS
// blip or rounding right at the posted limit doesn't trigger a false red pulse.
const OVER_BUFFER_KMH = 2;

// ---- Speed pill (always-on, bottom-left) ----
// Pulled in as a sub-component so the smoothing state is self-contained.
export function SpeedPill({ speedMs, unit, bottom, limitKmh }: { speedMs?: number; unit: "kmh" | "mph"; bottom?: number; limitKmh?: number | null }) {
  const rawKmh = (() => {
    if (typeof speedMs !== "number" || !Number.isFinite(speedMs) || speedMs < 0) return 0;
    const v = speedMs * 3.6;
    return v < 2 ? 0 : v;
  })();

  const [displayKmh, setDisplayKmh] = useState(0);
  const lastNonZeroRef = useRef<{ value: number; ts: number }>({ value: 0, ts: 0 });
  const fallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (fallTimerRef.current) { clearTimeout(fallTimerRef.current); fallTimerRef.current = null; }
    if (rawKmh > 0) {
      lastNonZeroRef.current = { value: rawKmh, ts: Date.now() };
      setDisplayKmh((prev) => (prev <= 0 ? rawKmh : prev * (1 - EMA_ALPHA) + rawKmh * EMA_ALPHA));
      return;
    }
    // Stopped (rawKmh === 0). Hold the last reading briefly, then SNAP straight
    // to 0. The previous code decayed gradually, but this effect only re-runs
    // when rawKmh CHANGES — so at a dead stop (rawKmh pinned at 0) it ran once
    // and left the pill stuck on a phantom 3-7 km/h. A hard snap guarantees 0.
    const last = lastNonZeroRef.current;
    const wait = Math.max(0, HOLD_MS - (Date.now() - last.ts));
    fallTimerRef.current = setTimeout(() => { setDisplayKmh(0); }, wait);
  }, [rawKmh]);

  useEffect(() => () => { if (fallTimerRef.current) clearTimeout(fallTimerRef.current); }, []);

  const isMph = unit === "mph";
  const value = isMph ? Math.round(displayKmh * 0.621371) : Math.round(displayKmh);

  // Over-limit detection. The posted limit (Google Roads, in KPH) is compared
  // against the smoothed speed with a small grace buffer so we don't flash red
  // the instant the needle grazes the limit (GPS noise / rounding). When the
  // road has no known limit (Roads API returned nothing) we never flag — better
  // to stay silent than cry wolf.
  const speeding =
    typeof limitKmh === "number" && limitKmh > 0 && displayKmh > limitKmh + OVER_BUFFER_KMH;

  // Pulsing red halo behind the pill while speeding. Native-driver opacity +
  // scale (no layout thrash); the loop runs only while `speeding` is true and
  // is fully torn down the moment you drop back under the limit.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    if (speeding) {
      pulse.setValue(0);
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1, duration: 550, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 0, duration: 550, useNativeDriver: true }),
        ])
      );
      loop.start();
    } else {
      pulse.stopAnimation();
      pulse.setValue(0);
    }
    return () => { if (loop) loop.stop(); };
  }, [speeding, pulse]);

  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.6] });
  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.45] });

  return (
    <View style={[styles.speedWrap, typeof bottom === "number" ? { bottom } : null]} pointerEvents="none">
      {speeding && (
        <Animated.View
          style={[styles.speedHalo, { opacity: haloOpacity, transform: [{ scale: haloScale }] }]}
          pointerEvents="none"
        />
      )}
      <View style={[styles.speedPill, speeding && styles.speedPillOver]}>
        <Text style={styles.speedValue}>{value}</Text>
        <Text style={[styles.speedUnit, speeding && styles.speedUnitOver]}>{isMph ? "mph" : "km/h"}</Text>
      </View>
    </View>
  );
}

// ---- Turn-by-turn overlay (top banner + bottom ETA bar) ----
type Props = {
  // Upcoming maneuver
  maneuverIcon: any;            // Ionicons name
  distanceToTurn: string;      // e.g. "200 m"
  instruction: string;         // e.g. "Turn left onto Main St"
  // Trip progress
  eta: string;                 // time remaining, e.g. "12 min"
  distanceRemaining: string;   // e.g. "8.4 km"
  arrival: string;             // arrival clock, e.g. "10:42 AM"
  // Controls
  muted: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
};

export default function TurnByTurnNav({
  maneuverIcon, distanceToTurn, instruction, eta, distanceRemaining, arrival,
  muted, onToggleMute, onEnd,
}: Props) {
  return (
    <>
      {/* ===== Top maneuver banner — always visible during nav ===== */}
      <View style={styles.bannerWrap} pointerEvents="box-none">
        <View style={styles.banner}>
          <View style={styles.maneuverIconWrap}>
            <Ionicons name={maneuverIcon} size={34} color="#000" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.distanceToTurn}>{distanceToTurn}</Text>
            <Text style={styles.instruction} numberOfLines={2}>{instruction}</Text>
          </View>
          <TouchableOpacity onPress={onToggleMute} hitSlop={10} style={styles.muteBtn} testID="nav-mute">
            <Ionicons name={muted ? "volume-mute" : "volume-high"} size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Bottom trip bar removed — the StepDrawer now owns the bottom bar
          (collapsed: time · distance · arrival + red Exit, pulls up for steps),
          floating just above the always-visible tab bar. */}
    </>
  );
}

const styles = StyleSheet.create({
  // ----- Top maneuver banner -----
  bannerWrap: {
    position: "absolute",
    top: 0, left: 0, right: 0,
    paddingTop: Platform.OS === "ios" ? 56 : 32,
    paddingHorizontal: 12,
    zIndex: 60,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: "#161618",
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: "rgba(255,214,10,0.35)",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  maneuverIconWrap: {
    width: 54, height: 54, borderRadius: 14,
    backgroundColor: YELLOW,
    alignItems: "center", justifyContent: "center",
  },
  distanceToTurn: { color: "#F4F4F4", fontSize: 28, fontWeight: "800", letterSpacing: -0.5, lineHeight: 32 },
  instruction: { color: "#808080", fontSize: 15, fontWeight: "500", marginTop: 1 },
  muteBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center", justifyContent: "center",
  },

  // ----- Bottom trip bar (thin convoy-yellow) -----
  bottomWrap: {
    position: "absolute",
    left: 12, right: 12, bottom: 28,
    zIndex: 60,
  },
  navYellowBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: "#FFD60A",
    borderRadius: 16,
    paddingVertical: 7,
    paddingLeft: 16,
    paddingRight: 7,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.18)",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
  navYellowTime: { color: "#1C1C1E", fontSize: 17, fontWeight: "800", letterSpacing: -0.3 },
  navYellowMeta: { color: "#3A3A3C", fontSize: 14, fontWeight: "600" },
  navExitBtn: {
    marginLeft: "auto",
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: "#FF3B30",
    alignItems: "center", justifyContent: "center",
  },
  navExitText: { color: "#F4F4F4", fontSize: 12, fontWeight: "700", letterSpacing: 0.2 },

  // ----- Speed pill (always-on, bottom-left) -----
  speedWrap: { position: "absolute", left: 12, bottom: 90, zIndex: 55 },
  speedPill: {
    width: 78,
    height: 60,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: "rgba(22,22,24,0.92)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  speedValue: { color: "#F4F4F4", fontSize: 24, fontWeight: "800", letterSpacing: -0.5, lineHeight: 26 },
  speedUnit: { color: "#808080", fontSize: 10, fontWeight: "600", letterSpacing: 0.3, marginTop: 1 },
  // Over-the-limit state: pill turns solid red with a brighter border; the unit
  // label lightens so it stays legible on red.
  speedPillOver: { backgroundColor: OVER_RED, borderColor: "rgba(255,255,255,0.55)" },
  speedUnitOver: { color: "rgba(255,255,255,0.85)" },
  // Pulsing glow ring behind the pill (same red), scaled out by the animation.
  speedHalo: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 16,
    backgroundColor: OVER_RED,
  },
});
