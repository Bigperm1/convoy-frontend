// driveFeed — the drive-time location request every head-unit feed makes, and the rule for
// rebuilding a live feed when the driver flips Lite GPS. PURE: no React, no expo, node-gated by
// tools/sim-qc/drive_feed_test.mts. src/navNotification.ts owns the subscriptions and injects the
// native calls into reliteDriveFeeds() so the async races are gated too.
//
// ── WHY (2026-09-10, Jeff: "how do the big 3 do the GPS?") ────────────────────────────────
// Apple, Google and Mapbox do the sensor fusion in the OS / native layer and map-match on top;
// none integrates a gyro in app code. Our CarPlay watcher and the background NAV_TASK asked expo
// for `Accuracy.High` = kCLLocationAccuracyNearestTenMeters (expo-location LocationAccuracy.swift)
// at 1 s / 5 m — the ONLY feed the car surface has on a locked phone — while the phone's own
// watcher already ran BestForNavigation at 500 ms / 2 m. Every feed now asks for the same thing.
//
// ── THE LITE GPS RULE (Codex review, 2026-09-10, two passes) ──────────────────────────────
// The phone watcher re-subscribes when `settings.liteGps` changes (map.tsx dep array). The
// head-unit feeds are module-scope singletons that only read the setting when they START, and
// `getSettings()` returns the DEFAULTS until the AsyncStorage hydration lands — so a cold CarPlay
// connect could start at BestForNavigation for a driver who chose Lite GPS, and a mid-drive toggle
// changed nothing on the head unit. Pass 2 found two races in the first fix: ONE shared "applied"
// flag cannot describe two feeds that started with different values (a toggle landing between the
// two starts hid the mismatch for good), and a rebuild in flight had no post-start consumer guard,
// so a release during the restart could leave a feed running with nobody holding the lock. Hence:
//  • each feed carries its OWN applied value, committed only after its native start succeeded
//    (`lite: null` = the feed is up but this JS session never started it — an inherited task);
//  • the plan compares each LIVE feed against the current setting; an unknown-mode feed is
//    rebuilt only on an actual toggle (`changed`), never on an unrelated settings notify;
//  • reliteDriveFeeds re-checks the consumer count after every await and tears everything down
//    if the last consumer left mid-rebuild — the same guard acquireBgLocation carries.

export type DriveFeedAccuracy = "bfn" | "high";

export type DriveFeedOptions = {
  accuracy: DriveFeedAccuracy;   // "bfn" = BestForNavigation (OS-fused); "high" = the Lite GPS opt-down
  timeInterval: number;          // ms — ANDROID ONLY: expo's iOS options carry accuracy + distanceInterval; iOS delivers ~1 Hz (measured)
  distanceInterval: number;      // m
  lite: boolean;
};

/**
 * The request for a drive-time feed — the same numbers as the phone's own watcher (map.tsx), so
 * every surface asks the OS for the same thing. Lite GPS = the driver's battery escape hatch.
 *  iOS: "bfn" is kCLLocationAccuracyBestForNavigation (OS sensor fusion), "high" is NearestTenMeters;
 *       timeInterval is ignored by expo's iOS provider, and delivery under BestForNavigation measured
 *       ~1 Hz on Jeff's rows (refuter 2026-09-10) — the "2 Hz" was never real on iOS.
 *  Android: BOTH enums map to PRIORITY_HIGH_ACCURACY on the fused provider; the explicit
 *       timeInterval / distanceInterval override expo's per-enum defaults (LocationHelpers.kt:113-117),
 *       so there the change is 1000→500 ms and 5→2 m, not a "mode".
 */
export function driveFeedOptions(lite: boolean): DriveFeedOptions {
  return lite
    ? { accuracy: "high", timeInterval: 1000, distanceInterval: 8, lite: true }
    : { accuracy: "bfn", timeInterval: 500, distanceInterval: 2, lite: false };
}

/** One feed as the owner sees it: is it up, and which Lite value did THIS session start it with
 *  (null = unknown: not started by this JS session, or not up). */
export type DriveFeedState = { up: boolean; lite: boolean | null };

export type DriveFeedRebuildPlan = { fg: boolean; bg: boolean };

/**
 * Which live feeds to rebuild.
 *  liteNow   — the Lite GPS value in settings right now
 *  changed   — this evaluation follows an ACTUAL liteGps transition (false for post-start checks
 *              and for the unrelated notifies every updateSettings() sends)
 *  consumers — surfaces holding the shared location lock (0 = nothing should be running)
 *  fg / bg   — the two feeds
 * A feed that is down stays down (its owner restarts it through the normal path).
 */
export function driveFeedRebuildPlan(a: {
  liteNow: boolean; changed: boolean; consumers: number; fg: DriveFeedState; bg: DriveFeedState;
}): DriveFeedRebuildPlan {
  if (a.consumers <= 0) return { fg: false, bg: false };
  const need = (f: DriveFeedState) => f.up && (f.lite == null ? a.changed : f.lite !== a.liteNow);
  return { fg: need(a.fg), bg: need(a.bg) };
}

/**
 * The cheap synchronous pre-check the settings listener runs: is there ANY chance a rebuild is
 * needed? The background task's up-ness costs a native call, so it is judged by its applied value
 * here and by hasStartedLocationUpdatesAsync inside reliteDriveFeeds.
 */
export function driveFeedNeedsRelite(a: {
  liteNow: boolean; changed: boolean; consumers: number; fg: DriveFeedState; bgLite: boolean | null;
}): boolean {
  if (a.consumers <= 0) return false;
  const fgNeeds = a.fg.up && (a.fg.lite == null ? a.changed : a.fg.lite !== a.liteNow);
  const bgMaybe = a.changed || (a.bgLite != null && a.bgLite !== a.liteNow);
  return fgNeeds || bgMaybe;
}

export type ReliteDeps = {
  liteNow: boolean;
  changed: boolean;
  consumers: () => number;                 // live count of lock holders
  fg: () => DriveFeedState;                // live foreground-watch state
  bgOn: () => Promise<boolean>;            // hasStartedLocationUpdatesAsync
  bgLite: () => boolean | null;            // the value this session started the task with
  restartFg: () => Promise<void>;          // stop + start; the start commits its own applied value
  restartBg: () => Promise<void>;          // force stop + start; likewise
  teardown: () => Promise<void>;           // stop everything: the last consumer left mid-rebuild
  log: (row: string) => void;
};

export type ReliteResult = "none" | "done" | "aborted";

/**
 * Rebuild the live feeds that no longer match the setting. Serialized by the caller (one chain).
 * Re-checks the consumer count after EVERY await: a release that lands mid-rebuild wins, and the
 * feeds this call may have brought back are torn down again (Codex pass 2, finding 2).
 */
export async function reliteDriveFeeds(d: ReliteDeps): Promise<ReliteResult> {
  const bgOn = await d.bgOn();
  if (d.consumers() === 0) return "aborted";
  const plan = driveFeedRebuildPlan({
    liteNow: d.liteNow, changed: d.changed, consumers: d.consumers(),
    fg: d.fg(), bg: { up: bgOn, lite: d.bgLite() },
  });
  if (!plan.fg && !plan.bg) return "none";
  d.log(`nav-loc relite lite=${d.liteNow ? 1 : 0} fg=${plan.fg ? 1 : 0} bg=${plan.bg ? 1 : 0}`);
  if (plan.fg) {
    await d.restartFg();
    if (d.consumers() === 0) { await d.teardown(); return "aborted"; }
  }
  if (plan.bg) {
    await d.restartBg();
    if (d.consumers() === 0) { await d.teardown(); return "aborted"; }
  }
  return "done";
}
