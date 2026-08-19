// GR Corolla vehicle asset registry.
//
// Maps a color name (case-insensitive) to the corresponding GR Corolla
// top-down PNG asset. Used by:
//   - <CarMarker> Garage preview + native map self-marker
//   - <ConvoyMapbox> / <CarMapView> self + peer PNG markers
//
// To add a new official GRC color: drop the PNG into /app/frontend/assets/vehicles/
// and add the require()/key here.
//
// NOTE: the 139 KB base64 mirror (vehicleAssetsB64.ts) was deleted — its only
// consumer was the retired <ConvoyMap.web> SVG-embed marker. require() alone now.

export type GRCColorKey =
  | "supersonic_red"
  | "blue_flame"
  | "ice_cap_white"
  | "heavy_metal"
  | "precious_black_pearl"
  | "gravel";

// require() bundles the asset for native (Image component memory-friendly).
// On web Metro returns a `{ uri }` object — works either way.
// v3 (8/19): the v2 renders tone-matched to the ORIGINAL photo sprite Jeff
// missed ("the grey is darker and richer") — measured: old body meanLum 66 vs
// v2's 103, corrected with gamma 1.43 + 12% saturation (heavy metal now 73).
// New DIRECTORY per the OTA asset path-key trap.
export const VEHICLE_PNG: Record<GRCColorKey, number | { uri: string }> = {
  supersonic_red:       require("../assets/vehicles/v3/supersonic_red.png"),
  blue_flame:           require("../assets/vehicles/v3/blue_flame.png"),
  ice_cap_white:        require("../assets/vehicles/v3/ice_cap_white.png"),
  heavy_metal:          require("../assets/vehicles/v3/heavy_metal.png"),
  precious_black_pearl: require("../assets/vehicles/v3/precious_black_pearl.png"),
  // GRMN Gravel (6X9 "Master's Khaki") — sprite rendered top-down from the NEW
  // authored GR model (2026-08-18), not a photo crop like the five older ones; ink is
  // a clean 132-length so it needs no normalisation correction.
  // gravel (v3, 8/19 pm): the MEASURED 06X9 grey-green + bronze wheels render,
  // tone-matched with the rest of the set. New path per re-render (path-key trap).
  gravel:               require("../assets/vehicles/v3/gravel.png"),
};

// Color name aliases — maps free-form user input to a canonical key.
// Accepts:
//   - Human label:   "Heavy Metal", "Supersonic Red", "Stratosphere Blue" (legacy)
//   - Snake_case:    "heavy_metal", "supersonic_red"
//   - GRC slug:      "grc_heavy_metal", "grc_heavymetal", "grc_supersonic_red"
// "Stratosphere Blue" is a legacy alias for "Blue Flame" so users who saved
// their profile under the old palette keep their PNG.
const ALIASES: Record<string, GRCColorKey> = {
  // Human labels
  "supersonic red":       "supersonic_red",
  "blue flame":           "blue_flame",
  "stratosphere blue":    "blue_flame", // legacy alias
  "ice cap white":        "ice_cap_white",
  "icecap white":         "ice_cap_white", // Garage uses one-word "Icecap"
  "heavy metal":          "heavy_metal",
  "precious black pearl": "precious_black_pearl",
  "black onyx":           "precious_black_pearl", // Garage label for the black GRC paint
  "onyx":                 "precious_black_pearl",
  // ⚠ Gravel was MISSING here from the day it shipped (found 8/19): resolveGRCKey
  // returned null and every surface silently fell back to heavy_metal — which is
  // why "gravel looks identical to heavy metal" (Jeff). It literally WAS.
  "gravel":               "gravel",
  "master's khaki":       "gravel",
  "masters khaki":        "gravel",
  // Snake_case keys
  "supersonic_red":       "supersonic_red",
  "blue_flame":           "blue_flame",
  "ice_cap_white":        "ice_cap_white",
  "icecap_white":         "ice_cap_white",
  "heavy_metal":          "heavy_metal",
  "precious_black_pearl": "precious_black_pearl",
  "black_onyx":           "precious_black_pearl",
  // GRC slug prefix (user-spec format: e.g. "grc_heavymetal")
  "grc_supersonic_red":   "supersonic_red",
  "grc_supersonicred":    "supersonic_red",
  "grc_blue_flame":       "blue_flame",
  "grc_blueflame":        "blue_flame",
  "grc_ice_cap_white":    "ice_cap_white",
  "grc_icecapwhite":      "ice_cap_white",
  "grc_heavy_metal":      "heavy_metal",
  "grc_heavymetal":       "heavy_metal",
  "grc_precious_black_pearl": "precious_black_pearl",
  "grc_preciousblackpearl":   "precious_black_pearl",
  "grc_gravel":               "gravel",
  "gravel_khaki":             "gravel",
};

export function resolveGRCKey(color?: string | null): GRCColorKey | null {
  if (!color) return null;
  const raw = String(color).trim().toLowerCase();
  if (!raw) return null;
  // direct hit
  if (ALIASES[raw]) return ALIASES[raw];
  // Strip non-alphanum then retry — handles "Heavy-Metal", "heavy.metal", etc.
  const norm = raw.replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_");
  if (ALIASES[norm]) return ALIASES[norm];
  const tight = raw.replace(/[^a-z0-9]/g, "");
  for (const [k, v] of Object.entries(ALIASES)) {
    if (k.replace(/[^a-z0-9]/g, "") === tight) return v;
  }
  return null;
}

/** Compute the canonical "grc_*" broadcast slug from any color input. */
export function toGRCSlug(color?: string | null): string | null {
  const key = resolveGRCKey(color);
  return key ? `grc_${key}` : null;
}

/** Returns the bundled asset (require() result) or null if color isn't a GRC. */
export function getVehiclePng(color?: string | null) {
  const key = resolveGRCKey(color);
  return key ? VEHICLE_PNG[key] : null;
}

/**
 * Default GRC PNG used when a user hasn't picked a custom paint yet.
 * Heavy Metal is the most neutral / least-flashy option in the lineup so it
 * blends cleanly on satellite tiles without misrepresenting anyone's car.
 */
export const DEFAULT_GRC_KEY: GRCColorKey = "heavy_metal";
export function getDefaultVehiclePng() {
  return VEHICLE_PNG[DEFAULT_GRC_KEY];
}
/** Resolves to a GRC asset always — never null. Falls back to the default GRC. */
export function getVehiclePngOrDefault(color?: string | null) {
  return getVehiclePng(color) || getDefaultVehiclePng();
}

/** Convenience: is this color one of the 5 GRC official paints? */
export function isGRCColor(color?: string | null): boolean {
  return resolveGRCKey(color) !== null;
}

// ===== 3D car tint =====
// The single 3D GLB car render is Ice Cap white. A near-white base tints
// cleanly to any paint via the Mapbox ModelLayer (white × color = that color),
// so all 5 colors come from ONE render instead of 5 hosted models.
//   color = modelColor (the paint hex)
//   mix   = modelColorMixIntensity 0..1 (how strongly the paint replaces the
//           white texture; 0 = keep original white, 1 = full paint)
// Hexes are representative GRC paints (tweak live via OTA — one-line change).
// Codes: Ice Cap 040 · Heavy Metal 1L5 · Supersonic Red 3U5 · Blue Flame 8W9 · Black 202
export const VEHICLE_TINT: Record<GRCColorKey, { color: string; mix: number }> = {
  ice_cap_white:        { color: "#FFFFFF", mix: 0.0 },  // 040 — keep factory white
  heavy_metal:          { color: "#6B7075", mix: 0.85 }, // 1L5 — metallic gunmetal grey
  supersonic_red:       { color: "#C8102E", mix: 1.0 },  // 3U5 — tricoat red
  blue_flame:           { color: "#1B9DD9", mix: 1.0 },  // 8W9 — metallic cyan/blue
  precious_black_pearl: { color: "#17191C", mix: 0.92 }, // 202 — gloss black
  // 6X9 Gravel — MEASURED from Toyota's own studio asset (8/19, filename carries the
  // paint code: MY26_GR-Corolla_US_GRMN-Gas-4WD-MT_6285_06X9_03_6K.png; four body
  // regions sampled, flat-lit panel median #585F60). Dark grey with a GREEN lean
  // (G≈B, R about 8 under) — Jeff: "like heavy metal but more of a green tint".
  // History: swatch #717A7C (blue-grey twin of Heavy Metal) → khaki #72705E (too
  // warm, wrong direction) → this. Bronze wheels remain the unmistakable tell.
  gravel:               { color: "#565E5F", mix: 0.9 },
};

/** modelColor + mix for the 3D car. Falls back to the default GRC paint. */
export function getVehicleTint(color?: string | null): { color: string; mix: number } {
  const key = resolveGRCKey(color) || DEFAULT_GRC_KEY;
  return VEHICLE_TINT[key];
}

// ===== 3D car model URLs (per color) =====
// One render, recolored per paint: only the white BODY pixels are repainted in
// the texture (wheels/glass/grille/lights untouched), textures downscaled to
// 1024 so each model is ~3.7MB (was 13MB) for a fast load. The map swaps the
// model by color instead of tinting the whole thing at runtime. The paint (body
// only) is glossy/metallic via a body-masked metallic-roughness map; tires, glass,
// grille and lights stay matte.
// ── THE AUTHORED MODEL, https-hosted (2026-08-19) ───────────────────────────
// Jeff's own GR_Corolla.glb (authored: real topology, modeled rear, carbon roof
// panel, matte Gravel), normalized to the old asset's 1.9101 m length with nose
// direction verified against the old model. Served from OUR Supabase storage
// (public bucket "models") — https because Mapbox Android's model loader rejects
// any non-http scheme (the 8/19 black-map lesson; see glb-ota memory). Replaces
// the AI-generated higgsfield set whose rear was hallucinated mush.
export const VEHICLE_MODEL_URL: Record<GRCColorKey, string> = {
  ice_cap_white:        "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models/out_ice_cap_white.glb",
  heavy_metal:          "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models/out_heavy_metal.glb",
  supersonic_red:       "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models/out_supersonic_red.glb",
  blue_flame:           "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models/out_blue_flame.glb",
  precious_black_pearl: "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models/out_precious_black_pearl.glb",
  // out_gravel3 (8/19 pm): the MEASURED 06X9 grey-green (see VEHICLE_TINT.gravel) +
  // bronze GRMN wheels. New FILENAME per re-bake, never an overwrite — devices cache
  // the old GLB by URL. (gravel2 was the khaki miss; gravel1 never rendered at all —
  // see the resolver-alias memory.)
  gravel:               "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models/out_gravel3.glb",
};

// ── PER-COLOUR FLAT-SPRITE NORMALISATION (2026-07-30) ────────────────────────
// Jeff: "make sure the 3D car markers for all the colours scale correctly — use the
// grey one as the reference."
//
// MEASURED, both halves:
//  • The 3D GLBs are IDENTICAL. Parsed all five and computed each world-space
//    bounding box through the node hierarchy: every one is 1.9101 x 0.6693 x 0.9012.
//    Same mesh, different textures — so the shared modelScale curve already renders
//    every colour at exactly the same size and NO correction is possible or needed.
//  • The FLAT top-down PNGs do NOT match. Same 44/88/132 canvas, but the car's INK
//    inside it differs, because each is a separate photo crop. Measured on the @3x
//    art (alpha bbox, ignoring the antialias fringe below alpha 24):
//        heavy_metal (GREY)   66 x 129   <- the reference Jeff named
//        ice_cap_white        66 x 130
//        precious_black_pearl 63 x 130
//        blue_flame           62 x 130
//        supersonic_red       62 x 132
//    So red/blue/black draw ~6% narrower than grey at the same spriteSize.
//
// Normalising in CODE rather than by re-cutting the PNGs is deliberate: changing an
// existing require()'d image's CONTENT does nothing over the air — expo-updates
// dedupes embedded assets by PATH and keeps serving the build's copy — so an asset
// fix would need a directory rename and a fresh build. A scale factor ships today.
// ⚠ NORMALISE ON LENGTH, NOT WIDTH. My first pass used the ink WIDTH and it was
// wrong — a uniform scale moves BOTH axes, and the lengths already matched. Measured
// ink (@3x, alpha>24, stable across a 8/24/64/128 threshold sweep so this is real and
// not antialias noise):
//     heavy_metal (GREY)    66 x 129     aspect 1.955
//     ice_cap_white         66 x 130     aspect 1.970
//     precious_black_pearl  63 x 130     aspect 2.063
//     blue_flame            62 x 130     aspect 2.097
//     supersonic_red        62 x 132     aspect 2.129
// Lengths agree within 2%; widths differ by 6%; ASPECT differs by 10%. So these are
// not one render at different zooms — the source art genuinely differs in shape, and
// NO single factor can make them identical. Scaling to equalise width therefore made
// red and blue 6.5-8.9% LONGER than grey, i.e. worse on the axis that actually reads
// as size. A top-down car's perceived size is its LENGTH.
// Normalising on length gives 0.977-1.000 — small, and correct in the axis that
// matters. Full parity needs the art re-rendered; queued for build 71.
const VEHICLE_PNG_INK_LEN: Record<GRCColorKey, number> = {
  heavy_metal: 132,  // v2 render — full-length ink by construction
  ice_cap_white: 132,  // v2 render — full-length ink by construction
  precious_black_pearl: 132,  // v2 render — full-length ink by construction
  blue_flame: 132,  // v2 render — full-length ink by construction
  supersonic_red: 132,  // v2 render — full-length ink by construction
  gravel: 132,   // rendered (not photographed) — full-length ink by construction
};
const VEHICLE_PNG_REF_LEN = VEHICLE_PNG_INK_LEN.heavy_metal;   // grey is the reference

/**
 * Multiplier that makes a colour's flat top-down sprite read the same SIZE as the
 * grey one, matched on the car's LENGTH (its long axis). 1.0 for grey, 0.977-0.992
 * for the rest. Apply to a map marker's size / spriteSize — never to the 3D model,
 * whose five GLBs are already dimensionally identical (1.9101 x 0.6693 x 0.9012).
 */
export function vehiclePngScale(color?: string | null): number {
  const key = resolveGRCKey(color) || DEFAULT_GRC_KEY;
  const len = VEHICLE_PNG_INK_LEN[key];
  if (!len) return 1;
  return Math.round((VEHICLE_PNG_REF_LEN / len) * 1000) / 1000;
}


/** Hosted 3D car model URL for the chosen paint. Falls back to the default GRC.
 * `lit` picks the headlights/taillights-ON bake (out_<key>_lit.glb, same bucket) —
 * the map passes it when the basemap lightPreset is dawn/dusk/night so the car
 * drives with its lights on after dark (Jeff, 8/19). */
export function getVehicleModelUrl(color?: string | null, lit?: boolean): string {
  const key = resolveGRCKey(color) || DEFAULT_GRC_KEY;
  const url = VEHICLE_MODEL_URL[key];
  return lit ? url.replace(/\.glb$/, "_lit.glb") : url;
}

/** True when the basemap light preset calls for headlights (dawn/dusk/night). */
export function isLitPreset(preset?: string | null): boolean {
  return preset === "dusk" || preset === "night" || preset === "dawn";
}

// The resolved model KEY for a color (e.g. "grc_heavy_metal"). Used to build a
// color-specific Mapbox model id so changing the car color swaps the 3D model LIVE:
// Mapbox caches a registered model by its id, so re-pointing a fixed id at a new .glb
// won't reload until remount — a per-color id forces the new model to load.
export function getVehicleModelKey(color?: string | null): string {
  return resolveGRCKey(color) || DEFAULT_GRC_KEY;
}

// ===== Top-down "Class" photos (Garage → Map Appearance → Class) =====
// Real top-down shots, background-keyed + rotated nose-up + fit to the GRC
// marker canvas (44×44, transparent) by the class-asset pipeline. Classes not
// in this map fall back to the tinted top-down silhouette until Jeff supplies
// a photo (missing: electric + motorcycle — hatchback intentionally uses the
// GRC avatar PNGs).
export const CLASS_TOPDOWN: Partial<Record<string, any>> = {
  hatchback:  require("../assets/images/classes-v2/hatchback.png"),  // carbon-roof hot hatch (512 white set)
  sedan:      require("../assets/images/classes-v2/sedan.png"),      // white BMW
  boat:       require("../assets/images/classes-v2/boat.png"),    // Supra wake boat
  jeep:       require("../assets/images/classes-v2/jeep.png"),    // (new class 2026-07-18)       // Supra wake boat
  muscle:     require("../assets/images/classes-v2/muscle.png"),     // striped muscle (512 white set)
  supercar:   require("../assets/images/classes-v2/supercar.png"),   // carbon-roof supercar (512 white set)
  electric:   require("../assets/images/classes-v2/electric.png"),   // glass-roof EV (512 white set)
  exotic:     require("../assets/images/classes-v2/exotic.png"),     // LaFerrari (512 white set)
  truck:      require("../assets/images/classes-v2/truck.png"),      // Raptor (512 white set)
  motorcycle: require("../assets/images/classes-v2/motorcycle.png"), // Ducati (512 white set)
  atv:        require("../assets/images/classes-v2/atv.png"),
  sxs:        require("../assets/images/classes-v2/sxs.png"),        // Can-Am Maverick
};
