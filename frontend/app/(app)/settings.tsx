import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { COLORS } from "../../src/theme";
import Glass from "../../src/Glass";
import { useSettings, DEFAULT_SETTINGS } from "../../src/settings";

// Re-export for navigation
const _DRIVE_MODE_ROUTE = "/(app)/drive-mode";

type RowProps = {
  icon: any;
  iconColor: string;
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  badge?: string;
};

function ToggleRow({ icon, iconColor, title, subtitle, value, onChange, badge }: RowProps) {
  return (
    <View style={styles.row}>
      <View style={[styles.iconWrap, { backgroundColor: iconColor + "22" }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={styles.title}>{title}</Text>
          {badge && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{badge}</Text>
            </View>
          )}
        </View>
        {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: "#3A3A3C", true: COLORS.primary }}
        thumbColor="#FFFFFF"
        ios_backgroundColor="#3A3A3C"
      />
    </View>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const [settings, setSettings] = useSettings();

  return (
    <View style={styles.container}>
      <SafeAreaView edges={["top"]} style={styles.headerWrap}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} testID="settings-back">
            <Ionicons name="chevron-back" size={26} color={COLORS.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Settings</Text>
          <View style={styles.headerBtn} />
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Live Feeds */}
        <Text style={styles.sectionLabel}>LIVE TRAFFIC FEEDS</Text>
        <Glass radius={16} style={styles.card}>
          <ToggleRow
            icon="globe-outline"
            iconColor="#3478F6"
            title="North America"
            subtitle="rtproxy-na.waze.com · Police, accidents, jams"
            value={settings.feedNA}
            onChange={(v) => setSettings({ feedNA: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="earth-outline"
            iconColor="#5AC8FA"
            title="International"
            subtitle="rtproxy-row.waze.com · Rest of World"
            value={settings.feedROW}
            onChange={(v) => setSettings({ feedROW: v })}
          />
        </Glass>
        <Text style={styles.helpText}>
          Public live-feed proxies enthusiast apps tap into. Disabling both will hide the “live” pins on the map.
        </Text>

        {/* Convoy Community */}
        <Text style={styles.sectionLabel}>CONVOY COMMUNITY</Text>
        <Glass radius={16} style={styles.card}>
          <ToggleRow
            icon="ribbon"
            iconColor="#FFD60A"
            title="Highlight Convoy reports"
            subtitle="Gold border around hazards reported by fellow Convoy drivers"
            value={settings.highlightConvoy}
            onChange={(v) => setSettings({ highlightConvoy: v })}
            badge="GOLD"
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="musical-note"
            iconColor="#FF9F0A"
            title="Convoy alert sound"
            subtitle="Subtle chime when a new community report appears nearby"
            value={settings.alertSound}
            onChange={(v) => setSettings({ alertSound: v })}
          />
        </Glass>
        <Text style={styles.helpText}>
          Convoy-originated reports are prioritized: they appear with a distinct gold border so you can tell at a glance which alerts came from your crew vs. the general feed.
        </Text>

        {/* Route Preferences */}
        <Text style={styles.sectionLabel}>ROUTE PREFERENCES</Text>
        <Glass radius={16} style={styles.card}>
          <ToggleRow
            icon="cash-outline"
            iconColor="#30D158"
            title="Avoid tolls"
            subtitle="Skip toll roads when possible"
            value={settings.avoidTolls}
            onChange={(v) => setSettings({ avoidTolls: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="speedometer-outline"
            iconColor="#FF9F0A"
            title="Avoid highways"
            subtitle="Prefer surface streets over freeways"
            value={settings.avoidHighways}
            onChange={(v) => setSettings({ avoidHighways: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="boat-outline"
            iconColor="#5AC8FA"
            title="Avoid ferries"
            subtitle="Don't route over water crossings"
            value={settings.avoidFerries}
            onChange={(v) => setSettings({ avoidFerries: v })}
          />
        </Glass>
        <Text style={styles.helpText}>
          Applied to every directions request — including auto-reroute when you go off-route. Routes refresh automatically when you toggle a preference.
        </Text>

        {/* Drive Mode */}
        <Text style={styles.sectionLabel}>DRIVE MODE</Text>
        <Glass radius={16} style={styles.card}>
          <TouchableOpacity testID="open-drive-mode" onPress={() => router.push("/(app)/drive-mode" as any)} style={styles.row} activeOpacity={0.85}>
            <View style={[styles.iconWrap, { backgroundColor: "#0A84FF22" }]}>
              <Ionicons name="car-sport" size={20} color="#0A84FF" />
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={styles.title}>Open Drive Mode</Text>
                <View style={[styles.badge, { backgroundColor: "#0A84FF22", borderColor: "#0A84FF88" }]}>
                  <Text style={[styles.badgeText, { color: "#0A84FF" }]}>CARPLAY</Text>
                </View>
              </View>
              <Text style={styles.subtitle}>Large-button fullscreen UI optimized for the head unit. Coming to Apple CarPlay in an EAS dev build.</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={COLORS.textDim} />
          </TouchableOpacity>
        </Glass>

        <View style={{ height: 120 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  headerWrap: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.hairline },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 8 },
  headerBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerTitle: { color: COLORS.text, fontSize: 17, fontWeight: "600", letterSpacing: -0.3 },
  content: { paddingHorizontal: 16, paddingTop: 12 },
  sectionLabel: {
    color: COLORS.textDim, fontSize: 12, fontWeight: "600",
    letterSpacing: 0.6, marginTop: 18, marginBottom: 8, marginLeft: 4,
  },
  card: { padding: 4 },
  row: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  title: { color: COLORS.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: COLORS.textDim, fontSize: 12, marginTop: 2, lineHeight: 16 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: COLORS.hairline, marginLeft: 60 },
  helpText: { color: COLORS.textMute || COLORS.textDim, fontSize: 11, lineHeight: 16, paddingHorizontal: 6, paddingTop: 8 },
  badge: {
    backgroundColor: "#FFD60A22",
    borderColor: "#FFD60A88",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  badgeText: { color: "#FFD60A", fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
});
