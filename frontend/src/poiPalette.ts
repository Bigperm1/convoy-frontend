// poiPalette.ts — one colour family per search category, shared by the map pins, the category chips
// and the results rows so pin ↔ chip ↔ row read as one system (Jeff, 2026-09-23, off a Mapbox
// screenshot: "i do like the contrast colours" — and, on the first attempt that put a glyph in the
// pin, "it looks nothing like the screenshot"). The reference: a SMALL solid teardrop in the DEEP
// shade with a white number, no glyph; the glyph and the BRIGHT shade live on the chip and the row.
//
// Two shades per category, measured in tools/poi-pins/bake.py (CIE76): bright = chip ring + glyph +
// row badge; deep = the pin fill, same hue at L 0.24. Every bright pair ≥ 12 ΔE apart, every deep pair
// ≥ 10 (Car Wash and Auto Parts were nudged off EV / Car Repair to get there). Hazard, roadwork and
// camera pins stay thin NeonPin outlines, so a category pin never reads as one of those by form alone.
// Keys are CategoryPills' category keys. Re-bake, never hand-edit a hex: the bake is the source.

export type PoiCategory =
  | "gas" | "food" | "coffee" | "carwash" | "repair" | "parking" | "ev"
  | "parts" | "grocery" | "pharmacy" | "atm" | "hotel" | "fastfood" | "hospital";

export type PoiColors = { bright: string; deep: string };

export const POI_PALETTE: Record<PoiCategory, PoiColors> = {
  gas:      { bright: "#F5891F", deep: "#753D05" },
  coffee:   { bright: "#C98A4B", deep: "#5E3D1C" },
  fastfood: { bright: "#FFC72C", deep: "#7A5A00" },
  atm:      { bright: "#B5E23A", deep: "#526B10" },
  grocery:  { bright: "#57D163", deep: "#1A6021" },
  pharmacy: { bright: "#2EC4A6", deep: "#176354" },
  ev:       { bright: "#1FC4DE", deep: "#0F5F6B" },
  carwash:  { bright: "#5FCBF6", deep: "#075574" },
  parking:  { bright: "#3B82F6", deep: "#053075" },
  repair:   { bright: "#8B7CF6", deep: "#150873" },
  parts:    { bright: "#B055F7", deep: "#440675" },
  hotel:    { bright: "#D946EF", deep: "#630A71" },
  food:     { bright: "#FF6FA5", deep: "#AD0041" },   // coral-pink, not brick-red — "move food to coral pink" (Jeff, 2026-09-23, off the real render); deep at L 0.34 so the pink survives on the dark map
  hospital: { bright: "#FF4D6D", deep: "#7A0016" },
};

/** A result with no category (never today — every search pin comes from a chip) draws in neutral slate. */
export const POI_NEUTRAL: PoiColors = { bright: "#9BA8B8", deep: "#2B3340" };

export const POI_CATEGORIES = Object.keys(POI_PALETTE) as PoiCategory[];

export function isPoiCategory(k: unknown): k is PoiCategory {
  return typeof k === "string" && k in POI_PALETTE;
}

export function poiColors(cat: string | undefined): PoiColors {
  return isPoiCategory(cat) ? POI_PALETTE[cat] : POI_NEUTRAL;
}
