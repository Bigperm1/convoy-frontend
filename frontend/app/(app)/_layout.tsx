import React, { useEffect } from "react";
import { NavigationProvider } from "@googlemaps/react-native-navigation-sdk";
import { Tabs, useRouter, Redirect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { View, ActivityIndicator, Platform, StyleSheet } from "react-native";
import { BlurView } from "expo-blur";
import VoiceController from "../../src/VoiceController";
import VoiceTabButton from "../../src/VoiceTabButton";
import { useLiveWalkieListener } from "../../src/livePtt";
import { useSettings } from "../../src/settings";
import { api } from "../../src/api";
import { hailBus } from "../../src/hailBus";
import * as Notifications from "expo-notifications";

// ===== Push notification module-scope config =====
//
// Both `setNotificationHandler` and the registration helper MUST run before
// any push notification is delivered. expo-notifications is native-only Ã¢ÂÂ on
// web all these APIs throw, so we guard with Platform.OS !== "web".
//
// `handleNotification` controls how a push is rendered when the app is in the
// foreground. Default behavior on iOS/Android is to do nothing in foreground;
// we want the OS banner + sound so the user sees the Hail immediately.
if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

// One-shot async helper invoked from the layout's mount effect. Pulls the
// FCM/APNs device token from the OS and PUTs it to /auth/push-token. Safe to
// call on every cold start Ã¢ÂÂ backend is idempotent.
async function registerForPushNotifications() {
  if (Platform.OS === "web") return;

  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let final = existing;
    if (existing !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      final = status;
    }
    if (final !== "granted") {
      // User denied Ã¢ÂÂ leave silently, the WS fallback path will handle Hails.
      return;
    }

    // `getDevicePushTokenAsync` returns the native FCM/APNs token, which is
    // what the Emergent push relay expects (NOT `getExpoPushTokenAsync`).
    const tokenData = await Notifications.getDevicePushTokenAsync();
    if (!tokenData?.data) return;

    await api.put("/auth/push-token", {
      token: tokenData.data,
      platform: Platform.OS,
    });
  } catch (e) {
    // Permission denied, simulator, or other token-fetch failure. Non-fatal.
    if (__DEV__) console.warn("Push token registration failed:", e);
  }
}

export default function AppLayout() {
  const { user } = useAuth();
  const router = useRouter();
  const [settings] = useSettings();

  // Mount the live walkie-talkie WebSocket listener once for the entire
  // (app) shell Ã¢ÂÂ incoming PTT transmissions auto-play even when the user is
  // on the Map, Music, Hub or Settings tab. The getter is read on every
  // incoming frame, so switching active community in Comms is reflected
  // immediately without reopening the socket.
  useLiveWalkieListener(() => settings.activeCommunityId);

  useEffect(() => {
    if (user === null) router.replace("/(auth)/login");
  }, [user, router]);

  // ===== Push notifications =====
  //
  // Register on mount (handles cold-start tokens) and re-register whenever
  // the auth user changes Ã¢ÂÂ covers logout Ã¢ÂÂ login Ã¢ÂÂ re-login flows so the
  // token gets re-saved against the new user's row.
  useEffect(() => {
    if (!user) return;
    registerForPushNotifications();
  }, [user]);

  // Foreground delivery listener Ã¢ÂÂ fires while the app is open. We DON'T
  // rely on the system banner here; instead we forward the hail to `hailBus`
  // which the map screen renders as an in-app toast (matches the existing
  // hail-via-WebSocket UX so users see the same UI regardless of transport).
  useEffect(() => {
    if (Platform.OS === "web") return;
    const sub = Notifications.addNotificationReceivedListener((notification) => {
      const data = (notification.request.content.data ?? {}) as any;
      if (data?.type === "hail") {
        hailBus.emit({
          fromHandle: String(data.from_handle || "Driver"),
          fromId: String(data.from_id || ""),
        });
      }
    });
    return () => sub.remove();
  }, []);

  // Tap-to-open listener Ã¢ÂÂ fires when the user taps the OS notification
  // banner while the app is backgrounded or killed. For Hails we route to
  // the Map tab so they can see the hailer's car blink on the map.
  useEffect(() => {
    if (Platform.OS === "web") return;
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = (response.notification.request.content.data ?? {}) as any;
      if (data?.type === "hail") {
        router.push("/(app)/map");
      }
    });
    return () => sub.remove();
  }, [router]);

  if (user === undefined) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg }}>
        <ActivityIndicator color={COLORS.primary} />
      </View>
    );
  }
  if (!user) return <Redirect href="/(auth)/login" />;

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
          tabBarActiveTintColor: "#FF6A00",
          tabBarButtonTestID: "tab-talk",
          tabBarIcon: ({ color, size }) => <Ionicons name="flash" size={size - 1} color={color} />,
        }} />
        {/* Voice screen is no longer represented in the bottom tab bar Ã¢ÂÂ the
            press-and-hold mic now lives inside the map's search bar (Google
            Maps-style). We keep the route file registered with href:null so
            any deep links into /voice still resolve without crashing. */}
        <Tabs.Screen name="voice" options={{ href: null }} />
        <Tabs.Screen name="music" options={{
          tabBarLabel: "Music",
          tabBarActiveTintColor: "#FF453A",
          tabBarButtonTestID: "tab-music",
          tabBarIcon: ({ color, size }) => <Ionicons name="musical-notes" size={size - 2} color={color} />,
        }} />
        {/* Hub is now reached via the circular profile avatar on the right
            edge of the map search bar (mirrors Google Maps). Hidden from the
            bottom bar but still navigable via router.push("/(app)/hub"). */}
        <Tabs.Screen name="hub" options={{ href: null }} />
        <Tabs.Screen name="settings" options={{ href: null }} />
        <Tabs.Screen name="drive-mode" options={{ href: null }} />
        <Tabs.Screen name="garage" options={{ href: null }} />
      </Tabs>

      {/* Global voice transcript banner (FAB removed Ã¢ÂÂ the elevated mic in the tab bar is the new CTA) */}
      <VoiceController />
    </View>
  );
}
