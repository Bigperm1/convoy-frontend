import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, KeyboardAvoidingView, Platform, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "../../src/auth";
import { api, formatErr } from "../../src/api";
import { COLORS } from "../../src/theme";
import Glass from "../../src/Glass";

export default function GarageScreen() {
  const { user, logout, refresh } = useAuth();
  const [handle, setHandle] = useState(user?.handle || "");
  const [make, setMake] = useState(user?.car_make || "");
  const [model, setModel] = useState(user?.car_model || "");
  const [year, setYear] = useState(user?.car_year ? String(user.car_year) : "");
  const [color, setColor] = useState(user?.car_color || "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    try {
      setBusy(true);
      await api.put("/auth/profile", {
        handle, car_make: make, car_model: model,
        car_year: year ? parseInt(year, 10) : null, car_color: color,
      });
      await refresh();
      Alert.alert("Saved", "Profile updated");
    } catch (e) { Alert.alert("Save failed", formatErr(e)); }
    finally { setBusy(false); }
  };

  return (
    <SafeAreaView style={styles.c} edges={["top"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 120 }}>
          <Text style={styles.title}>Garage</Text>
          <Text style={styles.sub}>{user?.email}</Text>

          <Glass radius={28} style={{ marginTop: 18 }}>
            <View style={{ alignItems: "center", padding: 22 }}>
              <View style={styles.avatar}>
                <LinearGradient colors={[COLORS.primary, COLORS.accent]} style={StyleSheet.absoluteFill} />
                <Ionicons name="car-sport" size={48} color="#fff" />
              </View>
              <Text style={styles.heroName}>{handle || "Driver"}</Text>
              <Text style={styles.heroCar}>
                {[year, make, model].filter(Boolean).join(" ") || "Add your car details"}
                {color ? ` · ${color}` : ""}
              </Text>
            </View>
          </Glass>

          <Text style={styles.sectionTitle}>Profile</Text>
          <Glass radius={20}>
            <View style={{ padding: 16 }}>
              <Field testID="garage-handle" label="Handle" value={handle} onChange={setHandle} />
              <Field testID="garage-make" label="Make" value={make} onChange={setMake} />
              <Field testID="garage-model" label="Model" value={model} onChange={setModel} />
              <Field testID="garage-year" label="Year" value={year} onChange={setYear} keyboard="number-pad" />
              <Field testID="garage-color" label="Color" value={color} onChange={setColor} />
              <TouchableOpacity testID="garage-save" onPress={save} disabled={busy} style={styles.btn} activeOpacity={0.85}>
                <LinearGradient colors={[COLORS.primary, COLORS.primaryDim]} style={styles.btnGrad}>
                  <Text style={styles.btnText}>{busy ? "Saving…" : "Save"}</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </Glass>

          <TouchableOpacity testID="logout-btn" style={styles.logoutBtn} onPress={logout}>
            <Ionicons name="log-out" size={18} color={COLORS.danger} />
            <Text style={styles.logoutText}>Sign out</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, value, onChange, keyboard, testID }: any) {
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        testID={testID}
        style={styles.input}
        value={value}
        onChangeText={onChange}
        keyboardType={keyboard || "default"}
        placeholderTextColor={COLORS.textMute}
      />
    </>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg },
  title: { color: COLORS.text, fontSize: 34, fontWeight: "700", letterSpacing: -1 },
  sub: { color: COLORS.textDim, marginTop: 2, fontSize: 13 },
  avatar: { width: 96, height: 96, borderRadius: 48, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  heroName: { color: COLORS.text, fontSize: 22, fontWeight: "700", letterSpacing: -0.5, marginTop: 14 },
  heroCar: { color: COLORS.textDim, marginTop: 4, fontSize: 14 },
  sectionTitle: { color: COLORS.textDim, marginTop: 22, marginBottom: 8, fontSize: 13, fontWeight: "500" },
  label: { color: COLORS.textDim, fontSize: 13, marginTop: 12, marginBottom: 6, fontWeight: "500" },
  input: { backgroundColor: "rgba(118,118,128,0.18)", color: COLORS.text, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, fontSize: 16 },
  btn: { marginTop: 18, borderRadius: 14, overflow: "hidden" },
  btnGrad: { paddingVertical: 14, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  logoutBtn: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 22, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,69,58,0.3)" },
  logoutText: { color: COLORS.danger, fontWeight: "600", fontSize: 15 },
});
