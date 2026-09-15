// chaseZoom — the follow camera's ZOOM: the speed curve, the corner zoom-in, and (since
// 2026-09-14) a speed-aware CEILING on that zoom-in. One function, on every surface.
//
// Split out of ConvoyMapbox.tsx on 2026-09-14 for the same reason as chasePitch.ts (09-11),
// cornerBlend.ts, offRouteGate.ts and selfLiftRule.ts: a rule that decides behaviour must live
// where tools/sim-qc can import it. ConvoyMapbox.tsx re-exports chaseZoom, so the phone map and
// CarMapView (CarPlay AND Android Auto) call it unchanged. Import nothing from 'react-native' in
// this file. CHASE_ZOOM_STOPS, chaseZoomForSpeed and the CORNER_* constants moved VERBATIM with
// their comments; the only behaviour change in the split is cornerZoomCeiling below.
// Gate: tools/sim-qc/chase_zoom_test.mts. Source guard: scripts/trap-check.py
// "corner-zoom-no-speed-ceiling".

function lerp(a: number, b: number, t: number) { const k = Math.max(0, Math.min(1, t)); return a + (b - a) * k; }

const CHASE_ZOOM_CITY = 17;       // closest, slow
const CHASE_ZOOM_HIGHWAY = 14;    // ~100 km/h — wider than before (was 15)
const CHASE_ZOOM_FAST = 12.8;     // ~180 km/h — widest, for 100-200 cruising

// ── SPEED → CHASE ZOOM (finer steps, 2026-07-29) ─────────────────────────────
// Jeff: "a couple of sessions ago we made the chase camera zooms better — can we
// add more steps in the zoom based on speed."
//
// The old curve was three tiers: FLAT 17 all the way to 45 km/h, then a straight
// 3-zoom-level plunge to 14 by 95, then a shallow drift to 12.8 by 180. Two
// problems with that shape. Nothing at all happened between a crawl and 45 km/h,
// so city driving never re-framed. Then one linear ramp did all the work at once,
// which reads as a shove rather than the camera breathing with the car — each zoom
// level is a 2x scale change, so 3 levels over 50 km/h is an 8x area change on a
// single straight line.
//
// A denser table fixes both: the framing eases continuously from crawl to cruise
// and every ~15 km/h has its own step. The three documented anchors are PRESERVED
// exactly — 17 at rest (CHASE_ZOOM_CITY, and see the FOLLOW_ZOOM invariant at the
// chaseZoomRaw call site in ConvoyMapbox.tsx), 14 at 95 (CHASE_ZOOM_HIGHWAY), 12.8 at 180
// (CHASE_ZOOM_FAST) — so this reshapes the curve BETWEEN known-good points rather
// than moving them.
//
// 0-20 km/h is deliberately held at exactly CHASE_ZOOM_CITY: parked and crawling
// framing must stay bit-identical to the native follow zoom (FOLLOW_ZOOM === 17).
// Monotonically decreasing, so the low-pass in pushCam never has to reverse.
// Every row is a plain number — OTA-tunable.
export const CHASE_ZOOM_STOPS: [number, number][] = [
  [0,   CHASE_ZOOM_CITY],    // 17.0  parked / crawl — pinned, see above
  [20,  CHASE_ZOOM_CITY],    // 17.0  residential
  [35,  16.6],               //       city street
  [50,  16.1],               //       arterial
  [65,  15.5],               //       fast arterial
  [80,  14.7],               //       highway approach
  [95,  CHASE_ZOOM_HIGHWAY], // 14.0  highway cruise — anchor
  [110, 13.6],
  [125, 13.3],
  [140, 13.1],
  [160, 12.9],
  [180, CHASE_ZOOM_FAST],    // 12.8  widest — anchor
];

export const CORNER_ZOOM = 18.5;
export const CORNER_FAR_M = 280;
export const CORNER_NEAR_M = 70;
// ── CHAINED MANEUVERS (Jeff, 2026-09-03: "the exit off the highway was glitching") ──
// cam-probe on his drive home: zoom climbed to 18.1 for the exit-gore maneuver, the step
// advanced at 18:02:34 with the NEXT maneuver 483 m away (car-strip `turn=483m`), so the
// target dropped to the 76 km/h speed zoom (14.9) and the camera glided out for 15 s — then
// at 280 m from the ramp's end-turn it climbed back to 18.5. In, out, in, through one exit.
// A step shorter than this holds the corner zoom for its whole length: the next maneuver is
// already close, and a highway exit is exactly a gore maneuver + a short ramp step.
// (2026-09-14: still held — but through cornerZoomCeiling, see below.)
export const CORNER_CHAIN_M = 550;

// ── SPEED-AWARE CEILING ON THE CORNER ZOOM (2026-09-14) ──────────────────────────────────
// Jeff, 2026-09-14, after the drive: "the last 10 min the off ramp was terrible and the route
// line was stuttering like crazy". Approved the same day, verbatim: "yes. off ramp build please".
//
// THE DEFECT. The chain hold above returned a FLAT CORNER_ZOOM 18.5 for any step <= 550 m and
// threw the speed zoom away. Every highway ramp is a step shorter than 550 m, so every ramp was
// drawn at maximum zoom while the car was still at highway speed. The corner blend had no speed
// term either (70 m from any maneuver = 18.5 at any speed).
//
// FIELD RECEIPTS (cam-probe rows, CarPlay surface; zt = the target this function returned):
//   2026-09-11 exit, instance ogb3m4-967731: 17:59:42 z=18.28 zt=18.50 spd=104. The speed curve
//     says 13.76 there, so the map was drawn ~4.5 levels (~23x) too close; the ground slid at
//     ~179 px/s against ~8.5 px/s at cruise.
//   2026-09-14 Abbotsford exit, instance h6sjel-844376:
//     18:15:50 z=13.42 zt=13.42 spd=119, 373 m before the exit on a 230 km step — exactly the
//       speed curve;
//     18:16:05 z=18.10 zg=18.26 zt=18.50 spd=99 on the ramp step (~460 m, derived from the
//       nav-eta/car-strip rows). The speed curve says 13.89;
//     18:16:20 z=18.26 zt=18.50 spd=43 near the ramp's end. The speed curve says 16.33.
//     The ground slid 151-168 px/s, against 7.1 px/s fifteen seconds earlier.
//   The fixes themselves were ordinary (pose-fix corrections 1.8-4.3 m, acc=10). The problem is
//   the GAIN: the same metre of correction was drawn ~20x bigger. Not terrain and not altitude.
//   No DEM source exists and altitude is never read; see memory merge-stutter-corner-zoom-gain.
//
// PRIOR ART (fetched + citation-checked 2026-09-11; memory chase-cam-zoom-prior-art):
//   Mapbox Navigation SDK FollowingFrameOptions maxZoom = 16.35, and its excludedManeuvers
//   default is exactly ["continue", "merge", "on ramp", "off ramp", "fork"]. Ramps get LESS
//   camera treatment, not more. MapLibre Navigation Android caps following at 16.0. Organic
//   Maps caps at 16. No readable implementation zooms IN for a short, fast step. Jeff,
//   2026-09-11: "seems like everybody is at a fixed pitch and cieling of around 16".
//
// THE RULE. The corner target may climb above the speed curve freely at city speed, but it
// cannot climb above cornerZoomCeiling(kmh):
//   18.5 (CORNER_ZOOM, no cap) at <= 45 km/h, falling linearly to 16.0 at >= 90 km/h.
// chaseZoom returns max(base, min(cornerTarget, ceiling)). The short-step hold and the distance
// blend both go through the ceiling. The speed curve (CHASE_ZOOM_STOPS) is untouched.
//
// WHY THESE NUMBERS
//   45 km/h: the speed at which the ceiling starts to bite. At <= 45 km/h the ceiling is
//     CORNER_ZOOM itself, so corners at those speeds are bit-identical to before (the gate sweeps
//     this). Every other cam-probe row with zt >= 17.5 on the 09-14 drive was at 4-25 km/h, and
//     the 09-14 ramp end (43 km/h, 18:16:20) gets its corner zoom back once the driver has slowed.
//     (ConvoyMapbox.tsx still declares a CHASE_KMH_CITY = 45, but nothing reads it; 45 is chosen
//     from the field rows above, not inherited from that constant.)
//     ⚠ A corner taken ABOVE 45 km/h — a fast arterial at 60 km/h, say — IS changed: its zoom-in
//     now stops at 17.67 instead of 18.5. The gate prints that row.
//   16.0: the published follow-camera ceilings — Mapbox Navigation SDK maxZoom 16.35, MapLibre
//     Navigation Android 16.0, Organic Maps 16. Both field receipts (99 and 104 km/h) land on the
//     flat part of the cap, not partway down the slope.
//   90 km/h, not the 95 highway anchor: both receipts sit 9-14 km/h above it, so ordinary
//     speed noise at the gore cannot lift them off the cap (a car braking through 85 km/h is at
//     16.28). At 90 km/h the cap is 16.0 against a speed curve of 14.23, so a highway maneuver
//     still tightens by 1.8 levels — just not by 4.5.
//   Linear between: continuous in speed, so a car braking down a ramp gets a smooth, one-way
//     climb back toward the corner zoom. It never steps and never reverses. The slope is 2.5/45 =
//     0.056 levels per km/h. That is the same order as the speed table's own steepest segment
//     (0.053, 65->80), so GPS speed jitter moves the ceiling no more than it already moves the
//     base, and CAM_ZOOM_DEADBAND 0.25 (ConvoyMapbox.tsx) absorbs +-4 km/h of it. Braking at
//     3.5 km/h/s raises the target by 0.19 levels/s. The camera's own slew (0.5/s) is untouched.
//
// HOW MUCH IT BUYS (ground flow on screen at lat 49.05, m/px = 78271.517*cos(lat)/2^z — the gate
// prints the full table):
//   >= 90 km/h on a ramp step: 18.5 -> 16.0, so every position correction is drawn ~5.7x smaller.
//   52-67 km/h: 1.3-2.3x smaller. <= 45 km/h: unchanged.
//   The 09-14 corrections that were logged between 67 and 24 km/h on the ramp are therefore only
//   partly addressed. The other half of that exit is that JS timers and rAF were DEAD for the whole
//   of it (timer-starve raf=0 18:16:03-18:18:36, display off); that is build 79's HairpinTimerPump,
//   not this file. Memory: field-2026-09-14-coquihalla-heat-and-exit.
//
// KNOWN LIMIT (pre-existing, unchanged): on the PHONE surface an invalid iOS speed (-1) arrives
// here as 0 km/h through kmhFromMs, so that one sample gets the city ceiling, exactly as it got
// 18.5 before this change. CarPlay/Android Auto drop invalid speeds in carStore.ts, and both
// field receipts are CarPlay rows.
//
// WHAT DID NOT CHANGE, deliberately:
//   - CORNER_ZOOM, CORNER_FAR_M, CORNER_NEAR_M, CORNER_CHAIN_M and the chain hold itself. Both
//     branches pass through the SAME ceiling at the same speed, so the gore -> ramp step advance
//     still hands over at the same value. The 09-03 in-out-in yo-yo cannot come back (gate G).
//   - The pitch (src/chasePitch.ts, fixed 48) and the car's screen position
//     (FOLLOW_LOWER_PAD_FRAC, CAR_LOWER_PAD_FRAC). These are Jeff's standing orders.
//   - The viewport- and latitude-aware "time-to-horizon" ceiling from the prior-art note was
//     NOT built. This is a fixed-number ceiling, so every surface still gets the identical zoom
//     number ("CarPlay matches the phone").
//
// ⚠ NOT FIELD-VERIFIED. On the next exit, look for cam-probe zt <= 16.0 while spd >= 90 on a ramp
// step, and zt climbing back toward 18.5 only as spd falls under ~45.
export const CORNER_CEIL_CITY_KMH = 45;
export const CORNER_CEIL_HIGHWAY_KMH = 90;
export const CORNER_CEIL_HIGHWAY_ZOOM = 16;

/** Highest zoom the CORNER zoom-in may reach at this speed. CORNER_ZOOM at city speed, 16 at highway speed. */
export function cornerZoomCeiling(kmh: number): number {
  const v = Number.isFinite(kmh) && kmh > 0 ? kmh : 0;
  return lerp(CORNER_ZOOM, CORNER_CEIL_HIGHWAY_ZOOM,
    (v - CORNER_CEIL_CITY_KMH) / (CORNER_CEIL_HIGHWAY_KMH - CORNER_CEIL_CITY_KMH));
}

export function chaseZoomForSpeed(kmh: number) {
  const st = CHASE_ZOOM_STOPS;
  const v = Number.isFinite(kmh) && kmh > 0 ? kmh : 0;
  if (v <= st[0][0]) return st[0][1];
  if (v >= st[st.length - 1][0]) return st[st.length - 1][1];
  for (let i = 1; i < st.length; i++) {
    if (v <= st[i][0]) {
      return lerp(st[i - 1][1], st[i][1], (v - st[i - 1][0]) / (st[i][0] - st[i - 1][0]));
    }
  }
  return st[st.length - 1][1];
}

// ── ROUNDABOUT HOLD (2026-09-15) ─────────────────────────────────────────────────────────
// Jeff's 09-15 drive, roundabout 2 (instance 1mdvgz-926948): the step machine advances 25 m
// BEFORE a maneuver point (nav.ts ADVANCE_THRESHOLD_M), and a Mapbox roundabout step starts at
// the ring's ENTRY and runs to the next maneuver — 30 km away that morning. So the moment the car
// reached the entry, the distance to the "next maneuver" jumped to 30 km and the corner zoom fell
// back to the speed curve: cam-probe 09:01:19.509 zt=16.95 @22 km/h (= chaseZoomForSpeed(22)),
// the camera sliding ~1 level wider on the way in. Roundabout 1 kept 18.5 only because the step
// after it was short (< CORNER_CHAIN_M).
// THE RULE: while the CURRENT step's own maneuver is a roundabout/rotary and the car is within
// ROUNDABOUT_HOLD_M (straight line) of that step's maneuver point, the corner target is
// CORNER_ZOOM — still through cornerZoomCeiling, so a fast rotary cannot zoom in at speed.
// 80 m covers the ring of an ordinary single- or two-lane roundabout (radius ~15-30 m) from the
// 25 m advance point to past the exit; past it the target releases to the speed curve and the
// camera slews out at CAM_ZOOM_SLEW_PER_S as after any maneuver.
// Mapbox maneuver types (docs): "roundabout", "rotary", "roundabout turn". "exit roundabout" /
// "exit rotary" only appear with roundabout_exits=true, which src/mapboxDirections.ts does not send.
// ⚠ NOT FIELD-VERIFIED. Next roundabout: cam-probe zt=18.50 (at <=45 km/h) while on the roundabout step.
export const ROUNDABOUT_HOLD_M = 80;
const ROUNDABOUT_TYPES = new Set(["roundabout", "rotary", "roundabout turn"]);

/**
 * Straight-line metres from the car to the CURRENT step's maneuver point when that maneuver is a
 * roundabout/rotary; undefined for any other maneuver or bad input. `maneuverKey` is nav.ts's
 * mapboxManeuverKey ("type|modifier").
 */
export function roundaboutHoldDistM(
  maneuverKey: string | null | undefined,
  stepLat: number | null | undefined, stepLng: number | null | undefined,
  carLat: number | null | undefined, carLng: number | null | undefined,
): number | undefined {
  if (typeof maneuverKey !== "string") return undefined;
  const type = maneuverKey.split("|")[0].trim().toLowerCase();
  if (!ROUNDABOUT_TYPES.has(type)) return undefined;
  const nums = [stepLat, stepLng, carLat, carLng];
  if (!nums.every((v) => typeof v === "number" && Number.isFinite(v))) return undefined;
  if (stepLat === 0 && stepLng === 0) return undefined;   // nav.ts's missing-location placeholder
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(carLat! - stepLat!), dLng = toRad(carLng! - stepLng!);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(stepLat!)) * Math.cos(toRad(carLat!)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function chaseZoom(kmh: number, distToManeuverM?: number, curStepLenM?: number, roundaboutDistM?: number) {
  const base = chaseZoomForSpeed(kmh);
  const inRoundabout = typeof roundaboutDistM === "number" && Number.isFinite(roundaboutDistM)
    && roundaboutDistM >= 0 && roundaboutDistM <= ROUNDABOUT_HOLD_M;
  if (inRoundabout) return Math.max(base, Math.min(CORNER_ZOOM, cornerZoomCeiling(kmh)));
  if (typeof distToManeuverM !== "number" || !Number.isFinite(distToManeuverM) || distToManeuverM <= 0) return base;
  // Chained maneuvers (exit gore → short ramp): hold the corner zoom for the whole short step.
  // Otherwise tighten continuously over CORNER_FAR_M → CORNER_NEAR_M to the maneuver.
  const shortStep = typeof curStepLenM === "number" && Number.isFinite(curStepLenM) && curStepLenM > 0 && curStepLenM <= CORNER_CHAIN_M;
  const cornerTarget = shortStep
    ? CORNER_ZOOM
    : lerp(base, CORNER_ZOOM, (CORNER_FAR_M - distToManeuverM) / (CORNER_FAR_M - CORNER_NEAR_M));
  // 2026-09-14: never above the speed-aware ceiling, never below the speed curve.
  return Math.max(base, Math.min(cornerTarget, cornerZoomCeiling(kmh)));
}
