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
import { acquireBgLocation, releaseBgLocation, registerBgConsumerProbe, hydrateCarRouteFromDisk, startForegroundCarFeed } from '../navNotification';
import { startCarDataService, stopCarDataService } from './carDataService';
import { CAR_BAR_BUTTON_CONFIG, CAR_MAP_BUTTON_CONFIG, handleCarBarButton, handleCarMapButton } from './carActions';
import { logEventReliable } from '../crashBreadcrumb';

let booted = false;

export function initCarPlayBootstrap(): void {
  if (Platform.OS !== 'ios' || booted) return;
  // ⚠ EVERY BAIL BELOW USED TO BE SILENT, and that cost a drive (2026-08-15). This
  // function registers the COLD root's onBarButtonPressed. If it returns early, every
  // CarPlay button is dead — no crash, no message, nothing in telemetry — which is
  // indistinguishable from "the taps never reach JS" and sends the next investigation
  // straight at the native template layer. It is the difference between an OTA fix and
  // a paid build, so the reason has to be on the record. One row per launch, iOS only.
  // Reliable delivery (2026-08-16): plain logEvent silently DROPS rows while the
  // Supabase client is not constructed yet — the normal state at app-root time, i.e.
  // exactly when this function runs on a CarPlay-first cold launch. Every bail row
  // logged here before this change could have vanished for that boring reason, so
  // "zero bail rows" never proved the bootstrap didn't bail. logEventReliable queues
  // to disk and delivers `late` when the client can't take the insert.
  const bail = (why: string) => { try { logEventReliable(`carplay-bootstrap-bail ${why}`); } catch {} };
  if (!(NativeModules as any).RNCarPlay) { bail('no-native-module'); return; }
  booted = true;

  let lib: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    lib = require('react-native-carplay');
  } catch (e) {
    bail(`require-threw ${String((e as any)?.message || e).slice(0, 120)}`);
    return;
  }
  const { CarPlay, MapTemplate } = lib;
  if (!CarPlay || !MapTemplate) {
    bail(`missing-export carplay=${!!CarPlay} maptemplate=${!!MapTemplate}`);
    return;
  }

  setCarState({ cpDbg: 'boot' });

  // THE POSITIVE RECEIPT CHAIN (2026-08-16, HANDOFF-48H §2.2's "single most important
  // instrument gap"). The bail rows log only FAILURE, and silence cannot distinguish
  // "bootstrap succeeded" from "this code never ran" — which left the dead-buttons
  // investigation unable to trust absence. These rows are OBSERVATIONS of each link
  // in the chain a working button depends on, recorded from library/system state, not
  // from our own success flags (an instrument that computes its answer from its own
  // input cannot contradict you — §9). Once per JS context per link, so a drive adds
  // at most four rows. Expected healthy cold sequence:
  //   carplay-bootstrap-ok → carplay-onconnect → carplay-idleroot-set (or -skip) → carplay-tap:*
  // The first link missing that a later link present would contradict localizes the
  // fault; all links present + no taps on a pressed button = the press dies native-side.
  const receiptOnce: Record<string, boolean> = {};
  const receipt = (key: string, detail: string) => {
    if (receiptOnce[key]) return;
    receiptOnce[key] = true;
    try { logEventReliable(`carplay-${key} ${detail}`); } catch {}
  };

  const setIdleRoot = () => {
    if (carPlayHookOwnsRoot) {
      setCarState({ cpDbg: 'idle:SKIP(hookOwns)' });
      // Not a failure — the warm root owns the template. Recorded because a session
      // where NOTHING set a root (no -set, no -skip) is the invisible case that has
      // eaten investigations before.
      receipt('idleroot-skip', 'hookOwns=1');
      return;
    }
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
        onBarButtonPressed: ({ id }: { id: string }) => handleCarBarButton(id, 'cold'),
        // Round CPMapButtons (zoom ± / Scout mic) — SF symbols via the build-65
        // systemImage patch (custom PNGs resolve nil under bridgeless; see
        // carActions.CAR_MAP_BUTTON_CONFIG). Ignored harmlessly on older builds.
        ...CAR_MAP_BUTTON_CONFIG,
        onMapButtonPressed: ({ id }: { id: string }) => handleCarMapButton(id, 'cold'),
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
      // setRootTemplate RETURNED — the template with our handlers is the root as far
      // as the JS side can observe. conn is the library's own connect state.
      receipt('idleroot-set', `conn=${CarPlay.connected ? 1 : 0}`);
    } catch (e: any) {
      // Full error + stack to the device log — the on-screen breadcrumb truncates,
      // and this throw is what prevents any CPMapTemplate from ever being created.
      try {
        console.error('[cpdiag] setIdleRoot THREW:', e?.message || String(e), '\nSTACK:\n' + (e?.stack || '(no stack)'));
      } catch {}
      setCarState({ cpDbg: 'idle:THREW ' + String(e?.message || e).slice(0, 40) });
      // This throw used to reach ONLY the screen breadcrumb — invisible from a query,
      // which is how a template-never-created session reads as "taps died native-side".
      receipt('idleroot-threw', String(e?.message || e).slice(0, 120));
    }
  };

  // Liveness ground truth for the dead-man sweep: the 'carplay' GPS hold is only
  // legitimate while the head unit is actually attached. A lost didDisconnect (or a
  // force-quit mid-session) used to strand the hold forever — 2026-08-26, the 5-hour
  // background-GPS day. CarPlay.connected is the library's live scene state.
  registerBgConsumerProbe('carplay', () => {
    try { return !!CarPlay.connected; } catch { return true; }
  });

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
  // HEAT/BATTERY: this poll used to run every 3s FOREVER on any phone that never
  // connects to CarPlay — i.e. permanently, for every Android user and every iPhone
  // driver not in a CarPlay car. It only exists to recover a didConnect emit that was
  // dropped because JS listeners weren't registered yet, which resolves within seconds
  // of process start; it was never meant to be a lifetime timer. So: bounded window,
  // and re-armed whenever the app becomes active (below) or CarPlay disconnects — both
  // of which are exactly when a real connect can appear. A genuine connect still
  // arrives through registerOnConnect regardless of this poll.
  const POKE_WINDOW_MS = 60000;
  let poll: any = null;
  let pollStartedAt = 0;
  const stopPolling = () => { if (poll) { clearInterval(poll); poll = null; } };
  const ensurePolling = () => {
    if (poll || CarPlay.connected) return;
    pollStartedAt = Date.now();
    poll = setInterval(() => {
      if (CarPlay.connected) { stopPolling(); return; }
      if (Date.now() - pollStartedAt > POKE_WINDOW_MS) { stopPolling(); return; }
      poke();
    }, 3000);
  };

  try {
    CarPlay.registerOnConnect(() => {
      setCarState({ cpDbg: 'onConnect:FIRED' });
      // The head unit's connect reached JS. First one per launch is the signal; a
      // reconnect mid-drive is ordinary and logging each would spend rows on noise.
      receipt('onconnect', `conn=${CarPlay.connected ? 1 : 0}`);
      stopPolling();
      onConnect();
    });
    CarPlay.registerOnDisconnect(() => { onDisconnect(); ensurePolling(); });
    setCarState({ cpDbg: 'wired conn=' + (CarPlay.connected ? '1' : '0') });
    // THE POSITIVE BOOTSTRAP RECEIPT: both connect handlers registered without a
    // throw. From here, a dead button can no longer be blamed on "the bootstrap
    // never ran" — this row is the proof it did, on this exact launch.
    receipt('bootstrap-ok', `conn=${CarPlay.connected ? 1 : 0} hookOwns=${carPlayHookOwnsRoot ? 1 : 0}`);
    if (CarPlay.connected) onConnect(); else { poke(); ensurePolling(); }
    // A head unit connecting often brings the app active — re-poke then, and resume
    // polling in case it had stopped.
    AppState.addEventListener('change', (s) => { if (s === 'active' && !CarPlay.connected) { poke(); ensurePolling(); } });
  } catch (e: any) {
    // This catch was SILENT — a registerOnConnect throw was dead buttons with zero
    // telemetry, indistinguishable from every other absence. It is a bail like the
    // ones at the top: the reason has to be on the record.
    bail(`register-threw ${String(e?.message || e).slice(0, 120)}`);
  }
}
