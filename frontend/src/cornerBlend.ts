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
// more than CORNER_D0 metres off, fully raw by CORNER_D1. Eased in fast, out slowly, so the
// marker never pops. Shared by both surfaces (ConvoyMapbox / CarMapView) so they agree.
export type CornerBlendState = { lastHdg: number | null; lastAt: number; rate: number; blend: number; tickAt: number };
export const newCornerBlendState = (): CornerBlendState => ({ lastHdg: null, lastAt: 0, rate: 0, blend: 0, tickAt: 0 });

const CORNER_RATE_DPS = 12;   // course swinging faster than this = a corner (a 90° turn at city speed is 20–40°/s)
const CORNER_D0 = 6;          // metres off the line before any blend
const CORNER_D1 = 16;         // fully raw beyond this
const MOVING_MS = 1.5;        // GPS course is noise below ~5 km/h
const RISE_MS = 250;
const FALL_MS = 700;
const angDelta = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

/** Returns 0..1: 0 = draw on the line, 1 = draw the raw fix. Call once per render/tick. */
export function cornerBlend(
  st: CornerBlendState,
  headingDeg: number | null | undefined,
  distM: number | null | undefined,
  speedMs: number,
  snapped: boolean,
  now: number = Date.now(),
): number {
  // Course rate from samples ≥150 ms apart (rAF-rate calls would divide by ~0).
  if (typeof headingDeg === "number" && Number.isFinite(headingDeg)) {
    if (st.lastHdg == null) { st.lastHdg = headingDeg; st.lastAt = now; }
    else {
      const dt = now - st.lastAt;
      if (dt >= 150) {
        const r = Math.abs(angDelta(st.lastHdg, headingDeg)) / (Math.min(dt, 2000) / 1000);
        st.rate = st.rate * 0.5 + r * 0.5;
        st.lastHdg = headingDeg; st.lastAt = now;
      }
    }
  }
  const turning = st.rate >= CORNER_RATE_DPS;
  const d = typeof distM === "number" && Number.isFinite(distM) ? distM : 0;
  const target = snapped && speedMs >= MOVING_MS && turning && d > CORNER_D0
    ? Math.max(0, Math.min(1, (d - CORNER_D0) / (CORNER_D1 - CORNER_D0)))
    : 0;
  const dt = st.tickAt ? Math.min(500, now - st.tickAt) : 0;
  st.tickAt = now;
  const k = Math.min(1, dt / (target > st.blend ? RISE_MS : FALL_MS));
  st.blend += (target - st.blend) * k;
  if (st.blend < 0.005) st.blend = 0;
  return st.blend;
}
