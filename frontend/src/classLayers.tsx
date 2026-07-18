// classLayers.tsx — runtime PRIMARY/SECONDARY paint for the top-down class
// sprites (replaces the pre-baked tint table, 2026-07-17).
//
// Each class ships 4 baked LAYERS next to its photo:
//   priblack/primask — the PRIMARY paint band (boat: the mid-grey swim-platform
//                      /hull accents; cars: the bright body panels)
//   secblack/secmask — the SECONDARY band (boat: the white deck; cars: the
//                      darker trim zone)
// Compose order: photo → [priblack + primask tinted] → [secblack + secmask
// tinted]. The "black" layer floors the band so the tint reads opaque over the
// map; the "mask" is white with alpha = shading × band-mix, so RN's tintColor
// (a flat recolor that PRESERVES alpha) renders proper shaded paint. An unset
// slot simply skips its layers — the original photo shows through — so any hex
// works live and no variant baking is needed.
import React from "react";
import { View, Image, StyleSheet } from "react-native";
import { CLASS_TOPDOWN } from "./vehicleAssets";

const L = (p: any) => p as any;
export const CLASS_LAYERS: Record<string, { priBlack: any; priMask: any; secBlack: any; secMask: any }> = {
  hatchback: { priBlack: L(require("../assets/images/classes-v2/hatchback_priblack.png")), priMask: L(require("../assets/images/classes-v2/hatchback_primask.png")), secBlack: L(require("../assets/images/classes-v2/hatchback_secblack.png")), secMask: L(require("../assets/images/classes-v2/hatchback_secmask.png")) },
  muscle: { priBlack: L(require("../assets/images/classes-v2/muscle_priblack.png")), priMask: L(require("../assets/images/classes-v2/muscle_primask.png")), secBlack: L(require("../assets/images/classes-v2/muscle_secblack.png")), secMask: L(require("../assets/images/classes-v2/muscle_secmask.png")) },
  supercar: { priBlack: L(require("../assets/images/classes-v2/supercar_priblack.png")), priMask: L(require("../assets/images/classes-v2/supercar_primask.png")), secBlack: L(require("../assets/images/classes-v2/supercar_secblack.png")), secMask: L(require("../assets/images/classes-v2/supercar_secmask.png")) },
  exotic: { priBlack: L(require("../assets/images/classes-v2/exotic_priblack.png")), priMask: L(require("../assets/images/classes-v2/exotic_primask.png")), secBlack: L(require("../assets/images/classes-v2/exotic_secblack.png")), secMask: L(require("../assets/images/classes-v2/exotic_secmask.png")) },
  electric: { priBlack: L(require("../assets/images/classes-v2/electric_priblack.png")), priMask: L(require("../assets/images/classes-v2/electric_primask.png")), secBlack: L(require("../assets/images/classes-v2/electric_secblack.png")), secMask: L(require("../assets/images/classes-v2/electric_secmask.png")) },
  truck:  { priBlack: L(require("../assets/images/classes-v2/truck_priblack.png")),  priMask: L(require("../assets/images/classes-v2/truck_primask.png")),  secBlack: L(require("../assets/images/classes-v2/truck_secblack.png")),  secMask: L(require("../assets/images/classes-v2/truck_secmask.png")) },
  atv:    { priBlack: L(require("../assets/images/classes-v2/atv_priblack.png")),    priMask: L(require("../assets/images/classes-v2/atv_primask.png")),    secBlack: L(require("../assets/images/classes-v2/atv_secblack.png")),    secMask: L(require("../assets/images/classes-v2/atv_secmask.png")) },
  sxs:    { priBlack: L(require("../assets/images/classes-v2/sxs_priblack.png")),    priMask: L(require("../assets/images/classes-v2/sxs_primask.png")),    secBlack: L(require("../assets/images/classes-v2/sxs_secblack.png")),    secMask: L(require("../assets/images/classes-v2/sxs_secmask.png")) },
  boat:   { priBlack: L(require("../assets/images/classes-v2/boat_priblack.png")),   priMask: L(require("../assets/images/classes-v2/boat_primask.png")),   secBlack: L(require("../assets/images/classes-v2/boat_secblack.png")),   secMask: L(require("../assets/images/classes-v2/boat_secmask.png")) },
  motorcycle: { priBlack: L(require("../assets/images/classes-v2/motorcycle_priblack.png")), priMask: L(require("../assets/images/classes-v2/motorcycle_primask.png")), secBlack: L(require("../assets/images/classes-v2/motorcycle_secblack.png")), secMask: L(require("../assets/images/classes-v2/motorcycle_secmask.png")) },
  sedan:  { priBlack: L(require("../assets/images/classes-v2/sedan_priblack.png")),  priMask: L(require("../assets/images/classes-v2/sedan_primask.png")),  secBlack: L(require("../assets/images/classes-v2/sedan_secblack.png")),  secMask: L(require("../assets/images/classes-v2/sedan_secmask.png")) },
};

// The 20-swatch palette (Jeff 2026-07-17), ordered as a hue ramp.
export const PAINT_COLORS = [
  "#2DEC86", // Hairpin green
  "#14532D", // dark green
  "#0D9488", // teal
  "#5AC8FA", // sky blue
  "#0A84FF", // blue
  "#1D3557", // dark blue
  "#BF5CFF", // purple
  "#FF2D95", // pink
  "#D2042D", // candy red
  "#FF3B30", // red
  "#5C4033", // dark brown
  "#D2B48C", // tan
  "#FF9500", // orange
  "#FFD60A", // yellow
  "#D4AF37", // gold
  "#F5F2E9", // off white
  "#FFFFFF", // white
  "#C0C4C9", // silver
  "#3A3F45", // gunmetal
  "#0B0B0C", // black
];

// The stacked sprite. size = square pt box (images use contain, same aspect).
// onReady fires ONCE when every rendered layer has loaded its bitmap — the map
// registration uses it to re-capture the MBXImage snapshot (which otherwise
// races image loading and can freeze an unpainted frame: the "boat color not
// saving onto the map" bug).
export function ClassSprite({ vehicleClass, primary, secondary, size = 66, onReady }: {
  vehicleClass: string;
  primary?: string | null;
  secondary?: string | null;
  size?: number;
  onReady?: () => void;
}) {
  const photo = CLASS_TOPDOWN[vehicleClass];
  const layers = CLASS_LAYERS[vehicleClass];
  const total = 1 + (layers && primary ? 2 : 0) + (layers && secondary ? 2 : 0);
  const loadedRef = React.useRef(0);
  const firedRef = React.useRef(false);
  const onLoad = () => {
    loadedRef.current += 1;
    if (!firedRef.current && loadedRef.current >= total) {
      firedRef.current = true;
      onReady?.();
    }
  };
  if (!photo) return null;
  const img = { ...StyleSheet.absoluteFillObject, width: size, height: size } as const;
  return (
    // collapsable={false}: Fabric view-flattening otherwise removes this wrapper
    // when the sprite is the child of the map's MBXImage — the native snapshot
    // then receives the 5 layer Images as DIRECT subviews, logs "Image supports
    // max 1 subview", and captures ONLY subview[0] (the unpainted base photo).
    // That was the real "boat color never lands on the map" bug.
    <View collapsable={false} style={{ width: size, height: size }}>
      <Image source={photo} style={img} resizeMode="contain" fadeDuration={0} onLoad={onLoad} />
      {layers && primary ? (
        <>
          <Image source={layers.priBlack} style={img} resizeMode="contain" fadeDuration={0} onLoad={onLoad} />
          <Image source={layers.priMask} style={[img, { tintColor: primary }]} resizeMode="contain" fadeDuration={0} onLoad={onLoad} />
        </>
      ) : null}
      {layers && secondary ? (
        <>
          <Image source={layers.secBlack} style={img} resizeMode="contain" fadeDuration={0} onLoad={onLoad} />
          <Image source={layers.secMask} style={[img, { tintColor: secondary }]} resizeMode="contain" fadeDuration={0} onLoad={onLoad} />
        </>
      ) : null}
    </View>
  );
}
