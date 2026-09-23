// showroom/CarArt.tsx — how each car looks on the Showroom stage (2026-09-22).
//
// ONE LIVE 3D VIEW AT A TIME. model-viewer in a WebView is the heavy thing on this screen (a full hero
// GLB is ~9 MB; GarageHeroCarousel used to mount it on every page at once, even while the arrow page
// showed). Here only the CENTRED car may go live; every other car is a still or a sprite:
//   arrow     the 2D arrow: the map's own arrow GLB rendered straight down, so it is exactly what the
//             2D map draws — green body, white rim outline (Jeff, 2026-09-22: "top view 2d with a white
//             outline")
//   arrow3d   the same GLB from the chase cam — behind and above at the map's 48° pitch
//             (chasePitch.ts), nose away from you (Jeff: "the 3d arrow so its chase cam view")
//   class     the class car in the member's class paint: the map's own top-down class sprite (ClassSprite),
//             FLAT and straight down like the 2D arrow — Silver's car is a 2D-map car (Jeff, 2026-09-22:
//             "the … class car need to be 2D top down version and in 2nd slot (silver)"; the 3/4 renders
//             tried an hour earlier came from a mix-up he corrected, and are gone)
//   class3d   still: a render of GRC2.glb, the stock car's default bake (assets/images/garage/grc-3d.png);
//             live: the full GR Corolla bake for the chosen paint (getVehicleModelUrl — the map loads the
//             decimated twin of the same car)
//   scan      still: the scan's hero shot (car-scans/<id>/hero.jpg, taken by this Garage the first time
//             the car was live) — falls back to the stock still when a scan has none yet; live: its hero GLB
//
// Every rendered still carries the class-sprite paint layers (src/classLayers.tsx): a black floor with
// alpha = the band, then a white mask with alpha = band x shading, tinted at runtime — so any paint hex
// works with no per-colour bake. The arrow's bands are body (primary) and rim (secondary).
// Renders: model-viewer 4.0 headless on magenta, keyed — regenerate with tools/garage-stills/render.sh.

import React, { useState } from "react";
import { Image as RNImage, StyleSheet, View, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import { ClassSprite } from "../../classLayers";
import { scanHeroImageSource } from "../../carScan";
import CarHero3D from "../../CarHero3D";

type Layers = { black: number; mask: number };
type Still = { base: number; aspect: number; pri?: Layers; sec?: Layers };

const ARROW_2D: Still = {
  base: require("../../../assets/images/garage/garage-arrow-2d.png"),
  aspect: 473 / 540,
  pri: { black: require("../../../assets/images/garage/garage-arrow-2d_bodyblack.png"), mask: require("../../../assets/images/garage/garage-arrow-2d_bodymask.png") },
  sec: { black: require("../../../assets/images/garage/garage-arrow-2d_rimblack.png"), mask: require("../../../assets/images/garage/garage-arrow-2d_rimmask.png") },
};
const ARROW_3D: Still = {
  base: require("../../../assets/images/garage/garage-arrow-3d.png"),
  aspect: 344 / 540,
  pri: { black: require("../../../assets/images/garage/garage-arrow-3d_bodyblack.png"), mask: require("../../../assets/images/garage/garage-arrow-3d_bodymask.png") },
  sec: { black: require("../../../assets/images/garage/garage-arrow-3d_rimblack.png"), mask: require("../../../assets/images/garage/garage-arrow-3d_rimmask.png") },
};
export const GRC_3D = require("../../../assets/images/garage/grc-3d.png");
/** grc-3d.png is 479×251 — keep every box at that aspect or the car squashes. */
export const GRC_ASPECT = 251 / 479;

/** Height a still takes at `width`, so the stage can size its box. */
export const stillHeight = (still: "arrow" | "arrow3d", width: number) =>
  Math.round(width * (still === "arrow" ? ARROW_2D : ARROW_3D).aspect);

/** A rendered still with its paint layers: photo → [black + tinted mask] per painted band. */
function PaintedStill({ still, width, primary, secondary }: {
  still: Still; width: number; primary?: string | null; secondary?: string | null;
}) {
  const box = { width, height: Math.round(width * still.aspect) };
  const over = { position: "absolute" as const, top: 0, left: 0, ...box };
  const band = (l: Layers | undefined, tint: string | null | undefined) =>
    l && tint ? (
      <>
        <RNImage source={l.black} style={over} resizeMode="contain" fadeDuration={0} />
        <RNImage source={l.mask} style={[over, { tintColor: tint }]} resizeMode="contain" fadeDuration={0} />
      </>
    ) : null;
  return (
    <View style={box}>
      <RNImage source={still.base} style={box} resizeMode="contain" fadeDuration={0} />
      {band(still.pri, primary)}
      {band(still.sec, secondary)}
    </View>
  );
}

/** The 2D arrow, straight down — the 2D map's own arrow, in the member's arrow paint. */
export function Arrow2D({ width, primary, secondary }: { width: number; primary?: string; secondary?: string }) {
  return <PaintedStill still={ARROW_2D} width={width} primary={primary} secondary={secondary} />;
}

/** The 3D arrow from the chase cam, in the member's arrow paint. */
export function Arrow3D({ width, primary, secondary }: { width: number; primary?: string; secondary?: string }) {
  return <PaintedStill still={ARROW_3D} width={width} primary={primary} secondary={secondary} />;
}

/** The class car in its class paint — the map's own top-down sprite, flat, nose up (the car fills ~95% of
 *  the square's height and ~45% of its width). */
export function ClassCar({ size, vehicleClass, primary, secondary }: {
  size: number; vehicleClass: string; primary?: string | null; secondary?: string | null;
}) {
  return <ClassSprite vehicleClass={vehicleClass} primary={primary} secondary={secondary} size={size} />;
}

/** The stock 3D car still. `silhouette` = the locked "your own car" teaser (no paint, just the shape). */
export function Car3DStill({ width, silhouette }: { width: number; silhouette?: boolean }) {
  const box = { width, height: Math.round(width * GRC_ASPECT) };
  return (
    <RNImage
      source={GRC_3D}
      style={[box, silhouette ? { tintColor: "#2A2F35" } : null]}
      resizeMode="contain"
      fadeDuration={0}
    />
  );
}

/** A scan's hero shot, or the stock still when the scan has none yet (only a car that was once live in
 *  this Garage has one — the snapshot is taken here). */
export function ScanStill({ scanId, width }: { scanId: string; width: number }) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : scanHeroImageSource(scanId);
  if (!src) return <Car3DStill width={width} />;
  // The hero shot is a JPEG — its background is baked in and never matches the stage, so it is framed
  // as a photo card on purpose rather than left as a hard-edged box (sim render, 2026-09-22).
  return (
    <View style={[styles.photo, { width, height: Math.round(width * 0.62) }]}>
      <Image
        source={src}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        cachePolicy="disk"
        transition={180}
        onError={() => setFailed(true)}
      />
    </View>
  );
}

/** The one live 3D view: a transparent model-viewer, with `still` shown underneath until the model is
 *  actually on screen (a failed load simply leaves the still). Never interactive — it sits under the
 *  stage's swipe layer; the full-screen spin is CarViewer3D (the "360° spin" action). */
export function LiveCar({ glbUrl, still, style, onSnapshot }: {
  glbUrl: string;
  still: React.ReactNode;
  style?: ViewStyle;
  onSnapshot?: (jpegDataUri: string) => void;
}) {
  const [ready, setReady] = useState(false);
  return (
    <View style={[styles.live, style]} pointerEvents="none">
      {!ready ? <View style={styles.center}>{still}</View> : null}
      <CarHero3D
        key={glbUrl}
        glbUrl={glbUrl}
        interactive={false}
        transparent
        onReady={() => setReady(true)}
        onSnapshot={onSnapshot}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  photo: {
    borderRadius: 22,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "#000",
  },
  live: { alignItems: "center", justifyContent: "center" },
  center: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
});
