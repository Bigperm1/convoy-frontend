// locationDisclosure.tsx — the PROMINENT DISCLOSURE that must appear BEFORE the OS
// location prompt.
//
// WHY THIS EXISTS (2026-07-25). Google Play requires an app that requests
// ACCESS_BACKGROUND_LOCATION to show its own in-app screen, before the runtime
// permission dialog, explaining the feature and that location is used in the
// background. Hairpin had none: it went straight to the OS prompt. iOS gets away
// with this because it renders the Info.plist usage string INSIDE the system
// dialog — Android's dialog shows no reason at all, so the app has to say it.
//
// Without this, the Play "Location permissions" declaration (and the demo video it
// requires) fails review, and the app is out of policy for shipping background
// location.
//
// Shape: a promise-based gate. `requestLocationDisclosure()` resolves true once the
// user taps Continue, false if they dismiss. The host is mounted once in
// app/(app)/_layout.tsx so it is available everywhere in the authenticated app.
//
// FAIL-OPEN by design: if no host is mounted (or anything throws) it resolves true
// rather than silently swallowing the permission request — a missing disclosure must
// never leave the driver with a dead map. The host is always mounted in practice.
import React, { useEffect, useState } from "react";
import { Modal, View, Text, Pressable, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "./theme";

type Resolver = (ok: boolean) => void;
let openFn: (() => void) | null = null;

// All callers of one disclosure share a SINGLE modal and a SINGLE promise.
// Two things went wrong before this (seen in the sim 2026-07-25, screenshot: the OS
// location dialog sitting ON TOP of the disclosure):
//   1. map.tsx has more than one path that asks for location. Without single-flight,
//      a second call replaced the first's resolver and orphaned it.
//   2. The first call can land BEFORE this host has mounted. Failing open there let
//      the OS prompt fire immediately while the modal appeared behind it — the exact
//      opposite of "disclosure first".
// So: requests made before the host mounts are HELD, and shown the moment it does.
let waiters: Resolver[] = [];
let armed = false;              // a disclosure is requested (shown or waiting for host)
let mountTimer: any = null;

// Fail-open backstop: if no host ever mounts, release the callers rather than
// leaving the driver with a dead map. Generous, because this only runs on the very
// first launch while the tree is still coming up.
const HOST_WAIT_MS = 8000;

function settle(ok: boolean) {
  const list = waiters;
  waiters = [];
  armed = false;
  if (mountTimer) { clearTimeout(mountTimer); mountTimer = null; }
  for (const r of list) { try { r(ok); } catch {} }
}

/**
 * Show the disclosure and resolve when the user answers. Concurrent callers share
 * one modal. Safe to call before the host mounts — the request waits for it.
 */
export function requestLocationDisclosure(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    waiters.push(resolve);
    if (armed) return;            // already showing / waiting — join it
    armed = true;
    if (openFn) { openFn(); return; }
    // Host not up yet: hold the request until it mounts, with a backstop.
    mountTimer = setTimeout(() => settle(true), HOST_WAIT_MS);
  });
}

/** Mount ONCE, high in the tree. Renders nothing until a disclosure is requested. */
export function LocationDisclosureHost() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    openFn = () => setVisible(true);
    // If a request arrived BEFORE this mounted, show it now.
    if (armed) setVisible(true);
    return () => { openFn = null; };
  }, []);

  const answer = (ok: boolean) => {
    setVisible(false);
    settle(ok);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => answer(false)}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name="location" size={26} color="#2DEC86" />
          </View>

          <Text style={styles.title}>Hairpin uses your location</Text>

          {/* The two things Google's reviewer looks for: WHAT the feature is, and an
              explicit statement that location is used in the BACKGROUND — in plain
              language, before the OS dialog appears. */}
          <Text style={styles.body}>
            Your location puts your car on your crew's live map and powers turn-by-turn
            navigation and the map on your car's display.
          </Text>
          <Text style={styles.body}>
            Hairpin keeps using your location{" "}
            <Text style={styles.bold}>in the background — even with your phone locked
            or in a mount</Text>{" "}
            so your crew can still see you and your navigation keeps working for the
            whole drive.
          </Text>
          <Text style={styles.bodyDim}>
            Your position is only ever shared with the crews you join, never publicly.
            You can change this any time in Settings, or turn location off in your
            device settings.
          </Text>

          <Pressable
            onPress={() => answer(true)}
            style={({ pressed }) => [styles.primary, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.primaryText}>Continue</Text>
          </Pressable>
          <Pressable
            onPress={() => answer(false)}
            style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.secondaryText}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.72)",
    alignItems: "center", justifyContent: "center", padding: 24,
  },
  card: {
    width: "100%", maxWidth: 380, borderRadius: 22, padding: 22,
    backgroundColor: "#141418", borderWidth: 1, borderColor: "rgba(255,255,255,0.10)",
    // Opaque card, so elevation is safe here (see glassLift in Glass.tsx for why
    // translucent surfaces must NOT use it on Android).
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 10 } },
      android: { elevation: 24 },
    }),
  },
  iconWrap: {
    width: 48, height: 48, borderRadius: 24, alignSelf: "center", marginBottom: 14,
    alignItems: "center", justifyContent: "center", backgroundColor: "rgba(45,236,134,0.12)",
  },
  title: { color: "#F4F4F4", fontSize: 20, fontWeight: "800", textAlign: "center", marginBottom: 14 },
  body: { color: "#D6DBD8", fontSize: 14.5, lineHeight: 21, marginBottom: 12 },
  bodyDim: { color: COLORS.textDim, fontSize: 13, lineHeight: 19, marginBottom: 20 },
  bold: { color: "#F4F4F4", fontWeight: "700" },
  primary: {
    backgroundColor: "#2DEC86", borderRadius: 14, paddingVertical: 14, alignItems: "center",
  },
  primaryText: { color: "#04120A", fontSize: 15.5, fontWeight: "800" },
  secondary: { paddingVertical: 12, alignItems: "center" },
  secondaryText: { color: COLORS.textDim, fontSize: 14, fontWeight: "600" },
});
