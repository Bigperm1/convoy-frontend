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
  TextInput,
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
import { logEvent } from "../../src/crashBreadcrumb";
import { findColorsForTyped, type CarColor } from "../../src/carDatabase";
import { MAIN_COLORS, CLUB_PALETTES } from "../../src/paintPalettes";
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

type Phase = "capture" | "paint" | "uploading" | "done";

// The paint the tester declares before sending — the pipeline color-matches the
// 3D reconstruction's body to this hex (photos alone shift massively with
// lighting; the declared paint is the ground truth). BACKEND-ONLY: it rides in
// the scan manifest and touches nothing else in the app.
type ScanPaint = {
  name?: string;
  hex: string;
  source: "factory" | "main" | "club" | "custom";
  /** Which club palette it came from, when source is "club" — the pipeline gets
   *  "Bayside Blue (Nissan)", not a bare name shared across marques. */
  group?: string;
};

const HEX_RE = /^[0-9a-fA-F]{6}$/;
const isLightHex = (hex: string) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 160;
};

export default function GarageCaptureScreen() {
  const { user } = useAuth();
  const [shots, setShots] = useState<Record<string, string>>({});
  const [active, setActive] = useState(0);
  const [phase, setPhase] = useState<Phase>("capture");
  const [sent, setSent] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; uploaded: number; error?: string } | null>(null);
  // Paint declaration (the "paint" phase). Factory list is matched from the
  // free-typed make/model; generic basics always offered; hex = paint code.
  const [paintSel, setPaintSel] = useState<ScanPaint | null>(null);
  const [paintHexDraft, setPaintHexDraft] = useState("");
  // Which club palette is open. Null = none; the chips are a filter, not a mode.
  const [clubOpen, setClubOpen] = useState<string | null>(null);
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
    // PROBE (2026-08-29): the lap is 4 stations and a tester who gives up mid-lap
    // leaves NOTHING behind today — the upload never runs, so carScan never logs.
    // Abandonment is invisible without a crumb per accepted shot. `n=` is how far
    // round they got; a run that stops at n=2 is a usability finding, not a bug report.
    try { logEvent(`carscan-shot-taken shot=${shot.id} n=${Object.keys(next).length}/${SHOTS_TOTAL}`); } catch {}
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

  // Upload into the ACTIVE station from the photo library (Jeff, 2026-08-27: "could
  // we add a upload feature to each photo slot as well if they decide to take a photo
  // with the stock camera?"). Same contract as the camera paths — a URI for this
  // station — so the send/upload half never learns where a frame came from.
  // allowsEditing stays OFF: cropping is exactly what wrecks the reconstruction's
  // framing, and the guided shots are uncropped too.
  const uploadPhoto = useCallback(async () => {
    Haptics.selectionAsync();
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== "granted") {
        return Alert.alert(
          "Photo access needed",
          "Allow photo access to upload a shot you already took.",
          [
            { text: "Not now", style: "cancel" },
            { text: "Open Settings", onPress: () => Linking.openSettings() },
          ],
        );
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 0.9,
        exif: false,
      });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      acceptShot(res.assets[0].uri);
    } catch {
      Alert.alert("Upload failed", "Could not open your photos. Please try again.");
    }
  }, [acceptShot]);

  const send = useCallback(async (paint: ScanPaint | null) => {
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
        // The declared paint target (null = "match my photos"). The pipeline
        // corrects the reconstruction's body color toward this hex, keeping
        // the photo texture's shading — and sanity-checks it against the
        // photos' median body color before applying.
        paint: paint
          ? { name: paint.name ?? null, hex: paint.hex, source: paint.source, group: paint.group ?? null }
          : null,
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

  // ── paint declaration (between capture and upload) ─────────────────────────
  if (phase === "paint") {
    const st = getSettings();
    const factory = findColorsForTyped(st.carMake, st.carModel);
    // A factory match already names this car's version of black/white/silver, so
    // the universal row drops any duplicate NAME rather than showing both.
    const factoryNames = new Set(factory.map((c) => c.name.toLowerCase()));
    const main = MAIN_COLORS.filter((c) => !factoryNames.has(c.name.toLowerCase()));
    const carLine = [st.carYear, st.carMake, st.carModel].filter(Boolean).join(" ");
    const club = CLUB_PALETTES.find((g) => g.label === clubOpen);
    const pick = (c: CarColor, source: ScanPaint["source"], group?: string) => {
      Haptics.selectionAsync();
      setPaintHexDraft("");
      setPaintSel({ name: c.name, hex: c.hex, source, group });
    };
    const hexValid = HEX_RE.test(paintHexDraft.trim().replace(/^#/, ""));
    const applyHex = () => {
      const raw = paintHexDraft.trim().replace(/^#/, "");
      if (!HEX_RE.test(raw)) return;
      Haptics.selectionAsync();
      setPaintSel({ hex: "#" + raw.toUpperCase(), source: "custom" });
    };
    const swatch = (c: CarColor, source: ScanPaint["source"], group?: string) => {
      const on =
        paintSel?.source === source &&
        paintSel?.group === group &&
        paintSel?.name === c.name &&
        paintSel?.hex.toLowerCase() === c.hex.toLowerCase();
      return (
        <TouchableOpacity
          key={source + (group ?? "") + c.name + c.hex}
          activeOpacity={0.8}
          onPress={() => pick(c, source, group)}
          style={[styles.paintSwatch, { backgroundColor: c.hex }, on && styles.paintSwatchOn]}
        >
          {on && <Ionicons name="checkmark" size={16} color={isLightHex(c.hex) ? "#000" : "#FFF"} />}
        </TouchableOpacity>
      );
    };
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity onPress={() => setPhase("capture")} style={styles.backBtn} hitSlop={10}>
            <Ionicons name="chevron-back" size={26} color="#EDEDED" />
          </TouchableOpacity>
          <Text style={styles.bigTitle}>Confirm your paint</Text>
          <Text style={styles.centreBody}>
            Phone photos shift with lighting. Pick your real paint and the 3D build gets
            color-matched to it{carLine ? ` — ${carLine}` : ""}.
          </Text>

          {factory.length > 0 && (
            <>
              <Text style={styles.paintGroup}>Factory colors{st.carModel ? ` — ${st.carModel}` : ""}</Text>
              <View style={styles.paintRow}>{factory.map((c) => swatch(c, "factory"))}</View>
            </>
          )}

          <Text style={styles.paintGroup}>Main colors</Text>
          <View style={styles.paintRow}>{main.map((c) => swatch(c, "main"))}</View>

          {CLUB_PALETTES.length > 0 && (
            <>
              <Text style={styles.paintGroup}>Club colors — the ones people name</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.clubChipScroll}
                contentContainerStyle={styles.clubChipRow}
              >
                {CLUB_PALETTES.map((g) => {
                  const on = clubOpen === g.label;
                  return (
                    <TouchableOpacity
                      key={g.label}
                      activeOpacity={0.85}
                      onPress={() => {
                        Haptics.selectionAsync();
                        setClubOpen(on ? null : g.label);
                      }}
                      style={[styles.clubChip, on && styles.clubChipOn]}
                    >
                      <Text style={[styles.clubChipText, on && styles.clubChipTextOn]}>{g.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              {club ? (
                <View style={styles.paintRow}>{club.colors.map((c) => swatch(c, "club", club.label))}</View>
              ) : (
                <Text style={styles.clubHint}>Pick a club to see its legendary paints.</Text>
              )}
            </>
          )}

          <Text style={styles.paintGroup}>Have the paint code? Enter the hex</Text>
          <View style={styles.paintHexRow}>
            <Text style={styles.paintHexHash}>#</Text>
            <TextInput
              style={styles.paintHexInput}
              value={paintHexDraft}
              onChangeText={setPaintHexDraft}
              placeholder="C0152A"
              placeholderTextColor="#606060"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={7}
              returnKeyType="done"
              onSubmitEditing={applyHex}
            />
            <TouchableOpacity
              style={[styles.paintHexApply, !hexValid && { opacity: 0.4 }]}
              activeOpacity={0.85}
              disabled={!hexValid}
              onPress={applyHex}
            >
              <Text style={styles.paintHexApplyText}>Use</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.paintPicked}>
            {paintSel
              ? paintSel.source === "custom"
                ? `Custom paint ${paintSel.hex}`
                : `${paintSel.name}${paintSel.group ? ` · ${paintSel.group}` : ""}`
              : "No paint picked yet"}
          </Text>
          <CandyCta
            label="Lock in paint & send"
            icon="sparkles"
            onPress={() => send(paintSel)}
            disabled={!paintSel}
            height={50}
            tier="ultra"
            style={styles.sendBtn}
          />
          <TouchableOpacity style={styles.ghostBtn} onPress={() => send(null)} activeOpacity={0.85}>
            <Text style={styles.ghostText}>Skip — match my photos</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

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
                <TouchableOpacity style={styles.ghostBtn} onPress={() => send(paintSel)} activeOpacity={0.85}>
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
              {/* Per-slot upload. Selecting the station first means the picker always
                  lands the frame where the driver tapped, with no second target. */}
              <TouchableOpacity
                onPress={() => { setActive(i); void uploadPhoto(); }}
                hitSlop={6}
                style={styles.tileUpload}
              >
                <Ionicons name="image-outline" size={13} color={ULTRA.accent} />
              </TouchableOpacity>
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

        <TouchableOpacity style={styles.uploadBtn} activeOpacity={0.85} onPress={uploadPhoto}>
          <Ionicons name="image-outline" size={17} color={ULTRA.accent} />
          <Text style={styles.uploadText}>Upload {shot.label.toLowerCase()} from photos</Text>
        </TouchableOpacity>

        <CandyCta
          label={complete ? "Generate my car" : `${SHOTS_TOTAL - captured} to go`}
          icon={complete ? "sparkles" : undefined}
          onPress={() => setPhase("paint")}
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
  // ── paint phase ──
  paintGroup: { color: "#808080", fontSize: 12, fontWeight: "600", alignSelf: "flex-start", marginTop: 18, marginBottom: 8 },
  paintRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, alignSelf: "flex-start" },
  paintSwatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  paintSwatchOn: { borderColor: ULTRA.accent, borderWidth: 2 },
  paintHexRow: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "stretch" },
  paintHexHash: { color: "#808080", fontSize: 16, fontWeight: "700" },
  paintHexInput: { flex: 1, color: "#EDEDED", fontSize: 15, borderWidth: 1, borderColor: "#2A2A2A", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "#131313" },
  paintHexApply: { borderWidth: 1, borderColor: ULTRA.accent, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  paintHexApplyText: { color: ULTRA.accent, fontSize: 14, fontWeight: "700" },
  paintPicked: { color: "#EDEDED", fontSize: 14, fontWeight: "600", marginTop: 16, marginBottom: 4 },
  clubChipScroll: { alignSelf: "stretch", marginBottom: 10 },
  clubChipRow: { gap: 8, paddingRight: 8 },
  clubChip: { borderWidth: 1, borderColor: "#2A2A2A", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: "#131313" },
  clubChipOn: { borderColor: ULTRA.accent, backgroundColor: "rgba(224,169,62,0.12)" },
  clubChipText: { color: "#9A9A9E", fontSize: 13, fontWeight: "600" },
  clubChipTextOn: { color: ULTRA.accent },
  clubHint: { color: "#606060", fontSize: 12, alignSelf: "flex-start", marginTop: 2 },
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

  tileUpload: {
    position: "absolute", right: 3, bottom: 3,
    width: 22, height: 22, borderRadius: 11,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.66)",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(224,169,62,0.5)",
  },
  uploadBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    alignSelf: "stretch", marginTop: 12,
    borderWidth: 1, borderColor: "#2A2A2A", borderRadius: 12, paddingVertical: 12,
  },
  uploadText: { color: ULTRA.accent, fontSize: 14, fontWeight: "600" },
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
