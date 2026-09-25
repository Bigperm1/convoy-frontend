// ribbon_fold_test — THE FOLD: a route that doubles back past its own corner, driven by a car that takes the return
// leg directly (John Mungai, CarPlay, 2026-09-24 18:57 PDT: "the car under the route line").
//
//   node --experimental-strip-types tools/sim-qc/ribbon_fold_test.mts
//
// His reroute (data/0924_fold_kinggeorge.json, the real Mapbox route re-fetched with his bearing) went west 11 m, RIGHT
// onto King George, U-turned 239 m up and came back SOUTH past the same corner. He turned LEFT at the corner. Receipts:
// car surface `ribbon-trim lag=556 anchorOff=71 hint=prev proj=3` for the minute at the light (the cut anchor stuck at
// the corner, 72 m away, under anchorCutM's old 80 m acceptance — the global scan never ran); phone `anchorOff=73
// proj=72` → `proj=101` (the windowed projection stuck on the outbound corner until 120 m). Both surfaces drew the
// return leg through the car. This gate replays that drive (1 Hz fixes synthesised on the real geometry from the crumb
// speeds; 3 m east of the line like his draw-cmp rows) through the SAME modules the surfaces run — projectOntoRoute
// lifted verbatim from ConvoyMapbox.tsx, the pose estimator, route follow, anchorCutM — in the surfaces' frame order.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { anchorCutM, ANCHOR_RECHECK_M, type CutAnchorHint, type AnchorPartition } from "../../src/ribbonAnchor.ts";
import { PROJ_FOLD_M, foldPrefersGlobal } from "../../src/routeFold.ts";
import { poseStart, posePredict, poseFix, poseRoute, poseOut, haversineM, rfPredict, rfFix, rfPose, type RfState, type RfLine } from "../../src/poseEstimator.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => { console.log(`${cond ? "  ok  " : "  FAIL"} ${name} ${detail}`); if (!cond) fails++; };

// ── projectOntoRoute, verbatim from ConvoyMapbox.tsx (the PROJ_ constants through the function's closing brace) ──
const ROOT = new URL("../../", import.meta.url);
const srcLines = readFileSync(new URL("src/ConvoyMapbox.tsx", ROOT), "utf8").split("\n");
const a = srcLines.findIndex((l) => l.startsWith("const PROJ_WINDOW_MIN_M"));
const b = srcLines.findIndex((l) => l.includes("NAV-LOCK end mbx-route-project-b"));
const b2 = srcLines.findIndex((l, i) => i > b && l === "}");
if (a < 0 || b < 0 || b2 < 0) { console.log("  FAIL could not lift projectOntoRoute from ConvoyMapbox.tsx"); process.exit(1); }
const dir = mkdtempSync(join(tmpdir(), "fold-"));
const modPath = join(dir, "proj.mts");
writeFileSync(modPath,
  `import { poseRoadWindowM } from ${JSON.stringify(new URL("src/poseEstimator.ts", ROOT).pathname)};\n` +
  `import { foldPrefersGlobal } from ${JSON.stringify(new URL("src/routeFold.ts", ROOT).pathname)};\n` +
  srcLines.slice(a, b2 + 1).join("\n") + "\n");
const { projectOntoRoute } = await import(pathToFileURL(modPath).href);

// ── the route ─────────────────────────────────────────────────────────────────────────────────────────────────
const data = JSON.parse(readFileSync(new URL("data/0924_fold_kinggeorge.json", import.meta.url), "utf8"));
const geom: [number, number][] = data.coordinates;
function lineOf(g: [number, number][]): RfLine { const cum = [0]; for (let i = 1; i < g.length; i++) cum.push(cum[i - 1] + haversineM(g[i - 1][1], g[i - 1][0], g[i][1], g[i][0])); return { coords: g, cum, totalM: cum[cum.length - 1] }; }
const line = lineOf(geom); const part: AnchorPartition = line;
const coords = geom.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
const pointAt = (m: number) => { let i = 1; while (i < line.cum.length - 1 && line.cum[i] < m) i++; const s0 = line.cum[i - 1], s1 = line.cum[i]; const t = s1 > s0 ? (m - s0) / (s1 - s0) : 0; const p = geom[i - 1], q = geom[i]; return { lat: p[1] + (q[1] - p[1]) * t, lng: p[0] + (q[0] - p[0]) * t }; };
const corner = { lat: geom[1][1], lng: geom[1][0] };
let mReturn = 0, dReturn = Infinity;
for (let i = 0; i < geom.length; i++) if (line.cum[i] > 300) { const d = haversineM(corner.lat, corner.lng, geom[i][1], geom[i][0]); if (d < dReturn) { dReturn = d; mReturn = line.cum[i]; } }
// his light: the return-leg metre nearest his raw stop fix
const lightRaw = { lng: data.light_raw_shifted[0], lat: data.light_raw_shifted[1] };
let M_LIGHT = 0, dl = Infinity;
for (let m = mReturn; m < mReturn + 200; m += 1) { const p = pointAt(m); const d = haversineM(p.lat, p.lng, lightRaw.lat, lightRaw.lng); if (d < dl) { dl = d; M_LIGHT = m; } }
console.log(`route ${Math.round(line.totalM)} m · corner ${line.cum[1].toFixed(1)} m · return leg passes it at ${Math.round(mReturn)} m (${dReturn.toFixed(1)} m apart) · his light at ${M_LIGHT} m (${dl.toFixed(1)} m from the raw fix, ${Math.round(haversineM(corner.lat, corner.lng, lightRaw.lat, lightRaw.lng))} m from the corner)`);

// ── John's drive, 1 Hz on the real geometry, speeds from his crumbs ──────────────────────────────────────────
type Fix = { t: number; lat: number; lng: number; crs: number | null; spd: number };
const spdAt = (t: number) => t <= 1 ? 5.2 : t <= 3 ? 5.8 : t <= 5 ? 6.4 : t <= 8 ? 8.0 : t <= 10 ? 8.6 : t === 11 ? 7 : t === 12 ? 5 : t === 13 ? 3 : t === 14 ? 1.5 : t <= 49 ? 0.3 : t === 50 ? 3 : t === 51 ? 5 : t <= 57 ? 7.5 : t <= 60 ? 9 : t <= 76 ? 10.5 : 9.2;
const crsAt = (t: number): number | null => t <= 1 ? 270 : t === 2 ? 248 : t === 3 ? 239 : t === 4 ? 221 : t === 5 ? 203 : spdAt(t) < 1 ? null : 180;
const east = (p: { lat: number; lng: number }, mE: number) => ({ lat: p.lat, lng: p.lng + mE / (111320 * Math.cos(p.lat * Math.PI / 180)) });
function johnsDrive(lateralM = 3): Fix[] {
  const fixes: Fix[] = [{ t: 0, ...east(pointAt(0), lateralM), crs: 270, spd: spdAt(0) }, { t: 1, ...east(pointAt(9), lateralM), crs: 270, spd: spdAt(1) }];
  let m = mReturn + 4;
  for (let t = 2; t <= 80; t++) { m += spdAt(t); if (t <= 49) m = Math.min(m, M_LIGHT); fixes.push({ t, ...east(pointAt(m), lateralM), crs: crsAt(t), spd: spdAt(t) }); }
  return fixes;
}

// ── the surfaces' frame loop, 12 Hz, in the order the components run ─────────────────────────────────────────
type Row = { t: number; projM: number; projD: number; anchM: number; anchD: number; src: string; lag: number; hdg: number };
function run(surface: "car" | "phone", fixes: Fix[], ln: RfLine = line, cs = coords): Row[] {
  const T0 = 1_700_000_000_000, hz = 12;
  let st = poseStart(); let rf: RfState = null; let held: any = null; let hint: CutAnchorHint = null;
  let projAt: number | null = null; let prevFix: { lat: number; lng: number } | null = null;
  const rows: Row[] = []; let fi = 0; let lastT = -1 / hz;
  const tEnd = fixes[fixes.length - 1].t;
  for (let t = 0; t <= tEnd + 1e-9; t += 1 / hz) {
    const now = T0 + t * 1000; const dt = t - lastT; lastT = t;
    st = posePredict(st, now, null);
    rf = rfPredict(rf, ln, now, st.spd);
    let landed: Fix | null = null;
    while (fi < fixes.length && fixes[fi].t <= t + 1e-9) {
      const f = fixes[fi];
      st = poseFix(st, { lat: f.lat, lng: f.lng, at: T0 + f.t * 1000, accM: 3, speedMs: f.spd, courseDeg: f.crs }, null);
      rf = rfFix(rf, ln, { lat: f.lat, lng: f.lng, at: T0 + f.t * 1000, courseDeg: f.crs, speedMs: f.spd }, now);
      if (surface === "car") held = projectOntoRoute(f.lat, f.lng, cs, null, null, null, f.spd);            // CarMapView: global
      else {                                                                                                // ConvoyMapbox: windowed
        const movedM = prevFix ? Math.hypot((f.lat - prevFix.lat) * 111320, (f.lng - prevFix.lng) * 111320 * Math.cos(f.lat * Math.PI / 180)) : null;
        prevFix = { lat: f.lat, lng: f.lng };
        held = projectOntoRoute(f.lat, f.lng, cs, projAt, movedM, f.crs, f.spd);
        projAt = held ? held.frac * held.totalM : null;
      }
      landed = f; fi++;
    }
    st = poseRoute(st, held, null, dt);
    const o = poseOut(st); if (!o || !held) continue;
    const r = rfPose(rf, ln, st.spd); const d = r ?? o;
    const anch = anchorCutM(ln, d.lat, d.lng, hint, ln, held.frac * ln.totalM); hint = anch.hint;
    if (landed) rows.push({ t: landed.t, projM: held.frac * held.totalM, projD: held.distM, anchM: anch.m, anchD: anch.distM, src: anch.src, lag: held.frac * ln.totalM - anch.m, hdg: d.hdg });
  }
  return rows;
}
const at = (rows: Row[], lo: number, hi: number) => rows.filter((r) => r.t >= lo && r.t <= hi);
const maxAbs = (rows: Row[], k: keyof Row) => Math.max(...rows.map((r) => Math.abs(Number(r[k]))));
const firstGood = (rows: Row[], pred: (r: Row) => boolean) => rows.find((r) => r.t >= 2 && pred(r))?.t ?? Infinity;

// A · John's drive — both surfaces
console.log("A · John's fold, both surfaces (the drawn car and the cut must follow him onto the return leg)");
const car = run("car", johnsDrive()), phone = run("phone", johnsDrive());
const carOn = firstGood(car, (r) => r.anchD <= 5 && Math.abs(r.lag) <= 10);
const phoneProjOn = firstGood(phone, (r) => r.projD <= 5);
const phoneOn = firstGood(phone, (r) => r.anchD <= 5 && Math.abs(r.lag) <= 10);
console.log(`     car: cut anchor on the return leg from t=${carOn}s · phone: projection from t=${phoneProjOn}s, cut anchor from t=${phoneOn}s`);
ok("A1 car surface: the cut anchor is back on the car within 5 s of the turn", carOn <= 6, `t=${carOn}`);
ok("A2 car surface at the light (t 16–49): cut anchor ≤ 3 m off, lag ≤ 10 m", maxAbs(at(car, 16, 49), "anchD") <= 3 && maxAbs(at(car, 16, 49), "lag") <= 10, `anchorOff ${maxAbs(at(car, 16, 49), "anchD").toFixed(0)} lag ${maxAbs(at(car, 16, 49), "lag").toFixed(0)}`);
ok("A3 phone: the projection is back on the car within 6 s of the turn", phoneProjOn <= 7, `t=${phoneProjOn}`);
ok("A4 phone at the light: projection ≤ 5 m, cut anchor ≤ 3 m, lag ≤ 10 m", maxAbs(at(phone, 16, 49), "projD") <= 5 && maxAbs(at(phone, 16, 49), "anchD") <= 3 && maxAbs(at(phone, 16, 49), "lag") <= 10, `proj ${maxAbs(at(phone, 16, 49), "projD").toFixed(0)} anchorOff ${maxAbs(at(phone, 16, 49), "anchD").toFixed(0)} lag ${maxAbs(at(phone, 16, 49), "lag").toFixed(0)}`);
ok("A5 both surfaces stay on the car all the way out (t 56–80: lag ≤ 10 m)", maxAbs(at(car, 56, 80), "lag") <= 10 && maxAbs(at(phone, 56, 80), "lag") <= 10);
// the OLD behaviour, for the record (what the crumbs showed): computed with the pre-fix acceptance, from the same rows
const stuckCar = at(car, 6, 11).filter((r) => r.src === "prev" && r.anchM < 30).length;
console.log(`     (before the fix the car's anchor stayed at the corner through t=11 with anchorOff 34→77 m — now ${stuckCar} such frames)`);

// B · controls — the fold escape must not fire where the window was right
console.log("B · controls");
// B1 a divided road: two parallel legs 12 m apart, the car on its own leg 4 m off — the other carriageway must not capture it
{
  const LAT0 = 49.2, LNG0 = -122.9, MPD = 111320;
  const g: [number, number][] = [];
  for (let i = 0; i <= 80; i++) g.push([LNG0, LAT0 + i * 25 / MPD]);                       // north 2 km
  for (let i = 80; i >= 0; i--) g.push([LNG0 + 12 / (MPD * Math.cos(LAT0 * Math.PI / 180)), LAT0 + i * 25 / MPD]);   // back south, 12 m east
  const ln = lineOf(g); const cs = g.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
  const fx: Fix[] = []; for (let t = 0; t <= 60; t++) fx.push({ t, lat: LAT0 + (200 + t * 12) / MPD, lng: LNG0 - 4 / (MPD * Math.cos(LAT0 * Math.PI / 180)), crs: 0, spd: 12 });
  const ph = run("phone", fx, ln, cs), cr = run("car", fx, ln, cs);
  ok("B1 divided road: the phone projection never leaves the northbound leg (arc advances, ≤ 6 m off)", ph.every((r) => r.projD <= 6) && ph.every((r, i) => i === 0 || r.projM >= ph[i - 1].projM - 1), `maxOff ${maxAbs(ph, "projD").toFixed(1)}`);
  ok("B1 divided road: both cut anchors ride the northbound leg (lag ≤ 10 m)", maxAbs(ph, "lag") <= 10 && maxAbs(cr, "lag") <= 10);
}
// B2 a 40 m GPS spike off a single straight road: same segment either way — the escape changes nothing
{
  const LAT0 = 49.3, LNG0 = -122.8, MPD = 111320;
  const g: [number, number][] = []; for (let i = 0; i <= 80; i++) g.push([LNG0, LAT0 + i * 25 / MPD]);
  const ln = lineOf(g); const cs = g.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
  const fx: Fix[] = []; for (let t = 0; t <= 40; t++) fx.push({ t, lat: LAT0 + (300 + t * 12) / MPD, lng: LNG0 + (t === 20 ? 40 : 2) / (MPD * Math.cos(LAT0 * Math.PI / 180)), crs: 0, spd: 12 });
  const ph = run("phone", fx, ln, cs);
  const spike = ph.find((r) => r.t === 20)!;
  ok("B2 single road, 40 m spike: the arc keeps advancing through the spike (no leap)", ph.every((r, i) => i === 0 || r.projM >= ph[i - 1].projM - 1) && spike.projM > ph[19].projM, `spike projM ${spike.projM.toFixed(0)} (t19 ${ph[19].projM.toFixed(0)})`);
}
ok("B3 the fold rule is what it says: 31 m windowed vs 3 m global → global; 29 m vs 3 m → keep; 40 m vs 25 m → keep", foldPrefersGlobal(31 * 31, 9) && !foldPrefersGlobal(29 * 29, 9) && !foldPrefersGlobal(40 * 40, 25 * 25));
ok("B4 constants: PROJ_FOLD_M 30, ANCHOR_RECHECK_M 20", PROJ_FOLD_M === 30 && ANCHOR_RECHECK_M === 20);

console.log(fails === 0 ? "\nPASS ribbon_fold" : `\nFAIL ribbon_fold (${fails})`);
if (fails) process.exit(1);
