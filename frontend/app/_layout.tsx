import React from "react";
import { Stack } from "expo-router";
import { AuthProvider } from "../src/auth";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { startKeepAlive } from "../src/keepAlive";
import { NavigationProvider } from "@googlemaps/react-native-navigation-sdk";

export default function RootLayout() {
useEffect(() => { startKeepAlive(); }, []);
return (
<NavigationProvider termsAndConditionsDialogOptions={{ title: "Terms & Conditions", companyName: "Convoy" }}>
<AuthProvider>
<StatusBar style="light" />
<Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#0A0A0A" } }} />
</AuthProvider>
</NavigationProvider>
);
}