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
//   R  a real drive-away after a witnessed park → re-arms 15–20 s after the run starts and >= 150 m from it, live after.
//   L  a red light mid re-arm → the run starts over.
//   G  a gap with no fixes → the run starts over.
//   C  a CarPlay reconnect → the witness clears at once; the first vehicular fix is live (unchanged).
//   U  no witnessed park → identical outputs to the pre-fix module, fix by fix (the "byte-for-byte" claim).
//   H  a witness restored from disk (hydrate, hu=1) is protected the same way; H2 with a driving stamp < 90 s old
//      too (no latch is restored over a witness — negative control on the pre-fix module); H3 without a witness the
//      restore is unchanged.
//   W  the drive's latch still inside its 90 s window at the disconnect: a 12 km/h and a 26 km/h fix share the car
//      spot (the witness drops the latch); NEGATIVE CONTROL on the pre-fix module shares them LIVE.
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = new URL("../../src/", import.meta.url);
const js = (body: string) => "data:text/javascript," + encodeURIComponent(body);
const EMPTY = js(`const f = () => {}; export const Platform = { OS: "ios", select: (o) => o.ios ?? o.default };
  export const useEffect = f, useState = (v) => [v, f], useRef = (v) => ({ current: v }), useCallback = (x) => x;`);
// AsyncStorage reads come from globalThis.__store (scenario H); writes are recorded there too.
const STORAGE = js(`const S = () => (globalThis.__store ??= {});
  export default { getItem: (k) => Promise.resolve(S()[k] ?? null), setItem: (k, v) => { S()[k] = v; return Promise.resolve(); },
    removeItem: (k) => { delete S()[k]; return Promise.resolve(); }, multiRemove: () => Promise.resolve() };`);
registerHooks({
  resolve(s: string, c: any, n: any) {
    if (s === "@react-native-async-storage/async-storage") return { url: STORAGE, shortCircuit: true };
    if (s === "react" || s === "react-native" || s.startsWith("expo-")) return { url: EMPTY, shortCircuit: true };
    // The pre-fix copy lives in a temp dir: its relative imports are the worktree's modules.
    if (s.startsWith(".") && /locationPrivacy\.base\.ts(\?.*)?$/.test(c.parentURL ?? "")) return { url: new URL(`${s.slice(2)}.ts`, SRC).href, shortCircuit: true };
    if (s.startsWith(".") && !/\.[a-z]+$/i.test(s)) { try { return n(s + ".ts", c); } catch {} }
    return n(s, c);
  },
});

let clock = 0;
Date.now = () => clock;
const utc = (h: number, m: number, s: number, ms = 0) => Date.UTC(2026, 8, 25, h, m, s, ms);
const S = 1000;

type LP = typeof import("../../src/locationPrivacy.ts");
let inst = 0;
const fresh = async (): Promise<LP> => { (globalThis as any).__store = {}; return import(new URL(`locationPrivacy.ts?i=${++inst}`, SRC).href); };
let baseSrc: string | null = null;
try { baseSrc = execFileSync("git", ["show", "c97a1580:frontend/src/locationPrivacy.ts"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
let baseFile: string | null = null;
if (baseSrc) { const d = mkdtempSync(join(tmpdir(), "park-rearm-base-")); baseFile = join(d, "locationPrivacy.base.ts"); writeFileSync(baseFile, baseSrc); }
const freshBase = async (): Promise<LP | null> => { if (!baseFile) return null; (globalThis as any).__store = {}; return import(pathToFileURL(baseFile).href + `?i=${++inst}`); };

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

// ── geometry ─────────────────────────────────────────────────────────────────────────────────────────────────────
const SPOT = { lat: 49.172938, lng: -122.666060 };     // 17:12:34.136 mode=pin raw= (the car spot)
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

// ── R · a real drive-away after a witnessed park ────────────────────────────────────────────────────────────────
{
  const lp = await fresh();
  parkWithCarPlay(lp);
  const T = utc(17, 30, 0);                       // 20 min later, no CarPlay this time (phone in the mount)
  let pos = SPOT; let v = 0; let runStart: { t: number; p: { lat: number; lng: number } } | null = null;
  let armed: { t: number; dt: number; d: number } | null = null; let earlyArm = false;
  for (let i = 0; i <= 40 && !armed; i++) {
    clock = T + i * S;
    v = Math.min(i * 1.0, 11);                    // 1 m/s² from rest to 40 km/h
    pos = north(pos, v);                           // metres covered in the last second ≈ current speed
    lp.noteFix(pos.lat, pos.lng, v, 0);
    if (!runStart && v >= kmh(15)) runStart = { t: clock, p: pos };
    if (lp.privacyDebug().latch) {
      armed = { t: clock, dt: runStart ? (clock - runStart.t) / S : -1, d: runStart ? metres(runStart.p, pos) : -1 };
      if (armed.dt < 15 || armed.d < 150) earlyArm = true;
    }
  }
  ok("R1 not re-armed before 15 s and 150 m of vehicular run", !!armed && !earlyArm, JSON.stringify(armed));
  ok("R2 re-armed within 20 s of the run's first ≥ 15 km/h fix", !!armed && armed.dt <= 20, JSON.stringify(armed));
  ok("R3 the witnessed park is cleared by the re-arm", lp.parkEndedByHeadUnit() === false);
  clock += S; pos = north(pos, 11); lp.noteFix(pos.lat, pos.lng, 11, 0);
  const sh = lp.shareablePosition({ ...pos, speed: 11, heading: 0 });
  ok("R4 …and the next fix is shared LIVE and recorded as the car spot", sh.share === true && (sh as any).lat === pos.lat && lp.carSpot()?.lat === pos.lat, JSON.stringify(sh));
}

// ── L · a red light in the middle of the re-arm ─────────────────────────────────────────────────────────────────
{
  const lp = await fresh();
  parkWithCarPlay(lp);
  let t = utc(17, 40, 0); let pos = SPOT;
  const step = (v: number) => { t += S; clock = t; pos = north(pos, v); lp.noteFix(pos.lat, pos.lng, v, 0); };
  for (let i = 0; i < 12; i++) step(10);          // 12 s at 36 km/h: a run of 110 m
  for (let i = 0; i < 3; i++) step(0);            // red light: below 9 km/h → the run starts over
  const resumeAt = t + S;
  let armedDt: number | null = null;
  for (let i = 0; i < 25 && armedDt == null; i++) { step(10); if (lp.privacyDebug().latch) armedDt = (t - resumeAt) / S; }
  ok("L1 the stop reset the run: not armed at resume + 10 s (though 22 s / 220 m of vehicular driving in total)", armedDt != null && armedDt >= 15, `armed ${armedDt} s after resuming`);
  ok("L2 …armed once the NEW run held 15 s and 150 m", armedDt != null && armedDt <= 16, `armed ${armedDt} s after resuming`);
}

// ── G · a gap with no fixes ─────────────────────────────────────────────────────────────────────────────────────
{
  const lp = await fresh();
  parkWithCarPlay(lp);
  let t = utc(17, 50, 0); let pos = SPOT;
  for (let i = 0; i < 10; i++) { t += S; clock = t; pos = north(pos, 10); lp.noteFix(pos.lat, pos.lng, 10, 0); }
  t += 60 * S; clock = t; pos = north(pos, 700); lp.noteFix(pos.lat, pos.lng, 10, 0);   // 60 s later, 700 m on
  ok("G1 a 60 s gap is not 'held': one fix 700 m away does not re-arm", lp.privacyDebug().latch === false && lp.parkEndedByHeadUnit() === true);
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
  const lp = await fresh();
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
  const base = await freshBase();
  if (base) {
    clock = utc(21, 0, 0); seed();
    await base.hydrateLocationPrivacy();
    const sh = base.shareablePosition({ ...walkP, speed: kmh(12), heading: 0 });
    ok("H2a NEGATIVE CONTROL (pre-fix): witnessed spot + restored latch → a 12 km/h fix is shared LIVE", base.parkEndedByHeadUnit() && base.privacyDebug().latch && sh.share === true && (sh as any).lat === walkP.lat, JSON.stringify(sh));
  } else console.log("  skip H2a negative control: pre-fix module unavailable");
  const lp = await fresh();
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
  const lp = await fresh();
  clock = utc(22, 0, 0);
  (globalThis as any).__store = { "convoy.lastDrivingAt.v1": String(clock - 30 * S) };
  await lp.hydrateLocationPrivacy();
  ok("H3 no witness: a driving stamp < 90 s old still restores the latch", lp.privacyDebug().latch === true);
}

if (baseFile) rmSync(join(baseFile, ".."), { recursive: true, force: true });
if (fails) { console.log(`FAIL park_rearm (${fails})`); process.exit(1); }
console.log("PASS park_rearm");
