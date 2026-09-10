// drive_feed_test — gate for src/driveFeed.ts (the drive-time location request + the Lite GPS
// rebuild rule + the async relite). Run: node --experimental-strip-types tools/sim-qc/drive_feed_test.mts
//
// Codex review 2026-09-10 (OTA-AM), pass 1: "Lite GPS no longer reliably downgrades all active
// location feeds" — the head-unit feeds read the setting only when they start, and settings hydrate
// asynchronously. Pass 2: a toggle landing between the two starts hid the mismatch behind ONE shared
// applied flag (D1), and a release during a rebuild could leave feeds running with no consumer (D2).
// Section D drives the real async function with deferred "native" promises, through a model of the
// navNotification glue (start reads the setting, commits after success, reconciles after start).
import {
  driveFeedOptions, driveFeedRebuildPlan, driveFeedNeedsRelite, reliteDriveFeeds, type DriveFeedState,
} from "../../src/driveFeed.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const eq = (a: { fg: boolean; bg: boolean }, b: { fg: boolean; bg: boolean }) => a.fg === b.fg && a.bg === b.bg;
const none = { fg: false, bg: false };
const F = (up: boolean, lite: boolean | null): DriveFeedState => ({ up, lite });

console.log("A. the request");
{
  const d = driveFeedOptions(false);
  check("A1 default = BestForNavigation 500 ms / 2 m", d.accuracy === "bfn" && d.timeInterval === 500 && d.distanceInterval === 2 && d.lite === false, JSON.stringify(d));
  const l = driveFeedOptions(true);
  check("A2 Lite GPS = High 1000 ms / 8 m (the phone watcher's numbers)", l.accuracy === "high" && l.timeInterval === 1000 && l.distanceInterval === 8 && l.lite === true, JSON.stringify(l));
  check("A3 default is never the ten-metre class", d.accuracy !== "high");
}

console.log("B. the rebuild rule");
{
  check("B1 no consumer → nothing (a leak is not ours to restart)", eq(driveFeedRebuildPlan({ liteNow: true, changed: true, consumers: 0, fg: F(true, false), bg: F(true, false) }), none));
  check("B2 unchanged value → nothing (every updateSettings notifies)", eq(driveFeedRebuildPlan({ liteNow: true, changed: false, consumers: 1, fg: F(true, true), bg: F(true, true) }), none));
  check("B3 changed, only the watch up → the watch only", eq(driveFeedRebuildPlan({ liteNow: true, changed: true, consumers: 1, fg: F(true, false), bg: F(false, null) }), { fg: true, bg: false }));
  check("B4 changed, only the task up → the task only", eq(driveFeedRebuildPlan({ liteNow: true, changed: true, consumers: 1, fg: F(false, null), bg: F(true, false) }), { fg: false, bg: true }));
  check("B5 changed, both up → both", eq(driveFeedRebuildPlan({ liteNow: false, changed: true, consumers: 2, fg: F(true, true), bg: F(true, true) }), { fg: true, bg: true }));
  check("B6 changed, neither up → nothing (a down feed is not started here)", eq(driveFeedRebuildPlan({ liteNow: true, changed: true, consumers: 1, fg: F(false, null), bg: F(false, null) }), none));
  check("B7 per-feed: only the feed that mismatches is rebuilt", eq(driveFeedRebuildPlan({ liteNow: true, changed: false, consumers: 1, fg: F(true, false), bg: F(true, true) }), { fg: true, bg: false }));
  check("B8 inherited task (mode unknown) + an actual toggle → rebuilt", eq(driveFeedRebuildPlan({ liteNow: true, changed: true, consumers: 1, fg: F(false, null), bg: F(true, null) }), { fg: false, bg: true }));
  check("B9 inherited task + an unrelated notify → left alone", eq(driveFeedRebuildPlan({ liteNow: true, changed: false, consumers: 1, fg: F(false, null), bg: F(true, null) }), none));
  check("B10 pre-check: matching feeds, unrelated notify → no work", !driveFeedNeedsRelite({ liteNow: true, changed: false, consumers: 1, fg: F(true, true), bgLite: true }));
  check("B11 pre-check: a mismatched task value → work (up-ness is checked natively)", driveFeedNeedsRelite({ liteNow: true, changed: false, consumers: 1, fg: F(false, null), bgLite: false }));
  check("B12 pre-check: no consumer → no work", !driveFeedNeedsRelite({ liteNow: true, changed: true, consumers: 0, fg: F(true, false), bgLite: false }));
}

// ── The glue model. Mirrors navNotification.ts: a start reads the setting when it is CALLED,
// awaits the native promise, commits its applied value only on success, bails if the last consumer
// left meanwhile, then reconciles (changed=false). The settings listener reconciles with
// changed = (value differs from the last value it saw). Rebuilds are serialized on one chain.
type Deferred = { p: Promise<void>; resolve: () => void };
function defer(): Deferred { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r; }); return { p, resolve }; }
const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle(n = 6): Promise<void> { for (let i = 0; i < n; i++) await tick(); }

function makeModel(init: { lite: boolean; consumers: number }) {
  const st = {
    settingsLite: init.lite, seen: init.lite, consumers: init.consumers,
    fgUp: false, fgLite: null as boolean | null, bgUp: false, bgLite: null as boolean | null,
    log: [] as string[], chain: Promise.resolve() as Promise<unknown>,
    pendingFg: [] as Deferred[], pendingBg: [] as Deferred[], fgStarts: 0, bgStarts: 0, teardowns: 0, results: [] as string[],
  };
  const stopFg = () => { st.fgUp = false; st.fgLite = null; };
  const reconcile = (fromSettings: boolean) => {
    const liteNow = st.settingsLite;
    const changed = fromSettings && liteNow !== st.seen;
    if (fromSettings) st.seen = liteNow;
    if (!driveFeedNeedsRelite({ liteNow, changed, consumers: st.consumers, fg: { up: st.fgUp, lite: st.fgLite }, bgLite: st.bgLite })) return;
    st.chain = st.chain.then(() => reliteDriveFeeds({
      liteNow, changed,
      consumers: () => st.consumers,
      fg: () => ({ up: st.fgUp, lite: st.fgLite }),
      bgOn: async () => st.bgUp,
      bgLite: () => st.bgLite,
      restartFg: async () => { stopFg(); await startFg(); },
      restartBg: async () => { await startBg(true); },
      teardown: async () => { st.teardowns++; stopFg(); st.bgUp = false; },
      log: (row) => st.log.push(row),
    }).then((r) => { st.results.push(r); })).catch(() => {});
  };
  const startFg = async () => {
    if (st.fgUp) return;
    const lite = st.settingsLite;                 // read when CALLED (driveLocationOptions)
    const d = defer(); st.pendingFg.push(d); await d.p;   // watchPositionAsync
    st.fgUp = true; st.fgLite = lite; st.fgStarts++;      // committed after success
    if (st.consumers === 0) { stopFg(); return; }         // the post-assign race guard
    reconcile(false);
  };
  const startBg = async (force: boolean) => {
    if (st.bgUp && !force) return;
    const lite = st.settingsLite;
    const d = defer(); st.pendingBg.push(d); await d.p;   // startLocationUpdatesAsync
    st.bgUp = true; st.bgLite = lite; st.bgStarts++;
    reconcile(false);
  };
  const release = () => { st.consumers = 0; stopFg(); st.bgUp = false; };
  const notify = () => reconcile(true);
  const resolveFg = () => { const d = st.pendingFg.shift(); d?.resolve(); return !!d; };
  const resolveBg = () => { const d = st.pendingBg.shift(); d?.resolve(); return !!d; };
  return { st, startFg, startBg, notify, release, resolveFg, resolveBg };
}

console.log("C. the pass-1 sequence: cold connect before hydration, then the toggle mid-drive");
await (async () => {
  const m = makeModel({ lite: false, consumers: 1 });
  void m.startFg(); void m.startBg(false);
  m.resolveFg(); m.resolveBg(); await settle();
  check("C1 cold start ran BestForNavigation (defaults)", m.st.fgLite === false && m.st.bgLite === false);
  m.st.settingsLite = true; m.notify(); await settle();      // hydration lands: the driver had Lite GPS on
  m.resolveFg(); await settle(); m.resolveBg(); await settle();
  // (a post-start reconcile may queue one extra "none" pass while the first rebuild is mid-flight — harmless)
  check("C2 hydration notify rebuilt BOTH feeds at Lite", m.st.fgLite === true && m.st.bgLite === true && m.st.results[0] === "done", JSON.stringify(m.st.results));
  const before = m.st.fgStarts + m.st.bgStarts;
  m.notify(); await settle();                               // an unrelated updateSettings (thread tap)
  check("C3 an unrelated notify restarts nothing", m.st.fgStarts + m.st.bgStarts === before && m.st.pendingFg.length === 0 && m.st.pendingBg.length === 0);
  m.st.settingsLite = false; m.notify(); await settle();     // the driver flips Lite GPS off mid-drive
  m.resolveFg(); await settle(); m.resolveBg(); await settle();
  check("C4 mid-drive toggle rebuilt both at BestForNavigation", m.st.fgLite === false && m.st.bgLite === false);
  m.release(); m.st.settingsLite = true; m.notify(); await settle();
  check("C5 after the last consumer leaves, a toggle restarts nothing", m.st.pendingFg.length === 0 && m.st.pendingBg.length === 0 && !m.st.fgUp && !m.st.bgUp);
  check("C6 exactly one relite receipt per actual rebuild", m.st.log.filter((r) => r.startsWith("nav-loc relite")).length === 2, m.st.log.join(" | "));
})();

console.log("D. the pass-2 races, driven with deferred native promises");
await (async () => {
  // D1 — Codex finding 1: the watch reads OFF and is pending; Lite flips ON; the task start reads ON.
  // With one shared flag the watch stayed at BestForNavigation forever. Per-feed values + the
  // post-start reconcile must bring the watch to ON too, and the chain must go quiet.
  const m = makeModel({ lite: false, consumers: 1 });
  void m.startFg();                                          // reads false, pending
  m.st.settingsLite = true; m.notify(); await settle();      // toggle lands while the watch is pending
  void m.startBg(false);                                     // reads true, pending
  m.resolveBg(); await settle();                             // task up at true
  m.resolveFg(); await settle();                             // watch up at FALSE → post-start reconcile
  check("D1a the mismatched watch was queued for a rebuild", m.st.pendingFg.length === 1 && m.st.pendingBg.length === 0, `fg=${m.st.pendingFg.length} bg=${m.st.pendingBg.length}`);
  m.resolveFg(); await settle();
  check("D1b both feeds end at Lite ON", m.st.fgLite === true && m.st.bgLite === true, `fg=${m.st.fgLite} bg=${m.st.bgLite}`);
  check("D1c the task was NOT restarted (it already matched)", m.st.bgStarts === 1);
  check("D1d the chain went quiet (no ping-pong)", m.st.pendingFg.length === 0 && m.st.pendingBg.length === 0 && m.st.fgStarts === 2);
})();
await (async () => {
  // D2 — Codex finding 2: both feeds up; a toggle starts a rebuild; the last consumer releases while
  // watchPositionAsync is pending. The rebuild must not resurrect either feed, must tear down, and
  // must NOT run its saved task restart.
  const m = makeModel({ lite: false, consumers: 1 });
  void m.startFg(); void m.startBg(false); m.resolveFg(); m.resolveBg(); await settle();
  m.st.settingsLite = true; m.notify(); await settle();      // rebuild starts: restartFg pending
  check("D2a the rebuild is mid-restart of the watch", m.st.pendingFg.length === 1 && !m.st.fgUp);
  const bgStartsBefore = m.st.bgStarts;
  m.release();                                               // CarPlay unplugged mid-rebuild
  m.resolveFg(); await settle();
  check("D2b the rebuilt watch was torn down again", !m.st.fgUp && m.st.fgLite == null);
  check("D2c the task restart never ran", m.st.pendingBg.length === 0 && m.st.bgStarts === bgStartsBefore && !m.st.bgUp);
  check("D2d the relite reported aborted and tore down", m.st.results.at(-1) === "aborted" && m.st.teardowns >= 1, JSON.stringify(m.st.results));
})();
await (async () => {
  // D3 — release landing during the very first await (hasStartedLocationUpdatesAsync) → aborted, no restarts.
  const m = makeModel({ lite: false, consumers: 1 });
  void m.startFg(); m.resolveFg(); await settle();
  m.st.settingsLite = true;
  m.notify();                                                // queued; bgOn() is the first await
  m.release();                                               // before the plan is computed
  await settle();
  check("D3 release before the plan → aborted, nothing restarted", m.st.results.at(-1) === "aborted" && m.st.pendingFg.length === 0 && m.st.fgStarts === 1, JSON.stringify(m.st.results));
})();
await (async () => {
  // D4 — an inherited task (up, mode unknown) is rebuilt on an actual toggle and left alone otherwise.
  const m = makeModel({ lite: false, consumers: 1 });
  m.st.bgUp = true; m.st.bgLite = null;                      // registered by a previous JS session
  m.notify(); await settle();
  check("D4a unrelated notify leaves the inherited task alone", m.st.pendingBg.length === 0);
  m.st.settingsLite = true; m.notify(); await settle();
  check("D4b an actual toggle rebuilds it", m.st.pendingBg.length === 1);
  m.resolveBg(); await settle();
  check("D4c and it now carries a known value", m.st.bgLite === true && m.st.results.at(-1) === "done");
})();
await (async () => {
  // D5 — two toggles in flight: the chain serializes and converges on the LAST value, bounded restarts.
  const m = makeModel({ lite: false, consumers: 1 });
  void m.startFg(); void m.startBg(false); m.resolveFg(); m.resolveBg(); await settle();
  m.st.settingsLite = true; m.notify();
  m.st.settingsLite = false; m.notify(); await settle();
  for (let i = 0; i < 8; i++) { m.resolveFg(); m.resolveBg(); await settle(); }
  check("D5a converged on the last value", m.st.fgLite === false && m.st.bgLite === false, `fg=${m.st.fgLite} bg=${m.st.bgLite}`);
  check("D5b bounded restarts (≤ 3 per feed incl. the first start)", m.st.fgStarts <= 3 && m.st.bgStarts <= 3, `fg=${m.st.fgStarts} bg=${m.st.bgStarts}`);
  check("D5c chain quiet", m.st.pendingFg.length === 0 && m.st.pendingBg.length === 0);
})();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
