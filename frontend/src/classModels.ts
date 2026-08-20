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

export const CLASS_MODEL_3D: Partial<Record<string, ClassModel3D>> = {
  // The GR Corolla palette, verbatim — modelKey routes to the authored GLBs.
  hatchback: {
    palette: [
      { name: "Heavy Metal",    hex: "#6B6E72", modelKey: "heavy_metal" },
      { name: "Supersonic Red", hex: "#C0152A", modelKey: "supersonic_red" },
      { name: "Icecap White",   hex: "#F0F0F0", modelKey: "ice_cap_white" },
      { name: "Blue Flame",     hex: "#0099D8", modelKey: "blue_flame" },
      { name: "Black Onyx",     hex: "#1A1A1A", modelKey: "precious_black_pearl" },
    ],
  },
  // muscle / sedan / supercar / truck / suv: generic unbranded models in
  // authoring (text-to-3D through the glb-pipeline, same QC gate). Each gets
  // { baseUrl, palette: shared 20-swatch tint list } when its bake passes.
};
