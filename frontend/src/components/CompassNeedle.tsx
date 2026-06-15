// CompassNeedle.tsx — faceted two-arm compass needle for the map's compass FAB.
//
// North arm = brand green + dark-grey facets; South arm = white + dark-grey
// facets, each split down the vertical centre for a 3D spindle look, with a
// white centre pin between them. Renders NORTH-UP; the parent FAB rotates the
// whole thing by the live map bearing so North always points to true north.
import React from "react";
import Svg, { Polygon, Circle } from "react-native-svg";

const GREEN = "#2DEC86";   // North, lit facet (brand)
const WHITE = "#FFFFFF";   // South, lit facet
const SHADOW = "#3A3A3C";  // shadow facet (both arms) — gives the 3D ridge
const PIN_RING = "#1C1C1E";

export default function CompassNeedle({ size = 54 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      {/* North arm (points up) — lit green on the left, shadowed grey on the right */}
      <Polygon points="50,6 39,50 50,50" fill={GREEN} />
      <Polygon points="50,6 61,50 50,50" fill={SHADOW} />
      {/* South arm (points down) — lit white on the left, shadowed grey on the right */}
      <Polygon points="50,94 39,50 50,50" fill={WHITE} />
      <Polygon points="50,94 61,50 50,50" fill={SHADOW} />
      {/* Centre pin */}
      <Circle cx="50" cy="50" r="8.5" fill={WHITE} stroke={PIN_RING} strokeWidth="2" />
    </Svg>
  );
}
