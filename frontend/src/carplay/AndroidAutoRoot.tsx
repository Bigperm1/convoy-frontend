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

import { useEffect, useRef } from 'react';
import { CarSurface } from './ConvoyCarPlay';
import { useCarStore } from './carStore';
import { acquireBgLocation, releaseBgLocation, hydrateCarRouteFromDisk, startForegroundCarFeed } from '../navNotification';
import { startCarDataService, stopCarDataService } from './carDataService';
import { noteCarConnected } from '../locationPrivacy';
import { AA_ACTION_STRIP, AA_MAP_BUTTONS, handleAaButton, carTap } from './carActions';
import { logEventReliable } from '../crashBreadcrumb';

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

export default function AndroidAutoRoot() {
  // FIRST RENDER = the native session actually ran this root (AppRegistry
  // .runApplication from CarPlaySession). Death before this row = native session
  // create / register; after = our JS tree.
  aaCrumb('root-render');
  const s = useCarStore();
  const templateRef = useRef<any>(null);

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
        actions: AA_ACTION_STRIP,
        mapButtons: AA_MAP_BUTTONS,
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
      aaCrumb('template-set');
    } catch (e) {
      console.warn('[AndroidAuto] root template setup failed', e);
      // A swallowed template failure is a blank car screen with no telemetry —
      // the exact invisibility class the receipt chain fixed on iOS.
      try { logEventReliable(`aa-crumb template-threw ${String((e as any)?.message || e).slice(0, 100)}`); } catch {}
    }
    return () => {
      templateRef.current = null;
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
      const onDisconnect = () => {
        void releaseBgLocation('androidauto');
        stopCarDataService();
        // RELEASE THE HEAD-UNIT FLAG TOO (2026-08-15). Without this the only thing
        // ending the 'attached' claim after a real disconnect is CAR_CONNECT_TTL_MS
        // expiring — a 90 s window in which the gate would still publish raw live
        // coordinates for someone who has just parked and walked away. The mount
        // asserts it, so the disconnect is the matching release; the TTL stays as the
        // backstop for the case this event never arrives (build 70, where the native
        // emit does not exist).
        noteCarConnected(false);
      };
      CarPlay.registerOnDisconnect?.(onDisconnect);
      off = () => { try { CarPlay.unregisterOnDisconnect?.(onDisconnect); } catch {} };
    } catch {}
    return () => { if (off) off(); };
  }, []);

  useEffect(() => {
    aaCrumb('root-mount');
    void acquireBgLocation('androidauto');   // shared bg task + fg car feed
    startCarDataService();                   // cold peers + hazards (WS/Supabase/REST)
    void startForegroundCarFeed();           // continuous GPS writer for the car map
    void hydrateCarRouteFromDisk();          // persisted route ribbon on cold connect
    // THE head-unit signal for Android. This root's MOUNT is the only trustworthy proof
    // a car session exists: CarPlaySession (Kotlin) runs it natively and only then —
    // unlike the library's didConnect, which fires at every phone launch with no car
    // (CarPlayModule.kt checkForConnection() emits it unconditionally). So
    // locationPrivacy learns 'attached' from here and never from the phone screen's
    // CarPlay.connected.
    //
    // ⚠ ASSERTED ONCE, DELIBERATELY — do NOT add a per-render re-assert. On build 70
    // nothing unmounts this root and no didDisconnect arrives, while startForegroundCarFeed
    // keeps writing positions at 1 s / 5 m (navNotification.ts:670-688) into carStore,
    // which re-renders this root. A re-assert on render would therefore keep the flag
    // permanently fresh AFTER the car session ended and publish raw walking GPS for the
    // life of the process — the same 'the writer keeps lying so the TTL never decays'
    // failure that was just removed from app/(app)/map.tsx. Instead the flag lapses after
    // CAR_CONNECT_TTL_MS and the gate falls back to the driving latch, which is the
    // private direction.
    noteCarConnected(true);
    return () => {
      void releaseBgLocation('androidauto');
      stopCarDataService();
      noteCarConnected(false);
    };
  }, []);

  // Re-assert the surface + buttons when the drive state flips. No nav payload is
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
        actions: AA_ACTION_STRIP,
        mapButtons: AA_MAP_BUTTONS,
      } as any);
    } catch (e) {
      console.warn('[AndroidAuto] updateTemplate failed', e);
    }
  }, [s.navigating]);

  return null;
}
