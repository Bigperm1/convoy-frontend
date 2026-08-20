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
// Palette doctrine (Jeff 8/20 night): every class palette (1) covers the core
// colours — black/white/grey/red/blue/green and the scene's signatures — and
// (2) names every swatch after a REAL paint from that class's marques.
// hex = swatch/intent; the tint multiplier sent to the model runs ~2x hot
// because it MULTIPLIES a mid-grey texture.

// MUSCLE — Mopar/Ford/Chevy heritage (Camaro/Challenger/Mustang, Jeff's call).
export const MUSCLE_PALETTE: ClassPaletteEntry[] = [
  { name: "Pitch Black",     hex: "#17191C" },
  { name: "Wimbledon White", hex: "#F4F1E4" },
  { name: "Lead Foot Grey",  hex: "#7D8083" },
  { name: "TorRed",          hex: "#D2232A" },
  { name: "Grabber Blue",    hex: "#1E90D6" },
  { name: "B5 Blue",         hex: "#3B9EE2" },
  { name: "Rally Green",     hex: "#3F5C48" },
  { name: "Plum Crazy",      hex: "#6C3082" },
  { name: "Go Mango",        hex: "#E96B23" },
  { name: "Sublime",         hex: "#8CC63E" },
];

// SUPERCAR additions to the GT3 RS factory seven (bakes queued): Nardo Grey,
// Rosso Corsa, Giallo Modena, Verde Mantis, Midnight Purple, Riviera Blue,
// Arancio Borealis — fills the yellow/orange/purple gaps with legend paints.
// HOT HATCH additions to the GRC six (bakes queued): Liquid Yellow (Renault),
// Nitrous Blue (Focus RS), WR Blue Pearl (Subaru), Ultimate Green (Focus RS).
// EXOTIC additions to the LFA five (bakes queued): Rosso Corsa, Verde Mantis,
// Papaya Spark (McLaren), French Racing Blue (Bugatti), Grigio Telesto (Lambo).

export const CLASS_MODEL_3D: Partial<Record<string, ClassModel3D>> = {
  hatchback: {
    palette: [
      { name: "Heavy Metal",    hex: "#6B6E72", modelKey: "heavy_metal" },
      { name: "Supersonic Red", hex: "#C0152A", modelKey: "supersonic_red" },
      { name: "Icecap White",   hex: "#F0F0F0", modelKey: "ice_cap_white" },
      { name: "Blue Flame",     hex: "#0099D8", modelKey: "blue_flame" },
      { name: "Black Onyx",     hex: "#1A1A1A", modelKey: "precious_black_pearl" },
      // The GRMN paint, real name kept (Jeff 8/20: "not sure if we can use the
      // exact names but lets do it anyways").
      { name: "Gravel",         hex: "#565E5F", modelKey: "gravel" },
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
  // Generated coupe with surgically dark wheels (wheels_dark.py — flood-fill
  // from measured axle centres; whole-model tint leaves them gunmetal). No lit
  // variant (single baked material). Day model after dark is the accepted v1.
  muscle: {
    baseUrl: "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models/out_class_muscle2.glb",
    palette: MUSCLE_PALETTE,
  },
};
