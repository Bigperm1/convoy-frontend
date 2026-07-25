// src/carplay/carPlayBootstrap.ts
//
// App-root CarPlay bootstrap (iOS only). Run at startup from index.js.
// Sets a minimal idle root MapTemplate AND acquires the SHARED background-
// location task (navNotification.acquireBgLocation) so carStore.selfLat/selfLng
// is fed on a cold connect and CarSurface can draw the map. Uses the BACKGROUND
// task, not foreground watchPositionAsync, because iOS starves foreground
// location once the app is backgrounded behind the head unit. The task is
// refcounted/shared with the nav banner so they never fight over iOS's single
// background-location slot.

import { NativeModules, Platform, AppState, processColor } from 'react-native';
import * as Location from 'expo-location';
import { carPlayHookOwnsRoot } from './carPlayShared';
import { setCarState, getCarState, emitCarGesture } from './carStore';
import { acquireBgLocation, releaseBgLocation, hydrateCarRouteFromDisk, startForegroundCarFeed } from '../navNotification';
import { startCarDataService, stopCarDataService } from './carDataService';
import { CAR_BAR_BUTTON_CONFIG, CAR_MAP_BUTTON_CONFIG, handleCarBarButton, handleCarMapButton } from './carActions';

let booted = false;

export function initCarPlayBootstrap(): void {
  if (Platform.OS !== 'ios' || booted) return;
  if (!(NativeModules as any).RNCarPlay) return;
  booted = true;

  let lib: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    lib = require('react-native-carplay');
  } catch {
    return;
  }
  const { CarPlay, MapTemplate } = lib;
  if (!CarPlay || !MapTemplate) return;

  setCarState({ cpDbg: 'boot' });

  const setIdleRoot = () => {
    if (carPlayHookOwnsRoot) { setCarState({ cpDbg: 'idle:SKIP(hookOwns)' }); return; }
    try {
      const t = new MapTemplate({
        id: 'convoy-carplay-idle',
        tabTitle: 'Map',
        tabSystemImageName: 'map',
        // processColor(), NOT a hex string: [RCTConvert UIColor:] accepts only
        // NSArray / NSNumber / NSDictionary (RCTConvert.mm:936+) — an NSString falls
        // through and returns NIL. And because the KEY is present, RNCarPlay.m:947
        // takes the if-branch and skips its own systemGray5 fallback, so we were
        // calling setGuidanceBackgroundColor:nil on a property the SDK declares
        // nonnull (CPMapTemplate.h:63). processColor returns the ARGB NSNumber the
        // NSNumber branch expects.
        guidanceBackgroundColor: processColor('#0B0B0C'),
        tripEstimateStyle: 'dark',
        // Wave 3: Search / Police / End on the map template's NAV-BAR — the
        // chrome layer that actually renders + taps on the head unit (the round
        // CPMapButtons don't; see carActions.ts header). Cold-capable: these
        // handlers run entirely at module scope.
        ...CAR_BAR_BUTTON_CONFIG,
        onBarButtonPressed: ({ id }: { id: string }) => handleCarBarButton(id),
        // Round CPMapButtons (zoom ± / Scout mic) — SF symbols via the build-65
        // systemImage patch (custom PNGs resolve nil under bridgeless; see
        // carActions.CAR_MAP_BUTTON_CONFIG). Ignored harmlessly on older builds.
        ...CAR_MAP_BUTTON_CONFIG,
        onMapButtonPressed: ({ id }: { id: string }) => handleCarMapButton(id),
        // iOS-26 pinch/zoom — the COLD root was missing these entirely, so a driver
        // who connected the head unit without opening the phone app first had no
        // pinch at all (the warm root in ConvoyCarPlay.tsx has had them since
        // d704ced). Same gesture bus, so CarMapView biases its follow-zoom
        // identically on both roots. Harmless below iOS 26 — the native delegate
        // methods are API_AVAILABLE(ios 26.0) and simply never fire.
        onDidBeginZoomGesture: () => emitCarGesture({ kind: 'zoomBegin' }),
        onDidUpdateZoomGesture: (e: { scale: number; velocity: number }) =>
          emitCarGesture({ kind: 'zoom', scale: e?.scale ?? 1, velocity: e?.velocity ?? 0 }),
        onDidEndZoomGesture: (e: { velocity: number }) =>
          emitCarGesture({ kind: 'zoomEnd', velocity: e?.velocity ?? 0 }),
      });
      CarPlay.setRootTemplate(t);
      setCarState({ cpDbg: 'idle:SET conn=' + (CarPlay.connected ? '1' : '0') });
    } catch (e: any) {
      // Full error + stack to the device log — the on-screen breadcrumb truncates,
      // and this throw is what prevents any CPMapTemplate from ever being created.
      try {
        console.error('[cpdiag] setIdleRoot THREW:', e?.message || String(e), '\nSTACK:\n' + (e?.stack || '(no stack)'));
      } catch {}
      setCarState({ cpDbg: 'idle:THREW ' + String(e?.message || e).slice(0, 40) });
    }
  };

  const onConnect = () => {
    setIdleRoot();
    void acquireBgLocation('carplay');
    // Cold-capable PEERS + HAZARDS feeds (CarPlay-standalone Wave 1): WebSocket +
    // Supabase presence/Realtime + REST backstops, module-scope — the head unit
    // shows the convoy and hazards even when map.tsx never mounted. Coexists with
    // the warm phone mirror via the carStore freshness gates.
    startCarDataService();
    // ALSO start the continuous foreground feed directly on connect — independent of
    // map.tsx (which may be unmounted behind CarPlay) and of acquireBgLocation's
    // permission branch. It self-guards (idempotent) and is released with the shared
    // lock on disconnect. This is the main-context writer that keeps the car's GPS
    // fix alive while the phone is in the mount / foreground.
    void startForegroundCarFeed();
    // Cold connect: pull the persisted active-route polyline into carStore so the
    // car map draws the real ribbon even though the phone map isn't mounted.
    void hydrateCarRouteFromDisk();
    // Seed an immediate fix so hasFix flips true at once (instead of waiting for the
    // first watch tick). BOUNDED RETRY: race past a single cold-GPS miss; stop as soon
    // as any feed has landed a fix. Errors are surfaced to carDbg (shown on the car
    // overlay) instead of being silently swallowed — so a failure self-reports on screen.
    void (async () => {
      const fg = await Location.getForegroundPermissionsAsync().catch(() => ({ granted: false }));
      if (!fg.granted) { setCarState({ carDbg: 'seed:no-fg-perm' }); return; }
      const acc = Location.Accuracy.Balanced; // read enum ONCE, outside the catch
      for (let i = 0; i < 8 && CarPlay.connected && getCarState().selfLat == null; i++) {
        try {
          const p = (await Location.getLastKnownPositionAsync())
            ?? (await Location.getCurrentPositionAsync({ accuracy: acc }));
          if (p?.coords) {
            const h = p.coords.heading;
            const sp = p.coords.speed;
            setCarState({
              selfLat: p.coords.latitude,
              selfLng: p.coords.longitude,
              heading: typeof h === 'number' && h >= 0 ? h : null,
              speedMs: typeof sp === 'number' && sp >= 0 ? sp : 0,
              carDbg: 'seed:ok#' + i,
            });
            break;
          }
        } catch (e) { setCarState({ carDbg: 'seed:err#' + i + ':' + String(e).slice(0, 40) }); }
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();
  };

  const onDisconnect = () => {
    void releaseBgLocation('carplay');
    stopCarDataService();
  };

  // COLD-CONNECT BELT + CORRECTED ROOT-CAUSE NOTE (rewritten 2026-07-19).
  //
  // ⚠ The note that used to live here claimed bridgeless nils `cp.bridge`, so
  // RNCarPlay's `didConnect` emit (guarded by `if (cp.bridge)`) is dropped, no
  // template is ever presented, and THAT is why CarPlay has no input channel.
  // THAT WAS WRONG — and because it was written as fact, three separate audits
  // re-derived it from this comment and it nearly bought a native build. Verified
  // against the RN 0.81 source actually on disk:
  //   • RCTEventEmitter declares a readwrite `bridge` property (RCTEventEmitter.h:16)
  //     with no manual accessors, so it is auto-synthesized.
  //   • Bridgeless RCTInstance constructs an RCTBridgeProxy (RCTInstance.mm:303/326)
  //     and RCTTurboModuleManager assigns it via setValue:forKey:@"bridge"
  //     (RCTTurboModuleManager.mm:683-703).
  //   → `cp.bridge` is NON-nil on a warm connect, the guard PASSES, didConnect DOES
  //     fire and setRootTemplate DOES run. (sendEventWithName never needed the bridge
  //     anyway — it dispatches through _callableJSModules.)
  //
  // The REAL cause of "CarPlay does nothing when I touch it": every confirmation
  // routed through `CarPlay.bridge.toast()`, which has ZERO occurrences in
  // ios/RNCarPlay.m (it is Android-only) and was swallowed by `?.` + try/catch — so a
  // WORKING nav-bar button was indistinguishable from a dead one. Fixed in
  // carActions.carAlert() (real CPAlertTemplate). See that function's comment.
  //
  // This poll STAYS: it is idempotent, self-cancels at the CarPlay.connected check,
  // and still covers the genuine COLD case where CarSceneDelegate mints the singleton
  // before TurboModuleManager has set `bridge` — there the guard CAN legitimately drop
  // the emit, and checkForConnection() (not bridge-guarded) recovers it.
  let pokes = 0;
  const poke = () => {
    pokes += 1;
    const b = (CarPlay as any).bridge;
    // Record WHY a poke did nothing: missing bridge vs missing method vs it ran.
    const how = !b ? 'NOBRIDGE' : (typeof b.checkForConnection !== 'function' ? 'NOFN' : 'ok');
    try { b?.checkForConnection?.(); } catch {}
    setCarState({ cpDbg: 'poke#' + pokes + ':' + how + ' conn=' + (CarPlay.connected ? '1' : '0') });
  };
  let poll: any = null;
  const ensurePolling = () => {
    if (poll || CarPlay.connected) return;
    poll = setInterval(() => {
      if (CarPlay.connected) { clearInterval(poll); poll = null; return; }
      poke();
    }, 3000);
  };

  try {
    CarPlay.registerOnConnect(() => { setCarState({ cpDbg: 'onConnect:FIRED' }); if (poll) { clearInterval(poll); poll = null; } onConnect(); });
    CarPlay.registerOnDisconnect(() => { onDisconnect(); ensurePolling(); });
    setCarState({ cpDbg: 'wired conn=' + (CarPlay.connected ? '1' : '0') });
    if (CarPlay.connected) onConnect(); else { poke(); ensurePolling(); }
    // A head unit connecting often brings the app active — re-poke then, and resume
    // polling in case it had stopped.
    AppState.addEventListener('change', (s) => { if (s === 'active' && !CarPlay.connected) { poke(); ensurePolling(); } });
  } catch {
    // react-native-carplay not ready yet — ignore; the hook covers the warm path.
  }
}
