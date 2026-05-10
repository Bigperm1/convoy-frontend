// GR Corolla vehicle asset registry.
//
// Maps a color name (case-insensitive) to the corresponding GR Corolla
// top-down PNG asset. Used by:
//   - <CarMarker> Garage preview + native map self-marker
//   - <ConvoyMap.web> user marker (via base64 SVG embed)
//
// To add a new official GRC color: drop the PNG into /app/frontend/assets/vehicles/,
// re-run the base64 generator at /app/frontend/src/vehicleAssetsB64.ts, and add
// the require()/key here.

import { GRC_PNG_B64 } from "./vehicleAssetsB64";

export type GRCColorKey =
  | "supersonic_red"
  | "blue_flame"
  | "ice_cap_white"
  | "heavy_metal"
  | "precious_black_pearl";

// require() bundles the asset for native (Image component memory-friendly).
// On web Metro returns a `{ uri }` object — works either way.
export const VEHICLE_PNG: Record<GRCColorKey, number | { uri: string }> = {
  supersonic_red:       require("../assets/vehicles/supersonic_red.png"),
  blue_flame:           require("../assets/vehicles/blue_flame.png"),
  ice_cap_white:        require("../assets/vehicles/ice_cap_white.png"),
  heavy_metal:          require("../assets/vehicles/heavy_metal.png"),
  precious_black_pearl: require("../assets/vehicles/precious_black_pearl.png"),
};

// Color name aliases — maps free-form user input to a canonical key.
// "Stratosphere Blue" is a legacy alias for "Blue Flame" so users who saved
// their profile under the old palette keep their PNG.
const ALIASES: Record<string, GRCColorKey> = {
  "supersonic red":       "supersonic_red",
  "blue flame":           "blue_flame",
  "stratosphere blue":    "blue_flame", // legacy alias
  "ice cap white":        "ice_cap_white",
  "heavy metal":          "heavy_metal",
  "precious black pearl": "precious_black_pearl",
};

export function resolveGRCKey(color?: string | null): GRCColorKey | null {
  if (!color) return null;
  const k = String(color).trim().toLowerCase();
  return ALIASES[k] || null;
}

/** Returns the bundled asset (require() result) or null if color isn't a GRC. */
export function getVehiclePng(color?: string | null) {
  const key = resolveGRCKey(color);
  return key ? VEHICLE_PNG[key] : null;
}

/** Returns a base64 data URL for the GRC PNG — used by web SVG marker embed. */
export function getVehiclePngDataUri(color?: string | null): string | null {
  const key = resolveGRCKey(color);
  if (!key) return null;
  const b64 = GRC_PNG_B64[key];
  return b64 ? `data:image/png;base64,${b64}` : null;
}

/** Convenience: is this color one of the 5 GRC official paints? */
export function isGRCColor(color?: string | null): boolean {
  return resolveGRCKey(color) !== null;
}
