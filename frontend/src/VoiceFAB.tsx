import React from "react";
import { TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { COLORS } from "./theme";
import { useVoice, VoiceResult } from "./useVoice";

export default function VoiceFAB({ onIntent }: { onIntent?: (intent: string | null, text?: string) => void }) {
  const { recording, busy, start, stop, transcribe } = useVoice();

  const onPressIn = async () => { await start(); };
  const onPressOut = async () => {
    const uri = await stop();
    if (!uri) return;
    const res: VoiceResult | null = await transcribe(uri);
    if (!res) return;
    if (res.text) Alert.alert("You said", `"${res.text}"${res.intent ? `\n\nAction: ${res.intent}` : ""}`);
    if (onIntent) onIntent(res.intent, res.text);
  };

  return (
    <TouchableOpacity
      testID="voice-fab"
      style={styles.fab}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      activeOpacity={0.8}
    >
      <LinearGradient
        colors={recording ? [COLORS.accent, "#3F3D9F"] : ["rgba(94,92,230,0.9)", "rgba(94,92,230,0.6)"]}
        style={StyleSheet.absoluteFill}
      />
      {busy ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <Ionicons name="mic" size={24} color="#fff" />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute", bottom: 110, left: 18, width: 56, height: 56, borderRadius: 28,
    overflow: "hidden", alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
  },
});
