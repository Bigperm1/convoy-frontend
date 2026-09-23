// showroom/CarArt.tsx — how each car looks on the Showroom stage (2026-09-22).
//
// ONE LIVE 3D VIEW AT A TIME. model-viewer in a WebView is the heavy thing on this screen (a full hero
// GLB is ~9 MB; GarageHeroCarousel used to mount it on every page at once, even while the arrow page
// showed). Here only the CENTRED car may go live; every other car is a still or a sprite:
//   arrow     the 2D green arrow, drawn flat (SVG, in the member's arrow paint) — the approved design
//   arrow3d   a render of the arrow GLB (assets/images/garage/arrow-3d.png, model-viewer headless,
//             2026-09-22), repainted with the class-sprite layering (black floor + tinted shading mask,
//             src/classLayers.tsx) so a painted arrow shows its paint here too. The GLB itself is bundled
//             only (ConvoyMapbox GREEN_ARROW_MODEL) — model-viewer cannot load it — so there is no live view.
//   class     the exact class sprite the map draws (ClassSprite), laid back onto the turntable
//   class3d   still: a render of GRC2.glb, the stock car's default bake (assets/images/garage/grc-3d.png);
//             live: the full GR Corolla bake for the chosen paint (getVehicleModelUrl — the map loads the
//             decimated twin of the same car)
//   scan      still: the scan's hero shot (car-scans/<id>/hero.jpg, taken by this Garage the first time
//             the car was live) — falls back to the stock still when a scan has none yet; live: its hero GLB

import React, { useState } from "react";
import { Image as RNImage, StyleSheet, View, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import Svg, { Path } from "react-native-svg";
import { ClassSprite } from "../../classLayers";
import { scanHeroImageSource } from "../../carScan";
import CarHero3D from "../../CarHero3D";

export const ARROW_3D = require("../../../assets/images/garage/arrow-3d.png");
const ARROW_3D_LAYERS = {
  bodyBlack: require("../../../assets/images/garage/arrow-3d_bodyblack.png"),
  bodyMask: require("../../../assets/images/garage/arrow-3d_bodymask.png"),
  rimBlack: require("../../../assets/images/garage/arrow-3d_rimblack.png"),
  rimMask: require("../../../assets/images/garage/arrow-3d_rimmask.png"),
};
export const GRC_3D = require("../../../assets/images/garage/grc-3d.png");
/** grc-3d.png is 479×251 — keep every box at that aspect or the car squashes. */
export const GRC_ASPECT = 251 / 479;
/** arrow-3d.png is 367×359. */
const ARROW_ASPECT = 359 / 367;

// The Hairpin arrow silhouette from the approved design (a 24-unit chevron).
const ARROW_PATH = "M12 2.5l7.6 18.2-7.6-3.9-7.6 3.9z";
const STOCK_BODY = "#2DEC86";
const STOCK_EDGE = "#0E9B58";

/** The 2D arrow, lying flat on the turntable. */
export function Arrow2D({ size, primary, secondary }: { size: number; primary?: string; secondary?: string }) {
  return (
    <View style={{ width: size, height: size, transform: [{ perspective: 500 }, { rotateX: "58deg" }] }}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path
          d={ARROW_PATH}
          fill={primary || STOCK_BODY}
          stroke={secondary || (primary ? "rgba(0,0,0,0.35)" : STOCK_EDGE)}
          strokeWidth={secondary ? 1 : 0.6}
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

/** The 3D arrow still, in the member's arrow paint. */
export function Arrow3D({ width, primary, secondary }: { width: number; primary?: string; secondary?: string }) {
  const box = { width, height: Math.round(width * ARROW_ASPECT) };
  const over = { position: "absolute" as const, top: 0, left: 0, ...box };
  return (
    <View style={box}>
      <RNImage source={ARROW_3D} style={box} resizeMode="contain" fadeDuration={0} />
      {primary ? (
        <>
          <RNImage source={ARROW_3D_LAYERS.bodyBlack} style={over} resizeMode="contain" fadeDuration={0} />
          <RNImage source={ARROW_3D_LAYERS.bodyMask} style={[over, { tintColor: primary }]} resizeMode="contain" fadeDuration={0} />
        </>
      ) : null}
      {secondary ? (
        <>
          <RNImage source={ARROW_3D_LAYERS.rimBlack} style={over} resizeMode="contain" fadeDuration={0} />
          <RNImage source={ARROW_3D_LAYERS.rimMask} style={[over, { tintColor: secondary }]} resizeMode="contain" fadeDuration={0} />
        </>
      ) : null}
    </View>
  );
}

/** The class car — the map's own sprite, nose away from you, laid back onto the turntable. */
export function ClassCar({ size, vehicleClass, primary, secondary }: {
  size: number; vehicleClass: string; primary?: string | null; secondary?: string | null;
}) {
  return (
    <View style={{ width: size, height: size, transform: [{ perspective: 600 }, { rotateX: "52deg" }] }}>
      <ClassSprite vehicleClass={vehicleClass} primary={primary} secondary={secondary} size={size} />
    </View>
  );
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
