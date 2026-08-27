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
import type { VehicleClass } from "./settings";

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


// ── The 2D paint-picker palettes (Jeff 2026-08-27: "each class has the main
// colors from the popular models/makes… as well as black, white, gray, red") ──
//
// This is what Garage → Class actually shows — the flat 20-swatch PAINT_COLORS
// list is retired for classes with a row here (Arrow keeps it; it isn't a
// class). Same doctrine as the 3D palettes above: real factory paint names
// from the class's popular marques, core colours covered. These are hex-only
// swatches for the runtime-tinted top-down sprite — completely separate from
// CLASS_MODEL_3D, whose rows stay authored-models-only.
//
// Every name below was web-verified as a REAL factory paint of the stated
// marque (2026-08-27 research pass, adversarially fact-checked; factory paint
// codes exist for all of them). Hexes are good-faith sRGB approximations —
// published database values where they exist, pixel-sampled factory chips or
// Commons photos where they don't. Entries WITHOUT modelKey are picker-only
// hexes; the 3D bakes for the hatch/supercar/exotic additions stay queued.
//
// Cross-class consistency: the same physical paint keeps ONE hex everywhere —
// Nardo Grey (#8E9492 — NOT the widely-reposted #C0C6C8, which is actually
// Audi Suzuka Gray), Hydro Blue Pearl (#2E7DBC), Granite Crystal (#565A5F),
// Cyber Orange (#E8781E).

// Renault/Ford/Subaru queued bakes + Jeff's 8/27 marques (Peugeot, Citroën).
const HATCH_SWATCH_ADDITIONS: ClassPaletteEntry[] = [
  { name: "Liquid Yellow",  hex: "#F4BC02" }, // Renault Sport Clio, J37
  { name: "Nitrous Blue",   hex: "#1351D8" }, // Ford Focus RS Mk3
  { name: "WR Blue Pearl",  hex: "#4B6FB5" }, // Subaru WRX/STI, 02C/K7X
  { name: "Ultimate Green", hex: "#97AA53" }, // Ford Focus RS Mk2, 9GFE5ZA
  { name: "Orange Mango",   hex: "#FB8F00" }, // Citroën Saxo, KHN
  { name: "Sorrento Green", hex: "#14332B" }, // Peugeot 205 GTI, ERM (hex lifted from the #071316 chip so it reads green, not black)
  // Verified but CUT for hue duplication: Ginster Yellow (VW Golf GTI, ≈Liquid
  // Yellow) and Championship White (Civic Type R NH-0, ≈Icecap White).
];

// The legend-paint gap fillers from the 8/20 notes (yellow/orange/purple).
const SUPERCAR_SWATCH_ADDITIONS: ClassPaletteEntry[] = [
  { name: "Nardo Grey",       hex: "#8E9492" }, // Audi, LY7C
  { name: "Rosso Corsa",      hex: "#D40000" }, // Ferrari
  { name: "Giallo Modena",    hex: "#FCE903" }, // Ferrari
  { name: "Verde Mantis",     hex: "#7DC23B" }, // Lamborghini, L0L6
  // LV4/LX0's colour-flip can't live in one hex; the grounded #280137 reads
  // BLACK at swatch size, so this is the deliberate daylight flip tone.
  { name: "Midnight Purple",  hex: "#3A2A5D" }, // Nissan Skyline GT-R
  { name: "Riviera Blue",     hex: "#018ADA" }, // Porsche 993, 39E
  { name: "Arancio Borealis", hex: "#FBA400" }, // Lamborghini, L0E2
];

const EXOTIC_SWATCH_ADDITIONS: ClassPaletteEntry[] = [
  { name: "Rosso Corsa",         hex: "#D40000" }, // Ferrari
  { name: "Verde Mantis",        hex: "#7DC23B" }, // Lamborghini
  { name: "Papaya Spark",        hex: "#FF8000" }, // McLaren 720S, 3965
  { name: "French Racing Blue",  hex: "#0072BB" }, // Bugatti Chiron Sport
  { name: "Grigio Telesto",      hex: "#7692A5" }, // Lamborghini, 0098
];

// SEDAN — sport-sedan scene: BMW M, AMG, Audi RS, Alfa, Lexus F, Cadillac V.
const SEDAN_PALETTE: ClassPaletteEntry[] = [
  { name: "Black Sapphire",     hex: "#101216" }, // BMW, 475
  { name: "Alpine White",       hex: "#F2F3F0" }, // BMW, 300
  { name: "Nardo Grey",         hex: "#8E9492" }, // Audi RS, LY7C
  { name: "Selenite Grey Magno",hex: "#75787B" }, // Mercedes-AMG C63 (matte)
  { name: "Rosso Competizione", hex: "#921219" }, // Alfa Giulia QV, PRZ
  { name: "Yas Marina Blue",    hex: "#2E6DB4" }, // BMW M3 F80, B68
  { name: "Ultrasonic Blue",    hex: "#1D4FA1" }, // Lexus F, 8X1
  { name: "Isle of Man Green",  hex: "#146C4C" }, // BMW M3 G80, C4G
  { name: "Austin Yellow",      hex: "#C3C93B" }, // BMW M3 F80, B67
  { name: "Blaze Orange",       hex: "#D96C2B" }, // Cadillac CT5-V Blackwing
  // Verified but CUT for hue duplication: Frozen Portimao Blue + Electric Blue.
];

// TRUCK — Jeff's marques: Ford, Dodge/RAM, Chevy (+ one Toyota TRD).
const TRUCK_PALETTE: ClassPaletteEntry[] = [
  { name: "Agate Black",      hex: "#0B0D10" }, // Ford F-150
  { name: "Oxford White",     hex: "#F0EFE9" }, // Ford F-150
  { name: "Silver Ice",       hex: "#9DA0A3" }, // Chevy Silverado
  { name: "Granite Crystal",  hex: "#565A5F" }, // Ram 1500, PAU
  { name: "Race Red",         hex: "#D6001C" }, // Ford F-150
  { name: "Red Hot",          hex: "#C00A26" }, // Chevy Silverado
  { name: "Velocity Blue",    hex: "#1E6CB5" }, // Ford F-150
  { name: "Northsky Blue",    hex: "#46688B" }, // Chevy Silverado
  { name: "Hydro Blue Pearl", hex: "#2E7DBC" }, // Ram 1500 TRX, PBJ
  { name: "Army Green",       hex: "#535F49" }, // Toyota TRD Pro
  { name: "Code Orange",      hex: "#DE6420" }, // Ford Raptor
  { name: "Baja Yellow",      hex: "#F9CE20" }, // Ram 1500 TRX
];

// ELECTRIC — Tesla core + the EV scene's signatures.
const ELECTRIC_PALETTE: ClassPaletteEntry[] = [
  { name: "Solid Black",      hex: "#0B0B0D" }, // Tesla, PBSB
  { name: "Pearl White",      hex: "#F2F3F5" }, // Tesla, PPSW
  { name: "Midnight Silver",  hex: "#45494E" }, // Tesla, PMNG
  { name: "Ultra Red",        hex: "#9B1420" }, // Tesla
  { name: "Deep Blue",        hex: "#20395C" }, // Tesla, PPSB
  { name: "Launch Green",     hex: "#4F5D51" }, // Rivian R1T
  { name: "Rivian Blue",      hex: "#2264A8" }, // Rivian R1T
  { name: "Compass Yellow",   hex: "#EDA842" }, // Rivian R1T
  { name: "Cyber Orange",     hex: "#E8781E" }, // Mustang Mach-E
  { name: "Frozen Blue",      hex: "#A9C4CE" }, // Porsche Taycan
  { name: "Digital Teal",     hex: "#26454A" }, // Hyundai Ioniq 5
  // Verified but CUT for hue duplication: Grabber Blue Metallic (Mach-E).
];

// JEEP — the JL/JT scene icons (+ one Bronco extra).
const JEEP_PALETTE: ClassPaletteEntry[] = [
  { name: "Black Clear Coat", hex: "#0B0B0C" }, // Wrangler, PX8
  { name: "Bright White",     hex: "#F4F6F5" }, // Wrangler, PW7
  { name: "Sting-Gray",       hex: "#6C716E" }, // Wrangler, PDN
  { name: "Granite Crystal",  hex: "#565A5F" }, // Gladiator, PAU
  { name: "Firecracker Red",  hex: "#B82428" }, // Wrangler, PRC
  { name: "Hydro Blue Pearl", hex: "#2E7DBC" }, // Wrangler, PBJ
  { name: "Sarge Green",      hex: "#5A6342" }, // Wrangler, PGG
  { name: "Gecko",            hex: "#6FA843" }, // Wrangler
  { name: "Tuscadero",        hex: "#DE4D8B" }, // Wrangler
  { name: "High Velocity",    hex: "#F2D22E" }, // Wrangler
  { name: "Snazzberry",       hex: "#6B2E3F" }, // Wrangler
  { name: "Cyber Orange",     hex: "#E8781E" }, // Ford Bronco
];

export const CLASS_SWATCHES: Partial<Record<VehicleClass, ClassPaletteEntry[]>> = {
  hatchback: [...CLASS_MODEL_3D.hatchback!.palette, ...HATCH_SWATCH_ADDITIONS],
  muscle: MUSCLE_PALETTE,
  supercar: [...CLASS_MODEL_3D.supercar!.palette, ...SUPERCAR_SWATCH_ADDITIONS],
  exotic: [...CLASS_MODEL_3D.exotic!.palette, ...EXOTIC_SWATCH_ADDITIONS],
  sedan: SEDAN_PALETTE,
  truck: TRUCK_PALETTE,
  electric: ELECTRIC_PALETTE,
  jeep: JEEP_PALETTE,
};

// The real paint name for a saved hex, if the class palette has it — the
// Garage preview line shows "Supersonic Red", not "#C0152A".
export function classPaintName(cls: string, hex?: string | null): string | undefined {
  if (!hex) return undefined;
  const h = hex.toLowerCase();
  return CLASS_SWATCHES[cls as VehicleClass]?.find((e) => e.hex.toLowerCase() === h)?.name;
}
