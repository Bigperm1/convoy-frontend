// Speedometer.tsx — bottom-left glass HUD showing the driver's current speed.
//
// Lifted out of map.tsx during the June 2025 refactor. Pulls speed (m/s) from
// the parent's location watcher, converts to km/h (×3.6), and floors to 0
// below 1 km/h so a stationary GPS doesn't read "1".
//
// Smoothing buffer: GPS speed momentarily drops to 0 mid-drive (tunnel,
// urban canyon, brief signal stutter). Without smoothing the HUD flickers
// 65 → 0 → 65 in under a second. We hold the previous reading for up to
// HOLD_MS (2s) before allowing it to fall to 0. Any non-zero reading
// resets the hold and updates immediately. EMA smoothing keeps the visual
// transition between adjacent samples gradual instead of jagged.

import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet } from "react-native";

export const SPEEDO_HOLD_MS = 2000;
// Exponential-moving-average smoothing factor for the displayed km/h.
// alpha = 0.25 → ~4-sample window: each new reading contributes 25% to the
// displayed value, prior smoothed value 75%.
export const SPEEDO_EMA_ALPHA = 0.25;

type Props = {
  speedMs?: number;
  speedLimit?: number | null;
  unit: "kmh" | "mph";
};

export default function Speedometer({ speedMs, speedLimit, unit }: Props) {
  // rawKmh: this tick's converted speed (>=1 km/h or 0)
  const rawKmh = (() => {
    if (typeof speedMs !== "number" || !Number.isFinite(speedMs) || speedMs < 0) return 0;
    const v = speedMs * 3.6;
    return v < 1 ? 0 : v;
  })();

  // displayKmh: what the UI actually shows. Smoothed via EMA so rapid GPS
  // fluctuations look like gradual transitions rather than jumps.
  const [displayKmh, setDisplayKmh] = useState(0);
  // Last non-zero reading + timestamp — survives across renders.
  const lastNonZeroRef = useRef<{ value: number; ts: number }>({ value: 0, ts: 0 });
  // Pending fall-to-zero timer so we can cancel if speed comes back.
  const fallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (fallTimerRef.current) {
      clearTimeout(fallTimerRef.current);
      fallTimerRef.current = null;
    }

    if (rawKmh > 0) {
      lastNonZeroRef.current = { value: rawKmh, ts: Date.now() };
      setDisplayKmh((prev) =>
        prev <= 0
          ? rawKmh
          : prev * (1 - SPEEDO_EMA_ALPHA) + rawKmh * SPEEDO_EMA_ALPHA
      );
      return;
    }

    const last = lastNonZeroRef.current;
    const elapsed = Date.now() - last.ts;
    if (last.value > 0 && elapsed < SPEEDO_HOLD_MS) {
      const remaining = SPEEDO_HOLD_MS - elapsed;
      fallTimerRef.current = setTimeout(() => {
        if (lastNonZeroRef.current.ts === last.ts) {
          setDisplayKmh((prev) => prev * (1 - SPEEDO_EMA_ALPHA));
        }
      }, remaining);
    } else {
      setDisplayKmh((prev) => prev * (1 - SPEEDO_EMA_ALPHA));
    }
  }, [rawKmh]);

  useEffect(() => () => {
    if (fallTimerRef.current) clearTimeout(fallTimerRef.current);
  }, []);

  // Posted limit always arrives in KPH from Google Roads — convert it to
  // the user's display unit BEFORE doing any threshold math.
  // Threshold is 20 km/h over → orange / red, scaled for MPH (~12 mph).
  const isMph = unit === "mph";
  const speedDisplay = isMph ? Math.round(displayKmh * 0.621371) : Math.round(displayKmh);
  const limitDisplay = speedLimit == null
    ? null
    : isMph
      ? Math.round(speedLimit * 0.621371)
      : Math.round(speedLimit);
  const overStep = isMph ? 12 : 20;
  const speedoBg = !limitDisplay || speedDisplay <= limitDisplay
    ? "rgba(28,28,30,0.88)"
    : speedDisplay <= limitDisplay + overStep
      ? "#FF9500"
      : "#FF3B30";

  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={[styles.hud, { backgroundColor: speedoBg }]}>
        <View style={styles.inner}>
          <Text style={styles.value}>{speedDisplay}</Text>
          <Text style={styles.unit}>{isMph ? "MPH" : "KM/H"}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 12,
    bottom: 90,
    zIndex: 6,
  },
  hud: {
    width: 64,
    height: 64,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
    overflow: "hidden",
  },
  inner: {
    alignItems: "center",
    justifyContent: "center",
  },
  value: {
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "700",
    lineHeight: 24,
    letterSpacing: -0.5,
  },
  unit: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 9,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginTop: 1,
  },
});
