import React, { useEffect, useRef, useState } from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "../src/auth";
import { COLORS } from "../src/theme";
import { ONBOARDING_KEY } from "./onboarding";
import { logEventReliable } from "../src/crashBreadcrumb";

// Index gate — three terminal destinations:
//   1. /(app)/map        if a user session is already active
//   2. /onboarding       if first-launch (ONBOARDING_KEY unset) AND signed out
//   3. /(auth)/login     if returning anonymous user
//
// We hold off the redirect until both `user` and the AsyncStorage read have
// resolved so we never flash the wrong screen.
//
// And one HOLDING state (2026-09-24, Rodrigo's underground launch on build 79): a token is stored, there
// is no cached profile to show, and the server has not answered — `connecting` from useAuth. The gate
// stays here and says "Connecting…" instead of sending a signed-in driver to the login screen, and asks
// auth to try again every AUTH_RETRY_MS (auth also retries on foreground). Only a 401/403 from the server
// turns this into `user === null` → login. Every exit writes `auth-gate to=… user=… ms=…` so the next
// "black screen, then sign-in" report can be read from crash_reports (src/auth.tsx has the matching
// `auth-refresh` rows).
const AUTH_RETRY_MS = 15_000; // Jeff's spec, 2026-09-24: "a retry every 15 s while there"

function userTag(u: { id: string } | null | undefined): string {
  return u === undefined ? "undef" : u === null ? "null" : String(u.id);
}

export default function Index() {
  const router = useRouter();
  const { user, connecting, refresh } = useAuth();
  // onboarded === undefined → still reading from storage. We treat it as a
  // third "loading" state so the spinner stays up until we know.
  const [onboarded, setOnboarded] = useState<boolean | undefined>(undefined);
  const mountedAtRef = useRef(Date.now());
  const connectingLoggedRef = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(ONBOARDING_KEY)
      .then((v) => setOnboarded(v === "1"))
      // If storage itself fails, default to "already onboarded" so the user
      // never gets stuck on the tour. Better to silently miss the slides
      // than to deadlock on a storage permission error.
      .catch(() => setOnboarded(true));
  }, []);

  useEffect(() => {
    if (user === undefined || onboarded === undefined) return;
    const to = user ? "map" : !onboarded ? "onboarding" : "login";
    try { logEventReliable(`auth-gate to=${to} user=${userTag(user)} ms=${Date.now() - mountedAtRef.current}`); } catch {}
    if (to === "map") router.replace("/(app)/map");
    else if (to === "onboarding") router.replace("/onboarding");
    else router.replace("/(auth)/login");
  }, [user, onboarded, router]);

  // "Connecting…" — keep asking while we sit here with a token but nothing to show.
  const showConnecting = user === undefined && connecting;
  useEffect(() => {
    if (!showConnecting) return;
    if (!connectingLoggedRef.current) {
      connectingLoggedRef.current = true;
      try { logEventReliable(`auth-gate to=connecting user=undef ms=${Date.now() - mountedAtRef.current}`); } catch {}
    }
    const id = setInterval(() => { void refresh("retry"); }, AUTH_RETRY_MS);
    return () => clearInterval(id);
  }, [showConnecting, refresh]);

  return (
    <View style={styles.c}>
      <ActivityIndicator color={COLORS.primary} size="large" />
      {showConnecting ? <Text style={styles.connecting}>Connecting…</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg },
  connecting: { marginTop: 16, color: COLORS.textDim, fontSize: 15 },
});
