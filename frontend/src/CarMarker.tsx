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
import { Image, View } from "react-native";
import { getVehiclePngOrDefault } from "./vehicleAssets";

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
  // ---- Primary palette (GR Corolla high-res PNG assets) ----
  { name: "Supersonic Red",         hex: "#D60019" }, // bright performance red
  { name: "Blue Flame",             hex: "#1E9CFF" }, // electric azure blue
  { name: "Ice Cap White",          hex: "#F4F6F8" }, // crisp pearl white
  { name: "Heavy Metal",            hex: "#5C5F66" }, // metallic gunmetal gray
  { name: "Precious Black Pearl",   hex: "#0E0F12" }, // deep pearlescent black
  // ---- Legacy / extended ----
  { name: "Stratosphere Blue", hex: "#1F4FB8" }, // legacy — aliased to Blue Flame PNG
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
  /**
   * Canonical GR Corolla slug broadcast over Supabase presence
   * (e.g. "grc_heavy_metal"). When provided, takes precedence over `color`
   * for asset lookup. Defaults to the Heavy Metal GRC PNG if neither
   * `activeColor` nor `color` resolves to one of the 5 known paints — we
   * never render a generic silhouette.
   */
  activeColor?: string | null;
  heading?: number | null;     // degrees, 0 = north
  size?: number;               // overall icon size in px
  testID?: string;
};

// Path data is drawn as if the vehicle is pointing UP (heading 0°). We then
// rotate the entire <G> by `heading`. All paths are sized to a 100×100 viewBox.
// NOTE: The legacy SVG silhouette paths below are retained only as historical
// reference. Live rendering always uses the GR Corolla PNG assets (see render
// body in CarMarker default export).

export default function CarMarker({ color, activeColor, heading, size = 40, testID }: Props) {
  // Heading from expo-location is degrees clockwise from true north — used as
  // a CSS rotate degree directly.
  const angle = Number.isFinite(heading as number) ? Math.round((heading as number) % 360) : 0;
  // Resolve to a GR Corolla PNG. If color/activeColor don't match one of the
  // 5 official paints, we fall back to the DEFAULT_GRC PNG ("Heavy Metal") so
  // every driver always shows up as a recognisable top-down car — never a
  // generic SVG silhouette or a broken image.
  const asset = getVehiclePngOrDefault(activeColor || color);
  return (
    <View
      testID={testID}
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
      pointerEvents="none"
    >
      <Image
        source={asset as any}
        style={{
          width: size,
          height: size,
          transform: [{ rotate: `${angle}deg` }],
        }}
        resizeMode="contain"
      />
    </View>
  );
}
