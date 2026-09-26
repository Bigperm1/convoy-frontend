import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ActivityIndicator, StyleSheet, Pressable, Alert } from "react-native";
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
// ...and a way out (2026-09-25, Codex on the unpublished auth commit): "Connecting…" alone has no exit —
// a server that never answers (or a token store that never becomes readable) holds the driver here for
// good. After ESCAPE_AFTER_MS on this screen, two controls appear under it: "Try again" (a refresh now)
// and "Sign out" (an explicit logout, confirmed like Settings → Sign out). Nothing else changes: only a
// 401/403 from the server signs anyone out on its own. 60 s = the axios budget of one /auth/me that
// timed out, or four fast failures (boot + three 15 s retries).
// Round 2 (2026-09-25): the clock starts at MOUNT and runs while `user` is still undefined — not only once
// `connecting` is true — so a stage that never finishes (a token read that never answers never sets
// `connecting`) still ends on "Connecting…" + the two controls, not a bare spinner forever
// (scratchpad auth_verify_escape V4). "Try again" now waits on a request already in flight (auth `tap`).
const ESCAPE_AFTER_MS = 60_000;

function userTag(u: { id: string } | null | undefined): string {
  return u === undefined ? "undef" : u === null ? "null" : String(u.id);
}

export default function Index() {
  const router = useRouter();
  const { user, connecting, refresh, logout } = useAuth();
  // onboarded === undefined → still reading from storage. We treat it as a
  // third "loading" state so the spinner stays up until we know.
  const [onboarded, setOnboarded] = useState<boolean | undefined>(undefined);
  const mountedAtRef = useRef(Date.now());
  const connectingLoggedRef = useRef(false);
  const [escape, setEscape] = useState(false);   // "Try again" / "Sign out" are showing (sticky once shown)
  const [trying, setTrying] = useState(false);   // a "Try again" refresh is in flight
  const connectingRef = useRef(connecting);      // for the escape crumb: did it fire with `connecting` set?
  useEffect(() => { connectingRef.current = connecting; }, [connecting]);

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

  // "Connecting…" — keep asking while we sit here with a token but nothing to show. Past the escape it shows
  // whenever `user` is still undefined, whatever stage is stuck.
  const waiting = user === undefined;
  const showConnecting = waiting && (connecting || escape);
  useEffect(() => {
    if (!showConnecting) return;
    if (!connectingLoggedRef.current) {
      connectingLoggedRef.current = true;
      try { logEventReliable(`auth-gate to=connecting user=undef ms=${Date.now() - mountedAtRef.current}`); } catch {}
    }
    const id = setInterval(() => { void refresh("retry"); }, AUTH_RETRY_MS);
    return () => clearInterval(id);
  }, [showConnecting, refresh]);
  useEffect(() => {
    if (!waiting) return;
    const esc = setTimeout(() => {
      try { logEventReliable(`auth-gate escape=shown connecting=${connectingRef.current ? 1 : 0} ms=${Date.now() - mountedAtRef.current}`); } catch {}
      setEscape(true);
    }, ESCAPE_AFTER_MS);
    return () => clearTimeout(esc);
  }, [waiting]);

  const tryAgain = useCallback(async () => {
    if (trying) return;
    try { logEventReliable(`auth-gate tap=try-again ms=${Date.now() - mountedAtRef.current}`); } catch {}
    setTrying(true);
    try { await refresh("tap"); } finally { setTrying(false); }
  }, [trying, refresh]);

  const signOut = useCallback(() => {
    Alert.alert("Sign out", "Sign out of Hairpin on this device? You'll need a connection to sign back in.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => {
        try { logEventReliable(`auth-gate tap=sign-out ms=${Date.now() - mountedAtRef.current}`); } catch {}
        void logout();   // on failure it alerts ("Couldn't sign out") and this screen stays as it is
      } },
    ]);
  }, [logout]);

  return (
    <View style={styles.c}>
      <View style={styles.col}>
        <ActivityIndicator color={COLORS.primary} size="large" />
        {showConnecting ? <Text style={styles.connecting}>Connecting…</Text> : null}
        {/* Hung below the text, out of the flow, so the spinner and "Connecting…" do not jump when it appears. */}
        {showConnecting && escape ? (
          <View style={styles.row}>
            <Pressable
              onPress={tryAgain}
              disabled={trying}
              accessibilityRole="button"
              accessibilityLabel="Try again"
              style={({ pressed }) => [styles.btn, (pressed || trying) && styles.btnDown]}
            >
              <Text style={styles.btnText}>{trying ? "Trying…" : "Try again"}</Text>
            </Pressable>
            <Pressable
              onPress={signOut}
              accessibilityRole="button"
              accessibilityLabel="Sign out"
              style={({ pressed }) => [styles.btn, pressed && styles.btnDown]}
            >
              <Text style={styles.btnText}>Sign out</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg },
  col: { alignItems: "center" },
  // Near-white, never a grey, on the dark background (Jeff's standing rule; was textDim #98989F).
  connecting: { marginTop: 16, color: COLORS.text, fontSize: 15 },
  row: { position: "absolute", top: "100%", alignSelf: "center", flexDirection: "row", gap: 12, marginTop: 24 },
  // The Hairpin square (DESIGN.md § Shape): radius ≈ 28 % of height — 10 on 36.
  btn: {
    height: 36, minWidth: 112, paddingHorizontal: 16, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: COLORS.surfaceSolid, borderWidth: 1, borderColor: COLORS.hairlineStrong,
  },
  btnDown: { opacity: 0.6 },
  btnText: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
});
