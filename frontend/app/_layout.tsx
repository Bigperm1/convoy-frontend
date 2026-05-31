import React from 'react';
import { Stack } from 'expo-router';
import { AuthProvider } from '../src/auth';
// NOTE: NavigationProvider (Google Navigation SDK) is temporarily NOT mounted while
// the map runs on react-native-maps. The dependency is kept so we can re-enable the
// full Nav SDK (chase cam) later as a selectable map mode — just re-add the import
// and wrap the tree with <NavigationProvider> again.
// import { NavigationProvider } from '@googlemaps/react-native-navigation-sdk';

export default function RootLayout() {
  return (
    <AuthProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </AuthProvider>
  );
}
