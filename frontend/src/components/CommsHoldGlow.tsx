// CommsHoldGlow.tsx — soft, smoky green haze that breathes outward around the
// Comms mic while holding-to-talk to Claude.
//
// NO hard-edged rings: three translucent green circles, each looping scale-up +
// fade-out on a staggered phase (native driver), overlapping into a continuous
// green fog that pushes out in all directions. A `vis` master value fades the
// whole thing in on start and out on release. Absolutely centered in the tab
// cell, pointerEvents="none" so it never blocks the press.
import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View, Platform } from "react-native";

const GREEN = "#2DEC86";
const DURATION = 1500;

// Base 30px circle, innermost most opaque. They all scale to the same max, but
// the staggered phase + decreasing opacity reads as layered, breathing fog.
const BLOBS = [
  "rgba(45,236,134,0.22)",
  "rgba(45,236,134,0.15)",
  "rgba(45,236,134,0.10)",
];
const BASE = 30;

export default function CommsHoldGlow({ active }: { active: boolean }) {
  // One driver per blob (staggered so the fog never gaps) + a master fade.
  const anims = useRef(BLOBS.map(() => new Animated.Value(0))).current;
  const vis = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let loops: Animated.CompositeAnimation[] = [];
    if (active) {
      Animated.timing(vis, { toValue: 1, duration: 160, useNativeDriver: true }).start();
      anims.forEach((a) => a.setValue(0));
      loops = anims.map((a, i) =>
        Animated.loop(
          Animated.sequence([
            Animated.delay((DURATION / anims.length) * i),
            Animated.timing(a, {
              toValue: 1,
              duration: DURATION,
              easing: Easing.out(Easing.quad),
              useNativeDriver: true,
            }),
          ])
        )
      );
      loops.forEach((l) => l.start());
    } else {
      Animated.timing(vis, { toValue: 0, duration: 260, useNativeDriver: true }).start();
    }
    return () => loops.forEach((l) => l.stop());
  }, [active, anims, vis]);

  return (
    <View pointerEvents="none" style={styles.wrap}>
      {BLOBS.map((fill, i) => {
        const a = anims[i];
        const scale = a.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.8] });
        // Fade in quickly then out to nothing as it expands; gated by the master
        // `vis` so releasing the hold fades the whole haze smoothly.
        const opacity = Animated.multiply(
          vis,
          a.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 0] })
        );
        return (
          <Animated.View
            key={i}
            style={[styles.blob, { backgroundColor: fill, opacity, transform: [{ scale }] }]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Fills the tab cell and centers the blobs on the mic icon. Sits behind the
  // icon because CommsTabButton renders it before its children.
  wrap: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  blob: {
    position: "absolute",
    width: BASE,
    height: BASE,
    borderRadius: BASE / 2,
    // Soft green glow rim so there's no hard circular edge (iOS). Android leans
    // on the translucent stacked fills + scale for the same fog read.
    ...Platform.select({
      ios: { shadowColor: GREEN, shadowOpacity: 0.7, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
      default: {},
    }),
  },
});
