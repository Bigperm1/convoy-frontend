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

console.log(fails === 0 ? "\nPASS route_follow" : `\nFAIL route_follow (${fails})`);
if (fails) process.exit(1);
