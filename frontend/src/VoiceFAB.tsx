import React from "react";
import { TouchableOpacity, View, Text, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
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
      style={[styles.fab, recording && styles.fabActive]}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      activeOpacity={0.7}
    >
      {busy ? (
        <ActivityIndicator color="#000" />
      ) : (
        <Ionicons name="mic" size={26} color={recording ? "#000" : COLORS.secondary} />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute", bottom: 100, left: 18, width: 60, height: 60, borderRadius: 30,
    backgroundColor: COLORS.surface, borderWidth: 2, borderColor: COLORS.secondary,
    alignItems: "center", justifyContent: "center",
    shadowColor: COLORS.secondary, shadowOpacity: 0.5, shadowRadius: 12, elevation: 6,
  },
  fabActive: { backgroundColor: COLORS.secondary },
});
