import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { COLORS } from "../../src/theme";
import { api } from "../../src/api";
import VoiceFAB from "../../src/VoiceFAB";

const { width } = Dimensions.get("window");

export default function DriveScreen() {
  const router = useRouter();
  const [time, setTime] = useState(new Date());
  const [hazardCount, setHazardCount] = useState(0);
  const [speed, setSpeed] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    (async () => {
      try {
        const { data } = await api.get("/hazards");
        setHazardCount(data.length);
      } catch {}
    })();
    return () => clearInterval(t);
  }, []);

  const onIntent = (intent: string | null) => {
    if (intent === "report_police") quickReport("police");
    else if (intent === "report_accident") quickReport("accident");
    else if (intent === "report_road") quickReport("road");
    else if (intent === "open_talk") router.push("/(app)/talk");
    else if (intent === "open_music") router.push("/(app)/music");
    else if (intent === "open_map") router.push("/(app)/map");
  };

  const quickReport = async (kind: string) => {
    try {
      const me = await api.get("/auth/me");
      const lat = me.data.lat || 37.7749;
      const lng = me.data.lng || -122.4194;
      await api.post("/hazards", { kind, lat, lng });
      setHazardCount((c) => c + 1);
    } catch {}
  };

  return (
    <SafeAreaView style={styles.c} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.modeLabel}>DRIVE MODE</Text>
        <Text style={styles.time}>{time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
      </View>

      <View style={styles.hudRow}>
        <View style={styles.hudCard}>
          <Text style={styles.hudVal}>{speed}</Text>
          <Text style={styles.hudLabel}>MPH</Text>
        </View>
        <View style={styles.hudCard}>
          <Text style={[styles.hudVal, { color: COLORS.warning }]}>{hazardCount}</Text>
          <Text style={styles.hudLabel}>ALERTS</Text>
        </View>
        <View style={styles.hudCard}>
          <Text style={[styles.hudVal, { color: COLORS.secondary }]}>ON</Text>
          <Text style={styles.hudLabel}>CARPLAY</Text>
        </View>
      </View>

      <View style={styles.grid}>
        <BigButton testID="drive-police" icon="shield" label="POLICE" color={COLORS.danger} onPress={() => quickReport("police")} />
        <BigButton testID="drive-hazard" icon="warning" label="HAZARD" color={COLORS.warning} onPress={() => quickReport("road")} />
        <BigButton testID="drive-accident" icon="alert-circle" label="ACCIDENT" color={COLORS.danger} onPress={() => quickReport("accident")} />
        <BigButton testID="drive-traffic" icon="car" label="TRAFFIC" color={COLORS.warning} onPress={() => quickReport("traffic")} />
      </View>

      <View style={styles.bottomRow}>
        <TouchableOpacity testID="drive-map" style={styles.bottomBtn} onPress={() => router.push("/(app)/map")}>
          <Ionicons name="map" size={28} color={COLORS.primary} />
          <Text style={styles.bottomLabel}>MAP</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="drive-talk" style={styles.bottomBtn} onPress={() => router.push("/(app)/talk")}>
          <Ionicons name="mic" size={28} color={COLORS.primary} />
          <Text style={styles.bottomLabel}>TALK</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="drive-music" style={styles.bottomBtn} onPress={() => router.push("/(app)/music")}>
          <Ionicons name="musical-notes" size={28} color={COLORS.primary} />
          <Text style={styles.bottomLabel}>MUSIC</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.tip}>Apple CarPlay-ready · Hold mic for voice command</Text>

      <VoiceFAB onIntent={onIntent} />
    </SafeAreaView>
  );
}

function BigButton({ icon, label, color, onPress, testID }: any) {
  return (
    <TouchableOpacity testID={testID} style={[styles.big, { borderColor: color + "55" }]} onPress={onPress}>
      <Ionicons name={icon} size={48} color={color} />
      <Text style={[styles.bigLabel, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg, padding: 16 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  modeLabel: { color: COLORS.primary, fontSize: 14, letterSpacing: 4, fontWeight: "900" },
  time: { color: COLORS.text, fontSize: 22, fontWeight: "900", letterSpacing: 2 },
  hudRow: { flexDirection: "row", gap: 10, marginBottom: 12 },
  hudCard: { flex: 1, backgroundColor: COLORS.surface, borderRadius: 14, padding: 14, alignItems: "center", borderWidth: 1, borderColor: COLORS.border },
  hudVal: { color: COLORS.primary, fontSize: 30, fontWeight: "900" },
  hudLabel: { color: COLORS.textDim, fontSize: 10, letterSpacing: 2, marginTop: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 8 },
  big: {
    width: (width - 16 * 2 - 10) / 2, height: 130, borderRadius: 18, backgroundColor: COLORS.surface,
    borderWidth: 2, alignItems: "center", justifyContent: "center", gap: 8,
  },
  bigLabel: { fontWeight: "900", letterSpacing: 2, fontSize: 14 },
  bottomRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  bottomBtn: { flex: 1, backgroundColor: COLORS.surface, borderRadius: 14, padding: 16, alignItems: "center", borderWidth: 1, borderColor: COLORS.border },
  bottomLabel: { color: COLORS.text, fontSize: 11, letterSpacing: 2, marginTop: 4, fontWeight: "800" },
  tip: { color: COLORS.textDim, textAlign: "center", marginTop: 16, fontSize: 11, letterSpacing: 1.5 },
});
