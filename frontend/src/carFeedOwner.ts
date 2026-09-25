// carFeedOwner.ts — THE ONE OWNER of the car GPS watcher (privacy, 2026-09-25).
//
// Jeff, 2026-09-25: "i think the connection is following me after the carplay dissconnect. it should not follow me
// when i discconect from car play... this is a privacy concern. fix it and lock it."
//
// ── WHAT WAS MEASURED (crash_reports, SELECT only) ───────────────────────────────────────────────────────────────
// After `carplay-disconnect` + `loc-bgsess op=stop` (the correct release) the car store kept receiving FRESH fixes
// in the background for minutes to hours — 09-23 for 110 min and for 2 h 09, 09-25 from 10:08:20 until the JS
// restarted at 10:14:15 — and raw walking coordinates reached telemetry through `draw-cmp surf=car gps=…` and
// `cam-apply surf=car req=…`. At every one of Jeff's CarPlay connects `nav-loc src=car` (logged just before the
// native watch starts) appears TWICE in the same second (09-22 09:10:06, 09-23 08:54:37 and 17:31:36, 09-24 17:31:11,
// 09-25 09:19:14.987 + 09:19:15.025), and a car-watch callback (`loc-src feed=fg`) ran AFTER the release on every
// disconnect checked (09-25 10:08:21.100, 180 ms after it).
//
// ── THE MECHANISM (HYPOTHESIS — strongly supported, not reproduced on a device) ─────────────────────────────────────
// navNotification.startForegroundCarFeed checked `if (_fgCarWatch) return;` BEFORE its awaits and assigned
// `_fgCarWatch = await Location.watchPositionAsync(…)` AFTER them. carPlayBootstrap.onConnect calls it twice at once
// (through acquireBgLocation, and directly), so both callers passed the guard, two native watchers started, and the
// second assignment overwrote the first: that subscription was never removed by anything. Since build 79 the car
// watcher asks iOS for continuous background delivery (allowsBackgroundLocationUpdates, pausesUpdatesAutomatically
// false), so the orphan kept GPS on and the app alive for the life of the JS runtime. One orphan (Ni GR, 09-23) has
// no visible double start, so the fix is not "stop calling it twice": this owner is the ONLY creation path of a car
// watch, and it can reach every watch it made IN THIS JS CONTEXT. (A watch from a previous JS context — an in-process
// reload — is out of its reach; review 2026-09-25 found the reload paths gated off while CarPlay / Android Auto or
// turn-by-turn is live: 0 of 51 rt-1.29.0 restarts with CarPlay connected. Native half: CARPLAY.md §6c.)
//
// ── THE RULE ─────────────────────────────────────────────────────────────────────────────────────────────────────
//  • start() is single-flight: a caller that arrives while a start is in flight JOINS it. At most one live watch.
//  • stop() bumps the generation and removes EVERY subscription it holds (a Set), with NO delivery needed — a phone
//    lying still gets no callbacks through a 2 m distance filter, so a stop that waited for one would never land.
//  • a start that resolves after a stop (older generation), or when wanted() is false, is never kept.
//  • every delivery is checked: a subscription that is not the current one, or any delivery while wanted() is
//    false, removes itself and NEVER reaches onFix.
//
// ── THE NATIVE SETTLE (HYPOTHESIS from a source read, not reproduced) ─────────────────────────────────────────────
// expo-location 19.0.8 iOS (ios/LocationModule.swift) watchPositionImplAsync stores locationStreamers[watchId] and
// starts streamLocations() inside a detached `Task {}`; removeWatchAsync stops that streamer and then NILS the entry.
// A remove that lands before the Task has run would let the Task start CoreLocation afterwards with nothing
// tracking it. A second JS remove() cannot rescue that — VERIFIED by reading build/LocationSubscribers.js:
// unregisterCallback returns early once the callback is gone, so a repeat remove() never reaches native, and the
// native entry is nil anyway. So removal waits for the native start to have settled: a subscription younger than
// CAR_FEED_SETTLE_MS is NEUTRALISED at once (none of its deliveries reach onFix, and each delivery removes it — a
// delivery proves the native stream is up, so that remove cannot strand it) and removed when it is
// CAR_FEED_SETTLE_MS old (a timer, plus an opportunistic sweep on every start / stop / live() call in case JS timers
// are frozen). A subscription older than that — the car watch at the end of any real drive — is removed at once.
// ⚠ THIS IS NOT A GUARANTEE (Codex 2026-09-25): a young subscription with frozen timers and no delivery waits for the
// next owner call, and the native race itself cannot be closed from JS. The native fix is a build-80 item
// (CARPLAY.md §6c: serialize start/remove inside expo-location's LocationModule.swift / LocationsStreamer).
//
// Pure: no react-native / expo imports. The native watch, the clock and the timer are injected so
// tools/sim-qc/car_feed_leak_test.mts drives this exact code in plain node.

/** What a native watch hands back (expo's LocationSubscription has this shape). remove() may be called twice. */
export type WatchSub = { remove: () => void };

// How long a freshly-resolved native watch is left to settle before it is removed. 1000 ms: the window being covered
// is a detached Swift Task being scheduled after watchPositionImplAsync has already returned — no measurement exists
// (it cannot be observed from JS), so this is a chosen bound (review, 2026-09-25): one fix interval of the ~1 Hz iOS
// delivery measured for this feed (navNotification.ts, drive-time location note), far above a Task scheduling delay.
export const CAR_FEED_SETTLE_MS = 1000;
// Receipt budget per JS context for the `carfeed` rows. 20 = the loc-src receipt's own budget (navNotification.ts
// noteLocSource: "at most 20 per JS context"); a join is logged at every connect, so this covers a day of drives
// without letting a pathological loop spend Supabase rows (IO-constrained, memory supabase-disk-io-budget).
export const CAR_FEED_RECEIPT_MAX = 20;
// Budget for navNotification's `loc-release` receipt (one row each time the location lock's consumer set empties).
// Same 20 per JS context, same reason.
export const LOC_RELEASE_RECEIPT_MAX = 20;

type Later = (fn: () => void, ms: number) => unknown;

export type CarFeedDeps<L, S extends WatchSub> = {
  /** Start ONE native watch delivering to onLoc. Resolve null when it did not start (no permission). */
  watch: (onLoc: (loc: L) => void) => Promise<S | null>;
  /** Does anyone still hold the location lock? (navNotification: `_locConsumers.size > 0`) */
  wanted: () => boolean;
  /** The real per-fix work. Called only for the current, wanted subscription. */
  onFix: (loc: L) => void;
  /** A new subscription just became the current one. */
  onLive?: (sub: S) => void;
  log: (row: string) => void;
  now?: () => number;
  later?: Later;
};

export type CarFeedOwner = {
  /** Single-flight start. Resolves when the watch is up, joined, refused (unwanted / no permission) or raced. */
  start(): Promise<void>;
  /** Remove every subscription this owner holds. Synchronous; needs no delivery. */
  stop(): void;
  /** Native subscriptions this owner still holds (current + any neutralised one still settling). */
  live(): number;
};

type Entry<S> = { sub: S; bornAt: number; dead: boolean; removed: boolean };

/** A row logger that stops after `max` rows (per instance = per JS context). */
export function boundedLog(max: number, log: (row: string) => void): (row: string) => void {
  let rows = 0;
  return (row: string) => {
    if (rows >= max) return;
    rows += 1;
    try { log(row); } catch {}
  };
}

/**
 * Remove a watch subscription its owner no longer wants, without racing the native start (see the header): at once
 * when it is at least CAR_FEED_SETTLE_MS old, otherwise when it reaches that age. For a caller that owns exactly one
 * watch (app/(app)/map.tsx's phone watcher) and learns it is unwanted as the start resolves.
 */
// ⏱ Settle ages are MONOTONIC (Codex delta review 4): a wall clock that jumped forward must not make a young native watch
// look settled and get it removed before its stream started (a stranded GPS stream), and one that jumped back must not
// hold a removal for as long as the clock takes to catch up. performance.now(); Date.now() only if it is unavailable.
// This module stays import-free (tools/sim-qc loads it directly), so the clock lives here; a caller's `bornAt` must be
// settleNow() too (app/(app)/map.tsx's phone watcher).
export function settleNow(): number {
  try {
    const p = (globalThis as any).performance;
    const v = p && typeof p.now === "function" ? p.now() : NaN;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  } catch {}
  return Date.now();
}
export function removeWhenSettled(sub: WatchSub, bornAt: number, now: () => number = settleNow, later: Later = (fn, ms) => setTimeout(fn, ms)): void {
  const wait = CAR_FEED_SETTLE_MS - (now() - bornAt);
  const go = () => { try { sub.remove(); } catch {} };
  if (!(wait > 0)) go();
  else later(go, Math.min(wait, CAR_FEED_SETTLE_MS));
}

export function createCarFeedOwner<L, S extends WatchSub = WatchSub>(d: CarFeedDeps<L, S>): CarFeedOwner {
  const now = d.now ?? settleNow;
  const later: Later = d.later ?? ((fn, ms) => setTimeout(fn, ms));
  const receipt = boundedLog(CAR_FEED_RECEIPT_MAX, d.log);
  const held = new Set<Entry<S>>();
  let current: Entry<S> | null = null;
  let gen = 0;
  let inflight: { gen: number; p: Promise<void> } | null = null;

  // Fail CLOSED: if the question "is anyone still using the car feed?" cannot be answered, the answer is no.
  const wantedNow = (): boolean => { try { return !!d.wanted(); } catch { return false; } };

  const removeNow = (e: Entry<S>): void => {
    if (e.removed) return;
    e.removed = true;
    e.dead = true;
    held.delete(e);
    if (current === e) current = null;
    try { e.sub.remove(); } catch {}
  };
  // Neutralise now; remove now if the native start has settled, else when it has (see the header).
  const retire = (e: Entry<S>): void => {
    if (e.removed) return;
    const wasDead = e.dead;
    e.dead = true;
    if (current === e) current = null;
    const wait = CAR_FEED_SETTLE_MS - (now() - e.bornAt);
    if (!(wait > 0)) { removeNow(e); return; }
    if (!wasDead) later(() => removeNow(e), Math.min(wait, CAR_FEED_SETTLE_MS));
  };
  // Opportunistic: a settled, neutralised subscription is removed on the next start/stop even if its timer froze.
  const sweep = (): void => {
    for (const e of Array.from(held)) if (e.dead && now() - e.bornAt >= CAR_FEED_SETTLE_MS) removeNow(e);
  };

  const deliver = (box: { e: Entry<S> | null }, myGen: number, loc: L): void => {
    const e = box.e;
    if (!e) {
      // expo registers the JS callback BEFORE the native start resolves, so a fix can arrive first. It counts only
      // if nothing has been stopped since this start began and someone still wants the feed.
      if (myGen === gen && wantedNow()) d.onFix(loc);
      return;
    }
    if (e.dead || e !== current || !wantedNow()) {
      const why = e.dead ? "dead" : e !== current ? "stale" : "unwanted";
      removeNow(e);   // a delivery proves the native stream is up — removing it now cannot strand it
      receipt(`carfeed op=self-stop why=${why} live=${held.size}`);
      return;
    }
    d.onFix(loc);
  };

  function start(): Promise<void> {
    sweep();
    if (current) return Promise.resolve();
    if (!wantedNow()) return Promise.resolve();
    if (inflight && inflight.gen === gen) {
      receipt(`carfeed op=join`);
      return inflight.p;
    }
    const myGen = gen;
    const box: { e: Entry<S> | null } = { e: null };
    const p = (async () => {
      let sub: S | null = null;
      try { sub = await d.watch((loc: L) => deliver(box, myGen, loc)); } catch { sub = null; }
      if (!sub) return;
      const e: Entry<S> = { sub, bornAt: now(), dead: false, removed: false };
      box.e = e;
      held.add(e);
      if (myGen !== gen || current || !wantedNow()) {
        const why = myGen !== gen ? "stopped" : current ? "dup" : "unwanted";
        retire(e);
        receipt(`carfeed op=raced why=${why} live=${held.size}`);
        return;
      }
      current = e;
      try { d.onLive?.(sub); } catch {}
    })();
    const rec = { gen: myGen, p };
    inflight = rec;
    p.then(() => { if (inflight === rec) inflight = null; }, () => { if (inflight === rec) inflight = null; });
    return p;
  }

  function stop(): void {
    gen += 1;
    current = null;
    for (const e of Array.from(held)) retire(e);
    sweep();
  }

  return { start, stop, live: () => { sweep(); return held.size; } };
}
