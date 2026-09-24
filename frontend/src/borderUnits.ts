// borderUnits.ts — which speed unit the car's OWN POSITION implies, with no network call.
// (Jeff, 2026-09-24: "go ship the border rule" — replaces a Google Geocoding lookup that had never
// been enabled on the project, so the units had never auto-switched for anyone; a network call
// would also fail at exactly the moment it matters, at Peace Arch with data roaming off.)
//
// West of Lake of the Woods the whole Canada–US border is the 49th parallel, so latitude decides:
//   * −123.1° … −95.2° (the BC mainland east of Point Roberts, through Manitoba): south of 49° → mph,
//     north → km/h, with a ±0.002° (~220 m) dead band because 0 Avenue in Surrey / Langley /
//     Abbotsford runs along the line and GPS noise must not flip the tile back and forth. Point
//     Roberts (US, south of 49° between −123.1° and −123.0°) sits in this stretch and reads mph.
//   * west of −123.1°: Vancouver Island, the Gulf Islands and the BC coast are Canada above 48.30°;
//     the Olympic Peninsula, Oregon and the California coast are US below it. Known misses: the
//     Neah Bay corner of Washington (above 48.30°) and the Alaska panhandle read km/h.
//   * east of −95.2° the border is irregular, so only the unambiguous latitudes decide: above 49.4°
//     (north of the Northwest Angle) → km/h, below 41.68° (south of Pelee Island) → mph; the band
//     between (Toronto, Detroit, Montreal, Boston, Chicago…) keeps whatever the unit already is.
//   * south of 32.75° west of −97° (the Mexican border zone) and south of 21.7° anywhere: keep.
// Pure on purpose — tools/sim-qc/border_units_test.mts pins every case above.
export type SpeedUnit = "kmh" | "mph";

export const BORDER_LAT = 49.0;
export const BORDER_BAND_DEG = 0.002;
export const POINT_ROBERTS_MERIDIAN = -123.1;
export const LAKE_OF_THE_WOODS_MERIDIAN = -95.2;
export const JUAN_DE_FUCA_LAT = 48.3;
export const NORTHWEST_ANGLE_LAT = 49.4;
export const PELEE_ISLAND_LAT = 41.68;
export const MEXICO_ZONE_LAT = 32.75;
export const MEXICO_ZONE_LNG = -97.0;
export const SOUTH_LIMIT_LAT = 21.7;

/** Which side of the Canada–US border the position is on, or null where the rule can't say. */
export function borderSide(lat: number, lng: number): "us" | "ca" | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < SOUTH_LIMIT_LAT) return null;
  if (lat < MEXICO_ZONE_LAT && lng < MEXICO_ZONE_LNG) return null;
  if (lng > LAKE_OF_THE_WOODS_MERIDIAN) {
    if (lat > NORTHWEST_ANGLE_LAT) return "ca";
    if (lat < PELEE_ISLAND_LAT) return "us";
    return null;
  }
  if (lng < POINT_ROBERTS_MERIDIAN) return lat < JUAN_DE_FUCA_LAT ? "us" : "ca";
  if (lat < BORDER_LAT - BORDER_BAND_DEG) return "us";
  if (lat > BORDER_LAT + BORDER_BAND_DEG) return "ca";
  return null;
}

/** The unit the position implies; `current` is kept wherever the rule can't decide. */
export function borderUnit(lat: number, lng: number, current: SpeedUnit): SpeedUnit {
  const side = borderSide(lat, lng);
  return side === "us" ? "mph" : side === "ca" ? "kmh" : current;
}
