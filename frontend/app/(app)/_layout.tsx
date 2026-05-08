import React, { useEffect } from "react";
import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { View, ActivityIndicator } from "react-native";

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
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "#0A0A0A",
          borderTopColor: "#1a1a1c",
          borderTopWidth: 1,
          height: 78,
          paddingBottom: 18,
          paddingTop: 10,
        },
        tabBarActiveTintColor: COLORS.primary,
        tabBarInactiveTintColor: COLORS.textDim,
        tabBarLabelStyle: { fontSize: 10, letterSpacing: 1.5, fontWeight: "700" },
      }}
    >
      <Tabs.Screen
        name="map"
        options={{ tabBarLabel: "MAP", tabBarIcon: ({ color, size }) => <Ionicons name="map" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="talk"
        options={{ tabBarLabel: "TALK", tabBarIcon: ({ color, size }) => <Ionicons name="mic" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="drive"
        options={{ tabBarLabel: "DRIVE", tabBarIcon: ({ color, size }) => <Ionicons name="car-sport" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="music"
        options={{ tabBarLabel: "MUSIC", tabBarIcon: ({ color, size }) => <Ionicons name="musical-notes" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="garage"
        options={{ tabBarLabel: "GARAGE", tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} /> }}
      />
    </Tabs>
  );
}
