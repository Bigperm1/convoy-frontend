// car_feed_leak_test — once CarPlay / Android Auto disconnects, no car GPS watch may survive (privacy, 2026-09-25).
//
//   node --experimental-strip-types tools/sim-qc/car_feed_leak_test.mts
//
// Jeff, 2026-09-25: "i think the connection is following me after the carplay dissconnect. it should not follow me
// when i discconect from car play... this is a privacy concern. fix it and lock it."
// MEASURED (crash_reports): two `nav-loc src=car` rows in the same second at every one of his CarPlay connects
// (09-22 09:10:06 … 09-25 09:19:14.987 + .025); a car-watch callback (`loc-src feed=fg`) after `loc-bgsess op=stop`
// on every disconnect checked; fresh car fixes for up to 2 h 09 afterwards, raw walking coordinates in
// `draw-cmp surf=car gps=…`. The start guard ran BEFORE the await and the assignment AFTER it
// (`if (_fgCarWatch) return; … _fgCarWatch = await Location.watchPositionAsync(…)`), so two concurrent starts made
// two native watchers and the stop could reach only one. src/carFeedOwner.ts is now the only creator.
//
// The 'native' here is a fake with expo-location 19.0.8's JS semantics, READ from
// node_modules/expo-location/build/Location.js + LocationSubscribers.js: the callback is registered BEFORE the native
// start resolves (so a fix can arrive first), remove() unregisters it synchronously, and a second remove() is a no-op.
// Every promise is deferred, so the test decides the interleaving.
//   A  two concurrent starts → ONE native watch. NEGATIVE CONTROL: today's guard-before-await shape → TWO, and a stop
//      leaves one running (proves this test sees the bug).
//   B  a stop while a start is in flight → 0 live once it resolves and settles; never removed before the settle
//      (the native-race rule in the owner's header), and never reaches onFix.
//   C  a delivery after the release → self-stops, onFix never called.
//   D  a stop with ZERO deliveries → 0 live (a phone lying still gets no callbacks).
//   E  5 connect/disconnect cycles → exactly 1 native start per connect, 0 live after each disconnect.
//   F  static: navNotification.ts's only watchPositionAsync( is inside the owner; the disconnect paths release the lock
//      (CarPlay onDisconnect; Android Auto disconnect AND unmount); map.tsx's phone watcher is cancellation-safe and
//      re-runs when nav ends; no `= await Location.watchPositionAsync(` anywhere in src/ or app/.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createCarFeedOwner, removeWhenSettled, CAR_FEED_SETTLE_MS, type WatchSub } from "../../src/carFeedOwner.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

// ── the clock and the timers are ours ────────────────────────────────────────────────────────────────────────────
let clock = 1_000_000;
let timers: { at: number; fn: () => void }[] = [];
const later = (fn: () => void, ms: number) => { timers.push({ at: clock + ms, fn }); };
function advance(ms: number): void {
  const end = clock + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers[0];
    if (!t || t.at > end) break;
    timers.shift(); clock = t.at; t.fn();
  }
  clock = end;
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

// ── fake native, expo semantics ──────────────────────────────────────────────────────────────────────────────────
type Loc = { n: number };
class FakeSub implements WatchSub {
  removed = false; removeCalls = 0;
  id: number; cb: (l: Loc) => void;
  constructor(id: number, cb: (l: Loc) => void) { this.id = id; this.cb = cb; }
  remove() { this.removeCalls++; if (this.removed) return; this.removed = true; }   // unregisterCallback: idempotent
}
class FakeNative {
  created: FakeSub[] = [];
  private waiting: { sub: FakeSub; resolve: (s: FakeSub) => void }[] = [];
  watch(cb: (l: Loc) => void): Promise<FakeSub> {
    const sub = new FakeSub(this.created.length + 1, cb);   // callback registered FIRST, like expo
    this.created.push(sub);
    return new Promise((resolve) => this.waiting.push({ sub, resolve }));
  }
  resolveAll() { const w = this.waiting; this.waiting = []; for (const x of w) x.resolve(x.sub); }
  live() { return this.created.filter((s) => !s.removed).length; }
  deliver(n: number) { for (const s of this.created) if (!s.removed) s.cb({ n }); }   // native events reach registered callbacks only
}

// A permission read in front of the watch, as startForegroundCarFeed has (getForegroundPermissionsAsync).
function makePerm() {
  let waiting: (() => void)[] = [];
  return {
    read: () => new Promise<{ granted: boolean }>((r) => waiting.push(() => r({ granted: true }))),
    grantAll: () => { const w = waiting; waiting = []; for (const f of w) f(); },
  };
}

function makeOwner(native: FakeNative, perm: ReturnType<typeof makePerm>, consumers: Set<string>) {
  const fixes: number[] = [];
  const rows: string[] = [];
  const owner = createCarFeedOwner<Loc, FakeSub>({
    wanted: () => consumers.size > 0,
    watch: async (onLoc) => {
      const fg = await perm.read();
      if (!fg.granted) return null;
      return native.watch(onLoc);
    },
    onFix: (l) => fixes.push(l.n),
    log: (r) => rows.push(r),
    now: () => clock,
    later,
  });
  return { owner, fixes, rows };
}

// ── A · two concurrent starts ────────────────────────────────────────────────────────────────────────────────────
{
  // NEGATIVE CONTROL: navNotification.startForegroundCarFeed as it was at c97a1580 — guard before the awaits,
  // assignment after them.
  const native = new FakeNative(); const perm = makePerm();
  let _fgCarWatch: FakeSub | null = null;
  const legacyStart = async () => {
    if (_fgCarWatch) return;
    const fg = await perm.read();
    if (!fg.granted) return;
    _fgCarWatch = await native.watch(() => {});
  };
  const legacyStop = () => { try { _fgCarWatch?.remove(); } catch {} _fgCarWatch = null; };
  const a = legacyStart(), b = legacyStart();   // carPlayBootstrap.onConnect: acquireBgLocation('carplay') + the direct call
  perm.grantAll(); await flush(); native.resolveAll(); await Promise.all([a, b]);
  ok("A0 NEGATIVE CONTROL: today's guard-before-await → 2 native watches from one connect", native.live() === 2, `live=${native.live()}`);
  legacyStop();
  ok("A0b NEGATIVE CONTROL: today's stop reaches one — an orphan keeps running", native.live() === 1, `live=${native.live()}`);
}
{
  const native = new FakeNative(); const perm = makePerm(); const consumers = new Set(["carplay"]);
  const { owner, fixes, rows } = makeOwner(native, perm, consumers);
  const a = owner.start(), b = owner.start();
  perm.grantAll(); await flush(); native.resolveAll(); await Promise.all([a, b]);
  ok("A1 owner: two concurrent starts → 1 native watch", native.created.length === 1 && native.live() === 1 && owner.live() === 1, `created=${native.created.length} live=${native.live()} owner=${owner.live()}`);
  await owner.start();
  ok("A2 a start while live is a no-op", native.created.length === 1);
  native.deliver(7);
  ok("A3 the one watch feeds onFix exactly once per fix", fixes.length === 1 && fixes[0] === 7, JSON.stringify(fixes));
  ok("A4 the join is on the record (`carfeed op=join`)", rows.includes("carfeed op=join"), JSON.stringify(rows));
}

// ── B · a stop while the start is in flight ─────────────────────────────────────────────────────────────────────
{
  const native = new FakeNative(); const perm = makePerm(); const consumers = new Set(["carplay"]);
  const { owner, fixes, rows } = makeOwner(native, perm, consumers);
  const p = owner.start();
  perm.grantAll(); await flush();                         // the native start is now in flight
  consumers.delete("carplay"); owner.stop();              // releaseBgLocation('carplay') lands mid-start
  native.resolveAll(); await p;
  ok("B1 raced start is logged (`carfeed op=raced why=stopped`)", rows.some((r) => r.startsWith("carfeed op=raced why=stopped")), JSON.stringify(rows));
  ok("B2 not removed before the native start has settled (the zombie-race rule)", native.created[0].removeCalls === 0, `removeCalls=${native.created[0].removeCalls}`);
  native.deliver(1);                                      // a fix inside the settle window…
  ok("B3 …never reaches onFix, and removes the watch at once (a delivery proves the stream is up)", fixes.length === 0 && native.live() === 0, `fixes=${fixes.length} live=${native.live()}`);
  advance(CAR_FEED_SETTLE_MS);
  ok("B4 0 live after resolve + settle", native.live() === 0 && owner.live() === 0, `native=${native.live()} owner=${owner.live()}`);
}
{
  // Same, with NO delivery: the settle timer alone removes it.
  const native = new FakeNative(); const perm = makePerm(); const consumers = new Set(["carplay"]);
  const { owner, fixes } = makeOwner(native, perm, consumers);
  const p = owner.start();
  perm.grantAll(); await flush();
  consumers.delete("carplay"); owner.stop();
  native.resolveAll(); await p;
  advance(CAR_FEED_SETTLE_MS - 1);
  ok("B5 still settling 1 ms before the settle", native.live() === 1);
  advance(1);
  ok("B6 removed by the settle timer, no delivery needed", native.live() === 0 && owner.live() === 0 && fixes.length === 0, `native=${native.live()}`);
}
{
  // Stop BEFORE the permission read even resolved: the start must not create a watch it cannot keep… it may create
  // one (the owner does not know yet), but it must not survive.
  const native = new FakeNative(); const perm = makePerm(); const consumers = new Set(["carplay"]);
  const { owner } = makeOwner(native, perm, consumers);
  const p = owner.start();
  consumers.delete("carplay"); owner.stop();
  perm.grantAll(); await flush(); native.resolveAll(); await p; advance(CAR_FEED_SETTLE_MS);
  ok("B7 stop before the permission read → 0 live after settle", native.live() === 0 && owner.live() === 0, `native=${native.live()}`);
}

// ── C · a delivery after the release ─────────────────────────────────────────────────────────────────────────────
{
  const native = new FakeNative(); const perm = makePerm(); const consumers = new Set(["carplay"]);
  const { owner, fixes, rows } = makeOwner(native, perm, consumers);
  const p = owner.start(); perm.grantAll(); await flush(); native.resolveAll(); await p;
  advance(60_000);
  native.deliver(1);
  ok("C0 a wanted fix reaches onFix", fixes.length === 1);
  consumers.delete("carplay");                            // the lock emptied but nothing called stop (any leak shape)
  native.deliver(2);
  ok("C1 a delivery with no consumer → onFix NOT called", fixes.length === 1, JSON.stringify(fixes));
  ok("C2 …and the watch removed itself", native.live() === 0 && owner.live() === 0, `native=${native.live()}`);
  ok("C3 …on the record (`carfeed op=self-stop why=unwanted`)", rows.some((r) => r.startsWith("carfeed op=self-stop why=unwanted")), JSON.stringify(rows));
  native.deliver(3);
  ok("C4 nothing more is delivered", fixes.length === 1);
}
{
  // A fix delivered BEFORE the native start resolved (expo registers the callback first), after a stop.
  const native = new FakeNative(); const perm = makePerm(); const consumers = new Set(["carplay"]);
  const { owner, fixes } = makeOwner(native, perm, consumers);
  const p = owner.start(); perm.grantAll(); await flush();
  consumers.delete("carplay"); owner.stop();
  native.deliver(9);                                      // arrives before resolve
  native.resolveAll(); await p; advance(CAR_FEED_SETTLE_MS);
  ok("C5 a pre-resolve fix after a stop never reaches onFix", fixes.length === 0 && native.live() === 0, `fixes=${fixes.length} live=${native.live()}`);
}

// ── D · stop with ZERO deliveries ────────────────────────────────────────────────────────────────────────────────
{
  const native = new FakeNative(); const perm = makePerm(); const consumers = new Set(["carplay"]);
  const { owner } = makeOwner(native, perm, consumers);
  const p = owner.start(); perm.grantAll(); await flush(); native.resolveAll(); await p;
  advance(45 * 60_000);                                   // a 45-minute drive
  consumers.delete("carplay"); owner.stop();              // the car turns off; the phone lies still → no callbacks
  ok("D1 stop with zero deliveries → 0 live at once", native.live() === 0 && owner.live() === 0, `native=${native.live()} owner=${owner.live()}`);
}
{
  // A young watch (stopped inside its settle) with frozen JS timers: the next start/stop still sweeps it.
  const native = new FakeNative(); const perm = makePerm(); const consumers = new Set(["carplay"]);
  const { owner } = makeOwner(native, perm, consumers);
  const p = owner.start(); perm.grantAll(); await flush(); native.resolveAll(); await p;
  consumers.delete("carplay"); owner.stop();
  timers = [];                                            // iOS froze the timers (CARPLAY.md rule 7b)
  clock += CAR_FEED_SETTLE_MS;
  ok("D2 frozen timer: still held until the next owner call", native.live() === 1);
  owner.stop();
  ok("D3 …which removes it (sweep), still with zero deliveries", native.live() === 0 && owner.live() === 0, `native=${native.live()}`);
}

// ── E · five connect / disconnect cycles ─────────────────────────────────────────────────────────────────────────
{
  const native = new FakeNative(); const perm = makePerm(); const consumers = new Set<string>();
  const { owner, fixes } = makeOwner(native, perm, consumers);
  let allOk = true; const detail: string[] = [];
  for (let i = 1; i <= 5; i++) {
    consumers.add("carplay");                             // acquireBgLocation('carplay') adds the tag synchronously…
    const a = owner.start(), b = owner.start();           // …then both connect-time starts run at once
    perm.grantAll(); await flush(); native.resolveAll(); await Promise.all([a, b]);
    const up = native.live();
    advance(20 * 60_000); native.deliver(100 + i);        // a drive
    consumers.delete("carplay"); owner.stop();            // carplay-disconnect → releaseBgLocation('carplay')
    advance(CAR_FEED_SETTLE_MS);
    const cOk = up === 1 && native.created.length === i && native.live() === 0 && owner.live() === 0;
    if (!cOk) allOk = false;
    detail.push(`#${i}:up=${up},made=${native.created.length},after=${native.live()}`);
  }
  ok("E1 5 cycles: 1 native start per connect, 0 live after every disconnect", allOk, detail.join(" "));
  ok("E2 every drive's fix reached onFix once", JSON.stringify(fixes) === JSON.stringify([101, 102, 103, 104, 105]), JSON.stringify(fixes));
}

// ── removeWhenSettled (map.tsx's phone watcher) ──────────────────────────────────────────────────────────────────
{
  const s1 = new FakeSub(1, () => {});
  removeWhenSettled(s1, clock, () => clock, later);
  ok("R1 a just-resolved watch is not removed at once", s1.removeCalls === 0);
  advance(CAR_FEED_SETTLE_MS);
  ok("R2 …it is removed once settled", s1.removed);
  const s2 = new FakeSub(2, () => {});
  removeWhenSettled(s2, clock - CAR_FEED_SETTLE_MS, () => clock, later);
  ok("R3 an already-settled watch is removed at once", s2.removed);
}

// ── F · static: the single creation path and the release paths ───────────────────────────────────────────────────
// CAR_FEED_ROOT=<dir with src/ and app/> runs the static half against another tree (e.g. the pre-fix commit exported
// with `git archive`, which must FAIL F1–F18 — the mutation check that the static half is not vacuous).
const ROOT = process.env.CAR_FEED_ROOT ? new URL(`file://${process.env.CAR_FEED_ROOT.replace(/\/?$/, "/")}`) : new URL("../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");
// Comments → spaces, newlines and offsets kept (the same rule as scripts/trap-check.py blank_comments).
function blank(src: string): string {
  let out = ""; let i = 0; let inS: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (inS) { out += c; if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; } if (c === inS) inS = null; i++; continue; }
    if (c === "'" || c === '"' || c === "`") { inS = c; out += c; i++; continue; }
    if (src.startsWith("//", i)) { const j = src.indexOf("\n", i); const e = j < 0 ? src.length : j; out += " ".repeat(e - i); i = e; continue; }
    if (src.startsWith("/*", i)) { const j = src.indexOf("*/", i + 2); const e = j < 0 ? src.length : j + 2; out += src.slice(i, e).replace(/[^\n]/g, " "); i = e; continue; }
    out += c; i++;
  }
  return out;
}
// Index of the bracket that closes the one at `open` (strings skipped).
function closeOf(src: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = []; let inS: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inS) { if (c === "\\") { i++; continue; } if (c === inS) inS = null; continue; }
    if (c === "'" || c === '"' || c === "`") { inS = c; continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "}" || c === "]") { if (stack.pop() !== c) return -1; if (stack.length === 0) return i; }
  }
  return -1;
}
const count = (s: string, needle: string) => s.split(needle).length - 1;
function bodyAfter(src: string, marker: string, from = 0): string | null {
  const at = src.indexOf(marker, from);
  if (at < 0) return null;
  const open = at + marker.length - 1;                    // marker ends with its opening bracket
  const close = closeOf(src, open);
  return close < 0 ? null : src.slice(open, close + 1);
}

{
  const nav = blank(read("src/navNotification.ts"));
  ok("F1 navNotification.ts: exactly one watchPositionAsync(", count(nav, "watchPositionAsync(") === 1, `n=${count(nav, "watchPositionAsync(")}`);
  const ownerCall = bodyAfter(nav, "createCarFeedOwner<Location.LocationObject, CarWatch>(");
  ok("F2 …and it is inside the createCarFeedOwner(…) call (the owner's watch dep)", !!ownerCall && count(ownerCall, "watchPositionAsync(") === 1);
  const startFn = bodyAfter(nav, "export async function startForegroundCarFeed(): Promise<void> {");
  ok("F3 startForegroundCarFeed goes through the owner", !!startFn && /_carFeed\.start\(\)/.test(startFn) && !/watchPositionAsync/.test(startFn));
  const stopFn = bodyAfter(nav, "function stopForegroundCarFeed(): void {");
  ok("F4 stopForegroundCarFeed stops the owner", !!stopFn && /_carFeed\.stop\(\)/.test(stopFn));
  const rel = bodyAfter(nav, "export async function releaseBgLocation(tag: string): Promise<void> {");
  ok("F5 releaseBgLocation stops the car feed and logs `loc-release`", !!rel && /stopForegroundCarFeed\(\)/.test(rel) && /loc-release tag=/.test(rel));
  ok("F6 the owner's wanted() is the lock's consumer set", !!ownerCall && /wanted:\s*\(\)\s*=>\s*_locConsumers\.size\s*>\s*0/.test(ownerCall));

  const cp = blank(read("src/carplay/carPlayBootstrap.ts"));
  const cpDis = bodyAfter(cp, "const onDisconnect = () => {");
  ok("F7 carPlayBootstrap onDisconnect → releaseBgLocation('carplay')", !!cpDis && cpDis.includes("releaseBgLocation('carplay')"));
  ok("F8 carPlayBootstrap onDisconnect → setCarSurfaceLive('carplay', false)", !!cpDis && cpDis.includes("setCarSurfaceLive('carplay', false)"));

  const aa = blank(read("src/carplay/AndroidAutoRoot.tsx"));
  const aaDis = bodyAfter(aa, "const onDisconnect = () => {");
  ok("F9 AndroidAutoRoot disconnect → releaseBgLocation('androidauto')", !!aaDis && aaDis.includes("releaseBgLocation('androidauto')") && aaDis.includes("setCarSurfaceLive('androidauto', false)"));
  const acq = aa.indexOf("acquireBgLocation('androidauto')");
  const effAt = acq < 0 ? -1 : aa.lastIndexOf("useEffect(", acq);
  const mountEff = effAt < 0 ? null : bodyAfter(aa, "useEffect(", effAt);
  const unmount = mountEff ? bodyAfter(mountEff, "return () => {") : null;
  ok("F10 AndroidAutoRoot unmount → releaseBgLocation('androidauto')", !!unmount && unmount.includes("releaseBgLocation('androidauto')") && unmount.includes("setCarSurfaceLive('androidauto', false)"));

  const map = blank(read("app/(app)/map.tsx"));
  ok("F11 map.tsx: exactly one watchPositionAsync(", count(map, "watchPositionAsync(") === 1);
  const w = map.indexOf("Location.watchPositionAsync(");
  const eAt = map.lastIndexOf("useEffect(", w);
  const eff = eAt < 0 ? null : bodyAfter(map, "useEffect(", eAt);
  ok("F12 map.tsx phone watcher: `let cancelled = false` + the cleanup sets it", !!eff && /let cancelled = false;/.test(eff) && /return \(\) => \{ cancelled = true;/.test(eff));
  ok("F13 …a watch resolving after the cleanup is removed (removeWhenSettled)", !!eff && /\.then\(\(s\) => \{[\s\S]*?sub = s;[\s\S]*?if \(cancelled\) removeWhenSettled\(s,/.test(eff));
  ok("F14 …a delivery to a cancelled effect is dropped and removes the watch", !!eff && /\(pos\) => \{\s*if \(cancelled\) \{ try \{ sub\?\.remove\?\.\(\); \} catch \{\} return; \}/.test(eff));
  ok("F15 …and the effect re-runs when nav ends in the background (fgWatchKeep in the deps)", !!eff && /\[appActive, settings\.liteGps, fgWatchKeep\]\s*\)$/.test(eff));
  ok("F16 …and fgWatchKeep is the gate's own condition", /const fgWatchKeep = appActive \|\| navMode === "turn-by-turn";/.test(map));
}
{
  // No `= await Location.watchPositionAsync(` in src/ or app/, and no creator of a watch outside the two owners above.
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const n of readdirSync(new URL(rel, ROOT))) {
      const r = `${rel}${n}`;
      if (n === "node_modules") continue;
      if (statSync(new URL(r, ROOT)).isDirectory()) walk(`${r}/`);
      else if (/\.(ts|tsx)$/.test(n)) files.push(r);
    }
  };
  walk("src/"); walk("app/");
  const assignAfterAwait: string[] = []; const creators: string[] = [];
  for (const f of files) {
    const b = blank(read(f));
    if (/=\s*await\s+Location\.watchPositionAsync\(/.test(b)) assignAfterAwait.push(f);
    if (/watchPositionAsync\(/.test(b)) creators.push(f);
  }
  ok("F17 no `= await Location.watchPositionAsync(` in src/ or app/", assignAfterAwait.length === 0, assignAfterAwait.join(","));
  ok("F18 the only watch creators are navNotification.ts (owner) and map.tsx (phone watcher)",
    JSON.stringify(creators.sort()) === JSON.stringify(["app/(app)/map.tsx", "src/navNotification.ts"]), JSON.stringify(creators));
}

// ── G · the REAL navNotification.ts, driven through carPlayBootstrap.onConnect / onDisconnect ─────────────────────
// Loaded in node with every other import stubbed (the same registerHooks technique as depart_facing_test.mts): its
// relative imports become no-op modules generated from its own import list — except driveFeed.ts and carFeedOwner.ts,
// which are pure and run for real — and expo-location is the fake above behind globalThis.__loc. The connect
// sequence is carPlayBootstrap's: `void acquireBgLocation('carplay')` then `void startForegroundCarFeed()`, with the
// native start deferred until both are in flight (a native start takes longer than JS microtasks).
// G0 is the NEGATIVE CONTROL on the REAL pre-fix file (c97a1580, via `git show`): 2 native watches, 1 left running
// after releaseBgLocation('carplay'). G1–G4 run the current file.
if (!process.env.CAR_FEED_ROOT) {
  const { registerHooks } = await import("node:module");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const g = globalThis as any;
  g.__rows = [] as string[];
  const js = (body: string) => "data:text/javascript," + encodeURIComponent(body);
  const LOCATION = js(`
    const L = () => globalThis.__loc;
    export const Accuracy = { High: 4, BestForNavigation: 6, Balanced: 3 };
    export const LocationActivityType = { AutomotiveNavigation: 2 };
    export const getForegroundPermissionsAsync = (...a) => L().getForegroundPermissionsAsync(...a);
    export const getBackgroundPermissionsAsync = (...a) => L().getBackgroundPermissionsAsync(...a);
    export const requestBackgroundPermissionsAsync = (...a) => L().requestBackgroundPermissionsAsync(...a);
    export const hasStartedLocationUpdatesAsync = (...a) => L().hasStartedLocationUpdatesAsync(...a);
    export const startLocationUpdatesAsync = (...a) => L().startLocationUpdatesAsync(...a);
    export const stopLocationUpdatesAsync = (...a) => L().stopLocationUpdatesAsync(...a);
    export const watchPositionAsync = (...a) => L().watchPositionAsync(...a);`);
  const RN = js(`export const Platform = { OS: "ios", select: (o) => o.ios ?? o.default };
    export const AppState = { currentState: "background", addEventListener: () => ({ remove() {} }) };`);
  const STORAGE = js(`export default { getItem: () => Promise.resolve(null), setItem: () => Promise.resolve(), removeItem: () => Promise.resolve(), multiRemove: () => Promise.resolve() };`);
  const NOTIF = js(`const p = () => Promise.resolve(); export const AndroidImportance = { HIGH: 4 }; export const AndroidNotificationPriority = { HIGH: "high" };
    export const setNotificationChannelAsync = p, scheduleNotificationAsync = p, dismissNotificationAsync = p, cancelScheduledNotificationAsync = p, getPermissionsAsync = p, requestPermissionsAsync = p;`);
  const TASKS = js(`export const defineTask = () => {}; export const isTaskRegisteredAsync = () => Promise.resolve(false);`);
  const REAL = new Set(["./driveFeed", "./carFeedOwner"]);
  const SRC = new URL("src/", ROOT);
  // A no-op module exporting exactly the names navNotification imports from `spec` (read from its own source).
  const stubFor = (parentSrc: string, spec: string): string => {
    const m = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']`).exec(parentSrc);
    const names = (m?.[1] ?? "").split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("type ")).map((x) => x.split(/\s+as\s+/).pop()!.trim());
    const val = (n: string) => n === "logEvent" || n === "logEventReliable" ? "(r) => { globalThis.__rows.push(String(r)); }"
      : n === "getSettings" ? "() => ({})" : n === "subscribeSettings" ? "() => () => {}" : n === "isPhoneTbtSpeaking" ? "() => true"
      : /^[A-Z][A-Z0-9_]+$/.test(n) ? (n === "CAR_DIAG_MODE" ? "false" : "0") : "() => undefined";
    return js(names.map((n) => `export const ${n} = ${val(n)};`).join("\n"));
  };
  registerHooks({
    resolve(spec: string, ctx: any, next: any) {
      if (spec === "expo-location") return { url: LOCATION, shortCircuit: true };
      if (spec === "react-native") return { url: RN, shortCircuit: true };
      if (spec === "@react-native-async-storage/async-storage") return { url: STORAGE, shortCircuit: true };
      if (spec === "expo-notifications") return { url: NOTIF, shortCircuit: true };
      if (spec === "expo-task-manager") return { url: TASKS, shortCircuit: true };
      const parent = ctx.parentURL ?? "";
      if (spec.startsWith(".") && /navNotification(\.base)?\.ts$/.test(parent)) {
        if (REAL.has(spec)) return { url: new URL(`${spec.slice(2)}.ts`, SRC).href, shortCircuit: true };   // the worktree's pure module
        return { url: stubFor(readFileSync(fileURLToPath(parent), "utf8"), spec), shortCircuit: true };
      }
      return next(spec, ctx);
    },
  });
  // The fake native location service (expo JS semantics, see FakeNative) + NAV_TASK state.
  const makeLoc = () => {
    const native = new FakeNative(); let task = false;
    g.__loc = {
      getForegroundPermissionsAsync: async () => ({ granted: true, status: "granted" }),
      getBackgroundPermissionsAsync: async () => ({ granted: true }),
      requestBackgroundPermissionsAsync: async () => ({ granted: true }),
      hasStartedLocationUpdatesAsync: async () => task,
      startLocationUpdatesAsync: async () => { task = true; },
      stopLocationUpdatesAsync: async () => { task = false; },
      watchPositionAsync: (_o: unknown, cb: (l: any) => void) => native.watch(cb),
    };
    return { native, task: () => task };
  };
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  const connectDisconnect = async (mod: any, native: FakeNative) => {
    void mod.acquireBgLocation("carplay");     // carPlayBootstrap.onConnect, in its order
    void mod.startForegroundCarFeed();
    await flush(); await flush();               // both starts reach the native call before it answers
    const madeAtConnect = native.created.length;
    native.resolveAll(); await flush(); await flush();
    const liveWhileConnected = native.live();
    t += 30 * 60_000;                           // a 30-minute drive (every watch is far past its settle)
    await mod.releaseBgLocation("carplay");     // carPlayBootstrap.onDisconnect
    await flush();
    return { madeAtConnect, liveWhileConnected, liveAfter: native.live() };
  };
  // G0 NEGATIVE CONTROL — the pre-fix file.
  let base: string | null = null;
  try { base = execFileSync("git", ["show", "c97a1580:frontend/src/navNotification.ts"], { cwd: fileURLToPath(ROOT), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
  if (base) {
    const dir = mkdtempSync(join(tmpdir(), "car-feed-base-"));
    const f = join(dir, "navNotification.base.ts");
    writeFileSync(f, base);
    const { native } = makeLoc();
    const mod = await import(pathToFileURL(f).href);
    const r = await connectDisconnect(mod, native);
    rmSync(dir, { recursive: true, force: true });
    ok("G0 NEGATIVE CONTROL (real pre-fix navNotification.ts, c97a1580): one connect → 2 native watches", r.madeAtConnect === 2 && r.liveWhileConnected === 2, JSON.stringify(r));
    ok("G0b NEGATIVE CONTROL: after releaseBgLocation('carplay') one is STILL running — the leak", r.liveAfter === 1, JSON.stringify(r));
  } else {
    console.log("  skip G0 negative control: `git show c97a1580:frontend/src/navNotification.ts` unavailable (shallow clone?)");
  }
  // G1–G4 — the current file.
  {
    g.__rows.length = 0;
    const loc = makeLoc();
    const mod = await import(new URL("src/navNotification.ts", ROOT).href);
    const r = await connectDisconnect(mod, loc.native);
    ok("G1 current navNotification.ts: one connect → 1 native watch", r.madeAtConnect === 1 && r.liveWhileConnected === 1, JSON.stringify(r));
    ok("G2 releaseBgLocation('carplay') → 0 native watches, NAV_TASK stopped", r.liveAfter === 0 && !loc.task(), JSON.stringify(r));
    ok("G3 the release receipt says so: `loc-release tag=carplay fgLive=0 task=0`", g.__rows.includes("loc-release tag=carplay fgLive=0 task=0"), JSON.stringify(g.__rows.filter((x: string) => x.startsWith("loc-") || x.startsWith("carfeed") || x.startsWith("nav-loc"))));
    ok("G4 exactly one `nav-loc src=car` for the connect (was two)", g.__rows.filter((x: string) => x.startsWith("nav-loc src=car")).length === 1);
    // Five more drives on the same module instance.
    const made0 = loc.native.created.length; let allOk = true; const d: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r2 = await connectDisconnect(mod, loc.native);
      if (!(r2.madeAtConnect === made0 + i + 1 && r2.liveWhileConnected === 1 && r2.liveAfter === 0)) allOk = false;
      d.push(JSON.stringify(r2));
    }
    ok("G5 5 more connect/disconnect cycles on the real module → 1 watch each, 0 after each", allOk, d.join(" "));
  }
  Date.now = realNow;
}

if (fails) { console.log(`FAIL car_feed_leak (${fails})`); process.exit(1); }
console.log("PASS car_feed_leak");
process.exit(0);   // the real module registers a settings listener and (if a test ever fails mid-drive) a stall timer
