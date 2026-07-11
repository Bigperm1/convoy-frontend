// Audio — TEMP tester-calibration screen. Testers play their music at a comfortable
// volume (the greyed "Music" row is a fixed 100% reference — iOS gives us no volume
// API for Apple Music/Spotify, so it's an anchor, not a control), then tune Voice /
// Dings / Comms / Transmission to sit right against it, screenshot, and we average
// the results into new defaults. Volumes persist to settings.vol* (0..1) and are
// read at each playback site via getAudioVol().
import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSettings, updateSettings, getAudioVol, getNovaVoice, AudioVolKey } from "../../../src/settings";
import { previewNovaVoice, stopNovaPreview } from "../../../src/novaVoices";
import { playSpeedDing } from "../../../src/speedDing";
import { SettingsPage, SectionLabel, SettingsCard, Divider, HelpText } from "../../../src/components/settingsKit";
import VolumeSlider from "../../../src/components/VolumeSlider";

function AudioRow({
  icon, color, title, subtitle, value, disabled, onChange, onComplete, onPreview,
}: {
  icon: any; color: string; title: string; subtitle: string; value: number;
  disabled?: boolean; onChange?: (v: number) => void; onComplete?: (v: number) => void; onPreview?: () => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <Ionicons name={icon} size={20} color={disabled ? "#8E8E93" : color} style={{ width: 24 }} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, disabled && styles.dim]}>{title}</Text>
          <Text style={styles.sub}>{subtitle}</Text>
        </View>
        <Text style={[styles.pct, disabled && styles.dim]}>{Math.round(value * 100)}%</Text>
        {onPreview ? (
          <TouchableOpacity onPress={onPreview} style={styles.preview} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="play" size={15} color={color} />
          </TouchableOpacity>
        ) : <View style={{ width: 30 }} />}
      </View>
      <VolumeSlider value={value} disabled={disabled} onChange={onChange} onComplete={onComplete} color={disabled ? "#8E8E93" : color} />
    </View>
  );
}

export default function AudioPage() {
  const [settings] = useSettings();
  // Live drag state (persists to settings on release). Seeded from saved volumes.
  const [voice, setVoice] = useState(getAudioVol(settings, "volVoice"));
  const [dings, setDings] = useState(getAudioVol(settings, "volDings"));
  const [comms, setComms] = useState(getAudioVol(settings, "volComms"));
  const [tx, setTx] = useState(getAudioVol(settings, "volTransmission"));

  useEffect(() => () => { void stopNovaPreview(); }, []);

  const persist = (key: AudioVolKey) => (v: number) => {
    updateSettings({ [key]: v });
    Haptics.selectionAsync();
  };

  return (
    <SettingsPage title="Audio">
      <HelpText>
        Play your music at a comfortable volume, then set each level so it sits right against it.
        Screenshot this screen when it feels good and send it over — we'll average everyone's and bake it in.
      </HelpText>

      <SectionLabel>OUTPUT LEVELS</SectionLabel>
      <SettingsCard>
        <AudioRow
          icon="musical-notes" color="#8E8E93" title="Music" subtitle="Your reference — set this in your music app"
          value={1} disabled
        />
        <Divider />
        <AudioRow
          icon="volume-high" color="#BF5AF2" title="Scout / Voice" subtitle="Scout, agentic replies & nav voice"
          value={voice} onChange={setVoice} onComplete={persist("volVoice")}
          onPreview={() => previewNovaVoice(getNovaVoice(settings))}
        />
        <Divider />
        <AudioRow
          icon="notifications" color="#FF9F0A" title="Alerts & Dings" subtitle="Speed alert & alert chimes"
          value={dings} onChange={setDings} onComplete={persist("volDings")}
          onPreview={() => playSpeedDing(false)}
        />
        <Divider />
        <AudioRow
          icon="radio" color="#0A84FF" title="Comms" subtitle="Live push-to-talk voice"
          value={comms} onChange={setComms} onComplete={persist("volComms")}
        />
        <Divider />
        <AudioRow
          icon="mic" color="#2DEC86" title="Transmission" subtitle="Replaying a saved transmission"
          value={tx} onChange={setTx} onComplete={persist("volTransmission")}
        />
      </SettingsCard>

      <HelpText>
        Music can only be set in your music app — iOS won't let us change its volume, so it's shown here as a fixed reference. Everything else is tuned relative to it.
      </HelpText>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingVertical: 12 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 },
  title: { color: "#F4F4F4", fontSize: 16, fontWeight: "600" },
  sub: { color: "#808080", fontSize: 12, marginTop: 1 },
  pct: { color: "#F4F4F4", fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"], minWidth: 42, textAlign: "right" },
  dim: { color: "#8E8E93" },
  preview: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
});
