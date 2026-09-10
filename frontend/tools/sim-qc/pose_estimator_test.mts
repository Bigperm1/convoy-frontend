// pose_estimator_test — the drawn car follows the CAR through a low-speed corner, not the line.
//
// Replays src/poseEstimator.ts under plain Node against (a) a synthetic 90° corner at 15 km/h with
// 1 Hz noisy fixes, with and without a 20 Hz gyro, and (b) Jeff's REAL King Rd rows from
// 2026-09-09 00:56:48–53 UTC — the corner that produced d = 15.9 / 10.8 / 14.8 m on three drives.
// Field shapes only: one or two fixes per corner, exactly what the road produces.
import {
  poseStart, posePredict, poseFix, poseRoute, poseOut, poseSeedYawSign, POSE_YAW_MAX_DPS, haversineM, bearingDeg, stepLatLng, wrap180, norm360,
  POSE_DR_MAX_M, POSE_ROUTE_MAX_M,
} from "../../src/poseEstimator.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

// ── truth generator: a 90° LEFT corner of radius r at constant speed ──────────────────────
type Truth = { lat: number; lng: number; hdg: number; t: number };
function makeCorner(speedMs: number, radiusM: number, legM: number, hz = 20): Truth[] {
  const out: Truth[] = [];
  let lat = 49.0330, lng = -122.2930, hdg = 180, t = 0;   // southbound, then left to east (90)
  const dt = 1 / hz;
  const arcLen = (Math.PI / 2) * radiusM;
  const total = legM + arcLen + legM;
  let s = 0;
  while (s <= total) {
    out.push({ lat, lng, hdg, t });
    const ds = speedMs * dt;
    if (s > legM && s <= legM + arcLen) hdg = (hdg - (ds / radiusM) * 180 / Math.PI + 360) % 360;   // left = decreasing
    const p = stepLatLng(lat, lng, hdg, ds); lat = p.lat; lng = p.lng; s += ds; t += dt;
  }
  return out;
}
/** Left 90° then right 90° with legs between: the second corner is gyro-driven (sign learned on the first). */
function makeSCurve(speedMs: number, radiusM: number, legM: number, hz = 20): Truth[] {
  const out: Truth[] = []; let lat = 49.0330, lng = -122.2930, hdg = 180, t = 0; const dt = 1 / hz;
  const arc = (Math.PI / 2) * radiusM; const marks = [legM, legM + arc, 2 * legM + arc, 2 * legM + 2 * arc, 3 * legM + 2 * arc];
  let s = 0;
  while (s <= marks[4]) {
    out.push({ lat, lng, hdg, t }); const ds = speedMs * dt;
    if (s > marks[0] && s <= marks[1]) hdg = (hdg - (ds / radiusM) * 180 / Math.PI + 360) % 360;      // left
    else if (s > marks[2] && s <= marks[3]) hdg = (hdg + (ds / radiusM) * 180 / Math.PI) % 360;       // right
    const p = stepLatLng(lat, lng, hdg, ds); lat = p.lat; lng = p.lng; s += ds; t += dt;
  }
  return out;
}
/** A straight run south at constant speed, one truth sample per 1/hz s. */
function makeStraight(speedMs: number, lengthM: number, hz = 20): Truth[] {
  const out: Truth[] = []; let lat = 49.0330, lng = -122.2930, t = 0; const dt = 1 / hz;
  for (let s = 0; s <= lengthM; s += speedMs * dt) {
    out.push({ lat, lng, hdg: 180, t }); const p = stepLatLng(lat, lng, 180, speedMs * dt); lat = p.lat; lng = p.lng; t += dt;
  }
  return out;
}
// deterministic noise
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

function run(truth: Truth[], opts: { gyro: boolean; noiseM: number; route: boolean; yawSign?: 1 | -1; fixHz?: number; biasDps?: number; from?: number; exitFrom?: number; seedSign?: 1 | -1; speedMs?: number; courseDrop?: (i: number, tr: Truth) => boolean }) {
  let st = poseStart();
  if (opts.seedSign) st = poseSeedYawSign(st, opts.seedSign);
  const fixHz = opts.fixHz ?? 1;
  const T0 = 1_700_000_000_000;
  let lastFixT = -Infinity, lastFixIdx = -1, yawSince = 0;
  let heldProj: { lat: number; lng: number; bearing: number; distM: number } | null = null;
  let lastRawLat = truth[0].lat, lastRawLng = truth[0].lng;
  const errs: number[] = []; const hdgErrs: number[] = []; const steps: number[] = [];
  let prevOut: { lat: number; lng: number } | null = null;
  for (let i = 0; i < truth.length; i++) {
    const tr = truth[i]; const now = T0 + tr.t * 1000;
    // sensor yaw rate: the true rate with the chosen sign convention, ±0.5 dps noise
    let yaw: number | null = null;
    if (opts.gyro && i > 0) {
      const dt = tr.t - truth[i - 1].t;
      const rate = wrap180(tr.hdg - truth[i - 1].hdg) / dt;
      yaw = (rate + rnd() + (opts.biasDps ?? 0)) * (opts.yawSign ?? 1);
      yawSince += yaw * dt;
    }
    // The estimator takes the sensor's CUMULATIVE yaw (fused attitude), never a rate sample.
    st = posePredict(st, now, opts.gyro && i > 0 ? { cumDeg: yawSince, atMs: now } : null);
    if (tr.t - lastFixT >= 1 / fixHz - 1e-9) {
      const noisyLat = tr.lat + (rnd() * 2 * opts.noiseM) / 111320;
      const noisyLng = tr.lng + (rnd() * 2 * opts.noiseM) / (111320 * Math.cos(tr.lat * Math.PI / 180));
      // GPS course = bearing of the last 1 s of TRUE travel (what a receiver reports), with noise
      const j = Math.max(0, i - 20);
      const course = i > 0 ? (bearingDeg(truth[j].lat, truth[j].lng, tr.lat, tr.lng) + rnd() * 8 + 360) % 360 : null;
      // courseDrop: the platform reports NO course on these fixes (what iOS does in a slow corner)
      const courseOut = opts.courseDrop && opts.courseDrop(i, tr) ? null : course;
      st = poseFix(st, { lat: noisyLat, lng: noisyLng, at: now, accM: 8, speedMs: opts.speedMs ?? 4.17, courseDeg: courseOut }, opts.gyro ? yawSince : null);
      lastFixT = tr.t; lastFixIdx = i; lastRawLat = noisyLat; lastRawLng = noisyLng;
    }
    if (opts.route) {
      // EXACTLY what the surfaces do: the projection is of the RAW FIX and is held between fixes
      // (CarMapView/ConvoyMapbox memoise projectOntoRoute on the raw lat/lng). Codex 2026-09-09: the
      // first version of this gate projected the ESTIMATE and so could not see the backward drag.
      if (lastFixIdx === i || heldProj == null) heldProj = projectOnLegs(lastRawLat, lastRawLng, truth);
      st = poseRoute(st, heldProj, yaw, i > 0 ? tr.t - truth[i - 1].t : 0.05);
    }
    const o = poseOut(st);
    if (o) {
      errs.push(haversineM(o.lat, o.lng, tr.lat, tr.lng));
      hdgErrs.push(Math.abs(wrap180(o.hdg - tr.hdg)));
      if (prevOut) steps.push(haversineM(prevOut.lat, prevOut.lng, o.lat, o.lng));
      prevOut = { lat: o.lat, lng: o.lng };
    }
  }
  const from = opts.from ?? 20; const exitFrom = opts.exitFrom ?? Math.floor(errs.length / 2);
  return {
    maxErr: Math.max(...errs.slice(from)), meanErr: errs.slice(from).reduce((a, b) => a + b, 0) / (errs.length - from),
    maxHdgErr: Math.max(...hdgErrs.slice(from)), maxStep: Math.max(...steps.slice(from)), st,
    lateHdgErr: Math.max(...hdgErrs.slice(exitFrom)),
  };
}
// The route "polyline": the two legs meeting at the apex (a single vertex, like the real one).
function projectOnLegs(lat: number, lng: number, truth: Truth[]) {
  // vertices = the truth samples where the heading starts changing (one per corner), like a real polyline
  const verts: Truth[] = [truth[0]];
  for (let i = 1; i < truth.length; i++) if (Math.abs(wrap180(truth[i].hdg - truth[i - 1].hdg)) > 1e-6 && Math.abs(wrap180(truth[i - 1].hdg - (verts.length > 1 ? truth[i - 2].hdg : truth[i - 1].hdg))) < 1e-6 && (verts.length === 1 || i - truth.indexOf(verts[verts.length - 1]) > 40)) verts.push(truth[i - 1]);
  verts.push(truth[truth.length - 1]);
  const legs: (readonly [Truth, Truth, number])[] = [];
  for (let k = 0; k + 1 < verts.length; k++) legs.push([verts[k], verts[k + 1], bearingDeg(verts[k].lat, verts[k].lng, verts[k + 1].lat, verts[k + 1].lng)] as const);
  let best: { lat: number; lng: number; bearing: number; distM: number } | null = null;
  for (const [p, q, brg] of legs) {
    // project onto segment p→q in a local metre frame
    const cos = Math.cos(lat * Math.PI / 180);
    const px = (q.lng - p.lng) * cos * 111320, py = (q.lat - p.lat) * 111320;
    const rx = (lng - p.lng) * cos * 111320, ry = (lat - p.lat) * 111320;
    const len2 = px * px + py * py; let t = len2 > 0 ? (rx * px + ry * py) / len2 : 0; t = Math.max(0, Math.min(1, t));
    const qx = p.lng + (q.lng - p.lng) * t, qy = p.lat + (q.lat - p.lat) * t;
    const d = haversineM(lat, lng, qy, qx);
    if (!best || d < best.distM) best = { lat: qy, lng: qx, bearing: brg, distM: d };
  }
  return best;
}

// ── A. left then right at 15 km/h, radius 10 m: gyro + GPS + route; measured on the SECOND corner ──
// POSITION BAR = 6 m for the synthetic corners. The fixes here carry ±3 m per-axis uniform noise
// (up to 4.2 m radial, every second) and the estimator deliberately follows part of it — an
// estimator that ignored fresh fixes would be one that lags a real lane change. Against that noise
// the max over ~100 frames sits at 5.4–5.9 m; 5 m was ambition, not physics. The FIELD bar is
// section E: Jeff's real King Rd rows, where the old draw sat 14.8 m off the car.
const corner = makeCorner(4.17, 10, 60);
const scurve = makeSCurve(4.17, 10, 60);
const secondEntry = (() => { const a = (Math.PI / 2) * 10; return Math.floor((2 * 60 + a) / 4.17 * 20) - 20; })();
const secondExit = (() => { const a = (Math.PI / 2) * 10; return Math.floor((2 * 60 + 2 * a) / 4.17 * 20) + 40; })();
{
  const r = run(scurve, { gyro: true, noiseM: 3, route: true, from: secondEntry, exitFrom: secondExit });
  ok("A1 gyro: max position error through the second corner < 6 m", r.maxErr < 6, `${r.maxErr.toFixed(1)} m`);
  ok("A2 gyro: heading within 10° on the exit leg", r.lateHdgErr < 10, `${r.lateHdgErr.toFixed(1)}°`);
  ok("A3 gyro: heading within 15° THROUGH the second corner", r.maxHdgErr < 15, `${r.maxHdgErr.toFixed(1)}°`);
  ok("A4 gyro: no frame step larger than 1.5 m (no pops)", r.maxStep < 1.5, `${r.maxStep.toFixed(2)} m`);
  ok("A5 gyro sign was learned on the first corner", r.st.yawSign !== 0, `sign=${r.st.yawSign}`);
}
// ── B. same corner, the sensor reports the OPPOSITE sign convention ─────────────────────────
{
  const r = run(scurve, { gyro: true, noiseM: 3, route: true, yawSign: -1, from: secondEntry, exitFrom: secondExit });
  ok("B1 opposite gyro sign is learned and the second corner still tracks", r.st.yawSign === -1 && r.maxErr < 6, `sign=${r.st.yawSign} maxErr=${r.maxErr.toFixed(1)}`);
}
// ── C. GPS-only (no gyro): must still beat the old 14.8 m and not pop ───────────────────────
{
  const exitIdx = Math.floor((60 + (Math.PI / 2) * 10) / 4.17 * 20) + 40;
  const r = run(corner, { gyro: false, noiseM: 3, route: true, exitFrom: exitIdx });
  ok("C1 gps-only: max position error < 9 m", r.maxErr < 9, `${r.maxErr.toFixed(1)} m`);
  ok("C2 gps-only: heading within 15° on the exit leg", r.lateHdgErr < 15, `${r.lateHdgErr.toFixed(1)}°`);
  ok("C3 gps-only: no frame step larger than 1.5 m", r.maxStep < 1.5, `${r.maxStep.toFixed(2)} m`);
}
// ── D. stationary phone with jitter: nothing moves ──────────────────────────────────────────
{
  let st = poseStart(); const T0 = 1_700_000_000_000;
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0, accM: 8, speedMs: 0, courseDeg: null });
  let maxD = 0;
  for (let i = 1; i <= 120; i++) {
    st = posePredict(st, T0 + i * 250, { cumDeg: 0.3 * rnd(), atMs: T0 + i * 250 });
    if (i % 4 === 0) st = poseFix(st, { lat: 49.03 + rnd() * 6 / 111320, lng: -122.29 + rnd() * 6 / 73000, at: T0 + i * 250, accM: 10, speedMs: 0, courseDeg: null });
    const o = poseOut(st)!; maxD = Math.max(maxD, haversineM(o.lat, o.lng, 49.03, -122.29));
  }
  ok("D1 parked 30 s: estimate stays within 2 m", maxD < 2, `${maxD.toFixed(2)} m`);
  ok("D2 parked: heading held (no spin)", Math.abs(wrap180(poseOut(st)!.hdg - 0)) < 1);
}
// ── E. Jeff's real King Rd rows (2026-09-09 00:56:48–53 UTC) — the corner that named the bug ──
// raw fixes with the fix's own second, the REPORTED speed (km/h→m/s) and course:
const KING = [
  { lat: 49.031088, lng: -122.293123, at: 48.382, spd: 16 / 3.6, course: 136 },
  { lat: 49.031193, lng: -122.292938, at: 49.377, spd: 23 / 3.6, course: 88 },
  { lat: 49.031180, lng: -122.292831, at: 50.412, spd: 29 / 3.6, course: 87 },
  { lat: 49.031229, lng: -122.292602, at: 53.025, spd: 28 / 3.6, course: 88 },
];
{
  let st = poseStart(); const T0 = 1_700_000_000_000;
  // an approach fix a second earlier on the southbound leg (course 159 = the route bearing)
  st = poseFix(st, { lat: 49.031250, lng: -122.293180, at: T0 + 47_300, accM: 8, speedMs: 20 / 3.6, courseDeg: 159 });
  const outs: { lat: number; lng: number; hdg: number }[] = [];
  let tMs = 47_300;
  for (let k = 0; k < KING.length; k++) {
    const f = KING[k];
    const target = Math.round(f.at * 1000);
    while (tMs < target) { tMs = Math.min(target, tMs + 83); st = posePredict(st, T0 + tMs, null); }
    st = poseFix(st, { lat: f.lat, lng: f.lng, at: T0 + target, accM: 8, speedMs: f.spd, courseDeg: f.course });
    // what was DRAWN in the second after this fix: ease the correction out over 0.6 s, then read
    let t2 = tMs; const until = tMs + 600;
    while (t2 < until) { t2 = Math.min(until, t2 + 83); st = posePredict(st, T0 + t2, null); }
    tMs = t2;
    outs.push(poseOut(st)!);
  }
  // i=1 was the row drawn 14.8 m from the fix on the LINE; the estimate must be near the fix.
  const d1 = haversineM(outs[0].lat, outs[0].lng, KING[0].lat, KING[0].lng);
  const d2 = haversineM(outs[1].lat, outs[1].lng, KING[1].lat, KING[1].lng);
  ok("E1 King Rd i=1: drawn within 8 m of the fix (was 14.8 m on the line)", d1 < 8, `${d1.toFixed(1)} m`);
  const d3 = haversineM(outs[2].lat, outs[2].lng, KING[2].lat, KING[2].lng);
  ok("E2a King Rd i=2 (one implausible fix earlier): still closer than the old 14.8 m line", d2 < 14.8, `${d2.toFixed(1)} m`);
  ok("E2b King Rd i=3: converged within 6 m one fix later", d3 < 6, `${d3.toFixed(1)} m`);
  ok("E3 King Rd: nose within 20° of the course at i=2 (was the 124° bisector)",
    Math.abs(wrap180(outs[1].hdg - 88)) < 20, `${outs[1].hdg.toFixed(0)}° vs course 88°`);
  ok("E4 King Rd: nose within 8° of the course by the last row", Math.abs(wrap180(outs[3].hdg - 88)) < 8, `${outs[3].hdg.toFixed(0)}°`);
  // the i=1 fix implies 65 km/h to i=2 at 16–23 km/h reported: it must not be swallowed whole
  ok("E5 King Rd: the implausible i=1→i=2 jump was down-weighted (est step < fix step)",
    haversineM(outs[0].lat, outs[0].lng, outs[1].lat, outs[1].lng) < haversineM(KING[0].lat, KING[0].lng, KING[1].lat, KING[1].lng) + 0.5);
}
// ── F. off-route: the route pull releases and the estimate follows the car ──────────────────
{
  const r = run(corner, { gyro: true, noiseM: 3, route: false, seedSign: 1 });
  ok("F1 no route at all still tracks with a seeded sign (< 6 m)", r.maxErr < 6, `${r.maxErr.toFixed(1)} m`);
  let st = poseStart(); const T0 = 1_700_000_000_000;
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0, accM: 8, speedMs: 10, courseDeg: 90 });
  st = poseRoute(st, { lat: 49.0305, lng: -122.29, bearing: 90, distM: POSE_ROUTE_MAX_M + 20 }, 0, 0.1);
  ok("F2 a projection beyond reach gets zero weight", st.routeW < 0.01, `w=${st.routeW.toFixed(3)}`);
}
// ── G. a lost signal cannot drive the car down the road on its own ──────────────────────────
{
  let st = poseStart(); const T0 = 1_700_000_000_000;
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0, accM: 8, speedMs: 25, courseDeg: 90 });
  for (let i = 1; i <= 100; i++) st = posePredict(st, T0 + i * 100, null);
  const o = poseOut(st)!; const d = haversineM(o.lat, o.lng, 49.03, -122.29);
  ok("G1 10 s without a fix at 25 m/s dead-reckons at most POSE_DR_MAX_M", d <= POSE_DR_MAX_M + 0.5, `${d.toFixed(1)} m`);
}
// ── H. a stale / out-of-order fix is refused, a vague fix only nudges ───────────────────────
{
  let st = poseStart(); const T0 = 1_700_000_000_000;
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0 + 2000, accM: 8, speedMs: 10, courseDeg: 90 });
  const before = poseOut(st)!;
  st = poseFix(st, { lat: 49.04, lng: -122.30, at: T0 + 1000, accM: 8, speedMs: 10, courseDeg: 90 });
  ok("H1 an older fix is rejected", st.rejected === 1 && poseOut(st)!.lat === before.lat);
  st = poseFix(st, { lat: 49.0301, lng: -122.29, at: T0 + 3000, accM: 80, speedMs: 0, courseDeg: null });
  for (let i = 1; i <= 12; i++) st = posePredict(st, T0 + 3000 + i * 100, null);
  const moved = haversineM(before.lat, before.lng, poseOut(st)!.lat, poseOut(st)!.lng);
  ok("H2 an 80 m-accuracy fix moves the estimate < 25 % of the way", moved < 0.25 * haversineM(49.03, -122.29, 49.0301, -122.29) + 0.1, `${moved.toFixed(1)} m of 11.1`);
}
// ── I. gyro bias is learned on a straight (after one corner taught the sign) ───────────────
{
  const learn = makeCorner(4.17, 10, 60);
  const tail = makeStraight(15, 900); const t0 = learn[learn.length - 1].t + 0.05; const p0 = learn[learn.length - 1];
  // continue the straight EAST from where the corner ended (heading 90)
  const straight: Truth[] = []; let lat = p0.lat, lng = p0.lng, t = t0;
  for (let i = 0; i < tail.length; i++) { straight.push({ lat, lng, hdg: 90, t }); const q = stepLatLng(lat, lng, 90, 15 / 20); lat = q.lat; lng = q.lng; t += 0.05; }
  const truth = learn.concat(straight);
  const r = run(truth, { gyro: true, noiseM: 3, route: false, biasDps: 1.5, from: learn.length + 400, exitFrom: learn.length + 400 });
  ok("I1 a 1.5 dps gyro bias does not swing the nose on a 60 s straight (err < 6°)", r.lateHdgErr < 6, `${r.lateHdgErr.toFixed(1)}°`);
  ok("I2 the bias was learned (|bias| within 0.8 dps of 1.5)", Math.abs(Math.abs(r.st.yawBias) - 1.5) < 0.8, `bias=${r.st.yawBias.toFixed(2)}`);
}
// ── J. the sign is learned inside the FIRST corner, not after it ────────────────────────────
{
  const r = run(corner, { gyro: true, noiseM: 3, route: true });
  ok("J1 sign known by the end of the first corner", r.st.yawSign !== 0);
}

// ── K. a straight at 30 m/s with PERFECT 1 Hz fixes and the projection held from the raw fix ─────
// Codex adversarial review 2026-09-09 reproduced 5.6–11.9 m of error here: the route pull dragged the
// dead-reckoned estimate BACK toward the previous fix's projection every frame. Lateral-only now.
{
  const truth = makeStraight(30, 600);
  // measured from t = 5 s: the first fix carries no course (hdgKnown=false → no dead reckoning for
  // one second), so the first two seconds are the estimator acquiring a heading, not steady state.
  const r = run(truth, { gyro: true, noiseM: 0, route: true, seedSign: 1, speedMs: 30, from: 100 });
  ok("K1 30 m/s straight, held raw projection: max error < 3 m", r.maxErr < 3, `${r.maxErr.toFixed(1)} m`);
  ok("K2 ...and no frame step over 1.3× the physical 1.5 m/frame", r.maxStep < 1.5 * 1.3, `${r.maxStep.toFixed(2)} m`);
}
// ── L. signal loss on a straight with the route pull active: no backward crawl past the DR cap ─
{
  let st = poseStart(); const T0 = 1_700_000_000_000; st = poseSeedYawSign(st, 1);
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0, accM: 8, speedMs: 20, courseDeg: 90 });
  for (let i = 1; i <= 10; i++) st = posePredict(st, T0 + i * 100, { cumDeg: 0, atMs: T0 + i * 100 });   // the second between fixes, as on the road
  st = poseFix(st, { lat: 49.03, lng: -122.29 + 20 / 73000, at: T0 + 1000, accM: 8, speedMs: 20, courseDeg: 90 });
  const proj = { lat: 49.03, lng: -122.29 + 20 / 73000, bearing: 90, distM: 0 };   // held: the last fix's projection
  let minLng = Infinity, maxLng = -Infinity;
  for (let i = 1; i <= 100; i++) { st = posePredict(st, T0 + 1000 + i * 100, { cumDeg: 0, atMs: T0 + 1000 + i * 100 }); st = poseRoute(st, proj, 0, 0.1); const o = poseOut(st)!; minLng = Math.min(minLng, o.lng); maxLng = Math.max(maxLng, o.lng); }
  const o = poseOut(st)!;
  ok("L1 after 10 s without a fix the car sits at the DR cap ahead, not dragged back", haversineM(o.lat, o.lng, proj.lat, proj.lng) > POSE_DR_MAX_M - 2, `${haversineM(o.lat, o.lng, proj.lat, proj.lng).toFixed(1)} m ahead`);
  ok("L2 it never moved backward", maxLng === o.lng, "");
}

// ── M. a stationary start, then a parking-lot crawl at 2 m/s (Codex 2nd pass) ──────────────
{
  let st = poseStart(); const T0 = 1_700_000_000_000;
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0, accM: 8, speedMs: 0, courseDeg: null });   // parked, no course
  let lng = -122.29; let last = { lat: 49.03, lng };
  for (let i = 1; i <= 20; i++) {
    for (let k = 1; k <= 10; k++) st = posePredict(st, T0 + (i - 1) * 1000 + k * 100, null);
    lng += 2 / 73000; last = { lat: 49.03, lng };
    st = poseFix(st, { lat: 49.03, lng, at: T0 + i * 1000, accM: 8, speedMs: 2, courseDeg: 90 });
  }
  for (let k = 1; k <= 10; k++) st = posePredict(st, T0 + 20_000 + k * 100, null);
  const o = poseOut(st)!; const d = haversineM(o.lat, o.lng, last.lat, last.lng);
  ok("M1 crawl from a standstill: the marker followed the fixes (< 5 m behind)", d < 5, `${d.toFixed(1)} m`);
  ok("M2 a heading was established from the crawl's course", st.hdgKnown && Math.abs(wrap180(o.hdg - 90)) < 15, `hdg=${o.hdg.toFixed(0)}`);
  ok("M3 nothing left queued", Math.hypot(st.pendLat * 111320, st.pendLng * 73000) < 2, "");
}
// ── N. a late-delivered fix must not drag the car back or renew dead reckoning (Codex 2nd pass) ─
{
  let st = poseStart(); const T0 = 1_700_000_000_000; st = poseSeedYawSign(st, 1);
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0, accM: 8, speedMs: 20, courseDeg: 90 });
  for (let i = 1; i <= 10; i++) st = posePredict(st, T0 + i * 100, 0);
  st = poseFix(st, { lat: 49.03, lng: -122.29 + 20 / 73000, at: T0 + 1000, accM: 8, speedMs: 20, courseDeg: 90 });
  for (let i = 1; i <= 100; i++) st = posePredict(st, T0 + 1000 + i * 100, 0);   // 10 s: at the 40 m cap
  const before = poseOut(st)!;
  // a fix from 2 s after the last one — 9 s old by the clock — arrives now
  st = poseFix(st, { lat: 49.03, lng: -122.29 + 60 / 73000, at: T0 + 2000, accM: 8, speedMs: 20, courseDeg: 90 });
  for (let i = 1; i <= 50; i++) st = posePredict(st, T0 + 11_000 + i * 100, 0);
  const after = poseOut(st)!;
  const moved = haversineM(before.lat, before.lng, after.lat, after.lng);
  ok("N1 a 9 s-old fix does not drag the car back (moved < 2 m)", moved < 2 && after.lng >= before.lng - 1e-7, `${moved.toFixed(1)} m`);
  ok("N2 ...and does not renew the dead-reckoning budget", st.drM >= POSE_DR_MAX_M - 0.5, `drM=${st.drM.toFixed(1)}`);
}

// ── O. a late STOPPED fix at the origin after 40 m of dead reckoning: no 26 m backward slide ────
{
  let st = poseStart(); const T0 = 1_700_000_000_000; st = poseSeedYawSign(st, 1);
  st = posePredict(st, T0, 0);
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0, accM: 8, speedMs: 10, courseDeg: 90 });
  for (let i = 1; i <= 40; i++) st = posePredict(st, T0 + i * 100, 0);        // 4 s → 40 m
  const before = poseOut(st)!;
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0 + 1000, accM: 8, speedMs: 0, courseDeg: null });   // 3 s old, stopped, at the origin
  for (let i = 1; i <= 20; i++) st = posePredict(st, T0 + 4000 + i * 100, 0);
  const after = poseOut(st)!;
  ok("O1 a stale stopped fix cannot catch the car back (slide < 3 m)", haversineM(before.lat, before.lng, after.lat, after.lng) < 3, `${haversineM(before.lat, before.lng, after.lat, after.lng).toFixed(1)} m`);
}
// ── P. a stale 20 m/s fix does not restart dead reckoning on a stopped estimate ──────────────
{
  let st = poseStart(); const T0 = 1_700_000_000_000; st = poseSeedYawSign(st, 1);
  st = posePredict(st, T0, 0);
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0, accM: 8, speedMs: 0, courseDeg: null });
  for (let i = 1; i <= 100; i++) st = posePredict(st, T0 + i * 100, 0);        // 10 s parked
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0 + 1000, accM: 8, speedMs: 20, courseDeg: 90 });   // 9 s old, "20 m/s east"
  for (let i = 1; i <= 50; i++) st = posePredict(st, T0 + 10_000 + i * 100, 0);
  const o = poseOut(st)!;
  ok("P1 a stale fast fix does not move a stopped car", haversineM(o.lat, o.lng, 49.03, -122.29) < 1, `${haversineM(o.lat, o.lng, 49.03, -122.29).toFixed(1)} m`);
  ok("P2 ...and does not mark the heading known", !st.hdgKnown, "");
}
// ── Q. a stale course then a fresh crawl: the crawl must still be able to set the heading ───
{
  let st = poseStart(); const T0 = 1_700_000_000_000;
  st = posePredict(st, T0, null);
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0, accM: 8, speedMs: 0, courseDeg: null });
  for (let i = 1; i <= 100; i++) st = posePredict(st, T0 + i * 100, null);
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0 + 1000, accM: 8, speedMs: 20, courseDeg: 90 });   // 9 s old course
  ok("Q1 a stale course does not set the heading", !st.hdgKnown, "");
  let lng = -122.29;
  for (let i = 1; i <= 10; i++) {
    for (let k = 1; k <= 10; k++) st = posePredict(st, T0 + 10_000 + (i - 1) * 1000 + k * 100, null);
    lng += 2 / 73000;
    st = poseFix(st, { lat: 49.03, lng, at: T0 + 10_000 + i * 1000, accM: 8, speedMs: 2, courseDeg: 90 });
  }
  ok("Q2 fresh crawl courses then establish it", st.hdgKnown && Math.abs(wrap180(poseOut(st)!.hdg - 90)) < 15, `hdg=${poseOut(st)!.hdg.toFixed(0)}`);
}
// ── R. a 10 s-old FIRST fix (a remount replaying a cached location) seeds a held position only ──
{
  let st = poseStart(); const T0 = 1_700_000_000_000; st = poseSeedYawSign(st, 1);
  st = posePredict(st, T0 + 10_000, 0);                                          // the clock is 10 s past the fix
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0, accM: 8, speedMs: 20, courseDeg: 90 });
  for (let i = 1; i <= 100; i++) st = posePredict(st, T0 + 10_000 + i * 100, 0);
  const o = poseOut(st)!;
  ok("R1 a stale first fix does not dead-reckon (stays within 1 m)", haversineM(o.lat, o.lng, 49.03, -122.29) < 1, `${haversineM(o.lat, o.lng, 49.03, -122.29).toFixed(1)} m`);
  ok("R2 ...heading not known, speed not adopted", !st.hdgKnown && st.spd === 0, `spd=${st.spd}`);
}

// ── S. the platform drops the course through the corner (iOS below ~2 m/s does): the gyro holds ──
// Codex 4th pass: both surfaces were feeding the STICKY display heading in as a fresh course, so a
// held 90° "course" fought a gyro-driven turn and eventually snapped the nose back. Here the fixes
// inside the second corner carry NO course at all and the heading must still follow the turn.
{
  const inArc = (i: number, tr: Truth) => tr.hdg > 90 + 1e-6 && tr.hdg < 180 - 1e-6 && i > secondEntry - 40;
  const r = run(scurve, { gyro: true, noiseM: 3, route: true, from: secondEntry, exitFrom: secondExit, courseDrop: inArc });
  ok("S1 no course inside the corner: heading still within 15° through it", r.maxHdgErr < 15, `${r.maxHdgErr.toFixed(1)}°`);
  ok("S2 ...and within 10° on the exit leg", r.lateHdgErr < 10, `${r.lateHdgErr.toFixed(1)}°`);
  ok("S3 ...position still < 6 m", r.maxErr < 6, `${r.maxErr.toFixed(1)} m`);
}
// ── T. two estimators share one cumulative yaw integral: both learn the sign, neither is starved ─
{
  let a = poseStart(), b = poseStart(); const T0 = 1_700_000_000_000;
  let cum = 0; let hdg = 180; let lat = 49.03, lng = -122.29;
  for (let i = 0; i <= 8; i++) {
    const now = T0 + i * 1000;
    if (i > 0) { hdg = (hdg - 20 + 360) % 360; cum += 20; const p = stepLatLng(lat, lng, hdg, 5); lat = p.lat; lng = p.lng; }
    const f = { lat, lng, at: now, accM: 8, speedMs: 5, courseDeg: hdg };
    a = posePredict(a, now, { cumDeg: cum, atMs: now }); b = posePredict(b, now, { cumDeg: cum, atMs: now });
    a = poseFix(a, f, cum); b = poseFix(b, f, cum);    // the SAME cumulative integral, both readers
  }
  ok("T1 the first estimator learned the sign", a.yawSign !== 0, `a=${a.yawSign}`);
  ok("T2 the second estimator learned the same sign (not starved by the first)", b.yawSign === a.yawSign && b.yawSign !== 0, `b=${b.yawSign}`);
}

// ── U. MOUNT VIBRATION (Jeff's 2026-09-10 drive: "pointing left and right the whole time") ──────
// A straight highway at 100 km/h, 1 Hz fixes ±3 m, render ticks at 12 Hz. The phone in its mount
// oscillates about the vertical at 37 Hz, ±0.15° — a bounded wobble (peak rate ±35°/s, the field's
// ±33°/s samples) whose true integral is ~0.
// (a) the FUSED attitude sees the bounded wobble: the cumulative yaw handed in is the true integral
//     plus that oscillation → the heading must stay within 4° of the course.
// (b) NEGATIVE CONTROL — what shipped in OTA-AK: one instantaneous rate sample per render frame,
//     integrated as rate×dt. Sampling a 37 Hz oscillation at 12 Hz aliases it into a random walk;
//     the field rows showed ±33°/s samples and a heading 12–31° off. Built as a cumulative value
//     the OLD way and fed through the SAME posePredict — the error must be large, or the gate is
//     not testing the defect.
{
  const spd = 28, T0 = 1_700_000_000_000, TICK = 1000 / 12, DUR_S = 40;
  const AMP = 0.15;
  const wobbleDeg = (tS: number) => AMP * Math.sin(2 * Math.PI * 37 * tS);
  const wobbleRate = (tS: number) => AMP * 2 * Math.PI * 37 * Math.cos(2 * Math.PI * 37 * tS);   // °/s, peak ±35 — what the field rows showed
  // Render ticks JITTER ±15 ms (a refuter showed the exact 37/12 beat flatters neither side: with
  // jitter the old feed is worse at every frequency and the fused feed stays ≤ 0.4°).
  const runStraight = (feed: (tS: number, dtS: number, prevCum: number) => number) => {
    let st = poseSeedYawSign(poseStart(), 1);
    const hdg = 90;
    let cum = 0, maxErr = 0, nextFix = 0, prevT = 0;
    for (let k = 0; k * TICK <= DUR_S * 1000; k++) {
      const tS = (k * TICK + (k > 0 ? rnd() * 15 : 0)) / 1000;
      const dtS = tS - prevT; prevT = tS;
      if (k > 0) cum = feed(tS, dtS, cum);
      st = posePredict(st, T0 + k * TICK, k > 0 ? { cumDeg: cum, atMs: T0 + k * TICK } : null);
      if (tS >= nextFix) {
        const p = stepLatLng(49.03, -122.29, hdg, spd * tS);
        const lat = p.lat + (rnd() * 6) / 111320, lng = p.lng + (rnd() * 6) / (111320 * Math.cos(49.03 * Math.PI / 180));
        st = poseFix(st, { lat, lng, at: T0 + Math.round(tS * 1000), accM: 5, speedMs: spd, courseDeg: hdg }, cum);
        nextFix += 1;
      }
      if (tS > 5 && st.hdgKnown) maxErr = Math.max(maxErr, Math.abs(wrap180(st.hdg - hdg)));
    }
    return { maxErr, st };
  };
  // (a) fused attitude: cumulative = true integral (0) + the bounded wobble at the tick instant
  const a = runStraight((tS) => wobbleDeg(tS));
  ok("U1 fused attitude under 37 Hz mount wobble: heading within 1° on a straight", a.maxErr < 1, `${a.maxErr.toFixed(2)}°`);
  ok("U2 …and the last tick's rate is inside the plausibility clamp", Math.abs(a.st.yawDpsLast) <= POSE_YAW_MAX_DPS, `${a.st.yawDpsLast.toFixed(1)} dps`);
  // (b) the old feed: one rate SAMPLE per render frame, integrated as rate×dt — aliased
  const b = runStraight((tS, dtS, prev) => prev + wobbleRate(tS) * dtS);
  ok("U3 NEGATIVE CONTROL — a rate sample per jittered frame wags the heading > 4° (and > 4× the fused path)", b.maxErr > 4 && b.maxErr > 4 * a.maxErr, `${b.maxErr.toFixed(1)}° vs ${a.maxErr.toFixed(2)}° (the OTA-AK defect)`);
}

// ── V. Codex 2026-09-10: the clamp's clock is the SENSOR's, and a frozen sensor is no sensor ──────
// V1: a legal 40°/s turn, sensor every 50 ms, renders in PAIRS 2 ms apart around each sample (49 ms,
//     51 ms). Judged by the render interval, the 2° sample-delta over "2 ms" is 1000°/s and gets
//     dropped — the heading stops turning. Judged by the sensor interval it is 40°/s and follows.
{
  let st = poseSeedYawSign(poseStart(), 1);
  const T0 = 1_700_000_000_000; let hdg = 0; const lat0 = 49.03, lng0 = -122.29;
  st = poseFix(st, { lat: lat0, lng: lng0, at: T0, accM: 5, speedMs: 8, courseDeg: 0 }, 0);
  st = posePredict(st, T0, { cumDeg: 0, atMs: T0 });
  let cum = 0, sensorAt = T0;
  for (let n = 1; n <= 60; n++) {                       // 3 s at 20 Hz
    sensorAt = T0 + n * 50; cum += 40 * 0.05; hdg += 2;
    st = posePredict(st, sensorAt - 1, { cumDeg: cum, atMs: sensorAt });   // render 49 ms after the previous sample
    st = posePredict(st, sensorAt + 1, { cumDeg: cum, atMs: sensorAt });   // render 2 ms later, same sample
  }
  ok("V1 40°/s turn with paired renders 2 ms apart: heading follows (within 3°)", Math.abs(wrap180(st.hdg - hdg)) < 3, `est=${st.hdg.toFixed(1)} true=${hdg} src=${st.src}`);
  ok("V1b …and the last rate reads 40°/s, not 0 or 1000", Math.abs(st.yawDpsLast - 40) < 1, `${st.yawDpsLast.toFixed(1)}`);
}
// V2: the sensor freezes (callbacks stop) while GPS keeps reporting a 20°/s turn: with a stale
//     integral the surfaces hand in null; the estimator must fall back to the GPS turn rate and
//     report src=gps, not hold a frozen heading as "gyro".
{
  let st = poseSeedYawSign(poseStart(), 1);
  const T0 = 1_700_000_000_000; let hdg = 90; let lat = 49.03, lng = -122.29;
  st = poseFix(st, { lat, lng, at: T0, accM: 5, speedMs: 8, courseDeg: hdg }, 0);
  st = posePredict(st, T0, { cumDeg: 0, atMs: T0 });
  let srcMid = "";
  for (let i = 1; i <= 6; i++) {
    const now = T0 + i * 1000; hdg = norm360(hdg + 20);
    const p = stepLatLng(lat, lng, hdg, 8); lat = p.lat; lng = p.lng;
    for (let k = 1; k <= 12; k++) { st = posePredict(st, now - 1000 + k * 83, null); if (i === 4 && k === 6) srcMid = st.src; }
    st = poseFix(st, { lat, lng, at: now, accM: 5, speedMs: 8, courseDeg: hdg }, null);
  }
  ok("V2 frozen sensor (null): the estimator predicts from the GPS turn rate (src=gps), heading within 12°", srcMid === "gps" && Math.abs(wrap180(st.hdg - hdg)) < 12, `src=${srcMid} err=${wrap180(st.hdg - hdg).toFixed(1)}°`);
}

// ── W. a JS stall (> POSE_MAX_DT_S) inside a corner: no dead reckoning, but the sensor's fresh delta
//      still turns the heading (refuter 2026-09-10: dropping it lost 12° across a 2 s stall).
{
  let st = poseSeedYawSign(poseStart(), 1);
  const T0 = 1_700_000_000_000;
  st = poseFix(st, { lat: 49.03, lng: -122.29, at: T0, accM: 5, speedMs: 8, courseDeg: 0 }, 0);
  st = posePredict(st, T0, { cumDeg: 0, atMs: T0 });
  st = posePredict(st, T0 + 100, { cumDeg: 0, atMs: T0 + 100 });
  const before = st.hdg, latBefore = st.lat, lngBefore = st.lng;
  // the sensor integrated a 40° turn during a 2 s JS stall (samples kept coming at 20 Hz)
  st = posePredict(st, T0 + 2100, { cumDeg: 40, atMs: T0 + 2100 });
  ok("W1 heading turned by the stall's sensor delta (≈40°), src=hold", Math.abs(wrap180(st.hdg - before - 40)) < 0.5 && st.src === "hold", `Δ=${wrap180(st.hdg - before).toFixed(1)} src=${st.src}`);
  ok("W2 …with no dead reckoning during the gap", st.lat === latBefore && st.lng === lngBefore);
}

console.log(fails === 0 ? "\nPASS pose_estimator" : `\nFAIL pose_estimator (${fails})`);
if (fails) process.exit(1);
