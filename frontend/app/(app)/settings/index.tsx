import React, { useCallback, useState } from "react";
import { Text, StyleSheet, TouchableOpacity, Linking, Alert } from "react-native";
import { useRouter } from "expo-router";
import { GlassFill } from "../../../src/Glass";
import { useAuth } from "../../../src/auth";
import { resetAppData } from "../../../src/resetAppData";
import { isNavSessionLive } from "../../../src/navNotification";
import { headUnitAttachedRaw } from "../../../src/locationPrivacy";
import {
  useSettings,
  updateSettings,
  getMapModeChoice,
  getRouteColor,
} from "../../../src/settings";
import {
  SettingsPage,
  SectionLabel,
  SettingsCard,
  MenuRow,
  ToggleRow,
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

  // Jeff 8/20: donations live at the BOTTOM of Settings. External link during
  // beta; store builds must swap this to an IAP tip jar (Apple rejects tip
  // links that bypass IAP — RevenueCat consumables ride build 74's track).
  const openDonate = useCallback(() => {
    const url = "https://hairpin.app/donate"; // placeholder until Jeff supplies the real donation link
    Linking.openURL(url).catch(() =>
      Alert.alert("Couldn't open the page", "Visit hairpin.app/donate in your browser.")
    );
  }, []);

  const sendFeedback = useCallback(() => {
    const url = "mailto:support@hairpin.app?subject=Hairpin%20Feedback";
    Linking.openURL(url).catch(() =>
      Alert.alert("Couldn't open Mail", "Email us at support@hairpin.app")
    );
  }, []);


  const confirmReset = useCallback(() => {
    // Not mid-drive: a reload would orphan the native location task / Android
    // foreground notification / car session (review, 8/21). Same rule the red pill uses.
    if (isNavSessionLive() || headUnitAttachedRaw()) {
      Alert.alert("End navigation first", "Finish the drive and disconnect from CarPlay / Android Auto, then reset.");
      return;
    }
    Alert.alert("Reset app data", "This wipes all of Hairpin's saved data on this phone — settings, saved sign-in, cached routes and places — and restarts the app. Your account and drives on the server are untouched. You'll sign in again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Reset and restart", style: "destructive", onPress: () => {
        void resetAppData().then((restarted) => {
          if (restarted) return;                 // the JS context is already being torn down
          void logout();
          Alert.alert("Data wiped", "Close Hairpin completely and reopen it to finish the reset.");
        });
      } },
    ]);
  }, [logout]);

  const confirmSignOut = useCallback(() => {
    Alert.alert("Sign out", "Sign out of Hairpin on this device?", [
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
        <MenuRow icon="color-palette" iconColor="#E0A93E" title="App Skin" subtitle="The metal the whole app wears" onPress={() => go("/(app)/settings/app-skin")} />
        <Divider />
        <MenuRow icon="map" iconColor="#0A84FF" title="Map Mode" value={mapModeVal} onPress={() => go("/(app)/settings/map-mode")} />
        <Divider />
        <MenuRow icon="navigate" iconColor="#0A84FF" title="Map View" value={mapViewVal} onPress={() => go("/(app)/settings/map-view")} />
        <Divider />
        <MenuRow icon="color-palette" iconColor="#BF5AF2" title="Route Color" swatch={routeColor} onPress={() => go("/(app)/settings/route-color")} />
        <Divider />
        <MenuRow icon="options" iconColor="#30D158" title="Route Preferences" subtitle="Tolls, highways, ferries" onPress={() => go("/(app)/settings/route-preferences")} />
      </SettingsCard>

      {/* DRIVING — keep the screen alive + quiet Hairpin on a call */}
      <SectionLabel>DRIVING</SectionLabel>
      <SettingsCard>
        <ToggleRow
          icon="phone-portrait" iconColor="#5AC8FA"
          title="Prevent Auto-Lock"
          subtitle="Keep the screen on so the map & CarPlay marker don't freeze"
          value={settings.preventAutoLock !== false}
          onChange={(v) => updateSettings({ preventAutoLock: v })}
        />
        <Divider />
        <ToggleRow
          icon="call" iconColor="#30D158"
          title="Mute During Calls"
          subtitle="Silence Scout, comms & dings while you're on a phone call"
          value={settings.muteDuringCalls !== false}
          onChange={(v) => updateSettings({ muteDuringCalls: v })}
        />
        <Divider />
        <ToggleRow
          icon="battery-half" iconColor="#FFD60A"
          title="Battery Saver"
          subtitle="Run cooler: lighter GPS & frame rate. Off = auto (eco only when unplugged)"
          value={settings.powerProfile === "eco"}
          onChange={(v) => updateSettings({ powerProfile: v ? "eco" : "auto" })}
        />
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

      {/* AUDIO — tester calibration for per-source output levels */}
      <SectionLabel>AUDIO</SectionLabel>
      <SettingsCard>
        <MenuRow icon="options" iconColor="#FF9F0A" title="Audio Levels" subtitle="Tune Scout, dings & comms volume" onPress={() => go("/(app)/settings/audio")} />
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
        <Divider />
        {/* The one-tap fresh install (2026-08-21). See src/resetAppData.ts. */}
        <MenuRow
          icon="refresh-circle"
          iconColor="#FF9F0A"
          title="Reset app data"
          subtitle="Wipes every saved setting and session on this phone and restarts — like a fresh install"
          onPress={confirmReset}
          destructive
          testID="settings-reset-app-data"
        />
      </SettingsCard>

      {/* DONATIONS — Jeff's ask: a word about what it costs to keep Hairpin
          running, but never a cost breakdown. */}
      <SectionLabel>SUPPORT THE ROAD</SectionLabel>
      <SettingsCard>
        <Text style={styles.donateBlurb}>
          Hairpin is built and run by one person. Every drive you take runs on
          real infrastructure — live maps, routing, voice and the servers that
          keep your convoy connected — and those bills arrive every single day,
          whether or not anyone pays for the app. If Hairpin makes your drives
          better, a donation of any size genuinely helps keep it on the road.
        </Text>
        <Divider />
        <MenuRow
          icon="heart"
          iconColor="#FF375F"
          title="Donate"
          subtitle="Help cover the daily running costs"
          onPress={openDonate}
        />
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
  donateBlurb: {
    color: "#B9B9BF", fontSize: 12.5, lineHeight: 18,
    paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10,
  },
  signOut: {
    marginTop: 26, height: 52, borderRadius: 16, overflow: "hidden",
    alignItems: "center", justifyContent: "center", backgroundColor: "transparent",
  },
  signOutText: { color: "#FF453A", fontSize: 16, fontWeight: "700" },
});
