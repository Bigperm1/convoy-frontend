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
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";

const YELLOW = "#FFD60A";
const HOLD_MS = 2000;
const EMA_ALPHA = 0.25;

// ---- Speed pill (always-on, bottom-left) ----
// Pulled in as a sub-component so the smoothing state is self-contained.
export function SpeedPill({ speedMs, unit }: { speedMs?: number; unit: "kmh" | "mph" }) {
  const rawKmh = (() => {
    if (typeof speedMs !== "number" || !Number.isFinite(speedMs) || speedMs < 0) return 0;
    const v = speedMs * 3.6;
    return v < 1 ? 0 : v;
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
    // Stopped (rawKmh === 0). Decay the displayed value toward zero, but SNAP
    // to a hard 0 once it dips below 1 km/h — otherwise the exponential decay
    // (prev * 0.75) only ever approaches zero and the pill lingers on "2" / "3"
    // while the car is parked. `decay` returns 0 when the result rounds to 0.
    const decay = (prev: number) => { const next = prev * (1 - EMA_ALPHA); return next < 1 ? 0 : next; };
    const last = lastNonZeroRef.current;
    const elapsed = Date.now() - last.ts;
    if (last.value > 0 && elapsed < HOLD_MS) {
      fallTimerRef.current = setTimeout(() => {
        if (lastNonZeroRef.current.ts === last.ts) setDisplayKmh(decay);
      }, HOLD_MS - elapsed);
    } else {
      setDisplayKmh(decay);
    }
  }, [rawKmh]);

  useEffect(() => () => { if (fallTimerRef.current) clearTimeout(fallTimerRef.current); }, []);

  const isMph = unit === "mph";
  const value = isMph ? Math.round(displayKmh * 0.621371) : Math.round(displayKmh);

  return (
    <View style={styles.speedWrap} pointerEvents="none">
      <View style={styles.speedPill}>
        <Text style={styles.speedValue}>{value}</Text>
        <Text style={styles.speedUnit}>{isMph ? "mph" : "km/h"}</Text>
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
  // Controls
  muted: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
};

export default function TurnByTurnNav({
  maneuverIcon, distanceToTurn, instruction, eta, distanceRemaining,
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

      {/* ===== Bottom ETA bar ===== */}
      <View style={styles.bottomWrap} pointerEvents="box-none">
        <View style={styles.etaBar}>
          <View style={styles.etaTextBlock}>
            <Text style={styles.etaTime}>{eta}</Text>
            <Text style={styles.etaDist}>{distanceRemaining}</Text>
          </View>
          <TouchableOpacity onPress={onEnd} style={styles.endBtn} activeOpacity={0.85} testID="end-nav">
            <Ionicons name="close" size={20} color="#fff" />
            <Text style={styles.endText}>End</Text>
          </TouchableOpacity>
        </View>
      </View>
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
  distanceToTurn: { color: "#fff", fontSize: 28, fontWeight: "800", letterSpacing: -0.5, lineHeight: 32 },
  instruction: { color: "rgba(255,255,255,0.8)", fontSize: 15, fontWeight: "500", marginTop: 1 },
  muteBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center", justifyContent: "center",
  },

  // ----- Bottom ETA bar -----
  bottomWrap: {
    position: "absolute",
    left: 0, right: 0, bottom: 28,
    paddingHorizontal: 12,
    alignItems: "center",
    zIndex: 60,
  },
  etaBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#161618",
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 18,
    minWidth: 240,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  etaTextBlock: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  etaTime: { color: "#34C759", fontSize: 20, fontWeight: "800", letterSpacing: -0.3 },
  etaDist: { color: "rgba(255,255,255,0.65)", fontSize: 15, fontWeight: "600" },
  endBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FF3B30",
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 14,
    marginLeft: 18,
  },
  endText: { color: "#fff", fontSize: 15, fontWeight: "700", letterSpacing: 0.2 },

  // ----- Speed pill (always-on, bottom-left) -----
  speedWrap: { position: "absolute", left: 12, bottom: 90, zIndex: 55 },
  speedPill: {
    minWidth: 60,
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
  speedValue: { color: "#fff", fontSize: 24, fontWeight: "800", letterSpacing: -0.5, lineHeight: 26 },
  speedUnit: { color: "rgba(255,255,255,0.6)", fontSize: 10, fontWeight: "600", letterSpacing: 0.3, marginTop: 1 },
});
