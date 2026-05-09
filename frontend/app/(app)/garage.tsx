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

export default function GarageScreen() {
  const { user, refresh } = useAuth();
  const router = useRouter();

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
          {/* Live preview — what other drivers see on the map */}
          <Glass radius={22} style={{ marginBottom: 18 }}>
            <View style={styles.previewBox}>
              <View style={{ alignItems: "center", marginBottom: 8 }}>
                <CarMarker body={body} color={color} heading={0} size={140} />
              </View>
              <Text style={styles.previewLabel}>{[year, make, model].filter(Boolean).join(" ") || "Your car"}</Text>
              <Text style={styles.previewSub}>{color || "—"} · {body}</Text>
            </View>
          </Glass>

          {/* Year / Make / Model / Color */}
          <Field label="Year" value={year} onChange={setYear} placeholder="1999" keyboard="number-pad" testID="garage-year" />
          <Field label="Make" value={make} onChange={setMake} placeholder="Nissan" testID="garage-make" />
          <Field label="Model" value={model} onChange={setModel} placeholder="Skyline GT-R" testID="garage-model" />
          <Field label="Color" value={color} onChange={setColor} placeholder="Bayside Blue" testID="garage-color" />

          {/* Color swatches — tap-to-pick from a curated palette (also keeps free-form input) */}
          <Text style={styles.section}>Quick colors</Text>
          <View style={styles.swatchRow}>
            {CAR_COLORS.map((c) => (
              <TouchableOpacity
                key={c.name}
                onPress={() => setColor(c.name)}
                activeOpacity={0.85}
                testID={`garage-color-${c.name}`}
              >
                <View style={[
                  styles.swatch,
                  { backgroundColor: c.hex },
                  color.toLowerCase() === c.name.toLowerCase() && styles.swatchActive,
                ]} />
              </TouchableOpacity>
            ))}
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
  // Preview block
  previewBox: { padding: 16, alignItems: "center" },
  previewLabel: { color: COLORS.text, fontSize: 16, fontWeight: "700", marginTop: 8 },
  previewSub: { color: COLORS.textDim, fontSize: 12, marginTop: 2, textTransform: "capitalize" },
  // Color swatches
  swatchRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 4 },
  swatch: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 2, borderColor: "rgba(255,255,255,0.18)",
  },
  swatchActive: { borderColor: "#FFC700", transform: [{ scale: 1.08 }] },
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
