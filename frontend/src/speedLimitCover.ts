// speedLimitCover — where the posted-limit cache is COMPLETE, for src/speedLimit.ts. PURE (no React,
// no RN; the one import is a constant from the sibling pure module, with the extension so Node's
// resolver finds it — see tsconfig.json) so tools/sim-qc/speed_limit_cover_test.mts drives this
// exact code under Node.
//
// ── WHY (2026-09-22, Olaf's 14:31:39 UTC phantom tier-2 ding on Highway 17) ────────────────────────
// `speed-limit lim=80>50 near=24 cls=tertiary x=80@11m/179° crs=217 spd=92` → 2 s later
// `speed-alert tier=2 mode=ding over=44 limit=50`, southbound on Hwy 17 at ~49.1777,-122.9129.
// Live OSM there (Overpass, 2026-09-22): his own carriageway is a 250 m piece (way 904359585,
// motorway 80), the NE-bound carriageway beside it is ~1 km long (498148398, motorway 80 — the
// `x=80@11m/179°` the direction rule rightly rejected) and River Road (1181925454, tertiary 50) runs
// 24 m alongside. The cache that tick was the fetch that landed at 14:30:26.7, centred where the car
// was when it STARTED — by the 30 s-apart draw-cmp fixes that is ≥ 1.6 km from the 14:31:39 point
// (≈1646 m at the latest possible start, ≈2584 m at the earliest), i.e. past FETCH_RADIUS_M (1500). The long ways still
// poked into the old circle; the short piece of his own road did not. The snap then did exactly what
// it is told to: the nearest aligned tagged way within 30 m — a road BESIDE the car filling a hole
// in the cache. Ni GR carries the same signature on 09-16 23:46:04 (`100>30 … x=100@16m/179°`, the
// own carriageway back at 4 m 36 s later).
//
// THE RULE: a landed fetch is complete for the snap inside `fetch radius − SNAP_TOLERANCE_M` of the
// point it was centred on, and NOT outside it. Overpass `around:R` selects a way if any SEGMENT of it
// passes within R of the centre (measured 2026-09-22: `way(around:20,49.098868,-123.035551)[highway]`
// returns Hwy 99 way 381185362 whose nearest NODE is ≥ 400 m away and whose segment passes 15 m off).
// So a way within SNAP_TOLERANCE_M of a point ≤ R − 30 from the centre has a point ≤ R from the
// centre and is in the payload; inside that disc every way the snap could pick is present, outside it
// only the long ways that happen to cross the circle are. Beyond the disc the honest answer is "no
// sign", never a neighbour's limit. The margin is DERIVED (1500 − 30 = 1470), not tuned: both numbers
// are ones Jeff already approved, and there is no third.
//
// The disc is keyed on the last LANDED fetch, never on the refetch trigger (`_center` in
// speedLimit.ts, which a failed fetch nulls): a driver stopped on a good cache through an Overpass
// outage is at distance 0 and keeps the sign.
//
// ── OUTSIDE THE DISC THE SIGN MAY ONLY CONTINUE (review, same day) ──────────────────────────────
// "Blank beyond 1470 m" alone was measured against the mirrors' health on 2026-09-22 (overpass-api.de
// 200 on 4 of 11 of the app's own queries, 504 ×5, 429 ×1; the other two mirrors unreachable): a straight
// motorway at 90 km/h went blank 200 of 480 ticks (five 47 s / 1175 m runs in 8 min) against 3 of 480 on
// the old code, because the LONG motorway pieces the car is actually on are still in the old payload — the
// disc threw away a right answer along with the wrong ones. So outside the disc the snap still runs, and its
// answer is kept exactly when it CONTINUES the limit the sign showed inside the disc. The phantom is, by
// definition, a DIFFERENT limit appearing from a road beside the hole (Olaf: 80 → 50; Ni GR: 100 → 30); a
// continued limit cannot ding, because the over-limit arithmetic sees the number it already had. The class
// is deliberately not compared: a residential 50 giving way to a tertiary 50 is the same sign, and the
// only thing at stake outside the disc is the NUMBER. A legitimate change of limit out there (100 → 80 at
// a zone boundary) waits for a fetch that covers the car — one cycle, ≤ ~30 s — shown as no sign, never
// as a guess.

/** What the snap resolved the last time the car was INSIDE the disc: the number the sign showed. */
export type CoverSnap = { limitKmh: number | null };

/** Outside the disc: true when `next` continues the limit the sign already showed inside it. */
export function continuesCover(prev: CoverSnap | null, next: CoverSnap | null): boolean {
  return prev != null && prev.limitKmh != null && next != null && next.limitKmh === prev.limitKmh;
}

import { SNAP_TOLERANCE_M } from "./speedLimitSnap.ts";

/** The centre a fetch was asked for (the fetch-START position, not where the car was when it landed) and its radius. */
export type Cover = { lat: number; lng: number; radiusM: number };

/** The radius inside which a fetch of `fetchRadiusM` is complete for the snap: 1500 − 30 = 1470 m. */
export function coverRadiusM(fetchRadiusM: number): number {
  return fetchRadiusM - SNAP_TOLERANCE_M;
}

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Metres from the cover's centre to the point; Infinity when nothing has landed yet. */
export function coverDistM(cover: Cover | null, lat: number, lng: number): number {
  return cover ? haversineM(cover.lat, cover.lng, lat, lng) : Infinity;
}

/** True when the last landed fetch is complete for a snap at this point. */
export function isCovered(cover: Cover | null, lat: number, lng: number): boolean {
  return cover != null && coverDistM(cover, lat, lng) <= coverRadiusM(cover.radiusM);
}
