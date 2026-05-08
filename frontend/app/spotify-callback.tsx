import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { handleCallbackCode } from "../src/spotify";
import { COLORS } from "../src/theme";

export default function SpotifyCallback() {
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "ok" | "fail">("loading");
  const [msg, setMsg] = useState<string>("Connecting to Spotify…");

  useEffect(() => {
    (async () => {
      if (typeof window === "undefined") return;
      const params = new URLSearchParams(window.location.search);
      const error = params.get("error");
      const code = params.get("code");
      if (error) {
        setStatus("fail");
        setMsg(`Spotify denied access: ${error}`);
        setTimeout(() => router.replace("/(app)/music"), 2500);
        return;
      }
      if (!code) {
        setStatus("fail"); setMsg("Missing authorization code");
        setTimeout(() => router.replace("/(app)/music"), 2500);
        return;
      }
      try {
        const ok = await handleCallbackCode(code);
        setStatus(ok ? "ok" : "fail");
        setMsg(ok ? "Signed in! Redirecting…" : "Token exchange failed");
      } catch (e: any) {
        setStatus("fail");
        setMsg(e?.message || "Sign-in failed");
      }
      setTimeout(() => router.replace("/(app)/music"), 1200);
    })();
  }, [router]);

  return (
    <View style={styles.c}>
      {status === "loading" ? <ActivityIndicator color={COLORS.primary} /> : null}
      <Text style={styles.text}>{msg}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg, alignItems: "center", justifyContent: "center", padding: 24 },
  text: { color: COLORS.text, marginTop: 14, textAlign: "center" },
});
