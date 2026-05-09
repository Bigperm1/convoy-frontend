import React, { useEffect, useRef } from "react";
import { TouchableOpacity, View, StyleSheet, Animated, Easing, Platform, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useVoice } from "./useVoice";

// Elevated, oversized purple mic that lives in the middle of the tab bar.
// Press-and-hold records; release transcribes. Shows pulsing animation while recording.
// Pressing it does NOT navigate — it triggers voice activation. The "voice" route file is a no-op.
export default function VoiceTabButton() {
  const { recording, busy, start, stop, transcribe } = useVoice();
  const pulse = useRef(new Animated.Value(1)).current;
  const press = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (recording) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1.12, duration: 600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1.0, duration: 600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulse.setValue(1);
    }
  }, [recording, pulse]);

  const onPressIn = async () => {
    Animated.spring(press, { toValue: 0.92, useNativeDriver: true, speed: 30, bounciness: 6 }).start();
    await start();
  };
  const onPressOut = async () => {
    Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 8 }).start();
    const uri = await stop();
    if (!uri) return;
    await transcribe(uri); // result is broadcast on voiceBus → VoiceController shows banner & routes
  };

  return (
    <View style={styles.slot} pointerEvents="box-none">
      <Animated.View style={[styles.lift, { transform: [{ scale: pulse }, { scale: press }] }]} pointerEvents="box-none">
        <TouchableOpacity
          testID="voice-tab-cta"
          activeOpacity={0.85}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          style={styles.btn}
        >
          <LinearGradient
            colors={recording ? ["#FF3B30", "#A6201E"] : ["#7C7AED", "#5E5CE6"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          {/* glossy inner ring for depth */}
          <View style={styles.innerRing} />
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Ionicons name={recording ? "radio" : "mic"} size={30} color="#fff" />
          )}
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const SIZE = 64;
const styles = StyleSheet.create({
  // Match a tab cell (~76 wide). The actual button overflows upward to feel elevated.
  slot: { flex: 1, alignItems: "center", justifyContent: "flex-start" },
  // Pull the button upward so it visually sits ABOVE the tab bar
  lift: {
    width: SIZE, height: SIZE,
    marginTop: -22,
    borderRadius: SIZE / 2,
    ...Platform.select({
      ios: { shadowColor: "#5E5CE6", shadowOpacity: 0.55, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } },
      android: { elevation: 10 },
      web: { boxShadow: "0 6px 18px rgba(94,92,230,0.55)" } as any,
    }),
  },
  btn: {
    flex: 1, borderRadius: SIZE / 2, overflow: "hidden",
    alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: "rgba(255,255,255,0.22)",
  },
  innerRing: {
    position: "absolute", top: 4, left: 4, right: 4, bottom: 4,
    borderRadius: (SIZE - 8) / 2,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
  },
});
