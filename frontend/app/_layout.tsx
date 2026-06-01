import React from 'react';
import { Stack } from 'expo-router';
import { AuthProvider } from '../src/auth';
// NOTE: NavigationProvider (Google Navigation SDK) is temporarily NOT mounted while
// the map runs on react-native-maps. The dependency has been removed; re-add
// @googlemaps/react-native-navigation-sdk and wrap the tree with <NavigationProvider>
// again only if switching back to the Nav SDK as a selectable map mode later.

export default function RootLayout() {
  return (
    <AuthProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </AuthProvider>
  );
}
