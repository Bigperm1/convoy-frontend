import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Alert,
} from "react-native";
import { useRouter, Link } from "expo-router";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { formatErr } from "../../src/api";

export default function Signup() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [handle, setHandle] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [color, setColor] = useState("");
  const [busy, setBusy] = useState(false);
  const { register } = useAuth();
  const router = useRouter();

  const submit = async () => {
    if (!email || !password || !handle) return Alert.alert("Email, password and handle required");
    try {
      setBusy(true);
      await register({
        email: email.trim().toLowerCase(),
        password,
        handle,
        car_make: make,
        car_model: model,
        car_year: year ? parseInt(year, 10) : null,
        car_color: color,
      });
      router.replace("/(app)/map");
    } catch (e) {
      Alert.alert("Signup failed", formatErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: COLORS.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ padding: 24 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>JOIN THE CONVOY</Text>
        <Text style={styles.tag}>Set up your driver profile</Text>

        <View style={styles.card}>
          <Field label="HANDLE" testID="signup-handle" value={handle} onChange={setHandle} placeholder="ApexHunter" />
          <Field label="EMAIL" testID="signup-email" value={email} onChange={setEmail} placeholder="you@revradar.app" auto />
          <Field label="PASSWORD" testID="signup-password" value={password} onChange={setPassword} placeholder="••••••" secure />

          <Text style={styles.section}>YOUR CAR</Text>
          <Field label="MAKE" testID="signup-make" value={make} onChange={setMake} placeholder="Nissan" />
          <Field label="MODEL" testID="signup-model" value={model} onChange={setModel} placeholder="Skyline GT-R" />
          <Field label="YEAR" testID="signup-year" value={year} onChange={setYear} placeholder="1999" keyboard="number-pad" />
          <Field label="COLOR" testID="signup-color" value={color} onChange={setColor} placeholder="Bayside Blue" />

          <TouchableOpacity testID="signup-submit" style={styles.btn} onPress={submit} disabled={busy}>
            <Text style={styles.btnText}>{busy ? "CREATING…" : "CREATE ACCOUNT"}</Text>
          </TouchableOpacity>

          <Link href="/(auth)/login" asChild>
            <TouchableOpacity testID="link-login" style={{ marginTop: 14, alignItems: "center" }}>
              <Text style={{ color: COLORS.textDim }}>Have an account? <Text style={{ color: COLORS.primary }}>Sign in</Text></Text>
            </TouchableOpacity>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, value, onChange, placeholder, secure, auto, keyboard, testID }: any) {
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        testID={testID}
        style={styles.input}
        value={value}
        onChangeText={onChange}
        secureTextEntry={!!secure}
        autoCapitalize={auto ? "none" : "words"}
        keyboardType={keyboard || "default"}
        placeholder={placeholder}
        placeholderTextColor={COLORS.textDim}
      />
    </>
  );
}

const styles = StyleSheet.create({
  title: { color: COLORS.text, fontSize: 28, fontWeight: "900", letterSpacing: 3, marginTop: 24 },
  tag: { color: COLORS.textDim, marginTop: 4, letterSpacing: 1, marginBottom: 18 },
  card: { backgroundColor: COLORS.surface, borderRadius: 20, padding: 18, borderWidth: 1, borderColor: COLORS.border },
  label: { color: COLORS.textDim, fontSize: 11, letterSpacing: 2, marginTop: 12, marginBottom: 6 },
  section: { color: COLORS.primary, fontSize: 12, letterSpacing: 3, marginTop: 22 },
  input: {
    backgroundColor: COLORS.bg, borderWidth: 1, borderColor: COLORS.border,
    color: COLORS.text, padding: 13, borderRadius: 12, fontSize: 15,
  },
  btn: { backgroundColor: COLORS.primary, padding: 15, borderRadius: 12, marginTop: 22, alignItems: "center" },
  btnText: { color: "#000", fontWeight: "900", letterSpacing: 2 },
});
