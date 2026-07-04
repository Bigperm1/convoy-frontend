import React from "react";
import { ImageBackground, View, StyleSheet } from "react-native";

/**
 * Full-screen wallpaper shown behind the app's dark pages (Hub, Garage, Comms).
 *
 * Liquid Glass refracts whatever is behind it — over pure #000 there's nothing to
 * bend, so glass surfaces render invisible. This lays down a rich image (the teal
 * topo wallpaper) so the glass cards/controls on those pages actually read, then
 * a dark scrim on top keeps the UI legible and on-brand (dark-only).
 *
 * The image lives at assets/images/glass-bg.png — swap that one file to re-skin
 * every page at once.
 */
export default function GlassBackdrop({ scrim = 0.6 }: { scrim?: number }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <ImageBackground
        source={require("../../assets/images/glass-bg.png")}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
      >
        <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(4,10,9,${scrim})` }]} />
      </ImageBackground>
    </View>
  );
}
