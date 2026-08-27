// CarViewfinder.tsx — the guided camera for a Car Scan station.
//
// Jeff, 2026-08-26, choosing this over the system camera: a bespoke viewfinder with
// a car outline, a level, and auto-capture when the phone is held right. That choice
// is what makes build 74 necessary for this feature at all — expo-camera is a new
// native module (see src/guidedCamera.ts for the OTA trap that comes with it).
//
// ── WHAT THE OVERLAY IS AND IS NOT ────────────────────────────────────────────
// The ghost car communicates WHICH WAY TO STAND — a front elevation at the nose and
// tail stations, a side profile at the flanks — because the single most common way to
// ruin a Multi-view reconstruction is to shoot four three-quarter views. It is
// deliberately NOT a shape to match precisely: a Yaris and a GT3 RS share no outline,
// and a driver who squeezes their car into a silhouette that does not fit it will
// step in, or off-axis, to make it match — which is exactly the framing error we are
// trying to prevent. So it sits at low opacity behind the real alignment aids:
//
//   the BOX      fill it, and the car is at the right distance
//   the AXIS     put the badge / the centre of the flank on it, and you are square
//
// ── WHAT THE LEVEL CAN AND CANNOT CHECK ───────────────────────────────────────
// It checks that the phone is not rolled sideways and is not aimed at the sky or the
// tarmac, and that it is being held still. It CANNOT check that you are square to the
// car — the phone has no idea where the car is. Squareness is the driver's job, which
// is what the axis line is for. The copy is careful never to claim otherwise.
// The maths is in src/carViewfinderLevel.ts, tested offline under both possible
// gravity sign conventions.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import Svg, { Path, Rect, Line, Circle } from "react-native-svg";

import { loadGuidedCamera, loadDeviceMotion } from "../guidedCamera";
import { skin } from "../tierTheme";
import type { ScanShot } from "../carScan";
import {
  readLevel, levelHint, normalise, rollDegrees, aimDegrees,
  type LevelReading, type Vec3,
} from "../carViewfinderLevel";

const ULTRA = skin("ultra");

/** How long the phone must stay good before auto-capture fires. Long enough that a
 *  momentary pass while swinging the phone up does not trigger it, short enough that
 *  it does not feel broken. */
const DWELL_MS = 900;
/** Sensor cadence. 10/s is plenty for a bubble and costs little battery. */
const MOTION_INTERVAL_MS = 100;

type Props = {
  shot: ScanShot;
  index: number;
  total: number;
  onCapture: (uri: string) => void;
  onCancel: () => void;
};

/** Front elevation — used at the nose and tail stations. viewBox 0 0 200 100. */
const GHOST_FRONT =
  "M30,78 L30,58 Q30,44 44,40 L60,30 Q68,25 100,25 Q132,25 140,30 L156,40 Q170,44 170,58 L170,78 " +
  "M30,64 L170,64 M56,40 L144,40";
/** Side profile — used at the two flank stations. */
const GHOST_SIDE =
  "M14,74 L14,62 Q16,50 38,46 L70,30 Q84,24 112,24 L142,26 Q168,30 182,46 L188,54 Q190,60 190,74 " +
  "M14,62 L190,62";

export default function CarViewfinder({ shot, index, total, onCapture, onCancel }: Props) {
  const cam = loadGuidedCamera();
  const CameraView = cam?.CameraView;

  const camRef = useRef<any>(null);
  const [ready, setReady] = useState(false);          // preview mounted
  const [busy, setBusy] = useState(false);            // shutter in flight
  const [auto, setAuto] = useState(true);             // auto-capture armed
  const [level, setLevel] = useState<LevelReading | null>(null);
  const [dwell, setDwell] = useState(0);              // 0..1 toward auto-capture

  const prevRef = useRef<Vec3 | null>(null);
  const goodSinceRef = useRef<number | null>(null);
  const firedRef = useRef(false);                     // one capture per mount, ever

  const isProfile = shot.slot === "Left" || shot.slot === "Right";

  // ── the level ───────────────────────────────────────────────────────────────
  // Absent DeviceMotion (a build without expo-sensors) simply means no bubble and no
  // auto-capture; the shutter still works. That is why guidedCameraAvailable() does
  // NOT gate on this module.
  useEffect(() => {
    const DeviceMotion = loadDeviceMotion();
    if (!DeviceMotion) return;
    let sub: any = null;
    let cancelled = false;
    (async () => {
      try {
        if (!(await DeviceMotion.isAvailableAsync())) return;
      } catch { return; }
      if (cancelled) return;
      try { DeviceMotion.setUpdateInterval(MOTION_INTERVAL_MS); } catch {}
      sub = DeviceMotion.addListener((m: any) => {
        const l = readLevel(m?.accelerationIncludingGravity, prevRef.current);
        prevRef.current = normalise(m?.accelerationIncludingGravity) ?? prevRef.current;
        setLevel(l);
      });
    })();
    return () => { cancelled = true; try { sub?.remove?.(); } catch {} };
  }, []);

  const capture = useCallback(async (fromAuto: boolean) => {
    // One shot per mount. Without this, a slow takePictureAsync lets the dwell timer
    // fire a second capture underneath the first and the station advances twice.
    if (firedRef.current || busy || !camRef.current) return;
    firedRef.current = true;
    setBusy(true);
    try {
      Haptics.impactAsync(
        fromAuto ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Heavy,
      ).catch(() => {});
      const pic = await camRef.current.takePictureAsync({
        // Matches the system-camera path this replaces: no crop, negligible
        // compression. Framing and detail are what the reconstruction reads.
        quality: 0.9,
        exif: false,
        skipProcessing: false,
      });
      if (pic?.uri) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        onCapture(pic.uri);
        return;
      }
      firedRef.current = false;   // nothing came back — let them try again
    } catch {
      firedRef.current = false;
    } finally {
      setBusy(false);
    }
  }, [busy, onCapture]);

  // ── auto-capture dwell ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!auto || !ready || busy || firedRef.current || !level) { setDwell(0); return; }
    if (!level.ready) { goodSinceRef.current = null; setDwell(0); return; }
    if (goodSinceRef.current == null) goodSinceRef.current = Date.now();
    const held = Date.now() - goodSinceRef.current;
    const pct = Math.min(1, held / DWELL_MS);
    setDwell(pct);
    if (pct >= 1) { void capture(true); return; }
    const t = setTimeout(() => setDwell((d) => d), 60);   // re-run on the next tick
    return () => clearTimeout(t);
  }, [level, auto, ready, busy, capture]);

  if (!CameraView) {
    // Defensive only: the caller checks guidedCameraAvailable() before rendering us.
    return null;
  }

  const hint = level ? levelHint(level) : "Line the car up in the box";
  const good = !!level?.ready;

  return (
    <View style={styles.fill}>
      <CameraView
        ref={camRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        animateShutter={false}
        onCameraReady={() => setReady(true)}
      />

      {/* ── the guide overlay ── */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%" viewBox="0 0 200 100" preserveAspectRatio="xMidYMid meet">
          {/* framing box — fill it and the car is at the right distance */}
          <Rect
            x="12" y="20" width="176" height="62" rx="4"
            fill="none"
            stroke={good ? ULTRA.accent : "rgba(255,255,255,0.55)"}
            strokeWidth={good ? 1.2 : 0.8}
            strokeDasharray="6 4"
          />
          {/* the ghost — says WHICH WAY TO STAND, not what shape to match */}
          <Path
            d={isProfile ? GHOST_SIDE : GHOST_FRONT}
            fill="none"
            stroke={good ? ULTRA.accent : "#FFFFFF"}
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={good ? 0.5 : 0.28}
          />
          {/* centre axis — put the badge (or the middle of the flank) on it */}
          <Line
            x1="100" y1="16" x2="100" y2="86"
            stroke={good ? ULTRA.accent : "rgba(255,255,255,0.5)"}
            strokeWidth="0.6"
            strokeDasharray="3 3"
          />
          {/* horizon bar — rolls with the phone, so it reads as a spirit level */}
          {level && (
            <Line
              x1="70" y1={92 + Math.max(-6, Math.min(6, level.roll * 60))}
              x2="130" y2={92 - Math.max(-6, Math.min(6, level.roll * 60))}
              stroke={level.roll <= 0.1 ? ULTRA.accent : "#FF9500"}
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          )}
          {/* dwell ring — auto-capture is never a surprise */}
          {dwell > 0 && (
            <Circle
              cx="100" cy="92" r="7"
              fill="none" stroke={ULTRA.accent} strokeWidth="1.6"
              strokeDasharray={`${dwell * 44} 44`}
              strokeLinecap="round"
              transform="rotate(-90 100 92)"
            />
          )}
        </Svg>
      </View>

      {/* ── chrome ── */}
      <SafeAreaView style={styles.chrome} pointerEvents="box-none">
        <View style={styles.top}>
          <TouchableOpacity onPress={onCancel} hitSlop={12} style={styles.close}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <View style={styles.station}>
            <Text style={styles.stationLabel}>{shot.label}</Text>
            <Text style={styles.stationCount}>{index + 1} of {total}</Text>
          </View>
          <TouchableOpacity
            onPress={() => { Haptics.selectionAsync(); setAuto((a) => !a); }}
            hitSlop={12}
            style={[styles.autoPill, auto && { borderColor: ULTRA.accent }]}
          >
            <Ionicons
              name={auto ? "flash" : "flash-off"}
              size={13}
              color={auto ? ULTRA.accent : "#9A9A9A"}
            />
            <Text style={[styles.autoText, auto && { color: ULTRA.accent }]}>AUTO</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.bottom}>
          <Text style={styles.hint}>{shot.hint}</Text>
          <View style={[styles.levelPill, good && { borderColor: ULTRA.accent }]}>
            <Ionicons
              name={good ? "checkmark-circle" : "alert-circle-outline"}
              size={15}
              color={good ? ULTRA.accent : "#FF9500"}
            />
            <Text style={[styles.levelText, good && { color: ULTRA.accent }]}>{hint}</Text>
          </View>
          {!!level && (
            <Text style={styles.readout}>
              roll {rollDegrees(level.roll)}°  ·  aim {aimDegrees(level.aim)}°
            </Text>
          )}

          <TouchableOpacity
            onPress={() => capture(false)}
            disabled={busy || !ready}
            style={[styles.shutter, (busy || !ready) && { opacity: 0.5 }]}
          >
            {busy ? (
              <ActivityIndicator color="#000" />
            ) : (
              <View style={[styles.shutterInner, good && { backgroundColor: ULTRA.accent }]} />
            )}
          </TouchableOpacity>
          <Text style={styles.shutterCaption}>
            {auto ? "Shoots itself when you hold it steady — or tap" : "Tap to shoot"}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#000" },
  chrome: { flex: 1, justifyContent: "space-between" },
  top: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 8,
  },
  close: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  station: { alignItems: "center" },
  stationLabel: { color: "#fff", fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
  stationCount: { color: "rgba(255,255,255,0.6)", fontSize: 12, marginTop: 1 },
  autoPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.25)",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  autoText: { color: "#9A9A9A", fontSize: 10, fontWeight: "800", letterSpacing: 0.6 },
  bottom: { alignItems: "center", paddingBottom: 18, gap: 9 },
  hint: {
    color: "rgba(255,255,255,0.85)", fontSize: 13, textAlign: "center",
    paddingHorizontal: 34,
  },
  levelPill: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.22)",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  levelText: { color: "#fff", fontSize: 12.5, fontWeight: "600" },
  readout: {
    color: "rgba(255,255,255,0.45)", fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  shutter: {
    width: 74, height: 74, borderRadius: 37, marginTop: 2,
    borderWidth: 3, borderColor: "rgba(255,255,255,0.9)",
    alignItems: "center", justifyContent: "center",
  },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: "#fff" },
  shutterCaption: { color: "rgba(255,255,255,0.55)", fontSize: 11 },
});
