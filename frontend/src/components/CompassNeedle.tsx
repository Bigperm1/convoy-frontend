// CompassNeedle.tsx — faceted two-arm compass needle for the map's compass FAB.
//
// North arm = brand green + dark-grey facets; South arm = white + dark-grey
// facets, each split down the vertical centre for a 3D spindle look, with a
// white centre pin between them. Renders NORTH-UP; the parent FAB rotates the
// whole thing by the live map bearing so North always points to true north.
import React from "react";
import Svg, { Polygon, Circle } from "react-native-svg";
import { useAccent } from "../appSkin";

/** The brand north facet. Exported so a surface that must match CarPlay's BAKED
 *  compass PNG can pin it: <CompassNeedle north={BRAND_NORTH} />. */
export const BRAND_NORTH = "#2DEC86";
const WHITE = "#FFFFFF";   // South, lit facet
const SHADOW = "#3A3A3C";  // shadow facet (both arms) — gives the 3D ridge
const PIN_RING = "#1C1C1E";

/**
 * `north` overrides the lit north facet. It defaults to the APP SKIN (Jeff, 2026-08-25:
 * "we should also do the crew/2D/3D/compass tiered too"), so the needle turns silver at
 * Premium and gold at Ultra along with the rest of the map furniture.
 *
 * ⚠ CarPlay's compass is a SEPARATE, baked base64 PNG (CAR_ICON_COMPASS in
 * src/carplay/carButtonIcons.ts) rasterised from these exact polygons. It cannot read a
 * hook, so it stays brand green until it is re-baked per metal — pass `north={BRAND_NORTH}`
 * anywhere the two surfaces must match.
 */
export default function CompassNeedle({ size = 54, north }: { size?: number; north?: string }) {
  const accent = useAccent();
  const northFill = north ?? accent;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      {/* North arm (points up) — lit accent on the left, shadowed grey on the right */}
      <Polygon points="50,6 39,50 50,50" fill={northFill} />
      <Polygon points="50,6 61,50 50,50" fill={SHADOW} />
      {/* South arm (points down) — lit white on the left, shadowed grey on the right */}
      <Polygon points="50,94 39,50 50,50" fill={WHITE} />
      <Polygon points="50,94 61,50 50,50" fill={SHADOW} />
      {/* Centre pin */}
      <Circle cx="50" cy="50" r="8.5" fill={WHITE} stroke={PIN_RING} strokeWidth="2" />
    </Svg>
  );
}
