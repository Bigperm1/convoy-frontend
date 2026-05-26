// Garage — driver profile editor.
//
// Lets the user edit their car: Year / Make / Model / Color, then pick the
// silhouette body type and car color shown to other drivers on the map.
// PATCH-style — sends only the changed fields to PUT /auth/profile.

import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, Alert, Platform, KeyboardAvoidingView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";

import { useAuth } from "../../src/auth";
import { api, formatErr } from "../../src/api";
import { COLORS } from "../../src/theme";
import Glass from "../../src/Glass";
import CarMarker, { CAR_BODIES, CAR_COLORS, CarBody } from "../../src/CarMarker";
import { useSettings, kmhToDisplay } from "../../src/settings";

export default function GarageScreen() {
  const { user, refresh } = useAuth();
  const router = useRouter();
  // Speed-unit preference — the backend always stores top_speed_record in
  // KM/H so we convert at the display layer to match the user's choice.
  const [settings] = useSettings();

  const [year, setYear]   = useState<string>(user?.car_year ? String(user.car_year) : "");
  const [make, setMake]   = useState<string>(user?.car_make || "");
  const [model, setModel] = useState<string>(user?.car_model || "");
  const [color, setColor] = useState<string>(user?.car_color || "Bayside Blue");
  const [body, setBody]   = useState<CarBody>((user?.car_type as CarBody) || "sedan");
  const [busy, setBusy]   = useState(false);

  // Re-hydrate when user object changes (e.g. after refresh)
  useEffect(() => {
    if (!user) return;
    setYear(user.car_year ? String(user.car_year) : "");
    setMake(user.car_make || "");
    setModel(user.car_model || "");
    setColor(user.car_color || "Bayside Blue");
    setBody((user.car_type as CarBody) || "sedan");
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    try {
      const yearNum = year.trim() ? Number(year.trim()) : null;
      await api.put("/auth/profile", {
        car_year: Number.isFinite(yearNum as number) ? yearNum : null,
        car_make: make.trim(),
        car_model: model.trim(),
        car_color: color.trim(),
        car_type: body,
      });
      await refresh();
      Alert.alert("Saved", "Your garage is up to date.");
    } catch (e) { Alert.alert("Save failed", formatErr(e)); }
    finally { setBusy(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={22} color={COLORS.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Garage</Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 18, paddingBottom: 120 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* ===== Live Preview — virtual garage stage =====
              Replaces the flat Glass card with a polished "showroom" look:
              radial concrete-floor gradient + LED accent border. The car sits
              on the stage and recolors live as the user picks a swatch below.
              Inspired by the high-end virtual garage reference. */}
          <View style={styles.stageOuter}>
            <View style={styles.stageLed} testID="garage-stage" pointerEvents="none" />
            <LinearGradient
              colors={[
                "rgba(40,40,46,0.92)",  // back wall — darker concrete
                "rgba(28,28,32,0.92)",  // floor center
                "rgba(18,18,22,0.95)",  // foreground edge
              ]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={styles.stageBg}
            >
              {/* radial spotlight on the car (subtle) */}
              <LinearGradient
                colors={[ "rgba(255,255,255,0.10)", "rgba(255,255,255,0)" ]}
                style={styles.stageSpot}
                start={{ x: 0.5, y: 0 }}
                end={{ x: 0.5, y: 1 }}
              />
              <View style={styles.stageCar}>
                <CarMarker body={body} color={color} heading={0} size={170} />
              </View>
              <View style={styles.stageCaption}>
                <Text style={styles.previewLabel}>{[year, make, model].filter(Boolean).join(" ") || "Your car"}</Text>
                <Text style={styles.previewSub}>{color || "—"} · {body}</Text>
              </View>
            </LinearGradient>
          </View>

          {/* Personal best — Top Cruise Speed from Map sessions. Auto-tracked, read-only. */}
          <Glass radius={22} style={{ marginBottom: 18 }}>
            <View style={styles.pbBox} testID="garage-personal-best">
              <View style={styles.pbIconWrap}>
                <Ionicons name="speedometer" size={26} color="#FFC700" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.pbLabel}>Top Cruise Speed</Text>
                <Text style={styles.pbHint}>
                  {user?.top_speed_record && user.top_speed_record > 0
                    ? "Personal best — beat it on your next drive."
                    : "Drive with the Map open to set your first record."}
                </Text>
              </View>
              <View style={styles.pbValueWrap}>
                <Text style={styles.pbValue} testID="garage-personal-best-value">
                  {user?.top_speed_record && user.top_speed_record > 0
                    ? kmhToDisplay(user.top_speed_record, settings.speedUnit)
                    : "—"}
                </Text>
                <Text style={styles.pbUnit}>{settings.speedUnit === 'mph' ? 'mph' : 'km/h'}</Text>
              </View>
            </View>
          </Glass>

          {/* Year / Make / Model / Color */}
          <Field label="Year" value={year} onChange={setYear} placeholder="1999" keyboard="number-pad" testID="garage-year" />
          <Field label="Make" value={make} onChange={setMake} placeholder="Nissan" testID="garage-make" />
          <Field label="Model" value={model} onChange={setModel} placeholder="Skyline GT-R" testID="garage-model" />
          <Field label="Color" value={color} onChange={setColor} placeholder="Bayside Blue" testID="garage-color" />

          {/* Color swatches — tap-to-pick. Each chip shows the named color
              underneath so the driver can communicate "Stratosphere Blue" to
              fellow community members instead of guessing the hex. */}
          <Text style={styles.section}>Quick colors</Text>
          <View style={styles.swatchRow}>
            {CAR_COLORS.map((c) => {
              const active = color.toLowerCase() === c.name.toLowerCase();
              return (
                <TouchableOpacity
                  key={c.name}
                  onPress={() => setColor(c.name)}
                  activeOpacity={0.85}
                  testID={`garage-color-${c.name}`}
                  style={styles.swatchTile}
                >
                  <View style={[
                    styles.swatch,
                    { backgroundColor: c.hex },
                    active && styles.swatchActive,
                    // Lift Ice Cap White off the dark background so it doesn't
                    // look like an empty chip.
                    c.name === "Ice Cap White" && { borderColor: "rgba(255,255,255,0.28)" },
                  ]} />
                  <Text style={[styles.swatchLabel, active && styles.swatchLabelActive]} numberOfLines={1}>
                    {c.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Body type / icon */}
          <Text style={styles.section}>Car icon</Text>
          <View style={styles.bodyGrid}>
            {CAR_BODIES.map((b) => {
              const active = body === b.id;
              return (
                <TouchableOpacity
                  key={b.id}
                  onPress={() => setBody(b.id)}
                  activeOpacity={0.85}
                  testID={`garage-body-${b.id}`}
                  style={[styles.bodyCard, active && styles.bodyCardActive]}
                >
                  <CarMarker body={b.id} color={color} heading={0} size={56} />
                  <Text style={[styles.bodyLabel, active && { color: COLORS.text }]}>{b.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Save */}
          <TouchableOpacity testID="garage-save" disabled={busy} onPress={save} style={styles.btn} activeOpacity={0.85}>
            <LinearGradient colors={["#FFE45C", "#FFC700", "#FF9F0A"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.btnGrad}>
              <Text style={styles.btnText}>{busy ? "Saving…" : "Save garage"}</Text>
            </LinearGradient>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, value, onChange, placeholder, keyboard, testID }: any) {
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={COLORS.textMute}
        keyboardType={keyboard || "default"}
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 10 },
  backBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  title: { color: COLORS.text, fontSize: 22, fontWeight: "700", letterSpacing: -0.4 },
  section: { color: COLORS.text, fontSize: 16, fontWeight: "600", marginTop: 22, marginBottom: 8, letterSpacing: -0.2 },
  label: { color: COLORS.textDim, fontSize: 12, marginBottom: 6, fontWeight: "500" },
  input: { backgroundColor: "rgba(118,118,128,0.18)", color: COLORS.text, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, fontSize: 16 },
  // Preview block — virtual-garage stage (concrete + LED frame)
  stageOuter: {
    marginBottom: 18,
    borderRadius: 24,
    overflow: "hidden",
    position: "relative",
  },
  // Glowing LED border outline. Sits on top of the gradient; pointerEvents none.
  stageLed: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(255,199,0,0.55)", // brand yellow LED accent
    shadowColor: "#FFC700",
    shadowOpacity: 0.45,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    zIndex: 2,
  },
  stageBg: {
    paddingHorizontal: 18,
    paddingVertical: 22,
    minHeight: 230,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
  },
  stageSpot: {
    position: "absolute",
    top: 0, left: "10%", right: "10%",
    height: "60%",
    borderRadius: 200,
  },
  stageCar: { alignItems: "center", marginBottom: 10 },
  stageCaption: { alignItems: "center" },
  previewBox: { padding: 16, alignItems: "center" }, // legacy — kept in case
  previewLabel: { color: COLORS.text, fontSize: 16, fontWeight: "700", marginTop: 8 },
  previewSub: { color: COLORS.textDim, fontSize: 12, marginTop: 2, textTransform: "capitalize" },
  // Personal best tile
  pbBox: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16 },
  pbIconWrap: {
    width: 48, height: 48, borderRadius: 14,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(255,199,0,0.14)",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,199,0,0.45)",
  },
  pbLabel: { color: COLORS.text, fontSize: 15, fontWeight: "700", letterSpacing: -0.2 },
  pbHint: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  pbValueWrap: { alignItems: "flex-end" },
  pbValue: { color: "#FFC700", fontSize: 28, fontWeight: "800", letterSpacing: -0.5, lineHeight: 30 },
  pbUnit: { color: COLORS.textDim, fontSize: 11, fontWeight: "600", marginTop: 2 },
  // Color swatches — tiles with a label underneath each color circle.
  swatchRow: { flexDirection: "row", flexWrap: "wrap", gap: 14, marginTop: 6, marginBottom: 8 },
  swatchTile: { alignItems: "center", width: 76 },
  swatch: {
    width: 38, height: 38, borderRadius: 19,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.10)",
  },
  swatchActive: { borderColor: "#FFC700", transform: [{ scale: 1.10 }] },
  swatchLabel: { color: COLORS.textDim, fontSize: 10, fontWeight: "600", marginTop: 6, textAlign: "center" },
  swatchLabelActive: { color: COLORS.text, fontWeight: "700" },
  // Body grid
  bodyGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  bodyCard: {
    width: "30%", aspectRatio: 1,
    backgroundColor: "rgba(118,118,128,0.12)",
    borderWidth: 1, borderColor: COLORS.hairline,
    borderRadius: 14,
    alignItems: "center", justifyContent: "center", gap: 4,
  },
  bodyCardActive: { borderColor: "#FFC700", backgroundColor: "rgba(255,199,0,0.10)" },
  bodyLabel: { color: COLORS.textDim, fontSize: 11, fontWeight: "600", letterSpacing: 0.2 },
  // CTA
  btn: { marginTop: 28, borderRadius: 16, overflow: "hidden" },
  btnGrad: { paddingVertical: 16, alignItems: "center" },
  btnText: { color: "#1a1a1a", fontWeight: "700", fontSize: 16, letterSpacing: 0.2 },
});
