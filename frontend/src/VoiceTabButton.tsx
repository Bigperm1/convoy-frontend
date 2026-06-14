import React, { useEffect, useRef } from "react";
import { TouchableOpacity, View, StyleSheet, Animated, Easing, Platform, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useVoice } from "./useVoice";

// Elevated, oversized brand-yellow mic that lives in the middle of the tab bar.
// Press-and-hold records; release transcribes. Pulses bigger while recording.
// Pressing it does NOT navigate â it triggers voice activation. The "voice" route file is a no-op.

const SIZE = 72;          // a bit bigger so the icon never crops on the curve
const ICON_SIZE = 30;     // glyph stays centered, well clear of the rounded edge

// Convoy logo yellow â warm amber gradient. Switches to red while transmitting.
const IDLE_COLORS = ["#7DF0B0", "#2DEC86", "#00C46A"];
const REC_COLORS = ["#FF6B35", "#FF3B30", "#A6201E"];

export default function VoiceTabButton() {
  const { recording, busy, start, stop, transcribe } = useVoice();
  const pulse = useRef(new Animated.Value(1)).current;
  const press = useRef(new Animated.Value(1)).current;
  // Halo ring that ripples outward while recording (extra "I'm listening" cue).
  const halo = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (recording) {
      // Big breath â grows ~30% bigger so the user feels the press "land".
      const breath = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1.30, duration: 480, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1.10, duration: 480, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        ])
      );
      const ripple = Animated.loop(
        Animated.sequence([
          Animated.timing(halo, { toValue: 1, duration: 1200, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          Animated.timing(halo, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      );
      breath.start();
      ripple.start();
      return () => { breath.stop(); ripple.stop(); };
    } else {
      pulse.setValue(1);
      halo.setValue(0);
    }
  }, [recording, pulse, halo]);

  const onPressIn = async () => {
    Animated.spring(press, { toValue: 0.92, useNativeDriver: true, speed: 30, bounciness: 6 }).start();
    await start();
  };
  const onPressOut = async () => {
    Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 8 }).start();
    const uri = await stop();
    if (!uri) return;
    await transcribe(uri); // result is broadcast on voiceBus â VoiceController shows banner & routes
  };

  return (
    <View style={styles.slot} pointerEvents="box-none">
      {/* Outward-rippling halo ring while recording */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.halo,
          {
            opacity: halo.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
            transform: [{ scale: halo.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.85] }) }],
          },
        ]}
      />
      <Animated.View style={[styles.lift, { transform: [{ scale: pulse }, { scale: press }] }]} pointerEvents="box-none">
        <TouchableOpacity
          testID="voice-tab-cta"
          activeOpacity={0.85}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          style={styles.btn}
        >
          <LinearGradient
            colors={(recording ? REC_COLORS : IDLE_COLORS) as [string, string, ...string[]]}
            start={{ x: 0.2, y: 0 }}
            end={{ x: 0.8, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          {/* glossy inner ring for depth */}
          <View style={styles.innerRing} />
          {busy ? (
            <ActivityIndicator color="#1a1a1a" />
          ) : (
            <Ionicons
              name={recording ? "radio" : "mic"}
              size={ICON_SIZE}
              // Dark glyph on the bright yellow for high contrast & legibility.
              color={recording ? "#fff" : "#1a1a1a"}
            />
          )}
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Match a tab cell (~76 wide). The actual button overflows upward to feel elevated.
  slot: { flex: 1, alignItems: "center", justifyContent: "flex-start" },
  // Pull the button upward so it visually sits ABOVE the tab bar
  lift: {
    width: SIZE, height: SIZE,
    marginTop: -28,
    borderRadius: SIZE / 2,
    ...Platform.select({
      ios: { shadowColor: "#00C46A", shadowOpacity: 0.7, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
      android: { elevation: 12 },
      web: { boxShadow: "0 8px 22px rgba(0,196,106,0.65)" } as any,
    }),
  },
  btn: {
    flex: 1, borderRadius: SIZE / 2, overflow: "hidden",
    alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: "rgba(255,255,255,0.45)",
  },
  innerRing: {
    position: "absolute", top: 5, left: 5, right: 5, bottom: 5,
    borderRadius: (SIZE - 10) / 2,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.30)",
  },
  // Halo: positioned behind the button, pulses outward while recording.
  halo: {
    position: "absolute",
    top: -28, alignSelf: "center",
    width: SIZE, height: SIZE, borderRadius: SIZE / 2,
    backgroundColor: "transparent",
    borderWidth: 2,
    borderColor: "rgba(0,196,106,0.85)",
  },
});
