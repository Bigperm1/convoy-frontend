// speed_limit_cover_test — gate for src/speedLimitCover.ts: the posted-limit cache is only complete
// near where it was fetched. Run: node --experimental-strip-types tools/sim-qc/speed_limit_cover_test.mts
//
// Olaf, 2026-09-22 14:31:39 UTC (07:31 PDT), southbound on Highway 17 at 92 km/h:
//   `speed-limit lim=80>50 near=24 cls=tertiary x=80@11m/179° crs=217 spd=92` → 14:31:41
//   `speed-alert tier=2 mode=ding over=44 limit=50 episode=3`.
// The fetch he was running on landed at 14:30:26.7 and was centred where the car was when it STARTED —
// by the draw-cmp fixes (30 s apart, interpolated) that is ≥ 1618 m from the 14:31:39 point at the LATEST
// possible start, past FETCH_RADIUS_M 1500. The ~1 km NE-bound carriageway (498148398) and River Road
// (1181925454 / 371969219) poked into that circle; the 250 m piece of his own carriageway (904359585) did
// not. Section O replays that on live OSM geometry (Overpass, 2026-09-22) and asserts BOTH halves: the snap
// alone still says 50 (so the ding was the snap doing its job on a hole) and the cover rule is what stops it.
// N is the cost and the must-not-blank cases, G the honest drops that must keep resolving, B the KNOWN-OPEN
// mechanism this fix does not touch (an untagged ramp beside a tagged minor road — Olaf 14:41:59).
//
// src/speedLimit.ts composes these: `_cover` = the last LANDED fetch's centre + FETCH_RADIUS_M; `_resolveAt`
// snaps everywhere, remembers the number the sign showed while isCovered(), and outside the disc keeps the snap
// only while continuesCover() says it is the same number — anything else is null with one `speed-cover out`
// row. Section C is that rule: the review measured "blank beyond 1470 m" alone at 200/480 ticks on a straight
// motorway under 2026-09-22's mirror health, because the long piece the car is ON was still in the payload.
import { coverRadiusM, coverDistM, isCovered, continuesCover, type Cover } from "../../src/speedLimitCover.ts";
import { snapSpeedLimit, SNAP_TOLERANCE_M, type LimitWay } from "../../src/speedLimitSnap.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
const FETCH_RADIUS_M = 1500;                 // src/speedLimit.ts — pinned here so a change there shows up as a diff in two places
const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180, toDeg = (r: number) => (r * 180) / Math.PI;
// a point `distM` metres from (lat,lng) along `hdgDeg` (equirectangular; exact for due north, sub-metre at street scale)
const dest = (lat: number, lng: number, hdgDeg: number, distM: number) => ({
  lat: lat + toDeg((distM * Math.cos(toRad(hdgDeg))) / R),
  lng: lng + toDeg((distM * Math.sin(toRad(hdgDeg))) / (R * Math.cos(toRad(lat)))),
});
// a way as a straight line through (lat,lng) with a heading, ±len m
const line = (lat: number, lng: number, hdgDeg: number, lenM: number, maxspeedKmh: number, extra: Partial<LimitWay> = {}): LimitWay =>
  ({ maxspeedKmh, geom: [dest(lat, lng, hdgDeg, -lenM), { lat, lng }, dest(lat, lng, hdgDeg, lenM)], ...extra });
// a way `offM` metres to the RIGHT of a car at (lat,lng) on course `crs` (negative = left), drawn along `wayHdg`
const beside = (lat: number, lng: number, crs: number, offM: number, wayHdg: number, maxspeedKmh: number, extra: Partial<LimitWay> = {}): LimitWay => {
  const p = dest(lat, lng, crs + 90, offM);
  return line(p.lat, p.lng, wayHdg, 200, maxspeedKmh, extra);
};
const fmt = (r: ReturnType<typeof snapSpeedLimit>) => `lim=${r.limitKmh} near=${Number.isFinite(r.nearestM) ? r.nearestM.toFixed(1) : "∞"} cls=${r.highway} x=${r.crossing ? `${r.crossing.limitKmh}@${r.crossing.distM.toFixed(1)}m/${r.crossing.diffDeg.toFixed(0)}°` : "-"}`;

console.log("V. the margin is derived, not tuned");
{
  ok("V1 coverRadiusM(1500) === 1470 === FETCH_RADIUS_M − SNAP_TOLERANCE_M (Overpass around: = SEGMENT distance — way 381185362 came back at around:20 of 49.098868,-123.035551 with its nodes ≥ 400 m away)",
    coverRadiusM(FETCH_RADIUS_M) === 1470 && coverRadiusM(FETCH_RADIUS_M) === FETCH_RADIUS_M - SNAP_TOLERANCE_M, `got ${coverRadiusM(FETCH_RADIUS_M)}`);
  ok("V2 no cover yet → distance Infinity, not covered", coverDistM(null, 49, -123) === Infinity && !isCovered(null, 49, -123));
}

console.log("O. Olaf 2026-09-22 14:29–14:32 UTC, Highway 17 southbound — live OSM geometry (Overpass 2026-09-22)");
{
  // Ways within 45 m of the 14:31:39 point. maxspeed=80 on all Hwy 17 pieces; River Road tertiary 50 two-way.
  const ne80: LimitWay = { maxspeedKmh: 80, oneway: true, highway: "motorway", geom: [{ lat: 49.1730873, lng: -122.9170443 }, { lat: 49.1735748, lng: -122.9166034 }, { lat: 49.1740737, lng: -122.9161576 }, { lat: 49.1758839, lng: -122.9145427 }, { lat: 49.1763957, lng: -122.9140729 }, { lat: 49.1769144, lng: -122.9135559 }, { lat: 49.1776771, lng: -122.9127114 }, { lat: 49.1780901, lng: -122.9122579 }, { lat: 49.1788517, lng: -122.9113324 }, { lat: 49.1794705, lng: -122.9106416 }, { lat: 49.1801293, lng: -122.9099597 }, { lat: 49.1806229, lng: -122.9094645 }, { lat: 49.1806704, lng: -122.9094179 }] };   // 498148398 NE-bound, ~1 km
  const own80: LimitWay = { maxspeedKmh: 80, oneway: true, highway: "motorway", geom: [{ lat: 49.1778635, lng: -122.9126565 }, { lat: 49.17773, lng: -122.9128142 }, { lat: 49.1769715, lng: -122.9136469 }, { lat: 49.1764478, lng: -122.9141763 }, { lat: 49.1759382, lng: -122.9146388 }] };   // 904359585 SW-bound, 250 m — Olaf's
  const river50: LimitWay = { maxspeedKmh: 50, oneway: false, highway: "tertiary", geom: [{ lat: 49.1771185, lng: -122.9131162 }, { lat: 49.1772591, lng: -122.9129658 }, { lat: 49.177717, lng: -122.9124349 }, { lat: 49.1787777, lng: -122.9111675 }, { lat: 49.178898, lng: -122.911037 }, { lat: 49.1794992, lng: -122.9103806 }, { lat: 49.1800808, lng: -122.9097687 }, { lat: 49.1805548, lng: -122.9092719 }, { lat: 49.1805977, lng: -122.9092272 }, { lat: 49.1808341, lng: -122.9089732 }, { lat: 49.1809509, lng: -122.908843 }, { lat: 49.1810663, lng: -122.9087063 }] };   // 1181925454
  const river50b: LimitWay = { maxspeedKmh: 50, oneway: false, highway: "tertiary", geom: [{ lat: 49.1723785, lng: -122.9158902 }, { lat: 49.1724514, lng: -122.9159041 }, { lat: 49.1730419, lng: -122.9160165 }, { lat: 49.1732965, lng: -122.9160497 }, { lat: 49.1735205, lng: -122.9160431 }, { lat: 49.1737547, lng: -122.9159936 }, { lat: 49.1740018, lng: -122.9159103 }, { lat: 49.1740565, lng: -122.9158796 }, { lat: 49.174228, lng: -122.9157833 }, { lat: 49.1743917, lng: -122.9156731 }, { lat: 49.1745391, lng: -122.9155416 }, { lat: 49.1748557, lng: -122.9152512 }, { lat: 49.1755002, lng: -122.914673 }, { lat: 49.1755604, lng: -122.9146192 }, { lat: 49.1762054, lng: -122.9140282 }, { lat: 49.1768426, lng: -122.9134136 }, { lat: 49.1771185, lng: -122.9131162 }] };   // 371969219
  const stale = [ne80, river50, river50b];                                              // what the 14:30:26 cache could hold here: 904359585 absent
  // The LATEST possible centre of the fetch that landed 14:30:26.7 (the car at 14:30:26, interpolated between the 14:30:12 and
  // 14:30:42 draw-cmp fixes). Any earlier start is further away still (14:29:40 → 2584 m).
  const f3: Cover = { lat: 49.18991, lng: -122.90018, radiusM: FETCH_RADIUS_M };
  const at1 = { lat: 49.17767, lng: -122.91291 };                                       // 14:31:39, 3 s before the 14:31:42 fix
  const d1 = coverDistM(f3, at1.lat, at1.lng);
  ok("O1a the 14:31:39 point is beyond the cover of the last landed fetch (≈1646 m > 1470)", !isCovered(f3, at1.lat, at1.lng) && d1 > 1470 && Math.abs(d1 - 1646) < 15, `d=${d1.toFixed(0)}`);
  const s1 = snapSpeedLimit(at1.lat, at1.lng, stale, 217, 92 / 3.6);
  ok("O1b …and the snap on the stale set STILL says 50: River Road ~24 m along the course, the NE carriageway 80@~11m/~179° rejected — the receipt, reproduced",
    s1.limitKmh === 50 && s1.highway === "tertiary" && Math.abs(s1.nearestM - 24) < 2 && s1.crossing?.limitKmh === 80 && Math.abs((s1.crossing?.distM ?? 0) - 11) < 2 && (s1.crossing?.diffDeg ?? 0) > 170, fmt(s1));
  ok("O1c so the cover rule, not the snap, is what stops the ding: outside the disc the limit is null", !isCovered(f3, at1.lat, at1.lng) ? true : false);
  const s1own = snapSpeedLimit(at1.lat, at1.lng, [...stale, own80], 217, 92 / 3.6);
  ok("O1d with his own carriageway in the payload the motorway's 80 wins at ~2 m — what a complete cache gives", s1own.limitKmh === 80 && s1own.highway === "motorway" && s1own.nearestM < 4, fmt(s1own));
  const at2 = { lat: 49.182274, lng: -122.908048 };                                     // the 14:31:12 fix
  ok("O2 the 14:31:12 fix (≈1024 m from the same centre) IS covered — the sign is not blanked before the edge", isCovered(f3, at2.lat, at2.lng) && Math.abs(coverDistM(f3, at2.lat, at2.lng) - 1024) < 15, `d=${coverDistM(f3, at2.lat, at2.lng).toFixed(0)}`);
  // The landing: `ahead-ingest` 14:32:14.919 then `speed-limit lim=?>80 near=3 cls=motorway x=80@12m/180° crs=219 spd=84` at 14:32:14.921.
  // A cycle is capped at ~3 × FETCH_TIMEOUT_MS, so the landing cycle started ≥ 14:31:44; its centre is taken as the 14:31:42 fix.
  const land: Cover = { lat: 49.177091, lng: -122.913552, radiusM: FETCH_RADIUS_M };
  const at3 = { lat: 49.170947, lng: -122.919847 };                                     // 14:32:14.9, interpolated between the 14:32:12 and 14:32:42 fixes
  const sw80: LimitWay = { maxspeedKmh: 80, oneway: true, highway: "motorway", geom: [{ lat: 49.1718378, lng: -122.9186201 }, { lat: 49.1707931, lng: -122.9199206 }, { lat: 49.1706619, lng: -122.9200828 }, { lat: 49.1702217, lng: -122.9206284 }, { lat: 49.1694309, lng: -122.9215858 }] };   // 498148396 SW-bound — Olaf's, here
  const ne80b: LimitWay = { maxspeedKmh: 80, oneway: true, highway: "motorway", geom: [{ lat: 49.1693676, lng: -122.9214659 }, { lat: 49.1699026, lng: -122.9208295 }, { lat: 49.1705382, lng: -122.9200535 }, { lat: 49.1717875, lng: -122.918525 }] };   // 498148390 NE-bound
  const s3 = snapSpeedLimit(at3.lat, at3.lng, [sw80, ne80b, ne80, own80, river50, river50b], 219, 84 / 3.6);
  // The field row read near=3 x=80@12m/180°; a point interpolated between fixes 30 s apart lands ~7 m off the carriageway, so
  // only what does not depend on sub-10 m interpolation is asserted: covered, 80, motorway, inside the tolerance.
  ok("O3 the landing resolve is inside its own cover (≈822 m) and snaps the motorway's 80 — the field row `?>80 cls=motorway`, untouched by the cover", isCovered(land, at3.lat, at3.lng) && Math.abs(coverDistM(land, at3.lat, at3.lng) - 822) < 15 && s3.limitKmh === 80 && s3.highway === "motorway" && s3.nearestM < SNAP_TOLERANCE_M, `d=${coverDistM(land, at3.lat, at3.lng).toFixed(0)} ${fmt(s3)}`);
  const c: Cover = { lat: 49.0, lng: -123.0, radiusM: FETCH_RADIUS_M };
  const in1470 = dest(c.lat, c.lng, 0, 1470), out1471 = dest(c.lat, c.lng, 0, 1471);
  ok("O4 the boundary pins the derivation: 1470.0 m due north is covered, 1471 m is not", isCovered(c, in1470.lat, in1470.lng) && !isCovered(c, out1471.lat, out1471.lng), `d=${coverDistM(c, in1470.lat, in1470.lng).toFixed(2)} / ${coverDistM(c, out1471.lat, out1471.lng).toFixed(2)}`);
}

console.log("S. stationary through an Overpass outage");
{
  const c: Cover = { lat: 49.2425, lng: -123.0038, radiusM: FETCH_RADIUS_M };
  ok("S1 the cover is the last LANDED fetch: at its centre the driver is covered whatever the refetch trigger is doing", isCovered(c, c.lat, c.lng) && coverDistM(c, c.lat, c.lng) === 0);
}

console.log("N. the edge: a legitimate sign near it stays, the declared cost beyond it, no blank while a refetch is in flight");
{
  const c: Cover = { lat: 49.2425, lng: -123.0038, radiusM: FETCH_RADIUS_M };
  const p1 = dest(c.lat, c.lng, 90, 1450);
  const z30 = [beside(p1.lat, p1.lng, 90, 20, 90, 30, { highway: "residential" })];   // a 30 zone 20 m beside a car 1450 m out
  const n1 = snapSpeedLimit(p1.lat, p1.lng, z30, 90, 45 / 3.6);
  ok("N1 a residential 30 at 1450 m from the last fetch centre: covered AND limit 30 (a school zone 1.45 km out still shows)", isCovered(c, p1.lat, p1.lng) && n1.limitKmh === 30, `d=${coverDistM(c, p1.lat, p1.lng).toFixed(0)} ${fmt(n1)}`);
  const p2 = dest(c.lat, c.lng, 90, 1480);
  const z30b = [beside(p2.lat, p2.lng, 90, 20, 90, 30, { highway: "residential" })];
  const n2 = snapSpeedLimit(p2.lat, p2.lng, z30b, 90, 45 / 3.6);
  ok("N2 the same 30 at 1480 m: NOT covered → the snap's 30 is kept only if the sign already showed 30 inside the disc (C1); after a 50 it is null with one `speed-cover out d=1480 r=1470 lim=50 saw=30/residential` row — the declared cost, never a neighbour's limit",
    !isCovered(c, p2.lat, p2.lng) && n2.limitKmh === 30 && Math.round(coverDistM(c, p2.lat, p2.lng)) === 1480 && coverRadiusM(c.radiusM) === 1470
    && continuesCover({ limitKmh: 30 }, { limitKmh: n2.limitKmh }) && !continuesCover({ limitKmh: 50 }, { limitKmh: n2.limitKmh }), `d=${coverDistM(c, p2.lat, p2.lng).toFixed(0)} ${fmt(n2)}`);
  const p3 = dest(c.lat, c.lng, 90, 1200);
  const hwy = [beside(p3.lat, p3.lng, 90, 3, 90, 100, { highway: "motorway", oneway: true })];
  const n3 = snapSpeedLimit(p3.lat, p3.lng, hwy, 90, 110 / 3.6);
  ok("N3 a motorway 100 at 1200 m (the refetch triggered at 1000 m, not yet landed): covered, 100 — no blank inside the disc", isCovered(c, p3.lat, p3.lng) && n3.limitKmh === 100, fmt(n3));
}

console.log("C. outside the disc the sign may only CONTINUE the number it showed inside it (review 2026-09-22)");
{
  ok("C1 motorway 100 inside → motorway 100 outside: continues (the long piece the car is on — the sign stays, no blank on a straight highway)", continuesCover({ limitKmh: 100 }, { limitKmh: 100 }));
  ok("C2 Olaf: 80 inside → the hole offers River Road's 50 outside: NOT a continuation → null, no ding (the phantom by definition)", !continuesCover({ limitKmh: 80 }, { limitKmh: 50 }));
  ok("C3 Ni GR 09-16 23:46:04: 100 inside → an unclassified 30 outside: NOT a continuation", !continuesCover({ limitKmh: 100 }, { limitKmh: 30 }));
  ok("C4 residential 50 → tertiary 50 outside: continues — the class is not compared, only the number the driver is measured against", continuesCover({ limitKmh: 50 }, { limitKmh: 50 }));
  ok("C5 a legitimate 100 → 80 outside the disc: NOT a continuation → null until a fetch covers the car (the declared cost, one cycle)", !continuesCover({ limitKmh: 100 }, { limitKmh: 80 }));
  ok("C6 nothing shown inside (untagged road, null) → anything outside is null: a limit cannot APPEAR from a hole", !continuesCover({ limitKmh: null }, { limitKmh: 50 }) && !continuesCover(null, { limitKmh: 50 }));
  ok("C7 no road within tolerance outside (null) never continues a number", !continuesCover({ limitKmh: 100 }, { limitKmh: null }) && !continuesCover({ limitKmh: 100 }, null));
}

console.log("G. honest drops keep resolving — the cover is centred at the car (a complete cache), the snap is byte-identical");
{
  const P = { lat: 49.038018, lng: -122.338203 };
  const c: Cover = { lat: P.lat, lng: P.lng, radiusM: FETCH_RADIUS_M };
  // Jeff 2026-09-14 22:57:30 `speed-limit lim=90>70 near=5 cls=motorway_link x=- crs=236 spd=116` — the Coquihalla-day exit.
  const g1 = snapSpeedLimit(P.lat, P.lng, [beside(P.lat, P.lng, 236, 5, 236, 70, { highway: "motorway_link", oneway: true })], 236, 116 / 3.6);
  ok("G1 a 70 ramp at 116 km/h (46 over) still snaps 70 inside the cover", isCovered(c, P.lat, P.lng) && g1.limitKmh === 70, fmt(g1));
  // SPL_GRC 2026-09-15 23:43:50 `speed-limit lim=60>30 near=4 cls=motorway_link x=60@7m/179° crs=326 spd=56` — the off-ramp drop.
  const g2 = snapSpeedLimit(P.lat, P.lng, [beside(P.lat, P.lng, 326, -7, 146, 60, { highway: "motorway", oneway: true }), beside(P.lat, P.lng, 326, 4, 326, 30, { highway: "motorway_link", oneway: true })], 326, 56 / 3.6);
  ok("G2 the 30 off-ramp at 56 still snaps 30 with the motorway 60 as the rejected crossing", g2.limitKmh === 30 && g2.crossing?.limitKmh === 60, fmt(g2));
  // SPL_GRC 2026-09-20 14:04:12 `speed-limit lim=50>30 near=1 cls=service x=60@11m/180° crs=271 spd=64` — the ferry-terminal lane.
  // (the motorway first, as G2: the snap only records a crossing while it is still nearer than the best so far)
  const g3 = snapSpeedLimit(P.lat, P.lng, [beside(P.lat, P.lng, 271, -11, 91, 60, { highway: "motorway", oneway: true }), beside(P.lat, P.lng, 271, 1, 271, 30, { highway: "service" })], 271, 64 / 3.6);
  ok("G3 a service 30 at 64 (34 over) keeps its sign — no class/speed rule was reintroduced (speedLimitSnap.ts untouched)", g3.limitKmh === 30 && g3.crossing?.limitKmh === 60, fmt(g3));
}

console.log("B. KNOWN OPEN — mechanism B is not touched by the cover: the road under the car carries no maxspeed and a tagged minor road runs beside it");
{
  // Olaf 2026-09-22 14:41:59 `speed-limit lim=?>30 near=29 cls=unclassified x=- crs=300 spd=73` → 14:42:01 tier=2 over=45 limit=30,
  // on the Hwy 17 → Hwy 99 loop ramp (381185370, motorway_link, NO maxspeed — not in the payload). Live OSM 2026-09-22, full geometry.
  const burns30: LimitWay = { maxspeedKmh: 30, oneway: false, highway: "unclassified", geom: [{ lat: 49.1037993, lng: -123.0460865 }, { lat: 49.1037247, lng: -123.0460034 }, { lat: 49.103632, lng: -123.0458572 }, { lat: 49.1026868, lng: -123.043792 }, { lat: 49.0993862, lng: -123.0364957 }, { lat: 49.0989795, lng: -123.0355087 }, { lat: 49.0985395, lng: -123.0345197 }, { lat: 49.0984127, lng: -123.034226 }, { lat: 49.098269, lng: -123.0338311 }, { lat: 49.0977949, lng: -123.0325196 }, { lat: 49.0977344, lng: -123.0323343 }, { lat: 49.0976841, lng: -123.0321481 }, { lat: 49.0976362, lng: -123.0319141 }, { lat: 49.0976068, lng: -123.0317 }, { lat: 49.0975873, lng: -123.0314767 }, { lat: 49.0975807, lng: -123.0312968 }, { lat: 49.0975807, lng: -123.0311129 }, { lat: 49.0976214, lng: -123.0305939 }, { lat: 49.097628, lng: -123.0303602 }, { lat: 49.0976376, lng: -123.0290909 }, { lat: 49.0976399, lng: -123.0289496 }] };   // 827949502, 1.45 km
  const hwy99a: LimitWay = { maxspeedKmh: 100, oneway: true, highway: "motorway", geom: [{ lat: 49.0966714, lng: -123.0310897 }, { lat: 49.1012412, lng: -123.0411431 }, { lat: 49.1029298, lng: -123.0448871 }] };   // 381185362
  const hwy99b: LimitWay = { maxspeedKmh: 100, oneway: true, highway: "motorway", geom: [{ lat: 49.1017651, lng: -123.0425967 }, { lat: 49.100645, lng: -123.0401694 }, { lat: 49.0995914, lng: -123.0378403 }, { lat: 49.098327, lng: -123.0350516 }] };   // 381428912
  const at = { lat: 49.097365, lng: -123.031871 };                                       // on the loop ramp: Burns ~29 m, Hwy 99 ~31 m — the receipt's near=29
  const c: Cover = { lat: at.lat, lng: at.lng, radiusM: FETCH_RADIUS_M };               // the cache IS complete here — that is the point
  const b1 = snapSpeedLimit(at.lat, at.lng, [burns30, hwy99a, hwy99b], 301, 73 / 3.6);
  const hwyOnly = snapSpeedLimit(at.lat, at.lng, [hwy99a, hwy99b], 301, 73 / 3.6);
  ok("B1 KNOWN OPEN — flips when untagged occupants (B1) land: covered, and the snap says 30 from Burns Drive ~29 m (Hwy 99 outside the tolerance, the ramp not in the payload) — Olaf 14:41:59 still dings after this fix",
    isCovered(c, at.lat, at.lng) && b1.limitKmh === 30 && b1.highway === "unclassified" && Math.abs(b1.nearestM - 29) < 2 && hwyOnly.limitKmh === null && hwyOnly.nearestM > SNAP_TOLERANCE_M, `${fmt(b1)} hwy99=${hwyOnly.nearestM.toFixed(1)}m`);
}

console.log(fails === 0 ? "\nPASS speed_limit_cover" : `\nFAIL speed_limit_cover (${fails})`);
if (fails) process.exit(1);
