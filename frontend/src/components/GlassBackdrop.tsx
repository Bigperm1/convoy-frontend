import React from "react";
import { ImageBackground, View, StyleSheet } from "react-native";

/**
 * Full-screen wallpaper shown behind the app's dark pages (Comms, Garage, Hub,
 * Settings). Liquid Glass refracts whatever is behind it — over pure #000 there's
 * nothing to bend, so the glass surfaces render flat. This lays down the neon
 * grid/road wallpaper so the glass cards, pills, and mic actually pick up the
 * refraction, then a light scrim keeps content legible over the bright bits.
 *
 * The image lives at assets/images/glass-bg.png — swap that one file to re-skin
 * every page at once.
 */
export default function GlassBackdrop({ scrim = 0.4 }: { scrim?: number }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <ImageBackground
        source={require("../../assets/images/glass-bg.png")}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
      >
        <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(3,8,7,${scrim})` }]} />
      </ImageBackground>
    </View>
  );
}
