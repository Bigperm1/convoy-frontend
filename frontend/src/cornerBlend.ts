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
  // ── cornerNose() state (2026-09-04) — see the NOSE COURSE CLAMP note below ──
  // These three count GPS FIXES, never renders — see "THE HOLD COUNTS FIXES, NOT FRAMES" below.
  offAt: number;            // FIX TIME of the first over-cone course sample of this run (0 = none)
  offFixAt: number;         // FIX TIME of the last one COUNTED — dedupes the ~12-60 renders of one fix
  offN: number;             // how many DISTINCT fixes in this run were over the cone
  hdgFix: number;           // the eased correction currently applied to the nose, degrees signed
  noseAt: number;           // last cornerNose() tick (stale after NOSE_STALE_MS)
};
export const newCornerBlendState = (): CornerBlendState => ({ lastHdg: null, lastAt: 0, rate: 0, rateAt: 0, blend: 0, tickAt: 0, offAt: 0, offFixAt: 0, offN: 0, hdgFix: 0, noseAt: 0 });

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

// ── NOSE COURSE CLAMP (2026-09-04, Olaf on OTA-V: "still drifting around the corners.
//    As in taking some but not all wide.") ────────────────────────────────────────────
// Nine corner-trace bursts off that drive. POSITION was never the complaint: `d` (drawn-vs-raw)
// was 0.1–5.0 m in 42 of 44 samples with one 8.6 m spike, and while snapped with cornerK=0 the
// drawn point IS the projection, so d = the car's distance from the line — under CORNER_D0
// almost throughout. The blend was correctly shut. The NOSE was the defect:
//
//   05:52:56–53:00 surf=car mode=route d=2.7/2.6/2.5/2.4/2.4m spd=23–44
//                  hdg 134→114   gpsHdg 89–90   rb 90
//
// mode=route with hdg ≠ gpsHdg means the nose came from noseBearing(routeProj) — i.e.
// projectOntoRoute's `bearingSmooth` — while `rb`, the segment bearing, had ALREADY settled to
// 90, the same value as the course. bearingSmooth is mixAng(tanStart, tanEnd, t) with
// tanStart = the bisector of the previous segment and this one, so just past a corner vertex it
// starts half a turn behind and only reaches the segment bearing at the FAR END of the segment.
// Reproduced exactly: prevSeg=178 gives tanStart=134 (the observed i=1) and t=0.45 gives 114
// (the observed i=5). On a long post-corner straight that is 4–5 s of car drawn 24–45° across
// its own direction of travel while sitting 2.4 m from the GPS. That is the "wide" look.
//
// The discriminator is the COURSE, not the segment. Measured over the nine bursts:
//   |hdg − rb|      clean 06:39:43 i=1 = 38°, defect 05:52:56 i=1 = 44°  ← cannot separate them
//   |hdg − gpsHdg|  clean 06:39:43 i=1 = 19°, defect 05:52:56 i=1 = 45°  ← separates cleanly
// (06:39:43 and 06:44:34 are bearingSmooth doing its JOB: rb had jumped ahead to 276/273 while
// the car was mid-turn at 219/224, and the smoothed nose sat between them. Those must not move.)
//
// So this CLAMPS, it does not chase: the nose may not sit more than NOSE_MAX_OFF_COURSE_DEG from
// the course while snapped and moving, and the correction is exactly 0 whenever it is within
// that — so on every straight, and on eight of the nine bursts above, the output is the input
// unchanged. Position is untouched: this function never moves the car, only where it points.
const NOSE_MAX_OFF_COURSE_DEG = 20;  // MEASURED 2026-09-04: worst clean burst 19° (06:39:43 i=1,
                                     // hdg 238 gpsHdg 219); the defect held 45°→24° for 5 s.
// ── THE HOLD COUNTS FIXES, NOT FRAMES (2026-09-04, Codex adversarial pass, [high]) ──────
// The first version held for NOSE_FIX_HOLD_MS = 1500 ms measured with `now` — RENDER time.
// But the call sites pass the SAME course value on every frame between GPS fixes (both are
// re-rendered by a 12 Hz trim ticker while the course only changes at ~1 Hz), so a SINGLE
// erroneous fix that merely stayed current for 1.5 s satisfied that hold and rotated the
// nose with no second GPS observation behind it. The hold is now measured in FIX time and
// requires NOSE_FIX_MIN_SAMPLES DISTINCT fixes, each over the cone, spanning ≥ NOSE_FIX_SPAN_MS.
// The measured justification is unchanged and still fits: the 05:52:56 defect was over the
// cone at BOTH ends of a 5 s window (44° at i=1, 24° at i=5) — five distinct fixes — while
// one bad fix is by construction one sample and can no longer move anything.
const NOSE_FIX_MIN_SAMPLES = 2;      // two DISTINCT over-cone fixes minimum. One is a sample, not evidence.
const NOSE_FIX_SPAN_MS = 1000;       // ...and they must span this much FIX time. Course fixes land at
                                     // ~1 Hz (measured: the corner-trace rows are 1 s apart, and
                                     // cornerBlend's own MIN_DT_S/RATE_HOLD_MS were sized off that
                                     // same cadence), so this is "≥ 2 real fixes" stated in time.
const NOSE_COURSE_STALE_MS = 3000;   // 3× the ~1 Hz fix cadence. A course older than this is not
                                     // evidence about where the car points NOW ⇒ no correction, and
                                     // any live one decays out. Covers a paused feed, a screen-off
                                     // handoff, and a frozen `heading` field.
const NOSE_FIX_MIN_SPEED_MS = 4.2;   // 15 km/h. Below this the raw course spins — that spin is the
                                     // whole reason the nose is locked to the line at all. The
                                     // defect ran at 23–44 km/h, so nothing here needs low speed.
const NOSE_RISE_TAU_MS = 400;        // 63% of a 25° correction in 400 ms ≈ 40°/s — inside the
                                     // 20–40°/s a real corner already turns at, so it reads as steering.
const NOSE_FALL_TAU_MS = 500;
const NOSE_FIX_DEADBAND_DEG = 0.25;  // ends the release tail; the draw path already skips frames
                                     // that rotate <0.08° (ConvoyMapbox.tsx), so this is invisible.
const NOSE_STALE_MS = 1500;          // not called for this long (unsnapped, or cornerK ≥ 0.5) ⇒
                                     // forget everything, and re-serve the hold before correcting
                                     // again, so a resumed snap can never pop the nose.

/** The heading to DRAW for a snapped car: `noseDeg` unless it is more than 20° off the GPS
 *  course, in which case it is pulled back to the edge of that cone. Call once per render.
 *  `courseAt` is WHEN that course sample arrived (see FixClock below) — it is what makes the
 *  hold count fixes instead of frames, so passing a per-render clock here would restore the
 *  exact defect the hold exists to prevent. No `courseAt` ⇒ no clamp, the correct failure. */
export function cornerNose(
  st: CornerBlendState,
  noseDeg: number,
  courseDeg: number | null | undefined,
  courseAt: number | null | undefined,
  speedMs: number,
  snapped: boolean,
  now: number = Date.now(),
): number {
  if (!Number.isFinite(noseDeg)) return noseDeg;
  const nose = ((noseDeg % 360) + 360) % 360;
  if (st.noseAt && now - st.noseAt > NOSE_STALE_MS) { st.hdgFix = 0; st.offAt = 0; st.offFixAt = 0; st.offN = 0; st.noseAt = 0; }
  let correction = 0;
  // A course with no arrival time, from the future (clock step), or older than
  // NOSE_COURSE_STALE_MS is not evidence: fall through to the reset below, which zeroes the
  // run and lets any live correction decay out on NOSE_FALL_TAU_MS.
  const fixAge = typeof courseAt === "number" && Number.isFinite(courseAt) ? now - courseAt : Infinity;
  if (snapped && fixAge >= 0 && fixAge <= NOSE_COURSE_STALE_MS
      && typeof courseDeg === "number" && Number.isFinite(courseDeg) && courseDeg >= 0
      && speedMs >= NOSE_FIX_MIN_SPEED_MS) {
    const err = angDelta(courseDeg, nose);              // signed nose-minus-course, −180..180
    const over = Math.abs(err) - NOSE_MAX_OFF_COURSE_DEG;
    if (over > 0) {
      const at = courseAt as number;
      if (at !== st.offFixAt) {                         // a NEW fix — not this one re-rendered
        if (!st.offAt || at < st.offAt) { st.offAt = at; st.offN = 0; }  // first, or the clock stepped back
        st.offFixAt = at;
        st.offN += 1;
      }
      if (st.offN >= NOSE_FIX_MIN_SAMPLES && st.offFixAt - st.offAt >= NOSE_FIX_SPAN_MS) {
        correction = -Math.sign(err) * over;
      }
    } else { st.offAt = 0; st.offFixAt = 0; st.offN = 0; }
  } else { st.offAt = 0; st.offFixAt = 0; st.offN = 0; }
  const dt = st.noseAt ? Math.min(500, now - st.noseAt) : 0;
  st.noseAt = now;
  // Ease the CORRECTION, never the heading: on a straight the correction is 0, so `hdgFix`
  // decays to 0 and the returned value is bit-identical to `noseDeg`. No lag is added anywhere
  // the nose was already right. The eased term also absorbs the 1 Hz steps in the course while
  // the clamp is engaged, so the nose rides the cone edge smoothly instead of stepping with GPS.
  const k = Math.min(1, dt / (correction !== 0 ? NOSE_RISE_TAU_MS : NOSE_FALL_TAU_MS));
  st.hdgFix += (correction - st.hdgFix) * k;
  if (correction === 0 && Math.abs(st.hdgFix) < NOSE_FIX_DEADBAND_DEG) st.hdgFix = 0;
  return st.hdgFix === 0 ? nose : (((nose + st.hdgFix) % 360) + 360) % 360;
}

// ── DERIVED FIX CLOCK (2026-09-04) ────────────────────────────────────────────────────
// cornerNose needs to know WHEN the course sample it is holding arrived. Neither surface
// carries the GPS fix's own timestamp that far down the draw path, VERIFIED:
//   • phone — `UserLocation` (ConvoyMapbox.tsx:103) and `CarPoint` (:1128) have
//     lat/lng/heading/speed/acc and no time field at all.
//   • car   — `setCarSelfPosition` DOES take a `fixTs` (carStore.ts:324) but keeps it in the
//     module-local write gate (`lastSelfPos`, :306/:346); it is never published into the
//     state CarMapView reads.
// Publishing the real Location.timestamp means editing map.tsx + carStore.ts, which this
// change does not own. So the fix moment is DERIVED: the wall clock of the render where the
// raw pose (lat/lng/course) last CHANGED. That is exactly the question the hold asks — "is
// this the same sample I already counted, or a new one?" — and pose changes at the fix rate.
// ⚠ LIMIT, stated rather than hidden: if a feed ever moved position while REPEATING a stale
// course value, this clock would call those distinct samples. Bounded, not eliminated:
//   • phone — the course is BearingTracker.get (map.tsx:4580). Above this clamp's 4.2 m/s floor
//     a 1 Hz fix moves ≥ ~4.2 m, over the tracker's MIN_MOVE_M = 3 m (bearing.ts:21), so it
//     returns either the GPS course or a FRESH prev→curr bearing — never the cached one.
//   • car   — carStore's heading is deliberately sticky (`heading ?? prevHeading`,
//     carStore.ts:356-359), so a null-course feed CAN repeat a value while position moves.
//     iOS only reports course = -1 (→ null) at low speed, which the 15 km/h gate already
//     excludes, but that is an argument, not a measurement.
// The one check that would settle it for real is publishing `fixTs` (carStore already
// RECEIVES it, carStore.ts:324, from map.tsx:3388's `pos.timestamp`) through carStore +
// UserLocation and passing it here instead; the signature already takes it.
export type FixClock = { lat: number; lng: number; hdg: number | null; at: number };
export const newFixClock = (): FixClock => ({ lat: NaN, lng: NaN, hdg: null, at: 0 });
/** Returns the derived arrival time of the CURRENT pose. Call once per render, before
 *  cornerNose, whether or not the clamp itself runs — a pose change on a frame that skipped
 *  the clamp would otherwise be dated to a later render. */
export function noteFix(
  fc: FixClock,
  lat: number | null | undefined,
  lng: number | null | undefined,
  hdg: number | null | undefined,
  now: number = Date.now(),
): number {
  const hd = typeof hdg === "number" && Number.isFinite(hdg) ? hdg : null;
  if (typeof lat !== "number" || !Number.isFinite(lat) || typeof lng !== "number" || !Number.isFinite(lng)) {
    // No usable pose ⇒ 0, which reads as infinitely stale in cornerNose. Never `now`: a
    // per-render timestamp is precisely what would let one sample masquerade as many.
    fc.lat = NaN; fc.lng = NaN; fc.hdg = null; fc.at = 0;
    return 0;
  }
  if (lat !== fc.lat || lng !== fc.lng || hd !== fc.hdg) { fc.lat = lat; fc.lng = lng; fc.hdg = hd; fc.at = now; }
  return fc.at;
}
