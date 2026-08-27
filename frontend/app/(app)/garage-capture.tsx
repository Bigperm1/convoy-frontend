// Garage Capture — the guided four-shot lap that Garage Scan pitches.
//
// One station at a time, in a clockwise walk around the car. The tester never
// decides what to shoot or in what order; the ring diagram shows where to stand
// and the camera opens straight into the next station. Any tile can be re-shot
// before sending, because the whole set goes up in one batch at the end.
//
// All four are straight-on and all four feed the model — Tripo's Multi-view mode
// takes exactly these (see src/carScan.ts for why four, and why orthogonal).

import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";

import { COLORS } from "../../src/theme";
import { CandyCta } from "../../src/components/CandyCta";
import { TierTitle } from "../../src/PremiumBadge";
import { skin } from "../../src/tierTheme";
import { useAuth } from "../../src/auth";
import { getSettings, updateSettings } from "../../src/settings";
import { ensureCameraPermission } from "../../src/permissionGate";
import { SCAN_SHOTS, SHOTS_TOTAL, newScanId, uploadScan, registerScan, type CapturedShot } from "../../src/carScan";
// SAFE to import statically on every build: CarViewfinder never imports expo-camera at
// module scope — it goes through guidedCamera's probe and renders null without it.
// See src/guidedCamera.ts for why a static expo-camera import would be a rollback bomb.
import CarViewfinder from "../../src/components/CarViewfinder";
import { guidedCameraAvailable } from "../../src/guidedCamera";

// This is an ULTRA PREMIUM page — gold, not brand green (Jeff 8/23).
const ULTRA = skin("ultra");

// BASE name, not @3x (build-74 failure, 2026-08-27): an explicit density-suffixed
// require resolves in dev Metro but "Unable to resolve module" kills the RELEASE
// export:embed — it killed the first build-74 Android cut. Metro picks @2x/@3x from
// the base name itself.
const TOPDOWN = require("../../assets/vehicles/v3/heavy_metal.png");

const RING = 200;          // diagram box
const RING_R = 78;         // station orbit radius
const CAR = 96;            // top-down sprite size inside the ring

type Phase = "capture" | "uploading" | "done";

export default function GarageCaptureScreen() {
  const { user } = useAuth();
  const [shots, setShots] = useState<Record<string, string>>({});
  const [active, setActive] = useState(0);
  const [phase, setPhase] = useState<Phase>("capture");
  const [sent, setSent] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; uploaded: number; error?: string } | null>(null);
  // The guided viewfinder (build 74+). On an older binary this stays false forever and
  // the system-camera path below runs instead — identical output, no crash.
  const [viewfinder, setViewfinder] = useState(false);

  const captured = Object.keys(shots).length;
  const complete = captured === SHOTS_TOTAL;
  const shot = SCAN_SHOTS[active];

  // Station dots sit on a circle; bearing 0 (the nose) is straight up.
  const dots = useMemo(
    () =>
      SCAN_SHOTS.map((s) => {
        const rad = ((s.bearing - 90) * Math.PI) / 180;
        return {
          ...s,
          x: RING / 2 + RING_R * Math.cos(rad),
          y: RING / 2 + RING_R * Math.sin(rad),
        };
      }),
    [],
  );

  /** Move to the next station that still has no photo; stay put when full. */
  const advance = useCallback((justShot: number, next: Record<string, string>) => {
    for (let i = 1; i <= SHOTS_TOTAL; i++) {
      const idx = (justShot + i) % SHOTS_TOTAL;
      if (!next[SCAN_SHOTS[idx].id]) return setActive(idx);
    }
  }, []);

  /** Both camera paths land here: record the shot and move to the next empty station. */
  const acceptShot = useCallback((uri: string) => {
    const next = { ...shots, [shot.id]: uri };
    setShots(next);
    advance(active, next);
  }, [shots, shot, active, advance]);

  const takePhoto = useCallback(async () => {
    Haptics.selectionAsync();
    const granted = await ensureCameraPermission();
    if (!granted) {
      return Alert.alert(
        "Camera access needed",
        "Hairpin needs the camera to photograph your car.",
        [
          { text: "Not now", style: "cancel" },
          { text: "Open Settings", onPress: () => Linking.openSettings() },
        ],
      );
    }
    // Build 74+: our own viewfinder, with the station ghost, the level and auto-capture.
    if (guidedCameraAvailable()) { setViewfinder(true); return; }
    // Build 73 and earlier: the system camera. Same contract — a URI for this station.
    try {
      const res = await ImagePicker.launchCameraAsync({
        // No cropping and no compression worth speaking of: framing and detail
        // are exactly what the reconstruction is reading.
        allowsEditing: false,
        quality: 0.9,
        exif: false,
      });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      acceptShot(res.assets[0].uri);
    } catch {
      Alert.alert("Camera failed", "Could not open the camera. Please try again.");
    }
  }, [acceptShot]);

  const send = useCallback(async () => {
    Haptics.selectionAsync();
    setPhase("uploading");
    setSent(0);
    const s = await getSettings();
    const scanId = newScanId(user?.handle);
    // SERVER-SIDE CAP (Jeff, 2026-08-27): the device counter resets on reinstall, so
    // the bucket is the ledger and register-scan is the gate. FAILS CLOSED — the cap
    // protects paid Tripo credits, so no verdict means no upload, with a retry path.
    const gate = await registerScan(user?.handle, scanId);
    if (!gate.ok) {
      setPhase("capture");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        gate.reason === "cap" ? "No renders left" : "Can't reach the scan service",
        gate.reason === "cap"
          ? `You've used both of your renders (${gate.used}/${gate.max}). Ask Jeff if you need another.`
          : "Check your connection and try again — your photos are still here.",
      );
      return;
    }
    const payload: CapturedShot[] = SCAN_SHOTS.filter((x) => shots[x.id]).map((x) => ({
      shotId: x.id,
      uri: shots[x.id],
    }));
    const r = await uploadScan(
      scanId,
      payload,
      {
        handle: user?.handle ?? null,
        platform: Platform.OS,
        car: {
          year: s.carYear ?? null,
          make: s.carMake ?? null,
          model: s.carModel ?? null,
          color: s.carColor ?? null,
          vehicleClass: s.vehicleClass ?? null,
        },
        capturedAt: new Date().toISOString(),
      },
      (done) => setSent(done),
    );
    // An attempt is only spent when the photos are actually IN the bucket. A
    // failed upload must not burn one of the two renders.
    if (r.ok) {
      await updateSettings({
        carScanId: scanId,
        carScanStatus: "submitted",
        carScanSubmittedAt: new Date().toISOString(),
        carScanAttemptsUsed: (s.carScanAttemptsUsed ?? 0) + 1,
      });
    }
    setResult({ ok: r.ok, uploaded: r.uploaded, error: r.error });
    setPhase("done");
    Haptics.notificationAsync(
      r.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error,
    );
  }, [shots, user]);

  // ── uploading / done ───────────────────────────────────────────────────────
  if (phase !== "capture") {
    const uploading = phase === "uploading";
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centre}>
          {uploading ? (
            <>
              <ActivityIndicator size="large" color={ULTRA.accent} />
              <Text style={styles.bigTitle}>Building your car</Text>
              <Text style={styles.centreBody}>
                {sent} of {SHOTS_TOTAL} photos uploaded
              </Text>
              <Text style={styles.finePrint}>Keep the app open until this finishes.</Text>
            </>
          ) : (
            <>
              <View style={[styles.resultRing, !result?.ok && styles.resultRingBad]}>
                <Ionicons
                  name={result?.ok ? "checkmark" : "alert"}
                  size={44}
                  color={result?.ok ? ULTRA.accent : COLORS.warning}
                />
              </View>
              <Text style={styles.bigTitle}>{result?.ok ? "Your car is in the queue" : "Partly sent"}</Text>
              <Text style={styles.centreBody}>
                {/* Say only what actually happens. There is no automatic
                    build pipeline yet — a person collects these and runs them
                    through by hand — so this must not promise a car appearing
                    on its own. */}
                {result?.ok
                  ? `All ${SHOTS_TOTAL} photos are in. Your car is built by hand right now, so give it a day or two — we'll message you when it's ready. Nothing more to do; you can close the app.`
                  : `${result?.uploaded ?? 0} of ${SHOTS_TOTAL} photos went up.${result?.error ? ` ${result.error}` : ""}`}
              </Text>
              {!result?.ok && (
                <Text style={styles.finePrint}>
                  This did not use up one of your renders.
                </Text>
              )}
              {!result?.ok && (
                <TouchableOpacity style={styles.ghostBtn} onPress={send} activeOpacity={0.85}>
                  <Ionicons name="refresh" size={17} color={ULTRA.accent} />
                  <Text style={styles.ghostText}>Try again</Text>
                </TouchableOpacity>
              )}
              <CandyCta label="Done" onPress={() => router.back()} height={52} tier="ultra" style={styles.doneBtn} />
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // ── the guided viewfinder owns the whole screen while it is open ───────────
  if (viewfinder) {
    return (
      <CarViewfinder
        shot={shot}
        index={active}
        total={SHOTS_TOTAL}
        onCancel={() => setViewfinder(false)}
        onCapture={(uri) => { setViewfinder(false); acceptShot(uri); }}
      />
    );
  }

  // ── capture ────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Scan your car</Text>
        <Text style={styles.counter}>
          {captured}/{SHOTS_TOTAL}
        </Text>
      </View>

      <View style={styles.track}>
        <View style={[styles.trackFill, { width: `${(captured / SHOTS_TOTAL) * 100}%` }]} />
      </View>
      <TierTitle tier="ultra" style={styles.tierTitle} />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Overhead ring — where to stand for this shot. */}
        <View style={styles.ring}>
          {/* The same top-down sprite the pitch screen orbits. A side-profile
              icon rotated 90 degrees reads as a sliver, not a car, and the ring
              only makes sense if the car in it is seen from above. */}
          <Image source={TOPDOWN} style={styles.carSprite} resizeMode="contain" />
          {dots.map((d, i) => {
            const done = !!shots[d.id];
            const isActive = i === active;
            return (
              <TouchableOpacity
                key={d.id}
                onPress={() => {
                  Haptics.selectionAsync();
                  setActive(i);
                }}
                activeOpacity={0.8}
                style={[
                  styles.dot,
                  { left: d.x - 15, top: d.y - 15 },
                  done && styles.dotDone,
                  isActive && styles.dotActive,
                ]}
              >
                {done && !isActive ? (
                  <Ionicons name="checkmark" size={15} color={ULTRA.ink} />
                ) : (
                  <Text style={[styles.dotNum, isActive && styles.dotNumActive]}>{i + 1}</Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.stationLabel}>{shot.label}</Text>
        <Text style={styles.stationHint}>{shot.hint}</Text>
        {/* No pill marking "important" shots: all four are fed to the model,
            so singling any of them out would be a lie. */}

        {/* Every frame, every car. */}
        <View style={styles.reminder}>
          <Ionicons name="information-circle-outline" size={15} color={COLORS.textDim} />
          <Text style={styles.reminderText}>
            Three to four metres back on 1x, phone at head height tilted slightly down.
          </Text>
        </View>

        {/* Filmstrip — tap any tile to re-shoot it. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.strip}
        >
          {SCAN_SHOTS.map((s, i) => (
            <TouchableOpacity
              key={s.id}
              activeOpacity={0.85}
              onPress={() => {
                Haptics.selectionAsync();
                setActive(i);
              }}
              style={[styles.tile, i === active && styles.tileActive]}
            >
              {shots[s.id] ? (
                <Image source={{ uri: shots[s.id] }} style={styles.tileImg} />
              ) : (
                <Text style={styles.tileNum}>{i + 1}</Text>
              )}
            </TouchableOpacity>
          ))}
        </ScrollView>

        <CandyCta
          label={shots[shot.id] ? `Re-shoot ${shot.label.toLowerCase()}` : "Take photo"}
          icon="camera"
          onPress={takePhoto}
          tier="ultra"
          style={styles.shutterWrap}
        />

        <CandyCta
          label={complete ? "Generate my car" : `${SHOTS_TOTAL - captured} to go`}
          icon={complete ? "sparkles" : undefined}
          onPress={send}
          disabled={!complete}
          height={50}
          tier="ultra"
          style={styles.sendBtn}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  scroll: { paddingHorizontal: 22, paddingBottom: 44, alignItems: "center" },

  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 10,
  },
  backBtn: { padding: 6, width: 46 },
  headerTitle: { flex: 1, color: COLORS.text, fontSize: 17, fontWeight: "700", textAlign: "center" },
  counter: {
    width: 46,
    textAlign: "right",
    paddingRight: 8,
    color: COLORS.textDim,
    fontSize: 14,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },

  track: { height: 3, backgroundColor: "#1A1A1A", marginHorizontal: 22, borderRadius: 2, overflow: "hidden" },
  trackFill: { height: 3, backgroundColor: ULTRA.accent },
  tierTitle: { marginTop: 12 },

  ring: {
    width: RING,
    height: RING,
    marginTop: 22,
    marginBottom: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  carSprite: { width: CAR, height: CAR, opacity: 0.5 },
  dot: {
    position: "absolute",
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#121212",
    borderWidth: 1,
    borderColor: "#2A2A2A",
  },
  dotDone: { backgroundColor: ULTRA.accent, borderColor: ULTRA.rim },
  dotActive: {
    backgroundColor: ULTRA.ink,
    borderColor: ULTRA.accent,
    borderWidth: 2,
    transform: [{ scale: 1.18 }],
  },
  dotNum: { color: COLORS.textDim, fontSize: 12, fontWeight: "700" },
  dotNumActive: { color: ULTRA.accent },

  stationLabel: { color: COLORS.text, fontSize: 27, fontWeight: "800", marginTop: 8, textAlign: "center" },
  stationHint: {
    color: COLORS.textDim,
    fontSize: 15,
    lineHeight: 21,
    marginTop: 6,
    textAlign: "center",
    maxWidth: 300,
  },

  reminder: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
    marginTop: 18,
    paddingHorizontal: 4,
    maxWidth: 320,
  },
  reminderText: { flex: 1, color: COLORS.textDim, fontSize: 12.5, lineHeight: 18 },

  strip: { gap: 8, paddingVertical: 20, paddingHorizontal: 2 },
  tile: {
    width: 64,
    height: 48,
    borderRadius: 9,
    backgroundColor: "#101010",
    borderWidth: 1,
    borderColor: "#242424",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  tileActive: { borderColor: ULTRA.accent, borderWidth: 2 },
  tileImg: { width: "100%", height: "100%" },
  tileNum: { color: "#4A4A4A", fontSize: 13, fontWeight: "700" },

  shutterWrap: { alignSelf: "stretch" },
  shutter: {
    height: 54,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  shutterText: { color: "#04150B", fontSize: 17, fontWeight: "800" },

  sendBtn: {
    alignSelf: "stretch",
    height: 50,
    borderRadius: 16,
    marginTop: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: ULTRA.accent,
  },
  sendBtnOff: { borderColor: "#242424" },
  sendText: { color: ULTRA.accent, fontSize: 16, fontWeight: "700" },
  sendTextOff: { color: "#4A4A4A" },

  centre: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 34, gap: 14 },
  bigTitle: { color: COLORS.text, fontSize: 26, fontWeight: "800", textAlign: "center", marginTop: 6 },
  centreBody: { color: COLORS.textDim, fontSize: 15, lineHeight: 22, textAlign: "center" },
  finePrint: { color: "#4A4A4A", fontSize: 12.5, textAlign: "center", marginTop: 2 },

  resultRing: {
    width: 92,
    height: 92,
    borderRadius: 46,
    borderWidth: 2,
    borderColor: ULTRA.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  resultRingBad: { borderColor: COLORS.warning },

  ghostBtn: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 10, marginTop: 4 },
  ghostText: { color: ULTRA.accent, fontSize: 15, fontWeight: "700" },

  doneBtn: {
    alignSelf: "stretch",
    height: 52,
    borderRadius: 16,
    backgroundColor: ULTRA.accent,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 10,
  },
  doneText: { color: "#04150B", fontSize: 17, fontWeight: "800" },
});
