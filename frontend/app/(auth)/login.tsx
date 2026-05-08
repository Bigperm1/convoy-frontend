import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Alert,
} from "react-native";
import { useRouter, Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { formatErr } from "../../src/api";
import { LinearGradient } from "expo-linear-gradient";

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
      Alert.alert("Login failed", formatErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <LinearGradient colors={["#0A0A0A", "#0D1A0A", "#0A0A0A"]} style={StyleSheet.absoluteFill} />
        <View style={styles.brand}>
          <View style={styles.logoBox} testID="logo">
            <Ionicons name="speedometer" size={48} color={COLORS.primary} />
          </View>
          <Text style={styles.title}>REV RADAR</Text>
          <Text style={styles.tag}>Drive together. See everything.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>EMAIL</Text>
          <TextInput
            testID="login-email"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="you@revradar.app"
            placeholderTextColor={COLORS.textDim}
          />
          <Text style={styles.label}>PASSWORD</Text>
          <TextInput
            testID="login-password"
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
            placeholderTextColor={COLORS.textDim}
          />
          <TouchableOpacity testID="login-submit" style={styles.btn} onPress={onSubmit} disabled={busy}>
            <Text style={styles.btnText}>{busy ? "SIGNING IN…" : "ENTER GARAGE"}</Text>
          </TouchableOpacity>

          <Link href="/(auth)/signup" asChild>
            <TouchableOpacity testID="link-signup" style={styles.linkBtn}>
              <Text style={styles.linkText}>New here? <Text style={{ color: COLORS.primary }}>Create account</Text></Text>
            </TouchableOpacity>
          </Link>
        </View>

        <Text style={styles.footer}>Demo: demo@revradar.app / demo1234</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, padding: 24, justifyContent: "center", backgroundColor: COLORS.bg },
  brand: { alignItems: "center", marginBottom: 36 },
  logoBox: {
    width: 96, height: 96, borderRadius: 24, backgroundColor: COLORS.surface,
    alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#2a4a1a", marginBottom: 16,
  },
  title: { color: COLORS.text, fontSize: 36, fontWeight: "900", letterSpacing: 4 },
  tag: { color: COLORS.textDim, marginTop: 6, letterSpacing: 2, fontSize: 12 },
  card: { backgroundColor: COLORS.surface, borderRadius: 20, padding: 20, borderWidth: 1, borderColor: COLORS.border },
  label: { color: COLORS.textDim, fontSize: 11, letterSpacing: 2, marginBottom: 8, marginTop: 12 },
  input: {
    backgroundColor: COLORS.bg, borderWidth: 1, borderColor: COLORS.border,
    color: COLORS.text, padding: 14, borderRadius: 12, fontSize: 16,
  },
  btn: {
    backgroundColor: COLORS.primary, paddingVertical: 16, borderRadius: 12,
    marginTop: 22, alignItems: "center",
  },
  btnText: { color: "#000", fontWeight: "900", letterSpacing: 2, fontSize: 15 },
  linkBtn: { marginTop: 14, alignItems: "center" },
  linkText: { color: COLORS.textDim },
  footer: { color: COLORS.textDim, textAlign: "center", marginTop: 18, fontSize: 12 },
});
