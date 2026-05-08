import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Alert, Image,
} from "react-native";
import { useRouter, Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { formatErr } from "../../src/api";
import Glass from "../../src/Glass";

export default function Login() {
  const [email, setEmail] = useState("demo@revradar.app");
  const [password, setPassword] = useState("demo1234");
  const [busy, setBusy] = useState(false);
  const { login } = useAuth();
  const router = useRouter();

  const onSubmit = async () => {
    if (!email || !password) return Alert.alert("Enter email and password");
    try {
      setBusy(true);
      await login(email.trim(), password);
      router.replace("/(app)/map");
    } catch (e) {
      Alert.alert("Sign in failed", formatErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: COLORS.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Ambient gradient blobs */}
        <View style={styles.blobBlue} />
        <View style={styles.blobIndigo} />
        <LinearGradient colors={["rgba(0,0,0,0)", "rgba(0,0,0,0.6)", "#000"]} style={StyleSheet.absoluteFill} pointerEvents="none" />

        <View style={styles.brand}>
          <View style={styles.logoBox} testID="logo">
            <Ionicons name="navigate" size={42} color={COLORS.text} />
          </View>
          <Text style={styles.title}>Convoy</Text>
          <Text style={styles.tag}>Drive together. See everything.</Text>
        </View>

        <Glass radius={28} style={styles.card}>
          <View style={{ padding: 22 }}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              testID="login-email"
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="you@convoy.app"
              placeholderTextColor={COLORS.textMute}
            />
            <Text style={styles.label}>Password</Text>
            <TextInput
              testID="login-password"
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="••••••••"
              placeholderTextColor={COLORS.textMute}
            />
            <TouchableOpacity testID="login-submit" style={styles.btn} onPress={onSubmit} disabled={busy} activeOpacity={0.85}>
              <LinearGradient colors={[COLORS.primary, COLORS.primaryDim]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.btnGrad}>
                <Text style={styles.btnText}>{busy ? "Signing in…" : "Sign in"}</Text>
              </LinearGradient>
            </TouchableOpacity>

            <Link href="/(auth)/signup" asChild>
              <TouchableOpacity testID="link-signup" style={styles.linkBtn}>
                <Text style={styles.linkText}>New here? <Text style={{ color: COLORS.primary, fontWeight: "600" }}>Create account</Text></Text>
              </TouchableOpacity>
            </Link>
          </View>
        </Glass>

        <Text style={styles.footer}>Demo: demo@revradar.app · demo1234</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, padding: 24, justifyContent: "center", backgroundColor: COLORS.bg },
  blobBlue: { position: "absolute", top: -120, right: -80, width: 360, height: 360, borderRadius: 999, backgroundColor: COLORS.primary, opacity: 0.18, filter: "blur(80px)" as any },
  blobIndigo: { position: "absolute", bottom: -120, left: -100, width: 320, height: 320, borderRadius: 999, backgroundColor: COLORS.accent, opacity: 0.16 },
  brand: { alignItems: "center", marginBottom: 32 },
  logoBox: {
    width: 84, height: 84, borderRadius: 24, alignItems: "center", justifyContent: "center", marginBottom: 18,
    backgroundColor: COLORS.surfaceSolid, borderWidth: 1, borderColor: COLORS.hairlineStrong,
  },
  title: { color: COLORS.text, fontSize: 38, fontWeight: "700", letterSpacing: -1 },
  tag: { color: COLORS.textDim, marginTop: 4, fontSize: 15, letterSpacing: -0.2 },
  card: { },
  label: { color: COLORS.textDim, fontSize: 13, marginTop: 14, marginBottom: 8, fontWeight: "500" },
  input: {
    backgroundColor: "rgba(118,118,128,0.18)",
    color: COLORS.text, paddingVertical: 14, paddingHorizontal: 14, borderRadius: 14, fontSize: 16,
  },
  btn: { marginTop: 22, borderRadius: 14, overflow: "hidden" },
  btnGrad: { paddingVertical: 16, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 16, letterSpacing: -0.2 },
  linkBtn: { marginTop: 16, alignItems: "center" },
  linkText: { color: COLORS.textDim, fontSize: 14 },
  footer: { color: COLORS.textMute, textAlign: "center", marginTop: 22, fontSize: 12 },
});
