// Custom app entry point.
//
// Expo Router's default entry is `expo-router/entry` (it registers the root app
// component). We wrap it so we can ALSO register the Android Auto headless JS
// root that react-native-carplay's car session runs on connect.
//
// Order matters: importing `expo-router/entry` first preserves the exact normal
// app startup (root component registration, routing). The Android Auto
// registration is an additive, platform-guarded side effect that runs after and
// is a no-op on web/iOS. See src/carplay/registerAndroidAuto.ts and
// src/carplay/AndroidAutoRoot.tsx for why "AndroidAuto" must be registered.
import 'expo-router/entry';
import './src/carplay/registerAndroidAuto';
import './src/carplay/registerCarSurface';

// Fatal-JS-error breadcrumbs: queue message+stack on a fatal (expo-updates'
// ~5s recovery window gives the write time to land), harvest expo-updates'
// own error log next launch, deliver to Supabase. See src/crashBreadcrumb.ts.
import { installCrashBreadcrumb, logBundleMark, logUpdateRegression } from './src/crashBreadcrumb';
installCrashBreadcrumb();

// WHICH JS IS ACTUALLY RUNNING. One row per JS context, from the bundle ENTRY so it
// covers every surface (phone, CarPlay, Android Auto) — they share one runtime. The
// row's PRESENCE is the signal: a session whose columns say launch_kind='ota' but that
// never emits `js-mark` is running an older/embedded bundle while native reports the
// OTA. See the long note in src/crashBreadcrumb.ts for the CarPlay-first host-boot race
// that makes this possible, and why no other field can tell us.
logBundleMark();
logUpdateRegression();

// ANDROID AUTO BLACK BOX (phone half). The native car entry points record any throw to
// filesDir/aa_crash.txt; this uploads and clears it on the next launch, so nobody has to
// sit in the car with a laptop running adb to capture an AA failure. Android-only, fully
// guarded, never blocks startup. See src/androidAutoCrashLog.ts.
import { flushAndroidAutoCrashLog } from './src/androidAutoCrashLog';
void flushAndroidAutoCrashLog();

// Sets a CarPlay root template on a COLD connect (CarPlay opened while the phone
// app isn't running), where the phone map screen's useConvoyCarPlay hook isn't
// mounted to do it. No-op on web/Android and on the warm path. See carPlayBootstrap.ts.
//
// GUARDED, and it is NOT redundant with the try/catch in registerAndroidAuto.ts /
// registerCarSurface.ts. Measured: carPlayBootstrap's static import closure is 30
// modules, 29 of which it SHARES with the AndroidAutoRoot tree (carStore, carActions,
// navNotification, nav, api, supabase, settings, audioMode...). Those run real code at
// module scope — carActions.ts:695 `armPosRing()`, navNotification.ts:531
// `TaskManager.defineTask`, :782 `AppState.addEventListener`, api.ts:53's axios
// interceptor, supabase.ts:40's createClient. The car-registration guards above run
// FIRST, so a throw in a shared module is caught there — and then re-thrown right here
// when this require re-evaluates the failed module, un-caught, killing the app at boot.
// A boot crash trips expo-updates ErrorRecovery -> rollback to the embedded bundle ->
// the device can no longer be reached by OTA at all. Degrade to "no cold-connect
// bootstrap this session" instead.
//
// `expo-router/entry` above is deliberately left unguarded: it IS the app, and there is
// nothing to degrade to if it fails.
try {
  const { initCarPlayBootstrap } = require('./src/carplay/carPlayBootstrap');
  initCarPlayBootstrap();
} catch (e) {
  // ⚠ A SILENT CATCH IS A BLIND SPOT, and this one already cost a drive (2026-08-15).
  // The guard above is right — a throw here must not brick the app — but as first
  // written its only trace was a console.error nobody can read from a car. If this
  // fires, the cold CarPlay root never registers onBarButtonPressed and EVERY car
  // button goes dead with no crash, no message, and nothing in telemetry: exactly the
  // "buttons do nothing" report that has now recurred four times in this project.
  // Degrading quietly is correct; degrading INVISIBLY is not. Send a row.
  console.error('[carplay] bootstrap init failed:', e);
  try {
    require('./src/crashBreadcrumb').logEvent(
      `carplay-bootstrap-failed ${String((e && e.message) || e).slice(0, 160)}`,
    );
  } catch {}
}
