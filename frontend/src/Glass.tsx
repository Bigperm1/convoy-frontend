import React from "react";
import { View, StyleSheet, ViewProps, Platform } from "react-native";
import { BlurView } from "expo-blur";
import { GlassView, GlassContainer, isLiquidGlassAvailable } from "expo-glass-effect";
import { COLORS } from "./theme";
import { getMapMode, getSettings } from "./settings";

// iOS 26+ ships the real Liquid Glass material (UIGlassEffect). Everything below
// (and every screen that uses <Glass/>) gets it automatically there; iOS < 26 and
// Android fall back to the expo-blur frosted panel, web to a translucent surface.
const LIQUID_GLASS = isLiquidGlassAvailable();

// Theme-adaptive tint for the map/nav HUD glass (banner, speedo, weather, zoom,
// FABs, search bar, pills — phone AND CarPlay). iOS-26 "regular" glass adapts to
// the backdrop, so it needs help to stay readable AND translucent (like the route
// drawer / tab bar) on every basemap:
//   • dawn / day / satellite (LIGHT maps): a TRANSLUCENT dark wash — dark enough to
//     read, sheer enough that the map still shows through (never the opaque black a
//     solid hex gave). dawn + day share this.
//   • dusk / night (DARK maps): NO tint — the clear adaptive glass already reads as
//     dark frosted there. dusk + night share this.
// Called at render, so it re-resolves as the auto map mode advances with the clock.
// NOT used on the music player (which wants clean art-tinted glass).
export function hudTint(): string | undefined {
  const mode = getMapMode(getSettings());
  const darkMap = mode === "dusk" || mode === "night";
  // Light basemaps (dawn/day/satellite): a real-but-light dark wash so content
  // reads, while the CLEAR material still bends the map through. Dark basemaps
  // (dusk/night): NO tint — fully clear, which reads great over the dark map.
  return darkMap ? undefined : "rgba(18,18,22,0.42)";
}

// Slightly DARKER theme-adaptive tint for the big DRAWER surfaces (drive-preview
// sheet + nav step-drawer) so they read as the base layer beneath the lighter HUD
// items — but still fully CLEAR on dusk/night like everything else.
export function drawerTint(): string | undefined {
  const mode = getMapMode(getSettings());
  const darkMap = mode === "dusk" || mode === "night";
  return darkMap ? undefined : "rgba(16,16,20,0.55)";
}

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
        glassEffectStyle="clear"
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
  tintColor,
  style,
}: {
  intensity?: number;
  tint?: "light" | "dark" | "default";
  // Optional colour wash for the glass (e.g. red for a destructive Exit button).
  tintColor?: string;
  // Extra style (e.g. borderRadius + overflow) so callers with rounded corners can
  // clip the glass. Merged on top of absoluteFill.
  style?: any;
}) {
  const fill = [StyleSheet.absoluteFill, style];
  if (Platform.OS === "web") {
    return <View style={[fill, { backgroundColor: tintColor ?? "rgba(28,28,30,0.72)", opacity: tintColor ? 0.85 : 1 }]} />;
  }
  if (LIQUID_GLASS) {
    // Wrap the glass in a GlassContainer (iOS-26 GlassEffectContainer). It renders
    // the glass as a STABLE grouped layer — it no longer re-samples/flickers when
    // the map tab reappears — while the CLEAR material keeps the refractive edge-
    // lensing that bends the map behind it (the premium "rounded-3D-edge" look).
    // pointerEvents none so taps fall through to the button content on top.
    return (
      <GlassContainer style={fill} pointerEvents="none">
        <GlassView glassEffectStyle="clear" colorScheme="dark" tintColor={tintColor} style={StyleSheet.absoluteFill} />
      </GlassContainer>
    );
  }
  return (
    <>
      <BlurView intensity={intensity} tint={tint} style={fill} />
      {tintColor ? <View style={[fill, { backgroundColor: tintColor, opacity: 0.55 }]} pointerEvents="none" /> : null}
    </>
  );
}
