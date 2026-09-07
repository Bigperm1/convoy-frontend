// Car-spot trust gate — src/carSpotTrust.ts, the rules hydrate uses before believing a
// persisted parking spot. Replays Say Phin's 2026-09-06 record first (it must be REFUSED),
// then the legitimate shapes (they must still be adopted). Run:
//   node --experimental-strip-types tools/sim-qc/car_spot_trust_test.mts
import assert from "node:assert/strict";
import { spotAdoptVerdict, fixMayBecomeSpot, SPOT_MAX_AGE_MS, SPOT_WRITE_MAX_SPEED_MS } from "../../src/carSpotTrust.ts";

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
// seen DRIVING at 22:03 (persisted driving stamp) → she left it → refused. A stamp older than the
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

console.log(out.join(" | "));
console.log("PASS");
