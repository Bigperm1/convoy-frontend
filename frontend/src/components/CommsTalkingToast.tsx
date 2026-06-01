// CommsTalkingToast — global, app-wide "someone is transmitting" banner.
//
// The live PTT listener (useLiveWalkieListener, mounted once in app/_layout)
// already PLAYS incoming clips on every tab. This component adds the matching
// VISUAL cue so comms feel global: a small top banner ("🎙 jeff is talking…")
// shows no matter which screen you're on while the app is foregrounded.
//
// Scope rules (mirror the listener's own gating so the banner never lies):
//   - Foreground only. When backgrounded, the OS notification handles it
//     (see pttNotification.ts + the push path), so we'd double-notify.
//   - Never for our OWN transmission (the backend echoes our clip back).
//   - Only the active community channel, and only when Comms Live is on.
//
// Mounted in app/(app)/_layout.tsx so it floats above every tab's content.

import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Platform, AppState } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { livePttBus } from "../livePtt";
import { getSettings } from "../settings";
import { useAuth } from "../auth";

const VISIBLE_MS = 3000;

export default function CommsTalkingToast() {
  const { user } = useAuth();
  const [handle, setHandle] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const off = livePttBus.on((m) => {
      // Foreground only — the OS notification covers the backgrounded case.
      if (AppState.currentState !== "active") return;
      // Don't announce our own voice back to us.
      if (user?.id && m.user_id === user.id) return;
      const s = getSettings();
      // Respect the Comms Live mute toggle + only the active convoy channel.
      if (s.commsLive === false) return;
      if (!s.activeCommunityId || m.channel !== s.activeCommunityId) return;

      setHandle(m.handle || "Driver");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setHandle(null), VISIBLE_MS);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [user?.id]);

  if (!handle) return null;

  return (
    <View pointerEvents="none" style={styles.wrap}>
      <View style={styles.pill}>
        <Ionicons name="mic" size={14} color="#FF6A00" />
        <Text style={styles.text} numberOfLines={1}>{handle} is talking…</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: Platform.OS === "ios" ? 58 : 34,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 9999,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(28,28,30,0.92)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,106,0,0.55)",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 8,
  },
  text: { color: "#fff", fontSize: 13, fontWeight: "700", letterSpacing: 0.2 },
});
