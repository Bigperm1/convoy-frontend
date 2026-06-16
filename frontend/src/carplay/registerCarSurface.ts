// src/carplay/registerCarSurface.ts
//
// Registers the "ConvoyCarSurface" JS root that is mounted onto the iOS CarPlay
// window natively by CarSceneDelegate (plugins/withConvoyCarPlay.js) using Expo's
// bridgeless root-view factory (rootViewFactory viewWithModuleName:).
//
// WHY THIS EXISTS / WHY AT STARTUP:
// react-native-carplay's own MapTemplate `component` path mounts the car window
// with RCTRootView(initWithBridge:), which renders NOTHING under the New
// Architecture (bridgeless, RN 0.81 / Expo SDK 54) -> blank car screen. Convoy
// bypasses that path (the native render block is patched out) and mounts the car
// window itself from CarSceneDelegate. For that native mount to find a JS root,
// this component MUST be registered under 'ConvoyCarSurface' BEFORE a CarPlay
// head unit connects -- CarSceneDelegate.didConnect fires before the app's JS
// onConnect runs. Registering here, at the app entry (imported from index.js),
// guarantees it is in place by the time any car connects.
//
// Guarded so it is a complete no-op on web and Android (Android Auto has its own
// root via registerAndroidAuto.ts). The require of ConvoyCarPlay only happens on
// iOS, so it can never affect other platforms.

import { AppRegistry, Platform } from 'react-native';

if (Platform.OS === 'ios') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CarSurface } = require('./ConvoyCarPlay');
  AppRegistry.registerComponent('ConvoyCarSurface', () => CarSurface);
}
