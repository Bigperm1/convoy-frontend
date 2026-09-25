// src/carplay/AndroidAutoRoot.tsx
//
// The headless React root that react-native-carplay runs INSIDE the Android Auto
// car session. This is the piece that makes Android Auto actually work.
//
// Why this exists / how Android Auto bootstraps:
//   When a head unit connects, react-native-carplay's CarPlaySession (Kotlin)
//   does `AppRegistry.runApplication("AndroidAuto", ...)` and then sets the car
//   context (see node_modules/react-native-carplay/android/.../CarPlaySession.kt
//   and CarPlayModule.setCarContext). So the car UI must be built by an
//   AppRegistry component registered under the EXACT key "AndroidAuto"
//   (registered at app launch in registerAndroidAuto.ts). If that root doesn't
//   exist, the car connects but renders nothing — which is exactly why Android
//   Auto wasn't working: Convoy only ever built its car UI inside
//   useConvoyCarPlay (mounted by map.tsx), which doesn't run in the car session
//   and isn't even mounted unless the phone is on the map screen.
//
// iOS/CarPlay does NOT use this path — there, templates are built in the running
// app's JS context (useConvoyCarPlay). This root is Android-Auto-only.
//
// It renders no phone UI (returns null). The visible car surface is the
// CarSurface component handed to the NavigationTemplate (react-native-carplay
// registers it under the template id and renders it onto the car's map surface).
// Live drive data flows in through carStore, which map.tsx mirrors via
// useConvoyCarPlay while a route is active.

import { useMapView2DLocked } from '../mapViewMode';
import { useEffect, useRef } from 'react';
import { DeviceEventEmitter, NativeModules } from 'react-native';
import { CarSurface } from './ConvoyCarPlay';
import { useCarStore } from './carStore';
import { acquireBgLocation, releaseBgLocation, registerBgConsumerProbe, hydrateCarRouteFromDisk, startForegroundCarFeed } from '../navNotification';
import { startCarDataService, stopCarDataService } from './carDataService';
import { noteCarConnected } from '../locationPrivacy';
import { aaActionStrip, aaMapButtons, handleAaButton, carTap } from './carActions';
import { startCarStatus, stopCarStatus } from './carStatus';
import { isAskableStatus } from './carStatusRule';
import { logEventReliable } from '../crashBreadcrumb';
import { setCarSurfaceLive } from '../drawTelemetry';

// ── COLD-CONNECT TRACER (2026-08-18 night) ──────────────────────────────────
// The first-connect crash dies BETWEEN js-mark and every other instrument — no
// fatal, no bail, nothing. These crumbs (reliable delivery: the queue survives the
// process death and flushes `late` on the healthy relaunch) mark each stage of the
// connect path, so the NEXT crash names the stage it died in: the furthest crumb
// present is where it got to. Once per JS context per stage — a drive adds ≤4 rows.
const _crumbed: Record<string, boolean> = {};
function aaCrumb(stage: string): void {
  if (_crumbed[stage]) return;
  _crumbed[stage] = true;
  try { logEventReliable(`aa-crumb ${stage}`); } catch {}
}

// ── updateTemplate WORKS NOW, AND THAT CHANGED EVERYTHING (2026-07-30) ───────
// It used to be a silent no-op: CarPlayModule.kt looked up `carScreens[name]`
// with the MODULE name, which never matched, so nothing pushed from here reached
// androidx and every pixel of nav chrome on the head unit was our own CarSurface.
// BUILD 70 PATCHED THAT LOOKUP. So from build 70 onward androidx really does
// receive whatever we send — and it started drawing its OWN routing card and
// travel estimate ON TOP of the ones CarSurface already draws.
//
// That is exactly what Say Phin photographed and Jeff called out: a left-hand
// banner covering the speedo, and two ETAs on screen ("these seem redundant").
// The androidx docs are explicit — "unless set with this method, navigation info
// won't be displayed" — so the fix is simply NOT to send it. CarSurface owns the
// maneuver, the ETA and the speedo, exactly as it does on CarPlay, and androidx
// contributes only the button strips.
//
// ⚠ DO NOT reinstate navigationInfo / travelEstimate without deleting the
// equivalent rows from CarSurface first, or the duplicate banner comes straight
// back. The payload shapes that androidx parses are recorded in git history if
// that trade is ever revisited (parseNavigationInfo does getMap("info")!!,
// parseTravelEstimate does getMap("destinationTime")!! — both REQUIRED keys whose
// absence is an uncaught throw on the car's main thread).

// The car's buttons. androidx requires a NON-EMPTY action strip on a
// NavigationTemplate, which is why this used to be a single "Hairpin" title —
// a placeholder that was never replaced, and the reason Jeff kept reporting "AA
// buttons still missing" after they were added to the CarPlay template. THIS is
// the template Android Auto actually renders; ConvoyCarPlay's MapTemplate is the
// iOS/phone path and never reaches a head unit.
//   actions    -> ActionStrip     (up to 4; title OR icon)
//   mapButtons -> MapActionStrip  (up to 4; ICON ONLY — androidx rejects titles)
// Both reuse CarPlay's button ids so the existing handlers take them unchanged.

// How many times this JS process has set the car root. Rides the aa-stack rows so a
// SECOND Android Auto session in the same process is distinguishable from the first.
let _aaRootSets = 0;
// `aa-session op=start|end why=hold-<via>|mount|ctx|hold-off|disconnect|unmount` — one per session edge, at most 40 per
// process (a flapping head unit must not spend Supabase rows). Reliable: a car cold start logs before the Supabase
// client exists.
let _aaSessionRows = 0;
function aaSessionRow(msg: string): void {
  if (_aaSessionRows >= 40) return;
  _aaSessionRows += 1;
  try { logEventReliable(`aa-session ${msg}`); } catch {}
}

// ── ONE CAR SESSION = ONE ACQUIRE, ONE RELEASE (privacy, 2026-09-25 reviews 4 and 5) ───────────────────────────────
// Jeff, 2026-09-25: "it should not follow me when i discconect from car play... this is a privacy concern. fix it and
// lock it." The root below MOUNTS ONCE PER JS PROCESS (46 instances in 30 d, every `aa-stack op=root` is n=1, 0
// `op=root-unmount`) while CarPlaySession.kt runs AppRegistry.runApplication("AndroidAuto") into it for every car
// session — so a second session in one process used to assert nothing (review 4: 5 of 21 instrumented AA process
// lifetimes had 2–3 sessions). And a JS context that JOINS a live session through a reload (the red-pill Restart,
// ErrorRecovery) never runs the root at all: CarPlaySession re-runs nothing for a new ReactContext (review 5 —
// SMSGRC 2026-09-20, instance 89u9bd: `op=hold on=1 via=init` at 13:56:27 after an OTA Restart, no root until 15:05,
// the session's end at 14:31:56 witnessed by nobody, `draw-cmp … latch=1 hu=0` after arrival).
// So the session lives HERE, at module scope, keyed on native's own per-session receipt — CarJsKeepAlive's hold
// (react-native-carplay patch, utils/CarJsKeepAlive.kt): `op=hold on=1 via=acquire|join|regrab|init` is emitted only
// while a car session holds it (acquire at the session's onCreateScreen; init when a NEW ReactContext comes up under a
// live session — a reload, or a car-started cold boot), `op=hold on=0` only when the LAST session is destroyed. This
// module is required by registerAndroidAuto.ts during bundle evaluation, right after its own `aa-native` logger, so
// it hears what that logger hears. A session STARTS at `op=hold on=1` and ENDS at `op=hold on=0` or didDisconnect,
// each exactly once (_aaSessionAlive).
// COLD START: a head unit that connects and is destroyed while JS is still starting releases the hold with no JS
// context to hear it, and CarPlaySession's one-shot listener still runs the root and setCarContext (`op=ctx`) for the
// dead session afterwards (review 5, from the native code; 0 such rows in 30 d). So neither the mount nor `op=ctx`
// starts a session on a binary that emits hold receipts; the mount starts one only when native already reported the
// hold alive. On a binary that emits none (no setAaKeepAliveOptions, i.e. no CarJsKeepAlive — build 78), the mount and
// `op=ctx` start it as before. Gate: tools/sim-qc/car_feed_leak_test.mts AA (this module run for real).
let _aaSessionAlive = false;
// The last hold receipt this JS context heard (null: none yet), and whether this binary emits them at all.
let _aaNativeHold: boolean | null = null;
let _aaHoldReceipts = (() => { try { return typeof (NativeModules as any).RNCarPlay?.setAaKeepAliveOptions === 'function'; } catch { return false; } })();
function startAaSession(why: string): void {
  if (_aaSessionAlive) return;
  _aaSessionAlive = true;
  setCarSurfaceLive('androidauto', true);  // car-surface telemetry rows allowed until this session ends (2026-09-25)
  // THE head-unit signal for Android, once per SESSION — never per render. On build 70 nothing unmounted this root and
  // no didDisconnect arrived while startForegroundCarFeed kept writing positions into carStore (which re-renders
  // the root): a re-assert on render would keep the flag fresh after the car session ended and publish raw walking
  // GPS for the life of the process. The flag still lapses after CAR_CONNECT_TTL_MS (the gate then falls back to the
  // driving latch, the private direction).
  noteCarConnected(true, 'androidauto');
  void acquireBgLocation('androidauto');   // shared bg task + fg car feed
  startCarDataService();                   // cold peers + hazards (WS/Supabase/REST)
  startCarStatus('androidauto');           // car-screen "what is missing" + the Allow location action (build 79)
  void startForegroundCarFeed();           // continuous GPS writer for the car map — JOINS acquire's in-flight start (src/carFeedOwner.ts)
  void hydrateCarRouteFromDisk();          // persisted route ribbon on cold connect
  aaSessionRow(`op=start why=${why}`);
}
function endAaSession(why: string): void {
  if (!_aaSessionAlive) return;
  _aaSessionAlive = false;
  // The WITNESSED park first (the drive's latch drops), then the lock (every car watch, src/carFeedOwner.ts) and the
  // car-surface rows that carry coordinates. CARPLAY.md §6c.
  noteCarConnected(false, 'androidauto');
  void releaseBgLocation('androidauto');
  setCarSurfaceLive('androidauto', false);
  stopCarDataService();
  stopCarStatus();
  aaSessionRow(`op=end why=${why}`);
}
try {
  DeviceEventEmitter.addListener('aaNativeTrace', (e: any) => {
    const msg = String(e?.msg ?? '');
    const hold = /^op=hold on=([01])\b/.exec(msg);
    if (hold) {
      _aaHoldReceipts = true;
      _aaNativeHold = hold[1] === '1';
      if (_aaNativeHold) startAaSession(`hold-${/\bvia=(\w+)/.exec(msg)?.[1] ?? 'unknown'}`);
      else endAaSession('hold-off');
    } else if (!_aaHoldReceipts && /^op=ctx\b/.test(msg)) startAaSession('ctx');
  });
} catch {}
// Dead-man probe: the 'androidauto' hold is legitimate only while a car SESSION is live (see the carplay probe note —
// 2026-08-26 background-GPS leak). Module scope: a context that joined a session through a reload never mounts the root.
registerBgConsumerProbe('androidauto', () => _aaSessionAlive);

export default function AndroidAutoRoot() {
  // FIRST RENDER = the native session actually ran this root (AppRegistry
  // .runApplication from CarPlaySession). Death before this row = native session
  // create / register; after = our JS tree.
  aaCrumb('root-render');
  const s = useCarStore();
  const templateRef = useRef<any>(null);
  // Build 79 (2026-09-14): while location is askable from the car, the strip carries "Allow location"
  // (carActions.aaActionStrip). A boolean, so the updateTemplate effect below re-runs only on the flip.
  const askable = isAskableStatus(s.carStatus);
  // A Free / Silver car on the road keeps the map 2D and the strip's view button becomes the 3D tease
  // (carActions aaActionStrip). Rebuilt through the SAME updateTemplate path below when the Garage pick changes
  // mid-session (Jeff, 2026-09-23: "change the 2d button to 3d to entice the free silver users").
  const locked2D = useMapView2DLocked();

  // Build the single navigation template once and make it the car's root.
  useEffect(() => {
    try {
      // Lazy require: react-native-carplay runs native side effects at import,
      // so we never pull it into the web/iOS evaluation path. registerAndroidAuto
      // only mounts this root on Android with the native module present.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CarPlay, NavigationTemplate } = require('react-native-carplay');
      const template = new NavigationTemplate({
        id: 'convoy-aa-nav',
        component: CarSurface,
        actions: aaActionStrip(),
        mapButtons: aaMapButtons(),
        onButtonPressed: (e: { buttonId: string }) => {
          const id = e?.buttonId;
          // Do NOT carTap here when we have an id: handleAaButton always lands in
          // handleCarMapButton or handleCarBarButton, and BOTH already open with
          // carTap(id). Say Phin's 07:36 receipts show every press logged exactly
          // twice, ~15ms apart — that was this line doubling every row and
          // re-arming the toast. The action itself only ever ran once.
          if (!id) { carTap('aa-unknown'); return; }
          handleAaButton(id);
        },
      } as any);
      templateRef.current = template;
      CarPlay.setRootTemplate(template);
      // ── WHY THIS ROW EXISTS AND aa-crumb DOES NOT COVER IT (2026-09-09) ─────────────
      // Say Phin's head unit shows CarPlaySession's own "RNCarPlay loading..." root
      // placeholder for a whole drive while this tree renders normally — on 09-09 the car
      // surface drew 36 ribbon and 25 camera frames on the bundle that carries the first
      // aa-stack rows, and logged nothing, because those rows only covered the SEARCH
      // screen and he never opened search. That was my miss.
      // aa-crumb cannot fill the gap: the crumbs are deduped at MODULE scope, so
      // 'template-set' fires once per JS PROCESS. Android Auto can start a second session
      // in the same process (the phone app and this root share one ReactHost), and on that
      // second session the crumb is silent while this effect really does re-run. This row
      // is per-mount and counted, so "did we set our root on THIS connect" is answerable —
      // and, paired with the absence of any `op=pop`, it says whether OUR JS ever moved the
      // stack at all. A session with op=root and no op=pop that still shows the placeholder
      // puts the fault on the native side, which is a real answer rather than a guess.
      //
      // ⚠ READ PRESENCE, NOT ABSENCE (Codex adversarial review, 2026-09-09). A row that
      // ARRIVES is proof this ran. A row that is MISSING is NOT proof it did not: when the
      // direct insert cannot go out, the fallback is a bounded 25-row FIFO shared with crash
      // reports and up to 12 harvested updates-log rows per launch, so an offline or
      // crash-looping drive can evict this row before it is ever delivered. Classify a
      // session with no op=root as UNKNOWN, never as "our JS never set the root".
      _aaRootSets += 1;
      // logEventReliable, NOT logEvent: plain logEvent returns early and DROPS the row
      // outright while the Supabase client is still being constructed — the normal state on
      // an Android Auto cold connect, i.e. exactly when this fires. That is the difference
      // between a row that is merely delayed and one that never existed, and it is why the
      // caveat above is a caveat and not a dead loss. Contract: src/crashBreadcrumb.ts.
      try { logEventReliable(`aa-stack op=root id=convoy-aa-nav n=${_aaRootSets}`); } catch {}
      aaCrumb('template-set');
    } catch (e) {
      console.warn('[AndroidAuto] root template setup failed', e);
      // A swallowed template failure is a blank car screen with no telemetry —
      // the exact invisibility class the receipt chain fixed on iOS.
      try { logEventReliable(`aa-crumb template-threw ${String((e as any)?.message || e).slice(0, 100)}`); } catch {}
      try { logEventReliable(`aa-stack op=root-threw n=${_aaRootSets}`); } catch {}
    }
    return () => {
      templateRef.current = null;
      // Pairs with op=root: a root that is set and then torn down inside one drive is a
      // remount, which nothing has ever been able to see from the outside.
      try { logEventReliable('aa-stack op=root-unmount'); } catch {}
    };
  }, []);

  // ---- DATA/LOCATION FEED BOOTSTRAP (Android parity with iOS's
  // carPlayBootstrap.onConnect — 2026-07-16 deep dive) ----
  // carPlayBootstrap early-returns on Android, so nothing used to start the
  // GPS/peers/hazards/route feeds on an Android Auto connect: carStore stayed
  // empty unless the PHONE was sitting on the map screen or actively
  // navigating — a cold AA connect showed a fixless surface with no convoy.
  // This root's mount IS the correct trigger: CarPlaySession (Kotlin) runs the
  // "AndroidAuto" AppRegistry root ONLY when a real car session starts, so
  // (unlike the library's didConnect event, which fires spuriously at every
  // Android app launch — see ANDROID_SPURIOUS_CONNECT_GUARD_MS) starting feeds
  // here can never leak GPS onto a phone with no car attached. All four calls
  // are platform-agnostic; released/stopped when the car session unmounts.
  // (Since 2026-09-25 the trigger is native's per-session hold receipt, not this mount alone — see "ONE CAR SESSION"
  // at module scope: the mount runs once per process and also for a session that died during a cold start.)
  // ── RELEASE THE LOCATION HOLD WHEN THE CAR SESSION ACTUALLY ENDS ───────────
  // The cleanup below only runs if this React root UNMOUNTS, and nothing ever unmounts
  // it: CarPlaySession.onDestroy was a no-op upstream and the library has no
  // unmountApplicationComponentAtRootTag. This root shares the app's ReactHost — the
  // same JS context and the same _locConsumers Set as the phone — so once 'androidauto'
  // was in that Set, releaseBgLocation's size-0 gate made stopping the location feeds
  // unreachable for the life of the process. A tester measured 2 h 08 m of GPS against
  // 21 minutes of screen time; the foreground service kept the process alive and the
  // stall watchdog rebuilt the feeds every 25 s, so it never healed.
  //
  // The native half of the fix (patches/react-native-carplay) makes onDestroy emit
  // didDisconnect. This is the half that listens. NEEDS BUILD 71 — the event cannot
  // fire on an existing binary, so on build 70 this is inert and harmless.
  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CarPlay } = require('react-native-carplay');
      // Every session end (fires per session: the listener lives as long as this root). The head-unit flag is
      // released here too (2026-08-15): otherwise only CAR_CONNECT_TTL_MS would end the 'attached' claim — a 90 s
      // window of raw live coordinates for someone who has just parked and walked away.
      const onDisconnect = () => endAaSession('disconnect');
      CarPlay.registerOnDisconnect?.(onDisconnect);
      off = () => { try { CarPlay.unregisterOnDisconnect?.(onDisconnect); } catch {} };
    } catch {}
    return () => { if (off) off(); };
  }, []);

  useEffect(() => {
    aaCrumb('root-mount');
    // The mount starts a session only when native has reported one alive, or on a binary with no hold receipts (see
    // "ONE CAR SESSION" above): CarPlaySession also runs this root for a session destroyed during a cold start.
    if (!_aaHoldReceipts || _aaNativeHold === true) startAaSession('mount');
    return () => endAaSession('unmount');
  }, []);

  // Re-assert the surface + buttons when the drive state (or, build 79, the askable state) flips. No nav payload is
  // sent (see the header) — CarSurface draws all of it — so this exists only to keep
  // the template alive across a route start/end.
  useEffect(() => {
    const template = templateRef.current;
    if (!template) return;
    try {
      // Keep the surface and the buttons alive; send NO navigationInfo or
      // travelEstimate (see the header) so androidx draws no chrome of its own.
      template.updateTemplate({
        component: CarSurface,
        actions: aaActionStrip(),
        mapButtons: aaMapButtons(),
      } as any);
    } catch (e) {
      console.warn('[AndroidAuto] updateTemplate failed', e);
    }
    // `askable` (build 79): swap 2D/3D <-> "Allow location" through this SAME updateTemplate path —
    // never a push or pop, which has evicted the driver to the app drawer (memory
    // aa-poptotemplate-evicts-driver). A native parse failure is caught in CarPlayModule.updateTemplate
    // and leaves the old strip in place.
  }, [s.navigating, askable, locked2D]);

  return null;
}
