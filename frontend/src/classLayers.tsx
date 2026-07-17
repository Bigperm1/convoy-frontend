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
  coupe:  { priBlack: L(require("../assets/images/classes/coupe_priblack.png")),  priMask: L(require("../assets/images/classes/coupe_primask.png")),  secBlack: L(require("../assets/images/classes/coupe_secblack.png")),  secMask: L(require("../assets/images/classes/coupe_secmask.png")) },
  sports: { priBlack: L(require("../assets/images/classes/sports_priblack.png")), priMask: L(require("../assets/images/classes/sports_primask.png")), secBlack: L(require("../assets/images/classes/sports_secblack.png")), secMask: L(require("../assets/images/classes/sports_secmask.png")) },
  exotic: { priBlack: L(require("../assets/images/classes/exotic_priblack.png")), priMask: L(require("../assets/images/classes/exotic_primask.png")), secBlack: L(require("../assets/images/classes/exotic_secblack.png")), secMask: L(require("../assets/images/classes/exotic_secmask.png")) },
  truck:  { priBlack: L(require("../assets/images/classes/truck_priblack.png")),  priMask: L(require("../assets/images/classes/truck_primask.png")),  secBlack: L(require("../assets/images/classes/truck_secblack.png")),  secMask: L(require("../assets/images/classes/truck_secmask.png")) },
  atv:    { priBlack: L(require("../assets/images/classes/atv_priblack.png")),    priMask: L(require("../assets/images/classes/atv_primask.png")),    secBlack: L(require("../assets/images/classes/atv_secblack.png")),    secMask: L(require("../assets/images/classes/atv_secmask.png")) },
  sxs:    { priBlack: L(require("../assets/images/classes/sxs_priblack.png")),    priMask: L(require("../assets/images/classes/sxs_primask.png")),    secBlack: L(require("../assets/images/classes/sxs_secblack.png")),    secMask: L(require("../assets/images/classes/sxs_secmask.png")) },
  boat:   { priBlack: L(require("../assets/images/classes/boat_priblack.png")),   priMask: L(require("../assets/images/classes/boat_primask.png")),   secBlack: L(require("../assets/images/classes/boat_secblack.png")),   secMask: L(require("../assets/images/classes/boat_secmask.png")) },
  sedan:  { priBlack: L(require("../assets/images/classes/sedan_priblack.png")),  priMask: L(require("../assets/images/classes/sedan_primask.png")),  secBlack: L(require("../assets/images/classes/sedan_secblack.png")),  secMask: L(require("../assets/images/classes/sedan_secmask.png")) },
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
    <View style={{ width: size, height: size }}>
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
