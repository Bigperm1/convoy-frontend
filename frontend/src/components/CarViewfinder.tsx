// CarViewfinder.tsx — the guided camera for a Car Scan station.
//
// Jeff, 2026-08-26, choosing this over the system camera: a bespoke viewfinder with
// a framing box and a level, so the driver knows where to stand. That choice
// is what makes build 74 necessary for this feature at all — expo-camera is a new
// native module (see src/guidedCamera.ts for the OTA trap that comes with it).
//
// ── WHAT THE OVERLAY IS AND IS NOT ────────────────────────────────────────────
// Two aids, and nothing else:
//
//   the BOX      fill it, and the car is at the right distance
//   the AXIS     put the badge / the centre of the flank on it, and you are square
//
// ⛔ There WAS a ghost-car wireframe here (a front elevation at the nose and tail, a
// side profile at the flanks). Jeff pulled it 2026-08-27 after testing on his own car:
// "please take the wire frame out." Do not reinstate it. The reasoning that argued
// against it from the start still stands — a Yaris and a GT3 RS share no outline, so a
// driver squeezing their car into a silhouette that does not fit it steps in or
// off-axis to make it match, which is the exact framing error the station is guarding
// against.
//
// ⛔ Auto-capture is likewise GONE (same session, same reason: "the camera auto
// captures too lets take that out too"). The shutter is the only way a frame is taken.
// The level still colours the chrome and coaches — it just never pulls the trigger.
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
import Svg, { Rect, Line } from "react-native-svg";

import { loadGuidedCamera, loadDeviceMotion } from "../guidedCamera";
import { skin } from "../tierTheme";
import type { ScanShot } from "../carScan";
import {
  levelHint, normalise, smoothUnit, readLevelUnit, displayRoll,
  rollDegrees, aimDegrees,
  type LevelReading, type Vec3,
} from "../carViewfinderLevel";

const ULTRA = skin("ultra");

/** Sensor cadence. Faster than the old 100 ms because the reading is now smoothed:
 *  more samples make the average calmer AND more responsive, not noisier. */
const MOTION_INTERVAL_MS = 60;

type Props = {
  shot: ScanShot;
  index: number;
  total: number;
  onCapture: (uri: string) => void;
  onCancel: () => void;
};

export default function CarViewfinder({ shot, index, total, onCapture, onCancel }: Props) {
  const cam = loadGuidedCamera();
  const CameraView = cam?.CameraView;

  const camRef = useRef<any>(null);
  const [ready, setReady] = useState(false);          // preview mounted
  const [busy, setBusy] = useState(false);            // shutter in flight
  const [level, setLevel] = useState<LevelReading | null>(null);

  /** Last SMOOTHED unit vector — both the EMA state and the motion reference. */
  const smoothRef = useRef<Vec3 | null>(null);
  const firedRef = useRef(false);                     // one capture per mount, ever

  // ── the level ───────────────────────────────────────────────────────────────
  // Absent DeviceMotion (a build without expo-sensors) simply means no bubble; the
  // shutter still works. That is why guidedCameraAvailable() does NOT gate on this
  // module.
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
        const unit = normalise(m?.accelerationIncludingGravity);
        if (!unit) { setLevel({ roll: 1, aim: 1, motion: 1, ready: false }); return; }
        const sm = smoothUnit(smoothRef.current, unit);
        setLevel(readLevelUnit(sm, smoothRef.current));
        smoothRef.current = sm;
      });
    })();
    return () => { cancelled = true; try { sub?.remove?.(); } catch {} };
  }, []);

  const capture = useCallback(async () => {
    // One shot per mount: a slow takePictureAsync would otherwise let a second tap
    // fire underneath the first and advance the station twice.
    if (firedRef.current || busy || !camRef.current) return;
    firedRef.current = true;
    setBusy(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
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

  if (!CameraView) {
    // Defensive only: the caller checks guidedCameraAvailable() before rendering us.
    return null;
  }

  const hint = level ? levelHint(level) : "Line the car up in the box";
  const good = !!level?.ready;
  // Deadbanded so a steady hand draws a dead-flat bar instead of micro-wobble.
  const barTilt = level ? Math.max(-6, Math.min(6, displayRoll(level.roll) * 60)) : 0;

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
              x1="70" y1={92 + barTilt}
              x2="130" y2={92 - barTilt}
              stroke={level.roll <= 0.1 ? ULTRA.accent : "#FF9500"}
              strokeWidth="1.4"
              strokeLinecap="round"
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
          {/* Balances the close button so the station label stays centred. */}
          <View style={styles.close} />
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
            onPress={() => capture()}
            disabled={busy || !ready}
            style={[styles.shutter, (busy || !ready) && { opacity: 0.5 }]}
          >
            {busy ? (
              <ActivityIndicator color="#000" />
            ) : (
              <View style={[styles.shutterInner, good && { backgroundColor: ULTRA.accent }]} />
            )}
          </TouchableOpacity>
          <Text style={styles.shutterCaption}>Tap to shoot</Text>
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
