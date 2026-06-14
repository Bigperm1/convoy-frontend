// src/carplay/registerAndroidAuto.ts
//
// Registers the "AndroidAuto" headless JS root that react-native-carplay's
// CarPlaySession runs when an Android Auto head unit connects (it calls
// AppRegistry.runApplication("AndroidAuto", ...) natively). This MUST run at app
// startup, before any car connection — it's imported from index.js, the app
// entry point, right after expo-router/entry.
//
// Guarded so it is a complete no-op on web and iOS, and on any build without the
// react-native-carplay native module — the require of AndroidAutoRoot (which
// pulls in react-native-carplay) only happens on Android when RNCarPlay exists,
// so it can never crash at import. iOS/CarPlay builds its templates in the
// running app's JS context (useConvoyCarPlay) and does not use this root.

import { AppRegistry, NativeModules, Platform } from 'react-native';

if (Platform.OS === 'android' && (NativeModules as any).RNCarPlay) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AndroidAutoRoot = require('./AndroidAutoRoot').default;
  AppRegistry.registerComponent('AndroidAuto', () => AndroidAutoRoot);
}
