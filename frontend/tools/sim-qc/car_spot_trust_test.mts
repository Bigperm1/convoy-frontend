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

// F — which fixes may become a spot: 7 km/h (Say Phin's frozen fix) may not; a crawl into the
// stall at 3 km/h and the final stop may; unknown speed counts as stopped.
assert.equal(fixMayBecomeSpot(7 / 3.6), false);
assert.equal(fixMayBecomeSpot(3 / 3.6), true);
assert.equal(fixMayBecomeSpot(0), true);
assert.equal(fixMayBecomeSpot(undefined), true);
assert.equal(fixMayBecomeSpot(SPOT_WRITE_MAX_SPEED_MS), false);
out.push(`F 7km/h=no 3km/h=yes 0=yes unknown=yes cap=${SPOT_WRITE_MAX_SPEED_MS}m/s`);

console.log(out.join(" | "));
console.log("PASS");
