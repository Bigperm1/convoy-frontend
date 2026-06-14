// CommsHoldGlow.tsx — large, diffuse green smoke that breathes outward around the
// Comms mic while holding-to-talk to Claude.
//
// NO readable rings: FIVE very translucent green circles of slightly different
// sizes, each looping a big scale-up + fade-out on a staggered phase (native
// driver). Low opacity + a wide spread means they overlap into one soft green
// cloud rather than distinct waves. A `vis` master value fades the whole haze in
// on start and out on release. Absolutely centered in the tab cell,
// pointerEvents="none" so it never blocks the press.
import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View, Platform } from "react-native";

const GREEN = "#2DEC86";
const DURATION = 1800;

// Varied sizes + translucent fills blend into a diffuse cloud (no hard rings).
// Brighter than before, plus one tight high-opacity near-core blob for a vivid
// center while the rest spread wide (scale to 5.5).
const BLOBS = [
  { size: 26, fill: "rgba(45,236,134,0.28)", maxScale: 2.6 }, // bright tight near-core
  { size: 34, fill: "rgba(45,236,134,0.20)", maxScale: 5.5 },
  { size: 30, fill: "rgba(45,236,134,0.17)", maxScale: 5.5 },
  { size: 38, fill: "rgba(45,236,134,0.13)", maxScale: 5.5 },
  { size: 32, fill: "rgba(45,236,134,0.11)", maxScale: 5.5 },
  { size: 36, fill: "rgba(45,236,134,0.08)", maxScale: 5.5 },
];

export default function CommsHoldGlow({ active }: { active: boolean }) {
  const anims = useRef(BLOBS.map(() => new Animated.Value(0))).current;
  const vis = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let loops: Animated.CompositeAnimation[] = [];
    if (active) {
      Animated.timing(vis, { toValue: 1, duration: 180, useNativeDriver: true }).start();
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
      Animated.timing(vis, { toValue: 0, duration: 300, useNativeDriver: true }).start();
    }
    return () => loops.forEach((l) => l.stop());
  }, [active, anims, vis]);

  return (
    <View pointerEvents="none" style={styles.wrap}>
      {BLOBS.map((b, i) => {
        const a = anims[i];
        const scale = a.interpolate({ inputRange: [0, 1], outputRange: [0.5, b.maxScale] });
        // Fade in fast then out to nothing across the expansion; gated by `vis`
        // so releasing the hold dissolves the whole cloud smoothly.
        const opacity = Animated.multiply(
          vis,
          a.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 1, 0] })
        );
        return (
          <Animated.View
            key={i}
            style={[
              styles.blob,
              {
                width: b.size,
                height: b.size,
                borderRadius: b.size / 2,
                backgroundColor: b.fill,
                opacity,
                transform: [{ scale }],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Fills the tab cell and centers the cloud on the mic icon. Sits behind the
  // icon because CommsTabButton renders it before its children.
  wrap: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  blob: {
    position: "absolute",
    // Soft green glow rim so edges stay diffuse (iOS). Android leans on the very
    // low-opacity stacked fills + wide scale for the same smoke read.
    ...Platform.select({
      ios: { shadowColor: GREEN, shadowOpacity: 0.6, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } },
      default: {},
    }),
  },
});
