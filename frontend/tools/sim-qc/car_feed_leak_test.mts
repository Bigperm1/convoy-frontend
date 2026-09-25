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
//   F  static: navNotification.ts's only watchPositionAsync( is inside the owner; the Android Auto disconnect AND unmount
//      release the lock as plain top-level statements (not deferred, not conditional); map.tsx's effect deps and
//      fgWatchKeep; no `= await Location.watchPositionAsync(` and no named import of it anywhere in src/ or app/.
//   G  the REAL navNotification.ts through connect/disconnect (G0 = the pre-fix file leaking one watch; G6 = a FAILED
//      background start, where only the release's own stop can end the car watch).
//   T  the REAL drawTelemetry.ts: no surf=car draw-cmp / pose-fix / corner-trace / cam-apply row without a live car.
//   CP the REAL carPlayBootstrap.ts: connect / disconnect call the head-unit writer, the lock and the telemetry flag
//      synchronously (a deferred or conditional release fails).
//   AA the REAL AndroidAutoRoot.tsx through three car sessions in one process against the real locationPrivacy (AA0 =
//      round 3's root: session 2 never asserted and its walk-away went out live).
//   M  map.tsx's phone-watcher effect, extracted from the source and run: a cleanup before, soon after and long after
//      the watch resolves, deliveries to a dead effect, and the background gate.
//      What M cannot see: whether React re-runs the effect at the right moments (F checks the deps text), hook order,
//      the real expo-location, and the ingest body on the live path.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createCarFeedOwner, removeWhenSettled, CAR_FEED_SETTLE_MS, CAR_FEED_RECEIPT_MAX, LOC_RELEASE_RECEIPT_MAX, type WatchSub } from "../../src/carFeedOwner.ts";

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

// ── P · the owner's values are pinned (src/carFeedOwner.ts is outside tools/sim-qc/data/nav-lock.json) ─────────
// Changing one needs Jeff's say-so (RULES.md §4) — the lock tool does not cover this file yet.
ok("P1 carFeedOwner constants are the approved values", CAR_FEED_SETTLE_MS === 1000 && CAR_FEED_RECEIPT_MAX === 20 && LOC_RELEASE_RECEIPT_MAX === 20,
  JSON.stringify({ CAR_FEED_SETTLE_MS, CAR_FEED_RECEIPT_MAX, LOC_RELEASE_RECEIPT_MAX }));

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
// The statements directly in a `{ … }` block (bracket depth 1, split at `;`), whitespace-normalised. A call deferred
// into a timer/closure or put under a condition is NOT a top-level statement of the block.
function statements(block: string): string[] {
  const out: string[] = []; let depth = 0; let cur = ""; let inS: string | null = null;
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (inS) { cur += c; if (c === "\\") { cur += block[i + 1] ?? ""; i++; continue; } if (c === inS) inS = null; continue; }
    if (c === "'" || c === '"' || c === "`") { inS = c; cur += c; continue; }
    if ("({[".includes(c)) { depth++; if (depth === 1) continue; }
    else if (")}]".includes(c)) { depth--; if (depth === 0) continue; }
    if (depth === 1 && c === ";") { out.push(cur.replace(/\s+/g, " ").trim()); cur = ""; continue; }
    if (depth >= 1) cur += c;
  }
  return out.filter(Boolean);
}
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
  ok("F6 the owner's wanted() is exactly the lock's consumer set", !!ownerCall && /wanted:\s*\(\)\s*=>\s*_locConsumers\.size\s*>\s*0\s*,/.test(ownerCall));

  // carPlayBootstrap's connect / disconnect are checked by RUNNING them (section CP). The same statement check here
  // keeps the static half meaningful for a tree the behavioural half cannot load.
  const cp = blank(read("src/carplay/carPlayBootstrap.ts"));
  const cpDis = bodyAfter(cp, "const onDisconnect = () => {");
  const cpSt = cpDis ? statements(cpDis) : [];
  ok("F7 carPlayBootstrap onDisconnect: release + witness as plain top-level statements",
    ["void releaseBgLocation('carplay')", "noteCarConnected(false, 'carplay')"].every((x) => cpSt.includes(x)), JSON.stringify(cpSt.filter((x) => /release|noteCar/.test(x))));
  ok("F8 carPlayBootstrap onDisconnect → setCarSurfaceLive('carplay', false) (top level)", cpSt.includes("setCarSurfaceLive('carplay', false)"));

  // AndroidAutoRoot is run for real in section AA; these keep the static half meaningful on a tree AA cannot load.
  const aa = blank(read("src/carplay/AndroidAutoRoot.tsx"));
  const endSt = statements(bodyAfter(aa, "const endAaSession = (why: string) => {") ?? "{}");
  ok("F9 AndroidAutoRoot endAaSession: head-unit release + lock release + telemetry flag as plain top-level statements, and every didDisconnect ends the session",
    ["noteCarConnected(false, 'androidauto')", "void releaseBgLocation('androidauto')", "setCarSurfaceLive('androidauto', false)"].every((x) => endSt.includes(x))
      && /const onDisconnect = \(\) => endAaSession\('disconnect'\);/.test(aa), JSON.stringify(endSt));
  const startSt = statements(bodyAfter(aa, "const startAaSession = (why: string) => {") ?? "{}");
  const mountAt = aa.indexOf("startAaSession('mount');");
  const mountEff = mountAt < 0 ? null : bodyAfter(aa, "useEffect(", aa.lastIndexOf("useEffect(", mountAt));
  ok("F10 AndroidAutoRoot: a session starts at the mount AND at every native op=ctx, asserts + acquires, and the unmount ends it",
    ["noteCarConnected(true, 'androidauto')", "void acquireBgLocation('androidauto')", "setCarSurfaceLive('androidauto', true)"].every((x) => startSt.includes(x))
      && !!mountEff && /return \(\) => endAaSession\('unmount'\);/.test(mountEff)
      && /addListener\('aaNativeTrace'[\s\S]{0,200}?op=ctx[\s\S]{0,80}?startAaSession\('ctx'\)/.test(aa), JSON.stringify(startSt));

  const map = blank(read("app/(app)/map.tsx"));
  ok("F11 map.tsx: exactly one watchPositionAsync(", count(map, "watchPositionAsync(") === 1);
  const w = map.indexOf("Location.watchPositionAsync(");
  const eAt = map.lastIndexOf("useEffect(", w);
  const eff = eAt < 0 ? null : bodyAfter(map, "useEffect(", eAt);
  ok("F15 map.tsx phone watcher re-runs when it loses its last reason to run (fgWatchKeep in the deps)", !!eff && /\[appActive, settings\.liteGps, fgWatchKeep\]\s*\)$/.test(eff));
  ok("F16 …fgWatchKeep = app active OR a phone route OR a head unit (locationPrivacy's own aggregate, kept reactive)",
    /const fgWatchKeep = appActive \|\| navMode === "turn-by-turn" \|\| huAttached;/.test(map) && /return subscribeHeadUnit\(setHuAttached\);/.test(map));
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
  const assignAfterAwait: string[] = []; const creators: string[] = []; const named: string[] = [];
  for (const f of files) {
    const b = blank(read(f));
    if (/=\s*await\s+Location\.watchPositionAsync\(/.test(b)) assignAfterAwait.push(f);
    if (/watchPositionAsync\(/.test(b)) creators.push(f);
    if (/import\s*\{[^}]*\bwatchPositionAsync\b[^}]*\}\s*from\s*["']expo-location["']|\{[^}]*\bwatchPositionAsync\b[^}]*\}\s*=\s*Location\b/.test(b)) named.push(f);
  }
  ok("F17 no `= await Location.watchPositionAsync(` in src/ or app/", assignAfterAwait.length === 0, assignAfterAwait.join(","));
  ok("F17b no named / destructured watchPositionAsync (an alias would hide a watch from F18)", named.length === 0, named.join(","));
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
  const RN = js(`export const Platform = { get OS() { return globalThis.__os ?? "ios"; }, select: (o) => o.ios ?? o.default };
    export const AppState = { currentState: "background", addEventListener: () => ({ remove() {} }) };
    export const NativeModules = { RNCarPlay: {} }; export const processColor = (c) => c;
    export const DeviceEventEmitter = { addListener: (ev, fn) => { (globalThis.__dee ??= []).push({ ev, fn }); return { remove() { globalThis.__dee = globalThis.__dee.filter((x) => x.fn !== fn); } }; } };`);
  const STORAGE = js(`export default { getItem: () => Promise.resolve(null), setItem: () => Promise.resolve(), removeItem: () => Promise.resolve(), multiRemove: () => Promise.resolve() };`);
  // useEffect / useRef delegate to globalThis.__react when a test renders a component (section AA); otherwise no-ops.
  const REACT = js(`const f = () => {}; const R = () => globalThis.__react;
    export const useEffect = (fn, d) => (R() ? R().useEffect(fn, d) : undefined), useState = (v) => [v, f],
      useRef = (v) => (R() ? R().useRef(v) : { current: v }), useCallback = (x) => x; export default {};`);
  const ROWS = js(`export const logEvent = (r) => { globalThis.__rows.push(String(r)); }; export const logEventReliable = logEvent;`);
  // A module exporting the names `parent` imports from `spec`, each one RECORDING its calls into globalThis.__calls
  // as "<spec>:<name>(<json args>)" and returning a resolved promise (so `void x().catch(…)` works). For section CP.
  const recorderFor = (parentSrc: string, spec: string): string => {
    const m = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']`).exec(parentSrc);
    const names = (m?.[1] ?? "").split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("type ")).map((x) => x.split(/\s+as\s+/).pop()!.trim());
    const val = (n: string) => n === "carPlayHookOwnsRoot" ? "false" : /^[A-Z][A-Z0-9_]+$/.test(n) ? "{}"
      : `(...a) => { globalThis.__calls.push(${JSON.stringify(spec + ":" + n)} + "(" + a.map((x) => JSON.stringify(x)).join(",") + ")"); return ${n === "getCarState" ? "({})" : "Promise.resolve()"}; }`;
    return js(names.map((n) => `export const ${n} = ${val(n)};`).join("\n"));
  };
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
      if (spec === "react") return { url: REACT, shortCircuit: true };
      const parent = ctx.parentURL ?? "";
      if (spec.startsWith(".") && /navNotification(\.base)?\.ts$/.test(parent)) {
        if (REAL.has(spec)) return { url: new URL(`${spec.slice(2)}.ts`, SRC).href, shortCircuit: true };   // the worktree's pure module
        return { url: stubFor(readFileSync(fileURLToPath(parent), "utf8"), spec), shortCircuit: true };
      }
      if (spec.startsWith(".") && /carPlayBootstrap\.ts$/.test(parent)) return { url: recorderFor(readFileSync(fileURLToPath(parent), "utf8"), spec), shortCircuit: true };
      if (spec.startsWith(".") && /AndroidAutoRoot\.(cur|r3)\.mjs$/.test(parent)) {
        if (spec === "../locationPrivacy") return { url: g.__aaLpUrl, shortCircuit: true };            // the REAL gate, per run
        return { url: recorderFor(readFileSync(fileURLToPath(parent), "utf8"), spec), shortCircuit: true };
      }
      if (spec === "./crashBreadcrumb" && /drawTelemetry\.ts$/.test(parent)) return { url: ROWS, shortCircuit: true };
      if (spec.startsWith(".") && !/\.[a-z]+$/i.test(spec)) { try { return next(spec + ".ts", ctx); } catch {} }
      return next(spec, ctx);
    },
  });
  // The fake native location service (expo JS semantics, see FakeNative) + NAV_TASK state.
  const makeLoc = (bgStartFails = false) => {
    const native = new FakeNative(); let task = false;
    g.__loc = {
      getForegroundPermissionsAsync: async () => ({ granted: true, status: "granted" }),
      getBackgroundPermissionsAsync: async () => ({ granted: true }),
      requestBackgroundPermissionsAsync: async () => ({ granted: true }),
      hasStartedLocationUpdatesAsync: async () => task,
      // G6: a FAILED background start (When-In-Use behind the lock, an Android FGS refusal) — NAV_TASK never runs.
      startLocationUpdatesAsync: async () => { if (bgStartFails) throw new Error("bgstart refused"); task = true; },
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
    // G6 — the review's mutation (the car-watch stop moved inside `if (started)`) passed every gate because this fake
    // always started NAV_TASK. With the background start refused, only the release's own stop ends the car watch.
    g.__rows.length = 0;
    const failing = makeLoc(true);
    const r3 = await connectDisconnect(mod, failing.native);
    ok("G6 FAILED background start: releaseBgLocation still removes the car watch (fgLive=0 task=0)",
      r3.madeAtConnect === 1 && r3.liveAfter === 0 && !failing.task() && g.__rows.includes("loc-release tag=carplay fgLive=0 task=0"),
      JSON.stringify({ ...r3, rows: g.__rows.filter((x: string) => x.startsWith("loc-release")) }));
  }

  // ── T · the car-surface telemetry drop, run for real (src/drawTelemetry.ts) ─────────────────────────────────────
  {
    const dt = await import(new URL("src/drawTelemetry.ts", ROOT).href);
    const rows = () => (g.__rows as string[]).filter((r) => /^(draw-cmp|pose-fix|corner-trace|snap-mode|cam-apply) surf=car/.test(r));
    const phoneRows = () => (g.__rows as string[]).filter((r) => /^(draw-cmp|pose-fix|cam-apply) surf=phone/.test(r));
    const raw = { lat: 49.1734, lng: -122.6654 }, gps = { lat: 49.1734, lng: -122.6654, accM: 5 };
    const pose = { fixAge: 90, acc: 5, course: 90, spd: 8, estHdg: 90, yaw: null, src: "gps", drawnVsFixM: 1, distM: 2, routeW: 0.5 };
    const hdg = { locked: 90, raw: 90, route: 90 };
    const burst = () => {
      t += 61_000;
      dt.reportDraw("car", raw, raw, "raw", 8, true, gps, hdg); dt.reportPoseFix("car", true, pose); dt.reportCamApply("car", "dM=40 req=49.17340,-122.66540");
      dt.reportDraw("phone", raw, raw, "raw", 8, true, gps, hdg); dt.reportPoseFix("phone", true, pose); dt.reportCamApply("phone", "dM=40 req=49.17340,-122.66540");
    };
    g.__rows.length = 0; burst();
    const before = rows().length, ctlPhone = phoneRows().length;
    dt.setCarSurfaceLive("carplay", true); g.__rows.length = 0; burst();
    const during = rows().length;
    dt.setCarSurfaceLive("carplay", false); g.__rows.length = 0; burst();
    const after = rows().length;
    ok("T1 no car surface → no surf=car draw-cmp / pose-fix / cam-apply row (the phone rows still write)", before === 0 && ctlPhone === 3, `car=${before} phone=${ctlPhone}`);
    ok("T2 CarPlay live → the car rows write", during === 3, `car=${during}`);
    ok("T3 after the disconnect → none again", after === 0, `car=${after}`);
    const cmb = blank(read("src/ConvoyMapbox.tsx"));
    ok("T4 ConvoyMapbox's cam-apply goes through reportCamApply (no direct cam-apply row)", /reportCamApply\(probeRole, /.test(cmb) && !/`cam-apply surf=/.test(cmb));
  }

  // ── CP · carPlayBootstrap.ts run for real: connect / disconnect ───────────────────────────────────────────────────
  {
    g.__calls = [] as string[];
    g.__DEV__ = true;
    const cb = { connect: [] as (() => void)[], disconnect: [] as (() => void)[] };
    const CarPlay = { connected: false, bridge: { checkForConnection() {} }, registerOnConnect: (f: () => void) => cb.connect.push(f), registerOnDisconnect: (f: () => void) => cb.disconnect.push(f), setRootTemplate() {} };
    class MapTemplate { cfg: unknown; constructor(c: unknown) { this.cfg = c; } }
    g.require = (m: string) => { if (m === "react-native-carplay") return { CarPlay, MapTemplate }; throw new Error(`require ${m}`); };
    g.__loc = { ...g.__loc, getForegroundPermissionsAsync: async () => ({ granted: false }) };
    const boot = await import(new URL("src/carplay/carPlayBootstrap.ts", ROOT).href);
    boot.initCarPlayBootstrap();
    const calls = g.__calls as string[];
    ok("CP0 at boot (nothing attached) the session claims the head-unit source", calls.includes(`../locationPrivacy:noteCarConnected(false,"carplay")`), JSON.stringify(calls.filter((c) => /noteCar/.test(c))));
    calls.length = 0; CarPlay.connected = true; for (const f of cb.connect) f();
    const onC = [...calls];
    ok("CP1 connect, synchronously: head unit attached, lock acquired, car feed started, car rows allowed",
      [`../locationPrivacy:noteCarConnected(true,"carplay")`, `../navNotification:acquireBgLocation("carplay")`, `../navNotification:startForegroundCarFeed()`, `../drawTelemetry:setCarSurfaceLive("carplay",true)`].every((x) => onC.includes(x)),
      JSON.stringify(onC.filter((c) => /noteCar|BgLocation|ForegroundCarFeed|SurfaceLive/.test(c))));
    calls.length = 0; CarPlay.connected = false; for (const f of cb.disconnect) f();
    const onD = [...calls];
    ok("CP2 disconnect, SYNCHRONOUSLY (no timer, no await): the park witnessed, the lock released, car rows stopped",
      [`../locationPrivacy:noteCarConnected(false,"carplay")`, `../navNotification:releaseBgLocation("carplay")`, `../drawTelemetry:setCarSurfaceLive("carplay",false)`].every((x) => onD.includes(x)),
      JSON.stringify(onD.filter((c) => /noteCar|BgLocation|SurfaceLive/.test(c))));
    ok("CP3 …and the witness comes before the lock release (the latch drops before anything else can run)",
      onD.indexOf(`../locationPrivacy:noteCarConnected(false,"carplay")`) < onD.indexOf(`../navNotification:releaseBgLocation("carplay")`));
    delete g.require;
  }

  // ── AA · AndroidAutoRoot.tsx run for real through THREE car sessions in one JS process ──────────────────────────
  // The root mounts once per process; CarPlaySession runs a new session into it (field: 5 of 21 AA process lifetimes had
  // 2–3 sessions). Its head-unit calls go to the REAL locationPrivacy (Platform android), the rest are recorded.
  // AA0 is the NEGATIVE CONTROL on round 3's root (732c8a6e): session 2 never asserts, so its walk-away is shared LIVE.
  {
    const ts = (await import("typescript")).default;
    const { mkdtempSync: mkd, writeFileSync: wf, rmSync: rmf } = await import("node:fs");
    const aaRun = async (src: string, tag: "cur" | "r3") => {
      const dir = mkd(join(tmpdir(), "aa-root-"));
      const file = join(dir, `AndroidAutoRoot.${tag}.mjs`);
      wf(file, ts.transpileModule(src, { fileName: "AndroidAutoRoot.tsx", compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.Preserve } }).outputText);
      g.__os = "android"; g.__calls = [] as string[]; g.__dee = [];
      g.__aaLpUrl = new URL(`src/locationPrivacy.ts?aa=${tag}`, ROOT).href;
      const lp: any = await import(g.__aaLpUrl);
      await lp.hydrateLocationPrivacy();
      const disconnects: (() => void)[] = [];
      const CarPlay = { registerOnDisconnect: (f: () => void) => disconnects.push(f), unregisterOnDisconnect() {}, setRootTemplate() {} };
      class NavigationTemplate { c: unknown; constructor(c: unknown) { this.c = c; } updateTemplate() {} }
      g.require = (m: string) => { if (m === "react-native-carplay") return { CarPlay, NavigationTemplate }; throw new Error(`require ${m}`); };
      const effects: (() => (void | (() => void)))[] = [];
      g.__react = { useEffect: (fn: () => (void | (() => void))) => { effects.push(fn); }, useRef: (v: unknown) => ({ current: v }) };
      const Root = (await import(pathToFileURL(file).href)).default;
      Root();
      const cleanups = effects.map((fn) => fn());
      g.__react = null;
      const calls = g.__calls as string[];
      const count = (x: string) => calls.filter((c) => c === x).length;
      const ctx = () => { for (const l of [...(g.__dee as any[])]) if (l.ev === "aaNativeTrace") l.fn({ msg: "op=ctx life=RESUMED forced=0 ee=1" }); };
      const disconnect = () => { for (const f of disconnects) f(); };
      let p = { lat: 49.1, lng: -122.6 };
      const drive = (secs: number) => { for (let k = 0; k < secs; k++) { t += 1000; p = { lat: p.lat + 20 / 111320, lng: p.lng }; lp.noteFix(p.lat, p.lng, 20, 0); } for (let k = 0; k < 10; k++) { t += 1000; lp.noteFix(p.lat, p.lng, 0, null); } };
      const st = () => ({ raw: lp.headUnitAttachedRaw(), hu: lp.parkEndedByHeadUnit(), latch: lp.privacyDebug().latch });
      const out: any = {};
      drive(300); out.s1drive = st(); disconnect(); out.s1end = st();
      t += 30 * 60_000;
      ctx(); out.s2start = st();
      for (const l of [...(g.__dee as any[])]) if (l.ev === "aaNativeTrace") l.fn({ msg: "op=hold on=1 via=acquire" });   // not a session start
      drive(300);
      const midShare = lp.shareablePosition({ lat: p.lat, lng: p.lng, speed: 20, heading: 0 });
      out.s2live = midShare.share && midShare.lat === p.lat;
      const car = { ...p }; disconnect(); out.s2end = st();
      t += 60_000;
      const w1 = { lat: car.lat + 60 / 111320, lng: car.lng };
      const sh1 = lp.shareablePosition({ ...w1, speed: 3.3, heading: 0 }); lp.noteFix(w1.lat, w1.lng, 3.3, null);
      t += 1000; const w2 = { lat: car.lat + 90 / 111320, lng: car.lng }; lp.noteFix(w2.lat, w2.lng, 7.2, null);
      t += 1000; const w3 = { lat: car.lat + 95 / 111320, lng: car.lng };
      const sh3 = lp.shareablePosition({ ...w3, speed: 3.3, heading: 0 }); lp.noteFix(w3.lat, w3.lng, 3.3, null);
      out.walkLive = (sh1.share && sh1.lat === w1.lat) || (sh3.share && sh3.lat === w3.lat);
      t += 10 * 60_000; ctx(); ctx(); out.s3start = st(); drive(120); disconnect(); out.s3end = st();
      for (const c of cleanups) if (typeof c === "function") c();   // unmount after the last session
      out.acquires = count(`../navNotification:acquireBgLocation("androidauto")`);
      out.releases = count(`../navNotification:releaseBgLocation("androidauto")`);
      out.surfaceOn = count(`../drawTelemetry:setCarSurfaceLive("androidauto",true)`);
      out.surfaceOff = count(`../drawTelemetry:setCarSurfaceLive("androidauto",false)`);
      delete g.require; g.__os = undefined;
      rmf(dir, { recursive: true, force: true });
      return out;
    };
    const cur = await aaRun(read("src/carplay/AndroidAutoRoot.tsx"), "cur");
    let r3: string | null = null;
    try { r3 = execFileSync("git", ["show", "732c8a6e:frontend/src/carplay/AndroidAutoRoot.tsx"], { cwd: fileURLToPath(ROOT), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
    if (r3) {
      const old = await aaRun(r3, "r3");
      ok("AA0 NEGATIVE CONTROL (round 3 root, 732c8a6e): session 2 never asserts a head unit and its walk-away is shared LIVE",
        old.s2start.raw === false && old.s2end.latch === true && old.walkLive === true, JSON.stringify(old));
    } else console.log("  skip AA0 negative control: 732c8a6e unavailable");
    ok("AA1 each connect asserts the head unit and clears the previous park (sessions 2 and 3 via op=ctx)",
      cur.s2start.raw === true && cur.s2start.hu === false && cur.s3start.raw === true && cur.s3start.hu === false, JSON.stringify({ s2: cur.s2start, s3: cur.s3start }));
    ok("AA2 each disconnect witnesses the park and drops the drive's latch", [cur.s1end, cur.s2end, cur.s3end].every((x: any) => x.raw === false && x.hu === true && x.latch === false), JSON.stringify({ s1: cur.s1end, s2: cur.s2end, s3: cur.s3end }));
    ok("AA3 drive 2 is shared live while connected", cur.s2live === true);
    ok("AA4 the walk after session 2 stays at the car spot (a 26 km/h glitch included)", cur.walkLive === false);
    ok("AA5 one acquire and one release per session (3 + 3; a duplicate op=ctx and a non-ctx trace start nothing; the unmount after the last disconnect releases nothing twice)",
      cur.acquires === 3 && cur.releases === 3 && cur.surfaceOn === 3 && cur.surfaceOff === 3, JSON.stringify({ a: cur.acquires, r: cur.releases, on: cur.surfaceOn, off: cur.surfaceOff }));
  }

  // ── M · map.tsx's phone-watcher effect, extracted from the source and run ───────────────────────────────────────
  {
    const ts = (await import("typescript")).default;
    const vm = await import("node:vm");
    const raw = read("app/(app)/map.tsx"); const bl = blank(raw);
    const wAt = bl.indexOf("Location.watchPositionAsync(");
    const eAt = bl.lastIndexOf("useEffect(", wAt);
    const open = bl.indexOf("() => {", eAt) + "() => ".length;
    const close = closeOf(bl, open);
    const code = ts.transpileModule(`var __effect = () => ${raw.slice(open, close + 1)};`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    let mclock = 5_000_000; let mtimers: { at: number; fn: () => void }[] = [];
    const mlater = (fn: () => void, ms: number) => { mtimers.push({ at: mclock + ms, fn }); };
    const madvance = (ms: number) => { const end = mclock + ms; for (;;) { mtimers.sort((a, b) => a.at - b.at); const x = mtimers[0]; if (!x || x.at > end) break; mtimers.shift(); mclock = x.at; x.fn(); } mclock = end; };
    const run = (o: { appActive: boolean; nav: boolean; keepPrev: boolean; keep: boolean }) => {
      const native = new FakeNative(); let ingest = 0;
      const ctx: any = {
        ensureLocationPermission: async () => true, appActive: o.appActive, navActiveRef: { current: o.nav },
        fgWatchKeepRef: { current: o.keepPrev }, fgWatchKeep: o.keep, settings: { liteGps: false },
        Location: { Accuracy: { High: 4, BestForNavigation: 6 }, watchPositionAsync: (_o: unknown, cb2: (l: any) => void) => native.watch(cb2) },
        removeWhenSettled: (s2: WatchSub, bornAt: number) => removeWhenSettled(s2, bornAt, () => mclock, mlater),
        Date: { now: () => mclock },
        rawCourseHere: () => { ingest++; return null; },   // the first call of the fix-ingest body
      };
      vm.runInNewContext(code, ctx);
      const cleanup = ctx.__effect();
      return { native, cleanup, ingested: () => ingest };
    };
    const active = { appActive: true, nav: false, keepPrev: true, keep: true };
    {
      const r = run(active); await flush(); await flush();
      const made = r.native.created.length;
      r.cleanup();                                   // the effect is torn down while the start is in flight
      r.native.resolveAll(); await flush(); await flush();
      const heldAtResolve = r.native.live();
      let threw = false;
      try { r.native.deliver(1); } catch { threw = true; }   // a fix for the dead effect (an unguarded ingest throws here: no map.tsx scope)
      const afterDelivery = r.native.live();
      ok("M1 cleanup while the watch start is in flight → the late watch is removed (a `sub = await` shape leaves it running)",
        made === 1 && heldAtResolve === 1 && afterDelivery === 0 && r.ingested() === 0 && !threw, JSON.stringify({ made, heldAtResolve, afterDelivery, ingested: r.ingested(), threw }));
    }
    {
      const r = run(active); await flush(); await flush();
      r.cleanup(); r.native.resolveAll(); await flush(); await flush();
      madvance(CAR_FEED_SETTLE_MS - 1); const before = r.native.live();
      madvance(1);
      ok("M2 …and with no delivery it is removed once the native start has settled", before === 1 && r.native.live() === 0, `before=${before} after=${r.native.live()}`);
    }
    {
      const r = run(active); await flush(); await flush(); r.native.resolveAll(); await flush(); await flush();
      madvance(5_000); r.cleanup();
      ok("M3 cleanup of a settled watch removes it at once (a cleanup that forgets to remove fails here)", r.native.live() === 0 && r.native.created[0].removeCalls === 1, `live=${r.native.live()}`);
    }
    {
      const r = run(active); await flush(); await flush(); r.native.resolveAll(); await flush(); await flush();
      madvance(300); r.cleanup();
      const atCleanup = r.native.created[0].removeCalls;
      madvance(CAR_FEED_SETTLE_MS);
      ok("M4 cleanup 300 ms after the watch resolved waits for the settle, then removes it (the zombie-race rule)", atCleanup === 0 && r.native.live() === 0, `removeCallsAtCleanup=${atCleanup} live=${r.native.live()}`);
    }
    {
      const mk = async (o: typeof active) => { const r = run(o); await flush(); await flush(); await flush(); return r.native.created.length; };
      const bgIdle = await mk({ appActive: false, nav: false, keepPrev: true, keep: false });
      const bgNavNoPrev = await mk({ appActive: false, nav: true, keepPrev: false, keep: true });
      const bgNavPrev = await mk({ appActive: false, nav: true, keepPrev: true, keep: true });
      const fg = await mk(active);
      ok("M5 the gate: background + no route → no watch; a background start after a run that had none → no watch; a continuing background route → watch; foreground → watch",
        bgIdle === 0 && bgNavNoPrev === 0 && bgNavPrev === 1 && fg === 1, JSON.stringify({ bgIdle, bgNavNoPrev, bgNavPrev, fg }));
    }
  }
  Date.now = realNow;
}

if (fails) { console.log(`FAIL car_feed_leak (${fails})`); process.exit(1); }
console.log("PASS car_feed_leak");
process.exit(0);   // the real module registers a settings listener and (if a test ever fails mid-drive) a stall timer
