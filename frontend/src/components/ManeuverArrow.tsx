// ManeuverArrow — a real VECTOR turn arrow (react-native-svg), shared by the phone
// nav banner AND the CarPlay maneuver strip so the two are pixel-identical. Replaces
// the old unicode glyphs (↱ ↗ …), which rendered inconsistently and looked wrong.
//
// react-native-svg draws the same path on every surface (no icon-font loading), so it
// works on the CarPlay window where icon fonts were flaky.

import React from "react";
import { useAppSkin } from "../appSkin";
import { TIER_SKIN, type VisualTier } from "../tierTheme";
import { View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Path, Circle, G } from "react-native-svg";

export type ManeuverDir =
  | "straight" | "left" | "right" | "slight-left" | "slight-right" | "uturn"
  // Roundabouts carry the EXIT direction so the arrow leaves the circle at the real angle.
  | "roundabout" | "roundabout-slight-left" | "roundabout-left"
  | "roundabout-slight-right" | "roundabout-right";

// Parse a turn → a direction. `maneuverKey` is Mapbox's joined "type|modifier"
// (e.g. "roundabout|slight left") from NavStep.maneuver — the roundabout EXIT direction
// lives in the modifier, since the instruction text ("take the 3rd exit") has no L/R.
// Order matters: specific before general (e.g. "slight right" before "right").
export function maneuverDir(instruction: string, maneuverKey?: string): ManeuverDir {
  const t = (instruction || "").toLowerCase();
  const key = (maneuverKey || "").toLowerCase();
  if (/\bu[- ]?turn\b/.test(t)) return "uturn";
  if (/\bround ?about\b|\brotary\b/.test(t) || /^(roundabout|rotary)/.test(key)) {
    const mod = key.split("|")[1] || "";
    if (/slight left/.test(mod)) return "roundabout-slight-left";
    if (/slight right/.test(mod)) return "roundabout-slight-right";
    if (/left/.test(mod)) return "roundabout-left";
    if (/right/.test(mod)) return "roundabout-right";
    return "roundabout"; // straight-through / unknown exit
  }
  if (/\bslight left\b|\bkeep left\b|\bfork left\b/.test(t)) return "slight-left";
  if (/\bslight right\b|\bkeep right\b|\bfork right\b/.test(t)) return "slight-right";
  if (/\bleft\b/.test(t)) return "left";
  if (/\bright\b/.test(t)) return "right";
  if (/\bmerge\b|\b(ramp|exit|take)\b/.test(t)) return "slight-right";
  return "straight";
}

// Non-roundabout path data (viewBox 0 0 28 28). [stem, head]. Stroked, no fill.
const PATHS: Partial<Record<ManeuverDir, string[]>> = {
  straight: ["M14 23.5 L14 8", "M8.5 13 L14 7 L19.5 13"],
  right: ["M11 24 L11 12.5 Q11 9.5 14 9.5 L19 9.5", "M15.5 6 L20.5 9.5 L15.5 13"],
  left: ["M17 24 L17 12.5 Q17 9.5 14 9.5 L9 9.5", "M12.5 6 L7.5 9.5 L12.5 13"],
  "slight-right": ["M9.5 22.5 L19 9.5", "M14 9.5 L19 9.5 L19 14.5"],
  "slight-left": ["M18.5 22.5 L9 9.5", "M14 9.5 L9 9.5 L9 14.5"],
  uturn: ["M9.5 23 L9.5 13 Q9.5 7.5 14.5 7.5 Q19.5 7.5 19.5 13 L19.5 17", "M16 14 L19.5 17.5 L23 14"],
};

// Roundabout exit angle (SVG clockwise degrees; the base exit arrow points UP = straight).
const RBT_EXIT_DEG: Record<string, number> = {
  "roundabout": 0,
  "roundabout-slight-left": -48,
  "roundabout-left": -98,
  "roundabout-slight-right": 48,
  "roundabout-right": 98,
};

export function ManeuverArrow({
  dir,
  size = 30,
  color = "#0B0B0C",
}: {
  dir: ManeuverDir;
  size?: number;
  color?: string;
}) {
  const sw = 2.8;
  const stroke = { stroke: color, strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };

  // Roundabout: circle + entry stub (bottom) + an exit arrow that leaves the circle at
  // the actual exit angle from the maneuver modifier.
  if (dir.startsWith("roundabout")) {
    const deg = RBT_EXIT_DEG[dir] ?? 0;
    return (
      <Svg width={size} height={size} viewBox="0 0 28 28">
        <Circle cx="14" cy="14" r="5.5" stroke={color} strokeWidth={sw} fill="none" />
        <Path d="M14 24 L14 19.5" {...stroke} />
        <G rotation={deg} originX={14} originY={14}>
          <Path d="M14 8.5 L14 3" {...stroke} />
          <Path d="M10.5 6 L14 2.5 L17.5 6" {...stroke} />
        </G>
      </Svg>
    );
  }

  const paths = PATHS[dir] || PATHS.straight!;
  return (
    <Svg width={size} height={size} viewBox="0 0 28 28">
      {paths.map((d, i) => (
        <Path key={i} d={d} {...stroke} />
      ))}
    </Svg>
  );
}

// ── The CANDY language ───────────────────────────────────────────────────────
// Exported so other surfaces can wear the map banner's look WITHOUT re-typing
// the stops. Jeff 2026-08-23 asked for this gradient on the Garage CTAs and
// icons; copying three hex values into four more screens is exactly how the
// phone and CarPlay drifted apart before ManeuverBox existed.
// RE-EXPORTED, not defined here — tierTheme.ts owns them. Defining them here while
// tierTheme imported them, AND importing TIER_SKIN back from tierTheme, is the cycle
// that crashed Settings on 2026-08-25. Keep the arrow pointing one way.
export { CANDY_COLORS, CANDY_LOCATIONS, CANDY_RIM, CANDY_INK } from "../tierTheme";

// ── ManeuverBox: THE green maneuver square, shared by every surface ──────────
// (Jeff 8/20: "add a gradient look to the turnbyturn green squares... for all
// surfaces — they look plain and flat.") One component so the phone banner, the
// phone drive-list rows, and the CarPlay/AA nav card can never drift apart —
// same rule as ManeuverArrow itself. The construction is the candy language the
// End button established: vertical mint→brand→deep gradient + a pale-green
// hairline rim; the dark glyph rides on top. LinearGradient is proven on every
// surface including the AA canvas (the 8/18 bisect exonerated it).

/**
 * ── THE TURN SQUARE WEARS THE APP SKIN (Jeff, 2026-08-25) ────────────────────
 * "make sure the turn banner square and the phone turnbyturn (map replacement)
 *  follow the skin too."
 *
 * The candy language and TIER_SKIN are the SAME construction — a three-stop
 * vertical gradient at [0, 0.45, 1] plus a pale hairline rim (DESIGN.md §1) — so
 * the box just reads its stops from the skin instead of the brand constants. One
 * component means the phone banner, the phone drive-list rows and the CarPlay /
 * AA nav card cannot drift apart, which is the whole reason ManeuverBox exists.
 *
 * `tier` overrides it for a surface that must stay brand green regardless.
 * NOTE this is deliberately NOT map paint: the route line, congestion and hazards
 * are untouched (src/appSkin.ts). This is a UI card that happens to sit over the
 * map, and Jeff asked for it explicitly.
 */
export function ManeuverBox({
  size = 30,
  radius = 8,
  style,
  tier,
  children,
}: {
  size?: number;
  radius?: number;
  style?: any;
  tier?: VisualTier;
  children: React.ReactNode;
}) {
  const skinTier = useAppSkin();
  const sk = TIER_SKIN[tier ?? skinTier];
  return (
    <View
      style={[{
        width: size, height: size, borderRadius: radius,
        alignItems: "center", justifyContent: "center",
        overflow: "hidden",
        borderWidth: 1, borderColor: sk.rim,
      }, style]}
    >
      <LinearGradient
        colors={sk.colors}
        locations={sk.locations}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />
      {children}
    </View>
  );
}

export default ManeuverArrow;
