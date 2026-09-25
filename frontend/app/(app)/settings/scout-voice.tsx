import React, { useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "../../../src/theme";
import { useSettings, getSpeedAlertMode, getNovaVoice } from "../../../src/settings";
import { NOVA_VOICES, previewNovaVoice, stopNovaPreview } from "../../../src/novaVoices";
import { playSpeedDing } from "../../../src/speedDing";
import { SettingsPage, SectionLabel, SettingsCard, ToggleRow, RadioRow, Divider, HelpText } from "../../../src/components/settingsKit";
import * as Haptics from "expo-haptics";

export default function ScoutVoicePage() {
  const [settings, setSettings] = useSettings();
  const novaVoiceSel = getNovaVoice(settings);
  // Stop any voice-preview sample if the user leaves this page mid-playback.
  useEffect(() => () => { void stopNovaPreview(); }, []);

  return (
    // Titled "Scout & Alerts" (was "Scout Voice") now that the road heads-ups live here too
    // (Jeff, 2026-09-23: menu reorganization). The route and file name are unchanged.
    <SettingsPage title="Scout & Alerts">
      <SectionLabel>VOICE</SectionLabel>
      <SettingsCard>
        <ToggleRow
          icon="volume-high" iconColor="#BF5AF2" title="Scout voice"
          subtitle="Master switch for all of Scout's voice"
          value={settings.novaVoice !== false}
          onChange={(v) => setSettings({ novaVoice: v })}
        />
        <Divider />
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
      </SettingsCard>

      <SectionLabel>SPOKEN EXTRAS</SectionLabel>
      <SettingsCard>
        <ToggleRow icon="chatbubbles" iconColor="#BF5AF2" title="Hands-free replies" subtitle="Answer Scout out loud — say “yes” / “no” to her prompts (e.g. a faster route) instead of tapping" value={settings.scoutHandsFree !== false} onChange={(v) => setSettings({ scoutHandsFree: v })} feature="comms_handsfree" />
        <Divider />
        <ToggleRow icon="car-sport" iconColor="#BF5AF2" title="Convoy alerts" subtitle="On a shared convoy route, Scout flags when the crew spreads out — plus a heads-up when a club member comes within 5 km" value={settings.convoyAlerts !== false} onChange={(v) => setSettings({ convoyAlerts: v })} />
        <Divider />
        <ToggleRow icon="bulb" iconColor="#BF5AF2" title="Departure IQ" subtitle="When you're parked at a saved place, offer a one-tap drive to where you usually head next" value={settings.departureIQ !== false} onChange={(v) => setSettings({ departureIQ: v })} />
        <Divider />
        <ToggleRow icon="sparkles" iconColor="#BF5AF2" title="Route greeting" subtitle="Scout's personable hello when you tap Start on a drive" value={settings.novaGreeting !== false} onChange={(v) => setSettings({ novaGreeting: v })} />
        <Divider />
        <ToggleRow icon="navigate-circle" iconColor="#0A84FF" title="Mid-drive callouts" subtitle="Proactive faster-route and hazard-ahead suggestions while navigating" value={settings.novaMidDrive !== false} onChange={(v) => setSettings({ novaMidDrive: v })} />
        <Divider />
        <ToggleRow icon="cafe" iconColor="#FF9F0A" title="Drive check-ins" subtitle="Every hour and a half on the road, Scout checks in — a fatigue check, a stretch, a joke, a word on the crew or the destination. A 15-minute stop resets the clock" value={settings.scoutCheckIns !== false} onChange={(v) => setSettings({ scoutCheckIns: v })} />
      </SettingsCard>

      {/* UNFILTERED SCOUT (Jeff, 2026-09-24: "can we switch on NSFW too"). Opt-in, OFF by default: the same
          Scout with the customer-service voice off — swears, roasts, adult humour. Language only: never
          sexual or explicit (App Store 1.1.4 bans that outright, no rating unlocks it), never a slur. It
          applies where Scout speaks as a PERSONALITY — voice replies, the route greeting, the arrival line,
          drive check-ins (src/settings.ts scoutEdgy); turn-by-turn, speed and road alerts stay clean.
          Store paperwork: the rating moves to 17+ (Apple) / Mature (Google) with this switch in the build. */}
      <SectionLabel>PERSONALITY</SectionLabel>
      <SettingsCard>
        <ToggleRow icon="flame" iconColor="#FF453A" title="Unfiltered Scout" subtitle="Adult humour and language (NSFW). Scout swears, roasts you and the crew, and keeps the jokes for grown-ups. Directions and alerts stay clean. Off = the family version" value={settings.scoutEdgy === true} onChange={(v) => setSettings({ scoutEdgy: v })} />
      </SettingsCard>

      <SectionLabel>SPEED ALERT</SectionLabel>
      <SettingsCard>
        <RadioRow icon="speedometer" iconColor="#FF453A" title="Scout" subtitle="Scout speaks up once when you're well over the limit (~21 over), once more if you push past ~41 — then stays quiet until you've been back near the limit for a bit" selected={getSpeedAlertMode(settings) === "nova"} onSelect={() => setSettings({ speedAlertMode: "nova", novaSpeeding: true })} />
        <Divider />
        <RadioRow icon="notifications" iconColor="#FF9F0A" title="Ding" subtitle="A chime instead of a voice: one ding when you go ~21 over, and again if you push past ~41 — once per speeding stretch, not on every wobble" selected={getSpeedAlertMode(settings) === "ding"} onSelect={() => setSettings({ speedAlertMode: "ding", novaSpeeding: false })} />
        {/* Preview the ding without having to go speed. ONE button — the Double sample was
            removed with the double ding itself (Jeff, 2026-09-12). */}
        <View style={styles.sampleRow}>
          <TouchableOpacity style={styles.sampleBtn} activeOpacity={0.8} testID="ding-sample" onPress={() => { Haptics.selectionAsync().catch(() => {}); void playSpeedDing(); }}>
            <Ionicons name="play-circle" size={18} color="#FF9F0A" />
            <Text style={styles.sampleBtnText}>Play sample</Text>
          </TouchableOpacity>
        </View>
        <Divider />
        <RadioRow icon="speedometer-outline" iconColor="#8E8E93" title="Off" subtitle="No speed warnings" selected={getSpeedAlertMode(settings) === "off"} onSelect={() => setSettings({ speedAlertMode: "off", novaSpeeding: false })} />
        <Divider />
        <ToggleRow icon="trending-up" iconColor="#FF9F0A" title="Adaptive alerts" subtitle="Learn your usual pace so the first nudge stops nagging at speeds you always drive (the firmer alert stays fixed)" value={settings.adaptiveSpeedAlerts !== false} onChange={(v) => setSettings({ adaptiveSpeedAlerts: v })} />
      </SettingsCard>

      {/* ROAD HEADS-UPS — moved here from Map Layers (Jeff, 2026-09-23: menu reorganization):
          their only reader, src/aheadAlerts.ts isOnFor(), gates what Scout speaks or dings, and
          nothing on the map. Same keys, same handlers, same copy as they had there.
          AHEAD-ALERTS (2026-09-21, Jeff: "Yes build them and stage 2 for 80. … Give the speed
          cameras and playground/school zones a good heads up for distance and time."). Same
          20-second lead as the speed cameras (Settings → Map Layers), same single speed-ding after
          the first time a kind comes up in a trip — see src/aheadAlerts.ts. The school subtitle
          hedges ("during the school year") for the same reason the spoken line says "when school's
          in" (src/aheadAlertRules.ts): there is no machine-readable BC school calendar, so the app
          must not claim the limit is in force. */}
      <SectionLabel>ROAD HEADS-UPS</SectionLabel>
      <SettingsCard>
        <ToggleRow icon="train" iconColor="#FFD60A" title="Railway crossings" subtitle="Scout calls out a level crossing ahead — spoken the first time each drive, a single ding after that" value={settings.alertRailway !== false} onChange={(v) => setSettings({ alertRailway: v })} />
        <Divider />
        <ToggleRow icon="school" iconColor="#FF9F0A" title="School zones" subtitle="Heads-up for a marked school zone ahead, weekdays 8am–5pm during the school year (OpenStreetMap)" value={settings.alertSchoolZones !== false} onChange={(v) => setSettings({ alertSchoolZones: v })} />
        <Divider />
        <ToggleRow icon="happy" iconColor="#30D158" title="Playground zones" subtitle="Heads-up for a playground zone ahead — 30 km/h dawn to dusk in BC, worked out on the phone from the sun" value={settings.alertPlaygroundZones !== false} onChange={(v) => setSettings({ alertPlaygroundZones: v })} />
      </SettingsCard>
      {/* Corrected 2026-08-26: the old copy said turn-by-turn "isn't affected" by the
          master switch — false, speak() gates every spoken line on it (nav.ts) — and it
          steered testers to the map mute as the only nav silencer. Say what each
          control actually does. */}
      {/* The last sentence points at the one heads-up not on this page: the speed-camera callout
          rides the Speed cameras switch in Map Layers (aheadAlerts.ts isOnFor: camera →
          settings.speedCameras), which also draws the camera pins (Jeff, 2026-09-23: menu
          reorganization). */}
      <HelpText>{`The Scout voice switch is the master: off silences everything Scout says, turn-by-turn directions included. The speaker button on the map mutes just the drive callouts and arrival announcements, and the Voice level lives in Settings → Audio. Speed-camera heads-ups follow the Speed cameras switch in Settings → Map Layers.`}</HelpText>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
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
  sampleRow: { flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingBottom: 12, marginTop: -2 },
  sampleBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: "rgba(255,159,10,0.14)", borderWidth: 1, borderColor: "rgba(255,159,10,0.35)" },
  sampleBtnText: { color: "#FF9F0A", fontSize: 13, fontWeight: "700" },
});
