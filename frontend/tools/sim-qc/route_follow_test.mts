// route_follow_test — the drawn car follows the ROUTE LINE through corners (src/poseEstimator.ts rf*).
//
//   node --experimental-strip-types tools/sim-qc/route_follow_test.mts
//
// Jeff, 2026-09-18: "we are still over shooting corners this needs to fixed now it does not look premium. it is over
// shooting in the 2d map too." His 09-16 corners (tools/sim-qc/data/0916_corner90.json — his own 1 Hz fixes on the app's
// own Mapbox lines, longitudes shifted) replayed through the estimator alone put the car 7–17 m off the line at the
// turn and swung the nose ~10° past the new road. With route follow the car rides the line around the corner.
// Every replay runs the surfaces' order at 12 Hz: posePredict → poseFix → poseRoute, and rfPredict → rfFix; the drawn
// pose is rfPose when active, else the estimator (exactly what ConvoyMapbox / CarMapView draw).
import {
  poseStart, posePredict, poseFix, poseRoute, poseOut, haversineM, bearingDeg, wrap180, stepLatLng,
  rfPredict, rfFix, rfPose, rfProject, rfBearing, rfSameLine, type RfLine, type RfState, RF_ON_M, RF_OFF_FIXES,
} from "../../src/poseEstimator.ts";
import { loadFieldData, backfill, projectOntoRoute, type FieldFix } from "./pose_field_replay.mts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => { console.log(`${cond ? "  ok  " : "  FAIL"} ${name} ${detail}`); if (!cond) fails++; };

function lineOf(geom: [number, number][]): RfLine {
  const cum = [0];
  for (let i = 1; i < geom.length; i++) cum.push(cum[i - 1] + haversineM(geom[i - 1][1], geom[i - 1][0], geom[i][1], geom[i][0]));
  return { coords: geom, cum, totalM: cum[cum.length - 1] };
}

type Frame = { t: number; lat: number; lng: number; hdg: number; rf: boolean; m: number | null };
/** The surfaces' loop. `withRf` false = the estimator alone (the control). */
function replay(line: RfLine, fixes: FieldFix[], withRf: boolean, hz = 12, lineFor?: (t: number) => RfLine) {
  const coords = line.coords.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
  const T0 = 1_700_000_000_000;
  let st = poseStart(); let rf: RfState = null; let held: ReturnType<typeof projectOntoRoute> | null = null;
  const t0 = fixes[0].t, tEnd = fixes[fixes.length - 1].t;
  let fi = 0, lastT = t0 - 1 / hz;
  const frames: Frame[] = []; const atFix: { t: number; drawnM: number; fixM: number; lateral: number }[] = [];
  for (let t = t0; t <= tEnd + 1 / hz + 1e-9; t += 1 / hz) {
    const now = T0 + t * 1000; const dt = t - lastT; lastT = t;
    const ln = lineFor ? lineFor(t) : line;
    st = posePredict(st, now, null);
    if (withRf) rf = rfPredict(rf, ln, now, st.spd);
    let landed: FieldFix | null = null;
    while (fi < fixes.length && fixes[fi].t <= t + 1e-9) {
      const f = fixes[fi];
      st = poseFix(st, { lat: f.lat, lng: f.lng, at: T0 + f.t * 1000, accM: 10, speedMs: f.spd, courseDeg: f.crs }, null);
      if (withRf) rf = rfFix(rf, ln, { lat: f.lat, lng: f.lng, at: T0 + f.t * 1000, courseDeg: f.crs, speedMs: f.spd }, now);
      held = projectOntoRoute(f.lat, f.lng, coords, f.spd);
      landed = f; fi++;
    }
    st = poseRoute(st, held, null, dt);
    const o = poseOut(st); if (!o || !st.hdgKnown) continue;
    const r = withRf ? rfPose(rf, ln, st.spd) : null;
    const d = r ?? o;
    frames.push({ t, lat: d.lat, lng: d.lng, hdg: d.hdg, rf: !!r, m: rf ? rf.m : null });
    if (landed) {
      const pm = rfProject(ln, d.lat, d.lng, rf ? rf.m : null, 80), fm = pm ? rfProject(ln, landed.lat, landed.lng, pm.m, 80) : null;
      if (pm && fm) atFix.push({ t, drawnM: pm.m, fixM: fm.m, lateral: fm.distM });
    }
  }
  return { frames, atFix };
}

// ── A · Jeff's real 09-16 corners ─────────────────────────────────────────────────────────────────
console.log("A · Jeff's 09-16 corners (drawn car vs the route line, estimator alone → with route follow)");
const data = loadFieldData();
for (const [key, c] of Object.entries(data.corners)) {
  const line = lineOf(data.geoms[key]);
  const fixes = [...backfill(c.anchor, c.before), c.anchor, ...c.after];
  // The corner = the line's sharpest direction change near the anchor; entry/exit bearings 25 m either side.
  const am = rfProject(line, c.anchor.lat, c.anchor.lng, null)!.m;
  let cornerM = am, bestTurn = 0;
  for (let m = Math.max(0, am - 60); m <= Math.min(line.totalM, am + 60); m += 1) {
    const turn = Math.abs(wrap180(rfBearing(line, m + 3, 2) - rfBearing(line, m - 3, 2)));
    if (turn > bestTurn) { bestTurn = turn; cornerM = m; }
  }
  const entry = rfBearing(line, Math.max(0, cornerM - 25), 5), exit = rfBearing(line, Math.min(line.totalM, cornerM + 25), 5);
  const sign = Math.sign(wrap180(exit - entry)) || 1;
  const measure = (withRf: boolean) => {
    const { frames, atFix } = replay(line, fixes, withRf);
    let maxOff = 0, maxPast = 0, rfN = 0, minRate = Infinity;
    const warm = frames.length ? frames[0].t + 2.5 : 0;
    for (let i = 0; i < frames.length; i++) {
      const fr = frames[i]; if (fr.t < warm) continue;
      const p = rfProject(line, fr.lat, fr.lng, fr.m ?? cornerM, 80)!;
      if (Math.abs(p.m - cornerM) <= 40) maxOff = Math.max(maxOff, p.distM);
      // the nose past the road actually drawn there (the line's own direction at this metre), after the corner
      if (p.m > cornerM + 8 && p.m < cornerM + 40) maxPast = Math.max(maxPast, sign * wrap180(fr.hdg - rfBearing(line, p.m, 5)));
      if (fr.rf) rfN++;
      // how slowly the puck moves out of the corner (m/s over each frame), route follow only
      if (withRf && fr.rf && i > 0 && frames[i - 1].rf && fr.m != null && frames[i - 1].m != null && p.m > cornerM && p.m < cornerM + 25)
        minRate = Math.min(minRate, (fr.m - frames[i - 1].m!) / (fr.t - frames[i - 1].t));
    }
    // Only fixes that sit ON the line can say how far along it the car is: at King Rd the Mapbox line cuts the corner by
    // ~15 m and four fixes 7–17 m off it all project onto the same bend point (142.5 m) while the car drives on.
    const alongErr = Math.max(0, ...atFix.filter((a) => a.lateral <= 8).map((a) => Math.abs(a.drawnM - a.fixM)));
    return { maxOff, maxPast, rfShare: rfN / Math.max(1, frames.length), alongErr, minRate };
  };
  const was = measure(false), now = measure(true);
  const isRab = /rab/.test(key);
  console.log(`  ${key}: ${c.name.slice(0, 60)}`);
  console.log(`     off the line near the corner: ${was.maxOff.toFixed(1)} m → ${now.maxOff.toFixed(1)} m · nose past the road: ${was.maxPast.toFixed(1)}° → ${now.maxPast.toFixed(1)}° · along-line vs fix ≤ ${now.alongErr.toFixed(1)} m · slowest out of the corner ${Number.isFinite(now.minRate) ? now.minRate.toFixed(1) : "-"} m/s · route follow ${(now.rfShare * 100).toFixed(0)} % of frames`);
  if (!isRab) {
    ok(`A ${key} stays on the line through the corner (≤ 1.5 m)`, now.maxOff <= 1.5, `${now.maxOff.toFixed(1)} m (estimator alone ${was.maxOff.toFixed(1)} m)`);
    ok(`A ${key} the nose does not swing past the new road (≤ 3°)`, now.maxPast <= 3, `${now.maxPast.toFixed(1)}° (estimator alone ${was.maxPast.toFixed(1)}°)`);
    ok(`A ${key} no crawl out of the corner (≥ 60 % of the fix speed)`, !Number.isFinite(now.minRate) || now.minRate >= 0.6 * Math.min(...fixes.slice(-4).map((f) => f.spd)), `${Number.isFinite(now.minRate) ? now.minRate.toFixed(1) : "-"} m/s`);
  } else {
    ok(`A ${key} roundabout: stays within 2 m of the ring line`, now.maxOff <= 2, `${now.maxOff.toFixed(1)} m`);
  }
  ok(`A ${key} keeps up with the car (along the line within 12 m of each on-line fix)`, now.alongErr <= 12, `${now.alongErr.toFixed(1)} m`);
  ok(`A ${key} route follow engaged`, now.rfShare >= 0.5, `${(now.rfShare * 100).toFixed(0)} %`);
}

// ── Synthetic helpers: an L-shaped line (east 600 m) and a car driving it at 1 Hz ─────────────────
const LAT0 = 49.05, LNG0 = -122.0;
const mE = (x: number, y: number): [number, number] => [LNG0 + x / (111320 * Math.cos(LAT0 * Math.PI / 180)), LAT0 + y / 111320];
const straightLine = lineOf(Array.from({ length: 61 }, (_, i) => mE(i * 10, 0)));
function drive(path: (s: number) => { x: number; y: number; crs: number }, speed: number, secs: number, jitter = 0, seed = 5): FieldFix[] {
  let sd = seed; const rnd = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff - 0.5; };
  const out: FieldFix[] = [];
  for (let t = 0; t <= secs; t += 1) {
    const p = path(speed * t); const [lng, lat] = mE(p.x + rnd() * 2 * jitter, p.y + rnd() * 2 * jitter);
    out.push({ t, lat, lng, crs: speed >= 3 ? p.crs : null, spd: speed });
  }
  return out;
}

console.log("B · a wrong turn: the car leaves the line and route follow lets go");
{
  // East along the line to x=300, then north up a side road — the line keeps going east.
  const path = (s: number) => s <= 300 ? { x: s, y: 0, crs: 90 } : { x: 300, y: s - 300, crs: 0 };
  const fixes = drive(path, 12, 40);
  const { frames } = replay(straightLine, fixes, true);
  const leaveT = 300 / 12;
  const rfAfter = frames.filter((f) => f.t > leaveT + RF_OFF_FIXES + 1.2 && f.rf).length;
  let worst = 0;
  for (const f of frames) if (f.t > leaveT + RF_OFF_FIXES + 1.5) { const s = 12 * f.t; const tr = path(s); const [lng, lat] = mE(tr.x, tr.y); worst = Math.max(worst, haversineM(f.lat, f.lng, lat, lng)); }
  ok("B1 route follow off within the release fixes of leaving the line", rfAfter === 0, `${rfAfter} frames still on the line`);
  ok("B2 then the car is drawn where it is (≤ 15 m from the truth)", worst <= 15, `${worst.toFixed(1)} m`);
}

console.log("C · stopped at a light with 3 m GPS jitter: no creep");
{
  const fixes = [...drive((s) => ({ x: s, y: 0, crs: 90 }), 10, 20), ...drive(() => ({ x: 200, y: 0, crs: 90 }), 0, 30, 3).map((f) => ({ ...f, t: f.t + 21 }))];
  const { frames } = replay(straightLine, fixes, true);
  const still = frames.filter((f) => f.t > 24);
  const xs = still.map((f) => rfProject(straightLine, f.lat, f.lng, null)!.m);
  const span = Math.max(...xs) - Math.min(...xs);
  ok("C1 the stopped car moves ≤ 4 m in 26 s of jitter", span <= 4, `${span.toFixed(1)} m`);
}

console.log("D · a traffic refresh (same road, new line object) keeps route follow; a reroute resets it");
{
  const fixes = drive((s) => ({ x: s, y: 0, crs: 90 }), 12, 30);
  const copy = lineOf(straightLine.coords.map((c) => [c[0], c[1]] as [number, number]));
  const { frames } = replay(straightLine, fixes, true, 12, (t) => (t > 15 ? copy : straightLine));
  const dropped = frames.filter((f) => f.t > 15 && f.t < 20 && !f.rf).length;
  ok("D1 same road, new object: route follow stays on", dropped === 0 && rfSameLine(straightLine, copy), `${dropped} frames off`);
  const other = lineOf(Array.from({ length: 61 }, (_, i) => mE(i * 10, 40)));
  ok("D2 a different road is not the same line", !rfSameLine(straightLine, other));
}

console.log("E · a gentle highway sweep at 100 km/h: on the line, nose smooth");
{
  const R = 600, v = 27.8;
  const sweep = lineOf(Array.from({ length: 121 }, (_, i) => { const a = (i / 120) * (Math.PI / 3); return mE(R * Math.sin(a), R - R * Math.cos(a)); }));
  const path = (s: number) => { const a = s / R; return { x: R * Math.sin(a), y: R - R * Math.cos(a), crs: (90 - a * 180 / Math.PI + 360) % 360 }; };
  const { frames } = replay(sweep, drive(path, v, 20), true);
  let maxOff = 0, maxStep = 0; for (let i = 1; i < frames.length; i++) { maxOff = Math.max(maxOff, rfProject(sweep, frames[i].lat, frames[i].lng, null)!.distM); maxStep = Math.max(maxStep, Math.abs(wrap180(frames[i].hdg - frames[i - 1].hdg))); }
  ok("E1 on the line (≤ 1 m)", maxOff <= 1, `${maxOff.toFixed(2)} m`);
  ok("E2 nose turns smoothly (≤ 2° per frame at 12 Hz)", maxStep <= 2, `${maxStep.toFixed(2)}°`);
}

// ── 2026-09-19 · the first drives on OTA-BB (memory field-2026-09-19-first-drives-on-ota-bb) ─────────────────────
// Three defects the field rows showed, each replayed from those rows (MEASURED where a row carries the number,
// straight-line interpolation at the logged speeds in between — labelled per scenario).
const mAt = (lat0: number) => 111320 * Math.cos(lat0 * Math.PI / 180);
/** A polyline from `start` along `legs` of [bearing°, metres], one vertex every ~5 m. */
function legsLine(start: [number, number], legs: Array<[number, number]>): RfLine {
  const pts: [number, number][] = [start];
  let [lng, lat] = start;
  for (const [brg, len] of legs) {
    const n = Math.max(1, Math.round(len / 5));
    for (let i = 1; i <= n; i++) {
      const d = len / n, b = brg * Math.PI / 180;
      lat += (Math.cos(b) * d) / 111320; lng += (Math.sin(b) * d) / mAt(lat);
      pts.push([lng, lat]);
    }
  }
  return lineOf(pts);
}
/** Drawn along-line speed ÷ car speed, max over frames inside [t0, t1] (0.25 s windows so a single frame cannot spike it). */
function lurch(frames: Frame[], fixes: FieldFix[], t0: number, t1: number): number {
  let worst = 0;
  // The car's speed BETWEEN fixes, interpolated (the car accelerates out of a turn; the last fix's speed is up to 1 s stale).
  const spdAt = (t: number) => {
    for (let i = 1; i < fixes.length; i++) if (fixes[i].t >= t) {
      const a = fixes[i - 1], b = fixes[i], u = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return (a.spd ?? 0) + ((b.spd ?? 0) - (a.spd ?? 0)) * Math.max(0, Math.min(1, u));
    }
    return fixes[fixes.length - 1].spd ?? 0;
  };
  for (let i = 0; i < frames.length; i++) {
    const a = frames[i]; if (a.t < t0 || a.t > t1 || !a.rf || a.m == null) continue;
    const j = frames.findIndex((b) => b.t >= a.t + 0.25); if (j < 0) break;
    const b = frames[j]; if (!b.rf || b.m == null) continue;
    const v = (b.m - a.m) / (b.t - a.t), car = Math.max(2, spdAt(a.t));
    worst = Math.max(worst, v / car);
  }
  return worst;
}

console.log("F · pulling out at walking pace the wrong way: route follow stays off (Say Phin 09-19 07:27, AA)");
{
  // The route: the road he pulled onto, running EAST (90°) along lat 49.228450 (the rf puck's rows). He came down a
  // driveway from the north at 3–6 km/h and turned right — WEST — onto it. MEASURED (SPL_GRC): :14.99 gps
  // 49.228673,-123.038014 crs 181 6 km/h (24.8 m N) · :16.99 3 km/h 21.7 m · :21.99 crs 169 6 km/h 15.2 m ·
  // :23.99 3 km/h 12.2 m · :31.99 raw 49.228487,-123.038020 crs 260 10 km/h · :33.03 raw …038075 crs 265 17 km/h ·
  // :34.03 raw …038155 crs 269 21 km/h. Pre-fix rows: route follow ON at :16.99 (gate=slow), the puck frozen at
  // 49.228450,-123.037956 pointing 90° until :34.03.
  const road = lineOf(Array.from({ length: 61 }, (_, i) => [-123.0420 + i * 0.00015, 49.228450] as [number, number]));
  const k = mAt(49.22845), N = (m: number) => 49.228450 + m / 111320, E = (dm: number) => -123.038014 + dm / k;
  const fx: FieldFix[] = [];
  const push = (t: number, lat: number, lng: number, crs: number | null, kmh: number) => fx.push({ t, lat, lng, crs, spd: kmh / 3.6 });
  push(1, N(24.8), E(0), 181, 6); push(2, N(23.2), E(0), 181, 5); push(3, N(21.7), E(0), 181, 3);            // :15–:17 (1, 3 MEASURED)
  for (let i = 4; i <= 7; i++) push(i, N(21.7 - (i - 3) * 1.6), E(0.3 * (i - 3)), 175, 5);                    // interpolated
  push(8, N(15.2), E(1.2), 169, 6);                                                                           // :22 MEASURED
  push(9, N(13.7), E(1.5), 169, 4); push(10, N(12.2), E(1.8), 169, 3);                                       // :24 MEASURED
  for (let i = 11; i <= 17; i++) push(i, N(12.2 - (i - 10) * 1.1), E(1.8 - (i - 10) * 0.4), 200, 4);          // interpolated, turning right
  push(18, 49.228487, -123.038020, 260, 10); push(19, 49.228484, -123.038075, 265, 17); push(20, 49.228485, -123.038155, 269, 21); // MEASURED
  for (let i = 21; i <= 32; i++) push(i, 49.228485, -123.038155 - (i - 20) * 6.5 / k, 270, 24);                // west at ~24 km/h
  const { frames } = replay(road, fx, true);
  const rfOn = frames.filter((f) => f.rf).length;
  // Pointing the wrong way = more than 90° off where he is driving, for how long (a car mid-turn legitimately lags its
  // own course for a moment; the defect was 170–175° for 18 s).
  let wrongS = 0;
  for (let i = 1; i < frames.length; i++) { const f = frames[i]; const c = [...fx].reverse().find((x) => x.t <= f.t); if (c && c.crs != null && (c.spd ?? 0) >= 2.5 && Math.abs(wrap180(f.hdg - c.crs)) > 90) wrongS += f.t - frames[i - 1].t; }
  ok("F1 route follow never switches on while he pulls out the other way", rfOn === 0, `${rfOn} frames on the line (pre-fix: on from :16.99, frozen 18 s)`);
  ok("F2 the car never points more than 90° from where he drives for over 1 s", wrongS <= 1, `${wrongS.toFixed(1)} s (pre-fix rows: 170–175° for 18 s)`);
}

console.log("G · a 90° intersection turn: no lurch (John 07:03:46 and Say Phin 07:33:27 — the SAME corner)");
{
  // The corner: in at 184° to the vertex 49.205360,-123.023541, out at 90° (both drivers' rf puck rows sit on it).
  const V: [number, number] = [-123.023541, 49.205360];
  const kk = mAt(49.20536);
  const up = [V[0] + (Math.sin(184 * Math.PI / 180) * -150) / kk, V[1] + (Math.cos(184 * Math.PI / 180) * -150) / 111320] as [number, number];
  const corner = legsLine(up, [[184, 150], [90, 300]]);
  const vM = rfProject(corner, V[1], V[0], null)!.m;
  const Nf = (m: number) => V[1] + m / 111320, Ef = (m: number) => V[0] + m / kk;
  // John: stopped at the light (a 25.6 s fix gap ending 07:03:41), then the left. MEASURED: :44.26 crs 182 21 km/h ·
  // :45.26 raw 49.205421,-123.023528 crs 144 26 km/h · :46.32 raw 49.205355,-123.023256 crs 121 29 km/h (the fix
  // JUMPED 21 m in 1.06 s) · :47.25 raw 49.205328,-123.023162 crs 91 33 km/h. Interpolated: the stop (20 m N) and
  // the pull-away to :44.26 (13 m N), and east of :47 at 34 km/h.
  const john: FieldFix[] = [];
  for (let t = 0; t <= 5; t++) john.push({ t, lat: Nf(20), lng: Ef(1.4), crs: null, spd: 0 });
  john.push({ t: 6.9, lat: Nf(19), lng: Ef(1.3), crs: 184, spd: 1.5 }, { t: 7.9, lat: Nf(16.5), lng: Ef(1.2), crs: 184, spd: 3.6 });
  john.push({ t: 9.26, lat: Nf(13), lng: Ef(1.0), crs: 182, spd: 21 / 3.6 });
  john.push({ t: 10.26, lat: 49.205421, lng: -123.023528, crs: 144, spd: 26 / 3.6 });
  john.push({ t: 11.32, lat: 49.205355, lng: -123.023256, crs: 121, spd: 29 / 3.6 });
  john.push({ t: 12.25, lat: 49.205328, lng: -123.023162, crs: 91, spd: 33 / 3.6 });
  for (let i = 1; i <= 8; i++) john.push({ t: 12.25 + i, lat: 49.20533, lng: -123.023162 + (i * 9.4) / kk, crs: 90, spd: 34 / 3.6 });
  // Say Phin, rolling through it. MEASURED: :25.00 gps 49.205569,-123.023517 crs 180 16 km/h · :26.02 crs 172 24 km/h
  // (position interpolated) · :26.99 raw 49.205432,-123.023448 crs 148 31 km/h · :27.99 raw 49.205384,-123.023340
  // crs 125 33 · :28.99 raw 49.205357,-123.023191 crs 104 40 · :29.99 crs 89 48. His fixes moved 9.5 m in that
  // second while their projection on the line moved ~23 m: the car cut a corner the line draws square.
  const sp: FieldFix[] = [];
  for (let t = 0; t <= 4; t++) sp.push({ t, lat: Nf(45 - t * 4.4), lng: Ef(1.6), crs: 184, spd: 16 / 3.6 });
  sp.push({ t: 5.0, lat: 49.205569, lng: -123.023517, crs: 180, spd: 16 / 3.6 });
  sp.push({ t: 6.02, lat: 49.2055, lng: -123.023482, crs: 172, spd: 24 / 3.6 });
  sp.push({ t: 6.99, lat: 49.205432, lng: -123.023448, crs: 148, spd: 31 / 3.6 });
  sp.push({ t: 7.99, lat: 49.205384, lng: -123.02334, crs: 125, spd: 33 / 3.6 });
  sp.push({ t: 8.99, lat: 49.205357, lng: -123.023191, crs: 104, spd: 40 / 3.6 });
  for (let i = 1; i <= 8; i++) sp.push({ t: 8.99 + i, lat: 49.20536, lng: -123.023191 + (i * 13.3) / kk, crs: 90, spd: 48 / 3.6 });
  for (const [who, fx, tTurn] of [["John", john, 10.26], ["Say Phin", sp, 6.99]] as const) {
    const { frames, atFix } = replay(corner, fx as FieldFix[], true);
    const L = lurch(frames, fx as FieldFix[], tTurn - 1, tTurn + 4);
    let maxOff = 0; for (const f of frames) if (f.rf) maxOff = Math.max(maxOff, rfProject(corner, f.lat, f.lng, f.m, 80)!.distM);
    const lag = Math.max(0, ...atFix.filter((a) => a.t >= tTurn - 1 && a.t <= tTurn + 3).map((a) => a.fixM - a.drawnM));
    console.log(`     ${who}: drawn/car speed out of the corner ≤ ${L.toFixed(2)}× · behind the fix at the corner ≤ ${lag.toFixed(1)} m · off the line ${maxOff.toFixed(1)} m`);
    ok(`G ${who}: no lurch out of the corner (≤ 1.6× the car's speed)`, L <= 1.6, `${L.toFixed(2)}× (field rows: 2–3×)`);
    ok(`G ${who}: rides the line through it (≤ 1.5 m)`, maxOff <= 1.5, `${maxOff.toFixed(1)} m`);
  }
  void vM;
}

console.log("H · the route turns, the car goes straight (Jeff 09-19 08:51:54, Say Phin 07:28:10) — KNOWN OPEN, regression guard");
{
  // MEASURED Jeff: :51.0 crs 359 14 km/h distM 4.7 · :52.2 crs 1 22 · :53.2 crs 0 29 · :54.2 crs 1 36 — the puck at 278°
  // 7 m off him (src=rf) — off-route :58.2. The same shape here at both drivers' speeds, the car 5 / 2 / 0 m beside the
  // line, straight on past the vertex.
  // ⚠ KNOWN OPEN (2026-09-19): route follow draws the car down the route's road for 0.8–1.9 s (up to ~36 m from it)
  // before letting go; the estimator alone never did (scratch control, same traces: 0.0 s). NOT fixed here, on purpose:
  // for the first 1–2 fixes this is indistinguishable from King Rd (c1830 above — the Mapbox line cuts that corner by
  // ~15 m, so the car rides straight past the line's vertex before its own road turns). Holding the puck at the vertex
  // until the car turns would end the swing and make King-Rd-type corners hesitate; that trade is Jeff's call. Until
  // then this asserts only that it gets no WORSE than the values measured on 2026-09-19.
  for (const off of [5, 2, 0]) for (const [kmh, turn] of [[36, 278], [49, 91]] as const) {   // Jeff's left (278° off a northbound leg); Say Phin's right (90° → 181°, i.e. a 91° right)
    const v = kmh / 3.6;
    const ln = legsLine([-122.0, 49.10], [[0, 300], [turn, 300]]);
    const kx = mAt(49.10), side = turn === 278 ? -off : off;
    const fx: FieldFix[] = [];
    for (let t = 0; t <= 45; t++) fx.push({ t, lat: 49.10 + Math.min(500, v * t) / 111320, lng: -122.0 + side / kx, crs: 0, spd: v });
    const { frames } = replay(ln, fx, true);
    const tV = 300 / v;
    let wrongS = 0, worstGap = 0;
    for (let i = 1; i < frames.length; i++) {
      const f = frames[i]; if (f.t < tV) continue;
      if (Math.abs(wrap180(f.hdg - turn)) <= 35) wrongS += f.t - frames[i - 1].t;
      const y = Math.min(500, v * f.t);
      worstGap = Math.max(worstGap, haversineM(f.lat, f.lng, 49.10 + y / 111320, -122.0 + side / kx));
    }
    console.log(`     ${off} m beside, ${kmh} km/h, route turns ${turn}°: drawn down the route's road ${wrongS.toFixed(1)} s · farthest from the car ${worstGap.toFixed(1)} m`);
    ok(`H ${off} m/${kmh} km/h: no worse than 2026-09-19 (≤ 2.0 s down the route's road, ≤ 40 m)`, wrongS <= 2.0 && worstGap <= 40, `${wrongS.toFixed(1)} s, ${worstGap.toFixed(1)} m`);
  }
}

console.log("I · the GPS goes quiet at speed: the car holds after POSE_DR_MAX_FIX_AGE_S (sim 09-19 stall; Jeff's 09-12 light)");
{
  // The sim, 2026-09-19 10:20 PDT: the location feed stalled for ~20 s at 36 km/h and route follow carried the puck 82 m past
  // the last fix (`draw-cmp src=rf d=82.4m fixAge=19515`) — it had no fix-age bound. Jeff 09-12 14:55 (the estimator's own
  // version, fixed in OTA-AS): stopped at a light, the last fix still read 16 km/h, the marker 41 m up the road.
  // Drive the straight line at 10 m/s for 20 s, then no fixes for 15 s.
  const fixes = drive((s) => ({ x: s, y: 0, crs: 90 }), 10, 20);
  const { frames } = replay(straightLine, [...fixes, { ...fixes[fixes.length - 1], t: 35 }], true);   // one late fix at 35 s ends the gap
  const lastFixM = rfProject(straightLine, fixes[fixes.length - 1].lat, fixes[fixes.length - 1].lng, null)!.m;
  const during = frames.filter((f) => f.t > 20 && f.t < 34.9 && f.m != null);
  const ahead = Math.max(0, ...during.map((f) => f.m! - lastFixM));
  ok("I1 at most POSE_DR_MAX_FIX_AGE_S of travel past the last fix (≤ 30 m at 10 m/s)", ahead <= 30, `${ahead.toFixed(1)} m (pre-fix 3f844877: 148.3 m, measured)`);
}

console.log("J · a 30 s GPS gap while driving on (a tunnel): route follow finds the car again (Codex 2026-09-19)");
{
  // Codex (medium, REPRODUCED): 2 km straight line, vertices every 10 m; on at 100/110 m at 10 m/s, then no fixes for 30 s
  // while the car drives on. The hold (I) parks the puck ~135 m; fixes at 410 m, 420 m … searched only a window around the
  // stale puck, never found the car, and route follow stayed OFF for the rest of the drive.
  const long = lineOf(Array.from({ length: 201 }, (_, i) => mE(i * 10, 0)));
  const all = drive((s) => ({ x: s, y: 0, crs: 90 }), 10, 70);
  const fixes = all.filter((f) => f.t <= 11 || f.t >= 41);
  const { frames } = replay(long, fixes, true);
  const back = frames.find((f) => f.t >= 41 && f.rf && Math.abs(rfProject(long, f.lat, f.lng, null)!.m - 10 * f.t) <= 15);
  const late = frames.filter((f) => f.t >= 46);
  const worst = Math.max(...late.map((f) => Math.abs(rfProject(long, f.lat, f.lng, null)!.m - 10 * f.t)));
  ok("J1 route follow is back on within 3 fixes of the GPS returning", !!back && back.t <= 44, back ? `on again at ${back.t.toFixed(1)} s (GPS back at 41 s)` : "never");
  ok("J2 and the car is drawn where it is after that (≤ 15 m along)", late.every((f) => f.rf) && worst <= 15, `${late.filter((f) => f.rf).length}/${late.length} frames on the line, worst ${worst.toFixed(1)} m`);
}

console.log(fails === 0 ? "\nPASS route_follow" : `\nFAIL route_follow (${fails})`);
if (fails) process.exit(1);
