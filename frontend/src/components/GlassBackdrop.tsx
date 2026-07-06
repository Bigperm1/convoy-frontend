import React from "react";
import { ImageBackground, View, StyleSheet, type ImageSourcePropType } from "react-native";

/**
 * Full-screen wallpaper shown behind the app's dark pages (Comms, Garage, Hub,
 * Settings). Liquid Glass refracts whatever is behind it — over pure #000 there's
 * nothing to bend, so the glass surfaces render flat. This lays down the neon
 * grid/road wallpaper so the glass cards, pills, and mic actually pick up the
 * refraction, then a light scrim keeps content legible over the bright bits.
 *
 * Default image: assets/images/glass-bg.png. Pass `source` to override per-page
 * (e.g. Comms/Settings/Garage use glass-bgt.png) — the require() must live in the
 * CALLER so Metro can bundle it statically.
 */
export default function GlassBackdrop({
  scrim = 0.4,
  source,
}: {
  scrim?: number;
  source?: ImageSourcePropType;
}) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <ImageBackground
        source={source ?? require("../../assets/images/glass-bg.png")}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
      >
        <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(3,8,7,${scrim})` }]} />
      </ImageBackground>
    </View>
  );
}
