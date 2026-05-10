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
        {/* Profile */}
        <Text style={styles.sectionLabel}>PROFILE</Text>
        <Glass radius={16} style={styles.card}>
          <TouchableOpacity
            testID="settings-garage"
            onPress={() => router.push("/(app)/garage")}
            activeOpacity={0.85}
            style={{ flexDirection: "row", alignItems: "center", padding: 14, gap: 12 }}
          >
            <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: "rgba(255,199,0,0.18)", alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="car-sport" size={18} color="#FFC700" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: COLORS.text, fontWeight: "600", fontSize: 15 }}>Garage</Text>
              <Text style={{ color: COLORS.textDim, fontSize: 12, marginTop: 2 }}>Year, make, model, color, and car icon</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={COLORS.textDim} />
          </TouchableOpacity>
        </Glass>

        {/* Privacy */}
        <Text style={styles.sectionLabel}>PRIVACY</Text>
        <Glass radius={16} style={styles.card}>
          <ToggleRow
            icon="radio-outline"
            iconColor="#FF6A00"
            title="Comms Live"
            subtitle="Hear & broadcast walkie-talkie on your communities. Off = radio silence."
            value={settings.commsLive}
            onChange={(v) => setSettings({ commsLive: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="car-sport-outline"
            iconColor="#FFC700"
            title="Avatar Live"
            subtitle="Show your car on the community map. Off = invisible to crew and yourself."
            value={settings.avatarLive}
            onChange={(v) => setSettings({ avatarLive: v })}
          />
        </Glass>
        <Text style={styles.helpText}>
          Your car only ever appears on maps inside communities you've joined — strangers from outside the crew can never see you. Toggle Avatar Live off to vanish from the map entirely.
        </Text>

        {/* Map View — exclusive radio choice. We render two RadioRows that
            mirror each other's state so toggling one auto-flips the other. */}
        <Text style={styles.sectionLabel}>MAP VIEW</Text>
        <Glass radius={16} style={styles.card}>
          <RadioRow
            icon="navigate"
            iconColor="#0A84FF"
            title="Heading Up"
            subtitle="Drone view · map rotates under the car · pitch 45° · car always points up"
            selected={settings.mapView === "heading_up"}
            onSelect={() => setSettings({ mapView: "heading_up" })}
          />
          <View style={styles.divider} />
          <RadioRow
            icon="compass-outline"
            iconColor="#34C759"
            title="North Up"
            subtitle="Classic view · map stays fixed north · pitch 0° · car rotates on top"
            selected={settings.mapView === "north_up"}
            onSelect={() => setSettings({ mapView: "north_up" })}
          />
        </Glass>
        <Text style={styles.helpText}>
          Heading Up is the default and feels like Waze/Google during driving. North Up keeps the world steady — helpful for getting your bearings or scanning a wide area. Your choice persists across launches.
        </Text>

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

// Radio-style row used by mutually-exclusive choices (e.g. Heading Up vs
// North Up map view). Visually mirrors ToggleRow but with a circular radio
// indicator instead of a Switch so the UI reads as "pick one of N" rather
// than "boolean on/off".
function RadioRow({
  icon, iconColor, title, subtitle, selected, onSelect,
}: {
  icon: any; iconColor: string; title: string; subtitle: string;
  selected: boolean; onSelect: () => void;
}) {
  return (
    <TouchableOpacity onPress={onSelect} activeOpacity={0.7} style={styles.row}>
      <View style={[styles.iconWrap, { backgroundColor: iconColor + "22" }]}>
        <Ionicons name={icon} size={20} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
      {/* Radio ring — filled core when selected, hollow ring otherwise. */}
      <View style={[styles.radioOuter, selected && { borderColor: "#FFC700" }]}>
        {selected && <View style={styles.radioInner} />}
      </View>
    </TouchableOpacity>
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
  // Radio button visuals — used by RadioRow for mutually-exclusive choices.
  // Hollow ring when unselected, filled yellow core when selected, matching
  // the Convoy brand accent so the active state pops without a Switch.
  radioOuter: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: COLORS.hairline,
    alignItems: "center", justifyContent: "center",
  },
  radioInner: { width: 12, height: 12, borderRadius: 6, backgroundColor: "#FFC700" },
});
