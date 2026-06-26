// Set the Mapbox public access token before anything renders (side-effect import,
// must stay first). No-op on web via initMapbox.web.ts.
import '../src/initMapbox';
import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { AuthProvider } from '../src/auth';
// NOTE: NavigationProvider (Google Navigation SDK) is temporarily NOT mounted while
// the map runs on react-native-maps. The dependency has been removed; re-add
// @googlemaps/react-native-navigation-sdk and wrap the tree with <NavigationProvider>
// again only if switching back to the Nav SDK as a selectable map mode later.

export default function RootLayout() {
  // Dismiss the native splash (brand logo) once the phone root mounts. On a cold
  // CarPlay-first launch the RN host boots against the detached CarPlay boot
  // window, so expo-splash-screen's default auto-hide can leave the phone window
  // stuck on the logo; hiding it here on phone-root mount clears it. Guarded —
  // a no-op if already hidden. We deliberately do NOT call preventAutoHideAsync,
  // so the normal cold-phone launch keeps auto-hiding as before.
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
