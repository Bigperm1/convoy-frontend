// navAnchor — along-route step anchoring for the turn-by-turn engine. PURE: no
// React, no RN, so it can be run in node against recorded drives.
//
// Why this exists (2026-08-21, rkoji7-061995 zombie drive, all from logged rows):
// twenty off-route refetches issued during a 3.5-minute excursion (06:29:35-06:33:11
// PT) all resolved together at 06:36:24, and the last one installed a route whose
// ORIGIN the car had left minutes earlier: at install the car projected to seg 84/219
// of the new polyline while stepIndex was reset to 0 and step 0's end was already
// behind it (turn= grew 1,595 -> 6,947 m as the car drove toward the destination).
// The advance loop only moves when the car comes within 25 m of the CURRENT step's
// end, so it could never move again; `remaining` (step-based) stayed ~14.9 km and
// both arrival gates key off it, so nav never ended (3h10m, no trip recorded).
//
// Anchoring by where the car sits ALONG the polyline, and which step ends lie ahead
// of that point, makes a swap land on the right step no matter how old the route is.
export type LL = { lat: number; lng: number };
export type LngLat = [number, number];

export type SegHit = { seg: number; t: number; distM: number };

const R = 6371000;
function toXY(lng: number, lat: number, lat0: number): [number, number] {
  const k = Math.PI / 180;
  return [(lng * k) * Math.cos(lat0 * k) * R, (lat * k) * R];
}

// Nearest segment of `coords` ([lng,lat] pairs) to point p — full scan, metres.
export function nearestSegment(coords: LngLat[], p: LL): SegHit | null {
  const n = coords.length - 1;
  if (n < 1) return null;
  const lat0 = p.lat;
  const [px, py] = toXY(p.lng, p.lat, lat0);
  let best: SegHit | null = null;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = toXY(coords[i][0], coords[i][1], lat0);
    const [bx, by] = toXY(coords[i + 1][0], coords[i + 1][1], lat0);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + dx * t - px, cy = ay + dy * t - py;
    const d = Math.sqrt(cx * cx + cy * cy);
    if (!best || d < best.distM) best = { seg: i, t, distM: d };
  }
  return best;
}

export const ANCHOR_MAX_OFF_M = 250;   // beyond this the car isn't on the line — don't anchor
export const ANCHOR_EPS_T = 0.02;      // same-segment tie: step end must be ahead of the car

export type Anchor = {
  index: number;          // step to anchor on
  carSeg: number;         // car's segment on the polyline (-1 if not on it)
  carT: number;
  endSegs: number[];      // each step end's segment (the step's END point)
  onRoute: boolean;       // false => car not within ANCHOR_MAX_OFF_M; index falls back to 0
};

// First step whose END lies ahead of the car along the polyline. Steps are walked
// in order so a self-overlapping route (out-and-back) resolves to the EARLIEST
// step still ahead, never a later pass over the same road.
export function anchorStepIndex(coords: LngLat[], steps: { end: LL }[], car: LL): Anchor {
  const endSegs: number[] = [];
  const endTs: number[] = [];
  for (const s of steps) {
    const h = s?.end ? nearestSegment(coords, s.end) : null;
    endSegs.push(h ? h.seg : -1); endTs.push(h ? h.t : 0);
  }
  const c = nearestSegment(coords, car);
  if (!c || c.distM > ANCHOR_MAX_OFF_M || !steps.length) {
    return { index: 0, carSeg: c ? c.seg : -1, carT: c ? c.t : 0, endSegs, onRoute: false };
  }
  for (let i = 0; i < steps.length; i++) {
    const es = endSegs[i];
    if (es < 0) continue;
    if (es > c.seg || (es === c.seg && endTs[i] > c.t + ANCHOR_EPS_T)) {
      return { index: i, carSeg: c.seg, carT: c.t, endSegs, onRoute: true };
    }
  }
  return { index: steps.length - 1, carSeg: c.seg, carT: c.t, endSegs, onRoute: true };
}
