import React from "react";
import { ImageBackground, View, StyleSheet, type ImageSourcePropType } from "react-native";
import { useAppSkin } from "../appSkin";
import type { VisualTier } from "../tierTheme";

/**
 * Full-screen wallpaper shown behind the app's dark pages (Comms, Garage, Hub,
 * Settings). Liquid Glass refracts whatever is behind it — over pure #000 there's
 * nothing to bend, so the glass surfaces render flat. This lays down the neon
 * grid/road wallpaper so the glass cards, pills, and mic actually pick up the
 * refraction, then a light scrim keeps content legible over the bright bits.
 *
 * ── THE WALLPAPER WEARS THE APP SKIN (Jeff, 2026-08-24/25) ───────────────────
 * "change the background wallpaper to have a gold line too" … "the comms page needs
 * to be silver and gold too including the wallpaper."
 *
 * DESIGN.md: a screen is ONE metal all the way through, so a green road under a gold
 * page is the one state that looks like a bug. The default source is therefore the
 * SKIN's road, and every signed-in page gets it by simply not passing `source`.
 *
 * The three are hue-rotations of the same artwork, not tints — `tintColor` flattens
 * every non-transparent pixel to a single colour and would destroy the image. Only
 * ~3.6% of the image is lit, so the rotation only ever touches the road and grid.
 *
 * Pass `source` ONLY to override deliberately:
 *   • app/(app)/garage.tsx pins it to the HERO CAROUSEL's tier, not the app skin, so
 *     the page previews the metal of whichever car you are looking at.
 *   • app/(auth)/login.tsx pins it to green — that screen is a brand lockup around the
 *     Hairpin wordmark PNG, which is itself green and cannot follow a skin.
 * The require() must live in the CALLER for a static override so Metro can bundle it.
 */
export const TIER_WALLPAPER: Record<VisualTier, ImageSourcePropType> = {
  brand:   require("../../assets/images/glass-bgt.png"),
  premium: require("../../assets/images/glass-bgt-silver.png"),
  ultra:   require("../../assets/images/glass-bgt-gold.png"),
};

export default function GlassBackdrop({
  scrim = 0.4,
  source,
}: {
  scrim?: number;
  source?: ImageSourcePropType;
}) {
  const tier = useAppSkin();
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <ImageBackground
        source={source ?? TIER_WALLPAPER[tier]}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
      >
        <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(3,8,7,${scrim})` }]} />
      </ImageBackground>
    </View>
  );
}
