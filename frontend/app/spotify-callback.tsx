import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { handleCallbackCode } from "../src/spotify";
import { updateSettings } from "../src/settings";
import { COLORS } from "../src/theme";

export default function SpotifyCallback() {
  const router = useRouter();
  // Native: the deep link (convoy://spotify-callback?code=…) lands here with
  // params. Web: read the query string. Handle BOTH so login works on Android.
  const params = useLocalSearchParams();
  const [status, setStatus] = useState<"loading" | "ok" | "fail">("loading");
  const [msg, setMsg] = useState<string>("Connecting to Spotify…");

  useEffect(() => {
    (async () => {
      let code = (typeof params.code === "string" ? params.code : null);
      let error = (typeof params.error === "string" ? params.error : null);
      if (!code && !error && typeof window !== "undefined") {
        const sp = new URLSearchParams(window.location.search);
        code = sp.get("code"); error = sp.get("error");
      }
      if (error || !code) {
        setStatus("fail");
        setMsg(error ? `Spotify denied access: ${error}` : "Missing authorization code");
        setTimeout(() => router.replace("/(app)/music"), 2200);
        return;
      }
      try {
        const ok = await handleCallbackCode(code);
        if (ok) await updateSettings({ musicSource: "spotify" }); // switch the Music tab to Spotify
        setStatus(ok ? "ok" : "fail");
        setMsg(ok ? "Signed in! Redirecting…" : "Token exchange failed");
      } catch (e: any) {
        setStatus("fail");
        setMsg(e?.message || "Sign-in failed");
      }
      setTimeout(() => router.replace("/(app)/music"), 1200);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
