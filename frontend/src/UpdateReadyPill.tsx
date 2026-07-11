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
import React from "react";
import { Platform, Text, TouchableOpacity, StyleSheet } from "react-native";
import * as Updates from "expo-updates";

export default function UpdateReadyPill({ hidden }: { hidden?: boolean }) {
  // Hooks must run unconditionally; expo-updates is a no-op shell on web.
  const { isUpdatePending } = Updates.useUpdates();
  if (Platform.OS === "web" || !isUpdatePending || hidden) return null;
  return (
    <TouchableOpacity
      style={styles.pill}
      onPress={() => { Updates.reloadAsync().catch(() => {}); }}
      activeOpacity={0.8}
      testID="update-ready-pill"
    >
      <Text style={styles.text}>Update ready — tap to install</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // Mirrors the liveOverlay chip (map.tsx) so it reads as part of the same stack.
  pill: {
    alignSelf: "center", marginTop: 6,
    paddingHorizontal: 12, paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "rgba(45,236,134,0.22)", // brand green glass
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(45,236,134,0.55)",
    zIndex: 5,
  },
  text: { color: "#2DEC86", fontSize: 11, fontWeight: "700", letterSpacing: 0.2 },
});
