// CarPlay-style "Drive Mode" — large-button fullscreen UI for safety while behind the wheel.
// True CarPlay support requires an EAS dev build with iOS CarPlay entitlements (configured in app.json).
// This screen mirrors the layout that will be projected to the head unit so users can preview it on phone.

import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { COLORS } from "../../src/theme";
import Glass from "../../src/Glass";

export default function DriveMode() {
  const router = useRouter();

  const Tile = ({ icon, label, color, onPress, testID }: { icon: any; label: string; color: string; onPress: () => void; testID: string }) => (
    <TouchableOpacity testID={testID} onPress={onPress} activeOpacity={0.85} style={styles.tileWrap}>
      <Glass radius={28} style={styles.tile}>
        <LinearGradient colors={[color + "77", color + "22"]} style={StyleSheet.absoluteFill} />
        <Ionicons name={icon} size={64} color="#fff" />
        <Text style={styles.tileLabel}>{label}</Text>
      </Glass>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.c} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Drive Mode</Text>
        <TouchableOpacity testID="drive-mode-exit" onPress={() => router.back()} style={styles.exitBtn}>
          <Ionicons name="close" size={28} color={COLORS.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.grid}>
        <View style={styles.row}>
          <Tile testID="dm-map" icon="map" label="Map" color="#0A84FF" onPress={() => router.replace("/(app)/map")} />
          <Tile testID="dm-coms" icon="flash" label="Comms" color="#FFD60A" onPress={() => router.replace("/(app)/talk")} />
        </View>
        <View style={styles.row}>
          <Tile testID="dm-music" icon="musical-notes" label="Music" color="#FF9F0A" onPress={() => router.replace("/(app)/music")} />
          <Tile testID="dm-hub" icon="people-circle" label="Hub" color="#30D158" onPress={() => router.replace("/(app)/hub")} />
        </View>
      </View>

      <Text style={styles.hint}>
        Large-button mode optimized for at-a-glance use while driving. Coming soon to Apple CarPlay head units.
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg, padding: 16 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  title: { color: COLORS.text, fontSize: 30, fontWeight: "800", letterSpacing: -0.6 },
  exitBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.10)", alignItems: "center", justifyContent: "center" },
  grid: { flex: 1, gap: 14 },
  row: { flex: 1, flexDirection: "row", gap: 14 },
  tileWrap: { flex: 1 },
  tile: { flex: 1, alignItems: "center", justifyContent: "center", overflow: "hidden", borderRadius: 28, gap: 12 },
  tileLabel: { color: "#fff", fontSize: 22, fontWeight: "800", letterSpacing: -0.3 },
  hint: { color: COLORS.textDim, textAlign: "center", fontSize: 12, marginTop: 12 },
});
