// Gas Jockey — shared brand list + octane mapping for the "Gas" category.
//
// Used by BOTH the Settings "Gas Jockey" section (renders a toggle per brand +
// an octane radio) and CategoryPills' gas search (filters the pins). Keeping
// the brand list here means the UI and the filter can never drift apart.
//
// The goal is decluttering the map's Gas pins: a driver picks their favorite
// chains (and optionally their octane), and stations that don't match are
// hidden. With everything left ON (the default) nothing is filtered, so the
// behavior only changes once the driver customizes it.

export type GasBrand = { key: string; label: string; match: string[] };

// Canada-first (the test fleet drives BC) plus the major North-American
// chains. `match` strings are lowercased substrings tested against a station's
// Places displayName. Add/remove freely — the Settings UI and the filter both
// read from this one list.
export const GAS_BRANDS: GasBrand[] = [
  { key: "shell",        label: "Shell",         match: ["shell"] },
  { key: "chevron",      label: "Chevron",       match: ["chevron"] },
  { key: "petrocan",     label: "Petro-Canada",  match: ["petro-canada", "petro canada", "petrocan"] },
  { key: "esso",         label: "Esso",          match: ["esso"] },
  { key: "husky",        label: "Husky",         match: ["husky"] },
  { key: "mobil",        label: "Mobil",         match: ["mobil"] },
  { key: "coop",         label: "Co-op",         match: ["co-op", "co op", "coop"] },
  { key: "costco",       label: "Costco",        match: ["costco"] },
  { key: "canadiantire", label: "Canadian Tire", match: ["canadian tire", "gas+", "gas plus"] },
  { key: "ultramar",     label: "Ultramar",      match: ["ultramar"] },
  { key: "pioneer",      label: "Pioneer",       match: ["pioneer"] },
  { key: "circlek",      label: "Circle K",      match: ["circle k", "circlek"] },
];

// Bucket key for stations whose name matches none of the known brands above
// (unbranded / independent stations). Toggled by the "Other" switch.
export const GAS_OTHER_KEY = "other";

// Resolve a station's display name to a known brand key, or null when it's
// unbranded / unrecognized (those fall under the "Other" bucket).
export function matchBrandKey(name?: string): string | null {
  const n = (name || "").toLowerCase();
  if (!n) return null;
  for (const b of GAS_BRANDS) {
    if (b.match.some((m) => n.includes(m))) return b.key;
  }
  return null;
}

// Octane choices, highest first (matches how pumps are usually listed).
export const OCTANES = ["94", "91", "89", "87"] as const;
export type Octane = (typeof OCTANES)[number];

// Map a North-American octane (AKI) to the Google `fuelOptions` fuel-type enum
// values that represent it. Google's NA data is mostly REGULAR_UNLEADED (87),
// MIDGRADE (89) and PREMIUM (91–93); the higher-RON Euro types (SP95/98/99/100)
// are folded in as best-effort matches where present. 94 (e.g. Chevron /
// Petro-Canada "Ultra 94") has no distinct Google enum, so it maps to the
// premium / high-octane types.
export function octaneFuelTypes(o: Octane): string[] {
  switch (o) {
    case "87": return ["REGULAR_UNLEADED"];
    case "89": return ["MIDGRADE"];
    case "91": return ["PREMIUM", "SP95", "SP98"];
    case "94": return ["PREMIUM", "SP98", "SP99", "SP100"];
  }
  return [];
}

// Does this station offer the requested octane?
//   true  — a matching fuel type is listed
//   false — fuel types are listed but none match
//   null  — no fuel-price data at all (unknown; the caller keeps unknowns so
//           the map doesn't go empty when Google returns no fuel data)
export function stationHasOctane(fuelOptions: any, o: Octane): boolean | null {
  const prices = fuelOptions?.fuelPrices;
  if (!Array.isArray(prices) || prices.length === 0) return null;
  const want = new Set(octaneFuelTypes(o));
  return prices.some((f: any) => want.has(f?.type));
}

// Decide whether a station passes the current Gas Jockey filters.
//   brands  — persisted Record<brandKey, boolean>; undefined = no brand filter
//   showOther — whether unbranded stations are shown
//   octane  — selected octane, or null for "all octanes"
// A brand key missing from `brands` defaults to visible, so turning one chain
// OFF never hides the others.
export function passesGasFilters(
  name: string | undefined,
  fuelOptions: any,
  brands: Record<string, boolean> | undefined,
  showOther: boolean,
  octane: Octane | null,
): boolean {
  if (brands) {
    const key = matchBrandKey(name);
    const brandVisible = key ? brands[key] !== false : showOther;
    if (!brandVisible) return false;
  }
  if (octane) {
    const has = stationHasOctane(fuelOptions, octane);
    if (has === false) return false; // fuels listed, none match → hide
  }
  return true;
}
