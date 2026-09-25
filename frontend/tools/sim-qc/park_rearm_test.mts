// park_rearm_test — after a WITNESSED park, one fast fix may not put the driver back on the map live.
//
//   node --experimental-strip-types tools/sim-qc/park_rearm_test.mts
//
// Jeff, 2026-09-25: "i think the connection is following me after the carplay dissconnect. it should not follow me
// when i discconect from car play... this is a privacy concern. fix it and lock it." What followed him:
// "My icon moved on the map."
//
// His rows (crash_reports, handle Jeff, update_id 01a0d804…, SELECT only; UTC):
//   17:08:20.898  carplay-disconnect app=background nav=0 fix=1                        (the witnessed park)
//   17:12:34.136  draw-cmp surf=phone mode=pin spd=2 … gps=withheld raw=49.172938,-122.666060 … latch=0 parked=1 hu=1
//   17:12:46.676  aa-appstate state=active                                              (app opened)
//   17:12:56.093  draw-cmp surf=car mode=raw spd=10 … gps=49.173237,-122.665995 … latch=0 parked=1 hu=1
//   17:13:10.094  draw-cmp surf=phone mode=raw spd=26 acc=14m … gps=49.173337,-122.665408 … latch=1 parked=0 hu=0
//   17:13:13.947  cam-probe surf=phone … spd=29 …                                        (speed only)
//   17:14:12.246  cam-probe surf=phone … spd=2 …                                         (speed only)
//   17:14:14.089  draw-cmp surf=phone mode=raw spd=7 acc=16m … gps=49.173417,-122.666179 … latch=1 parked=0 hu=0 spotAge=59s
// The pinned `raw=` at 17:12:34 IS the car spot (mode=pin draws the spot). One 26 km/h fix armed the latch and
// cleared the witness in the same noteFix call; the marker went raw, the shared position went live, and the car spot
// was rewritten where he walked (spotAge 59 s at 17:14:14).
//
// Drives the REAL src/locationPrivacy.ts (noteFix / noteCarConnected / shareablePosition / parkEndedByHeadUnit /
// privacyDebug / carSpot), loaded with the depart_facing_test.mts stubs, on our clock.
//   N  NEGATIVE CONTROL: the REAL pre-fix locationPrivacy.ts (c97a1580, via `git show`) on his recorded fixes →
//      re-arms at the first 26 km/h fix, clears the witness, shares LIVE (proves the test sees the bug).
//   J1 his recorded fixes → stays pinned: latch false, parkEndedByHeadUnit() true, share = the car spot, spot unmoved.
//   J2 the same stretch densified to 1 Hz with EVERY fix at 29 km/h (worse than the data) → still pinned: the
//      displacement rule refuses it however long the speed artifact lasts.
//   V  the rule's values (src/parkRearm.ts, outside nav-lock) are pinned.
//   R  a real drive-away after a witnessed park → re-arms once 15 s at >= 15 km/h AND 300 m are in (<= 40 s), live
//      after; a highway pull-away within 30 s.
//   L  a 25 s red light mid-proof does not start it over (<= 20 s after pulling away again).
//   E  stop-sign grids (100–160 m blocks) and stop-and-go traffic prove within ~60–75 s (v1 never did).
//   G  one far fix after a gap cannot prove (the robust median).
//   O  Jeff's 08-29 walk (rows as recorded, the >= 9 km/h counterfactual, and 41 s stuck on the multipath coordinate).
//   S  every new witness starts the proof from nothing (S1), and a witness adopted by hydrate drops a racing latch (S2).
//   Y  a relaunch whose storage read is LATE: 1, 2, 5 fast fixes before it cannot skip the saved witness (Y0 = round 3).
//   X  the third review's attacks: 14–31 s of 16 km/h-reading walking + 41 s stuck on the multipath point; two
//      consecutive / ping-pong 400 m outliers; every other fix on a far point (X0 / X0b = round 3 un-pinning).
//   Z  the review's urban-canyon walker model (seed 284 and 20-seed sets of brisk walkers with 15–17 km/h spikes) pinned.
//   Q  slow congestion STAYS PINNED (round 5 removed the slow path): three jams pinned for 30 min at 1 Hz, with and
//      without 3 m noise; the same jam then clearing goes live within 60 s (Q0 = round 4's slow path un-pins the jam).
//   WK the fifth review's walkers on the real module: straight 1.4 m/s walks with 8 / 12 m GPS noise and 1 in 10
//      single-fix 15–18 km/h readings at 1 Hz and Lite cadence (8 m filter), and a walk-then-sit — all pinned
//      (WK0 = round 4 un-pins them); a moving-walkway concourse at 2 m / 500 ms cadence (WK6-0 = round 4 un-pins it).
//      V5 / V6 / V7 isolate the real-Δt claim, the 10 s baseline and the run check (V5c / V6c / V7c = each removed).
//   K  the head-unit sources: an iOS COLD CarPlay disconnect is witnessed (K0 = the pre-fix cold path sharing live),
//      a cold connect clears yesterday's witness (K2/K3), the map mirror cannot create or cancel a witness (K4), and
//      with no session source the map mirror still works (K5).
//   C  a CarPlay reconnect → the witness clears at once; the first vehicular fix is live (unchanged).
//   U  no witnessed park → identical outputs to the pre-fix module, fix by fix (the "byte-for-byte" claim).
//   H  a witness restored from disk (hydrate, hu=1) is protected the same way; H2 with a driving stamp < 90 s old
//      too (no latch is restored over a witness — negative control on the pre-fix module); H3 without a witness the
//      restore is unchanged.
//   HF a relaunch whose storage read FAILS (rejects once; rejects 3× then succeeds; a record that does not parse, twice;
//      a read that hangs): walking fixes with 26 / 29 km/h readings are never shared live and write nothing, the saved
//      witness is adopted once a retry reads it (>= 5 s apart), the record on disk is byte-identical, and a bounded
//      `priv-hydrate` row names each outcome (HF0 = 0255f36a sharing the walk live and overwriting the record); HF5 the
//      retry backoff; HF6 a hung read settling after the retry changes nothing; HF7 Android Auto's 90 s TTL lapsing
//      (no disconnect heard) while reads fail — the head unit's latch never shares a walk (HF7-0 = 47db1aca sharing
//      it; HF7b isolates shareablePosition's hydration check, HF7b-0 = without it); HF8 a caller awaiting a HUNG attempt is released when a retry succeeds, and within 10 s when none does
//      (HF8-0 = 47db1aca never releasing it), and carDataService joins presence after the await, hydrated or not;
//      HF9 / HF9b the share decision is self-sufficient: a latch whose last driving fix is 100 s old shares nothing,
//      whether or not a fix ran since, through the async path too (HF9-0 / HF9b-0 = 7da32366 sharing the walk);
//      HF9c / HF9d / HF9e clock jumps: back an hour with walking fixes through noteFix, forward and back, and a lost
//      Android Auto disconnect whose TTL a backward jump would revive (HF9c-0 / HF9e-0 = 90dd1484); V8 the re-arm
//      rule across clock jumps (V8b-0 = without its restart); HF10a–d the witness is restored from the record alone —
//      a park 25 h old, a device clock +25 h, a process that died with CarPlay attached — and a drive after it still
//      goes live (HF10a-0 / HF10c-0 = 36c17f1e); KF1 the paused-monotonic residual, pinned and bounded; CLK1 the privacy
//      clock does not drift with dense calls (CLK1-0 = 36c17f1e), CLK2 a rollback logs a bounded row; HF9f a stale latch
//      is expired before noteFix reads it —
//      the first fast fix after it is not recorded as the car spot (HF9f-0 = 90dd1484); HF9g an expired Android Auto
//      attachment stays expired when the device clock is set back into its window (HF9g-0 = b286ad9b); PT a property
//      test — random device-clock jumps (±1 h, ±24 h, repeated) never produce a live walking share or a spot write
//      after a witnessed or lost disconnect, and a real drive under the same jumps stays live on every fix.
//   W  the drive's latch still inside its 90 s window at the disconnect: a 12 km/h and a 26 km/h fix share the car
//      spot (the witness drops the latch); NEGATIVE CONTROL on the pre-fix module shares them LIVE.
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = new URL("../../src/", import.meta.url);
const js = (body: string) => "data:text/javascript," + encodeURIComponent(body);
const EMPTY = js(`const f = () => {}; export const Platform = { get OS() { return globalThis.__os ?? "ios"; }, select: (o) => o.ios ?? o.default };
  export const useEffect = f, useState = (v) => [v, f], useRef = (v) => ({ current: v }), useCallback = (x) => x;`);
// AsyncStorage reads come from globalThis.__store (scenario H); writes are recorded there too.
// getItem waits for globalThis.__delay when a test sets it (a slow storage read at a relaunch — section Y).
// A test may replace reads outright with globalThis.__getItem(key, store) (a rejected, corrupt or hung read — section HF).
const STORAGE = js(`const S = () => (globalThis.__store ??= {});
  const later = (v) => (globalThis.__delay ? globalThis.__delay.then(() => v()) : Promise.resolve(v()));
  export default { getItem: (k) => (globalThis.__getItem ? globalThis.__getItem(k, S()) : later(() => S()[k] ?? null)), setItem: (k, v) => { S()[k] = v; return Promise.resolve(); },
    removeItem: (k) => { delete S()[k]; return Promise.resolve(); }, multiRemove: () => Promise.resolve() };`);
const ROWS = js(`export const logEventReliable = (r) => { (globalThis.__rows ??= []).push(String(r)); }; export const logEvent = logEventReliable;`);
registerHooks({
  resolve(s: string, c: any, n: any) {
    if (s === "@react-native-async-storage/async-storage") return { url: STORAGE, shortCircuit: true };
    if (s === "./crashBreadcrumb") return { url: ROWS, shortCircuit: true };   // rows land in globalThis.__rows
    if (s === "react" || s === "react-native" || s.startsWith("expo-")) return { url: EMPTY, shortCircuit: true };
    // The pre-fix copy lives in a temp dir: its relative imports are the worktree's modules.
    if (s === "./parkRearm.r3.ts" || s === "./parkRearm.r4.ts") return n(s, c);   // an earlier round's rule, beside its locationPrivacy copy
    if (s.startsWith(".") && /locationPrivacy\.base\.ts(\?.*)?$/.test(c.parentURL ?? "")) return { url: new URL(`${s.slice(2)}.ts`, SRC).href, shortCircuit: true };
    if (s.startsWith(".") && !/\.[a-z]+$/i.test(s)) { try { return n(s + ".ts", c); } catch {} }
    return n(s, c);
  },
});

// `clock` is TRUE time. The device's WALL clock is `clock + wallSkew` (a test moves wallSkew to change the clock), and
// performance.now() follows true time, never backwards (a scenario that restarts `clock` earlier freezes it there).
let clock = 0;
let wallSkew = 0;
Date.now = () => clock + wallSkew;
let monoT = 0, monoLast = 0, monoPaused = false;   // monoPaused: the monotonic clock stops (a device sleep — KF1)
(globalThis as any).performance.now = () => { if (!monoPaused && clock > monoLast) monoT += clock - monoLast; monoLast = clock; return monoT; };
const utc = (h: number, m: number, s: number, ms = 0) => Date.UTC(2026, 8, 25, h, m, s, ms);
const S = 1000;

type LP = typeof import("../../src/locationPrivacy.ts");
let inst = 0;
// `hydrated` (the default): the module has read its (empty) storage, as every real caller now waits for — noteFix trusts
// no fix before that (the Y section tests the before). Tests that seed storage or race the read pass false.
const fresh = async (hydrated = true): Promise<LP> => {
  (globalThis as any).__store = {};
  const lp: LP = await import(new URL(`locationPrivacy.ts?i=${++inst}`, SRC).href);
  if (hydrated) await lp.hydrateLocationPrivacy();
  return lp;
};
let baseSrc: string | null = null;
try { baseSrc = execFileSync("git", ["show", "c97a1580:frontend/src/locationPrivacy.ts"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
let baseFile: string | null = null;
if (baseSrc) { const d = mkdtempSync(join(tmpdir(), "park-rearm-base-")); baseFile = join(d, "locationPrivacy.base.ts"); writeFileSync(baseFile, baseSrc); }
const freshBase = async (hydrated = true): Promise<LP | null> => {
  if (!baseFile) return null;
  (globalThis as any).__store = {};
  const lp: LP = await import(pathToFileURL(baseFile).href + `?i=${++inst}`);
  if (hydrated) await lp.hydrateLocationPrivacy();
  return lp;
};

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

// ── geometry ─────────────────────────────────────────────────────────────────────────────────────────────────────
const SPOT = { lat: 49.172938, lng: -122.666060 };     // 17:12:34.136 mode=pin raw= (the car spot)
const DRIVING_ENTER = 4.17;                             // locationPrivacy.DRIVING_ENTER_SPEED_MS (asserted equal below)
const R_EARTH = 6371000;
const north = (p: { lat: number; lng: number }, m: number) => ({ lat: p.lat + (m / R_EARTH) * (180 / Math.PI), lng: p.lng });
const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180, dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
};
const kmh = (v: number) => v / 3.6;

// The drive that ends at the spot, with CarPlay attached, then the witnessed disconnect at 17:08:20.898.
function parkWithCarPlay(lp: LP, disconnectAt = utc(17, 8, 20, 898), walk = true) {
  clock = utc(17, 5, 0);
  lp.noteCarConnected(true);
  const start = north(SPOT, -720);
  for (let i = 0; i <= 60; i++) { clock = utc(17, 5, 0) + i * S; lp.noteFix(start.lat + (SPOT.lat - start.lat) * (i / 60), SPOT.lng, 12, 0); }
  for (let i = 1; i <= 30; i++) { clock = utc(17, 6, 0) + i * S; lp.noteFix(SPOT.lat, SPOT.lng, 0, null); }
  clock = disconnectAt;
  lp.noteCarConnected(false);
  if (!walk) return;
  // The phone's last fix before he opened the app: 17:12:34.136 `fixAge=180133` → taken 17:09:34.003, `sep=47m` from
  // the spot, `spd=2`. Its coordinates were withheld by the row, so this position (47 m north) is SYNTHESISED; only the
  // distance, time and speed are his. It is what drops the drive's latch (> 90 s after the last driving fix).
  clock = utc(17, 9, 34, 3);
  const w = north(SPOT, 47);
  lp.noteFix(w.lat, w.lng, kmh(2), null);
}
const pinnedAtSpot = (lp: LP, live: { lat: number; lng: number; speed: number }) => {
  const d = lp.privacyDebug();
  const sh = lp.shareablePosition({ lat: live.lat, lng: live.lng, speed: live.speed, heading: 0 });
  const spot = lp.carSpot();
  return {
    ok: d.latch === false && lp.parkEndedByHeadUnit() === true && sh.share === true && (sh as any).lat === SPOT.lat && (sh as any).lng === SPOT.lng
      && !!spot && spot.lat === SPOT.lat && spot.lng === SPOT.lng,
    why: `latch=${d.latch} hu=${lp.parkEndedByHeadUnit()} share=${sh.share ? `${(sh as any).lat},${(sh as any).lng}` : "none"} spot=${spot ? `${spot.lat},${spot.lng}` : "none"}`,
  };
};

// His recorded fixes (gps= rows), plus the one speed-only vehicular reading placed at the last known position.
const A1 = { lat: 49.173237, lng: -122.665995 }, A2 = { lat: 49.173337, lng: -122.665408 }, A3 = { lat: 49.173417, lng: -122.666179 };
const RECORDED: { t: number; p: { lat: number; lng: number }; v: number; src: string }[] = [
  { t: utc(17, 12, 56, 93), p: A1, v: kmh(10), src: "17:12:56.093 draw-cmp surf=car spd=10" },
  { t: utc(17, 13, 10, 94), p: A2, v: kmh(26), src: "17:13:10.094 draw-cmp surf=phone spd=26" },
  { t: utc(17, 13, 13, 947), p: A2, v: kmh(29), src: "17:13:13.947 cam-probe spd=29 (position of the 17:13:10 fix)" },
  { t: utc(17, 14, 12, 246), p: A3, v: kmh(2), src: "17:14:12.246 cam-probe spd=2 (position of the 17:14:14 fix)" },
  { t: utc(17, 14, 14, 89), p: A3, v: kmh(7), src: "17:14:14.089 draw-cmp surf=phone spd=7" },
];

// ── N · NEGATIVE CONTROL: the real pre-fix module ────────────────────────────────────────────────────────────────
{
  const lp = await freshBase();
  if (!lp) console.log("  skip N negative control: `git show c97a1580:frontend/src/locationPrivacy.ts` unavailable");
  else {
    parkWithCarPlay(lp);
    ok("N0 precondition: witnessed park at the spot, latch dropped (his 17:12:34 row: latch=0 parked=1 hu=1)", pinnedAtSpot(lp, { ...A1, speed: 0 }).ok);
    let armedAt: string | null = null; let shareAtArm: any = null;
    for (const f of RECORDED) {
      clock = f.t; lp.noteFix(f.p.lat, f.p.lng, f.v, null);
      if (!armedAt && lp.privacyDebug().latch) { armedAt = f.src; shareAtArm = lp.shareablePosition({ ...f.p, speed: f.v, heading: 0 }); }
    }
    ok("N1 NEGATIVE CONTROL (real pre-fix locationPrivacy.ts): re-arms on the first 26 km/h fix", armedAt === RECORDED[1].src, `armed at: ${armedAt}`);
    ok("N2 NEGATIVE CONTROL: …and clears the witnessed park", lp.parkEndedByHeadUnit() === false);
    ok("N3 NEGATIVE CONTROL: …and that fix is shared LIVE — his walking position, not the car", shareAtArm?.share === true && shareAtArm.lat === A2.lat && shareAtArm.lng === A2.lng, JSON.stringify(shareAtArm));
    const sp = lp.carSpot();
    ok("N4 NEGATIVE CONTROL: …and moved the car spot off the car (his row: spotAge=59s)", !!sp && (sp.lat !== SPOT.lat || sp.lng !== SPOT.lng), JSON.stringify(sp));
  }
}

// ── J1 · his recorded fixes on the fixed module ─────────────────────────────────────────────────────────────────
{
  const lp = await fresh();
  parkWithCarPlay(lp);
  let allOk = true; const bad: string[] = [];
  for (const f of RECORDED) {
    clock = f.t; lp.noteFix(f.p.lat, f.p.lng, f.v, null);
    const r = pinnedAtSpot(lp, { ...f.p, speed: f.v });
    if (!r.ok) { allOk = false; bad.push(`${f.src}: ${r.why}`); }
  }
  ok("J1 his 10:12–10:14 fixes → pinned after every one (latch=0, hu=1, share = car spot, spot unmoved)", allOk, bad.join(" | "));
}

// ── J2 · worst case: 1 Hz, every fix vehicular (29 km/h) for the whole stretch ─────────────────────────────────────
{
  const lp = await fresh();
  parkWithCarPlay(lp);
  const lerp = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, k: number) => ({ lat: a.lat + (b.lat - a.lat) * k, lng: a.lng + (b.lng - a.lng) * k });
  const t0 = utc(17, 12, 56), t1 = utc(17, 13, 10), t2 = utc(17, 13, 39), t3 = utc(17, 14, 14);
  let allOk = true; let n = 0; let maxFromFirst = 0; let first: { lat: number; lng: number } | null = null; const bad: string[] = [];
  for (let t = t0; t <= t3; t += S) {
    const p = t <= t1 ? lerp(A1, A2, (t - t0) / (t1 - t0)) : t <= t2 ? A2 : lerp(A2, A3, (t - t2) / (t3 - t2));
    clock = t; lp.noteFix(p.lat, p.lng, kmh(29), null); n++;
    first ??= p; maxFromFirst = Math.max(maxFromFirst, metres(first, p));
    const r = pinnedAtSpot(lp, { ...p, speed: kmh(29) });
    if (!r.ok && bad.length < 3) { allOk = false; bad.push(`${new Date(t).toISOString().slice(11, 23)} ${r.why}`); }
  }
  ok(`J2 ${n} fixes at 29 km/h over ${(t3 - t0) / S} s (his positions, max ${maxFromFirst.toFixed(0)} m from the first) → still pinned`, allOk, bad.join(" | "));
}

// ── V · the rule's values are pinned (src/parkRearm.ts is outside tools/sim-qc/data/nav-lock.json) ────────────────
// Changing one of these needs Jeff's say-so (RULES.md §4) — the lock tool does not cover this file yet.
{
  const R = await import(new URL("parkRearm.ts", SRC).href);
  const want = {
    PARK_REARM_WINDOW_MS: 120_000, PARK_REARM_VEHICULAR_MS: 15_000, PARK_REARM_MIN_M: 300, PARK_REARM_MOVE_RATIO: 0.8,
    PARK_REARM_FIX_CREDIT_MS: 2_000, PARK_REARM_BASELINE_MS: 10_000, PARK_REARM_JUMP_FACTOR: 2, PARK_REARM_JUMP_SLACK_M: 50,
    PARK_REARM_ROBUST_N: 5, PARK_REARM_CLAIM_MAX_MS: 3_000,
  };
  const got = Object.fromEntries(Object.keys(want).map((k) => [k, (R as any)[k]]));
  ok("V1 parkRearm constants are the approved values", JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  const exported = Object.keys(R).filter((k) => k.startsWith("PARK_REARM_")).sort();
  ok("V1c no other PARK_REARM_ export (the round-4 SLOW congestion path is gone)", JSON.stringify(exported) === JSON.stringify(Object.keys(want).sort()), exported.join(","));
  const lp0 = await fresh();
  ok("V1b the pure rule's entry speed here is locationPrivacy's DRIVING_ENTER_SPEED_MS", lp0.DRIVING_ENTER_SPEED_MS === DRIVING_ENTER, String(lp0.DRIVING_ENTER_SPEED_MS));
  // DF the ONE freshness predicate's contract (pure): never recorded, future-dated (a negative age) and >= 90 s old are
  // all expired. With privacyNow() no caller can hand it a negative age any more; the rule stays as the second line.
  const F = (lp0 as any).drivingEvidenceFresh as (a: number, n: number) => boolean;
  ok("DF drivingEvidenceFresh: 0 → expired; future (negative age) → expired; 89.999 s → fresh; 90 s → expired",
    F(0, 5e9) === false && F(1e9 + 1000, 1e9) === false && F(1e9, 1e9 + 89_999) === true && F(1e9, 1e9 + 90_000) === false && F(1e9, 1e9) === true);
  // Each defence alone, on the pure rule (the attacks above are each stopped by more than one, so these isolate them).
  const RR: any = R;
  const run = (fixes: { t: number; p: { lat: number; lng: number }; v: number }[]) => { const r = RR.createParkRearm({ enterMs: DRIVING_ENTER }); for (let i = 0; i < fixes.length; i++) if (r.note(fixes[i].t, fixes[i].p.lat, fixes[i].p.lng, fixes[i].v, SPOT)) return i; return -1; };
  const T = utc(12, 0, 0);
  const loopFix = (s2: number) => { const v = kmh(16), a = (v * s2) / 20; return { t: T + s2 * S, p: { lat: SPOT.lat + (20 * Math.sin(a)) / 111320, lng: SPOT.lng + (20 * (1 - Math.cos(a))) / (111320 * Math.cos((SPOT.lat * Math.PI) / 180)) }, v }; };
  const loop = Array.from({ length: 61 }, (_, s2) => loopFix(s2));
  const far = north(SPOT, 400);
  // V2 JUMPS: a car-park loop that earns credit, then the phone STUCK 5 s on a multipath point 400 m away at 50 km/h.
  const stuck5 = [...loop, ...Array.from({ length: 5 }, (_, i) => ({ t: T + (61 + i) * S, p: north(far, 0.2 * i), v: kmh(50) }))];
  ok("V2 a 5 s multipath stick 400 m away after a credited loop does not prove (jump rejection)", run(stuck5) === -1);
  // V3 SEGMENTS: the same stick for 40 s — long enough for the jump bound to admit it; it must start a new segment.
  const stuck40 = [...loop, ...Array.from({ length: 40 }, (_, i) => ({ t: T + (61 + i) * S, p: north(far, 0.2 * i), v: kmh(50) }))];
  ok("V3 …for 40 s: admitted only as a new segment, still no proof (credit and distance never span a jump)", run(stuck40) === -1);
  // V4 MEDIAN: a straight 36 km/h drive; one 45 m forward outlier (inside the jump bound: 55 m ≤ max(20, 60)) three
  // fixes before the proof. A median of five moves at most one step on a moving track; the last fix alone jumps ahead.
  const drive = Array.from({ length: 60 }, (_, s2) => ({ t: T + s2 * S, p: north(SPOT, 10 * s2), v: 10 }));
  const clean = run(drive);
  const withOut = run(drive.map((f, i) => (i === clean - 3 ? { ...f, p: north(f.p, 45) } : f)));
  ok("V4 one in-bound outlier cannot bring the proof forward by more than one fix (median of five)", clean > 0 && withOut >= clean - 1, `clean=${clean} withOutlier=${withOut}`);
  // V5 CLAIM = speed × REAL Δt (review round 5). The Lite GPS watcher's 8 m filter on a phone moving 3.0 m/s: noise-free
  // 8 m steps 2.67 s apart, EVERY fix reading 15.1 km/h. Its track covers 71 % of what 15 km/h claims over that time —
  // no credit, never proves. With the claim capped at the 2 s credit cap (round 4) each step "covers" 95 % and it proves.
  const lite = Array.from({ length: 90 }, (_, i) => ({ t: T + Math.round(i * 2667), p: north(SPOT, 30 + 8 * i), v: 4.2 }));
  ok("V5 an 8 m-filter track 2.67 s apart reading 15 km/h on every fix never proves (claim = speed × real Δt)", run(lite) === -1, `proved at fix ${run(lite)}`);
  {
    const d = mkdtempSync(join(tmpdir(), "park-rearm-claim2-")); const f = join(d, "parkRearm.claim2.ts");
    const src = readFileSync(new URL("parkRearm.ts", SRC), "utf8");
    writeFileSync(f, src.replace(/export const PARK_REARM_CLAIM_MAX_MS = [^;]+;/, "export const PARK_REARM_CLAIM_MAX_MS = PARK_REARM_FIX_CREDIT_MS;"));
    const R2: any = await import(pathToFileURL(f).href);
    const r2 = R2.createParkRearm({ enterMs: DRIVING_ENTER }); let at = -1;
    for (let i = 0; i < lite.length && at < 0; i++) if (r2.note(lite[i].t, lite[i].p.lat, lite[i].p.lng, lite[i].v, SPOT)) at = i;
    ok("V5c NEGATIVE CONTROL (this module with round 4's claim, capped at the 2 s credit cap): the same track proves", at >= 0, `proved at fix ${at} (+${((lite[Math.max(0, at)].t - T) / S).toFixed(0)} s)`);
    rmSync(d, { recursive: true, force: true });
  }
  // V6 the 10 s BASELINE check alone: a 10 km/h jog (2.8 m/s, 1 Hz) zig-zagging ±4 m, every OTHER fix reading 18 km/h.
  // Each fast fix's one-step run covers its claim (the zig-zag makes every step 8.5 m); over 10 s the track covers 28 m
  // of the 39 m the speeds claim (72 %) — no credit. V7 the RUN check alone: a 3.2 m/s jog in a straight line, 3 fixes
  // of every 10 reading 18 km/h: the 10 s baseline covers 86 % of its claim, each fast run 64 % — no credit.
  // Negative controls: this module with that one check removed proves each track.
  const zig = Array.from({ length: 200 }, (_, i) => ({ t: T + i * S, p: { ...north(SPOT, 30 + 2.8 * i), lng: SPOT.lng + ((i % 2 ? 4 : -4) / (R_EARTH * Math.cos((SPOT.lat * Math.PI) / 180))) * (180 / Math.PI) }, v: i % 2 ? 5 : 2.8 }));
  const runs = Array.from({ length: 300 }, (_, i) => ({ t: T + i * S, p: north(SPOT, 30 + 3.2 * i), v: (i % 10) >= 7 ? 5 : 3.2 }));
  ok("V6 a zig-zag jog with every other fix reading 18 km/h never proves (the 10 s baseline)", run(zig) === -1, `proved at fix ${run(zig)}`);
  ok("V7 a straight jog with 3-fix 18 km/h runs every 10 s never proves (the run check)", run(runs) === -1, `proved at fix ${run(runs)}`);
  {
    const src = readFileSync(new URL("parkRearm.ts", SRC), "utf8");
    const anchor = "if (base >= 0 && covers(base) && covers(runBase)) credit";
    const d = mkdtempSync(join(tmpdir(), "park-rearm-checks-"));
    const variant = async (name: string, repl: string) => { const f = join(d, `parkRearm.${name}.ts`); writeFileSync(f, src.replace(anchor, repl)); return (await import(pathToFileURL(f).href)) as any; };
    const firstProof = (M: any, fixes: typeof zig) => { const r = M.createParkRearm({ enterMs: DRIVING_ENTER }); for (let i = 0; i < fixes.length; i++) if (r.note(fixes[i].t, fixes[i].p.lat, fixes[i].p.lng, fixes[i].v, SPOT)) return i; return -1; };
    const noBase = await variant("nobase", "if (base >= 0 && covers(runBase)) credit"), noRun = await variant("norun", "if (base >= 0 && covers(base)) credit");
    ok("V6c NEGATIVE CONTROL (this rule without the 10 s baseline check): the zig-zag jog proves", src.includes(anchor) && firstProof(noBase, zig) >= 0, `proved at fix ${firstProof(noBase, zig)}`);
    ok("V7c NEGATIVE CONTROL (this rule without the run check): the straight jog proves", src.includes(anchor) && firstProof(noRun, runs) >= 0, `proved at fix ${firstProof(noRun, runs)}`);
    // V8 CLOCK JUMPS (Codex delta review 3): 25 s at 10 m/s (15 s credited, 250 m — not yet a proof), then the clock
    // moves BACK an hour and the car drives on. (a) 10 more fixes (350 m in all) do not prove: nothing from before the
    // jump counts. (b) 40 more s after the jump prove on their own evidence (the rule restarted rather than
    // freezing). (c) the same after a FORWARD jump of an hour: no proof from 10 fixes. V8b-0: this rule without the
    // restart on a large backward jump never proves again.
    const drive = (after: number, jumpS: number) => Array.from({ length: 25 + after }, (_, i) => ({ t: T + i * S + (i >= 25 ? jumpS * S : 0), p: north(SPOT, 30 + 10 * i), v: 10 }));
    const v8a = firstProof(RR, drive(10, -3600)), v8b = firstProof(RR, drive(40, -3600)), v8c = firstProof(RR, drive(10, 3600));
    ok("V8 a backward clock jump: pre-jump evidence never counts (a) and the rule restarts (b, proves after the jump); a forward jump counts nothing old (c)",
      v8a === -1 && v8b >= 25 + 15 && v8c === -1, JSON.stringify({ v8a, v8b, v8c }));
    {
      const reset = "if (prev.t - now > PARK_REARM_FIX_CREDIT_MS) { seg = []; prev = null; bridging = false; }";
      const f2 = join(d, "parkRearm.noreset2.ts"); writeFileSync(f2, src.replace(reset, "if (prev.t - now > PARK_REARM_FIX_CREDIT_MS) { /* no restart */ }"));
      const NR: any = await import(pathToFileURL(f2).href);
      ok("V8b-0 NEGATIVE CONTROL (this rule without the restart on a large backward jump): the drive after the jump never proves", src.includes(reset) && firstProof(NR, drive(40, -3600)) === -1, `proved at fix ${firstProof(NR, drive(40, -3600))}`);
    }
    rmSync(d, { recursive: true, force: true });
  }
}

// Kinematic drive at 2 Hz (the phone watcher's default 500 ms / 2 m): accelerate a m/s² to vmax, cruise, brake b m/s²
// to 0 at each stop, stand `stopS` s with no fixes (the 2 m distance filter), repeat. Straight road north from SPOT.
// (The model of review-priv/s_edges.mts, 2026-09-25.) Returns seconds until the witness cleared, or null.
function grid(lp: LP, t0: number, blocks: number, blockM: number, vmax: number, a = 1.5, b = 2.0, stopS = 3): number | null {
  let t = t0, pos = SPOT;
  for (let k = 0; k < blocks; k++) {
    let x = 0, v = 0;
    while (x < blockM - 0.01) {
      const brakeDist = (v * v) / (2 * b);
      if (blockM - x <= brakeDist + 0.001 && v > 0) v = Math.max(0, v - b * 0.5); else v = Math.min(vmax, v + a * 0.5);
      if (v <= 0.05 && x > blockM / 2) break;
      const dx = Math.min(v * 0.5, blockM - x); x += dx; pos = north(pos, dx); t += 500; clock = t;
      lp.noteFix(pos.lat, pos.lng, v, 0);
      if (!lp.parkEndedByHeadUnit()) return (t - t0) / S;
    }
    t += stopS * S;
  }
  return null;
}
// Stop-and-go: speed 0 → vpeak → 0 as a half-sine of period P s; 2 Hz fixes while moving (none while stopped).
function stopAndGo(lp: LP, t0: number, vpk: number, P: number, maxS = 600): number | null {
  let t = t0, pos = SPOT;
  for (let i = 0; i < maxS * 2; i++) {
    t += 500; clock = t; const v = vpk * Math.sin(Math.PI * (((i * 0.5) % P) / P));
    pos = north(pos, v * 0.5); if (v > 0.3) lp.noteFix(pos.lat, pos.lng, v, 0);
    if (!lp.parkEndedByHeadUnit()) return (t - t0) / S;
  }
  return null;
}

// ── R · a real drive-away after a witnessed park ────────────────────────────────────────────────────────────────
{
  const lp = await fresh();
  parkWithCarPlay(lp);
  const T = utc(17, 30, 0);                       // 20 min later, no CarPlay this time (phone in the mount)
  let pos = SPOT; let v = 0; let firstVeh: number | null = null;
  let armed: { s: number; sinceVeh: number; fromSpot: number } | null = null;
  for (let i = 0; i <= 60 && !armed; i++) {
    clock = T + i * S;
    v = Math.min(i * 1.0, 11);                    // 1 m/s² from rest to 40 km/h
    pos = north(pos, v);                           // metres covered in the last second ≈ current speed
    lp.noteFix(pos.lat, pos.lng, v, 0);
    if (firstVeh == null && v >= kmh(15)) firstVeh = clock;
    if (lp.privacyDebug().latch) armed = { s: i, sinceVeh: (clock - (firstVeh ?? clock)) / S, fromSpot: metres(SPOT, pos) };
  }
  ok("R1 not re-armed before 15 s at >= 15 km/h and 300 m from the spot", !!armed && armed.sinceVeh >= 15 && armed.fromSpot >= 300, JSON.stringify(armed));
  // Credit is judged against a 10 s baseline and the floor is 300 m (Jeff's privacy rule, 2026-09-25 round 5): measured 35 s.
  ok("R2 re-armed within 40 s of pulling away (1 m/s² to 40 km/h)", !!armed && armed.s <= 40, JSON.stringify(armed));
  ok("R3 the witnessed park is cleared by the re-arm", lp.parkEndedByHeadUnit() === false);
  clock += S; pos = north(pos, 11); lp.noteFix(pos.lat, pos.lng, 11, 0);
  const sh = lp.shareablePosition({ ...pos, speed: 11, heading: 0 });
  ok("R4 …and the next fix is shared LIVE and recorded as the car spot", sh.share === true && (sh as any).lat === pos.lat && lp.carSpot()?.lat === pos.lat, JSON.stringify(sh));
}
{
  // Highway pull-away: 2.5 m/s² to 100 km/h, 1 Hz.
  const lp = await fresh(); parkWithCarPlay(lp);
  const T = utc(17, 35, 0); let pos = SPOT; let at: number | null = null;
  for (let i = 0; i <= 60 && at == null; i++) { clock = T + i * S; const v = Math.min(2.5 * i, kmh(100)); pos = north(pos, v); lp.noteFix(pos.lat, pos.lng, v, 0); if (!lp.parkEndedByHeadUnit()) at = i; }
  ok("R5 highway pull-away (2.5 m/s² to 100 km/h) proves within 30 s (measured 24: 15 s of credit after a 10 s baseline)", at != null && at <= 30, `after ${at} s`);
}

// ── L · a red light in the middle of the proof does not start it over ─────────────────────────────────────────
{
  const lp = await fresh();
  parkWithCarPlay(lp);
  let t = utc(17, 40, 0); let pos = SPOT;
  const step = (v: number) => { t += S; clock = t; pos = north(pos, v); lp.noteFix(pos.lat, pos.lng, v, 0); };
  for (let i = 0; i < 12; i++) step(10);          // 12 s at 36 km/h: 120 m
  step(2); step(0.5);                              // braking to the light
  t += 25 * S;                                     // 25 s red light: no fixes (2 m distance filter)
  const resumeAt = t + S;
  let armedDt: number | null = null;
  for (let i = 0; i < 40 && armedDt == null; i++) { step(10); if (lp.privacyDebug().latch) armedDt = (t - resumeAt) / S; }
  ok("L1 a 25 s red light mid-proof: armed within 25 s of pulling away again (measured 22; the red light starts nothing over)", armedDt != null && armedDt <= 25, `armed ${armedDt} s after resuming`);
}

// ── E · stop-sign grids and stop-and-go traffic prove (v1 never did: review-priv/s_edges.mts) ────────────────────
{
  const res: string[] = []; let allOk = true;
  for (const [blocks, blockM, vk, limit] of [[20, 100, 30, 65], [20, 150, 30, 65], [20, 160, 30, 65], [20, 120, 40, 65], [20, 150, 50, 65], [3, 400, 50, 65]] as const) {
    const lp = await fresh(); parkWithCarPlay(lp);
    const s2 = grid(lp, utc(18, 0, 0), blocks, blockM, kmh(vk));
    if (s2 == null || s2 > limit) allOk = false;
    res.push(`${blocks}×${blockM}m@${vk}:${s2 ?? "PINNED"}s`);
  }
  ok("E1 stop-sign grids (100–160 m blocks, 3 s stops) prove within 65 s (measured 28–59 s at the 300 m floor)", allOk, res.join(" "));
}
{
  const res: string[] = []; let allOk = true;
  // Computed bound = 300 m at the half-sine's mean speed 2/π × peak (85 / 68 / 57 s), + 6 s for the 2 Hz sampling and the
  // median of five.
  for (const [vpk, P, limit] of [[20, 20, 91], [25, 30, 74], [30, 40, 63]] as const) {
    const lp = await fresh(); parkWithCarPlay(lp);
    const s2 = stopAndGo(lp, utc(18, 30, 0), kmh(vpk), P);
    if (s2 == null || s2 > limit) allOk = false;
    res.push(`peak${vpk}/P${P}:${s2 ?? "PINNED"}s`);
  }
  ok("E2 stop-and-go (half-sine to 20–30 km/h, 20–40 s period) proves within the computed bound", allOk, res.join(" "));
}

// ── G · a gap with no fixes ─────────────────────────────────────────────────────────────────────────────────────
{
  const lp = await fresh();
  parkWithCarPlay(lp);
  let t = utc(17, 50, 0); let pos = SPOT;
  for (let i = 0; i < 10; i++) { t += S; clock = t; pos = north(pos, 10); lp.noteFix(pos.lat, pos.lng, 10, 0); }
  t += 60 * S; clock = t; pos = north(pos, 700); lp.noteFix(pos.lat, pos.lng, 10, 0);   // 60 s later, 700 m on
  ok("G1 one fix 700 m away after a 60 s gap does not re-arm (the median of the last three cannot be one fix)", lp.privacyDebug().latch === false && lp.parkEndedByHeadUnit() === true);
}

// ── O · Jeff's 08-29 walk (crash_reports, handle Jeff, SELECT only; UTC) ─────────────────────────────────────────
//   20:00:46.090 spd=9 49.173335,-122.666000 · 20:00:56.095 spd=16 49.173400,-122.665518 · 20:01:06.564 spd=12
//   49.173395,-122.665085 · 20:01:17.091 spd=7 49.173371,-122.665494 · 20:01:28.633 spd=51 49.173307,-122.660864 (the
//   multipath fix, 338 m away) · 20:02:09.411 spd=49 49.173307,-122.660870 (the same coordinate 41 s later).
// Replayed after the 09-25 witnessed park at SPOT (the same street; SPOT is 30–70 m from his walking fixes).
{
  const P = (lat: number, lng: number) => ({ lat, lng });
  const REC = [
    { s: 0, p: P(49.173335, -122.666000), v: 9 }, { s: 10.005, p: P(49.173400, -122.665518), v: 16 },
    { s: 20.474, p: P(49.173395, -122.665085), v: 12 }, { s: 31.001, p: P(49.173371, -122.665494), v: 7 },
    { s: 42.543, p: P(49.173307, -122.660864), v: 51 }, { s: 83.321, p: P(49.173307, -122.660870), v: 49 },
  ];
  const pinnedAll = (lp: LP, seq: { s: number; p: { lat: number; lng: number }; v: number }[], t0: number) => {
    const bad: string[] = [];
    for (const f of seq) {
      clock = t0 + Math.round(f.s * S); lp.noteFix(f.p.lat, f.p.lng, kmh(f.v), null);
      const r = pinnedAtSpot(lp, { ...f.p, speed: kmh(f.v) });
      if (!r.ok && bad.length < 2) bad.push(`+${f.s.toFixed(1)}s ${r.why}`);
    }
    return bad;
  };
  const densify = (seq: typeof REC, over: (i: number, v: number) => number = (_i, v) => v) => {
    const out: typeof REC = [];
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = seq[i], b = seq[i + 1];
      for (let s2 = a.s; s2 < b.s; s2 += 1) { const k = (s2 - a.s) / (b.s - a.s); out.push({ s: s2, p: P(a.p.lat + (b.p.lat - a.p.lat) * k, a.p.lng + (b.p.lng - a.p.lng) * k), v: over(i, a.v + (b.v - a.v) * k) }); }
    }
    out.push(seq[seq.length - 1]);
    return out;
  };
  {
    const lp = await fresh(); parkWithCarPlay(lp);
    const bad = pinnedAll(lp, REC, utc(18, 50, 0));
    ok("O1 his 08-29 rows as recorded (both multipath fixes included) → pinned after every one", bad.length === 0, bad.join(" | "));
  }
  {
    // Counterfactual (review-priv/s_outlier.mts b): the 7 km/h sample read 10, so every walking fix is >= 9 km/h,
    // densified to 1 Hz by interpolation up to the first multipath fix, then one walking fix back.
    const lp = await fresh(); parkWithCarPlay(lp);
    const seq = densify(REC.slice(0, 4).map((f, i) => (i === 3 ? { ...f, v: 10 } : f)).concat([{ s: 41.6, p: P(49.173360, -122.665600), v: 10 }, REC[4], { s: 43.6, p: P(49.173371, -122.665494), v: 12 }]));
    const bad = pinnedAll(lp, seq, utc(19, 0, 0));
    ok("O2 counterfactual: walking >= 9 km/h at 1 Hz + the 338 m outlier + a walking fix → pinned", bad.length === 0, bad.join(" | "));
  }
  {
    // The adversarial reading of the two multipath rows 41 s apart: the phone sat on the bad coordinate the whole time,
    // reporting ~50 km/h at 1 Hz. Robust position AND displacement are then satisfied — only the move ratio refuses it.
    const lp = await fresh(); parkWithCarPlay(lp);
    const stuck = [] as typeof REC;
    for (let s2 = 42.543; s2 <= 83.321; s2 += 1) stuck.push({ s: s2, p: P(49.173307, -122.660864 - 0.000006 * ((s2 - 42.543) / 40.778)), v: 50 });
    const seq = densify(REC.slice(0, 4)).concat(stuck);
    const bad = pinnedAll(lp, seq, utc(19, 10, 0));
    ok(`O3 the phone stuck 41 s on the multipath coordinate (${metres(SPOT, REC[4].p).toFixed(0)} m from the spot) at 50 km/h → pinned (it never moved as its speed claims)`, bad.length === 0, bad.join(" | "));
  }
}

{
  // O4: the phone in a car that has NOT left — circling the car park at 16 km/h (a 40 m loop, so the speed and the
  // moves agree and vehicular time accrues) — then ONE multipath fix 400 m away. Only the robust median refuses it:
  // the last three fixes' median is still in the car park.
  const lp = await fresh(); parkWithCarPlay(lp);
  const t0 = utc(19, 20, 0); const R0 = 20; const v = kmh(16);
  const loopAt = (s2: number) => { const a = (v * s2) / R0; return { lat: SPOT.lat + (R0 * Math.sin(a)) / 111320, lng: SPOT.lng + (R0 * (1 - Math.cos(a))) / (111320 * Math.cos((SPOT.lat * Math.PI) / 180)) }; };
  let bad = "";
  for (let s2 = 0; s2 <= 60; s2++) { clock = t0 + s2 * S; const p = loopAt(s2); lp.noteFix(p.lat, p.lng, v, null); }
  const far = north(SPOT, 400); clock = t0 + 61 * S; lp.noteFix(far.lat, far.lng, kmh(50), null);
  const back = loopAt(62); clock = t0 + 62 * S; lp.noteFix(back.lat, back.lng, v, null);
  const r = pinnedAtSpot(lp, { ...back, speed: v });
  if (!r.ok) bad = r.why;
  ok("O4 60 s circling the car park at 16 km/h, then ONE fix 400 m away → pinned (the median of the last three)", bad === "", bad);
}

// ── S · every new witness starts the proof from nothing ─────────────────────────────────────────────────────────
{
  // S1 (review-priv/s_edges.mts): a proven drive-away, then a head-unit session with no fix in between, then a walk.
  const lp = await fresh(); parkWithCarPlay(lp);
  let t = utc(20, 0, 0), pos = SPOT;
  for (let i = 0; i < 60 && lp.parkEndedByHeadUnit(); i++) { t += S; clock = t; const v = Math.min(i * 1.0, 11); pos = north(pos, v); lp.noteFix(pos.lat, pos.lng, v, 0); }
  const spotBefore = lp.carSpot();
  t += 10 * 60 * S; clock = t; lp.noteCarConnected(true); t += 2 * S; clock = t; lp.noteCarConnected(false);
  const w = north(pos, 30); t += 60 * S; clock = t; lp.noteFix(w.lat, w.lng, kmh(26), null);
  const w2 = north(pos, 33); t += S; clock = t; lp.noteFix(w2.lat, w2.lng, kmh(12), null);
  const sp = lp.carSpot(); const sh = lp.shareablePosition({ ...w2, speed: kmh(12), heading: 0 });
  ok("S1 a proof from an earlier park does not carry into the next witness", lp.privacyDebug().latch === false && lp.parkEndedByHeadUnit() === true
    && sp?.lat === spotBefore?.lat && (sh as any).lat === spotBefore?.lat, JSON.stringify({ latch: lp.privacyDebug().latch, sh }));
}
{
  // S2: a fast fix reaches noteFix while hydrate is still reading a hu=1 spot (carDataService calls noteFix synchronously).
  const lp = await fresh(false);
  clock = utc(20, 30, 0);
  (globalThis as any).__store = {
    "convoy.lastCarSpot.v1": JSON.stringify({ lat: SPOT.lat, lng: SPOT.lng, t: utc(20, 20, 0), att: 0, mv: 0, hu: 1 }),
    "convoy.lastDrivingAt.v1": String(utc(20, 19, 0)),
  };
  const h = lp.hydrateLocationPrivacy();
  const p = north(SPOT, 40); lp.noteFix(p.lat, p.lng, kmh(26), null);
  await h;
  const q = north(SPOT, 45); clock = utc(20, 30, 5);
  const sh = lp.shareablePosition({ ...q, speed: kmh(12), heading: 0 });
  ok("S2 a hu=1 witness adopted after a racing fast fix drops that fix's latch → the car spot", lp.privacyDebug().latch === false && (sh as any).lat === SPOT.lat, JSON.stringify(sh));
}

// ── K · the head-unit SOURCES: iOS cold CarPlay (carPlayBootstrap) and the map.tsx mirror ───────────────────────
// Review 2026-09-25: on iOS only map.tsx reported a head unit, so a COLD CarPlay drive (the phone app never opened)
// was never witnessed (Rodrigo poi7m7-227888 `draw-cmp … latch=1 parked=1 hu=0` 282 s after `carplay-disconnect`).
const coldDrive = (lp: LP, source: "carplay" | null) => {
  clock = utc(21, 0, 0);
  if (source) lp.noteCarConnected(true, source);
  const start = north(SPOT, -720);
  for (let i = 0; i <= 60; i++) { clock = utc(21, 0, 0) + i * S; lp.noteFix(start.lat + (SPOT.lat - start.lat) * (i / 60), SPOT.lng, 12, 0); }  // carDataService.onStoreTick
  for (let i = 1; i <= 10; i++) { clock = utc(21, 1, 0) + i * S; lp.noteFix(SPOT.lat, SPOT.lng, 0, null); }
  clock = utc(21, 1, 20);
  if (source) lp.noteCarConnected(false, source);                           // carPlayBootstrap.onDisconnect
};
const openAppAndWalk = (lp: LP, mapWrites: boolean) => {
  clock = utc(21, 6, 20);                                                    // the app opened 5 min later
  if (mapWrites) lp.noteCarConnected(false);                                 // map.tsx mounts: its mirror reads false
  const walk = north(SPOT, 47);
  const before = lp.shareablePosition({ ...walk, speed: kmh(26), heading: 0 });   // the watcher callback, before noteFix
  lp.noteFix(walk.lat, walk.lng, kmh(26), null);
  const after = lp.shareablePosition({ ...walk, speed: kmh(26), heading: 0 });
  return { before, after, spot: lp.carSpot(), walk };
};
{
  const base = await freshBase();
  if (!base) console.log("  skip K0 negative control: pre-fix module unavailable");
  else {
    coldDrive(base, null);                                                   // pre-fix: nothing reports a head unit on iOS cold
    const r = openAppAndWalk(base, true);
    ok("K0 NEGATIVE CONTROL (pre-fix, cold CarPlay): the first 26 km/h walking fix is shared LIVE and becomes the car spot",
      (r.before as any).lat === r.walk.lat && (r.after as any).lat === r.walk.lat, JSON.stringify(r));
  }
  const lp = await fresh();
  coldDrive(lp, "carplay");
  ok("K1a cold CarPlay disconnect is witnessed and drops the latch", lp.parkEndedByHeadUnit() === true && lp.privacyDebug().latch === false);
  const r = openAppAndWalk(lp, true);
  const atSpot = (x: any) => x?.share === true && x.lat === SPOT.lat && x.lng === SPOT.lng;
  ok("K1b …5 min later the app opens (map mirror reads false) and a 26 km/h fix → the car spot, before and after noteFix", atSpot(r.before) && atSpot(r.after) && r.spot?.lat === SPOT.lat, JSON.stringify(r));
}
{
  // K2: yesterday's witnessed park on disk; hydrate first, then the cold connect.
  const lp = await fresh(false);
  clock = utc(22, 0, 0);
  (globalThis as any).__store = { "convoy.lastCarSpot.v1": JSON.stringify({ lat: SPOT.lat, lng: SPOT.lng, t: clock - 12 * 3600 * S, att: 0, mv: 0, hu: 1 }) };
  await lp.hydrateLocationPrivacy();
  const was = lp.parkEndedByHeadUnit();
  lp.noteCarConnected(true, "carplay");
  const p = north(SPOT, 12); clock += S; lp.noteFix(p.lat, p.lng, 12, 0);
  const sh = lp.shareablePosition({ ...p, speed: 12, heading: 0 });
  ok("K2 a cold connect clears a persisted hu=1 witness at once; the drive is live from its first fix", was === true && lp.parkEndedByHeadUnit() === false && (sh as any).lat === p.lat, JSON.stringify(sh));
}
{
  // K3: the connect lands first, the hydrate read resolves after it.
  const lp = await fresh(false);
  clock = utc(22, 30, 0);
  (globalThis as any).__store = { "convoy.lastCarSpot.v1": JSON.stringify({ lat: SPOT.lat, lng: SPOT.lng, t: clock - 12 * 3600 * S, att: 0, mv: 0, hu: 1 }) };
  lp.noteCarConnected(true, "carplay");
  await lp.hydrateLocationPrivacy();
  ok("K3 hydrate never adopts a witness while a head unit is attached", lp.parkEndedByHeadUnit() === false);
}
{
  // K4: warm iOS, both writers. The bootstrap claims the source at boot; the map mirror lags at both ends.
  const lp = await fresh();
  clock = utc(23, 0, 0);
  lp.noteCarConnected(false, "carplay");                                     // boot, nothing attached
  lp.noteCarConnected(true, "carplay");                                      // connect
  lp.noteCarConnected(false);                                                // map mirror still false (lagging render)
  const noSpuriousWitness = lp.parkEndedByHeadUnit() === false && lp.headUnitAttachedRaw() === true;
  lp.noteCarConnected(true);
  const start = north(SPOT, -300);
  for (let i = 0; i <= 25; i++) { clock = utc(23, 0, 1) + i * S; lp.noteFix(start.lat + (SPOT.lat - start.lat) * (i / 25), SPOT.lng, 12, 0); }
  clock += 5 * S;
  lp.noteCarConnected(false, "carplay");                                     // disconnect (session lifecycle)
  const witnessed = lp.parkEndedByHeadUnit() === true && lp.privacyDebug().latch === false && lp.headUnitAttachedRaw() === false;
  lp.noteCarConnected(true);                                                 // the mirror, one render late, still true
  const w = north(SPOT, 30); clock += S;
  const sh = lp.shareablePosition({ ...w, speed: kmh(12), heading: 0 });
  const notCancelled = lp.parkEndedByHeadUnit() === true && (sh as any).lat === SPOT.lat;
  lp.noteCarConnected(false);
  ok("K4a a lagging map mirror at the connect creates no witness", noSpuriousWitness);
  ok("K4b the session disconnect witnesses at once", witnessed);
  ok("K4c a lagging map mirror after the disconnect cannot cancel the witness or share live", notCancelled && lp.parkEndedByHeadUnit() === true, JSON.stringify(sh));
}
{
  // K5: the bootstrap never ran in this context (it bailed): map.tsx is the writer, as before.
  const lp = await fresh();
  clock = utc(23, 30, 0);
  lp.noteCarConnected(true);
  const p = north(SPOT, 10); lp.noteFix(p.lat, p.lng, 12, 0);
  clock += 5 * S; lp.noteCarConnected(false);
  ok("K5 with no session source the map mirror still witnesses (the pre-2026-09-25 path)", lp.parkEndedByHeadUnit() === true);
}

// ── C · a CarPlay reconnect is instant (unchanged) ──────────────────────────────────────────────────────────────
{
  const lp = await fresh();
  parkWithCarPlay(lp);
  clock = utc(18, 0, 0);
  lp.noteCarConnected(true);
  ok("C1 reconnect clears the witnessed park at once", lp.parkEndedByHeadUnit() === false);
  const p = north(SPOT, 10); clock += S; lp.noteFix(p.lat, p.lng, kmh(20), 0);
  const sh = lp.shareablePosition({ ...p, speed: kmh(20), heading: 0 });
  ok("C2 the first vehicular fix arms the latch and is shared live", lp.privacyDebug().latch === true && sh.share === true && (sh as any).lat === p.lat, JSON.stringify(sh));
}

// ── U · without a witnessed park the module behaves exactly as before, fix by fix ───────────────────────────────
{
  const cur = await fresh();
  const old = await freshBase();
  if (!old) console.log("  skip U: pre-fix module unavailable");
  else {
    // A phone-only day (no head unit ever): drive, red light, crawl, park, walk, a GPS spike on foot, jog, drive again.
    const script: { dt: number; v: number; m: number }[] = [];
    for (let i = 0; i < 30; i++) script.push({ dt: 1, v: i < 5 ? i : 12, m: i < 5 ? i : 12 });
    for (let i = 0; i < 20; i++) script.push({ dt: 1, v: 0, m: 0 });
    for (let i = 0; i < 20; i++) script.push({ dt: 1, v: 2, m: 2 });
    for (let i = 0; i < 5; i++) script.push({ dt: 30, v: 0, m: 0 });
    for (let i = 0; i < 30; i++) script.push({ dt: 1, v: 1.4, m: 1.4 });
    script.push({ dt: 1, v: kmh(26), m: 2 });
    for (let i = 0; i < 20; i++) script.push({ dt: 1, v: 3, m: 3 });
    for (let i = 0; i < 40; i++) script.push({ dt: 1, v: 14, m: 14 });
    const run = (lp: LP) => {
      let t = utc(19, 0, 0), p = north(SPOT, 2000); const out: string[] = [];
      for (const s of script) {
        t += s.dt * S; clock = t; p = north(p, s.m); lp.noteFix(p.lat, p.lng, s.v, 90);
        const d = lp.privacyDebug(); const sh = lp.shareablePosition({ ...p, speed: s.v, heading: 90 }); const sp = lp.carSpot();
        out.push(JSON.stringify([d.latch, d.parked, d.hu, lp.parkEndedByHeadUnit(), sh, sp]));
      }
      return out;
    };
    const a = run(cur), b = run(old);
    const firstDiff = a.findIndex((x, i) => x !== b[i]);
    ok(`U1 no witnessed park: ${a.length} fixes, identical latch/parked/witness/share/spot to the pre-fix module`, firstDiff === -1, firstDiff >= 0 ? `first diff at fix ${firstDiff}: new ${a[firstDiff]} vs old ${b[firstDiff]}` : "");
  }
}

// ── H · a witnessed park restored from disk (a relaunch while parked) ───────────────────────────────────────────
{
  const lp = await fresh(false);
  clock = utc(20, 0, 0);
  (globalThis as any).__store = {
    "convoy.lastCarSpot.v1": JSON.stringify({ lat: SPOT.lat, lng: SPOT.lng, t: clock - 10 * 60 * S, att: 0, mv: 0, hu: 1 }),
    "convoy.lastDrivingAt.v1": String(clock - 12 * 60 * S),
  };
  await lp.hydrateLocationPrivacy();
  ok("H0 precondition: the persisted witnessed park is adopted", lp.parkEndedByHeadUnit() === true && lp.carSpot()?.lat === SPOT.lat);
  clock += S; lp.noteFix(A2.lat, A2.lng, kmh(26), null);
  const r = pinnedAtSpot(lp, { ...A2, speed: kmh(26) });
  ok("H1 one 26 km/h fix after a relaunch does not un-pin it either", r.ok, r.why);
}

// ── W · the drive's latch is still inside its 90 s window when the head unit lets go ────────────────────────────
// The drive's last >= 9 km/h fix is 17:06:00; the disconnect comes 40 s later, so the pre-fix latch is still armed.
// A 12 km/h fix (above walking, below the 15 km/h entry) and a 26 km/h fix — each asked BEFORE noteFix sees it (the
// map.tsx order: the watcher callback posts /location, the coords effect calls noteFix a render later) and after.
{
  const run = (lp: LP) => {
    parkWithCarPlay(lp, utc(17, 6, 40), false);
    const out: { name: string; before: any; after: any; latch: boolean }[] = [];
    for (const [name, sec, m, v] of [["12 km/h", 45, 20, kmh(12)], ["26 km/h", 50, 60, kmh(26)]] as const) {
      clock = utc(17, 6, sec); const p = north(SPOT, m);
      const before = lp.shareablePosition({ ...p, speed: v, heading: 0 });
      lp.noteFix(p.lat, p.lng, v, 0);
      const after = lp.shareablePosition({ ...p, speed: v, heading: 0 });
      out.push({ name, before, after, latch: lp.privacyDebug().latch });
    }
    return out;
  };
  const atSpot = (sh: any) => sh?.share === true && sh.lat === SPOT.lat && sh.lng === SPOT.lng;
  const base = await freshBase();
  if (!base) console.log("  skip W negative control: pre-fix module unavailable");
  else {
    const r = run(base);
    ok("W0 NEGATIVE CONTROL (real pre-fix module): 40 s after the disconnect a 12 km/h fix is shared LIVE on the drive's latch", !atSpot(r[0].before) && r[0].before?.share === true, JSON.stringify(r[0].before));
    ok("W0b NEGATIVE CONTROL: …and so is the 26 km/h fix", !atSpot(r[1].before) && !atSpot(r[1].after), JSON.stringify(r[1].after));
  }
  const lp = await fresh();
  const r = run(lp);
  ok("W1 the witnessed park drops the drive's latch at once", r.every((x) => x.latch === false), JSON.stringify(r.map((x) => x.latch)));
  ok("W2 12 km/h fix → the car spot, before and after noteFix (movingNow false)", atSpot(r[0].before) && atSpot(r[0].after), JSON.stringify([r[0].before, r[0].after]));
  ok("W3 26 km/h fix → the car spot, before and after noteFix", atSpot(r[1].before) && atSpot(r[1].after), JSON.stringify([r[1].before, r[1].after]));
  ok("W4 the 90 s parked STATUS label is unchanged (still 'live' 50 s after the last driving fix)", r[1].after?.status === "live", JSON.stringify(r[1].after));
}

// ── H2 · a relaunch inside the 90 s window with a witnessed park on disk ─────────────────────────────────────────
// hydrate restores the latch (provisionally) from a driving stamp < 90 s old AND adopts a spot persisted with hu=1.
{
  const seed = () => {
    (globalThis as any).__store = {
      "convoy.lastCarSpot.v1": JSON.stringify({ lat: SPOT.lat, lng: SPOT.lng, t: clock - 20 * S, att: 0, mv: 0, hu: 1 }),
      "convoy.lastDrivingAt.v1": String(clock - 30 * S),
    };
  };
  const walkP = north(SPOT, 20);
  const base = await freshBase(false);
  if (base) {
    clock = utc(21, 0, 0); seed();
    await base.hydrateLocationPrivacy();
    const sh = base.shareablePosition({ ...walkP, speed: kmh(12), heading: 0 });
    ok("H2a NEGATIVE CONTROL (pre-fix): witnessed spot + restored latch → a 12 km/h fix is shared LIVE", base.parkEndedByHeadUnit() && base.privacyDebug().latch && sh.share === true && (sh as any).lat === walkP.lat, JSON.stringify(sh));
  } else console.log("  skip H2a negative control: pre-fix module unavailable");
  const lp = await fresh(false);
  clock = utc(21, 0, 0); seed();
  await lp.hydrateLocationPrivacy();
  ok("H2 precondition: the witnessed spot is adopted", lp.parkEndedByHeadUnit() === true && lp.carSpot()?.lat === SPOT.lat);
  ok("H2b no latch is restored over a witnessed park", lp.privacyDebug().latch === false);
  const sh = lp.shareablePosition({ ...walkP, speed: kmh(12), heading: 0 });
  ok("H2c a 12 km/h fix after that relaunch → the car spot", sh.share === true && (sh as any).lat === SPOT.lat && (sh as any).lng === SPOT.lng, JSON.stringify(sh));
  clock += S; lp.noteFix(walkP.lat, walkP.lng, kmh(26), null);
  const r = pinnedAtSpot(lp, { ...walkP, speed: kmh(26) });
  ok("H2d …and a 26 km/h fix too", r.ok, r.why);
}
{
  // Without a witnessed park the restore is untouched (the force-quit mid-drive fix, 2026-08-29).
  const lp = await fresh(false);
  clock = utc(22, 0, 0);
  (globalThis as any).__store = { "convoy.lastDrivingAt.v1": String(clock - 30 * S) };
  await lp.hydrateLocationPrivacy();
  ok("H3 no witness: a driving stamp < 90 s old still restores the latch", lp.privacyDebug().latch === true);
}

// ── Y · nothing is proven before the saved park is known (Codex 3rd pass) ─────────────────────────────────────────
// A relaunch with a witnessed park (hu=1) on disk; storage answers LATE; 1, 2 and 5 fast fixes land before it does.
// The pre-hydration fixes may not arm the latch or write the spot, so the saved witness is adopted and holds.
const LOC_V = (globalThis as any);
async function relaunchWithFixesBeforeRead(lp: LP, nFast: number) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const store = { "convoy.lastCarSpot.v1": JSON.stringify({ lat: SPOT.lat, lng: SPOT.lng, t: clock - 15 * 60 * S, att: 0, mv: 0, hu: 1 }) } as Record<string, string>;
  LOC_V.__store = new Proxy(store, { get: (o, k: string) => o[k] });
  LOC_V.__delay = gate;
  const h = lp.hydrateLocationPrivacy();
  const shares: any[] = [];
  for (let i = 1; i <= nFast; i++) {
    clock += S; const p = north(SPOT, 30 + 8 * i);
    shares.push(lp.shareablePosition({ ...p, speed: kmh(26), heading: 0 }));
    lp.noteFix(p.lat, p.lng, kmh(26), null);
  }
  release(); await h; LOC_V.__delay = null;
  const w = north(SPOT, 90); clock += S;
  const before = lp.shareablePosition({ ...w, speed: kmh(12), heading: 0 });
  lp.noteFix(w.lat, w.lng, kmh(12), null);
  const after = lp.shareablePosition({ ...w, speed: kmh(12), heading: 0 });
  return { shares, before, after, hu: lp.parkEndedByHeadUnit(), latch: lp.privacyDebug().latch, spot: lp.carSpot() };
}
{
  const atSpot = (x: any) => x?.share === true && x.lat === SPOT.lat && x.lng === SPOT.lng;
  const noLive = (xs: any[]) => xs.every((x) => !x.share || (x.lat === SPOT.lat));
  for (const n of [1, 2, 5]) {
    clock = utc(22, 40, 0);
    const lp = await fresh(false);
    const r = await relaunchWithFixesBeforeRead(lp, n);
    ok(`Y${n} ${n} fast fix(es) before a late storage read → the saved hu=1 witness holds; a 12 km/h walk fix → the car spot`,
      r.hu === true && r.latch === false && atSpot(r.before) && atSpot(r.after) && r.spot?.lat === SPOT.lat && noLive(r.shares),
      JSON.stringify({ hu: r.hu, latch: r.latch, before: r.before, after: r.after, preShares: r.shares.map((x: any) => x.share ? `${x.lat}` : x.reason) }));
  }
  {
    // Y6 SINGLE-FLIGHT: a second caller while the read is in flight gets the SAME promise — not an early "done".
    const lp = await fresh(false);
    let release: () => void = () => {}; LOC_V.__delay = new Promise<void>((r) => { release = r; });
    const h1 = lp.hydrateLocationPrivacy(); const h2 = lp.hydrateLocationPrivacy();
    let early = false; void h2.then(() => { early = true; }); await Promise.resolve(); await Promise.resolve();
    const sameAndPending = h1 === h2 && !early;
    release(); await h2; LOC_V.__delay = null;
    ok("Y6 hydrate is single-flight: a second caller during the read gets the same pending promise", sameAndPending);
  }
  // NEGATIVE CONTROL on the previous round's module (732c8a6e): two fixes before the read skip the saved witness.
  let prevSrc: string | null = null;
  try { prevSrc = execFileSync("git", ["show", "732c8a6e:frontend/src/locationPrivacy.ts"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
  if (prevSrc) {
    const d = mkdtempSync(join(tmpdir(), "park-rearm-r3-")); const f = join(d, "locationPrivacy.base.ts"); writeFileSync(f, prevSrc);
    clock = utc(22, 50, 0);
    const lp: LP = await import(pathToFileURL(f).href + `?i=${++inst}`);
    const r = await relaunchWithFixesBeforeRead(lp, 2);
    ok("Y0 NEGATIVE CONTROL (round 3, 732c8a6e): 2 fast fixes before the read → the witness is skipped and the walk is shared LIVE",
      r.hu === false && (r.after as any).lat !== SPOT.lat, JSON.stringify({ hu: r.hu, latch: r.latch, after: r.after }));
    rmSync(d, { recursive: true, force: true });
  } else console.log("  skip Y0 negative control: 732c8a6e unavailable");
}

// ── HF · a FAILED storage read at a relaunch is not "hydrated" (Codex final review, 2026-09-25) ─────────────────────
// Trigger (HYPOTHESIS): iOS relaunching the app in the background before the first unlock after a reboot, when the
// data-protected AsyncStorage manifest cannot be read. The app launch calls hydrate; then the phone, on foot, delivers
// 1 Hz walking fixes (1.4 m/s) with a 26 and a 29 km/h reading at +3/+4 s and again at +30/+31 s, and 12 km/h at +5 s.
{
  const SPOT_KEY = "convoy.lastCarSpot.v1";
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const walkAfterFailedRead = async (lpP: Promise<LP | null>, getItem: (k: string, store: Record<string, string>) => Promise<string | null>) => {
    clock = utc(23, 10, 0);
    const lp = await lpP; if (!lp) return null;
    const record = JSON.stringify({ lat: SPOT.lat, lng: SPOT.lng, t: clock - 15 * 60 * S, att: 0, mv: 0, hu: 1 });
    LOC_V.__store = { [SPOT_KEY]: record }; LOC_V.__rows = []; LOC_V.__getItem = getItem;
    void lp.hydrateLocationPrivacy();                               // the app launch
    await tick();
    const live: string[] = []; let adoptedAt: number | null = null;
    for (let i = 1; i <= 60; i++) {
      clock += S;
      const v = i === 3 || i === 30 ? kmh(26) : i === 4 || i === 31 ? kmh(29) : i === 5 ? kmh(12) : 1.4;
      const p = north(SPOT, 30 + 1.4 * i);
      lp.noteFix(p.lat, p.lng, v, null);
      await tick(); await tick();
      const sh: any = lp.shareablePosition({ ...p, speed: v, heading: 0 });
      if (sh.share && sh.lat === p.lat && sh.lng === p.lng) live.push(`+${i}s@${(v * 3.6).toFixed(0)}`);
      if (adoptedAt == null && lp.parkEndedByHeadUnit()) adoptedAt = i;
    }
    const out = { live, adoptedAt, hu: lp.parkEndedByHeadUnit(), latch: lp.privacyDebug().latch, spot: lp.carSpot(), diskIntact: LOC_V.__store[SPOT_KEY] === record, rows: [...(LOC_V.__rows as string[])] };
    LOC_V.__getItem = undefined;
    return out;
  };
  // Storage fault models: `n` = which attempt this is (counted on the spot key's read).
  const faulty = (fault: (n: number) => "reject" | "garbage" | "hang" | "ok") => {
    let n = 0;
    return (k: string, store: Record<string, string>) => {
      const attempt = k === SPOT_KEY ? ++n : n;
      const f = fault(attempt);
      if (f === "reject") return Promise.reject(new Error("storage unavailable"));
      if (f === "hang") return new Promise<string | null>(() => {});
      if (f === "garbage" && k === SPOT_KEY) return Promise.resolve('{"lat":49.17293');
      return Promise.resolve(store[k] ?? null);
    };
  };
  const cases: [string, (n: number) => "reject" | "garbage" | "hang" | "ok", RegExp][] = [
    ["a read that rejects once", (n) => (n <= 1 ? "reject" : "ok"), /priv-hydrate ok=0 why=read[\s\S]*priv-hydrate ok=1 why=spot/],
    ["a read that rejects 3 times, then succeeds", (n) => (n <= 3 ? "reject" : "ok"), /(priv-hydrate ok=0 why=read[\s\S]*){3}priv-hydrate ok=1 why=spot/],
    ["a saved record that does not parse, twice", (n) => (n <= 2 ? "garbage" : "ok"), /priv-hydrate ok=0 why=parse[\s\S]*priv-hydrate ok=1 why=spot/],
    ["a read that hangs", (n) => (n <= 1 ? "hang" : "ok"), /priv-hydrate ok=1 why=spot/],
  ];
  {
    // NEGATIVE CONTROL: 0255f36a (the round-5b commit) on the reject-once case.
    let base: string | null = null;
    try { base = execFileSync("git", ["show", "0255f36a:frontend/src/locationPrivacy.ts"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
    if (base) {
      const d = mkdtempSync(join(tmpdir(), "park-rearm-hf0-")); const f = join(d, "locationPrivacy.base.ts"); writeFileSync(f, base);
      LOC_V.__store = {};
      const r = await walkAfterFailedRead(import(pathToFileURL(f).href + `?i=${++inst}`), faulty((n) => (n <= 1 ? "reject" : "ok")));
      ok("HF0 NEGATIVE CONTROL (0255f36a): a read that rejects once → the saved witness is never adopted, the walk is shared LIVE and the record on disk is overwritten",
        !!r && r.hu === false && r.live.length > 0 && r.diskIntact === false, JSON.stringify(r && { live: r.live, hu: r.hu, disk: r.diskIntact }));
      rmSync(d, { recursive: true, force: true });
    } else console.log("  skip HF0 negative control: 0255f36a unavailable");
  }
  for (const [i, [name, fault, rowsRe]] of cases.entries()) {
    const r = await walkAfterFailedRead(fresh(false), faulty(fault));
    ok(`HF${i + 1} ${name}: never shared live, the saved witness adopted by a retry, the record on disk intact, the rows name it`,
      !!r && r.live.length === 0 && r.hu === true && r.latch === false && r.adoptedAt != null && r.spot?.lat === SPOT.lat && r.spot?.lng === SPOT.lng
        && r.diskIntact && rowsRe.test(r.rows.join("\n")) && r.rows.length <= 5,
      JSON.stringify(r && { live: r.live, adoptedAt: r.adoptedAt, hu: r.hu, latch: r.latch, disk: r.diskIntact, rows: r.rows }));
  }
  {
    // HF6 a read that hung and settles AFTER a retry succeeded applies nothing and reports nothing (it is "late").
    let releaseHung: (v: string | null) => void = () => {};
    const hung = new Promise<string | null>((r) => { releaseHung = r; });
    let n = 0;
    const r = await walkAfterFailedRead(fresh(false), (k, store) => { if (k === SPOT_KEY) n++; return n <= 1 ? hung : Promise.resolve(store[k] ?? null); });
    const lpState = r && { hu: r.hu, latch: r.latch, spot: r.spot, rows: r.rows.length };
    releaseHung(JSON.stringify({ lat: SPOT.lat + 0.01, lng: SPOT.lng, t: clock - 60 * S, att: 0, mv: 0, hu: 1 }));
    await tick(); await tick(); await tick();
    const rowsAfter = (LOC_V.__rows as string[]).length;
    ok("HF6 a read that hung and settles after a retry succeeded changes nothing (no second adoption, no row)", !!r && r.hu === true && rowsAfter === lpState!.rows && r.rows.filter((x) => x.includes("ok=1")).length === 1,
      JSON.stringify({ before: lpState, rowsAfter }));
  }
  // A module at a given commit (its relative imports resolve to this worktree's, which 47db1aca shares).
  const lpAt = async (rev: string): Promise<{ lp: LP; dir: string } | null> => {
    let src: string | null = null;
    try { src = execFileSync("git", ["show", `${rev}:frontend/src/locationPrivacy.ts`], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
    if (!src) return null;
    const dir = mkdtempSync(join(tmpdir(), `park-rearm-${rev}-`)); const f = join(dir, "locationPrivacy.base.ts"); writeFileSync(f, src);
    return { lp: await import(pathToFileURL(f).href + `?i=${++inst}`), dir };
  };
  {
    // HF7 ANDROID TTL WITH FAILING READS (Codex delta review, reproduced there on 47db1aca): every read rejects; an
    // Android Auto session asserts, 60 s of driving at 20 m/s (shared live — the head unit), then NO disconnect is
    // heard; 100 s after the last driving fix the phone is walking at 3.3 m/s, then 26 km/h, 12 km/h, for 3 min.
    const run = async (lpP: Promise<LP | null>) => {
      const lp = await lpP; if (!lp) return null;
      LOC_V.__os = "android"; LOC_V.__store = {}; LOC_V.__rows = [];
      LOC_V.__getItem = () => Promise.reject(new Error("storage unavailable"));
      clock = utc(23, 30, 0);
      void lp.hydrateLocationPrivacy(); await tick();
      lp.noteCarConnected(true, "androidauto");
      let p = north(SPOT, -1500); let driveLive = false;
      for (let i = 0; i < 60; i++) { clock += S; p = north(p, 20); lp.noteFix(p.lat, p.lng, 20, 0); await tick(); const sh: any = lp.shareablePosition({ ...p, speed: 20, heading: 0 }); if (sh.share && sh.lat === p.lat) driveLive = true; }
      const latchAtEnd = lp.privacyDebug().latch;
      clock += 100 * S;
      const live: string[] = [];
      for (let i = 0; i < 180; i++) {
        clock += S; const v = i % 30 === 5 ? kmh(26) : i % 30 === 6 ? kmh(12) : 3.3; p = north(p, v);
        lp.noteFix(p.lat, p.lng, v, null); await tick();
        const sh: any = lp.shareablePosition({ ...p, speed: v, heading: 0 });
        if (sh.share && sh.lat === p.lat && sh.lng === p.lng) live.push(`+${i}s@${(v * 3.6).toFixed(0)}`);
      }
      const out = { driveLive, latchAtEnd, live, latchAfter: lp.privacyDebug().latch, parked: lp.privacyDebug().parked };
      LOC_V.__getItem = undefined; LOC_V.__os = undefined;
      return out;
    };
    const old = await lpAt("47db1aca");
    if (old) {
      const r0 = await run(Promise.resolve(old.lp));
      ok("HF7-0 NEGATIVE CONTROL (47db1aca): after the TTL lapses the head unit's latch shares the walk LIVE", !!r0 && r0.driveLive && r0.live.length > 0, JSON.stringify(r0 && { live: r0.live.slice(0, 5), n: r0.live.length, latch: r0.latchAfter }));
      rmSync(old.dir, { recursive: true, force: true });
    } else console.log("  skip HF7-0 negative control: 47db1aca unavailable");
    const r = await run(fresh(false));
    ok("HF7 Android Auto TTL lapse with failing reads: the drive is live while attached, the walk after it never is (the latch expires, sharing needs a read)",
      !!r && r.driveLive && r.latchAtEnd && r.live.length === 0 && r.latchAfter === false, JSON.stringify(r));
    // HF7b the SHARING rule alone: the TTL lapses 90 s into a 150 s drive (no further assertion), so the latch the head
    // unit armed is still inside its 90 s window when the walk starts 10 s after the drive — only `shareablePosition`
    // requiring a successful read keeps that walk off the map. HF7b-0: this module without that one check shares it.
    const walkInsideWindow = async (lpP: Promise<LP | null>) => {
      const lp = await lpP; if (!lp) return null;
      LOC_V.__os = "android"; LOC_V.__store = {}; LOC_V.__rows = [];
      LOC_V.__getItem = () => Promise.reject(new Error("storage unavailable"));
      clock = utc(23, 40, 0);
      void lp.hydrateLocationPrivacy(); await tick();
      lp.noteCarConnected(true, "androidauto");
      let p = north(SPOT, -3000);
      for (let i = 0; i < 150; i++) { clock += S; p = north(p, 20); lp.noteFix(p.lat, p.lng, 20, 0); await tick(); }
      clock += 10 * S;
      const live: string[] = [];
      for (let i = 0; i < 30; i++) {
        clock += S; const v = kmh(12); p = north(p, v); lp.noteFix(p.lat, p.lng, v, null); await tick();
        const sh: any = lp.shareablePosition({ ...p, speed: v, heading: 0 });
        if (sh.share && sh.lat === p.lat && sh.lng === p.lng) live.push(`+${i}s`);
      }
      LOC_V.__getItem = undefined; LOC_V.__os = undefined;
      return { live, latch: lp.privacyDebug().latch };
    };
    {
      const src = readFileSync(new URL("locationPrivacy.ts", SRC), "utf8");
      const anchor = "const movingNow = _hydrateDone && latchFresh &&";
      const d = mkdtempSync(join(tmpdir(), "park-rearm-hf7b-")); const f = join(d, "locationPrivacy.base.ts");
      writeFileSync(f, src.replace(anchor, "const movingNow = latchFresh &&"));
      const r0 = await walkInsideWindow(import(pathToFileURL(f).href + `?i=${++inst}`));
      ok("HF7b-0 NEGATIVE CONTROL (this module without the hydration check in shareablePosition): the walk inside the latch window is shared LIVE", src.includes(anchor) && !!r0 && r0.live.length > 0, JSON.stringify(r0 && { n: r0.live.length, latch: r0.latch }));
      rmSync(d, { recursive: true, force: true });
    }
    const rb = await walkInsideWindow(fresh(false));
    ok("HF7b …a walk inside the head unit's 90 s latch window after the TTL lapsed, reads still failing → never live", !!rb && rb.live.length === 0, JSON.stringify(rb));
  }
  {
    // HF8 a caller awaiting the first, HUNG attempt (carDataService's cold-start await) is released when a retry
    // succeeds — before its 10 s bound.
    const run = async (lpP: Promise<LP | null>) => {
      const lp = await lpP; if (!lp) return null;
      clock = utc(23, 50, 0);
      const record = JSON.stringify({ lat: SPOT.lat, lng: SPOT.lng, t: clock - 15 * 60 * S, att: 0, mv: 0, hu: 1 });
      LOC_V.__store = { [SPOT_KEY]: record }; LOC_V.__rows = [];
      let n = 0; LOC_V.__getItem = (k: string, store: Record<string, string>) => { if (k === SPOT_KEY) n++; return n <= 1 ? new Promise(() => {}) : Promise.resolve(store[k] ?? null); };
      let released = false;
      const w = lp.hydrateLocationPrivacy(); void w.then(() => { released = true; });
      await tick();
      const before = released;
      clock += 6 * S; const p = north(SPOT, 40); lp.noteFix(p.lat, p.lng, 1.4, null);
      for (let k = 0; k < 5; k++) await tick();
      LOC_V.__getItem = undefined;
      return { before, released, hydratedHu: lp.parkEndedByHeadUnit() };
    };
    const old = await lpAt("47db1aca");
    if (old) {
      const r0 = await run(Promise.resolve(old.lp));
      ok("HF8-0 NEGATIVE CONTROL (47db1aca): the retry hydrates, but the caller of the hung attempt is never released", !!r0 && r0.hydratedHu === true && r0.released === false, JSON.stringify(r0));
      rmSync(old.dir, { recursive: true, force: true });
    } else console.log("  skip HF8-0 negative control: 47db1aca unavailable");
    const r = await run(fresh(false));
    ok("HF8 a caller of the hung first attempt is released when a retry succeeds (and the saved witness is adopted)", !!r && r.before === false && r.released === true && r.hydratedHu === true, JSON.stringify(r));
    // HF8b with no retry at all, a hung read releases its callers at the 10 s bound (setTimeout captured) — un-hydrated.
    {
      const lp = await fresh(false);
      LOC_V.__store = {}; LOC_V.__getItem = () => new Promise(() => {});
      const realSetTimeout = globalThis.setTimeout; const timers: { fn: () => void; ms: number }[] = [];
      (globalThis as any).setTimeout = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; };
      clock = utc(23, 55, 0);
      let released = false; void lp.hydrateLocationPrivacy().then(() => { released = true; });
      (globalThis as any).setTimeout = realSetTimeout;
      await tick(); const before = released;
      for (const t of timers) if (t.ms === 10_000) t.fn();
      await tick(); await tick();
      LOC_V.__getItem = undefined;
      ok("HF8b a read that hangs with no retry releases its callers at the 10 s bound, still un-hydrated (fail-closed)",
        before === false && released === true && timers.some((t) => t.ms === 10_000) && lp.privacyDebug().latch === false && lp.carSpot() == null,
        JSON.stringify({ before, released, timers: timers.map((t) => t.ms) }));
    }
    // HF8c carDataService: after its hydration await it marks privacy ready and joins presence unconditionally (only a
    // stopped service bails) — so a release by a retry, a failure or the bound all lead to the join; whether it shares
    // anything is shareablePosition's call per tick. (Static: carDataService is not loadable in node.)
    {
      const src = readFileSync(new URL("carplay/carDataService.ts", SRC), "utf8");
      const m = /try \{ await hydrateLocationPrivacy\(\); \} catch \{\}\s*\n\s*if \(!_running\) return;[^\n]*\n\s*_privacyReady = true;[\s\S]{0,1200}?\n\s*joinPresence\(\);\n\s*\}\)\(\);/.exec(src);
      ok("HF8c carDataService: `await hydrateLocationPrivacy()` → `_privacyReady = true` → `joinPresence()`, gated only on the service still running", !!m);
    }
  }
  {
    // HF9 THE SHARE DECISION IS SELF-SUFFICIENT (Codex delta review 2 — its exact sequence): reads fail; Android Auto
    // asserts and 60 s of driving fixes arm the latch; then 100 s with NO fix and no disconnect; then the reads recover
    // and hydration succeeds; then shareablePositionAsync of a 3.3 m/s walking position (no noteFix first — map.tsx's
    // manual refresh). HF9b the ordinary case: reads fine, a phone-only drive latched, 100 s with no fix, then a direct
    // shareablePosition of a walking position. HF9-0 / HF9b-0 = 7da32366 returning the walk.
    const hf9 = async (lpP: Promise<LP | null>) => {
      const lp = await lpP; if (!lp) return null;
      LOC_V.__os = "android"; LOC_V.__store = {}; LOC_V.__rows = [];
      LOC_V.__getItem = () => Promise.reject(new Error("storage unavailable"));
      clock = utc(21, 0, 0);
      void lp.hydrateLocationPrivacy(); await tick();
      lp.noteCarConnected(true, "androidauto");
      let p = north(SPOT, -1500);
      for (let i = 0; i < 60; i++) { clock += S; p = north(p, 20); lp.noteFix(p.lat, p.lng, 20, 0); await tick(); }
      const latched = lp.privacyDebug().latch;
      clock += 100 * S;                                              // no fix, no disconnect receipt
      LOC_V.__getItem = undefined;                                   // the reads recover
      await lp.hydrateLocationPrivacy(); await tick();
      const w = north(p, 40);
      const sh: any = await lp.shareablePositionAsync({ ...w, speed: 3.3, heading: 0 });
      const out = { latched, live: !!(sh.share && sh.lat === w.lat && sh.lng === w.lng), sh, parked: lp.privacyDebug().parked, latchAfter: lp.privacyDebug().latch };
      LOC_V.__os = undefined;
      return out;
    };
    const hf9b = async (lpP: Promise<LP | null>) => {
      const lp = await lpP; if (!lp) return null;
      clock = utc(21, 20, 0);
      let p = north(SPOT, -1500);
      for (let i = 0; i < 60; i++) { clock += S; p = north(p, 20); lp.noteFix(p.lat, p.lng, 20, 0); }
      const drivingLive = (() => { const sh: any = lp.shareablePosition({ ...p, speed: 20, heading: 0 }); return !!(sh.share && sh.lat === p.lat); })();
      clock += 100 * S;
      const w = north(p, 40);
      const sh: any = lp.shareablePosition({ ...w, speed: 3.3, heading: 0 });
      return { drivingLive, live: !!(sh.share && sh.lat === w.lat && sh.lng === w.lng), sh, parked: lp.privacyDebug().parked };
    };
    const old = await lpAt("7da32366");
    if (old) {
      const r0 = await hf9(Promise.resolve(old.lp));
      ok("HF9-0 NEGATIVE CONTROL (7da32366): the walking position is returned LIVE while isParked() says parked", !!r0 && r0.latched && r0.live && r0.parked, JSON.stringify(r0));
      rmSync(old.dir, { recursive: true, force: true });
      const old2 = await lpAt("7da32366");
      LOC_V.__store = {}; await old2!.lp.hydrateLocationPrivacy();
      const r0b = await hf9b(Promise.resolve(old2!.lp));
      ok("HF9b-0 NEGATIVE CONTROL (7da32366): a latched phone-only drive, 100 s with no fix → the walk is returned LIVE", !!r0b && r0b.drivingLive && r0b.live, JSON.stringify(r0b));
      rmSync(old2!.dir, { recursive: true, force: true });
    } else console.log("  skip HF9-0 / HF9b-0 negative controls: 7da32366 unavailable");
    const r = await hf9(fresh(false));
    ok("HF9 failed reads → AA latch → 100 s with no fix → reads recover → shareablePositionAsync(walking) is NOT live, and the stale latch is cleared",
      !!r && r.latched && !r.live && r.parked && r.latchAfter === false, JSON.stringify(r));
    const rb = await hf9b(fresh());
    ok("HF9b the same without any storage fault: a phone-only drive's latch 100 s old does not share a walk (the drive itself did)",
      !!rb && rb.drivingLive && !rb.live && rb.parked, JSON.stringify(rb));
    {
      // HF9c a clock that moved BACKWARDS after a latched drive (Codex delta review 3, its reproduction): the latch's
      // age is negative — expired, not eternal. A direct share, then 30 s of 3.3 m/s walking fixes THROUGH noteFix:
      // nothing shared live and the car spot never moves (it used to renew the latch and write the spot).
      // HF9d a clock that jumps FORWARD an hour after the drive, walking fixes, then back to 10 s after the drive,
      // walking fixes again: the jump ages the latch out and nothing revives it. HF9e Android Auto with its disconnect
      // LOST (the flag stays set), the 90 s TTL lapsed, then the clock moves back an hour: a negative TTL age is
      // expired too (carAttached), so the walk is not shared as "attached". HF9c-0 / HF9e-0 = 90dd1484.
      const clockCase = async (lpP: Promise<LP | null>, jump: "back" | "fwd") => {
        const lp = await lpP; if (!lp) return null;
        clock = utc(21, 40, 0); LOC_V.__store = {};
        await lp.hydrateLocationPrivacy();
        let p = north(SPOT, -1500);
        for (let i = 0; i < 60; i++) { clock += S; p = north(p, 20); lp.noteFix(p.lat, p.lng, 20, 0); }
        const spotBefore = lp.carSpot();
        wallSkew = (jump === "back" ? -3600 : 3600) * S;             // the DEVICE clock changes; true time does not
        const live: string[] = [];
        const direct: any = lp.shareablePosition({ ...north(p, 5), speed: 3.3, heading: 0 });
        if (direct.share && direct.lat !== spotBefore?.lat) live.push("direct");
        const walk = (n: number, tag: string) => { for (let i = 0; i < n; i++) { clock += S; p = north(p, 3.3); lp.noteFix(p.lat, p.lng, 3.3, null); const sh: any = lp.shareablePosition({ ...p, speed: 3.3, heading: 0 }); if (sh.share && sh.lat === p.lat && sh.lng === p.lng) live.push(`${tag}+${i}`); } };
        walk(30, "after");
        if (jump === "fwd") { wallSkew = 0; walk(20, "back-to-normal"); }
        wallSkew = 0;
        const spotAfter = lp.carSpot();
        return { live, spotMoved: !!spotBefore && !!spotAfter && (spotAfter.lat !== spotBefore.lat || spotAfter.lng !== spotBefore.lng), latch: lp.privacyDebug().latch, parked: lp.privacyDebug().parked };
      };
      const ttlCase = async (lpP: Promise<LP | null>) => {
        const lp = await lpP; if (!lp) return null;
        LOC_V.__os = "android"; LOC_V.__store = {}; clock = utc(22, 0, 0);
        await lp.hydrateLocationPrivacy();
        lp.noteCarConnected(true, "androidauto");               // …and its disconnect is never heard
        let p = north(SPOT, -1500);
        for (let i = 0; i < 60; i++) { clock += S; p = north(p, 20); lp.noteFix(p.lat, p.lng, 20, 0); }
        clock += 100 * S;                                        // the TTL lapsed
        wallSkew = -3600 * S;                                    // then the DEVICE clock moved back an hour
        const w = north(p, 40); const sh: any = lp.shareablePosition({ ...w, speed: 1.4, heading: 0 });
        LOC_V.__os = undefined; wallSkew = 0;
        return { live: !!(sh.share && sh.lat === w.lat && sh.lng === w.lng), sh };
      };
      const base = await lpAt("90dd1484");
      if (base) {
        const c0 = await clockCase(Promise.resolve(base.lp), "back");
        ok("HF9c-0 NEGATIVE CONTROL (90dd1484): after the clock moves back, walking fixes renew the latch, are shared LIVE and move the car spot", !!c0 && c0.live.length > 0 && c0.spotMoved, JSON.stringify(c0 && { n: c0.live.length, first: c0.live[0], spotMoved: c0.spotMoved }));
        rmSync(base.dir, { recursive: true, force: true });
        const base2 = await lpAt("90dd1484");
        const e0 = await ttlCase(Promise.resolve(base2!.lp));
        ok("HF9e-0 NEGATIVE CONTROL (90dd1484): a lost Android Auto disconnect + the clock moved back → the walk is shared as attached", !!e0 && e0.live, JSON.stringify(e0));
        rmSync(base2!.dir, { recursive: true, force: true });
      } else console.log("  skip HF9c-0 / HF9e-0 negative controls: 90dd1484 unavailable");
      const c = await clockCase(fresh(false), "back");
      ok("HF9c after the clock moves back an hour: no direct live share, 30 s of walking fixes through noteFix never shared live, the car spot never moves",
        !!c && c.live.length === 0 && !c.spotMoved && c.latch === false && c.parked === true, JSON.stringify(c));
      const d = await clockCase(fresh(false), "fwd");
      ok("HF9d a clock that jumps forward an hour and back: nothing shared live, the spot never moves, the latch stays expired",
        !!d && d.live.length === 0 && !d.spotMoved && d.latch === false, JSON.stringify(d));
      const e = await ttlCase(fresh(false));
      ok("HF9e a lost Android Auto disconnect, the TTL lapsed, then the clock moved back: not shared as attached", !!e && !e.live, JSON.stringify(e));
      // HF9f the latch is expired BEFORE anything reads it: a phone-only drive, 100 s with no fix, then ONE 26 km/h
      // walking fix. It may arm the latch (the unwitnessed rule), but it may not be RECORDED as the car spot on the
      // strength of the stale latch — the 08-29 arm-and-record rule (HF9f-0 = 90dd1484 moving the spot).
      const staleFast = async (lpP: Promise<LP | null>) => {
        const lp = await lpP; if (!lp) return null;
        clock = utc(22, 20, 0); LOC_V.__store = {}; await lp.hydrateLocationPrivacy();
        let p = north(SPOT, -1500);
        for (let i = 0; i < 60; i++) { clock += S; p = north(p, 20); lp.noteFix(p.lat, p.lng, 20, 0); }
        const before = lp.carSpot(); clock += 100 * S;
        const w = north(p, 60); lp.noteFix(w.lat, w.lng, kmh(26), null);
        const after = lp.carSpot();
        return { moved: !!before && !!after && (after.lat !== before.lat || after.lng !== before.lng) };
      };
      const b4 = await lpAt("90dd1484");
      if (b4) { const f0 = await staleFast(Promise.resolve(b4.lp)); ok("HF9f-0 NEGATIVE CONTROL (90dd1484): the first fast walking fix after a stale latch is recorded as the car spot", !!f0 && f0.moved, JSON.stringify(f0)); rmSync(b4.dir, { recursive: true, force: true }); }
      const f = await staleFast(fresh(false));
      ok("HF9f a stale latch is expired before noteFix reads it: one 26 km/h walking fix 100 s after the drive does not move the car spot", !!f && !f.moved, JSON.stringify(f));
      // HF9g ROLLBACK INTO THE WINDOW (Codex delta review 4, its exact sequence): Android Auto asserts at T and its
      // disconnect is lost; at T+100 s a walking fix (the attachment has expired); then the DEVICE clock is set back to
      // T+10 s — inside the original 90 s window — and a 1.4 m/s walking fix arrives. Measured on the wall clock the
      // attachment came back: the fix became the car spot and was shared live (HF9g-0 on b286ad9b).
      const hf9g = async (lpP: Promise<LP | null>) => {
        const lp = await lpP; if (!lp) return null;
        LOC_V.__os = "android"; LOC_V.__store = {}; clock = utc(22, 40, 0); wallSkew = 0;
        await lp.hydrateLocationPrivacy();
        const T = clock;
        lp.noteCarConnected(true, "androidauto");
        clock = T + 100 * S; let p = north(SPOT, 200); lp.noteFix(p.lat, p.lng, 1.4, null);
        const spotBefore = lp.carSpot();
        wallSkew = (T + 10 * S) - (clock + S);                        // the device clock now reads T+10 s
        clock += S; p = north(p, 1.4); lp.noteFix(p.lat, p.lng, 1.4, null);
        const sh: any = lp.shareablePosition({ ...p, speed: 1.4, heading: 0 });
        const spotAfter = lp.carSpot();
        LOC_V.__os = undefined; wallSkew = 0;
        return { live: !!(sh.share && sh.lat === p.lat && sh.lng === p.lng), spotBefore, spotAfter, spotWritten: JSON.stringify(spotBefore) !== JSON.stringify(spotAfter) };
      };
      const b5 = await lpAt("b286ad9b");
      if (b5) {
        const g0 = await hf9g(Promise.resolve(b5.lp));
        ok("HF9g-0 NEGATIVE CONTROL (b286ad9b): the rolled-back clock revives the attachment — the walking fix becomes the car spot and is shared LIVE", !!g0 && g0.live && g0.spotWritten, JSON.stringify(g0));
        rmSync(b5.dir, { recursive: true, force: true });
      } else console.log("  skip HF9g-0 negative control: b286ad9b unavailable");
      const g = await hf9g(fresh(false));
      ok("HF9g an expired Android Auto attachment stays expired when the clock is set back into its window: no spot write, not live", !!g && !g.live && !g.spotWritten, JSON.stringify(g));
    }
    {
      // PT PROPERTY: random DEVICE-clock jumps (±1 h, ±24 h, ±1 min, −2 min, −30 s; sometimes several in a row) every
      // 20–90 s, interleaved with
      // 10 min of 1 Hz fixes. (a) After a WITNESSED CarPlay disconnect, walking 1.1–2.0 m/s with 1 in 20 fixes reading
      // 26 km/h: never shared live, the car spot never written. (b) After a LOST Android Auto disconnect, once its 90 s
      // attachment has lapsed, walking 1.1–2.0 m/s (no fast readings — an unwitnessed park keeps the one-fast-fix rule):
      // never live, never a spot write. (c) A phone-only DRIVE at 15–25 m/s under the same jumps: shared live on every fix.
      const rnd = (seed: number) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t2 = Math.imul(a ^ (a >>> 15), 1 | a); t2 = (t2 + Math.imul(t2 ^ (t2 >>> 7), 61 | t2)) ^ t2; return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296; }; };
      const JUMPS = [3600, -3600, 86400, -86400, 60, -60, -120, -30];   // (small ones too: a rollback INTO a window)
      const jumper = (u: () => number) => { let next = 20 + Math.floor(u() * 70); return (i: number) => { if (i < next) return; next = i + 20 + Math.floor(u() * 70); const k = u() < 0.25 ? 3 : 1; for (let j = 0; j < k; j++) wallSkew += JUMPS[Math.floor(u() * JUMPS.length)] * S; }; };
      // "A spot write" = the car spot's POSITION or its recorded time changing (a slow final turn may legitimately retire
      // the parked HEADING of the same spot — src/carSpotTrust.ts headingTrackStep — which moves nothing).
      const spotKey = (x: any) => JSON.stringify(x ? { lat: x.lat, lng: x.lng, t: x.t } : null);
      const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);
      const lostAa = async (lpP: Promise<LP | null>, sd: number) => {
        const lp = await lpP; if (!lp) return "no-module";
        const u = rnd(1000 + sd); const jump = jumper(u);
        LOC_V.__os = "android"; LOC_V.__store = {}; wallSkew = 0; clock = utc(11, 0, 0);
        await lp.hydrateLocationPrivacy();
        lp.noteCarConnected(true, "androidauto");                     // its disconnect will be LOST
        let p = north(SPOT, -1200);
        for (let i = 0; i < 60; i++) { clock += S; p = north(p, 20); lp.noteFix(p.lat, p.lng, 20, 0); }
        clock += 40 * S;                                               // 100 s after the assertion: the attachment lapsed
        const spot0 = spotKey(lp.carSpot()); let bad = "";
        for (let i = 0; i < 600 && !bad; i++) {
          jump(i); clock += S; const v = 1.1 + 0.9 * u(); p = north(p, v);
          lp.noteFix(p.lat, p.lng, v, null);
          const sh: any = lp.shareablePosition({ ...p, speed: v, heading: 0 });
          if (sh.share && sh.lat === p.lat && sh.lng === p.lng) bad = `live@${i}`;
          else if (spotKey(lp.carSpot()) !== spot0) bad = `spot@${i}`;
        }
        LOC_V.__os = undefined; wallSkew = 0;
        return bad;
      };
      let aBad = 0, bBad = 0, cBad = 0; const why: string[] = [];
      for (const sd of SEEDS) {
        {
          const u = rnd(sd); const jump = jumper(u);
          const lp = await fresh(); wallSkew = 0; clock = utc(10, 0, 0);
          lp.noteCarConnected(true, "carplay");
          let p = north(SPOT, -1200);
          for (let i = 0; i < 60; i++) { clock += S; p = north(p, 20); lp.noteFix(p.lat, p.lng, 20, 0); }
          lp.noteCarConnected(false, "carplay");                      // witnessed
          const spot0 = spotKey(lp.carSpot()); let bad = "";
          for (let i = 0; i < 600 && !bad; i++) {
            jump(i); clock += S; const v = u() < 0.05 ? kmh(26) : 1.1 + 0.9 * u(); p = north(p, Math.min(v, 2));
            lp.noteFix(p.lat, p.lng, v, null);
            const sh: any = lp.shareablePosition({ ...p, speed: v, heading: 0 });
            if (sh.share && sh.lat === p.lat && sh.lng === p.lng) bad = `live@${i}`;
            else if (spotKey(lp.carSpot()) !== spot0) bad = `spot@${i}`;
          }
          if (bad) { aBad++; why.push(`a${sd}:${bad}`); }
          wallSkew = 0;
        }
        {
          const bad = await lostAa(fresh(), sd);
          if (bad) { bBad++; why.push(`b${sd}:${bad}`); }
        }
        {
          const u = rnd(2000 + sd); const jump = jumper(u);
          const lp = await fresh(); wallSkew = 0; clock = utc(12, 0, 0);
          let p = north(SPOT, 0); let notLive = 0;
          for (let i = 0; i < 600; i++) {
            jump(i); clock += S; const v = 15 + 10 * u(); p = north(p, v);
            lp.noteFix(p.lat, p.lng, v, 0);
            const sh: any = lp.shareablePosition({ ...p, speed: v, heading: 0 });
            if (!(sh.share && sh.lat === p.lat && sh.lng === p.lng)) notLive++;
          }
          if (notLive > 0) { cBad++; why.push(`c${sd}:${notLive} not live`); }
          wallSkew = 0;
        }
      }
      {
        let hits = 0, ran = 0;
        for (const sd of SEEDS) { const b = await lpAt("b286ad9b"); if (!b) break; ran++; if (await lostAa(Promise.resolve(b.lp), sd)) hits++; rmSync(b.dir, { recursive: true, force: true }); }
        if (ran) ok("PT-0 NEGATIVE CONTROL (b286ad9b, wall-clock windows): the lost-disconnect walks under the same jumps DO leak on some seeds", hits > 0, `${hits}/${SEEDS.length} leaked`);
        else console.log("  skip PT-0 negative control: b286ad9b unavailable");
      }
      ok(`PTa ${SEEDS.length} walks × 10 min after a witnessed disconnect, device clock jumping (±1 h, ±24 h, ±1 min, −2 min, −30 s): never live, never a spot write`, aBad === 0, why.filter((x) => x.startsWith("a")).join(" ") || "none");
      ok(`PTb ${SEEDS.length} walks × 10 min after a lost Android Auto disconnect (attachment lapsed), same jumps: never live, never a spot write`, bBad === 0, why.filter((x) => x.startsWith("b")).join(" ") || "none");
      ok(`PTc ${SEEDS.length} phone-only drives × 10 min, same jumps: shared live on every fix`, cBad === 0, why.filter((x) => x.startsWith("c")).join(" ") || "none");
      {
        // PTd LIVENESS: a real drive-away from a WITNESSED park while the device clock is set back an hour 10 s into it.
        // A rollback closes every privacy window (src/privacyClock.ts: a backward step adds an hour), so the re-arm proof
        // restarts at the jump — the accepted cost — and must still land: within 10 s + R2's bound (40 s) = 50 s.
        const lp = await fresh(); parkWithCarPlay(lp);
        const T = utc(17, 30, 0); let pos = SPOT; let at: number | null = null;
        for (let i = 0; i <= 90 && at == null; i++) {
          clock = T + i * S; if (i === 10) wallSkew = -3600 * S;
          const v = Math.min(i * 1.0, 11); pos = north(pos, v); lp.noteFix(pos.lat, pos.lng, v, 0);
          if (lp.privacyDebug().latch) at = i;
        }
        wallSkew = 0;
        ok("PTd a witnessed-park drive-away with the device clock set back an hour mid-proof still re-arms (restarted at the jump; within 50 s)", at != null && at <= 50, `re-armed at +${at} s`);
      }
    }
  }
  {
    // HF5 BACKOFF: a read that always rejects — attempts are >= 5 s apart (≤ 13 in 60 s of 1 Hz fixes), rows stop at 5.
    let reads = 0;
    const r = await walkAfterFailedRead(fresh(false), (k) => { if (k === SPOT_KEY) reads++; return Promise.reject(new Error("storage unavailable")); });
    ok("HF5 a read that never succeeds: fail-closed for 60 s, retried at most every 5 s, at most 5 rows", !!r && r.live.length === 0 && r.latch === false && r.spot == null && r.diskIntact && reads >= 2 && reads <= 13 && r.rows.length === 5,
      JSON.stringify(r && { live: r.live, reads, rows: r.rows.length, spot: r.spot }));
  }
  {
    // ── HF10 · THE WITNESS IS NOT THE PIN (privacy round 11, the lead's reproductions on 8ffdd2ec) ─────────────────────
    // A CarPlay drive ending at SPOT (process A), then a COLD START (process B) with A's disk: Jeff's 09-25 walk shape
    // (1.4, 1.4, 2.8 m/s, 26 km/h, 12 km/h, 1.9 m/s, 12 km/h, 1.4 m/s; 4 s apart). Never live, never the car spot.
    //   HF10a the park is 25 h old (the pin is past SPOT_MAX_AGE_MS: refused, `stale`) — the witness must survive;
    //   HF10a+ control: 23 h — pinned and adopted, as before;
    //   HF10b 10 min later, but the DEVICE clock moved +25 h (the wall-clock age gate calls it stale);
    //   HF10c the process DIED while CarPlay was attached (no disconnect heard: att=1, no hu) — relaunch 5 min later;
    //   HF10d …and a real phone-only drive-away after that relaunch still goes live (it pays the re-arm proof).
    // HF10a-0 / HF10c-0 = 36c17f1e (the witness restored only with the pin) sharing the walk and writing the spot.
    const parkA = async (lpP: Promise<LP | null>, witness: boolean) => {
      const lp = await lpP; if (!lp) return null;
      LOC_V.__store = {}; wallSkew = 0; clock = utc(9, 0, 0);
      await lp.hydrateLocationPrivacy();
      lp.noteCarConnected(true, "carplay");
      let p = north(SPOT, -1200);
      for (let i = 0; i < 60; i++) { clock += S; p = north(SPOT, -1200 + 20 * (i + 1)); lp.noteFix(p.lat, p.lng, 20, 0); }
      for (let i = 0; i < 20; i++) { clock += S; lp.noteFix(SPOT.lat, SPOT.lng, 0, null); }
      if (witness) lp.noteCarConnected(false, "carplay");      // else: the process dies here, attached
      return { ...(LOC_V.__store as Record<string, string>) };
    };
    const coldWalk = async (lpP: Promise<LP | null>, disk: Record<string, string>) => {
      const lp = await lpP; if (!lp) return null;
      LOC_V.__store = { ...disk };
      await lp.hydrateLocationPrivacy();
      const hydrated = { hu: lp.parkEndedByHeadUnit(), spotDrop: lp.privacyDebug().spotDrop, pin: !!lp.carSpot() };
      const seq = [1.4, 1.4, 2.8, kmh(26), kmh(12), 1.9, kmh(12), 1.4];
      let p = north(SPOT, 20); const live: string[] = []; const spotWalker: string[] = [];
      for (const v of seq) {
        clock += 4 * S; p = north(p, 6);
        lp.noteFix(p.lat, p.lng, v, null);
        const sh: any = lp.shareablePosition({ ...p, speed: v, heading: 0 });
        if (sh.share && sh.lat === p.lat && sh.lng === p.lng) live.push(`${(v * 3.6).toFixed(0)}kmh`);
        const sp = lp.carSpot(); if (sp && sp.lat === p.lat) spotWalker.push(`${(v * 3.6).toFixed(0)}kmh`);
      }
      const onDisk = LOC_V.__store[SPOT_KEY] ?? "";
      return { hydrated, live, spotWalker, diskAtSpot: onDisk.includes(String(SPOT.lat)), lp };
    };
    const cases: [string, boolean, () => void][] = [
      ["HF10a a witnessed park 25 h old", true, () => { clock += 25 * 3600 * S; }],
      ["HF10b a witnessed park 10 min old, the device clock moved +25 h", true, () => { clock += 600 * S; wallSkew = 25 * 3600 * S; }],
      ["HF10c the process died while CarPlay was attached (att=1, no hu), relaunch 5 min later", false, () => { clock += 300 * S; }],
    ];
    const base = await lpAt("36c17f1e");
    if (base) {
      for (const [name, witness, gap] of [cases[0], cases[2]]) {
        const disk = await parkA(fresh(), witness); gap();
        const b = await lpAt("36c17f1e");
        const r0 = await coldWalk(Promise.resolve(b!.lp), disk!);
        ok(`${name.slice(0, 5)}-0 NEGATIVE CONTROL (36c17f1e): no witness after the cold start — the walk is shared LIVE and becomes the car spot`, !!r0 && r0.hydrated.hu === false && r0.live.length > 0 && r0.spotWalker.length > 0, JSON.stringify(r0 && { h: r0.hydrated, live: r0.live, spotWalker: r0.spotWalker }));
        rmSync(b!.dir, { recursive: true, force: true }); wallSkew = 0;
      }
      rmSync(base.dir, { recursive: true, force: true });
    } else console.log("  skip HF10a-0 / HF10c-0 negative controls: 36c17f1e unavailable");
    {
      const disk = await parkA(fresh(), true); clock += 23 * 3600 * S;
      const r = await coldWalk(fresh(false), disk!);
      ok("HF10a+ control: a witnessed park 23 h old — witness AND pin restored, the walk never live, never the spot", !!r && r.hydrated.hu && r.hydrated.pin && r.live.length === 0 && r.spotWalker.length === 0, JSON.stringify(r && { h: r.hydrated, live: r.live, spotWalker: r.spotWalker }));
    }
    let hf10c: any = null;
    for (const [name, witness, gap] of cases) {
      const disk = await parkA(fresh(), witness); gap();
      const r = await coldWalk(fresh(false), disk!);
      ok(`${name}: the witness is restored without the pin; the walk is never live and never becomes the car spot`,
        !!r && r.hydrated.hu === true && r.hydrated.pin === false && r.live.length === 0 && r.spotWalker.length === 0 && r.diskAtSpot,
        JSON.stringify(r && { h: r.hydrated, live: r.live, spotWalker: r.spotWalker, diskAtSpot: r.diskAtSpot }));
      if (!witness) hf10c = r;
      wallSkew = 0;
    }
    if (hf10c) {
      // HF10d the same relaunched process, 10 min later: a real drive-away (1 m/s² to 40 km/h), phone only.
      const lp = hf10c.lp as LP; clock += 600 * S; let pos = north(SPOT, 70); let at: number | null = null;
      for (let i = 0; i <= 90 && at == null; i++) { clock += S; const v = Math.min(i * 1.0, 11); pos = north(pos, v); lp.noteFix(pos.lat, pos.lng, v, 0); if (!lp.parkEndedByHeadUnit()) at = i; }
      ok("HF10d after that relaunch a real phone-only drive-away re-arms (the accepted cost: the proof) within 40 s", at != null && at <= 40, `re-armed at +${at} s`);
    }
  }
  {
    // ── KF1 · KNOWN RESIDUAL (CARPLAY.md §6c #10): a paused monotonic clock AND a device-clock rollback inside the same
    // sleep. Lost Android Auto disconnect; the device sleeps 2 h with performance.now() paused and its clock is set back
    // 1 h 59 min 50 s during the sleep: both clocks now say ~10 s passed, and the attachment (asserted 60 s before the
    // sleep) looks alive. JS cannot see this; the fix is native (a boot-time clock that counts sleep). This pins the
    // residual — KF1a flags when it stops reproducing (update the docs) — and KF1b bounds it: the revived attachment
    // ends within its remaining 90 s of counted time.
    const lp = await fresh(); LOC_V.__os = "android"; wallSkew = 0; clock = utc(4, 0, 0);
    lp.noteCarConnected(true, "androidauto");
    let p = north(SPOT, -1200);
    for (let i = 0; i < 60; i++) { clock += S; p = north(p, 20); lp.noteFix(p.lat, p.lng, 20, 0); }
    monoPaused = true; clock += 2 * 3600 * S; wallSkew -= (2 * 3600 - 10) * S; (globalThis as any).performance.now(); monoPaused = false;
    const w = north(p, 40); lp.noteFix(w.lat, w.lng, 1.4, null);
    const sh: any = lp.shareablePosition({ ...w, speed: 1.4, heading: 0 });
    const revived = !!(sh.share && sh.lat === w.lat) && lp.headUnitAttachedNow();
    let endedAfter: number | null = null; let q = w;
    for (let i = 1; i <= 90 && endedAfter == null; i++) { clock += S; q = north(q, 1.4); lp.noteFix(q.lat, q.lng, 1.4, null); if (!lp.headUnitAttachedNow()) endedAfter = i; }
    LOC_V.__os = undefined; wallSkew = 0;
    ok("KF1a KNOWN RESIDUAL #10 still reproduces (paused monotonic + rollback in one sleep revives a lost AA attachment) — if this flips, update CARPLAY.md §6c", revived, JSON.stringify({ revived }));
    ok("KF1b …and the revived attachment ends within its remaining counted 90 s", endedAfter != null && endedAfter <= 30, `ended after ${endedAfter} s of awake walking`);
  }
  {
    // ── CLK · the privacy clock itself (fresh instances of src/privacyClock.ts, so the suite's shared one is untouched) ──
    // CLK1 DRIFT: calls 0.3 ms and 1.7 ms apart (the monotonic clock sub-millisecond, the wall clock in whole ms) must not
    // run the clock fast — summing max(Δmono, Δwall) per call ran 1.70× / 1.12× (CLK1-0 = 36c17f1e's clock).
    // CLK2 a rollback of more than 1 s logs `priv-clock-back`, at most 5 rows per process.
    const perf = (globalThis as any).performance; const harnessPerf = perf.now; const harnessDate = Date.now;
    const drift = async (url: string, stepMs: number, n: number) => {
      const C: any = await import(url);
      let tt = 1_000_000; perf.now = () => tt; Date.now = () => Math.floor(tt);
      const e0 = C.privacyNow(); for (let i = 0; i < n; i++) { tt += stepMs; C.privacyNow(); }
      const ratio = (C.privacyNow() - e0) / (n * stepMs);
      perf.now = harnessPerf; Date.now = harnessDate;
      return ratio;
    };
    const cur = (k: string) => new URL(`privacyClock.ts?clk=${k}${++inst}`, SRC).href;
    const r03 = await drift(cur("a"), 0.3, 20_000), r17 = await drift(cur("b"), 1.7, 5_000), r60 = await drift(cur("c"), 1000 / 60, 3_000);
    let old: string | null = null;
    try { old = execFileSync("git", ["show", "36c17f1e:frontend/src/privacyClock.ts"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
    if (old) {
      const d = mkdtempSync(join(tmpdir(), "privclock-old-")); const f = join(d, "privacyClock.old.ts"); writeFileSync(f, old);
      const o03 = await drift(pathToFileURL(f).href, 0.3, 20_000);
      ok("CLK1-0 NEGATIVE CONTROL (36c17f1e's clock): calls 0.3 ms apart run it fast", o03 >= 1.2, `×${o03.toFixed(3)}`);
      rmSync(d, { recursive: true, force: true });
    } else console.log("  skip CLK1-0 negative control: 36c17f1e unavailable");
    ok("CLK1 the privacy clock does not drift with dense calls (0.3 ms, 1.7 ms, 60 Hz spacing: within 1 %)", Math.abs(r03 - 1) <= 0.01 && Math.abs(r17 - 1) <= 0.01 && Math.abs(r60 - 1) <= 0.01, `×${r03.toFixed(4)} ×${r17.toFixed(4)} ×${r60.toFixed(4)}`);
    {
      const C: any = await import(cur("d"));
      let tt = 5_000_000, wall = 5_000_000; perf.now = () => tt; Date.now = () => wall;
      LOC_V.__rows = [];
      C.privacyNow(); const e0 = C.privacyNow();
      tt += 1000; wall -= 2000; const e1 = C.privacyNow();     // the device clock set back 2 s
      for (let i = 0; i < 9; i++) { tt += 1000; wall -= 5000; C.privacyNow(); }
      tt += 1000; wall -= 500; C.privacyNow();                   // a half-second step back: no penalty, no row
      perf.now = harnessPerf; Date.now = harnessDate;
      const rows = (LOC_V.__rows as string[]).filter((r) => r.startsWith("priv-clock-back"));
      ok("CLK2 a device-clock rollback closes every window (+1 h) and logs `priv-clock-back`, bounded at 5 rows", e1 - e0 >= 3_600_000 && rows.length === 5 && rows[0] === "priv-clock-back by=2s n=1", JSON.stringify({ jump: e1 - e0, rows }));
    }
  }
}

// Round 3 (732c8a6e) as a pair — its locationPrivacy.ts AND its parkRearm.ts — for the negative controls below.
let r3Dir: string | null = null;
try {
  const git = (f: string) => execFileSync("git", ["show", `732c8a6e:frontend/src/${f}`], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const lpSrc = git("locationPrivacy.ts").replace(`from "./parkRearm";`, `from "./parkRearm.r3.ts";`);
  r3Dir = mkdtempSync(join(tmpdir(), "park-rearm-r3pair-"));
  writeFileSync(join(r3Dir, "locationPrivacy.base.ts"), lpSrc); writeFileSync(join(r3Dir, "parkRearm.r3.ts"), git("parkRearm.ts"));
} catch { r3Dir = null; }
const freshR3 = async (): Promise<LP | null> => {
  if (!r3Dir) return null;
  (globalThis as any).__store = {};
  const lp: LP = await import(pathToFileURL(join(r3Dir, "locationPrivacy.base.ts")).href + `?i=${++inst}`);
  await lp.hydrateLocationPrivacy();
  return lp;
};
// Round 4 (8a6fa0aa) as a pair — the slow congestion path and the 2 s claim — for the round-5 negative controls.
let r4Dir: string | null = null;
try {
  const git = (f: string) => execFileSync("git", ["show", `8a6fa0aa:frontend/src/${f}`], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const lpSrc = git("locationPrivacy.ts").replace(`from "./parkRearm";`, `from "./parkRearm.r4.ts";`);
  r4Dir = mkdtempSync(join(tmpdir(), "park-rearm-r4pair-"));
  writeFileSync(join(r4Dir, "locationPrivacy.base.ts"), lpSrc); writeFileSync(join(r4Dir, "parkRearm.r4.ts"), git("parkRearm.ts"));
} catch { r4Dir = null; }
const freshR4 = async (): Promise<LP | null> => {
  if (!r4Dir) return null;
  (globalThis as any).__store = {};
  const lp: LP = await import(pathToFileURL(join(r4Dir, "locationPrivacy.base.ts")).href + `?i=${++inst}`);
  await lp.hydrateLocationPrivacy();
  return lp;
};

// ── X · the review's re-arm attacks (review-priv3/c_logic.mts, walkers.mts), on the real module ────────────────────
{
  const P = (lat: number, lng: number) => ({ lat, lng });
  const REC = [
    { s: 0, p: P(49.173335, -122.666000), v: 9 }, { s: 10.005, p: P(49.173400, -122.665518), v: 16 },
    { s: 20.474, p: P(49.173395, -122.665085), v: 12 }, { s: 31.001, p: P(49.173371, -122.665494), v: 7 },
    { s: 42.543, p: P(49.173307, -122.660864), v: 51 }, { s: 83.321, p: P(49.173307, -122.660870), v: 49 },
  ];
  const dens = (seq: typeof REC, over: (s2: number, v: number) => number) => {
    const out: typeof REC = [];
    for (let i = 0; i + 1 < seq.length; i++) { const a = seq[i], b = seq[i + 1]; for (let s2 = a.s; s2 < b.s; s2 += 1) { const k = (s2 - a.s) / (b.s - a.s); out.push({ s: s2, p: P(a.p.lat + (b.p.lat - a.p.lat) * k, a.p.lng + (b.p.lng - a.p.lng) * k), v: over(s2, a.v + (b.v - a.v) * k) }); } }
    out.push(seq[seq.length - 1]); return out;
  };
  const replay = (lp: LP, seq: { s: number; p: { lat: number; lng: number }; v: number }[], t0: number) => {
    let live: string | null = null;
    for (const f of seq) {
      clock = t0 + Math.round(f.s * S); lp.noteFix(f.p.lat, f.p.lng, kmh(f.v), null);
      const sh: any = lp.shareablePosition({ ...f.p, speed: kmh(f.v), heading: 0 });
      if (!live && sh.share && sh.lat === f.p.lat) live = `+${f.s.toFixed(1)}s`;
    }
    return { live, hu: lp.parkEndedByHeadUnit(), spot: lp.carSpot() };
  };
  for (const N of [14, 31]) {
    // c_logic O3+credit: his 08-29 walk densified, the first N s reading 16 km/h, then 41 s stuck on the multipath point.
    const stuck: typeof REC = [];
    for (let s2 = 42.543; s2 <= 83.321; s2 += 1) stuck.push({ s: s2, p: P(49.173307, -122.660864 - 0.000006 * ((s2 - 42.543) / 40.778)), v: 50 });
    const seq = dens(REC.slice(0, 4), (s2, v) => (s2 < N ? 16 : v)).concat(stuck);
    const run = async (lpP: Promise<LP | null>) => { const lp = await lpP; if (!lp) return null; parkWithCarPlay(lp); return replay(lp, seq, utc(19, 30, 0)); };
    const cur = await run(fresh());
    if (N === 14) {
      const old = await run(freshR3());
      if (old) ok("X0 NEGATIVE CONTROL (round 3 pair): the same 14 s walk + stuck multipath is shared LIVE and moves the spot", old.live != null && old.spot?.lat !== SPOT.lat, JSON.stringify(old));
      else console.log("  skip X0 negative control: 732c8a6e unavailable");
    }
    ok(`X${N} his 08-29 walk reading 16 km/h for ${N} s + 41 s stuck on the multipath point → pinned`, !!cur && cur.live == null && cur.hu === true && cur.spot?.lat === SPOT.lat, JSON.stringify(cur));
  }
  {
    // The two-outlier attacks (walkers.mts A3b/A3c/A4): the gate-O4 car-park loop (60 s at 16 km/h, credit accrues)
    // then TWO consecutive 400 m outliers; out/back/out; a walker with every other fix on a point 335 m away.
    const loop = (t0: number) => { const out: { t: number; p: { lat: number; lng: number }; v: number }[] = []; const v = kmh(16); for (let s2 = 0; s2 <= 60; s2++) { const a = (v * s2) / 20; out.push({ t: t0 + s2 * S, p: { lat: SPOT.lat + (20 * Math.sin(a)) / 111320, lng: SPOT.lng + (20 * (1 - Math.cos(a))) / (111320 * Math.cos((SPOT.lat * Math.PI) / 180)) }, v }); } return out; };
    const far = north(SPOT, 400);
    const cases: [string, (t0: number) => { t: number; p: { lat: number; lng: number }; v: number }[]][] = [
      ["A3b loop + TWO consecutive 400 m outliers", (t0) => { const b = loop(t0); const e = b[b.length - 1].t; return [...b, { t: e + S, p: far, v: kmh(50) }, { t: e + 2 * S, p: north(far, 5), v: kmh(50) }]; }],
      ["A3c loop + out / back / out", (t0) => { const b = loop(t0); const e = b[b.length - 1].t; return [...b, { t: e + S, p: far, v: kmh(50) }, { t: e + 2 * S, p: b[2].p, v: kmh(16) }, { t: e + 3 * S, p: north(far, -4), v: kmh(50) }]; }],
      ["A4 walker, every other fix on a point 335 m away reading 50 km/h", (t0) => { const out = []; const pt = north(SPOT, 335); for (let s2 = 0; s2 < 60; s2++) out.push(s2 % 2 ? { t: t0 + s2 * S, p: pt, v: kmh(50) } : { t: t0 + s2 * S, p: north(SPOT, 30 + 1.4 * s2), v: kmh(5) }); return out; }],
    ];
    for (const [name, mk] of cases) {
      if (name.startsWith("A3b")) {
        const old = await freshR3();
        if (old) {
          parkWithCarPlay(old);
          for (const f of mk(utc(20, 20, 0))) { clock = f.t; old.noteFix(f.p.lat, f.p.lng, f.v, null); }
          ok("X0b NEGATIVE CONTROL (round 3 pair): loop + TWO 400 m outliers clears the witness", old.parkEndedByHeadUnit() === false, `hu=${old.parkEndedByHeadUnit()}`);
        }
      }
      const lp = await fresh(); parkWithCarPlay(lp);
      let live = false;
      for (const f of mk(utc(20, 10, 0))) {
        clock = f.t; lp.noteFix(f.p.lat, f.p.lng, f.v, null);
        const sh: any = lp.shareablePosition({ ...f.p, speed: f.v, heading: 0 });
        const isSpot = f.p.lat === SPOT.lat && f.p.lng === SPOT.lng;   // the loop starts ON the spot
        if (sh.share && sh.lat === f.p.lat && sh.lng === f.p.lng && !isSpot) live = true;
      }
      ok(`X-${name} → pinned`, !live && lp.parkEndedByHeadUnit() === true, `live=${live} hu=${lp.parkEndedByHeadUnit()}`);
    }
  }
}

// ── Z · the review's urban-canyon walker model (review-priv3/canyon_lib.mts, same generator), 10 min per walk ───────
// truth: a straight walk from 30 m north of the spot; drift: OU velocity σv (τ 20 s) pulled back with τ 180 s; 2 m white
// noise; speed = walking + N(0, 1 km/h) with spikes to U(lo, hi) km/h lasting 2–6 s starting with p = 1/every per s.
// Round 3 un-pinned seed 284 of the first variant at +129 s and 500/500 of the third (review-priv3/canyon.out).
function canyonWalk(seed: number, walkMs: number, sigV: number, every: number, lo: number, hi: number) {
  let a = seed >>> 0;
  const u = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t2 = Math.imul(a ^ (a >>> 15), 1 | a); t2 = (t2 + Math.imul(t2 ^ (t2 >>> 7), 61 | t2)) ^ t2; return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296; };
  const gz = () => { let x = 0, y = 0; while (x === 0) x = u(); while (y === 0) y = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * y); };
  const out: { s: number; p: { lat: number; lng: number }; v: number }[] = [];
  let vx = 0, vy = 0, dx = 0, dy = 0; const hdg = u() * 2 * Math.PI; let tx = 0, ty = 30; let spike = 0, spikeV = 0;
  for (let s2 = 0; s2 <= 600; s2++) {
    tx += walkMs * Math.sin(hdg); ty += walkMs * Math.cos(hdg);
    vx += -vx / 20 + sigV * Math.sqrt(2 / 20) * gz(); vy += -vy / 20 + sigV * Math.sqrt(2 / 20) * gz();
    dx += vx - dx / 180; dy += vy - dy / 180;
    const nN = ty + dy + 2 * gz(), eE = tx + dx + 2 * gz();
    const p = { lat: SPOT.lat + (nN / R_EARTH) * (180 / Math.PI), lng: SPOT.lng + (eE / (R_EARTH * Math.cos((SPOT.lat * Math.PI) / 180))) * (180 / Math.PI) };
    let v = Math.max(0, walkMs + kmh(gz()));
    if (spike <= 0 && u() < 1 / every) { spike = 2 + Math.floor(u() * 5); spikeV = kmh(lo + (hi - lo) * u()); }
    if (spike > 0) { v = spikeV; spike--; }
    out.push({ s: s2, p, v });
  }
  return out;
}
{
  const variants: [string, number[], [number, number, number, number, number]][] = [
    ["1.4 m/s, drift σv 1 m/s, spikes 15–40 km/h every ~20 s", [284, ...Array.from({ length: 19 }, (_, i) => i + 1)], [1.4, 1, 20, 15, 40]],
    ["2.0 m/s, no drift, spikes 15–17 km/h every ~10 s", Array.from({ length: 20 }, (_, i) => i + 1), [2.0, 0, 10, 15, 17]],
    ["2.1 m/s, no drift, spikes 15–17 km/h every ~10 s", Array.from({ length: 20 }, (_, i) => i + 1), [2.1, 0, 10, 15, 17]],
  ];
  {
    const old = await freshR3();
    if (old) {
      parkWithCarPlay(old); const t0 = utc(23, 40, 0); let at: number | null = null;
      for (const f of canyonWalk(284, 1.4, 1, 20, 15, 40)) { clock = t0 + f.s * S; old.noteFix(f.p.lat, f.p.lng, f.v, null); if (at == null && !old.parkEndedByHeadUnit()) at = f.s; }
      ok("Z0 NEGATIVE CONTROL (round 3 pair): canyon walker seed 284 un-pins", at != null, `at +${at}s (review-priv3/canyon_lp.out: +129 s)`);
    }
  }
  for (const [name, seeds, prm] of variants) {
    let un = 0; const which: number[] = [];
    for (const seed of seeds) {
      const lp = await fresh(); parkWithCarPlay(lp);
      const t0 = utc(23, 50, 0);
      for (const f of canyonWalk(seed, ...prm)) { clock = t0 + f.s * S; lp.noteFix(f.p.lat, f.p.lng, f.v, null); }
      if (!lp.parkEndedByHeadUnit()) { un++; which.push(seed); }
    }
    ok(`Z canyon walker ${name}: ${seeds.length} walks × 10 min → all pinned`, un === 0, `un-pinned seeds ${which.join(",")}`);
  }
}

// ── Q · slow congestion after a witnessed park STAYS PINNED (round 5: the slow path is removed) ─────────────────────
// The accepted cost (src/parkRearm.ts header, CARPLAY.md §6c): a phone-only drive in traffic averaging under 300 m per
// 2 min keeps the shared position and the driver's own marker at the witnessed park until traffic averages above that
// for ~2 min, or a head unit reconnects. The jam shapes are review-priv3/jam_lp.mts's; 1 Hz fixes while moving.
{
  const jam = async (vpk: number, mv: number, st: number, lpP: Promise<LP | null>, o: { secs?: number; noise?: number; seed?: number; clearAt?: number } = {}) => {
    const lp = await lpP; if (!lp) return undefined; parkWithCarPlay(lp);
    let a = (o.seed ?? 1) >>> 0;
    const u = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t2 = Math.imul(a ^ (a >>> 15), 1 | a); t2 = (t2 + Math.imul(t2 ^ (t2 >>> 7), 61 | t2)) ^ t2; return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296; };
    const gz = () => { let x = 0, y = 0; while (x === 0) x = u(); while (y === 0) y = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * y); };
    const nz = o.noise ?? 0;
    let x = 0; let firstLive: number | null = null;
    for (let s2 = 1; s2 <= (o.secs ?? 1800) && firstLive == null; s2++) {
      let v: number;
      if (o.clearAt != null && s2 > o.clearAt) v = Math.min(kmh(40), (s2 - o.clearAt) * 1.0);   // the jam clears: 1 m/s² to 40 km/h
      else { const c = s2 % (mv + st); v = c < mv ? kmh(vpk) * Math.sin((Math.PI * c) / mv) : 0; }
      x += v; clock = utc(21, 30, 0) + s2 * S;
      if (v > 0.3) {
        const p = north(SPOT, x + nz * gz()); const rv = Math.max(0, v + (nz ? kmh(1) * gz() : 0));
        lp.noteFix(p.lat, p.lng, rv, 0);
        const sh: any = lp.shareablePosition({ ...p, speed: rv, heading: 0 }); if (sh.share && sh.lat === p.lat) firstLive = s2;
      }
    }
    return firstLive;
  };
  const shapes: [string, number, number, number][] = [
    ["jam (20 s rolling to 16 km/h, 30 s standing, 1.13 m/s average)", 16, 20, 30],
    ["jam (15 s rolling to 20 km/h, 25 s standing, 1.32 m/s average)", 20, 15, 25],
    ["queue (10 s rolling to 18 km/h, 40 s standing, 0.63 m/s average)", 18, 10, 40],
  ];
  const old = await jam(16, 20, 30, freshR4());
  if (old !== undefined) ok("Q0 NEGATIVE CONTROL (round 4 pair, 8a6fa0aa): its slow path puts the 16 km/h jam live", old != null, `first live +${old}s`);
  else console.log("  skip Q0 negative control: 8a6fa0aa unavailable");
  for (const [i, [name, vpk, mv, st]] of shapes.entries()) {
    const clean = await jam(vpk, mv, st, fresh());
    const noisy = await jam(vpk, mv, st, fresh(), { noise: 3, seed: 7 + i });
    ok(`Q${i + 1} ${name} stays pinned for 30 min (no noise, and with 3 m noise)`, clean === null && noisy === null, `first live ${clean ?? "never"} / ${noisy ?? "never"}`);
  }
  const cleared = await jam(16, 20, 30, fresh(), { clearAt: 600, noise: 3, seed: 11 });
  ok("Q4 …and when that jam clears after 10 min (1 m/s² to 40 km/h), the drive goes live within 60 s", cleared != null && cleared - 600 <= 60, `live +${cleared != null ? cleared - 600 : "never"} s after it cleared`);
}

// ── WK · the fifth review's walkers, on the real module (review-priv4 walker_cadence / walker_compare / sit_after_walk) ─
// A straight 1.4 m/s walk away from the car for 10 min with the app open; GPS noise OU per axis (σ, τ 30 s at 10 Hz —
// the review's generator), speed 1.4 ± 1 km/h with 1 in 10 delivered fixes reading 15–18 km/h; delivered at 1 Hz, or
// at Lite cadence (8 m filter, >= 1 s). "Pinned" = the witness stands and nothing is ever shared LIVE.
function ouWalk(seed: number, sigma: number, filterM: number, sitAfterM = 0, pSit = 0) {
  let a = seed >>> 0;
  const u = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t2 = Math.imul(a ^ (a >>> 15), 1 | a); t2 = (t2 + Math.imul(t2 ^ (t2 >>> 7), 61 | t2)) ^ t2; return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296; };
  const gz = () => { let x = 0, y = 0; while (x === 0) x = u(); while (y === 0) y = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * y); };
  const out: { s: number; p: { lat: number; lng: number }; v: number }[] = [];
  let nx = 0, ny = 0; let last: { lat: number; lng: number } | null = null, lastT = -99;
  for (let k = 0; k <= 6000; k++) {
    const t = k / 10;
    nx += -nx / 30 + sigma * Math.sqrt(2 / 30) * gz(); ny += -ny / 30 + sigma * Math.sqrt(2 / 30) * gz();
    const along = sitAfterM ? Math.min(30 + 1.4 * t, sitAfterM) : 30 + 1.4 * t;
    const sitting = sitAfterM > 0 && 30 + 1.4 * t >= sitAfterM;
    const p0 = north(SPOT, along + ny);
    const p = { lat: p0.lat, lng: p0.lng + (nx / (R_EARTH * Math.cos((SPOT.lat * Math.PI) / 180))) * (180 / Math.PI) };
    if (t - lastT < 1 - 1e-9 || (last && metres(last, p) < filterM)) continue;
    const spike = u() < (sitting ? pSit : 0.1);
    out.push({ s: t, p, v: spike ? kmh(15 + 3 * u()) : Math.max(0, (sitting ? 0 : 1.4) + kmh(gz())) });
    last = p; lastT = t;
  }
  return out;
}
{
  const walkLive = async (lpP: Promise<LP | null>, fixes: ReturnType<typeof ouWalk>) => {
    const lp = await lpP; if (!lp) return undefined; parkWithCarPlay(lp);
    const t0 = utc(18, 0, 0); let live: number | null = null;
    for (const f of fixes) {
      clock = t0 + Math.round(f.s * S); lp.noteFix(f.p.lat, f.p.lng, f.v, null);
      const sh: any = lp.shareablePosition({ ...f.p, speed: f.v, heading: 0 });
      if (live == null && sh.share && sh.lat === f.p.lat && sh.lng === f.p.lng) live = f.s;
    }
    return { live, hu: lp.parkEndedByHeadUnit() };
  };
  const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
  const sets: [string, (seed: number) => ReturnType<typeof ouWalk>][] = [
    ["1 Hz, σ 8 m", (sd) => ouWalk(sd, 8, 0)],
    ["1 Hz, σ 12 m", (sd) => ouWalk(sd, 12, 0)],
    ["Lite (8 m filter), σ 8 m", (sd) => ouWalk(sd, 8, 8)],
    ["Lite (8 m filter), σ 12 m", (sd) => ouWalk(sd, 12, 8)],
    ["1 Hz, σ 12 m, walk 350 m then SIT (1 in 20 sitting fixes read 15–18 km/h)", (sd) => ouWalk(sd, 12, 0, 350, 0.05)],
  ];
  for (const [i, [name, gen]] of sets.entries()) {
    let un = 0, un4 = 0; const which: number[] = [];
    for (const sd of SEEDS) {
      const fx = gen(sd);
      const cur = await walkLive(fresh(), fx);
      if (!cur || cur.live != null || cur.hu !== true) { un++; which.push(sd); }
      if (i === 0 || i === 3) { const o = await walkLive(freshR4(), fx); if (o && (o.live != null || o.hu !== true)) un4++; }
    }
    if (i === 0 || i === 3) {
      if (r4Dir) ok(`WK0 NEGATIVE CONTROL (round 4 pair, 8a6fa0aa): walker ${name} un-pins on some of the same ${SEEDS.length} walks`, un4 > 0, `${un4}/${SEEDS.length} un-pinned`);
      else console.log("  skip WK0 negative control: 8a6fa0aa unavailable");
    }
    ok(`WK${i + 1} walker ${name}: ${SEEDS.length} walks × 10 min → all pinned, nothing shared live`, un === 0, `un-pinned seeds ${which.join(",") || "none"}`);
  }
  // WK6 an airport concourse (review-priv4/attacks.mts A): walking 1.4 m/s, on moving walkways at 2.15 m/s for 60 s of
  // every 90 s — at the phone watcher's 2 m / 500 ms cadence, σ 8 m, 1 in 10 fixes reading 15–18 km/h.
  const walkway = (seed: number) => {
    let a = seed >>> 0;
    const u = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t2 = Math.imul(a ^ (a >>> 15), 1 | a); t2 = (t2 + Math.imul(t2 ^ (t2 >>> 7), 61 | t2)) ^ t2; return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296; };
    const gz = () => { let x = 0, y = 0; while (x === 0) x = u(); while (y === 0) y = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * y); };
    const out: { s: number; p: { lat: number; lng: number }; v: number }[] = [];
    let x = 30, nx = 0, ny = 0; let last: { lat: number; lng: number } | null = null, lastT = -99;
    for (let k = 0; k <= 6000; k++) {
      const t = k / 10; const v = (t % 90) < 60 ? 2.15 : 1.4; x += v * 0.1;
      nx += -nx / 30 + 8 * Math.sqrt(2 / 30) * gz(); ny += -ny / 30 + 8 * Math.sqrt(2 / 30) * gz();
      const p0 = north(SPOT, x + ny);
      const p = { lat: p0.lat, lng: p0.lng + (nx / (R_EARTH * Math.cos((SPOT.lat * Math.PI) / 180))) * (180 / Math.PI) };
      if (t - lastT < 0.5 - 1e-9 || (last && metres(last, p) < 2)) continue;
      out.push({ s: t, p, v: u() < 0.1 ? kmh(15 + 3 * u()) : Math.max(0, v + kmh(gz())) }); last = p; lastT = t;
    }
    return out;
  };
  const W_SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
  let unW = 0; const whichW: number[] = [];
  for (const sd of W_SEEDS) { const r = await walkLive(fresh(), walkway(sd)); if (!r || r.live != null || r.hu !== true) { unW++; whichW.push(sd); } }
  if (r4Dir) {
    let un4 = 0;
    for (const sd of W_SEEDS) { const r = await walkLive(freshR4(), walkway(sd)); if (r && (r.live != null || r.hu !== true)) un4++; }
    ok("WK6-0 NEGATIVE CONTROL (round 4 pair, 8a6fa0aa): the concourse walker un-pins on some of the same walks", un4 > 0, `${un4}/${W_SEEDS.length} un-pinned`);
  } else console.log("  skip WK6-0 negative control: 8a6fa0aa unavailable");
  ok(`WK6 moving-walkway concourse (2 m / 500 ms cadence, σ 8 m, 1 in 10 fast readings): ${W_SEEDS.length} walks × 10 min → all pinned`, unW === 0, `un-pinned seeds ${whichW.join(",") || "none"}`);
}

if (baseFile) rmSync(join(baseFile, ".."), { recursive: true, force: true });
if (r3Dir) rmSync(r3Dir, { recursive: true, force: true });
if (r4Dir) rmSync(r4Dir, { recursive: true, force: true });
if (fails) { console.log(`FAIL park_rearm (${fails})`); process.exit(1); }
console.log("PASS park_rearm");
