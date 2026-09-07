// place_identity_test.mts — gate for the pure parts of src/placeIdentity.ts (2026-09-06).
// Run: node --experimental-strip-types tools/sim-qc/place_identity_test.mts
// Jeff's example, with the candidates Google actually returned for it on 2026-09-06 (a 40 m
// nearby search: one business at Unit 100; a 150 m search: the whole complex).
import assert from "node:assert/strict";
import { pickArrivalPlace, speechName, addressTokens, validQuip, type PlaceCandidate } from "../../src/placeIdentityCore.ts";

const DEST = { lat: 49.1734155, lng: -122.6658367, label: "100 9420 200A Street, Langley, BC" };
const unit100: PlaceCandidate = { placeId: "a", name: "International Motorsports Motorcycle Company", primaryType: "motorcycle_dealer", types: ["motorcycle_dealer", "store"], formattedAddress: "9420 200a St Unit 100, Langley Twp, BC V1M 4C2, Canada", lat: 49.17343, lng: -122.66582, openNow: false };
const complex: PlaceCandidate[] = [
  unit100,
  { placeId: "b", name: "The Mutual Fire Insurance Company of British Columbia", primaryType: "insurance_agency", types: ["insurance_agency"], formattedAddress: "9366 200a St, Langley Twp, BC V1M 4B3, Canada", lat: 49.1727, lng: -122.6660 },
  { placeId: "c", name: "Highridge Medical Ltd", primaryType: "medical_clinic", types: ["medical_clinic", "health"], formattedAddress: "9347 200a St #170, Langley Twp, BC V1M 3Y4, Canada", lat: 49.1725, lng: -122.6650 },
  { placeId: "d", name: "9420 200a St Unit 100", primaryType: null, types: [], formattedAddress: "9420 200a St Unit 100, Langley Twp, BC V1M 4C2, Canada", lat: 49.1734155, lng: -122.6658367 },
];
const out: string[] = [];

// A — Jeff's address → the business at Unit 100, by name, closed right now.
const a = pickArrivalPlace(DEST, complex);
assert.ok(a); assert.equal(a.name, "International Motorsports"); assert.equal(a.rawName, unit100.name);
assert.equal(a.primaryType, "motorcycle_dealer"); assert.equal(a.openNow, false);
out.push(`A "${DEST.label}" → ${a.name} (${a.primaryType}, open=${a.openNow}, ${a.distM} m)`);

// B — the address-only "place" (no primary type) is never the answer, even at 0 m.
assert.equal(pickArrivalPlace(DEST, [complex[3]]), null);
out.push(`B address-only candidate → null`);

// C — a different unit at the same civic number does not match Unit 100's business.
const c = pickArrivalPlace({ ...DEST, label: "9420 200A Street Unit 200, Langley" }, complex);
assert.equal(c, null);
out.push(`C unit 200 asked, only unit 100 known → null`);

// C2 — the civic number without a unit, one business at that civic → it.
const c2 = pickArrivalPlace({ ...DEST, label: "9420 200A St, Langley" }, complex);
assert.ok(c2); assert.equal(c2.rawName, unit100.name);
out.push(`C2 civic only → the one business at 9420`);

// D — no address in the label (a shared pin, a saved "Coco's place"): nearest within 25 m only.
const d1 = pickArrivalPlace({ lat: 49.17343, lng: -122.66582, label: "Coco's place" }, complex);
assert.ok(d1); assert.equal(d1.rawName, unit100.name);
const d2 = pickArrivalPlace({ lat: 49.1740, lng: -122.6658, label: "Coco's place" }, complex);   // ~65 m off
assert.equal(d2, null);
out.push(`D pin at 2 m → match; pin 65 m off → null`);

// E — speech names.
assert.equal(speechName("International Motorsports Motorcycle Company"), "International Motorsports");
assert.equal(speechName("Highridge Medical Ltd"), "Highridge Medical");
assert.equal(speechName("Four Points Insurance"), "Four Points Insurance");
assert.equal(speechName("Taproot"), "Taproot");
assert.equal(speechName("TASC Systems Inc"), "TASC Systems");
assert.equal(speechName("The Master Group Langley"), "The Master Group Langley");
assert.equal(speechName("Golden Dragon Restaurant"), "Golden Dragon");
assert.equal(speechName("Joe's Cafe"), "Joe's Cafe");   // two words: the tail stays
out.push(`E speech names ok`);

// F — address tokens.
assert.deepEqual(addressTokens("100 9420 200A Street, Langley, BC"), { civic: "9420", unit: "100" });
assert.deepEqual(addressTokens("#100-9420 200A St"), { civic: "9420", unit: "100" });
assert.deepEqual(addressTokens("9420 200A St Unit 100"), { civic: "9420", unit: "100" });
assert.deepEqual(addressTokens("9420 200A St"), { civic: "9420", unit: null });
assert.deepEqual(addressTokens("Coco's place"), { civic: null, unit: null });
assert.deepEqual(addressTokens("100 9420 Main St"), { civic: "9420", unit: "100" });
assert.deepEqual(addressTokens("9420 Main St"), { civic: "9420", unit: null });
assert.deepEqual(addressTokens("Unit 100 9420 200A Street"), { civic: "9420", unit: "100" });
assert.deepEqual(addressTokens("20159 88 Ave, Langley"), { civic: "20159", unit: null });
out.push(`F address tokens ok`);

// G — generated quips are spoken only when short, plain and dash/emoji free.
assert.equal(validQuip("Looking to buy a bike today?"), "Looking to buy a bike today?");
assert.equal(validQuip("Get the ginger beef — I hear it's good"), null);
assert.equal(validQuip("Enjoy 🏍️"), null);
assert.equal(validQuip("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen"), null);
assert.equal(validQuip(42), null);
out.push(`G quip validation ok`);

console.log(out.join(" | "));
console.log("PASS");
