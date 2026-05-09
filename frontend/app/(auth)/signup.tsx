import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Alert, Image,
} from "react-native";
import { useRouter, Link } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { formatErr } from "../../src/api";
import Glass from "../../src/Glass";
import CarPresetPicker from "../../src/CarPresetPicker";

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
    if (!email || !password || !handle) return Alert.alert("Email, password and handle are required");
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
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 60 }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: "center", marginBottom: 8 }}>
          <Image source={require("../../assets/images/brand-mark.png")} style={{ width: 76, height: 76, marginBottom: 8 }} resizeMode="contain" />
        </View>
        <Text style={styles.title}>Join Convoy</Text>
        <Text style={styles.tag}>Set up your driver profile</Text>

        <Glass radius={28} style={{ marginTop: 22 }}>
          <View style={{ padding: 20 }}>
            <Field label="Handle" testID="signup-handle" value={handle} onChange={setHandle} placeholder="ApexHunter" />
            <Field label="Email" testID="signup-email" value={email} onChange={setEmail} placeholder="you@convoy.app" auto />
            <Field label="Password" testID="signup-password" value={password} onChange={setPassword} placeholder="••••••" secure />

            <Text style={styles.section}>Your car</Text>
            <Field label="Make" testID="signup-make" value={make} onChange={setMake} placeholder="Nissan" />
            <Field label="Model" testID="signup-model" value={model} onChange={setModel} placeholder="Skyline GT-R" />
            <View style={{ marginTop: 6 }}>
              <CarPresetPicker
                selectedMake={make}
                selectedModel={model}
                onSelect={(p) => { setMake(p.make); setModel(p.model); }}
              />
            </View>
            <Field label="Year" testID="signup-year" value={year} onChange={setYear} placeholder="1999" keyboard="number-pad" />
            <Field label="Color" testID="signup-color" value={color} onChange={setColor} placeholder="Bayside Blue" />

            <TouchableOpacity testID="signup-submit" onPress={submit} disabled={busy} style={styles.btn} activeOpacity={0.85}>
              <LinearGradient colors={[COLORS.primary, COLORS.primaryDim]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.btnGrad}>
                <Text style={styles.btnText}>{busy ? "Creating…" : "Create account"}</Text>
              </LinearGradient>
            </TouchableOpacity>

            <Link href="/(auth)/login" asChild>
              <TouchableOpacity testID="link-login" style={{ marginTop: 14, alignItems: "center" }}>
                <Text style={{ color: COLORS.textDim }}>Already a member? <Text style={{ color: COLORS.primary, fontWeight: "600" }}>Sign in</Text></Text>
              </TouchableOpacity>
            </Link>
          </View>
        </Glass>
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
        placeholderTextColor={COLORS.textMute}
      />
    </>
  );
}

const styles = StyleSheet.create({
  title: { color: COLORS.text, fontSize: 32, fontWeight: "700", letterSpacing: -0.8 },
  tag: { color: COLORS.textDim, marginTop: 4, fontSize: 15 },
  label: { color: COLORS.textDim, fontSize: 13, marginTop: 12, marginBottom: 6, fontWeight: "500" },
  section: { color: COLORS.text, fontSize: 17, fontWeight: "600", marginTop: 22, letterSpacing: -0.3 },
  input: { backgroundColor: "rgba(118,118,128,0.18)", color: COLORS.text, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, fontSize: 16 },
  btn: { marginTop: 22, borderRadius: 14, overflow: "hidden" },
  btnGrad: { paddingVertical: 16, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 16 },
});
