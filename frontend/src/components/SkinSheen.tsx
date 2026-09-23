// SkinSheen — the texture the DIAMOND skin lays over its gradient fill: facets and star glints (TRIAL, 2026-09-17: Jeff
// asked for diamond to look "a little more reflective like a diamond"). The classic metals carry no sheen.
import React from "react";
import { Image, StyleSheet, View } from "react-native";
import type { TierSkin } from "../tierTheme";

export default function SkinSheen({ sk, radius }: { sk: TierSkin; radius?: number }) {
  if (!sk.sheen) return null;
  // A non-interactive clip box, so the texture never eats a tap and follows the fill's corner radius.
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { overflow: "hidden", opacity: sk.sheenOpacity ?? 0.7 }, radius ? { borderRadius: radius } : null]}
    >
      <Image source={sk.sheen} resizeMode="cover" style={StyleSheet.absoluteFill} />
    </View>
  );
}
