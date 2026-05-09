import React, { useEffect } from "react";
import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { View, ActivityIndicator, Platform, StyleSheet } from "react-native";
import { BlurView } from "expo-blur";
import VoiceController from "../../src/VoiceController";
import VoiceTabButton from "../../src/VoiceTabButton";

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
            // allow the elevated mic to overflow upward
            overflow: "visible",
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
        <Tabs.Screen name="map" options={{
          tabBarLabel: "Map",
          tabBarActiveTintColor: "#0A84FF",
          tabBarButtonTestID: "tab-map",
          tabBarIcon: ({ color, size }) => <Ionicons name="map" size={size - 2} color={color} />,
        }} />
        <Tabs.Screen name="talk" options={{
          tabBarLabel: "Comms",
          tabBarActiveTintColor: "#FFD60A",
          tabBarButtonTestID: "tab-talk",
          tabBarIcon: ({ color, size }) => <Ionicons name="flash" size={size - 1} color={color} />,
        }} />
        {/* Center elevated mic CTA — replaces the old "Drive" tab. Press-and-hold to record. */}
        <Tabs.Screen
          name="voice"
          options={{
            tabBarLabel: () => null,
            tabBarIcon: () => null,
            tabBarButton: () => <VoiceTabButton />,
          }}
        />
        <Tabs.Screen name="music" options={{
          tabBarLabel: "Music",
          tabBarActiveTintColor: "#FF453A",
          tabBarButtonTestID: "tab-music",
          tabBarIcon: ({ color, size }) => <Ionicons name="musical-notes" size={size - 2} color={color} />,
        }} />
        <Tabs.Screen name="hub" options={{
          tabBarLabel: "Hub",
          tabBarActiveTintColor: "#FF9F0A",
          tabBarButtonTestID: "tab-hub",
          tabBarIcon: ({ color, size }) => <Ionicons name="people-circle" size={size - 1} color={color} />,
        }} />
        <Tabs.Screen name="settings" options={{ href: null }} />
        <Tabs.Screen name="drive-mode" options={{ href: null }} />
      </Tabs>

      {/* Global voice transcript banner (FAB removed — the elevated mic in the tab bar is the new CTA) */}
      <VoiceController />
    </View>
  );
}
