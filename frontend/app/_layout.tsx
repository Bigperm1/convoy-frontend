import React from "react";
import { Stack } from "expo-router";
import { AuthProvider } from "../src/auth";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#0A0A0A" } }} />
    </AuthProvider>
  );
}
