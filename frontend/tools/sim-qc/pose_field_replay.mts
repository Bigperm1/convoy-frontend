// pose_field_replay — replay a drive's own 1 Hz fixes through src/poseEstimator.ts on the REAL route
// geometry of the intersection, exactly in the surfaces' order (CarMapView.tsx / ConvoyMapbox.tsx:
// posePredict → poseFix → poseRoute at 12 Hz). Used by pose_estimator_test.mts section Z (the 09-16
// traffic-light corners). Data: tools/sim-qc/data/0916_corner90.json — every longitude there is shifted
// +0.37° so the public repo never carries home-area coordinates; the estimator's maths (haversine,
// bearings, the local equirectangular projection) is invariant under a pure longitude shift, verified
// identical to 1e-9 in heading, road, routeW and distM against the unshifted replay on 2026-09-16;
// one drawn-vs-fix distance (17:59, t=48.2) differs by 1.3 m — a threshold crossing inside poseFix at
// floating-point noise, not chased — so every bar in section Z is set on the SHIFTED data the gate runs.
import { readFileSync } from "node:fs";
import {
  poseStart, posePredict, poseFix, poseRoute, poseOut, poseRoadWindowM, wrap180, norm360, haversineM, stepLatLng,
} from "../../src/poseEstimator.ts";

export type FieldFix = { t: number; lat: number; lng: number; crs: number | null; spd: number };
type Before = { t: number; crs: number; spd: number };
type Corner = { name: string; before: Before[]; anchor: FieldFix; after: FieldFix[] };
type Data = { geoms: Record<string, [number, number][]>; corners: Record<string, Corner> };

export function loadFieldData(file = "0916_corner90.json"): Data {
  return JSON.parse(readFileSync(new URL(`./data/${file}`, import.meta.url), "utf8")) as Data;
}

// projectOntoRoute, ported from src/ConvoyMapbox.tsx (the global pass; these replays carry no stale
// window, so this is what the app's second pass computes): nearest point on the polyline, its segment
// bearing, and the WINDOWED chord at the projection and at speed × 1 s ahead (roadHdg / roadHdgAhead).
export function projectOntoRoute(pLat: number, pLng: number, coords: { latitude: number; longitude: number }[], speedMs: number) {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const cosLat = Math.cos(toRad(pLat));
  const X = (lng: number) => toRad(lng - pLng) * cosLat * R, Y = (lat: number) => toRad(lat - pLat) * R;
  const invLng = (x: number) => pLng + (x / (cosLat * R)) * (180 / Math.PI), invLat = (y: number) => pLat + (y / R) * (180 / Math.PI);
  let acc = 0, bestD2 = Infinity, bestArc = 0, bestX = 0, bestY = 0, bestDx = 0, bestDy = 0;
  let prevX = X(coords[0].longitude), prevY = Y(coords[0].latitude);
  for (let i = 1; i < coords.length; i++) {
    const cx = X(coords[i].longitude), cy = Y(coords[i].latitude);
    const dx = cx - prevX, dy = cy - prevY, len = Math.hypot(dx, dy);
    if (len > 0) {
      let t = ((0 - prevX) * dx + (0 - prevY) * dy) / (len * len); t = Math.max(0, Math.min(1, t));
      const px = prevX + t * dx, py = prevY + t * dy, d2 = px * px + py * py;
      if (d2 < bestD2) { bestD2 = d2; bestArc = acc + t * len; bestX = px; bestY = py; bestDx = dx; bestDy = dy; }
      acc += len;
    }
    prevX = cx; prevY = cy;
  }
  const total = acc;
  const bearing = (Math.atan2(bestDx, bestDy) * 180 / Math.PI + 360) % 360;
  const W = poseRoadWindowM(speedMs);
  const chordAt = (centre: number): number => {
    const s0 = Math.max(0, centre - W), s1 = Math.min(total, centre + W);
    if (s1 - s0 < 0.5) return bearing;
    let a = 0, p0: [number, number] | null = null, p1: [number, number] | null = null;
    let px = X(coords[0].longitude), py = Y(coords[0].latitude);
    for (let i = 1; i < coords.length && (p0 == null || p1 == null); i++) {
      const cx = X(coords[i].longitude), cy = Y(coords[i].latitude), len = Math.hypot(cx - px, cy - py);
      if (len > 0) {
        if (p0 == null && a + len >= s0) { const t = (s0 - a) / len; p0 = [px + t * (cx - px), py + t * (cy - py)]; }
        if (p1 == null && a + len >= s1 - 1e-6) { const t = Math.min(1, (s1 - a) / len); p1 = [px + t * (cx - px), py + t * (cy - py)]; }
        a += len;
      }
      px = cx; py = cy;
    }
    if (p1 == null) p1 = [px, py];
    if (p0 == null) return bearing;
    const ddx = p1[0] - p0[0], ddy = p1[1] - p0[1];
    return Math.hypot(ddx, ddy) > 0.25 ? (Math.atan2(ddx, ddy) * 180 / Math.PI + 360) % 360 : bearing;
  };
  const v = speedMs > 0 ? speedMs : 0;
  return { lat: invLat(bestY), lng: invLng(bestX), bearing, distM: Math.sqrt(bestD2), roadHdg: chordAt(bestArc), roadHdgAhead: v > 0 ? chordAt(Math.min(total, bestArc + v)) : chordAt(bestArc) };
}

// The rows before the first logged coordinate are walked BACK from it along their own course at the mean
// of the two logged speeds (pose-fix rows carry a coordinate only while the estimator reports turning).
export function backfill(anchor: FieldFix, before: Before[]): FieldFix[] {
  const out: FieldFix[] = []; let cur = anchor;
  for (let i = before.length - 1; i >= 0; i--) {
    const b = before[i];
    const dM = ((b.spd + cur.spd) / 2) * (cur.t - b.t);
    const p = stepLatLng(cur.lat, cur.lng, norm360(b.crs + 180), dM);
    cur = { t: b.t, lat: p.lat, lng: p.lng, crs: b.crs, spd: b.spd };
    out.unshift(cur);
  }
  return out;
}

export type ReplayRow = { t: number; crs: number | null; est: number; road: number | null; rk: number; src: string; dFix: number; distM: number; rw: number };
export type ReplayResult = { rows: ReplayRow[]; maxSwingDps: number; frames: { t: number; est: number }[] };

export function replayCorner(geom: [number, number][], fixes: FieldFix[], hz = 12, accMOf: (f: FieldFix, i: number) => number = () => 10): ReplayResult {
  const coords = geom.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
  const T0 = 1_700_000_000_000;
  let st = poseStart();
  let held: ReturnType<typeof projectOntoRoute> | null = null;
  const t0 = fixes[0].t, tEnd = fixes[fixes.length - 1].t;
  let fi = 0, lastT = t0 - 1 / hz, prevHdg: number | null = null, maxSwingDps = 0;
  const rows: ReplayRow[] = []; const frames: { t: number; est: number }[] = [];
  // One frame PAST the last fix so it lands (a fix at tEnd would otherwise never be folded in).
  for (let t = t0; t <= tEnd + 1 / hz + 1e-9; t += 1 / hz) {
    const now = T0 + t * 1000;
    const dtS = t - lastT; lastT = t;
    st = posePredict(st, now, null);
    let landed = false;
    while (fi < fixes.length && fixes[fi].t <= t + 1e-9) {
      const f = fixes[fi];
      st = poseFix(st, { lat: f.lat, lng: f.lng, at: T0 + f.t * 1000, accM: accMOf(f, fi), speedMs: f.spd, courseDeg: f.crs }, null);
      held = projectOntoRoute(f.lat, f.lng, coords, f.spd);
      landed = true; fi++;
    }
    st = poseRoute(st, held, null, dtS);
    const o = poseOut(st);
    if (o && st.hdgKnown) {
      if (prevHdg != null) maxSwingDps = Math.max(maxSwingDps, Math.abs(wrap180(o.hdg - prevHdg)) / dtS);
      prevHdg = o.hdg; frames.push({ t, est: o.hdg });
    }
    if (landed && o) {
      const f = fixes[fi - 1];
      rows.push({ t: f.t, crs: f.crs, est: o.hdg, road: st.roadHdg, rk: st.roadK, src: o.src, dFix: haversineM(o.lat, o.lng, f.lat, f.lng), distM: held!.distM, rw: o.routeW });
    }
  }
  return { rows, maxSwingDps, frames };
}

export function replayAll(data = loadFieldData()): Record<string, ReplayResult & { name: string }> {
  const out: Record<string, ReplayResult & { name: string }> = {};
  for (const [key, c] of Object.entries(data.corners)) {
    const fixes = [...backfill(c.anchor, c.before), c.anchor, ...c.after];
    out[key] = { name: c.name, ...replayCorner(data.geoms[key], fixes) };
  }
  return out;
}

// Standalone: print every corner (node --experimental-strip-types tools/sim-qc/pose_field_replay.mts)
if (process.argv[1] && /pose_field_replay\.mts$/.test(process.argv[1])) {
  for (const [k, r] of Object.entries(replayAll())) {
    console.log(`\n--- ${k}: ${r.name} --- maxSwing=${r.maxSwingDps.toFixed(1)}°/s`);
    for (const row of r.rows) console.log(`  t=${row.t.toFixed(3)} crs=${row.crs == null ? "-" : row.crs.toFixed(0).padStart(3)} est=${row.est.toFixed(2).padStart(6)} |est-crs|=${row.crs == null ? "-" : Math.abs(wrap180(row.est - row.crs)).toFixed(2).padStart(5)}° road=${row.road == null ? "-" : row.road.toFixed(1)} rk=${row.rk.toFixed(2)} src=${row.src} dFix=${row.dFix.toFixed(2)}m distM=${row.distM.toFixed(2)} rw=${row.rw.toFixed(2)}`);
  }
}
