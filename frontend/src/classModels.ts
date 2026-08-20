// Class 3D models — the PREMIUM map appearance (build-80 ladder, Jeff 8/20).
//
// One neutral GLB per class, tinted live by Mapbox (the VEHICLE_TINT mechanism)
// so a full palette costs nothing — EXCEPT the hatchback: Jeff's call, the
// Hatch class IS the authored GR Corolla, and its palette is the real GRC
// colour list so today's testers can keep their exact colour under the new
// tiers. The generic classes are being authored to the same QC bar as the car
// library ("almost perfect — they help sell Ultra"); until a class has a
// model, CLASS_MODEL_3D has no row and the picker falls back to the top-down
// sprite.
//
// STAGED: nothing reads this yet — the class-3D map rendering lands with the
// generic models.

import type { GRCColorKey } from "./vehicleAssets";

export type ClassPaletteEntry = {
  name: string;
  hex: string;          // swatch + live tint colour
  modelKey?: GRCColorKey; // authored per-colour GLB (hatchback/GRC only)
};

export type ClassModel3D = {
  // Neutral base model, tinted at runtime — absent for authored-per-colour classes.
  baseUrl?: string;
  palette: ClassPaletteEntry[];
};

// Archetypes locked by Jeff 8/20: Hot Hatch = GR Corolla, Supercar = 911
// GT3 RS, Exotic = LFA (all three already authored — palette rows route to the
// per-colour GLBs), Muscle = the generated coupe (tint palette; upgrade to an
// authored pack model if one lands). Jeff is sourcing Electric/Truck/Jeep
// packs; Sedan (M3 CS sits in the m2 pack) awaiting his confirmation.
export const CLASS_MODEL_3D: Partial<Record<string, ClassModel3D>> = {
  hatchback: {
    palette: [
      { name: "Heavy Metal",    hex: "#6B6E72", modelKey: "heavy_metal" },
      { name: "Supersonic Red", hex: "#C0152A", modelKey: "supersonic_red" },
      { name: "Icecap White",   hex: "#F0F0F0", modelKey: "ice_cap_white" },
      { name: "Blue Flame",     hex: "#0099D8", modelKey: "blue_flame" },
      { name: "Black Onyx",     hex: "#1A1A1A", modelKey: "precious_black_pearl" },
    ],
  },
  supercar: {
    palette: [
      { name: "Guards Red",     hex: "#D5001C", modelKey: "gt3rs_guards_red" },
      { name: "GT Silver",      hex: "#9EA1A4", modelKey: "gt3rs_gt_silver" },
      { name: "Carrara White",  hex: "#F4F4F0", modelKey: "gt3rs_carrara_white" },
      { name: "Jet Black",      hex: "#1C1C1E", modelKey: "gt3rs_jet_black" },
      { name: "Miami Blue",     hex: "#00B2D8", modelKey: "gt3rs_miami_blue" },
      { name: "Python Green",   hex: "#4EC53F", modelKey: "gt3rs_python_green" },
      { name: "Shark Blue",     hex: "#2E64B8", modelKey: "gt3rs_shark_blue" },
    ],
  },
  exotic: {
    palette: [
      { name: "Whitest White",  hex: "#F7F8F4", modelKey: "lfa_whitest_white" },
      { name: "Absolutely Red", hex: "#C41230", modelKey: "lfa_absolutely_red" },
      { name: "Pearl Yellow",   hex: "#E8C63E", modelKey: "lfa_pearl_yellow" },
      { name: "Pearl Blue",     hex: "#35589E", modelKey: "lfa_pearl_blue" },
      { name: "Matte Black",    hex: "#141518", modelKey: "lfa_matte_black" },
    ],
  },
  // Generated coupe, neutral grey — colours come from live model tint (dark
  // glass/wheels barely take tint, so the body carries the colour). No lit
  // variant (single baked material). Day model after dark is the accepted v1.
  muscle: {
    baseUrl: "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models/out_class_muscle.glb",
    palette: [
      { name: "Graphite",   hex: "#6B6E72" },
      { name: "Rally Red",  hex: "#C8102E" },
      { name: "White",      hex: "#F2F2EF" },
      { name: "Petrol Blue",hex: "#2E64B8" },
      { name: "Black",      hex: "#17191C" },
      { name: "Verde",      hex: "#3E8E4E" },
    ],
  },
};
