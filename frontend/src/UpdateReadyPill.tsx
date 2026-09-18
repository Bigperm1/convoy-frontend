// UpdateReadyPill — the always-available escape hatch for the stranded-OTA bug.
//
// Convoy's background audio + location keep the process alive (and iOS relaunches
// it in the background for location events), so expo-updates' default "apply on
// next launch" can strand a DOWNLOADED update for days — the 2026-07-09 and
// 2026-07-11 incidents: every OTA "vanished", and Settings → Check for Updates
// answered "You're up to date" because checkForUpdateAsync compares the server
// against what's DOWNLOADED on disk, not what's RUNNING.
//
// This pill watches expo-updates' live state (useUpdates). The moment a newer
// update finishes downloading (isUpdatePending), it appears under the search bar:
// "Update ready — tap to install". One tap = reloadAsync() = the new bundle runs
// NOW, no cold-start dance. Hidden while turn-by-turn nav is active so we never
// reload mid-drive; it reappears when the drive ends.
//
// ── IT ALSO CHECKS WHILE RUNNING (2026-09-18) ──────────────────────────────────
// app.json has updates.checkAutomatically = "ON_LOAD", and nothing else ever asked the
// server — so a process that never dies never DOWNLOADS a new update, and the pill
// (which only watches for a finished download) can never appear. Olaf's phone,
// 2026-09-18: one process alive from 17:13 the evening before, parked with the app
// open all night, then a CarPlay drive — still on OTA-AY 12 h after OTA-AZ shipped.
// So while the pill is mounted and NOT hidden (no turn-by-turn, no head unit) we ask:
// when the app comes to the foreground and every UPDATE_CHECK_EVERY_MS while it stays
// up. expo-updates' own doc says not to check "in a frequent loop" — hence the
// throttle. A found update is downloaded; isUpdatePending then shows the pill as before.
import React, { useEffect, useRef } from "react";
import { AppState, Platform, Text, TouchableOpacity, StyleSheet } from "react-native";
import * as Updates from "expo-updates";
import { logEvent } from "./crashBreadcrumb";

const UPDATE_CHECK_EVERY_MS = 30 * 60_000;

let lastCheckAt = 0;
let checking = false;

async function checkAndFetch(why: string): Promise<void> {
  if (Platform.OS === "web" || __DEV__ || !Updates.isEnabled) return;
  const now = Date.now();
  if (checking || now - lastCheckAt < UPDATE_CHECK_EVERY_MS) return;
  lastCheckAt = now;
  checking = true;
  try {
    const res = await Updates.checkForUpdateAsync();
    if (!res.isAvailable) return;
    const got = await Updates.fetchUpdateAsync();
    logEvent(`ota-check why=${why} avail=1 fetched=${got.isNew ? 1 : 0}`);
  } catch (e: any) {
    logEvent(`ota-check why=${why} err=${String(e?.message ?? e).slice(0, 80)}`);
  } finally {
    checking = false;
  }
}

export default function UpdateReadyPill({ hidden }: { hidden?: boolean }) {
  // Hooks must run unconditionally; expo-updates is a no-op shell on web.
  const { isUpdatePending } = Updates.useUpdates();
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  useEffect(() => {
    if (Platform.OS === "web") return;
    const run = (why: string) => { if (!hiddenRef.current) void checkAndFetch(why); };
    run("mount");
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") run("foreground"); });
    const id = setInterval(() => run("timer"), UPDATE_CHECK_EVERY_MS);
    return () => { sub.remove(); clearInterval(id); };
  }, []);
  // A drive that just ended (hidden → shown) is a natural moment to look.
  useEffect(() => { if (!hidden) void checkAndFetch("unhidden"); }, [hidden]);
  if (Platform.OS === "web" || !isUpdatePending || hidden) return null;
  return (
    <TouchableOpacity
      style={styles.pill}
      onPress={() => { Updates.reloadAsync().catch(() => {}); }}
      activeOpacity={0.8}
      testID="update-ready-pill"
    >
      <Text maxFontSizeMultiplier={1} style={styles.text}>Update ready — tap to install</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // Candy-red action banner with a rounded-square shape (matches the liveOverlay
  // chip's new corners). Bright + solid so the "update ready" CTA stands out.
  pill: {
    alignSelf: "center", marginTop: 6,
    paddingHorizontal: 12, paddingVertical: 5,
    borderRadius: 10,
    backgroundColor: "rgba(228,0,43,0.95)", // candy red
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.40)",
    zIndex: 5,
  },
  text: { color: "#FFFFFF", fontSize: 11, fontWeight: "700", letterSpacing: 0.2 },
});
