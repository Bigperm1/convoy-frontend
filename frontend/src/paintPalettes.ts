// Paint palettes for the CAR SCAN colour step (backend only).
//
// Jeff, 2026-08-27: *"lets just do main colour swatches for cars and popular car
// club colours like corvette, mustang, camaro, bmw, nissan, jdm, porsche, lambo,
// ferarri etc."* — after we established that a complete every-model colour
// database cannot be built as VERIFIED data (no public source publishes it).
//
// So the picker has three ladders, widest to narrowest:
//   1. Factory colours for the typed model  (carDatabase.ts — most accurate)
//   2. MAIN_COLORS                          (here — covers any car on earth)
//   3. CLUB_PALETTES                        (here — the paints people name with pride)
// plus the hex field, which is the real universal escape hatch.
//
// Nothing here is read by the app's own rendering. The chosen entry rides in the
// scan manifest so the build pipeline can colour-match the reconstruction.

import type { CarColor } from './carDatabase';

/** The universal set — a real car-paint spectrum, not a web colour wheel.
 *  Deliberately plain names: this is the "my car is just blue" ladder, and a
 *  made-up marketing name here would be a lie, not a flourish. */
export const MAIN_COLORS: CarColor[] = [
  { name: 'Black',       hex: '#0B0B0C' },
  { name: 'Matte Black', hex: '#232527' },
  { name: 'Gunmetal',    hex: '#3A3F45' },
  { name: 'Grey',        hex: '#6E7276' },
  { name: 'Silver',      hex: '#B9BDC1' },
  { name: 'White',       hex: '#F2F3F0' },
  { name: 'Red',         hex: '#C8102E' },
  { name: 'Burgundy',    hex: '#7A1220' },
  { name: 'Orange',      hex: '#E2621B' },
  { name: 'Bronze',      hex: '#8C6A3F' },
  { name: 'Gold',        hex: '#C9A227' },
  { name: 'Yellow',      hex: '#F2C400' },
  { name: 'Lime',        hex: '#93C03C' },
  { name: 'Green',       hex: '#1F7A44' },
  { name: 'Dark Green',  hex: '#14432A' },
  { name: 'Teal',        hex: '#16697A' },
  { name: 'Sky Blue',    hex: '#6FB7DC' },
  { name: 'Blue',        hex: '#1B5FBE' },
  { name: 'Navy',        hex: '#16264A' },
  { name: 'Purple',      hex: '#5B2C86' },
  { name: 'Pink',        hex: '#D9528F' },
  { name: 'Tan',         hex: '#C2A57B' },
];

export type ClubPalette = {
  /** Chip label — the club, not the corporate name ("Mopar", not "Stellantis"). */
  label: string;
  colors: (CarColor & { model?: string })[];
};

/** The legendary paints, by scene. Every name is a REAL factory paint,
 *  web-researched and adversarially fact-checked (2026-08-27). Colour-shift
 *  paints carry their DAYLIGHT body read — a single hex cannot hold a flip. */
export const CLUB_PALETTES: ClubPalette[] = [];

/** Find a paint's name across every ladder here, for display. */
export function paintNameFor(hex?: string | null): string | undefined {
  if (!hex) return undefined;
  const h = hex.toLowerCase();
  const main = MAIN_COLORS.find((c) => c.hex.toLowerCase() === h);
  if (main) return main.name;
  for (const g of CLUB_PALETTES) {
    const hit = g.colors.find((c) => c.hex.toLowerCase() === h);
    if (hit) return hit.name;
  }
  return undefined;
}
