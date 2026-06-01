import React from 'react';
import { Stack } from 'expo-router';
import { AuthProvider } from '../src/auth';

export default function RootLayout() {
  return (
    <AuthProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </AuthProvider>
  );
}
