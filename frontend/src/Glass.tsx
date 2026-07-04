import React from "react";
import { View, StyleSheet, ViewProps, Platform } from "react-native";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { COLORS } from "./theme";

// iOS 26+ ships the real Liquid Glass material (UIGlassEffect). Everything below
// (and every screen that uses <Glass/>) gets it automatically there; iOS < 26 and
// Android fall back to the expo-blur frosted panel, web to a translucent surface.
const LIQUID_GLASS = isLiquidGlassAvailable();

type Props = ViewProps & {
  intensity?: number;
  tint?: "light" | "dark" | "default";
  radius?: number;
  border?: boolean;
};

// Liquid-glass card. Real UIGlassEffect on iOS 26; BlurView on older iOS/Android;
// semi-transparent fallback on web.
export default function Glass({
  intensity = 50,
  tint = "dark",
  radius = 20,
  border = true,
  style,
  children,
  ...rest
}: Props) {
  const base = {
    borderRadius: radius,
    overflow: "hidden" as const,
    borderWidth: border ? StyleSheet.hairlineWidth : 0,
    borderColor: COLORS.hairlineStrong,
  };

  if (Platform.OS === "web") {
    // BlurView on web is unreliable; emulate with translucent surface
    return (
      <View
        style={[
          base,
          { backgroundColor: "rgba(28,28,30,0.72)" },
          style,
        ]}
        {...rest}
      >
        {children}
      </View>
    );
  }

  if (LIQUID_GLASS) {
    // The glass material IS the background — children render on top. colorScheme
    // pinned dark (Convoy is a dark-only UI) so the glass never flips light.
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme="dark"
        style={[base, style]}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View style={[base, style]} {...rest}>
      <BlurView intensity={intensity} tint={tint} style={StyleSheet.absoluteFill} />
      <View style={{ backgroundColor: "rgba(28,28,30,0.45)", flex: 1 }}>{children}</View>
    </View>
  );
}

// Absolute-fill glass LAYER for surfaces that already manage their own rounded/
// clipped container (modals, sheets, toasts) and just want the material behind
// their content. Real iOS-26 Liquid Glass; BlurView fallback below; translucent
// surface on web. Drop-in replacement for a `<BlurView style={absoluteFill} />`.
export function GlassFill({
  intensity = 64,
  tint = "dark",
}: {
  intensity?: number;
  tint?: "light" | "dark" | "default";
}) {
  if (Platform.OS === "web") {
    return <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(28,28,30,0.72)" }]} />;
  }
  if (LIQUID_GLASS) {
    return <GlassView glassEffectStyle="regular" colorScheme="dark" style={StyleSheet.absoluteFill} />;
  }
  return <BlurView intensity={intensity} tint={tint} style={StyleSheet.absoluteFill} />;
}
