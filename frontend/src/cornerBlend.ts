// cornerBlend — let the DRAWN car leave the route line while it is actually turning.
//
// Jeff, 2026-09-03 drive home: "the turn into the parking lot was wide." The corner-trace
// receipt shows why: `i=1 mode=route d=15.9m sep=16m spd=24 hdg=124 gpsHdg=136 rb=159` — the
// marker was route-SNAPPED, so it followed the polyline's wide arc around the corner while
// the real car cut inside, 16 m apart for about a second, then 4.5 m on the lot road.
//
// The snap is right on straights (it hides lane offset and GPS scatter — d is normally
// 0–5 m and on a divided highway the line can sit 35 m away for minutes without anyone
// minding). It is wrong only WHILE TURNING, when the line's corner geometry and the car's
// path genuinely differ. So: blend the drawn position from the projected point toward the
// raw fix only when the GPS course is swinging (≥ CORNER_RATE_DPS) AND the projection is
// more than CORNER_D0 metres off, fully raw by CORNER_D1. Exponentially eased in fast, out
// slowly, so the marker never pops. Shared by both surfaces (ConvoyMapbox / CarMapView) so they agree.
export type CornerBlendState = {
  lastHdg: number | null;   // last DISTINCT course sample
  lastAt: number;           // when it arrived
  rate: number;             // deg/s measured between the last two distinct samples
  rateAt: number;           // when `rate` was measured (stale after RATE_HOLD_MS)
  blend: number;
  tickAt: number;
};
export const newCornerBlendState = (): CornerBlendState => ({ lastHdg: null, lastAt: 0, rate: 0, rateAt: 0, blend: 0, tickAt: 0 });

const CORNER_RATE_DPS = 12;   // course swinging faster than this = a corner (a 90° turn at city speed is 20–40°/s)
const CORNER_D0 = 6;          // metres off the line before any blend
const CORNER_D1 = 16;         // fully raw beyond this
const MOVING_MS = 1.5;        // GPS course is noise below ~5 km/h
const MIN_DELTA_DEG = 3;      // smaller swings between samples are GPS jitter, not steering
const MIN_DT_S = 0.25;        // a swing is never measured over less than this (no 150 ms inflation)
const MAX_DT_S = 3;           // ...nor spread over a gap longer than this
const RATE_HOLD_MS = 1500;    // a measured rate stands until the next sample or this long, then it is stale
const RISE_TAU_MS = 250;      // exponential time constants (63% at tau), not finite durations
const FALL_TAU_MS = 700;
const angDelta = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

// ── Codex second-opinion pass (2026-09-03, first run after sign-in) ──────────────
// Two real findings against the first version, both fixed here:
//  • The rate was recomputed on EVERY call ≥150 ms apart, but the course only changes when a GPS
//    fix lands (~1 Hz). Unchanged frames decayed the rate, and the next fix was measured over
//    ~150 ms instead of its real ~1 s interval — a 4° jitter read as 27°/s, which would have
//    released a car sitting 35 m from a divided-highway line. Now a sample counts only when the
//    course actually changes (≥ MIN_DELTA_DEG), the interval is the real gap between distinct
//    samples floored at MIN_DT_S, and the rate holds (does not decay) until the next sample.
//  • The 0.5 EMA halved the first measured swing, so a short lot-entrance turn could sit below
//    threshold. The raw per-sample rate is used instead.
//  It also pointed out the easing is exponential (63% at 250 ms), not a finite ease; the
//  constants are named as time constants now rather than pretending otherwise.

/** Returns 0..1: 0 = draw on the line, 1 = draw the raw fix. Call once per render/tick. */
export function cornerBlend(
  st: CornerBlendState,
  headingDeg: number | null | undefined,
  distM: number | null | undefined,
  speedMs: number,
  snapped: boolean,
  now: number = Date.now(),
): number {
  if (typeof headingDeg === "number" && Number.isFinite(headingDeg)) {
    if (st.lastHdg == null) { st.lastHdg = headingDeg; st.lastAt = now; }
    else {
      const delta = Math.abs(angDelta(st.lastHdg, headingDeg));
      const dtS = (now - st.lastAt) / 1000;
      if (delta >= MIN_DELTA_DEG) {
        // A real course change: rate over the true interval since the last distinct sample.
        st.rate = delta / Math.min(MAX_DT_S, Math.max(MIN_DT_S, dtS));
        st.rateAt = now;
        st.lastHdg = headingDeg; st.lastAt = now;
      } else if (dtS >= MAX_DT_S) {
        // Held steady for a while: re-anchor so an eventual swing is measured from here.
        st.lastHdg = headingDeg; st.lastAt = now;
      }
    }
  }
  const turning = st.rate >= CORNER_RATE_DPS && now - st.rateAt <= RATE_HOLD_MS;
  const d = typeof distM === "number" && Number.isFinite(distM) ? distM : 0;
  const target = snapped && speedMs >= MOVING_MS && turning && d > CORNER_D0
    ? Math.max(0, Math.min(1, (d - CORNER_D0) / (CORNER_D1 - CORNER_D0)))
    : 0;
  const dt = st.tickAt ? Math.min(500, now - st.tickAt) : 0;
  st.tickAt = now;
  const k = Math.min(1, dt / (target > st.blend ? RISE_TAU_MS : FALL_TAU_MS));
  st.blend += (target - st.blend) * k;
  if (st.blend < 0.005) st.blend = 0;
  return st.blend;
}
