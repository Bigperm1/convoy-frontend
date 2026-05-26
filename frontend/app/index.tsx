import React, { useEffect, useState } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "../src/auth";
import { COLORS } from "../src/theme";
import { ONBOARDING_KEY } from "./onboarding";

// Index gate — three terminal destinations:
//   1. /(app)/map        if a user session is already active
//   2. /onboarding       if first-launch (ONBOARDING_KEY unset) AND signed out
//   3. /(auth)/login     if returning anonymous user
//
// We hold off the redirect until both `user` and the AsyncStorage read have
// resolved so we never flash the wrong screen.
export default function Index() {
  const router = useRouter();
  const { user } = useAuth();
  // onboarded === undefined → still reading from storage. We treat it as a
  // third "loading" state so the spinner stays up until we know.
  const [onboarded, setOnboarded] = useState<boolean | undefined>(undefined);

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
    if (user) {
      router.replace("/(app)/map");
    } else if (!onboarded) {
      router.replace("/onboarding");
    } else {
      router.replace("/(auth)/login");
    }
  }, [user, onboarded, router]);

  return (
    <View style={styles.c}>
      <ActivityIndicator color={COLORS.primary} size="large" />
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg },
});
