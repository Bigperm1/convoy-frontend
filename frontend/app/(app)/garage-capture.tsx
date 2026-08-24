// Garage Capture — the guided eight-shot lap that Garage Scan pitches.
//
// One station at a time, in a clockwise walk around the car. The tester never
// decides what to shoot or in what order; the ring diagram shows where to stand
// and the camera opens straight into the next station. Any tile can be re-shot
// before sending, because the whole set goes up in one batch at the end.
//
// The four straight-on views carry a "feeds the model" mark — those are the ones
// Tripo reconstructs from (see src/carScan.ts for why). The other four are for
// the retexture pass and for vendors that accept more views.

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
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";

import { COLORS } from "../../src/theme";
import { useAuth } from "../../src/auth";
import { getSettings } from "../../src/settings";
import { ensureCameraPermission } from "../../src/permissionGate";
import { SCAN_SHOTS, SHOTS_TOTAL, newScanId, uploadScan, type CapturedShot } from "../../src/carScan";

const RING = 200;          // diagram box
const RING_R = 78;         // station orbit radius

type Phase = "capture" | "uploading" | "done";

export default function GarageCaptureScreen() {
  const { user } = useAuth();
  const [shots, setShots] = useState<Record<string, string>>({});
  const [active, setActive] = useState(0);
  const [phase, setPhase] = useState<Phase>("capture");
  const [sent, setSent] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; uploaded: number; error?: string } | null>(null);

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
    try {
      const res = await ImagePicker.launchCameraAsync({
        // No cropping and no compression worth speaking of: framing and detail
        // are exactly what the reconstruction is reading.
        allowsEditing: false,
        quality: 0.9,
        exif: false,
      });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      const next = { ...shots, [shot.id]: res.assets[0].uri };
      setShots(next);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      advance(active, next);
    } catch {
      Alert.alert("Camera failed", "Could not open the camera. Please try again.");
    }
  }, [shots, shot, active, advance]);

  const send = useCallback(async () => {
    Haptics.selectionAsync();
    setPhase("uploading");
    setSent(0);
    const s = await getSettings();
    const scanId = newScanId(user?.handle);
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
              <ActivityIndicator size="large" color={COLORS.brand} />
              <Text style={styles.bigTitle}>Sending your car</Text>
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
                  color={result?.ok ? COLORS.brand : COLORS.warning}
                />
              </View>
              <Text style={styles.bigTitle}>{result?.ok ? "Got it" : "Partly sent"}</Text>
              <Text style={styles.centreBody}>
                {result?.ok
                  ? `All ${SHOTS_TOTAL} photos are in. We'll build your car and let you know when it lands on the map.`
                  : `${result?.uploaded ?? 0} of ${SHOTS_TOTAL} photos went up.${result?.error ? ` ${result.error}` : ""}`}
              </Text>
              {!result?.ok && (
                <TouchableOpacity style={styles.ghostBtn} onPress={send} activeOpacity={0.85}>
                  <Ionicons name="refresh" size={17} color={COLORS.brand} />
                  <Text style={styles.ghostText}>Try again</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.doneBtn} onPress={() => router.back()} activeOpacity={0.9}>
                <Text style={styles.doneText}>Done</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </SafeAreaView>
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

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Overhead ring — where to stand for this shot. */}
        <View style={styles.ring}>
          <MaterialCommunityIcons
            name="car-sports"
            size={62}
            color="#2A2A2A"
            style={{ transform: [{ rotate: "-90deg" }] }}
          />
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
                  <Ionicons name="checkmark" size={15} color="#04150B" />
                ) : (
                  <Text style={[styles.dotNum, isActive && styles.dotNumActive]}>{i + 1}</Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.stationLabel}>{shot.label}</Text>
        <Text style={styles.stationHint}>{shot.hint}</Text>
        {shot.feedsModel ? (
          <View style={styles.keyPill}>
            <Ionicons name="star" size={11} color="#04150B" />
            <Text style={styles.keyPillText}>Builds the model — take your time</Text>
          </View>
        ) : (
          <View style={styles.softPill}>
            <Text style={styles.softPillText}>Detail shot</Text>
          </View>
        )}

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

        <TouchableOpacity activeOpacity={0.9} onPress={takePhoto} style={styles.shutterWrap}>
          <LinearGradient
            colors={[COLORS.brand, COLORS.brandDim]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={styles.shutter}
          >
            <Ionicons name="camera" size={20} color="#04150B" />
            <Text style={styles.shutterText}>
              {shots[shot.id] ? `Re-shoot ${shot.label.toLowerCase()}` : "Take photo"}
            </Text>
          </LinearGradient>
        </TouchableOpacity>

        <TouchableOpacity
          activeOpacity={0.9}
          onPress={send}
          disabled={!complete}
          style={[styles.sendBtn, !complete && styles.sendBtnOff]}
        >
          <Text style={[styles.sendText, !complete && styles.sendTextOff]}>
            {complete ? `Send ${SHOTS_TOTAL} photos` : `${SHOTS_TOTAL - captured} to go`}
          </Text>
        </TouchableOpacity>
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
  trackFill: { height: 3, backgroundColor: COLORS.brand },

  ring: {
    width: RING,
    height: RING,
    marginTop: 22,
    marginBottom: 6,
    alignItems: "center",
    justifyContent: "center",
  },
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
  dotDone: { backgroundColor: COLORS.brand, borderColor: COLORS.brand },
  dotActive: {
    backgroundColor: "#04150B",
    borderColor: COLORS.brand,
    borderWidth: 2,
    transform: [{ scale: 1.18 }],
  },
  dotNum: { color: COLORS.textDim, fontSize: 12, fontWeight: "700" },
  dotNumActive: { color: COLORS.brand },

  stationLabel: { color: COLORS.text, fontSize: 27, fontWeight: "800", marginTop: 8, textAlign: "center" },
  stationHint: {
    color: COLORS.textDim,
    fontSize: 15,
    lineHeight: 21,
    marginTop: 6,
    textAlign: "center",
    maxWidth: 300,
  },

  keyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: COLORS.brand,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 5,
    marginTop: 12,
  },
  keyPillText: { color: "#04150B", fontSize: 11, fontWeight: "800" },
  softPill: {
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 5,
    marginTop: 12,
    borderWidth: 1,
    borderColor: "#2A2A2A",
  },
  softPillText: { color: COLORS.textDim, fontSize: 11, fontWeight: "700" },

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
  tileActive: { borderColor: COLORS.brand, borderWidth: 2 },
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
    borderColor: COLORS.brand,
  },
  sendBtnOff: { borderColor: "#242424" },
  sendText: { color: COLORS.brand, fontSize: 16, fontWeight: "700" },
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
    borderColor: COLORS.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  resultRingBad: { borderColor: COLORS.warning },

  ghostBtn: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 10, marginTop: 4 },
  ghostText: { color: COLORS.brand, fontSize: 15, fontWeight: "700" },

  doneBtn: {
    alignSelf: "stretch",
    height: 52,
    borderRadius: 16,
    backgroundColor: COLORS.brand,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 10,
  },
  doneText: { color: "#04150B", fontSize: 17, fontWeight: "800" },
});
