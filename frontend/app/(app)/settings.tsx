import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { COLORS } from "../../src/theme";
import Glass from "../../src/Glass";
import { useSettings, DEFAULT_SETTINGS, getMapMode, getAvatarMode, setAvatarMode } from "../../src/settings";
import { GAS_BRANDS, OCTANES } from "../../src/gasJockey";

// Re-export for navigation
const _DRIVE_MODE_ROUTE = "/(app)/drive-mode";

// Short pump-grade labels for the Gas Jockey octane radio rows.
const OCTANE_SUB: Record<string, string> = {
  "87": "Regular",
  "89": "Mid-grade",
  "91": "Premium",
  "94": "Ultra / high-octane premium",
};

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
            <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: "rgba(0,196,106,0.18)", alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="car-sport" size={18} color="#00C46A" />
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
            icon="people-outline"
            iconColor="#30D158"
            title="Nearby"
            subtitle="Show how many crew members are near you on the Comms screen."
            value={settings.showNearby}
            onChange={(v) => setSettings({ showNearby: v })}
          />
        </Glass>
        <Text style={styles.helpText}>
          Your car only ever appears on maps inside communities you've joined — strangers from outside the crew can never see you. Choose how you appear with Avatar Live below.
        </Text>

        {/* Avatar Live — 3-way privacy ladder (Full / Partial / Ghost), replacing
            the old on/off toggle. setAvatarMode writes settings.avatarMode and keeps
            the legacy avatarLive boolean in sync. Full vs Partial diverge once the
            car-connection gating ships; Ghost is fully invisible today. */}
        <Text style={styles.sectionLabel}>AVATAR LIVE</Text>
        <Glass radius={16} style={styles.card}>
          <RadioRow
            icon="car-sport"
            iconColor="#00C46A"
            title="Full"
            subtitle="Always on your convoy's map: live while you drive, parked at your car when you're not. Your real location away from the car is never shared."
            selected={getAvatarMode(settings) === "full"}
            onSelect={() => setAvatarMode("full")}
          />
          <View style={styles.divider} />
          <RadioRow
            icon="car-outline"
            iconColor="#0A84FF"
            title="Partial"
            subtitle="Visible only while you're connected to your car. Disconnect and you drop off the map until you reconnect."
            selected={getAvatarMode(settings) === "partial"}
            onSelect={() => setAvatarMode("partial")}
          />
          <View style={styles.divider} />
          <RadioRow
            icon="eye-off-outline"
            iconColor="#8E8E93"
            title="Ghost"
            subtitle="Invisible — your convoy never sees you, driving or parked."
            selected={getAvatarMode(settings) === "ghost"}
            onSelect={() => setAvatarMode("ghost")}
          />
        </Glass>
        <Text style={styles.helpText}>
          Full keeps you on the map even when you step away — pinned to your car, never your real location. Partial shows you only while you're connected to the car. Ghost hides you completely.
        </Text>

        {/* Map View — exclusive radio choice. We render two RadioRows that
            mirror each other's state so toggling one auto-flips the other. */}
        <Text style={styles.sectionLabel}>MAP VIEW</Text>
        <Glass radius={16} style={styles.card}>
          <RadioRow
            icon="navigate"
            iconColor="#0A84FF"
            title="Heading Up"
            subtitle="Drone view, map rotates under the car, 45-degree pitch, car always points up"
            selected={settings.mapView === "heading_up"}
            onSelect={() => setSettings({ mapView: "heading_up" })}
          />
          <View style={styles.divider} />
          <RadioRow
            icon="compass-outline"
            iconColor="#34C759"
            title="North Up"
            subtitle="Classic view, map stays fixed north, flat with no pitch, car rotates on top"
            selected={settings.mapView === "north_up"}
            onSelect={() => setSettings({ mapView: "north_up" })}
          />
        </Glass>
        <Text style={styles.helpText}>
          Heading Up is the default and feels like Waze/Google during driving. North Up keeps the world steady — helpful for getting your bearings or scanning a wide area. Your choice persists across launches.
        </Text>

        {/* Map Layers - persisted overlays that also appear on the map's
            in-context Layers sheet. Satellite/Traffic/Hazards stay map-only
            (they're view controls you flip while looking at the map). */}
        {/* Map Mode — single source of truth (settings.mapMode). Satellite =
            aerial; dawn/day/dusk/night = Mapbox Standard with that light preset.
            Synced with the map's own Layers sheet. */}
        <Text style={styles.sectionLabel}>MAP MODE</Text>
        <Glass radius={16} style={styles.card}>
          {([
            { key: "satellite", icon: "globe", color: "#0A84FF", title: "Satellite", sub: "Aerial imagery with road labels" },
            { key: "dawn", icon: "partly-sunny", color: "#FF9F0A", title: "Dawn", sub: "Soft morning light" },
            { key: "day", icon: "sunny", color: "#FFB300", title: "Day", sub: "Bright daytime" },
            { key: "dusk", icon: "cloudy-night", color: "#FF6A00", title: "Dusk", sub: "Warm evening light" },
            { key: "night", icon: "moon", color: "#5E5CE6", title: "Night", sub: "Dark 3D night map with buildings" },
          ] as const).map((m, i) => (
            <React.Fragment key={m.key}>
              {i > 0 && <View style={styles.divider} />}
              <RadioRow
                icon={m.icon}
                iconColor={m.color}
                title={m.title}
                subtitle={m.sub}
                selected={getMapMode(settings) === m.key}
                onSelect={() => setSettings({ mapMode: m.key })}
              />
            </React.Fragment>
          ))}
        </Glass>
        <Text style={styles.helpText}>
          Pick how the map looks. Satellite shows aerial imagery; Dawn / Day / Dusk / Night use the Mapbox vector map with time-of-day lighting and 3D buildings. Stays in sync with the map's own Layers button.
        </Text>

        <Text style={styles.sectionLabel}>MAP LAYERS</Text>
        <Glass radius={16} style={styles.card}>
          <ToggleRow
            icon="cloudy"
            iconColor="#5AC8FA"
            title="Weather"
            subtitle="Temperature, wind & precipitation overlay on the map"
            value={settings.showWeatherLayer}
            onChange={(v) => setSettings({ showWeatherLayer: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="camera"
            iconColor="#FF453A"
            title="Speed cameras"
            subtitle="Show fixed speed cameras and get a Nova voice alert as you approach (OpenStreetMap)"
            value={settings.speedCameras !== false}
            onChange={(v) => setSettings({ speedCameras: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="location"
            iconColor="#2DEC86"
            title="Place pins"
            subtitle="Show the pin markers for category search results. Gas prices and place names always stay visible."
            value={settings.showPlacePins !== false}
            onChange={(v) => setSettings({ showPlacePins: v })}
          />
        </Glass>
        <Text style={styles.helpText}>
          These persist across launches. Traffic and Hazard pins are toggled from the map's own Layers button since you flip those while looking at the map.
        </Text>

        {/* Gas Jockey — declutter the map's Gas category pins by favorite brand
            + octane. Everything defaults ON, so pins are unfiltered until the
            driver starts switching chains off or picks an octane. */}
        <Text style={styles.sectionLabel}>GAS JOCKEY</Text>
        <Glass radius={16} style={styles.card}>
          {GAS_BRANDS.map((b, i) => (
            <React.Fragment key={b.key}>
              {i > 0 && <View style={styles.divider} />}
              <ToggleRow
                icon="business"
                iconColor="#FF9F0A"
                title={b.label}
                value={(settings.gasBrands ?? {})[b.key] !== false}
                onChange={(v) => setSettings({ gasBrands: { ...(settings.gasBrands ?? {}), [b.key]: v } })}
              />
            </React.Fragment>
          ))}
          <View style={styles.divider} />
          <ToggleRow
            icon="ellipsis-horizontal-circle-outline"
            iconColor="#8E8E93"
            title="Other"
            subtitle="Unbranded & independent stations"
            value={settings.gasOther !== false}
            onChange={(v) => setSettings({ gasOther: v })}
          />
        </Glass>
        <Text style={styles.helpText}>
          Pick the chains you actually stop at — anything you switch off is hidden from the map's Gas pins. Leave them all on to see every station.
        </Text>

        {/* Octane — mutually exclusive. Picking one turns the others off; tap
            the selected one again to clear back to showing every grade. */}
        <Glass radius={16} style={styles.card}>
          {OCTANES.filter((o) => o === '94').map((o, i) => (
            <React.Fragment key={o}>
              {i > 0 && <View style={styles.divider} />}
              <RadioRow
                icon="flame"
                iconColor="#FF9F0A"
                title="High Octane Premium"
                subtitle="Ultra 94"
                selected={settings.gasOctane === o}
                onSelect={() => setSettings({ gasOctane: settings.gasOctane === o ? null : o })}
              />
            </React.Fragment>
          ))}
        </Glass>
        <Text style={styles.helpText}>
          Show only stations that carry your fuel. Choosing an octane turns the others off; tap it again to clear and show all grades. Stations that don't publish fuel data stay visible.
        </Text>

        {/* SPEED UNITS section removed — units are now fully GPS-automatic
            worldwide (map.tsx reverse-geocodes the country and applies
            unitForCountry), with no manual override. */}

        {/* Convoy Community */}
        <Text style={styles.sectionLabel}>CONVOY COMMUNITY</Text>
        <Glass radius={16} style={styles.card}>
          <ToggleRow
            icon="ribbon"
            iconColor="#2DEC86"
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

        {/* Nova Voice — toggle Nova's spoken extras. Turn-by-turn directions are
            NOT gated here (use the map mute button for those); these control the
            personable greeting, speeding nudges, and proactive mid-drive callouts. */}
        <Text style={styles.sectionLabel}>NOVA VOICE</Text>
        <Glass radius={16} style={styles.card}>
          <ToggleRow
            icon="volume-high"
            iconColor="#BF5AF2"
            title="Nova voice"
            subtitle="Master switch for all of Nova's voice"
            value={settings.novaVoice !== false}
            onChange={(v) => setSettings({ novaVoice: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="sparkles"
            iconColor="#BF5AF2"
            title="Route greeting"
            subtitle="Nova's personable hello when you tap Start on a drive"
            value={settings.novaGreeting !== false}
            onChange={(v) => setSettings({ novaGreeting: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="speedometer"
            iconColor="#FF453A"
            title="Speeding alerts"
            subtitle="Nova warns you when you're well over the posted limit"
            value={settings.novaSpeeding !== false}
            onChange={(v) => setSettings({ novaSpeeding: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="navigate-circle"
            iconColor="#0A84FF"
            title="Mid-drive callouts"
            subtitle="Proactive faster-route and hazard-ahead suggestions while navigating"
            value={settings.novaMidDrive !== false}
            onChange={(v) => setSettings({ novaMidDrive: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="git-compare-outline"
            iconColor="#0A84FF"
            title="Reroute announcements"
            subtitle="Nova's spoken reaction when the route recomputes"
            value={settings.novaReroute !== false}
            onChange={(v) => setSettings({ novaReroute: v })}
          />
        </Glass>
        <Text style={styles.helpText}>
          These control Nova's extra spoken touches. Turn-by-turn directions aren't affected — silence those with the mute button on the map.
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
      <View style={[styles.radioOuter, selected && { borderColor: "#00C46A" }]}>
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
    backgroundColor: "#2DEC8622",
    borderColor: "#2DEC8688",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  badgeText: { color: "#2DEC86", fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  // Radio button visuals — used by RadioRow for mutually-exclusive choices.
  // Hollow ring when unselected, filled yellow core when selected, matching
  // the Convoy brand accent so the active state pops without a Switch.
  radioOuter: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: COLORS.hairline,
    alignItems: "center", justifyContent: "center",
  },
  radioInner: { width: 12, height: 12, borderRadius: 6, backgroundColor: "#00C46A" },
});
