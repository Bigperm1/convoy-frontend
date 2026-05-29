import React from "react";
import { Stack } from "expo-router";
import { AuthProvider } from "../src/auth";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { startKeepAlive } from "../src/keepAlive";
  

export default function RootLayout() {
    useEffect(() => { startKeepAlive(); }, []);
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#0A0A0A" } }} />
    </AuthProvider>
  );
}
