// MapControlIcons.tsx — glyphs for the bottom-right map control FABs.
//
// These now render user-supplied PNG artwork (assets/images/police.png and
// assets/images/hazard.png) instead of the old hand-drawn react-native-svg
// glyphs. Both keep the single `size` prop so the FAB stack can render every
// control at one consistent size; the source art is 512×512 with transparency
// and is scaled down with resizeMode="contain" (no crop, aspect preserved).

import React from "react";
import { Image } from "react-native";

const POLICE_SRC = require("../../assets/images/police.png");
const HAZARD_SRC = require("../../assets/images/hazard.png");

export function PoliceBadgeIcon({ size = 38 }: { size?: number }) {
  return <Image source={POLICE_SRC} style={{ width: size, height: size }} resizeMode="contain" />;
}

export function HazardIcon({ size = 38 }: { size?: number }) {
  // An upward-pointing triangle's optical center (its centroid) sits BELOW its
  // bounding-box center, so a bounding-box-centered triangle reads as "low" in
  // a round FAB. Nudge it up a touch so the three corners sit equidistant from
  // the circle's edge.
  return (
    <Image
      source={HAZARD_SRC}
      style={{ width: size, height: size, transform: [{ translateY: -size * 0.08 }] }}
      resizeMode="contain"
    />
  );
}
