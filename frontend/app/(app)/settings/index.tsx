import React, { useCallback } from "react";
import { Text, StyleSheet, TouchableOpacity, Linking, Alert } from "react-native";
import { useRouter } from "expo-router";
import { GlassFill } from "../../../src/Glass";
import { useAuth } from "../../../src/auth";
import {
  useSettings,
  getMapModeChoice,
  getRouteColor,
} from "../../../src/settings";
import {
  SettingsPage,
  SectionLabel,
  SettingsCard,
  MenuRow,
  Divider,
} from "../../../src/components/settingsKit";

const MAP_MODE_LABEL: Record<string, string> = {
  auto: "Auto", satellite: "Satellite", dawn: "Dawn", day: "Day", dusk: "Dusk", night: "Night",
};

export default function SettingsMenu() {
  const router = useRouter();
  const { logout } = useAuth();
  const [settings] = useSettings();
  const go = useCallback((path: string) => router.push(path as any), [router]);

  const mapModeVal = MAP_MODE_LABEL[getMapModeChoice(settings)] ?? "Auto";
  const mapViewVal = settings.mapView === "north_up" ? "North Up" : "Heading Up";
  const scoutVal = settings.novaVoice !== false ? "On" : "Off";
  const routeColor = getRouteColor(settings);

  const sendFeedback = useCallback(() => {
    const url = "mailto:support@convoy.app?subject=Convoy%20Feedback";
    Linking.openURL(url).catch(() =>
      Alert.alert("Couldn't open Mail", "Email us at support@convoy.app")
    );
  }, []);

  const confirmSignOut = useCallback(() => {
    Alert.alert("Sign out", "Sign out of Convoy on this device?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => { void logout(); } },
    ]);
  }, [logout]);

  return (
    <SettingsPage title="Settings">
      {/* PROFILE */}
      <SectionLabel>PROFILE</SectionLabel>
      <SettingsCard>
        <MenuRow
          icon="car-sport" iconColor="#00C46A" title="Garage"
          subtitle="Year, make, model, color & car icon"
          onPress={() => go("/(app)/garage")} testID="settings-garage"
        />
      </SettingsCard>

      {/* NAVIGATION */}
      <SectionLabel>NAVIGATION</SectionLabel>
      <SettingsCard>
        <MenuRow icon="map" iconColor="#0A84FF" title="Map Mode" value={mapModeVal} onPress={() => go("/(app)/settings/map-mode")} />
        <Divider />
        <MenuRow icon="navigate" iconColor="#0A84FF" title="Map View" value={mapViewVal} onPress={() => go("/(app)/settings/map-view")} />
        <Divider />
        <MenuRow icon="color-palette" iconColor="#BF5AF2" title="Route Color" swatch={routeColor} onPress={() => go("/(app)/settings/route-color")} />
        <Divider />
        <MenuRow icon="options" iconColor="#30D158" title="Route Preferences" subtitle="Tolls, highways, ferries" onPress={() => go("/(app)/settings/route-preferences")} />
      </SettingsCard>

      {/* MAP & FUEL */}
      <SectionLabel>MAP &amp; FUEL</SectionLabel>
      <SettingsCard>
        <MenuRow icon="layers" iconColor="#5AC8FA" title="Map Layers" subtitle="Weather, speed cameras, place pins" onPress={() => go("/(app)/settings/map-layers")} />
        <Divider />
        <MenuRow icon="flame" iconColor="#FF9F0A" title="Gas Jockey" subtitle="Filter gas pins by brand & octane" onPress={() => go("/(app)/settings/gas-jockey")} />
      </SettingsCard>

      {/* ASSISTANT */}
      <SectionLabel>ASSISTANT</SectionLabel>
      <SettingsCard>
        <MenuRow icon="volume-high" iconColor="#BF5AF2" title="Scout Voice" value={scoutVal} subtitle="Greeting, speed & mid-drive callouts" onPress={() => go("/(app)/settings/scout-voice")} />
      </SettingsCard>

      {/* COMMUNITY */}
      <SectionLabel>COMMUNITY</SectionLabel>
      <SettingsCard>
        <MenuRow icon="ribbon" iconColor="#2DEC86" title="Convoy Community" subtitle="Report highlighting & alert sound" onPress={() => go("/(app)/settings/community")} />
      </SettingsCard>

      {/* PRIVACY */}
      <SectionLabel>PRIVACY</SectionLabel>
      <SettingsCard>
        <MenuRow icon="eye-off" iconColor="#30D158" title="Visibility & Comms" subtitle="Avatar Live, Comms, Nearby" onPress={() => go("/(app)/settings/privacy")} />
        <Divider />
        <MenuRow icon="location" iconColor="#FF453A" title="Location Services" onPress={() => go("/(app)/settings/location-services")} />
      </SettingsCard>

      {/* LEGAL */}
      <SectionLabel>LEGAL</SectionLabel>
      <SettingsCard>
        <MenuRow icon="document-text" iconColor="#8E8E93" title="Privacy Policy" onPress={() => go("/(app)/settings/privacy-policy")} />
        <Divider />
        <MenuRow icon="reader" iconColor="#8E8E93" title="Terms of Service" onPress={() => go("/(app)/settings/terms")} />
        <Divider />
        <MenuRow icon="shield-checkmark" iconColor="#8E8E93" title="Safety Guidelines" onPress={() => go("/(app)/settings/safety")} />
      </SettingsCard>

      {/* SUPPORT */}
      <SectionLabel>SUPPORT</SectionLabel>
      <SettingsCard>
        <MenuRow icon="chatbox-ellipses" iconColor="#0A84FF" title="Send Feedback" onPress={sendFeedback} />
        <Divider />
        <MenuRow icon="bug" iconColor="#8E8E93" title="Developer" subtitle="Debug overlays" onPress={() => go("/(app)/settings/developer")} />
      </SettingsCard>

      {/* SIGN OUT */}
      <TouchableOpacity onPress={confirmSignOut} activeOpacity={0.85} style={styles.signOut} testID="settings-signout">
        <GlassFill tintColor="rgba(20,20,24,0.5)" style={{ borderRadius: 16, overflow: "hidden" }} />
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  signOut: {
    marginTop: 26, height: 52, borderRadius: 16, overflow: "hidden",
    alignItems: "center", justifyContent: "center", backgroundColor: "transparent",
  },
  signOutText: { color: "#FF453A", fontSize: 16, fontWeight: "700" },
});
