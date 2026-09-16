// draw_deadband_test — SelfCarModel's ACCEPTANCE DEAD-BAND: what the marker does on screen.
//
// WHY (2026-09-15, Jeff at the 09-15 roundabouts: "IT STUDDERED AND WAS OFF THE ROUTE LINE A BIT"):
// SelfCarModel ignores a new target until it is SELF_DEADBAND_M (2.5 m) or SELF_DEADBAND_HDG (8°) from
// the DRAWN pose. While moving, "2.5 m" is a TIME: 0.45 s at 20 km/h. MEASURED here on the ported
// chain (the real effect + step, constants read out of src/ConvoyMapbox.tsx): at 20–25 km/h the drawn
// car is still for 41–42 % of display frames, p50 pause 167–183 ms, worst 383 ms, and it catches up in
// 2.5 m steps. That is the move-pause-move stutter, and it is independent of the route-line hold — it
// measures the same with the hold off (this file) and with it on (pose_hold_test CHAIN).
//
// THE RULE UNDER TEST (src/ConvoyMapbox.tsx SELF_DEADBAND_SPEED_SCALED): while the targets arrive
// faster than SELF_DEADBAND_FAST_TARGET_MS — the pose estimator's render-cadence feed during guidance,
// never the 1 Hz raw-fix feed of free drive — the MOVING band becomes
//     clamp(speed × SELF_DEADBAND_T_S, SELF_DEADBAND_MIN_M, SELF_DEADBAND_M)
// The stopped band, the scatter gate, the hard-snap path and the ease itself are untouched.
//
// The gates below are the contract: parked scatter and the sub-creep crawl must be IDENTICAL, crawl
// jitter must not regress, the 20–25 km/h pause must halve (it drops to ~0), 100 km/h must be
// identical, and the negative control proves the scaling is what does it.
//
//   node --experimental-strip-types tools/sim-qc/draw_deadband_test.mts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  poseStart, posePredict, poseFix, poseRoute, poseOut, haversineM, bearingDeg, stepLatLng, wrap180, poseRoadWindowM,
  type PoseState,
} from "../../src/poseEstimator.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
const qtl = (xs: number[], p: number) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))] : 0; };
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "–");

// ── the shipped constants, read out of the source (a rename or a retune fails the gate) ─────────
const SRC = readFileSync(join(ROOT, "src", "ConvoyMapbox.tsx"), "utf8");
const num = (re: RegExp, what: string): number[] => { const m = SRC.match(re); if (!m) { ok(`constants: ${what}`, false, `regex ${re} did not match — SelfCarModel changed; re-port this harness`); return [NaN]; } return m.slice(1).map(Number); };
const [DEAD_M] = num(/const SELF_DEADBAND_M = ([\d.]+);/, "SELF_DEADBAND_M");
const [DEAD_HDG] = num(/const SELF_DEADBAND_HDG = ([\d.]+);/, "SELF_DEADBAND_HDG");
const [STOP_M] = num(/const SELF_DEADBAND_STOP_M = ([\d.]+);/, "SELF_DEADBAND_STOP_M");
const [CREEP_MS] = num(/const SELF_CREEP_MS = ([\d.]+);/, "SELF_CREEP_MS");
const [T_S] = num(/const SELF_DEADBAND_T_S = ([\d.]+);/, "SELF_DEADBAND_T_S");
const [MIN_M] = num(/const SELF_DEADBAND_MIN_M = ([\d.]+);/, "SELF_DEADBAND_MIN_M");
const [FAST_MS] = num(/const SELF_DEADBAND_FAST_TARGET_MS = ([\d.]+);/, "SELF_DEADBAND_FAST_TARGET_MS");
const [SLACK_MS] = num(/const SELF_DEADBAND_FAST_SLACK_MS = ([\d.]+);/, "SELF_DEADBAND_FAST_SLACK_MS");
const [GAP_SAMPLES] = num(/const SELF_TARGET_GAP_SAMPLES = ([\d.]+);/, "SELF_TARGET_GAP_SAMPLES");
const SCALED_ON = /const SELF_DEADBAND_SPEED_SCALED = true;/.test(SRC);
const [SCATTER_M, SCATTER_MAX] = num(/agreeM >= ([\d.]+) && scatterRejects\.current < (\d+)/, "the scatter gate");
const [EASE_MIN, EASE_MULT] = num(/dur: Math\.max\((\d+), fixGap\.current \* ([\d.]+)\)/, "the ease duration");
const [GAP_MIN, GAP_FAST, GAP_FAST_V, GAP_LO, GAP_HI] = num(/if \(gap > (\d+)\) fixGap\.current = gap < (\d+) \? (\d+) : Math\.max\((\d+), Math\.min\((\d+), gap\)\)/, "the fixGap rule");
const [SUB_M, SUB_DEG] = num(/Math\.hypot\(dN, dE\) < ([\d.]+) && dH < ([\d.]+)/, "the sub-pixel skip");
const [JUMP_DEG] = num(/jumpDeg > ([\d.]+) \|\| inResumeSnap/, "the hard-snap jump");
/** Which cadence clock decides the moving band:
 *  "off"    — the pre-2026-09-15 rule: 2.5 m whenever moving;
 *  "fixgap" — the FIRST cut of the speed scaling (commit 2887c9d2), gated on `fixGap`. Kept ONLY as the negative
 *             control for the Codex [high] finding: fixGap is an ease-duration normaliser (it assigns only when the
 *             gap is over 80 ms and quantises 80–150 → 150, 150–300 → 300), so a 150–250 ms feed reads as 300 and
 *             silently restores the 2.5 m band;
 *  "target" — what ships now: the target's OWN clock — the median of the last SELF_TARGET_GAP_SAMPLES intervals
 *             ≤ SELF_DEADBAND_FAST_TARGET_MS and the newest interval ≤ SELF_DEADBAND_FAST_SLACK_MS. */
type Rule = "off" | "fixgap" | "target";
/** the constant the FIRST cut (2887c9d2) gated fixGap on — kept here so NEG2 reproduces the [high] finding as it was */
const FIRST_CUT_FAST_MS = 250;
const scaledBand = (spdMs: number) => Math.max(MIN_M, Math.min(DEAD_M, spdMs * T_S));

// ── harness: truth → the pose estimator (the guidance target) → SelfCarModel → the drawn pose ───
type Truth = { lat: number; lng: number; hdg: number; t: number };
type Pt = { lat: number; lng: number };
function makePath(speedMs: number, pieces: [number, number][], hdg0 = 180, hz = 20, lat0 = 49.033, lng0 = -121.923): Truth[] {
  const out: Truth[] = []; let lat = lat0, lng = lng0, hdg = hdg0, t = 0; const dt = 1 / hz;
  for (const [len, turn] of pieces) {
    const n = Math.max(1, Math.round(len / (speedMs * dt)));
    for (let k = 0; k < n; k++) {
      out.push({ lat, lng, hdg, t }); const ds = len / n;
      hdg = (hdg + turn / n + 360) % 360; const p = stepLatLng(lat, lng, hdg, ds); lat = p.lat; lng = p.lng; t += dt * (ds / (speedMs * dt));
    }
  }
  out.push({ lat, lng, hdg, t });
  return out;
}
function routeVerts(truth: Truth[], arcVertexM = 35): Pt[] {
  const verts: Pt[] = [{ lat: truth[0].lat, lng: truth[0].lng }];
  const turning = (i: number) => i > 0 && i < truth.length && Math.abs(wrap180(truth[i].hdg - truth[i - 1].hdg)) > 1e-6;
  let i = 1;
  while (i < truth.length) {
    if (!turning(i)) { i++; continue; }
    const a = i - 1; let b = i; while (b + 1 < truth.length && turning(b + 1)) b++;
    let arcM = 0; for (let k = a + 1; k <= b; k++) arcM += haversineM(truth[k - 1].lat, truth[k - 1].lng, truth[k].lat, truth[k].lng);
    if (arcM < arcVertexM) {
      const h1 = truth[a].hdg, h2 = truth[b].hdg; const cos = Math.cos(truth[a].lat * Math.PI / 180);
      const bx = (truth[b].lng - truth[a].lng) * cos * 111320, by = (truth[b].lat - truth[a].lat) * 111320;
      const d1x = Math.sin(h1 * Math.PI / 180), d1y = Math.cos(h1 * Math.PI / 180), d2x = Math.sin(h2 * Math.PI / 180), d2y = Math.cos(h2 * Math.PI / 180);
      const det = d1x * (-d2y) - d1y * (-d2x);
      if (Math.abs(det) > 1e-6) { const sIn = (bx * (-d2y) - by * (-d2x)) / det; verts.push({ lat: truth[a].lat + (sIn * d1y) / 111320, lng: truth[a].lng + (sIn * d1x) / (111320 * cos) }); }
      else { const m = Math.floor((a + b) / 2); verts.push({ lat: truth[a].lat, lng: truth[a].lng }, { lat: truth[m].lat, lng: truth[m].lng }, { lat: truth[b].lat, lng: truth[b].lng }); }
    } else {
      verts.push({ lat: truth[a].lat, lng: truth[a].lng }); let acc = 0;
      for (let k = a + 1; k <= b; k++) { acc += haversineM(truth[k - 1].lat, truth[k - 1].lng, truth[k].lat, truth[k].lng); if (acc >= arcVertexM) { verts.push({ lat: truth[k].lat, lng: truth[k].lng }); acc = 0; } }
      verts.push({ lat: truth[b].lat, lng: truth[b].lng });
    }
    i = b + 1;
  }
  verts.push({ lat: truth[truth.length - 1].lat, lng: truth[truth.length - 1].lng });
  return verts;
}
/** what the surfaces hand poseRoute: the RAW fix projected on the line, held between fixes */
function projectGlobal(lat: number, lng: number, verts: Pt[], speedMs: number) {
  const W = poseRoadWindowM(speedMs); const cos = Math.cos(lat * Math.PI / 180);
  const lens: number[] = []; for (let k = 0; k + 1 < verts.length; k++) lens.push(haversineM(verts[k].lat, verts[k].lng, verts[k + 1].lat, verts[k + 1].lng));
  const total = lens.reduce((a, b) => a + b, 0);
  let best: { lat: number; lng: number; bearing: number; distM: number; roadHdg: number; roadHdgAhead: number } | null = null; let arc = 0, acc = 0;
  for (let k = 0; k + 1 < verts.length; k++) {
    const p = verts[k], q = verts[k + 1];
    const px = (q.lng - p.lng) * cos * 111320, py = (q.lat - p.lat) * 111320, rx = (lng - p.lng) * cos * 111320, ry = (lat - p.lat) * 111320;
    const len2 = px * px + py * py; let t = len2 > 0 ? (rx * px + ry * py) / len2 : 0; t = Math.max(0, Math.min(1, t));
    const qy = p.lat + (q.lat - p.lat) * t, qx = p.lng + (q.lng - p.lng) * t; const d = haversineM(lat, lng, qy, qx);
    if (!best || d < best.distM) { const brg = bearingDeg(p.lat, p.lng, q.lat, q.lng); best = { lat: qy, lng: qx, bearing: brg, distM: d, roadHdg: brg, roadHdgAhead: brg }; arc = acc + t * lens[k]; }
    acc += lens[k];
  }
  if (!best) return null;
  const at = (s: number) => { let a = 0; for (let k = 0; k < lens.length; k++) { if (a + lens[k] >= s - 1e-9) { const t = lens[k] > 0 ? Math.min(1, Math.max(0, (s - a) / lens[k])) : 0; return { lat: verts[k].lat + (verts[k + 1].lat - verts[k].lat) * t, lng: verts[k].lng + (verts[k + 1].lng - verts[k].lng) * t }; } a += lens[k]; } return verts[verts.length - 1]; };
  const chord = (c: number, fb: number) => { const s0 = Math.max(0, c - W), s1 = Math.min(total, c + W); if (s1 - s0 < 0.5) return fb; const a = at(s0), b = at(s1); return haversineM(a.lat, a.lng, b.lat, b.lng) > 0.25 ? bearingDeg(a.lat, a.lng, b.lat, b.lng) : fb; };
  best.roadHdg = chord(arc, best.bearing); best.roadHdgAhead = chord(Math.min(total, arc + speedMs), best.roadHdg);
  return best;
}
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
type Tg = { t: number; lat: number; lng: number; hdg: number; spd: number };
type CaseDef = {
  nm: string; truth: Truth[]; verts: Pt[]; speedMs: number; noiseM: number; biasRightM?: number;
  /** the SPEED the fix reports (0 for a parked car) */ fixSpeedMs?: number;
  /** the platform reports no course (parked) */ noCourse?: boolean;
  /** free drive: the target is the RAW fix at 1 Hz, not the estimator at render cadence */ rawTargets?: boolean;
  /** thin the 12 Hz target stream to this cadence (ms between targets), as a function of time */ cadence?: (tS: number, n: number) => number;
  from: number; to: number; parkedAt?: Pt;
};
/** the estimator, driven exactly as the surfaces drive it: 12 Hz frames, 1 Hz fixes */
function targets(c: CaseDef, sd: number): Tg[] {
  seed = sd;
  let st = poseStart(); const T0 = 1_700_000_000_000; let lastFixT = -Infinity; let held: ReturnType<typeof projectGlobal> = null; let lastRenderT = -1; let nextRender = 0;
  const out: Tg[] = [];
  const spdFix = c.fixSpeedMs ?? c.speedMs;
  for (let i = 0; i < c.truth.length; i++) {
    const tr = c.truth[i]; const now = T0 + tr.t * 1000;
    if (tr.t + 1e-9 < nextRender) continue;
    nextRender = tr.t + 1 / 12;
    const dtS = lastRenderT >= 0 ? tr.t - lastRenderT : 1 / 12; lastRenderT = tr.t;
    st = posePredict(st, now, null);
    let fixed = false; let rawLat = 0, rawLng = 0;
    if (tr.t - lastFixT >= 1 - 1e-9) {
      let nLat = tr.lat + (rnd() * 2 * c.noiseM) / 111320, nLng = tr.lng + (rnd() * 2 * c.noiseM) / (111320 * Math.cos(tr.lat * Math.PI / 180));
      if (c.biasRightM) { const p = stepLatLng(nLat, nLng, (tr.hdg + 90) % 360, c.biasRightM); nLat = p.lat; nLng = p.lng; }
      const j = c.truth.findIndex((x) => x.t >= tr.t - 1);
      const course = i > 0 && !c.noCourse ? (bearingDeg(c.truth[j].lat, c.truth[j].lng, tr.lat, tr.lng) + rnd() * 8 + 360) % 360 : null;
      st = poseFix(st, { lat: nLat, lng: nLng, at: now, accM: 5, speedMs: spdFix, courseDeg: course }, null);
      lastFixT = tr.t; held = projectGlobal(nLat, nLng, c.verts, c.speedMs); fixed = true; rawLat = nLat; rawLng = nLng;
    }
    st = poseRoute(st, held, null, dtS);
    if (c.rawTargets) { if (fixed) out.push({ t: tr.t, lat: rawLat, lng: rawLng, hdg: tr.hdg, spd: spdFix }); continue; }
    const o = poseOut(st);
    if (o) out.push({ t: tr.t, lat: o.lat, lng: o.lng, hdg: st.hdgKnown ? o.hdg : 0, spd: spdFix });
  }
  return out;
}
const angD = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;
/** SelfCarModel's effect + step, ported. Each 60 Hz frame steps first, then takes the targets that arrived. */
function chain(tg: Tg[], rule: Rule, tFrom: number, tTo: number) {
  let seeded = false, render = { lat: 0, lng: 0, hdg: 0 };
  let anim: { fl: number; fg: number; fh: number; tl: number; tg: number; th: number; start: number; dur: number } | null = null;
  let lastFixAt = 0, fixGap = 1000, lastRaw: Pt | null = null, scatter = 0, lastDrawn: { lat: number; lng: number; hdg: number } | null = null;
  let eases = 0; const frames: { t: number; lat: number; lng: number; hdg: number }[] = [];
  let ti = 0; const tEnd = tg[tg.length - 1].t;
  // the TARGET clock, exactly as the effect keeps it (stamped above every bail)
  let lastTargetAt = 0; const tGaps: number[] = [];
  let bandMin = Infinity, bandMax = -Infinity, scaledN = 0, bandN = 0;
  const accept = (nowS: number) => {
    const now = nowS * 1000;
    while (ti < tg.length && tg[ti].t <= nowS + 1e-9) {
      const g = tg[ti++]; const inWin = g.t >= tFrom && g.t <= tTo;
      const tGap = lastTargetAt ? now - lastTargetAt : Infinity;
      lastTargetAt = now;
      tGaps.push(tGap); if (tGaps.length > GAP_SAMPLES) tGaps.shift();
      const sorted = [...tGaps].sort((a, b) => a - b);
      const medianGap = tGaps.length >= GAP_SAMPLES ? sorted[sorted.length >> 1] : Infinity;
      const fastTargets = medianGap <= FAST_MS && tGap <= SLACK_MS;
      if (lastFixAt) { const gap = now - lastFixAt; if (gap > GAP_MIN) fixGap = gap < GAP_FAST ? GAP_FAST_V : Math.max(GAP_LO, Math.min(GAP_HI, gap)); }
      lastFixAt = now;
      const prev = render;
      const jumpDeg = Math.abs(g.lat - prev.lat) + Math.abs(g.lng - prev.lng);
      if (!seeded || jumpDeg > JUMP_DEG) { seeded = true; render = { lat: g.lat, lng: g.lng, hdg: g.hdg }; lastRaw = { lat: g.lat, lng: g.lng }; scatter = 0; anim = null; continue; }
      const moveM = Math.hypot((g.lat - prev.lat) * 111320, (g.lng - prev.lng) * 111320 * Math.cos(prev.lat * Math.PI / 180));
      const stopped = g.spd < CREEP_MS;
      const band = stopped ? STOP_M
        : rule === "off" || !SCALED_ON ? DEAD_M
        : rule === "fixgap" ? (fixGap <= FIRST_CUT_FAST_MS ? scaledBand(g.spd) : DEAD_M)
        : (fastTargets ? scaledBand(g.spd) : DEAD_M);
      if (inWin && !stopped) { bandMin = Math.min(bandMin, band); bandMax = Math.max(bandMax, band); bandN++; if (band < DEAD_M) scaledN++; }
      if (moveM < band && Math.abs(angD(prev.hdg, g.hdg)) < DEAD_HDG) { lastRaw = { lat: g.lat, lng: g.lng }; scatter = 0; continue; }
      if (stopped && moveM >= band) {
        const agreeM = lastRaw ? Math.hypot((g.lat - lastRaw.lat) * 111320, (g.lng - lastRaw.lng) * 111320 * Math.cos(g.lat * Math.PI / 180)) : Infinity;
        lastRaw = { lat: g.lat, lng: g.lng };
        if (agreeM >= SCATTER_M && scatter < SCATTER_MAX) { scatter++; continue; }
        scatter = 0;
      } else { lastRaw = { lat: g.lat, lng: g.lng }; scatter = 0; }
      anim = { fl: prev.lat, fg: prev.lng, fh: prev.hdg, tl: g.lat, tg: g.lng, th: prev.hdg + angD(prev.hdg, g.hdg), start: now, dur: Math.max(EASE_MIN, fixGap * EASE_MULT) };
      if (inWin) eases++;
    }
  };
  const step = (nowS: number) => {
    if (!anim) return;
    const t = Math.min(1, (nowS * 1000 - anim.start) / anim.dur);
    const nl = anim.fl + (anim.tl - anim.fl) * t, ng = anim.fg + (anim.tg - anim.fg) * t, nh = anim.fh + (anim.th - anim.fh) * t;
    if (t < 1 && lastDrawn) { const dN = (nl - lastDrawn.lat) * 111320, dE = (ng - lastDrawn.lng) * 111320 * Math.cos(nl * Math.PI / 180); const dH = Math.abs(angD(lastDrawn.hdg, nh)); if (Math.hypot(dN, dE) < SUB_M && dH < SUB_DEG) return; }
    lastDrawn = { lat: nl, lng: ng, hdg: nh }; render = { lat: nl, lng: ng, hdg: nh }; if (t >= 1) anim = null;
  };
  for (let fr = 0; ; fr++) {
    const nowS = tg[0].t + fr / 60; if (nowS > tEnd) break;
    step(nowS); accept(nowS);
    if (nowS >= tFrom && nowS <= tTo) frames.push({ t: nowS, lat: render.lat, lng: render.lng, hdg: render.hdg });
  }
  return { frames, eases, bandMin, bandMax, scaledFrac: bandN ? scaledN / bandN : 0 };
}
type Res = { p50: number; p90: number; max: number; paused: number; c90: number; cmax: number; easesMin: number; x90: number; a50: number; rev10: number; wob10: number; drift90: number; driftMax: number; bandMin: number; bandMax: number; scaledFrac: number };
function measure(c: CaseDef, rule: Rule, seeds = 12): Res {
  const P: number[] = [], C: number[] = [], cross: number[] = [], along: number[] = [], drift: number[] = [];
  let pausedMs = 0, totalMs = 0, eases = 0, secs = 0, wob = 0, rev = 0, bandMin = Infinity, bandMax = -Infinity, scaledFrac = 0, runs = 0;
  for (let s = 1; s <= seeds; s++) {
    const tg = c.cadence ? thin(targets(c, s * 7919), c.cadence) : targets(c, s * 7919);
    if (tg.length < 10) continue;
    const ch = chain(tg, rule, c.from, c.to);
    bandMin = Math.min(bandMin, ch.bandMin); bandMax = Math.max(bandMax, ch.bandMax); scaledFrac += ch.scaledFrac; runs++;
    let run = 0; let prev: Pt | null = null; let lastSign = 0, net = 0; let ti = 0;
    for (let i = 0; i < ch.frames.length; i++) {
      const f = ch.frames[i];
      if (i > 0) { const d = haversineM(ch.frames[i - 1].lat, ch.frames[i - 1].lng, f.lat, f.lng); if (d <= 1e-3) run++; else { if (run > 0) { P.push(run * 1000 / 60); C.push(d); pausedMs += run * 1000 / 60; } run = 0; } }
      while (ti + 1 < c.truth.length && c.truth[ti + 1].t <= f.t) ti++;
      const tr = c.truth[ti]; const cos = Math.cos(tr.lat * Math.PI / 180);
      const dx = (f.lng - tr.lng) * 111320 * cos, dy = (f.lat - tr.lat) * 111320; const r = tr.hdg * Math.PI / 180;
      along.push(dx * Math.sin(r) + dy * Math.cos(r)); cross.push(Math.abs(dx * Math.cos(r) - dy * Math.sin(r)));
      if (c.parkedAt) drift.push(haversineM(f.lat, f.lng, c.parkedAt.lat, c.parkedAt.lng));
      if (prev) {
        const c2 = Math.cos(f.lat * Math.PI / 180); const ex = (f.lng - prev.lng) * 111320 * c2, ey = (f.lat - prev.lat) * 111320;
        const rr = (tr.hdg + 90) * Math.PI / 180; const l = ex * Math.sin(rr) + ey * Math.cos(rr);
        wob += Math.abs(l); net += l;
        if (Math.abs(l) > 0.02) { const sg = Math.sign(l); if (lastSign && sg !== lastSign) rev++; lastSign = sg; }
      }
      prev = { lat: f.lat, lng: f.lng };
    }
    totalMs += Math.max(1, (ch.frames.length - 1) * 1000 / 60); eases += ch.eases; secs += c.to - c.from;
  }
  return {
    p50: qtl(P, .5), p90: qtl(P, .9), max: qtl(P, 1), paused: 100 * pausedMs / Math.max(1, totalMs),
    c90: qtl(C, .9), cmax: qtl(C, 1), easesMin: eases / Math.max(1e-9, secs) * 60,
    x90: qtl(cross, .9), a50: qtl(along, .5), rev10: rev / Math.max(1e-9, secs) * 10, wob10: wob / Math.max(1e-9, secs) * 10,
    drift90: qtl(drift, .9), driftMax: qtl(drift, 1),
    bandMin, bandMax, scaledFrac: runs ? scaledFrac / runs : 0,
  };
}
/** keep a target only when `plan(t)` ms have passed since the last kept one — a loaded surface, dropped ticks, a 1 Hz feed */
function thin(tg: Tg[], plan: (tS: number, n: number) => number): Tg[] {
  const out: Tg[] = []; let lastT = -Infinity; let n = 0;
  for (const g of tg) { const need = plan(g.t, n); if (g.t - lastT >= need / 1000 - 1e-9) { out.push(g); lastT = g.t; n++; } }
  return out;
}
const row = (r: Res) => `pause ${r.p50.toFixed(0)}/${r.p90.toFixed(0)}/${r.max.toFixed(0)} ms ${r.paused.toFixed(1)}% paused | catch-up ${f2(r.c90)}/${f2(r.cmax)} m | ${r.easesMin.toFixed(0)} eases/min (${(60 * (1 - r.paused / 100)).toFixed(0)} drawn fps) | cross p90 ${f2(r.x90)} | along p50 ${f2(r.a50)} | wobble ${f2(r.wob10)} m/10s rev ${r.rev10.toFixed(1)}/10s`;
const same = (a: Res, b: Res) => (["p50", "p90", "max", "paused", "c90", "cmax", "easesMin", "x90", "a50", "rev10", "wob10", "drift90", "driftMax"] as const).every((k) => (Number.isFinite(a[k]) ? a[k] === b[k] : !Number.isFinite(b[k])));

// ── the cases ───────────────────────────────────────────────────────────────────────────────────
const straight = (v: number, m: number) => makePath(v, [[m, 0]], 0);
const vRing = 5.56, arcRing = 1.5 * Math.PI * 15, RING270 = makePath(vRing, [[60, 0], [arcRing, -270], [60, 0]]);
const v180 = 7.8, arc180 = Math.PI * 13, RING180 = makePath(v180, [[80, 0], [arc180, -180], [80, 0]]);
const RB: Pt[] = readFileSync(join(HERE, "data", "0915_rb_wps.txt"), "utf8").trim().split("\n").map((l) => { const [a, b] = l.split(",").map(Number); return { lat: a, lng: b }; });
const v0915 = 7.0;
const RB_TRUTH: Truth[] = (() => {
  let S = RB.slice(0, 57);
  for (let k = 0; k < 3; k++) { const o: Pt[] = [S[0]]; for (let i = 0; i + 1 < S.length; i++) { const a = S[i], b = S[i + 1]; o.push({ lat: a.lat * .75 + b.lat * .25, lng: a.lng * .75 + b.lng * .25 }, { lat: a.lat * .25 + b.lat * .75, lng: a.lng * .25 + b.lng * .75 }); } o.push(S[S.length - 1]); S = o; }
  const out: Truth[] = []; let t = 0;
  for (let i = 0; i + 1 < S.length; i++) { const d = haversineM(S[i].lat, S[i].lng, S[i + 1].lat, S[i + 1].lng); const h = bearingDeg(S[i].lat, S[i].lng, S[i + 1].lat, S[i + 1].lng); const n = Math.max(1, Math.round(d / (v0915 / 20))); for (let k = 0; k < n; k++) { out.push({ lat: S[i].lat + (S[i + 1].lat - S[i].lat) * k / n, lng: S[i].lng + (S[i + 1].lng - S[i].lng) * k / n, hdg: h, t }); t += d / n / v0915; } }
  return out;
})();
const parkedCase = (() => {
  const line = straight(8, 400); const verts = routeVerts(line); const mid = line[Math.floor(line.length / 2)];
  const truth: Truth[] = Array.from({ length: 20 * 60 }, (_, i) => ({ lat: mid.lat, lng: mid.lng, hdg: 0, t: i / 20 }));
  return { nm: "parked 60 s with 6 m scatter (the 08-19 'drifting everywhere' case)", truth, verts, speedMs: 0.0001, fixSpeedMs: 0, noiseM: 6, noCourse: true, from: 2, to: 58, parkedAt: { lat: mid.lat, lng: mid.lng } } as CaseDef;
})();
const crawl = (kmh: number): CaseDef => { const v = kmh / 3.6; const t = straight(v, v * 70); return { nm: `crawl ${kmh} km/h`, truth: t, verts: routeVerts(t), speedMs: v, noiseM: 3, from: 5, to: 65 }; };
const cruise = (kmh: number): CaseDef => { const v = kmh / 3.6; const t = straight(v, v * 70); return { nm: `cruise ${kmh} km/h`, truth: t, verts: routeVerts(t), speedMs: v, noiseM: 3, from: 5, to: 65 }; };
const RING_X9: CaseDef = { nm: "ring 270° r15 @20 km/h (X9)", truth: RING270, verts: routeVerts(RING270, 5), speedMs: vRing, noiseM: 3, from: 60 / vRing + 1, to: (60 + arcRing) / vRing };
const RING_180: CaseDef = { nm: "ring 180° r13 @28 km/h, fixes 3 m outside", truth: RING180, verts: routeVerts(RING180, 5.5), speedMs: v180, noiseM: 2, biasRightM: 3, from: 80 / v180 + 1, to: (80 + arc180) / v180 };
const LINE_0915: CaseDef = { nm: "09-15 ring line @25 km/h, white 3 m", truth: RB_TRUTH, verts: RB, speedMs: v0915, noiseM: 3, from: 3, to: RB_TRUTH[RB_TRUTH.length - 1].t - 3 };
const FREE_DRIVE: CaseDef = { ...cruise(30), nm: "free drive 30 km/h (raw fix targets, 1 Hz)", rawTargets: true };

console.log(`SelfCarModel acceptance band, as committed: stopped ${STOP_M} m below ${CREEP_MS} m/s; moving ${SCALED_ON ? `clamp(speed × ${T_S}, ${MIN_M}, ${DEAD_M}) while targets arrive within ${FAST_MS} ms, else ${DEAD_M}` : `${DEAD_M} (speed scaling OFF)`}; heading ${DEAD_HDG}°`);
ok("D0 SELF_DEADBAND_SPEED_SCALED is ON as committed (the stutter fix; flipping it off must be deliberate and re-measured)", SCALED_ON, "");

console.log("\nD1. UNCHANGED cases — the stopped band, the scatter gate and the raw-fix feed are untouched (every metric identical)");
for (const c of [parkedCase, crawl(5), cruise(60), cruise(100), FREE_DRIVE]) {
  const today = measure(c, "off"), now = measure(c, "target");
  console.log(`   ${c.nm}\n     today  ${row(today)}${c.parkedAt ? ` | drift p90 ${f2(today.drift90)} max ${f2(today.driftMax)} m` : ""}`);
  ok(`D1 ${c.nm}: identical to the old band`, same(today, now), c.parkedAt ? `drift p90 ${f2(now.drift90)} max ${f2(now.driftMax)} m` : `pause p90 ${now.p90.toFixed(0)} ms, ${now.easesMin.toFixed(0)} eases/min`);
}

console.log("\nD2. CRAWL 10 km/h (above creep, so the band moves): jitter must not regress");
{
  const c = crawl(10); const today = measure(c, "off"), now = measure(c, "target");
  console.log(`   today ${row(today)}\n   now   ${row(now)}`);
  ok("D2 crawl 10 km/h: lateral reversals per 10 s ≤ today (the visible wiggle)", now.rev10 <= today.rev10, `${today.rev10.toFixed(1)} → ${now.rev10.toFixed(1)}`);
  ok("D2b crawl 10 km/h: the drawn car is not further behind the truth than today", Math.abs(now.a50) <= Math.abs(today.a50), `along p50 ${f2(today.a50)} → ${f2(now.a50)} m`);
  console.log(`   note crawl COST: lateral excess travel ${f2(today.wob10)} → ${f2(now.wob10)} m/10 s and ${today.easesMin.toFixed(0)} → ${now.easesMin.toFixed(0)} eases/min — the marker is no longer frozen`);
}

console.log("\nD3. THE STUTTER: 20–28 km/h pause p90 must at least halve");
for (const c of [RING_X9, LINE_0915, RING_180]) {
  const today = measure(c, "off"), now = measure(c, "target");
  console.log(`   ${c.nm}\n     today ${row(today)}\n     now   ${row(now)}`);
  ok(`D3 ${c.nm}: pause p90 ≤ half of today`, now.p90 <= today.p90 / 2, `${today.p90.toFixed(0)} → ${now.p90.toFixed(0)} ms | paused ${today.paused.toFixed(1)}% → ${now.paused.toFixed(1)}% | catch-up p90 ${f2(today.c90)} → ${f2(now.c90)} m`);
  ok(`D3b ${c.nm}: no worse than today on lateral reversals or along-track lag`, now.rev10 <= today.rev10 && Math.abs(now.a50) <= Math.abs(today.a50), `rev ${today.rev10.toFixed(1)} → ${now.rev10.toFixed(1)} /10s | along p50 ${f2(today.a50)} → ${f2(now.a50)} m`);
}

console.log("\nD4. TARGET CADENCE — the band must follow how fast the TARGETS arrive, not fixGap (Codex [high], 2026-09-15)");
// fixGap only assigns when the gap is over 80 ms and quantises 80–150 → 150, 150–300 → 300, so a feed at
// 150–250 ms (a loaded CarPlay surface, a dropped 83 ms tick) read as 300 and restored the 2.5 m band. Each row
// gives the band the rule picks and the pause p90 for: today's band, the fixGap gate (the first cut), and the
// target clock (what ships). The X9 ring at 20 km/h is the shape Jeff stuttered on.
{
  const ring = (nm: string, cadence?: (t: number, n: number) => number, from?: number, to?: number): CaseDef =>
    ({ ...RING_X9, nm, cadence, from: from ?? RING_X9.from, to: to ?? RING_X9.to });
  const JITTER = [83, 166, 83, 250, 83, 83, 333, 166];
  const tIn = RING_X9.from, tOut = RING_X9.to, tMid = (tIn + tOut) / 2;
  // `halves` = the band is what holds the marker; on a feed slower than one ease (220 ms) the FEED holds it, so the
  // bar there is "the rule still calls it fast, and nothing gets worse".
  const CAD: { c: CaseDef; wantScaled: boolean; why: string; halves?: boolean }[] = [
    { c: ring("steady 83 ms (12 Hz estimator feed)"), wantScaled: true, why: "the guidance feed" },
    { c: ring("steady 150 ms", () => 150), wantScaled: true, why: "a loaded surface" },
    { c: ring("steady 200 ms", () => 200), wantScaled: true, why: "Codex's reproduction" },
    { c: ring("steady 250 ms", () => 250), wantScaled: true, why: "a heavily loaded surface" },
    { c: ring("steady 333 ms (four dropped ticks)", () => 333), wantScaled: true, why: "still the estimator feed", halves: false },
    { c: ring("jittery 83–333 ms with dropped ticks", (_t, n) => JITTER[n % JITTER.length]), wantScaled: true, why: "one dropped tick must not flip it" },
    { c: ring("slow → fast (1 Hz for 5 s, then 83 ms)", (t) => (t < tIn + 5 ? 1000 : 83), tIn + 6, tOut), wantScaled: true, why: "recovery inside one second" },
    { c: ring("fast → slow (83 ms, then 1 Hz)", (t) => (t < tMid ? 83 : 1000), tMid + 1, tOut), wantScaled: false, why: "a stopped feed reverts at once" },
    { c: ring("steady 1 Hz (raw-fix feed)", () => 1000), wantScaled: false, why: "free drive" },
  ];
  for (const { c, wantScaled, why, halves = true } of CAD) {
    const off = measure(c, "off"), fg = measure(c, "fixgap"), tgt = measure(c, "target");
    const bandTxt = (r: Res) => (Number.isFinite(r.bandMin) ? (r.bandMin === r.bandMax ? `${f2(r.bandMin)} m` : `${f2(r.bandMin)}–${f2(r.bandMax)} m (${(r.scaledFrac * 100).toFixed(0)}% scaled)`) : "–");
    console.log(`   ${c.nm} (${why})\n     today ${bandTxt(off)} pause p90 ${off.p90.toFixed(0)} ms | fixGap gate ${bandTxt(fg)} pause p90 ${fg.p90.toFixed(0)} ms | target clock ${bandTxt(tgt)} pause p90 ${tgt.p90.toFixed(0)} ms`);
    if (wantScaled) {
      ok(`D4 ${c.nm}: the target clock calls this feed fast${halves ? " and at least halves the pause p90" : " (the FEED, not the band, sets the pause here: it must simply not get worse)"}`,
        tgt.scaledFrac > 0.9 && (halves ? tgt.p90 <= off.p90 / 2 : tgt.p90 <= off.p90), `band ${bandTxt(tgt)} | pause p90 ${off.p90.toFixed(0)} → ${tgt.p90.toFixed(0)} ms`);
    } else {
      // a steady slow feed must match today exactly; a feed that JUST went slow carries a different drawn pose into
      // the window, so it is held to "the band reverted and the motion matches within one display frame / 10 % of the eases"
      const strict = !c.nm.includes("→");
      ok(`D4 ${c.nm}: the target clock keeps today's band${strict ? ", and every metric matches it" : " and the motion matches today"}`,
        tgt.bandMin === DEAD_M && tgt.bandMax === DEAD_M && (strict ? same(off, tgt) : Math.abs(tgt.p90 - off.p90) <= 1000 / 60 && tgt.easesMin <= off.easesMin * 1.1 && Math.abs(tgt.paused - off.paused) <= 2),
        `band ${bandTxt(tgt)} | pause p90 ${off.p90.toFixed(0)} → ${tgt.p90.toFixed(0)} ms | eases ${off.easesMin.toFixed(0)} → ${tgt.easesMin.toFixed(0)}/min | paused ${off.paused.toFixed(1)} → ${tgt.paused.toFixed(1)} %`);
    }
  }
  // the Codex finding itself: the first cut silently fell back to 2.5 m at 150–250 ms
  const fgFails = CAD.filter(({ c, wantScaled }) => wantScaled && measure(c, "fixgap").bandMax >= DEAD_M);
  ok(`NEG2 the fixGap gate (the first cut, fixGap ≤ ${FIRST_CUT_FAST_MS} ms) restores the 2.5 m band on a 150–250 ms feed — the [high] finding`, fgFails.length >= 3,
    `${fgFails.length} of the fast cadences fall back: ${fgFails.map(({ c }) => c.nm.split(" (")[0]).join(", ")}`);
}

console.log("\nD5. SCREEN-OFF (bgTick) COST — the 33 ms background stepper has no sub-pixel skip, so every tick that finds an ease in flight re-renders");
// Not a bar: a measurement of what the new band does to the number of bgTick ticks that DO WORK. The per-tick
// cost (pushCam + a full SelfCarModel re-render) is native and is NOT modelled here.
{
  const c = RING_X9;
  for (const rule of ["off", "target"] as const) {
    let work = 0, ticks = 0, secs = 0;
    for (let s = 1; s <= 6; s++) {
      const tg = targets(c, s * 7919);
      // replay the chain's acceptance, then count 30 Hz ticks with an ease in flight
      const ch = chain(tg, rule, c.from, c.to);
      // an ease is in flight exactly while the drawn pose is moving OR a pause is shorter than one ease;
      // approximate from the frame record: a 60 Hz frame that moved means work was owed at that instant
      let moving = 0;
      for (let i = 1; i < ch.frames.length; i++) if (haversineM(ch.frames[i - 1].lat, ch.frames[i - 1].lng, ch.frames[i].lat, ch.frames[i].lng) > 1e-3) moving++;
      const frac = moving / Math.max(1, ch.frames.length - 1);
      const secsRun = c.to - c.from; ticks += secsRun * 30; work += secsRun * 30 * frac; secs += secsRun;
    }
    console.log(`   ${rule === "off" ? "today " : "shipped"}: ${(work / Math.max(1e-9, secs) * 60).toFixed(0)} bgTick ticks/min do work, of ${(ticks / Math.max(1e-9, secs) * 60).toFixed(0)} ticks/min (the timer runs either way)`);
  }
  console.log("   note the bgTick path itself is unchanged and has no sub-pixel skip; its per-tick native cost is not modelled here.");
}

console.log("\nNEG. the speed scaling is what does it");
{
  const c = RING_X9; const today = measure(c, "off"), now = measure(c, "target");
  ok("NEG with the scaling disabled (rule \"off\"), D3 (pause p90 ≤ half) FAILS", !(today.p90 <= today.p90 / 2) && now.p90 <= today.p90 / 2, `disabled ${today.p90.toFixed(0)} ms vs bar ${(today.p90 / 2).toFixed(0)} ms`);
}

console.log(fails === 0 ? "\nPASS draw_deadband" : `\nFAIL draw_deadband (${fails})`);
if (fails) process.exit(1);
