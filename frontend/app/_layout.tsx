import React from 'react';
import { Stack } from 'expo-router';
import { AuthProvider } from '../src/auth';
import { NavigationProvider } from '@googlemaps/react-native-navigation-sdk';

export default function RootLayout() {
  return (
    <NavigationProvider termsAndConditionsDialogOptions={{ title: 'Terms', companyName: 'Convoy' }}>
      <AuthProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </AuthProvider>
    </NavigationProvider>
  );
}