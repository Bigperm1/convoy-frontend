// src/carplay/registerAndroidAuto.ts
//
// Registers the "AndroidAuto" headless JS root that react-native-carplay's
// CarPlaySession runs when an Android Auto head unit connects (it calls
// AppRegistry.runApplication("AndroidAuto", ...) natively). This MUST run at app
// startup, before any car connection — it's imported from index.js, the app
// entry point, right after expo-router/entry.
//
// Guarded so it is a complete no-op on web and iOS, and on any build without the
// react-native-carplay native module. iOS/CarPlay builds its templates in the
// running app's JS context (useConvoyCarPlay) and does not use this root.

import { AppRegistry, DeviceEventEmitter, NativeModules, Platform } from 'react-native';

// Per-process ceiling on `aa-native` rows. A connect emits ~4 (op=ctx, op=root, op=hold on=1,
// op=hold on=0); native caps op=hold-stall at 10 per process. The cap only matters if
// something loops, and logEventReliable is a Supabase INSERT per row (see the CarPlay GL
// retry storm: bound every breadcrumb).
const AA_NATIVE_ROWS_MAX = 80;

// MUST equal CarJsKeepAlive.TASK_KEY in patches/react-native-carplay+2.4.1-beta.0.patch
// (android/src/main/java/org/birkir/carplay/utils/CarJsKeepAlive.kt).
const CAR_SESSION_HOLD_TASK = 'HairpinCarSessionHold';

// OTA switch for the first build-79 cut's car-started cold-boot fix: CarPlaySession resuming
// the ReactContext with a null Activity when the host is BEFORE_CREATE. Superseded by the
// session hold below and OFF by default (it made AppState report 'active' in a car-only
// session and handed every lifecycle listener a null Activity). Flip to `true` ONLY if a
// head unit shows a car-started session that is dead with the hold on — i.e.
// `op=hold on=1 … task>=1 fab=1` but no `carplay-live-paint` / `car-viewport`. Native stores
// it (RNCarPlay.setAaKeepAliveOptions) and reads it at the NEXT connect, so it takes effect on
// the first car-started cold boot after a bundle carrying it has run once. Inert on build 78.
const AA_SYNTHETIC_RESUME = false;

// The platform + native-module guard stays OUTSIDE the try: it decides whether we
// touch the car tree at all, and a no-op on web/iOS must not be reported as a
// CarPlay failure.
if (Platform.OS === 'android' && (NativeModules as any).RNCarPlay) {
  // ── CAR SESSION JS HOLD (build 79, 2026-09-14) ─────────────────────────────────
  // react-native-carplay's CarJsKeepAlive starts a headless JS task under this key for the
  // whole Android Auto session, so JavaTimerManager keeps ticking while the phone app is
  // backgrounded, locked or swiped away (RN pauses timers on Activity pause unless a headless
  // task is active — facebook/react-native#50327). FIELD (09-13 read-only query): 198 of 200
  // `timer-starve … surf=car` rows came after the last `aa-appstate` was 'background'.
  // The task must NOT settle: an unregistered key or a resolved promise finishes it at once
  // (AppRegistryImpl.js startHeadlessTask) and the car falls back to the phone's lifecycle
  // (receipt: `aa-native op=hold-lost`). Native owns finishTask on disconnect — resolving on
  // didDisconnect here would also finish an overlapping new session's task. First in this
  // block so a throw in the AndroidAutoRoot require below cannot skip it. Inert on build 78
  // (nothing starts the task).
  try {
    AppRegistry.registerHeadlessTask(CAR_SESSION_HOLD_TASK, () => () => new Promise<void>(() => undefined));
  } catch {}
  try {
    (NativeModules as any).RNCarPlay?.setAaKeepAliveOptions?.(AA_SYNTHETIC_RESUME);
  } catch {}

  // ── NATIVE CONNECT RECEIPTS (build 79, 2026-09-13) ────────────────────────────
  // Say Phin's black screen: on build 78 every car-started Android Auto instance
  // (root-render <=5 ms after js-mark) failed and every phone-first one worked, and
  // JS could not tell — `aa-stack op=root` is logged when JS CALLS setRootTemplate,
  // before the native body runs, so failing sessions looked healthy. Build 79's
  // react-native-carplay patch emits `aaNativeTrace` from CarPlayModule:
  //   op=ctx life=<ReactHost lifecycle> forced=0|1 ee=0|1   (setCarContext; forced=1 only
  //                                                          when AA_SYNTHETIC_RESUME ran)
  //   op=root id=<templateId> depth=<stack size>            (after the root push)
  //   op=root-noop / op=root-miss                           (absorbed / no screen)
  //   op=hold on=1 via=acquire|init|regrab|join n= task= fab= anim= host= ctx= mfr= sdk=
  //   op=hold on=0 why= dur= bg= stp= mntBg= chorStall= slp= lost= re= task= host=
  //   op=hold-stall chor= sched= mnt= … / op=hold-lost task=    (CarJsKeepAlive)
  // Field proof of a car-started session: `op=ctx life=BEFORE_CREATE` +
  // `op=hold on=1 via=acquire|init task>=1 fab=1` PLUS `carplay-live-paint` + `car-viewport`
  // in the same instance_id — never `aa-crumb surface-render` alone (a JS render row, not a
  // paint). Proof of the phone-backgrounded fix: no `timer-starve … surf=car` after
  // `aa-appstate state=background` in an instance that logged `op=hold on=1`. Only
  // `hold-stall chor=0` is actionable; `chor=1 mnt=0` is inconclusive (empty commits count).
  //
  // MODULE SCOPE, not in AndroidAutoRoot: on a car cold start setCarContext runs
  // right after runApplication is queued, before the root component renders, so a
  // listener registered in a mount effect would miss op=ctx. Build 78 emits nothing,
  // so this is inert there. A missing row still means UNKNOWN (an event emitted
  // before this line ran is dropped), never "didn't happen".
  // logEventReliable, not logEvent: this fires during bundle eval on a car cold
  // start, exactly when the Supabase client may not exist yet and logEvent DROPS.
  try {
    let aaNativeRows = 0;
    DeviceEventEmitter.addListener('aaNativeTrace', (e: any) => {
      if (aaNativeRows >= AA_NATIVE_ROWS_MAX) return;
      aaNativeRows += 1;
      try {
        // Lazy require, same reason as the register-failed row below.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('../crashBreadcrumb').logEventReliable(
          `aa-native ${String(e?.msg ?? '').slice(0, 160)}`,
        );
      } catch {}
    });
  } catch {}

  // try/catch, matching registerCarSurface.ts's iOS path for the same reason.
  // The header used to claim this require "can never crash at import" — it can:
  // it synchronously evaluates the ENTIRE Android Auto module tree (AndroidAutoRoot
  // -> ConvoyCarPlay -> CarMapView -> carStore/navNotification/...) at every app
  // launch, on the PHONE, long before any head unit exists. A module-scope throw
  // anywhere in that tree killed the Android app at boot, and a boot crash trips
  // expo-updates ErrorRecovery -> rollback to the embedded bundle -> the device can
  // no longer be reached by OTA. Degrade to "no Android Auto this session" and let
  // the phone app live.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AndroidAutoRoot = require('./AndroidAutoRoot').default;
    AppRegistry.registerComponent('AndroidAuto', () => AndroidAutoRoot);
    // ── THE FIRST-CONNECT CRASH, ROOT-CAUSED (2026-08-19, Say Phin's captured
    // fatal: `"convoy-aa-nav" has not been registered`) ────────────────────────
    // The lib renders the nav template's map through a ReactSurface named by the
    // TEMPLATE ID (VirtualRenderer.kt: reactHost.createSurface(themed, moduleName)),
    // and that name is normally registered only inside AndroidAutoRoot's mount
    // effect (NavigationTemplate's constructor). When JS RELOADS while the car
    // session is live — an OTA apply, or expo-updates ErrorRecovery mid-crash —
    // the EXISTING native surface restarts against the new bundle BEFORE that
    // effect runs: AppRegistry.runApplication('convoy-aa-nav') throws, the process
    // dies, Android Auto blocklists the app, and every recovery reload repeats
    // the race (the 8/18 crash-loop night). Registering the surface component
    // HERE — module scope, app entry, same import graph — closes the window to
    // zero: any surface restart finds a valid component the instant the bundle
    // evaluates. The lib's later registerComponent with the same id is a
    // harmless replace (same component).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CarSurface } = require('./ConvoyCarPlay');
    AppRegistry.registerComponent('convoy-aa-nav', () => CarSurface);
  } catch (e) {
    console.error('[androidauto] AndroidAuto root registration failed:', e);
    // Console-only was invisible from a car (2026-08-18 tracer work): a failed
    // registration means the native session has NOTHING to run at connect — a
    // candidate for the silent first-connect death — so it must reach telemetry.
    // Lazy require: this file runs at app entry, crashBreadcrumb pulls RN deps.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../crashBreadcrumb').logEventReliable(
        `aa-crumb register-failed ${String((e as any)?.message || e).slice(0, 100)}`,
      );
    } catch {}
  }
}
