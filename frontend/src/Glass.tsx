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
  // (dusk/night): NO tint — fully clear, which reads great over the dark map. (The
  // "diamond" was a glass-SHAPE bug, not the tint — see GlassFill's GlassView radius.)
  // Dawn/day/satellite: deepened 0.42 → 0.52 so the near-white HUD readouts
  // (speed, temp, ETA) stay legible against a bright basemap — testers couldn't
  // read the white font on the day map. Dusk/night unchanged (fully clear).
  return darkMap ? undefined : "rgba(18,18,22,0.52)";
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
  // frost = a MORE-BLURRED, less-refractive variant. iOS 26 uses the "regular"
  // frosted material instead of "clear"; older tiers get a stronger BlurView +
  // darker fill. Opt-in per surface (e.g. Settings section cards want the extra
  // blur for legibility) so the map HUD keeps the clean "clear" glass.
  frost?: boolean;
};

// Liquid-glass card. Real UIGlassEffect on iOS 26; BlurView on older iOS/Android;
// semi-transparent fallback on web.
export default function Glass({
  intensity = 50,
  tint = "dark",
  radius = 20,
  border = true,
  frost = false,
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
          { backgroundColor: frost ? "rgba(20,20,24,0.82)" : "rgba(28,28,30,0.72)" },
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
    // "clear" = the refractive material the user wants (edge-lensing that bends the
    // map through). The "diamond lines / unfinished edges" complaint is a separate
    // edge-treatment issue, NOT the material — kept clear per request.
    // frost → "regular" is the MORE-BLURRED frosted material (Settings cards).
    return (
      <GlassView
        glassEffectStyle={frost ? "regular" : "clear"}
        colorScheme="dark"
        style={[base, style]}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }

  if (Platform.OS === "android") {
    // ANDROID: expo-blur's BlurView does NOT blur here (that needs the opt-in
    // experimental renderer) — it just paints a translucent grey RECT. Stacked on
    // the container's own dark background it produced a lighter inner box that
    // didn't follow the rounded shape: the "two shades in every button" report
    // (Jeff, 2026-07-23, system-wide). One flat translucent layer instead — same
    // radius, one shade, and cheaper to composite.
    return (
      <View
        style={[base, { backgroundColor: frost ? "rgba(20,20,24,0.88)" : "rgba(26,26,30,0.78)" }, style]}
        {...rest}
      >
        {children}
      </View>
    );
  }

  return (
    <View style={[base, style]} {...rest}>
      <BlurView intensity={frost ? Math.min(100, intensity + 40) : intensity} tint={tint} style={StyleSheet.absoluteFill} />
      <View style={{ backgroundColor: frost ? "rgba(20,20,24,0.6)" : "rgba(28,28,30,0.45)", flex: 1 }}>{children}</View>
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
    // GlassContainer (iOS-26 GlassEffectContainer) renders the glass as a STABLE
    // grouped layer (no re-sample/flicker when the map tab reappears).
    // CRITICAL: the GlassView must carry the SAME borderRadius as its container. With
    // only absoluteFill the glass shape stays a sharp RECTANGLE that the round container
    // then CLIPS — so the material's edge-lensing is computed for square corners and
    // shows as diagonal "diamond" creases, and on a circle the straight rect edges get
    // sliced at top/bottom/left/right (the "cut-off" look). Passing `fill` (absoluteFill
    // + the caller's radius) shapes the ACTUAL glass round/circular, so the refraction
    // follows the rounded edge cleanly. pointerEvents none so taps fall through to the
    // button content on top.
    return (
      <GlassContainer style={fill} pointerEvents="none">
        <GlassView glassEffectStyle="clear" colorScheme="dark" tintColor={tintColor} style={fill} />
      </GlassContainer>
    );
  }
  if (Platform.OS === "android") {
    // Same Android two-shade fix as the Glass card above: BlurView adds no blur
    // here, only a mismatched grey rect. One flat wash, following the caller's
    // radius (carried in `fill`). tintColor callers (e.g. the red Exit) keep
    // their colour as the wash itself.
    return (
      <View
        style={[fill, { backgroundColor: tintColor ?? "rgba(26,26,30,0.45)" }]}
        pointerEvents="none"
      />
    );
  }
  return (
    <>
      <BlurView intensity={intensity} tint={tint} style={fill} />
      {tintColor ? <View style={[fill, { backgroundColor: tintColor, opacity: 0.55 }]} pointerEvents="none" /> : null}
    </>
  );
}
