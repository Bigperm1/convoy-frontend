// hazardPalette.ts — the crew-report kinds as a colour family, borrowed from the search categories so a
// hazard pin, its Report tile, its confirmation pill and its card read as ONE system with the place pins
// (Jeff, 2026-09-25: "follow the same look as the food/gas/car wash etc icon border and colours.
// Police - ev charging colours · Crash - hospital colours · Hazard - fast food colours · Traffic - gas colours").
// Pure: no React, no native — tools/sim-qc/hazard_panel_test.mts loads it under plain Node.
import { POI_PALETTE, type PoiCategory, type PoiColors } from "./poiPalette";
import type { HazardGlyph } from "./carplay/hazardPanel";

export type HazardPaintGlyph = Exclude<HazardGlyph, "hz_camera" | "hz_hazard_candy">;
export type HazardPaint = { kind: string; cat: PoiCategory; label: string; glyph: HazardPaintGlyph } & PoiColors;

const MAP: Record<string, { cat: PoiCategory; label: string; glyph: HazardPaintGlyph }> = {
  police:   { cat: "ev",       label: "Police",  glyph: "hz_police" },
  accident: { cat: "hospital", label: "Crash",   glyph: "hz_crash" },
  road:     { cat: "fastfood", label: "Hazard",  glyph: "hz_hazard" },
  traffic:  { cat: "gas",      label: "Traffic", glyph: "hz_traffic" },
};
const FALLBACK = MAP.road;

/** Colours, label and glyph for a report kind. Unknown kinds draw as a road hazard. */
export function hazardPaint(kind: string | null | undefined): HazardPaint {
  const m = (kind && MAP[kind]) || FALLBACK;
  return { kind: kind && MAP[kind] ? kind : "road", ...m, ...POI_PALETTE[m.cat] };
}
export const HAZARD_PAINT_KINDS = Object.keys(MAP);
/** The registered Mapbox image name of a kind's pin (src/hazardPinImages.ts holds every one). */
export function hazardPinImageName(kind: string | null | undefined): string { return `hz_pin_${hazardPaint(kind).kind}`; }
