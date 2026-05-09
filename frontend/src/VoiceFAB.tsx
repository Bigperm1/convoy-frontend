import React, { useEffect, useRef } from "react";
import { TouchableOpacity, StyleSheet, ActivityIndicator, Animated, Easing, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { COLORS } from "./theme";
import { useVoice, VoiceResult } from "./useVoice";

type Props = {
  onIntent?: (intent: string | null, text?: string) => void;
  bottom?: number;
  left?: number;
  right?: number;
};

export default function VoiceFAB({ onIntent, bottom = 110, left = 18, right }: Props) {
  const { recording, busy, start, stop, transcribe } = useVoice();
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (recording) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1.18, duration: 600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1.0, duration: 600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulse.setValue(1);
    }
  }, [recording, pulse]);

  const onPressIn = async () => { await start(); };
  const onPressOut = async () => {
    const uri = await stop();
    if (!uri) return;
    const res: VoiceResult | null = await transcribe(uri);
    if (!res) return;
    if (onIntent) onIntent(res.intent, res.text);
  };

  const positionStyle = right != null ? { right, bottom } : { left, bottom };

  return (
    <Animated.View style={[styles.wrap, positionStyle, { transform: [{ scale: pulse }] }]} pointerEvents="box-none">
      <TouchableOpacity
        testID="voice-fab"
        style={styles.fab}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        activeOpacity={0.8}
      >
        <LinearGradient
          colors={recording ? ["#FF3B30", "#A6201E"] : ["rgba(94,92,230,0.95)", "rgba(94,92,230,0.65)"]}
          style={StyleSheet.absoluteFill}
        />
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Ionicons name={recording ? "radio" : "mic"} size={24} color="#fff" />
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", width: 56, height: 56 },
  fab: {
    flex: 1, borderRadius: 28,
    overflow: "hidden", alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.20)",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
      android: { elevation: 6 },
    }),
  },
});
