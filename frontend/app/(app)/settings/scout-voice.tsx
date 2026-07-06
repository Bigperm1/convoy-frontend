import React, { useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "../../../src/theme";
import { useSettings, getSpeedAlertMode, getNovaVoice } from "../../../src/settings";
import { NOVA_VOICES, previewNovaVoice, stopNovaPreview } from "../../../src/novaVoices";
import { SettingsPage, SectionLabel, SettingsCard, ToggleRow, RadioRow, Divider, HelpText } from "../../../src/components/settingsKit";

export default function ScoutVoicePage() {
  const [settings, setSettings] = useSettings();
  const novaVoiceSel = getNovaVoice(settings);
  // Stop any voice-preview sample if the user leaves this page mid-playback.
  useEffect(() => () => { void stopNovaPreview(); }, []);

  return (
    <SettingsPage title="Scout Voice">
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
        <ToggleRow icon="chatbubbles" iconColor="#BF5AF2" title="Hands-free replies" subtitle="Answer Scout out loud — say “yes” / “no” to her prompts (e.g. a faster route) instead of tapping" value={settings.scoutHandsFree !== false} onChange={(v) => setSettings({ scoutHandsFree: v })} />
        <Divider />
        <ToggleRow icon="car-sport" iconColor="#BF5AF2" title="Convoy alerts" subtitle="Scout speaks up when the crew spreads out and someone falls behind" value={settings.convoyAlerts !== false} onChange={(v) => setSettings({ convoyAlerts: v })} />
        <Divider />
        <ToggleRow icon="bulb" iconColor="#BF5AF2" title="Departure IQ" subtitle="When you're parked at a saved place, offer a one-tap drive to where you usually head next" value={settings.departureIQ !== false} onChange={(v) => setSettings({ departureIQ: v })} />
        <Divider />
        <ToggleRow icon="sparkles" iconColor="#BF5AF2" title="Route greeting" subtitle="Scout's personable hello when you tap Start on a drive" value={settings.novaGreeting !== false} onChange={(v) => setSettings({ novaGreeting: v })} />
        <Divider />
        <ToggleRow icon="navigate-circle" iconColor="#0A84FF" title="Mid-drive callouts" subtitle="Proactive faster-route and hazard-ahead suggestions while navigating" value={settings.novaMidDrive !== false} onChange={(v) => setSettings({ novaMidDrive: v })} />
      </SettingsCard>

      <SectionLabel>SPEED ALERT</SectionLabel>
      <SettingsCard>
        <RadioRow icon="speedometer" iconColor="#FF453A" title="Scout" subtitle="Scout speaks up when you're well over the limit (~21 over), firmer at ~41 over" selected={getSpeedAlertMode(settings) === "nova"} onSelect={() => setSettings({ speedAlertMode: "nova", novaSpeeding: true })} />
        <Divider />
        <RadioRow icon="notifications" iconColor="#FF9F0A" title="Ding" subtitle="A chime instead of a voice: one ding ~21 over, a double ding ~41 over" selected={getSpeedAlertMode(settings) === "ding"} onSelect={() => setSettings({ speedAlertMode: "ding", novaSpeeding: false })} />
        <Divider />
        <RadioRow icon="speedometer-outline" iconColor="#8E8E93" title="Off" subtitle="No speed warnings" selected={getSpeedAlertMode(settings) === "off"} onSelect={() => setSettings({ speedAlertMode: "off", novaSpeeding: false })} />
        <Divider />
        <ToggleRow icon="trending-up" iconColor="#FF9F0A" title="Adaptive alerts" subtitle="Learn your usual pace so the first nudge stops nagging at speeds you always drive (the firmer alert stays fixed)" value={settings.adaptiveSpeedAlerts !== false} onChange={(v) => setSettings({ adaptiveSpeedAlerts: v })} />
      </SettingsCard>
      <HelpText>{`These control Scout's extra spoken touches. Turn-by-turn directions aren't affected — silence those with the mute button on the map.`}</HelpText>
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
});
