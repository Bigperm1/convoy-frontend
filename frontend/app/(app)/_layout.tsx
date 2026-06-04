import React, { useEffect } from "react";
import { Tabs, useRouter, Redirect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { View, ActivityIndicator, Platform, StyleSheet } from "react-native";
import { BlurView } from "expo-blur";
import VoiceController from "../../src/VoiceController";
import VoiceTabButton from "../../src/VoiceTabButton";
import ConvoyWaveIcon from "../../src/components/ConvoyWaveIcon";
import CommsTalkingToast from "../../src/components/CommsTalkingToast";
import { useLiveWalkieListener } from "../../src/livePtt";
import { useSettings, hydrateCarFromProfile } from "../../src/settings";
import { api } from "../../src/api";
import { hailBus } from "../../src/hailBus";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";

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
    const perm = await Notifications.getPermissionsAsync();
    let final = perm.status;
    // Only PROMPT on the very first launch (status still "undetermined"). On
    // later launches we just read the saved status, so the OS prompt never
    // reappears. If previously denied, we silently skip (WS fallback delivers).
    if (perm.status === "undetermined" && perm.canAskAgain) {
      final = (await Notifications.requestPermissionsAsync()).status;
    }
    if (final !== "granted") {
      // User denied Ã¢ÂÂ leave silently, the WS fallback path will handle Hails.
      return;
    }

    // Expo push token ("ExponentPushToken[...]"). Expo's hosted push service
    // relays to FCM (Android) / APNs (iOS) on our behalf, so the backend only
    // has to POST to Expo - no Emergent relay, no raw FCM/APNs handling.
    const projectId =
      Constants?.expoConfig?.extra?.eas?.projectId ??
      (Constants as any)?.easConfig?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
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
  useLiveWalkieListener(() => settings.activeCommunityId, () => user?.id);

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

  // Backfill the car identity from the account profile whenever the user loads.
  // A fresh install / new build wipes local AsyncStorage, so without this the
  // Garage (and the map self-marker) come up empty even though the car is saved
  // on the account. Only fills blanks, so it never overrides a local edit.
  useEffect(() => {
    if (!user) return;
    hydrateCarFromProfile({
      car_make: user.car_make,
      car_model: user.car_model,
      car_color: user.car_color,
      car_year: user.car_year ?? null,
    });
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
      // PTT push tapped from the lockscreen / banner while backgrounded or
      // killed -> open the Comms transcript so the driver can replay what they
      // missed. (Requires the backend to send a {type:"ptt"} push on each
      // transmission; the receive + tap handling here is ready regardless.)
      if (data?.type === "ptt") {
        router.push("/(app)/talk");
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
            // Match the search pill's dark surface so the bar reads as the same
            // material as the rest of the Google-style chrome.
            backgroundColor: "rgba(34,35,38,0.96)",
            borderTopColor: "rgba(255,255,255,0.12)",
            borderTopWidth: StyleSheet.hairlineWidth,
            height: 88,
            paddingBottom: 24,
            paddingTop: 10,
            position: "absolute",
            // allow the elevated mic to overflow upward
            overflow: "visible",
          },
          // Solid dark surface (no blur) so the color matches the search bar.
          tabBarBackground: () => null,
          tabBarActiveTintColor: COLORS.primary,
          tabBarInactiveTintColor: COLORS.textDim,
          tabBarLabelStyle: { fontSize: 12, fontWeight: "500", letterSpacing: 0 },
        }}
      >
        <Tabs.Screen name="map" options={{
          tabBarLabel: "Map",
          tabBarActiveTintColor: "#1F6BFF",
          tabBarButtonTestID: "tab-map",
          tabBarIcon: ({ color }) => <Ionicons name="navigate" size={27} color={color} />,
        }} />
        <Tabs.Screen name="talk" options={{
          tabBarLabel: "Comms",
          tabBarActiveTintColor: "#FFD60A",
          tabBarButtonTestID: "tab-talk",
          tabBarIcon: ({ color }) => <ConvoyWaveIcon size={27} color={color} />,
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
          tabBarIcon: ({ color }) => <Ionicons name="musical-notes" size={27} color={color} />,
        }} />
        {/* Hub is now reached via the circular profile avatar on the right
            edge of the map search bar (mirrors Google Maps). Hidden from the
            bottom bar but still navigable via router.push("/(app)/hub"). */}
        <Tabs.Screen name="hub" options={{ href: null }} />
        <Tabs.Screen name="settings" options={{ href: null }} />
        <Tabs.Screen name="drive-mode" options={{ href: null }} />
        <Tabs.Screen name="garage" options={{ href: null }} />
        <Tabs.Screen name="admin" options={{ href: null }} />
      </Tabs>

      {/* Global voice transcript banner (FAB removed Ã¢ÂÂ the elevated mic in the tab bar is the new CTA) */}
      <VoiceController />

      {/* App-wide "someone is transmitting" banner so live comms are visible
          on every tab while foregrounded (audio already plays globally). */}
      <CommsTalkingToast />
    </View>
  );
}
