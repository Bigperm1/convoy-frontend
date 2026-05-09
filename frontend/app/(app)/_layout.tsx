import React, { useEffect } from "react";
import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { View, ActivityIndicator, Platform, StyleSheet } from "react-native";
import { BlurView } from "expo-blur";
import VoiceController from "../../src/VoiceController";

export default function AppLayout() {
  const { user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user === null) router.replace("/(auth)/login");
  }, [user, router]);

  if (user === undefined) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg }}>
        <ActivityIndicator color={COLORS.primary} />
      </View>
    );
  }
  if (!user) return null;

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.bg }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: Platform.OS === "web" ? "rgba(20,20,22,0.92)" : "transparent",
            borderTopColor: COLORS.hairline,
            borderTopWidth: StyleSheet.hairlineWidth,
            height: 84,
            paddingBottom: 22,
            paddingTop: 10,
            position: "absolute",
          },
          tabBarBackground: () =>
            Platform.OS === "web" ? null : (
              <BlurView tint="dark" intensity={70} style={StyleSheet.absoluteFill} />
            ),
          tabBarActiveTintColor: COLORS.primary,
          tabBarInactiveTintColor: COLORS.textDim,
          tabBarLabelStyle: { fontSize: 10, fontWeight: "600", letterSpacing: -0.1 },
        }}
      >
        <Tabs.Screen name="map" options={{ tabBarLabel: "Map", tabBarIcon: ({ color, size }) => <Ionicons name="map" size={size - 2} color={color} /> }} />
        <Tabs.Screen name="talk" options={{ tabBarLabel: "Talk", tabBarIcon: ({ color, size }) => <Ionicons name="mic" size={size - 2} color={color} /> }} />
        <Tabs.Screen name="drive" options={{ tabBarLabel: "Drive", tabBarIcon: ({ color, size }) => <Ionicons name="navigate-circle" size={size - 1} color={color} /> }} />
        <Tabs.Screen name="music" options={{ tabBarLabel: "Music", tabBarIcon: ({ color, size }) => <Ionicons name="musical-notes" size={size - 2} color={color} /> }} />
        <Tabs.Screen name="hub" options={{ tabBarLabel: "Hub", tabBarIcon: ({ color, size }) => <Ionicons name="people-circle" size={size - 1} color={color} /> }} />
        <Tabs.Screen name="settings" options={{ href: null }} />
      </Tabs>

      {/* Global voice activation: floating mic + transcript banner, available on every tab */}
      <VoiceController />
    </View>
  );
}
