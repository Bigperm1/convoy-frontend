// The navigation ribbon, cut at the car — as GEOMETRY, never as paint.
//
// ── WHY THIS FILE EXISTS (2026-09-01, Jeff's 9 am drive, two watchdog kills) ─────────
// The route line has to vanish behind the car and start a speed-aware lead ahead of
// its nose, and that start point moves with an eased 12 Hz ticker so it never
// sawtooths against the marker. Until today that motion was expressed as PAINT: every
// tick handed @rnmapbox a new `style` for the ribbon layers — `lineTrimOffset`, and
// (because a multi-colour `lineGradient` will not render under a trim) the whole
// congestion gradient re-baked with the gap folded into its alpha.
//
// What that costs at the native layer, VERIFIED by reading @rnmapbox/maps 10.3.1:
//   RNMBXLayer.reactStyle didSet  →  DispatchQueue.main.async { addStylesAndUpdate() }
//     → RNMBXStyle.lineLayer(): re-applies EVERY property (oldReactStyle is only
//       consulted for image/pattern props — there is no diff)
//     → apply(style:) → MapboxMaps StyleManager.updateLayer(withId:) — a full
//       read-modify-write: getStyleLayerProperties serialises the ENTIRE layer,
//       expression trees included, through CoreFoundation strings, on the MAIN thread,
//       each call a synchronous round-trip to the map's render thread.
// Three ribbon layers × 12 Hz × two live maps (phone + car) ≈ 72 of those per second.
// The crash log's main-thread stack is exactly that path — RCTMountingManager →
// StyleManager.updateLayer → resolveUpdatedLayerProperties → getStyleLayerProperties →
// CFStringCreateImmutableFunnel3 → memmove — and the termination reason is
// `scene-update watchdog transgression … exhausted real (wall clock) time allowance of
// 10.00 seconds`. Five relaunches in four minutes at 90–113 km/h. The same stall, when
// it clears inside 10 s, is the "Show map froze the phone AND CarPlay" report: both
// surfaces share the one main thread.
//
// ── THE RULE THIS FILE ENFORCES ──────────────────────────────────────────────────────
// Nothing that changes per tick may be a LAYER PROPERTY. The ribbon layers are now
// fully static (data-driven colour + alpha from feature properties, set once); what
// moves per tick is the SOURCE — a FeatureCollection cut at the car — and a GeoJSON
// source update is the path Mapbox is built to take at animation rates: no style
// read-modify-write, no main-thread serialisation of expressions.
//
// Colour is carried per PIECE rather than as a line-progress gradient, so it survives
// the cut without being rebuilt: consecutive same-colour segments merge into runs, and
// each colour change is expanded into BLEND_STEPS short pieces of interpolated colour
// across the same 70 m band the gradient used, so the picture is the one the tester
// photos were tuned against. The soft fade-in ahead of the nose is FADE_STEPS pieces of
// rising alpha; the translucent glow casing stays ONE feature (overlapping translucent
// caps would draw as blobs at every seam) and starts mid-fade, where its 8 px blur
// reads as the same soft edge the old gradient fade produced.
//
// Both surfaces call exactly this, with their own camera zoom, so the phone, CarPlay and
// Android Auto cannot drift apart again (the four-surfaces rule).
import { metersPerDp } from "./routeTrim";
import { colorFor, type CongestionLevel } from "./mapboxDirections";

/** [lng, lat] — GeoJSON order, the order the sources already use. */
export type LngLat = [number, number];

export type RibbonRun = { startM: number; endM: number; color: string };

export type RibbonPartition = {
  coords: LngLat[];
  /** Cumulative metres at each vertex; cum[0] = 0. */
  cum: number[];
  totalM: number;
  /** Colour along the line — contiguous, ascending, covering [0, totalM]. */
  runs: RibbonRun[];
};

/** Feature `kind` values the ribbon layers filter on. */
export const RIBBON_CASING = "rc";
export const RIBBON_CORE = "rk";

/** Same band the line-progress gradient blended over (mapboxDirections BLEND_M). */
export const BLEND_M = 70;
const BLEND_STEPS = 4;
/**
 * The transparent→solid fade-in just past the trim, as pieces of rising alpha.
 * Six steps, not three: at 3× on the simulator three steps read as a ladder of bands
 * in front of the nose (each ~7-13 px on a ~20 m fade); six are ~3-7 px each and read
 * as continuous. With butt caps the pieces meet flush, so the steps are the only seam.
 */
const FADE_ALPHA = [0.14, 0.28, 0.43, 0.57, 0.72, 0.86];
/**
 * How far the line start must move ON SCREEN before the source is rebuilt.
 * MEASURED against a 300-vertex, 27 km line at 49°N with 12 Hz ticks: at 1 dp a car
 * at 100 km/h on the z14 highway camera still rebuilt ~9×/s (3.1 m per dp); 2 dp is
 * ~4.5×/s there and ~1 m in a z17 car park. The old trim had a residual 1.3 dp
 * sawtooth the ease comment calls "below the perceptual floor" and a 15 dp one that
 * was plainly visible; 2 dp sits at the quiet end of that range on a 12 px line.
 * (These are SOURCE updates — the animation path, no style read-modify-write — so
 * the number is about wasted work, not about the main thread.)
 */
export const RIBBON_STEP_DP = 2;

const R = 6371000;
function segM(a: LngLat, b: LngLat): number {
  const k = Math.PI / 180;
  const dLat = (b[1] - a[1]) * k;
  const dLng = (b[0] - a[0]) * k;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * k) * Math.cos(b[1] * k) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function hexRgb(c: string): [number, number, number] | null {
  if (typeof c !== "string") return null;
  const s = c.trim();
  if (s[0] !== "#") return null;
  const h = s.length === 4 ? s.slice(1).split("").map((ch) => ch + ch).join("") : s.slice(1, 7);
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const ra = hexRgb(a), rb = hexRgb(b);
  if (!ra || !rb) return t < 0.5 ? a : b;
  const c = (i: number) => Math.round(ra[i] + (rb[i] - ra[i]) * t);
  return `#${((c(0) << 16) | (c(1) << 8) | c(2)).toString(16).padStart(6, "0")}`;
}

/**
 * Measure the line once and colour it once. Congestion is applied per segment only
 * when it lines up with the geometry (one level per segment); otherwise the whole
 * ribbon is the base colour — never a mis-registered one.
 * Memoise on the caller's side: it changes only when the route or its traffic does.
 */
export function buildRibbonPartition(
  coords: readonly LngLat[] | null | undefined,
  congestion: readonly (CongestionLevel | string)[] | null | undefined,
  base: string,
): RibbonPartition | null {
  if (!coords || coords.length < 2) return null;
  const n = coords.length;
  const cum = new Array<number>(n);
  cum[0] = 0;
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + segM(coords[i - 1], coords[i]);
  const totalM = cum[n - 1];
  if (!(totalM > 0)) return null;

  let runs: RibbonRun[];
  if (!congestion || congestion.length !== n - 1) {
    runs = [{ startM: 0, endM: totalM, color: base }];
  } else {
    runs = [];
    let start = 0;
    let color = colorFor(congestion[0], base);
    for (let i = 1; i < n - 1; i++) {
      const c = colorFor(congestion[i], base);
      if (c !== color) {
        runs.push({ startM: start, endM: cum[i], color });
        start = cum[i];
        color = c;
      }
    }
    runs.push({ startM: start, endM: totalM, color });
    if (runs.length > 1) {
      // Expand each colour change into a blend band, shrunk where two changes crowd.
      const out: RibbonRun[] = [];
      let curStart = 0;
      for (let k = 0; k < runs.length; k++) {
        const r = runs[k];
        const next = runs[k + 1];
        if (!next) { out.push({ startM: curStart, endM: r.endM, color: r.color }); break; }
        const half = Math.min(BLEND_M / 2, (r.endM - r.startM) / 2, (next.endM - next.startM) / 2);
        const lo = r.endM - half, hi = r.endM + half;
        if (hi - lo < 0.5) {
          out.push({ startM: curStart, endM: r.endM, color: r.color });
          curStart = r.endM;
          continue;
        }
        if (lo > curStart) out.push({ startM: curStart, endM: lo, color: r.color });
        const w = (hi - lo) / BLEND_STEPS;
        for (let j = 0; j < BLEND_STEPS; j++) {
          out.push({ startM: lo + j * w, endM: lo + (j + 1) * w, color: mix(r.color, next.color, (j + 0.5) / BLEND_STEPS) });
        }
        curStart = hi;
      }
      runs = out;
    }
  }
  return { coords: coords as LngLat[], cum, totalM, runs };
}

/** Index of the segment containing metre `m`: cum[i] <= m < cum[i+1]. */
function segIndex(p: RibbonPartition, m: number): number {
  let lo = 0, hi = p.cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.cum[mid] <= m) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function pointAt(p: RibbonPartition, m: number): LngLat {
  const i = segIndex(p, m);
  const a = p.coords[i], b = p.coords[i + 1];
  const len = p.cum[i + 1] - p.cum[i];
  const t = len > 0 ? Math.max(0, Math.min(1, (m - p.cum[i]) / len)) : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** The line between two metre marks, with interpolated end points. */
export function sliceCoords(p: RibbonPartition, startM: number, endM: number): LngLat[] {
  const s = Math.max(0, Math.min(p.totalM, startM));
  const e = Math.max(s, Math.min(p.totalM, endM));
  if (e - s < 0.05) return [];
  const out: LngLat[] = [pointAt(p, s)];
  for (let i = segIndex(p, s) + 1; i < p.coords.length && p.cum[i] < e; i++) out.push(p.coords[i]);
  out.push(pointAt(p, e));
  return out;
}

function colorAt(p: RibbonPartition, m: number): string {
  for (const r of p.runs) if (m < r.endM) return r.color;
  return p.runs[p.runs.length - 1].color;
}

/**
 * The ribbon as features, cut at `cutM` metres along the line (null = the whole
 * route, i.e. preview or off-route). One casing feature + colour/alpha core pieces.
 * Every feature carries `index` so the alternates layer's index filter excludes it.
 */
export function buildRibbonFeatures(
  p: RibbonPartition | null,
  opts: { cutM: number | null; fadeM: number; index: number },
): any[] {
  if (!p) return [];
  const feats: any[] = [];
  const push = (kind: string, coords: LngLat[], extra: Record<string, unknown>) => {
    if (coords.length >= 2) {
      feats.push({
        type: "Feature",
        properties: { index: opts.index, kind, ...extra },
        geometry: { type: "LineString", coordinates: coords },
      });
    }
  };
  if (opts.cutM == null) {
    push(RIBBON_CASING, p.coords, {});
    for (const r of p.runs) push(RIBBON_CORE, sliceCoords(p, r.startM, r.endM), { color: r.color, alpha: 1 });
    return feats;
  }
  const cut = Math.max(0, Math.min(p.totalM, opts.cutM));
  if (p.totalM - cut < 1) return feats; // at the destination: nothing left to draw
  const fade = Math.max(0, Math.min(opts.fadeM, p.totalM - cut));
  // The glow is ONE feature (translucent caps would blob at seams) starting mid-fade,
  // where its blur reads as the old gradient's soft edge.
  push(RIBBON_CASING, sliceCoords(p, cut + fade * 0.5, p.totalM), {});
  let m = cut;
  if (fade > 0.5) {
    const w = fade / FADE_ALPHA.length;
    for (let j = 0; j < FADE_ALPHA.length; j++) {
      const a = m, b = m + w;
      push(RIBBON_CORE, sliceCoords(p, a, b), { color: colorAt(p, (a + b) / 2), alpha: FADE_ALPHA[j] });
      m = b;
    }
  }
  for (const r of p.runs) {
    if (r.endM <= m) continue;
    push(RIBBON_CORE, sliceCoords(p, Math.max(r.startM, m), r.endM), { color: r.color, alpha: 1 });
  }
  return feats;
}

/**
 * Metres the line start must move before the source is rebuilt: RIBBON_STEP_DP of
 * screen at this camera. The 12 Hz ticker keeps rendering; the memo keyed on the
 * quantised value simply hits, so a parked car costs nothing and a car at highway speed
 * rebuilds only when a pixel would actually change.
 */
export function ribbonStepM(zoom: number, lat: number, mapScale = 1): number {
  const raw = RIBBON_STEP_DP * metersPerDp(zoom, lat) * mapScale;
  if (!Number.isFinite(raw)) return 8;
  // Snapped to a power-of-two ladder (0.5, 1, 2, 4, 8, 16 m …). Review caught the
  // subtlety: bins are anchored at 0, so with a step that follows the camera's
  // CONTINUOUS zoom ease, floor(m / step) re-bins on every tick while the zoom settles
  // — a parked car would rebuild the source at 12 Hz for as long as the camera moved.
  // On the ladder the step only changes when zoom crosses a whole octave.
  return Math.max(0.5, Math.pow(2, Math.round(Math.log2(raw))));
}
export function quantiseM(m: number | null, stepM: number): number | null {
  return m == null ? null : Math.floor(m / stepM) * stepM;
}
