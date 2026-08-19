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

import { AppRegistry, NativeModules, Platform } from 'react-native';

// The platform + native-module guard stays OUTSIDE the try: it decides whether we
// touch the car tree at all, and a no-op on web/iOS must not be reported as a
// CarPlay failure.
if (Platform.OS === 'android' && (NativeModules as any).RNCarPlay) {
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
