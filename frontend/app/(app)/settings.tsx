import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { COLORS } from "../../src/theme";
import Glass from "../../src/Glass";
import { useSettings, DEFAULT_SETTINGS, getMapModeChoice, getAvatarMode, setAvatarMode, getSpeedAlertMode, getRouteColor, getNovaVoice } from "../../src/settings";
import { NOVA_VOICES, previewNovaVoice, stopNovaPreview } from "../../src/novaVoices";
import { GAS_BRANDS, OCTANES } from "../../src/gasJockey";

// Re-export for navigation
const _DRIVE_MODE_ROUTE = "/(app)/drive-mode";

// Route-color presets — one-tap common colors (the spectrum bar below covers anything
// else). Picked to stay vivid + legible on the dark + satellite basemaps.
const ROUTE_PRESETS = [
  "#2DEC86", // brand green
  "#0A84FF", // Waze blue
  "#00D6E0", // cyan
  "#5E5CE6", // indigo
  "#BF5CFF", // purple
  "#FF2D95", // pink
  "#FF3B30", // red
  "#FF9500", // orange
  "#FFD60A", // yellow
  "#FFFFFF", // white
];

// HSL → #rrggbb. Used by the route-color spectrum bar so a tapped hue maps to a fixed
// vivid saturation/lightness (can't produce an illegible near-black/muddy color).
function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

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
  // Measured width of the route-color spectrum bar (for tap→hue mapping).
  const [spectrumW, setSpectrumW] = useState(0);
  const routeColor = getRouteColor(settings);
  const novaVoiceSel = getNovaVoice(settings);
  // Stop any voice-preview sample if the user leaves Settings mid-playback.
  useEffect(() => () => { void stopNovaPreview(); }, []);

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
            subtitle="Live while you're connected to your car; disconnect and you stay pinned at your car's last spot — your real location away from the car is never shared. Reconnect to go live."
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
          Full and Partial both keep you on the map at your car — live while you drive, pinned at your car's spot when you disconnect, never your real location away from it. Ghost hides you completely.
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
            { key: "auto", icon: "time", color: "#2DEC86", title: "Auto", sub: "Follows the time of day — dawn / day / dusk / night" },
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
                selected={getMapModeChoice(settings) === m.key}
                onSelect={() => setSettings({ mapMode: m.key })}
              />
            </React.Fragment>
          ))}
        </Glass>
        <Text style={styles.helpText}>
          Pick how the map looks. Satellite shows aerial imagery; Dawn / Day / Dusk / Night use the Mapbox vector map with time-of-day lighting and 3D buildings. Stays in sync with the map's own Layers button.
        </Text>

        {/* Route Color — recolors the route line (core + glow + near-car fade) on the
            phone AND CarPlay. Presets for one-tap, spectrum bar for any custom color. */}
        <Text style={styles.sectionLabel}>ROUTE COLOR</Text>
        <Glass radius={16} style={styles.card}>
          <View style={{ padding: 14 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
              {ROUTE_PRESETS.map((hex) => {
                const active = routeColor.toLowerCase() === hex.toLowerCase();
                return (
                  <TouchableOpacity
                    key={hex}
                    activeOpacity={0.8}
                    onPress={() => setSettings({ routeColor: hex })}
                    style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: hex, borderWidth: active ? 3 : 1, borderColor: active ? "#FFFFFF" : "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" }}
                  >
                    {active && <Ionicons name="checkmark" size={18} color={hex === "#FFFFFF" || hex === "#FFD60A" ? "#000" : "#FFF"} />}
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={{ color: "#808080", fontSize: 12, fontWeight: "600", marginTop: 16, marginBottom: 8 }}>Custom — tap the spectrum</Text>
            <TouchableOpacity
              activeOpacity={1}
              onLayout={(e) => setSpectrumW(e.nativeEvent.layout.width)}
              onPress={(e) => {
                if (spectrumW > 0) {
                  const x = Math.max(0, Math.min(spectrumW, e.nativeEvent.locationX));
                  setSettings({ routeColor: hslToHex(Math.round((x / spectrumW) * 360), 85, 55) });
                }
              }}
              style={{ height: 28, borderRadius: 8, overflow: "hidden", flexDirection: "row", borderWidth: 1, borderColor: "rgba(255,255,255,0.15)" }}
            >
              {Array.from({ length: 60 }).map((_, i) => (
                <View key={i} style={{ flex: 1, backgroundColor: hslToHex(Math.round((i / 59) * 360), 85, 55) }} />
              ))}
            </TouchableOpacity>

            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 14, gap: 10 }}>
              <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: routeColor, borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" }} />
              <Text style={{ color: "#F4F4F4", fontSize: 14, fontWeight: "700" }}>{routeColor.toUpperCase()}</Text>
            </View>
          </View>
        </Glass>
        <Text style={styles.helpText}>
          Sets your route-line color on the map and CarPlay. Tap a preset, or tap anywhere on the spectrum for a custom color. The glow and the fade near your car follow the same color automatically.
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
            subtitle="Show fixed speed cameras and get a Scout voice alert as you approach (OpenStreetMap)"
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

        {/* Scout Voice — toggle Scout's spoken extras. Turn-by-turn directions are
            NOT gated here (use the map mute button for those); these control the
            personable greeting, speeding nudges, and proactive mid-drive callouts. */}
        <Text style={styles.sectionLabel}>SCOUT VOICE</Text>
        <Glass radius={16} style={styles.card}>
          <ToggleRow
            icon="volume-high"
            iconColor="#BF5AF2"
            title="Scout voice"
            subtitle="Master switch for all of Scout's voice"
            value={settings.novaVoice !== false}
            onChange={(v) => setSettings({ novaVoice: v })}
          />
          <View style={styles.divider} />
          {/* Voice picker — which OpenAI voice Scout speaks in. Tap a chip to select
              it AND hear a short sample (cached per voice). */}
          <View style={styles.voicePicker}>
            <View style={styles.voicePickerHeader}>
              <Ionicons name="mic" size={18} color="#BF5AF2" />
              <Text style={styles.voicePickerTitle}>Voice</Text>
              <Text style={styles.voicePickerHint}>Tap to hear</Text>
            </View>
            <View style={styles.voiceChipWrap}>
              {NOVA_VOICES.map((v) => {
                const active = novaVoiceSel === v.id;
                return (
                  <TouchableOpacity
                    key={v.id}
                    testID={`nova-voice-${v.id}`}
                    activeOpacity={0.85}
                    onPress={() => { setSettings({ novaVoiceName: v.id }); void previewNovaVoice(v.id); }}
                    style={[styles.voiceChip, active && styles.voiceChipActive]}
                  >
                    <View style={styles.voiceChipTop}>
                      <Ionicons name={active ? "volume-high" : "volume-medium-outline"} size={14} color={active ? "#BF5AF2" : "#8E8E93"} />
                      <Text style={[styles.voiceChipLabel, active && styles.voiceChipLabelActive]}>{v.label}</Text>
                    </View>
                    <Text style={styles.voiceChipBlurb} numberOfLines={1}>{v.blurb}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
          <View style={styles.divider} />
          <ToggleRow
            icon="chatbubbles"
            iconColor="#BF5AF2"
            title="Hands-free replies"
            subtitle="Answer Scout out loud — say “yes” / “no” to her prompts (e.g. a faster route) instead of tapping"
            value={settings.scoutHandsFree !== false}
            onChange={(v) => setSettings({ scoutHandsFree: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="car-sport"
            iconColor="#BF5AF2"
            title="Convoy alerts"
            subtitle="Scout speaks up when the crew spreads out and someone falls behind"
            value={settings.convoyAlerts !== false}
            onChange={(v) => setSettings({ convoyAlerts: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="bulb"
            iconColor="#BF5AF2"
            title="Departure IQ"
            subtitle="When you're parked at a saved place, offer a one-tap drive to where you usually head next"
            value={settings.departureIQ !== false}
            onChange={(v) => setSettings({ departureIQ: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="sparkles"
            iconColor="#BF5AF2"
            title="Route greeting"
            subtitle="Scout's personable hello when you tap Start on a drive"
            value={settings.novaGreeting !== false}
            onChange={(v) => setSettings({ novaGreeting: v })}
          />
          <View style={styles.divider} />
          {/* Speed alert — three-way: Scout speaks / Ding chimes / Off.
              getSpeedAlertMode() migrates the legacy novaSpeeding boolean; we
              keep novaSpeeding synced (nova → true, else false) for back-compat. */}
          <RadioRow
            icon="speedometer"
            iconColor="#FF453A"
            title="Speed alert — Scout"
            subtitle="Scout speaks up when you're well over the limit (~21 over), firmer at ~41 over"
            selected={getSpeedAlertMode(settings) === "nova"}
            onSelect={() => setSettings({ speedAlertMode: "nova", novaSpeeding: true })}
          />
          <View style={styles.divider} />
          <RadioRow
            icon="notifications"
            iconColor="#FF9F0A"
            title="Speed alert — Ding"
            subtitle="A chime instead of a voice: one ding ~21 over, a double ding ~41 over"
            selected={getSpeedAlertMode(settings) === "ding"}
            onSelect={() => setSettings({ speedAlertMode: "ding", novaSpeeding: false })}
          />
          <View style={styles.divider} />
          <RadioRow
            icon="speedometer-outline"
            iconColor="#8E8E93"
            title="Speed alert — Off"
            subtitle="No speed warnings"
            selected={getSpeedAlertMode(settings) === "off"}
            onSelect={() => setSettings({ speedAlertMode: "off", novaSpeeding: false })}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="trending-up"
            iconColor="#FF9F0A"
            title="Adaptive alerts"
            subtitle="Learn your usual pace so the first nudge stops nagging at speeds you always drive (the firmer alert stays fixed)"
            value={settings.adaptiveSpeedAlerts !== false}
            onChange={(v) => setSettings({ adaptiveSpeedAlerts: v })}
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
        </Glass>
        <Text style={styles.helpText}>
          These control Scout's extra spoken touches. Turn-by-turn directions aren't affected — silence those with the mute button on the map.
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

        {/* Developer */}
        <Text style={styles.sectionLabel}>DEVELOPER</Text>
        <Glass radius={16} style={styles.card}>
          <ToggleRow
            icon="bug-outline"
            iconColor="#8E8E93"
            title="Debug overlays"
            subtitle="Show diagnostic readouts on the map and CarPlay — off keeps the screen clean"
            value={settings.debugOverlays === true}
            onChange={(v) => setSettings({ debugOverlays: v })}
          />
          <ToggleRow
            icon="car-sport-outline"
            iconColor="#8E8E93"
            title="CarPlay debug"
            subtitle="Show the feed breadcrumb + readouts on the CarPlay screen — off by default"
            value={settings.carplayDebug === true}
            onChange={(v) => setSettings({ carplayDebug: v })}
          />
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
  voicePicker: { paddingHorizontal: 14, paddingVertical: 12 },
  voicePickerHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  voicePickerTitle: { color: COLORS.text, fontSize: 15, fontWeight: "500", flex: 1 },
  voicePickerHint: { color: COLORS.textDim, fontSize: 12 },
  voiceChipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  voiceChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)", minWidth: 104 },
  voiceChipActive: { backgroundColor: "rgba(191,90,242,0.18)", borderColor: "#BF5AF2" },
  voiceChipTop: { flexDirection: "row", alignItems: "center", gap: 6 },
  voiceChipLabel: { color: "#C7C7CC", fontSize: 14, fontWeight: "700" },
  voiceChipLabelActive: { color: "#F4F4F4" },
  voiceChipBlurb: { color: COLORS.textDim, fontSize: 11, marginTop: 2 },
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
