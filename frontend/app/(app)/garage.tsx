import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, KeyboardAvoidingView, Platform, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../src/auth";
import { api, formatErr } from "../../src/api";
import { COLORS } from "../../src/theme";

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
        handle,
        car_make: make,
        car_model: model,
        car_year: year ? parseInt(year, 10) : null,
        car_color: color,
      });
      await refresh();
      Alert.alert("Saved", "Profile updated");
    } catch (e) {
      Alert.alert("Save failed", formatErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.c} edges={["top"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 40 }}>
          <Text style={styles.title}>GARAGE</Text>
          <Text style={styles.sub}>{user?.email}</Text>

          <View style={styles.heroCard}>
            <View style={styles.avatar}><Ionicons name="car-sport" size={48} color={COLORS.primary} /></View>
            <Text style={styles.heroName}>{handle || "Driver"}</Text>
            <Text style={styles.heroCar}>
              {[year, make, model].filter(Boolean).join(" ") || "Add your car details"}
              {color ? ` · ${color}` : ""}
            </Text>
          </View>

          <Text style={styles.sectionTitle}>PROFILE</Text>
          <View style={styles.card}>
            <Field testID="garage-handle" label="HANDLE" value={handle} onChange={setHandle} />
            <Field testID="garage-make" label="MAKE" value={make} onChange={setMake} />
            <Field testID="garage-model" label="MODEL" value={model} onChange={setModel} />
            <Field testID="garage-year" label="YEAR" value={year} onChange={setYear} keyboard="number-pad" />
            <Field testID="garage-color" label="COLOR" value={color} onChange={setColor} />
            <TouchableOpacity testID="garage-save" style={styles.btn} onPress={save} disabled={busy}>
              <Text style={styles.btnText}>{busy ? "SAVING…" : "SAVE"}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity testID="logout-btn" style={styles.logoutBtn} onPress={logout}>
            <Ionicons name="log-out" size={18} color={COLORS.danger} />
            <Text style={styles.logoutText}>SIGN OUT</Text>
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
        placeholderTextColor={COLORS.textDim}
      />
    </>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg },
  title: { color: COLORS.text, fontSize: 28, fontWeight: "900", letterSpacing: 4 },
  sub: { color: COLORS.textDim, marginTop: 2, fontSize: 12 },
  heroCard: { alignItems: "center", padding: 22, borderRadius: 20, backgroundColor: COLORS.surface, marginTop: 16, borderWidth: 1, borderColor: COLORS.border },
  avatar: { width: 96, height: 96, borderRadius: 48, backgroundColor: COLORS.bg, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: COLORS.primary + "55" },
  heroName: { color: COLORS.text, fontSize: 22, fontWeight: "900", letterSpacing: 2, marginTop: 12 },
  heroCar: { color: COLORS.textDim, marginTop: 4 },
  sectionTitle: { color: COLORS.textDim, marginTop: 22, marginBottom: 8, letterSpacing: 3, fontSize: 11 },
  card: { backgroundColor: COLORS.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: COLORS.border },
  label: { color: COLORS.textDim, fontSize: 11, letterSpacing: 2, marginTop: 12, marginBottom: 6 },
  input: { backgroundColor: COLORS.bg, borderWidth: 1, borderColor: COLORS.border, color: COLORS.text, padding: 12, borderRadius: 10, fontSize: 15 },
  btn: { backgroundColor: COLORS.primary, padding: 14, borderRadius: 12, marginTop: 18, alignItems: "center" },
  btnText: { color: "#000", fontWeight: "900", letterSpacing: 2 },
  logoutBtn: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 24, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: COLORS.danger + "55" },
  logoutText: { color: COLORS.danger, fontWeight: "900", letterSpacing: 2 },
});
