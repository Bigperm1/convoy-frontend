import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Linking, AppState } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { COLORS } from "../../../src/theme";
import { SettingsPage, SectionLabel, SettingsCard, HelpText } from "../../../src/components/settingsKit";
import { useAccent } from "../../../src/appSkin";

// Map the iOS foreground+background permission pair to a single readable state.
function statusFor(fg: string, bg: string): { text: string; color: string; icon: any } {
  if (fg !== "granted") return { text: "Off", color: "#FF453A", icon: "close-circle" };
  if (bg === "granted") return { text: "Always", color: "#2DEC86", icon: "checkmark-circle" };
  return { text: "While Using", color: "#FF9F0A", icon: "checkmark-circle" };
}

export default function LocationServicesPage() {
  const [fg, setFg] = useState("undetermined");
  const [bg, setBg] = useState("undetermined");
  const accent = useAccent();

  const refresh = useCallback(async () => {
    try {
      const f = await Location.getForegroundPermissionsAsync();
      setFg(f.status);
    } catch {}
    try {
      const b = await Location.getBackgroundPermissionsAsync();
      setBg(b.status);
    } catch {}
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  // Re-read the moment we return from the iOS Settings app so the status is fresh.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void refresh(); });
    return () => sub.remove();
  }, [refresh]);

  const status = statusFor(fg, bg);
  const openSettings = () => { Linking.openSettings().catch(() => {}); };
  const requestPerm = async () => {
    try { await Location.requestForegroundPermissionsAsync(); } catch {}
    void refresh();
  };

  return (
    <SettingsPage title="Location Services">
      <SectionLabel>PERMISSION</SectionLabel>
      <SettingsCard>
        <View style={styles.statusRow}>
          <View style={[styles.iconWrap, { backgroundColor: status.color + "22" }]}>
            <Ionicons name={status.icon} size={20} color={status.color} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.statusTitle}>Location Access</Text>
            <Text style={styles.statusSub}>How Hairpin can use your location</Text>
          </View>
          <Text style={[styles.statusValue, { color: status.color }]}>{status.text}</Text>
        </View>
      </SettingsCard>

      {fg === "undetermined" ? (
        <TouchableOpacity onPress={requestPerm} activeOpacity={0.85} style={[styles.cta, { backgroundColor: accent }]}>
          <Text style={[styles.ctaText, { color: "#06281A" }]}>Allow Location</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity onPress={openSettings} activeOpacity={0.85} style={[styles.cta, styles.ctaGlass]}>
          <Ionicons name="settings-outline" size={18} color="#0A84FF" />
          <Text style={[styles.ctaText, { color: "#0A84FF" }]}>Open in iOS Settings</Text>
        </TouchableOpacity>
      )}

      <HelpText>
        Hairpin needs location to show your car on the convoy map, navigate turn-by-turn, and keep the CarPlay map live while you drive. iOS controls the actual permission — use “Open in iOS Settings” to switch between While Using and Always, or to turn on Precise Location.
      </HelpText>
      <HelpText>
        Set “Always” so the CarPlay map keeps tracking when your phone is locked in your pocket. Choose who can see you on the map under Visibility &amp; Comms → Avatar Live.
      </HelpText>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 },
  iconWrap: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  statusTitle: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  statusSub: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  statusValue: { fontSize: 15, fontWeight: "700" },
  cta: {
    marginTop: 16, height: 52, borderRadius: 14, overflow: "hidden",
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
  },
  ctaGlass: { backgroundColor: "rgba(10,132,255,0.14)", borderWidth: 1, borderColor: "rgba(10,132,255,0.5)" },
  ctaText: { fontSize: 16, fontWeight: "700" },
});
