import React, { useCallback } from "react";
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
  // Names what it measures: the row is "Scout & Alerts" now (Jeff, 2026-09-23: menu reorganization),
  // and a bare "Off" would claim the alerts are off too — but novaVoice only gates what Scout SAYS;
  // speed dings and the road heads-up dings still play (speedDing.ts has no novaVoice gate).
  const scoutVal = settings.novaVoice !== false ? "Voice on" : "Voice off";
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
      {/* Grouped by what the driver is doing, not by where the code lives (Jeff, 2026-09-23:
          menu reorganization). The PROFILE › Garage row that used to head this page is gone —
          the Garage lives in the H menu now, and two doors to one room read as two rooms. */}

      {/* MAP — how the map looks and what it shows */}
      <SectionLabel>MAP</SectionLabel>
      <SettingsCard>
        <MenuRow icon="map" iconColor="#0A84FF" title="Map Mode" value={mapModeVal} onPress={() => go("/(app)/settings/map-mode")} />
        <Divider />
        {/* Was "Map View" — the page picks Heading Up vs North Up, which is an orientation. */}
        <MenuRow icon="compass" iconColor="#0A84FF" title="Map Orientation" value={mapViewVal} onPress={() => go("/(app)/settings/map-view")} />
        <Divider />
        <MenuRow icon="layers" iconColor="#5AC8FA" title="Map Layers" subtitle="Weather, cameras, incidents, pins" onPress={() => go("/(app)/settings/map-layers")} />
        <Divider />
        <MenuRow icon="flame" iconColor="#FF9F0A" title="Gas Jockey" subtitle="Filter gas pins by brand & octane" onPress={() => go("/(app)/settings/gas-jockey")} />
      </SettingsCard>

      {/* DRIVING — the route, keep the screen alive, quiet Hairpin on a call */}
      <SectionLabel>DRIVING</SectionLabel>
      <SettingsCard>
        <MenuRow icon="options" iconColor="#30D158" title="Route Preferences" subtitle="Tolls, highways, ferries & Pitstop timer" onPress={() => go("/(app)/settings/route-preferences")} />
        <Divider />
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
        {/* Restored 2026-08-30, one day after being removed — Say Phin reported heavy
            drain on a 106-minute unplugged Android Auto drive. The old subtitle claimed
            "lighter GPS & frame rate"; the frame-rate half had been dead since 08-14, so
            it advertised a saving it no longer delivered. This copy states only what the
            switch actually does, with the real measured numbers. */}
        <ToggleRow
          icon="battery-half" iconColor="#FFD60A"
          title="Battery Saver"
          subtitle="Lighter GPS — about 10 m accuracy instead of 4 m. Worth it on long drives without a charger."
          value={settings.liteGps === true}
          onChange={(v) => updateSettings({ liteGps: v })}
        />
      </SettingsCard>

      {/* SCOUT & SOUND — what Scout says and how loud everything plays. The road heads-ups
          (railway / school / playground) moved into Scout & Alerts: they are things Scout
          SAYS, not things the map draws. */}
      <SectionLabel>SCOUT &amp; SOUND</SectionLabel>
      <SettingsCard>
        <MenuRow icon="volume-high" iconColor="#BF5AF2" title="Scout & Alerts" value={scoutVal} subtitle="Voice, speed & road alerts" onPress={() => go("/(app)/settings/scout-voice")} />
        <Divider />
        {/* Own icon: 'options' is Route Preferences' glyph, and two rows wearing the same
            icon read as the same page. */}
        <MenuRow icon="musical-notes" iconColor="#FF9F0A" title="Audio" subtitle="Tune Scout, dings & comms volume" onPress={() => go("/(app)/settings/audio")} />
      </SettingsCard>

      {/* PRIVACY */}
      <SectionLabel>PRIVACY</SectionLabel>
      <SettingsCard>
        <MenuRow icon="eye-off" iconColor="#30D158" title="Visibility & Comms" subtitle="Visible or Ghost · Comms Live · Nearby" onPress={() => go("/(app)/settings/privacy")} />
        <Divider />
        <MenuRow icon="location" iconColor="#FF453A" title="Location Services" onPress={() => go("/(app)/settings/location-services")} />
      </SettingsCard>

      {/* LOOK — the app's metal and the route line's colour */}
      <SectionLabel>LOOK</SectionLabel>
      <SettingsCard>
        {/* The Garage half of the subtitle is the skin-follows-pick rule: "Drive this today"
            writes the pick's metal (src/garageCars.ts afterMarkerWrite → setSkinChoice). */}
        <MenuRow icon="color-palette" iconColor="#E0A93E" title="App Skin" subtitle="The metal the app wears. Picking a car in the Garage sets it too." onPress={() => go("/(app)/settings/app-skin")} />
        <Divider />
        {/* Own icon: App Skin keeps 'color-palette'. */}
        <MenuRow icon="brush" iconColor="#BF5AF2" title="Route Color" swatch={routeColor} onPress={() => go("/(app)/settings/route-color")} />
      </SettingsCard>

      {/* HELP & LEGAL */}
      <SectionLabel>HELP &amp; LEGAL</SectionLabel>
      <SettingsCard>
        <MenuRow icon="chatbox-ellipses" iconColor="#0A84FF" title="Send Feedback" onPress={sendFeedback} />
        <Divider />
        <MenuRow icon="shield-checkmark" iconColor="#8E8E93" title="Safety Guidelines" onPress={() => go("/(app)/settings/safety")} />
        <Divider />
        <MenuRow icon="document-text" iconColor="#8E8E93" title="Privacy Policy" onPress={() => go("/(app)/settings/privacy-policy")} />
        <Divider />
        <MenuRow icon="reader" iconColor="#8E8E93" title="Terms of Service" onPress={() => go("/(app)/settings/terms")} />
        <Divider />
        {/* Visible to everyone on purpose — tester tools stay until the club launch (Jeff,
            2026-09-23: menu reorganization). */}
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
