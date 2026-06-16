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
