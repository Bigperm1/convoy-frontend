// Top-down vehicle silhouette used as the live map marker for community peers.
//
// Renders an SVG car/motorcycle pointing toward the heading angle (0° = north),
// tinted with the user's car color. Falls back to a sedan if body type is unknown.
//
// Design intent (Waze/Apple Maps-style):
//   - clean monochrome silhouette with a subtle white outline so the icon stays
//     legible on busy satellite tiles
//   - small windshield highlight to give a sense of orientation
//
// IMPORTANT: We pre-rotate the SVG paths in code (transform=`rotate(...)`) so
// the marker shape itself rotates around its center on both web (Google Maps)
// and native (`react-native-maps` Marker rotation prop).

import React from "react";
import Svg, { G, Path, Rect, Defs, LinearGradient, Stop } from "react-native-svg";

export type CarBody = "sedan" | "coupe" | "suv" | "sports" | "truck" | "hatch" | "motorcycle" | "van";

export const CAR_BODIES: { id: CarBody; label: string; emoji: string }[] = [
  { id: "sedan",      label: "Sedan",      emoji: "🚗" },
  { id: "coupe",      label: "Coupe",      emoji: "🏎️" },
  { id: "sports",     label: "Sports",     emoji: "🏁" },
  { id: "suv",        label: "SUV",        emoji: "🚙" },
  { id: "hatch",      label: "Hatch",      emoji: "🚘" },
  { id: "truck",      label: "Truck",      emoji: "🛻" },
  { id: "van",        label: "Van",        emoji: "🚐" },
  { id: "motorcycle", label: "Motorbike",  emoji: "🏍️" },
];

// 12 named car colors that map to good-looking hexes. Free-form `car_color`
// strings are also accepted (CSS color syntax) — the silhouette will use them as-is.
// Color palette. The first 5 are the "primary" garage colors (named per the
// product spec — Supersonic Red, Stratosphere Blue, Ice Cap White, Heavy
// Metal, Precious Black Pearl). The remainder are legacy/extra options kept
// so existing user profiles ("Bayside Blue", "Guards Red", etc.) still
// resolve correctly via the lookup in `resolveCarColor()`.
export const CAR_COLORS: { name: string; hex: string }[] = [
  // ---- Primary palette ----
  { name: "Supersonic Red",         hex: "#D60019" }, // bright performance red
  { name: "Stratosphere Blue",      hex: "#1F4FB8" }, // deep aerospace blue
  { name: "Ice Cap White",          hex: "#F4F6F8" }, // crisp pearl white
  { name: "Heavy Metal",            hex: "#5C5F66" }, // metallic gunmetal gray
  { name: "Precious Black Pearl",   hex: "#0E0F12" }, // deep pearlescent black
  // ---- Legacy / extended ----
  { name: "Bayside Blue",   hex: "#0A84FF" },
  { name: "Nardo Gray",     hex: "#8E8E93" },
  { name: "Guards Red",     hex: "#FF453A" },
  { name: "Yellow",         hex: "#FFD60A" },
  { name: "Pearl White",    hex: "#F2F2F7" },
  { name: "Jet Black",      hex: "#1A1A1A" },
  { name: "Forest Green",   hex: "#30D158" },
  { name: "Dawn Orange",    hex: "#FF9F0A" },
  { name: "Plum Purple",    hex: "#BF5AF2" },
  { name: "Carbon",         hex: "#3A3A3C" },
  { name: "Midnight Silver", hex: "#AEAEB2" },
  { name: "Cyber Brown",    hex: "#A2845E" },
];

// Resolve a free-form color string to a usable hex. If it already looks like
// a CSS color we return it untouched; otherwise we look up the named palette.
export function resolveCarColor(input?: string | null): string {
  if (!input) return "#0A84FF";
  const t = input.trim();
  if (!t) return "#0A84FF";
  if (t.startsWith("#") || t.startsWith("rgb")) return t;
  const hit = CAR_COLORS.find((c) => c.name.toLowerCase() === t.toLowerCase());
  return hit?.hex || "#0A84FF";
}

type Props = {
  body?: CarBody | string | null;
  color?: string | null;
  heading?: number | null;     // degrees, 0 = north
  size?: number;               // overall icon size in px
  testID?: string;
};

// Path data is drawn as if the vehicle is pointing UP (heading 0°). We then
// rotate the entire <G> by `heading`. All paths are sized to a 100×100 viewBox.

function bodyPath(body: CarBody) {
  switch (body) {
    case "sports":
      // Wide, low, aggressive nose
      return "M50 8 L74 26 L78 64 L72 86 L60 92 L40 92 L28 86 L22 64 L26 26 Z";
    case "coupe":
      return "M50 10 L70 24 L74 60 L70 84 L58 92 L42 92 L30 84 L26 60 L30 24 Z";
    case "suv":
      return "M50 8 L72 22 L74 78 L70 92 L30 92 L26 78 L28 22 Z";
    case "truck":
      // Cab + bed (taller rectangle with cab notch)
      return "M50 8 L70 18 L72 44 L74 92 L26 92 L28 44 L30 18 Z";
    case "hatch":
      // Aggressive hot-hatch: pointed nose, pronounced front + rear fender flares,
      // mid-body waist, squared-off rear deck. (Roof spoiler is rendered as a
      // separate path overlaying the rear so it visually sits above the body.)
      return "M50 6 L60 12 L78 24 L80 32 L72 50 L80 68 L82 80 L78 90 L22 90 L18 80 L20 68 L28 50 L20 32 L22 24 L40 12 Z";
    case "van":
      return "M50 10 L74 22 L76 90 L70 94 L30 94 L24 90 L26 22 Z";
    case "motorcycle":
      // Slim narrow oval-ish with a bigger front
      return "M50 10 L60 30 L62 70 L56 90 L44 90 L38 70 L40 30 Z";
    case "sedan":
    default:
      return "M50 10 L70 24 L72 78 L66 92 L34 92 L28 78 L30 24 Z";
  }
}

// Optional rear-wing/spoiler overlay. Only the hot-hatch gets one — extends
// slightly wider than the body at the back so the wing reads from above.
// Returns `null` for bodies that don't have a spoiler.
function spoilerPath(body: CarBody): string | null {
  if (body === "hatch") {
    // A wide rear wing with two small endplates — wider than the rear fenders.
    return "M14 84 L86 84 L88 92 L12 92 Z M12 80 L18 80 L18 92 L12 92 Z M82 80 L88 80 L88 92 L82 92 Z";
  }
  return null;
}

function windshieldPath(body: CarBody) {
  switch (body) {
    case "motorcycle":
      return "M44 30 L56 30 L56 42 L44 42 Z";
    case "truck":
      return "M36 22 L64 22 L66 38 L34 38 Z";
    case "van":
      return "M34 22 L66 22 L66 36 L34 36 Z";
    default:
      return "M38 26 L62 26 L65 44 L35 44 Z";
  }
}

export default function CarMarker({ body = "sedan", color, heading, size = 40, testID }: Props) {
  const fill = resolveCarColor(color);
  const safeBody: CarBody = (CAR_BODIES.find((b) => b.id === body) ? (body as CarBody) : "sedan");
  // Heading from expo-location is degrees clockwise from true north — exactly
  // what SVG `rotate()` expects, so no conversion needed.
  const angle = Number.isFinite(heading as number) ? Math.round((heading as number) % 360) : 0;
  return (
    <Svg testID={testID} width={size} height={size} viewBox="0 0 100 100" pointerEvents="none">
      <Defs>
        <LinearGradient id="bodyGrad" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={fill} stopOpacity={1} />
          <Stop offset="1" stopColor={fill} stopOpacity={0.78} />
        </LinearGradient>
      </Defs>
      <G origin="50, 50" rotation={angle}>
        {/* Soft drop shadow */}
        <Path d={bodyPath(safeBody)} fill="rgba(0,0,0,0.45)" transform="translate(0,2)" />
        {/* Body */}
        <Path d={bodyPath(safeBody)} fill="url(#bodyGrad)" stroke="#ffffff" strokeWidth={2} strokeLinejoin="round" />
        {/* Optional roof spoiler / rear wing — currently only the hot-hatch */}
        {(() => {
          const sp = spoilerPath(safeBody);
          if (!sp) return null;
          return (
            <>
              <Path d={sp} fill="rgba(0,0,0,0.55)" transform="translate(0,1)" />
              <Path d={sp} fill="url(#bodyGrad)" stroke="#ffffff" strokeWidth={1.5} strokeLinejoin="round" />
            </>
          );
        })()}
        {/* Windshield (subtle highlight, helps show heading) */}
        <Path d={windshieldPath(safeBody)} fill="rgba(255,255,255,0.55)" />
        {/* Roof centerline accent */}
        <Rect x={48} y={50} width={4} height={26} rx={1} fill="rgba(0,0,0,0.18)" />
      </G>
    </Svg>
  );
}
