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

export default function Signup() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const { register } = useAuth();
  const router = useRouter();

  const submit = async () => {
    if (!email || !password || !handle) return Alert.alert("Email, password and handle are required");
    try {
      setBusy(true);
      // Car details are filled in later via the Garage screen — keeping signup
      // lean so new drivers can get on the map in seconds.
      await register({
        email: email.trim().toLowerCase(),
        password,
        handle,
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
        {/* Centered header — logo, title, and tagline share a single column,
            evenly spaced vertically and centered horizontally. */}
        <View style={styles.header}>
          <Image
            source={require("../../assets/images/brand-mark.png")}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.title}>Join Convoy</Text>
          <Text style={styles.tag}>Set up your driver profile</Text>
        </View>

        <Glass radius={28} style={{ marginTop: 22 }}>
          <View style={{ padding: 20 }}>
            <Field label="Handle" testID="signup-handle" value={handle} onChange={setHandle} placeholder="ApexHunter" />
            <Field label="Email" testID="signup-email" value={email} onChange={setEmail} placeholder="you@convoy.app" auto />
            <Field label="Password" testID="signup-password" value={password} onChange={setPassword} placeholder="••••••" secure />

            <Text style={styles.hint}>You'll pick your car and paint in the Garage after signing in.</Text>

            <TouchableOpacity testID="signup-submit" onPress={submit} disabled={busy} style={styles.btn} activeOpacity={0.85}>
              {/* Convoy yellow CTA — dark text for contrast. */}
              <LinearGradient colors={["#FFE45C", "#FFC700", "#FF9F0A"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.btnGrad}>
                <Text style={styles.btnText}>{busy ? "Creating…" : "Create account"}</Text>
              </LinearGradient>
            </TouchableOpacity>

            <Link href="/(auth)/login" asChild>
              <TouchableOpacity testID="link-login" style={{ marginTop: 14, alignItems: "center" }}>
                <Text style={{ color: COLORS.textDim }}>Already a member? <Text style={styles.signInLink}>Sign in</Text></Text>
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
  // Header block — logo + title + tag, all centered as one column
  header: { alignItems: "center", justifyContent: "center", marginBottom: 4 },
  logo: { width: 96, height: 96, marginBottom: 12 },
  title: { color: COLORS.text, fontSize: 32, fontWeight: "700", letterSpacing: -0.8, textAlign: "center" },
  tag: { color: COLORS.textDim, marginTop: 4, fontSize: 15, textAlign: "center" },
  label: { color: COLORS.textDim, fontSize: 13, marginTop: 12, marginBottom: 6, fontWeight: "500" },
  // Friendly hint that car selection lives in Garage, not signup.
  hint: { color: COLORS.textDim, fontSize: 12, marginTop: 18, lineHeight: 16, fontStyle: "italic" },
  input: { backgroundColor: "rgba(118,118,128,0.18)", color: COLORS.text, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, fontSize: 16 },
  btn: { marginTop: 22, borderRadius: 14, overflow: "hidden" },
  btnGrad: { paddingVertical: 16, alignItems: "center" },
  // Dark, high-contrast text for the yellow CTA — matches the brand-mark glyph color.
  btnText: { color: "#1a1a1a", fontWeight: "700", fontSize: 16, letterSpacing: 0.2 },
  signInLink: { color: "#FFC700", fontWeight: "600" },
});
