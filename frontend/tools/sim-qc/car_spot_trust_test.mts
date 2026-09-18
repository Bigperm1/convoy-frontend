// Car-spot trust gate — src/carSpotTrust.ts, the rules hydrate uses before believing a
// persisted parking spot. Replays Say Phin's 2026-09-06 record first (it must be REFUSED),
// then the legitimate shapes (they must still be adopted). Run:
//   node --experimental-strip-types tools/sim-qc/car_spot_trust_test.mts
import assert from "node:assert/strict";
import { spotAdoptVerdict, fixMayBecomeSpot, spotFacing, spotHeadingFor, headingTrackStep, HEADING_TRACK_EMPTY, SPOT_FACING_MAX_M, SPOT_HDG_MAX_DIST_M, SPOT_HDG_CREEP_MAX_M, SPOT_MAX_AGE_MS, SPOT_WRITE_MAX_SPEED_MS } from "../../src/carSpotTrust.ts";

const NOW = 1_800_000_000_000;
const H = 3600_000;
const out: string[] = [];

// A — Say Phin 09-06: written at 12:11 with AA attached, no disconnect witnessed, read 7.2 h later.
const sayPhin = { lat: 49.218541, lng: -123.040494, t: NOW - 25791 * 1000, att: 1 as const };
const a = spotAdoptVerdict(sayPhin, NOW);
assert.equal(a.adopt, false); assert.equal(a.why, "unwitnessed-attached");
out.push(`A sayphin: att=1 hu=0 age=7.2h → ${a.why}`);

// B — a witnessed head-unit park (car powered off, disconnect seen): adopted.
const b = spotAdoptVerdict({ ...sayPhin, hu: 1 }, NOW);
assert.equal(b.adopt, true);
out.push(`B witnessed park (hu=1) → adopt`);

// C — a phone-only park (no head unit ever attached): adopted as before.
const c = spotAdoptVerdict({ lat: 49.2, lng: -123.1, t: NOW - 2 * H }, NOW);
assert.equal(c.adopt, true);
out.push(`C phone-only spot 2h old → adopt`);

// C2 — a record written by the previous build (no att/hu fields at all): unchanged behaviour.
const c2 = spotAdoptVerdict({ lat: 49.2, lng: -123.1, t: NOW - 20 * H }, NOW);
assert.equal(c2.adopt, true);
out.push(`C2 legacy record 20h old → adopt`);

// D — stale beyond SPOT_MAX_AGE_MS, even if witnessed.
const d = spotAdoptVerdict({ lat: 49.2, lng: -123.1, t: NOW - SPOT_MAX_AGE_MS - 1, hu: 1 }, NOW);
assert.equal(d.adopt, false); assert.equal(d.why, "stale");
const d2 = spotAdoptVerdict({ lat: 49.2, lng: -123.1 }, NOW);   // the pre-08-29 immortal shape
assert.equal(d2.adopt, false); assert.equal(d2.why, "stale");
out.push(`D 24h+1ms → stale; no timestamp → stale`);

// E — malformed records never adopt.
for (const bad of [null, {}, { lat: "x", lng: 1, t: NOW }, { lat: NaN, lng: 1, t: NOW }]) {
  const e = spotAdoptVerdict(bad, NOW);
  assert.equal(e.adopt, false); assert.equal(e.why, "malformed");
}
out.push(`E malformed ×4 → malformed`);

// G — the OTA-AC regression (same night): Say Phin's spot written at the meet with hu=1 and a
// STOPPED last write must adopt; the same record whose last write was at 60 km/h (the app died
// while following the car home) must not, hu or no hu.
const g1 = spotAdoptVerdict({ lat: 49.171954, lng: -123.131714, t: NOW - 2804 * 1000, att: 1, hu: 1, mv: 0 }, NOW);
assert.equal(g1.adopt, true);
const g2 = spotAdoptVerdict({ lat: 49.2, lng: -123.05, t: NOW - 600 * 1000, att: 1, hu: 1, mv: 16.7 }, NOW);
assert.equal(g2.adopt, false); assert.equal(g2.why, "written-moving");
const g3 = spotAdoptVerdict({ lat: 49.2, lng: -123.05, t: NOW - 600 * 1000, mv: 4.2 }, NOW);   // phone-only, died at 15 km/h
assert.equal(g3.adopt, false); assert.equal(g3.why, "written-moving");
const g4 = spotAdoptVerdict({ lat: 49.2, lng: -123.05, t: NOW - 600 * 1000, mv: 0.4 }, NOW);   // phone-only, stopped
assert.equal(g4.adopt, true);
out.push(`G stopped+hu → adopt; 60km/h+hu → written-moving; phone-only 15km/h → written-moving; phone-only stopped → adopt`);

// H — Say Phin 22:31 on OTA-AD: a witnessed, stopped park at the meet (t = 21:45) but the car was
// seen DRIVING at 22:03 (persisted driving stamp) → he left it → refused. A stamp older than the
// spot (the pull-in itself) or within the grace keeps the park.
const meet = { lat: 49.171954, lng: -123.131714, t: NOW - 2804 * 1000, att: 1 as const, hu: 1 as const, mv: 0 };
const h1 = spotAdoptVerdict(meet, NOW, NOW - 1700 * 1000);   // drove 18 min after parking
assert.equal(h1.adopt, false); assert.equal(h1.why, "drove-after");
const h2 = spotAdoptVerdict(meet, NOW, NOW - 2900 * 1000);   // last drove 96 s BEFORE the spot
assert.equal(h2.adopt, true);
const h3 = spotAdoptVerdict(meet, NOW, NOW - 2804 * 1000 + 30_000);   // 30 s after: the pull-in
assert.equal(h3.adopt, true);
const h4 = spotAdoptVerdict(meet, NOW, 0);   // no stamp on disk
assert.equal(h4.adopt, true);
out.push(`H drove 18min after → drove-after; drove before/30s after/no stamp → adopt`);

// F — which fix speeds count as a STOP for the mv field: 7 km/h (Say Phin's frozen fix) does not;
// a crawl into the stall at 3 km/h and the final stop do; unknown speed counts as stopped.
assert.equal(fixMayBecomeSpot(7 / 3.6), false);
assert.equal(fixMayBecomeSpot(3 / 3.6), true);
assert.equal(fixMayBecomeSpot(0), true);
assert.equal(fixMayBecomeSpot(undefined), true);
assert.equal(fixMayBecomeSpot(SPOT_WRITE_MAX_SPEED_MS), false);
out.push(`F 7km/h=no 3km/h=yes 0=yes unknown=yes cap=${SPOT_WRITE_MAX_SPEED_MS}m/s`);

// ── F. THE PARKED HEADING (2026-09-16): spotFacing — the course the car stopped in, applied only AT the spot ──
{
  const spot = { lat: 49.2000, lng: -123.1000, hdg: 141, t: NOW - 9 * H };
  const dLat = (m: number) => m / 111320;
  const f1 = spotFacing(spot, { lat: spot.lat + dLat(10), lng: spot.lng }, NOW);
  assert.equal(f1, 141); out.push(`F1 10 m from the spot, 9 h old → ${f1}`);
  const f2 = spotFacing(spot, { lat: spot.lat + dLat(SPOT_FACING_MAX_M + 15), lng: spot.lng }, NOW);
  assert.equal(f2, null); out.push(`F2 ${SPOT_FACING_MAX_M + 15} m from the spot → null (the parkade exit, a lot)`);
  const f3 = spotFacing({ lat: spot.lat, lng: spot.lng, t: spot.t }, { lat: spot.lat, lng: spot.lng }, NOW);
  assert.equal(f3, null); out.push(`F3 a spot written before hdg existed → null`);
  const f4 = spotFacing({ ...spot, t: NOW - SPOT_MAX_AGE_MS - 60_000 }, { lat: spot.lat, lng: spot.lng }, NOW);
  assert.equal(f4, null); out.push(`F4 a spot older than its 24 h life → null`);
  const f5 = spotFacing({ ...spot, hdg: 360 }, { lat: spot.lat, lng: spot.lng }, NOW);
  assert.equal(f5, 0); out.push(`F5 hdg 360 → 0`);
  const f6 = spotFacing({ ...spot, hdg: -1 }, { lat: spot.lat, lng: spot.lng }, NOW);
  assert.equal(f6, null); out.push(`F6 hdg -1 (iOS "no course") → null`);
  const f7 = spotFacing({ lat: spot.lat, lng: spot.lng, hdg: 200 }, { lat: spot.lat, lng: spot.lng }, NOW);
  assert.equal(f7, 200); out.push(`F7 an in-memory spot with no timestamp → its hdg (age judged by hydrate already)`);
  assert.equal(spotFacing(null, { lat: 1, lng: 1 }, NOW), null); assert.equal(spotFacing(spot, null, NOW), null);
  out.push(`F8 no spot / no origin → null`);
  // The heading's PROVENANCE (Codex 09-16): it belongs to the place it was observed.
  const obs = { deg: 180, at: NOW - 60_000, lat: spot.lat, lng: spot.lng };
  assert.equal(spotHeadingFor(obs, { lat: spot.lat + dLat(20), lng: spot.lng }), 180);
  out.push(`F9 a spot 20 m from the heading's observation → 180`);
  assert.equal(spotHeadingFor(obs, { lat: spot.lat + dLat(SPOT_HDG_MAX_DIST_M + 40), lng: spot.lng }), null);
  out.push(`F10 a spot ${SPOT_HDG_MAX_DIST_M + 40} m away (the car moved while the app was gone) → null`);
  assert.equal(spotHeadingFor(null, { lat: spot.lat, lng: spot.lng }), null); assert.equal(spotHeadingFor({ ...obs, deg: -1 }, { lat: spot.lat, lng: spot.lng }), null);
  out.push(`F11 no observation / hdg -1 → null`);
  assert.equal(spotHeadingFor(obs, { lat: spot.lat + dLat(6), lng: spot.lng }, 3), 180);
  out.push(`F12 a normal stop: 3 m of creep after the last moving fix → 180`);
  assert.equal(spotHeadingFor(obs, { lat: spot.lat + dLat(6), lng: spot.lng }, SPOT_HDG_CREEP_MAX_M + 4), null);
  out.push(`F13 a slow three-point turn: ${SPOT_HDG_CREEP_MAX_M + 4} m crept below 1.5 m/s → null (the direction changed unseen)`);
}
// ── G. THE TRACKER on the production sequence (Codex round 3: the phone-only path never reached the creep rule) ──
{
  const step = (m: number) => m / 111320;
  const drive = (fixes: { m: number; spd: number; course: number | null; gate: boolean }[]) => {
    let t = HEADING_TRACK_EMPTY; let at = NOW;
    for (const f of fixes) { at += 1000; t = headingTrackStep(t, { lat: 49.2 + step(f.m), lng: -123.1, spd: f.spd, course: f.course, at }, f.gate); }
    return t;
  };
  // G1 — phone-only three-point turn: approach at 4 m/s (course 0, gate open), then 12 m of creep at 1 m/s with the gate
  //      CLOSED (below walking pace the phone-only path writes nothing), then a stop. The heading must be gone.
  const g1 = drive([{ m: 0, spd: 4, course: 0, gate: true }, { m: 4, spd: 4, course: 0, gate: true },
    ...Array.from({ length: 12 }, (_, i) => ({ m: 5 + i, spd: 1, course: null, gate: false })), { m: 17, spd: 0, course: null, gate: false }]);
  assert.equal(g1.obs, null); out.push(`G1 phone-only: 12 m crept at 1 m/s past a closed gate → heading retired`);
  // G2 — a normal parallel park: approach, 3 m of creep, stop — then the PHONE walks 30 m away at 1.2 m/s. Kept.
  const g2 = drive([{ m: 0, spd: 4, course: 90, gate: true }, { m: 4, spd: 4, course: 90, gate: true }, { m: 6, spd: 1.2, course: null, gate: true },
    { m: 7, spd: 0.8, course: null, gate: true }, { m: 7.5, spd: 0, course: null, gate: true },
    ...Array.from({ length: 25 }, (_, i) => ({ m: 8 + i * 1.2, spd: 1.2, course: null, gate: false }))]);
  assert.equal(g2.obs?.deg, 90); assert.equal(g2.frozen, true); out.push(`G2 parallel park then a 30 m walk → heading 90 kept (frozen at the stop)`);
  // G3 — a jogger with the gate closed never creates an observation.
  const g3 = drive(Array.from({ length: 10 }, (_, i) => ({ m: i * 3, spd: 3, course: 45, gate: false })));
  assert.equal(g3.obs, null); out.push(`G3 a moving course past a CLOSED gate → no observation`);
  // G4 — moving again after a park replaces the heading and re-arms the creep rule.
  const g4 = drive([{ m: 0, spd: 4, course: 90, gate: true }, { m: 4, spd: 0, course: null, gate: true }, { m: 4, spd: 5, course: 270, gate: true }]);
  assert.equal(g4.obs?.deg, 270); assert.equal(g4.frozen, false); out.push(`G4 driving off again → new heading 270, unfrozen`);
  // G5 — Codex r5b (2026-09-17): head unit ATTACHED, approach north, a temporary stop (a yield, selecting reverse), then a
  //      12 m turn at 1 m/s and the real park. The stop must not freeze the approach heading while the car is attached —
  //      the creep rule retires it. The same fixes phone-only (not attached) keep today's behaviour: the stop decides it.
  const g5fixes = [{ m: 0, spd: 6, course: 0 }, { m: 6, spd: 6, course: 0 }, { m: 8, spd: 0.1, course: null }, { m: 8, spd: 0, course: null },
    ...Array.from({ length: 12 }, (_, i) => ({ m: 9 + i, spd: 1, course: 90 })), { m: 21, spd: 0, course: null }];
  const driveAttached = (attached: boolean) => { let t = HEADING_TRACK_EMPTY; let at = NOW; for (const f of g5fixes) { at += 1000; t = headingTrackStep(t, { lat: 49.2 + step(f.m), lng: -123.1, spd: f.spd, course: f.course, at }, true, attached); } return t; };
  assert.equal(driveAttached(true).obs, null); assert.equal(driveAttached(false).obs?.deg, 0);
  out.push(`G5 attached: stop → 12 m slow turn → park retires the approach heading; phone-only keeps it (frozen at the stop)`);
}

console.log(out.join(" | "));
console.log("PASS");
