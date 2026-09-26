// parkWitness.ts — where a WITNESSED park is saved, on its own (privacy round 13, 2026-09-25).
//
// Jeff, 2026-09-25: "it should not follow me when i discconect from car play... this is a privacy concern. fix it and
// lock it." OTA-CG saved the witness (`hu=1`) only ON the car-spot record, and only `if (_carSpot)`: a CarPlay /
// Android Auto session that delivered no usable fix (no signal, location denied, a spot hydrate refused, a disconnect
// before the saved park was read) left nothing on disk. The app restarted, hydrate found no witness, and the next
// 26 km/h walking reading armed the ordinary latch — the walk was shared live and became the car spot (Codex high,
// reproduced in tools/sim-qc/park_rearm_test.mts HF13-0).
//
// So the witness has its own key. src/locationPrivacy.ts is its only reader and writer (never add another):
//   • written at every head-unit true→false transition, spot or no spot, hydrated or not — `{ hu: 1, t: <wall ms> }`
//     (`t` is for a human reading the disk; no rule reads it — the witness does not age);
//   • read in the same single-flight hydrate as the spot (a failed read is retried, fail-closed); ANY value present
//     restores the witnessed park unless a head unit is attached now;
//   • removed only where the in-memory witness is cleared: a head unit asserting, or the re-arm proof passing in noteFix.
// The key lives here, not in locationPrivacy.ts, because that file forbids new module-scope constants
// (tools/sim-qc/data/nav-lock.json watchNew); every line that reads or writes it is inside locationPrivacy.ts's
// 🔒 NAV-LOCK regions. Gate: tools/sim-qc/park_rearm_test.mts HF13–HF13e.
export const PARK_WITNESS_KEY = "convoy.parkWitness.v1";
