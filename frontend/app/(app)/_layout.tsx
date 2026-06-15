import React, { useEffect } from "react";
import { Tabs, useRouter, Redirect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { View, ActivityIndicator, Platform, StyleSheet, Text, AppState } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BlurView } from "expo-blur";
import VoiceController from "../../src/VoiceController";
import VoiceTabButton from "../../src/VoiceTabButton";
import CommsTabButton from "../../src/components/CommsTabButton";
import CommsTalkingToast from "../../src/components/CommsTalkingToast";
import ShareToast from "../../src/ShareToast";
import { useLiveWalkieListener } from "../../src/livePtt";
import { useSettings, hydrateCarFromProfile } from "../../src/settings";
import { api } from "../../src/api";
import { hailBus } from "../../src/hailBus";
import { shareBus } from "../../src/shareBus";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { initCallDetection } from "../../src/callState";

// ===== Push notification module-scope config =====
//
// Both `setNotificationHandler` and the registration helper MUST run before
// any push notification is delivered. expo-notifications is native-only — on
// web all these APIs throw, so we guard with Platform.OS !== "web".
//
// `handleNotification` controls how a push is rendered when the app is in the
// foreground. Default behavior on iOS/Android is to do nothing in foreground;
// we want the OS banner + sound so the user sees the Hail immediately.
if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      // The turn-by-turn nav banner (tagged data.nav) is a BACKGROUND affordance:
      // the map screen already shows the in-app maneuver banner, so don't pop the
      // system heads-up over it while the app is foregrounded. This handler only
      // runs in the foreground — backgrounded, the OS shows the banner normally.
      const isNav = (notification?.request?.content?.data as any)?.nav === true;
      if (isNav) {
        return {
          shouldShowAlert: false,
          shouldPlaySound: false,
          shouldSetBadge: false,
          shouldShowBanner: false,
          shouldShowList: true,
        };
      }
      return {
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      };
    },
  });
}

// One-shot async helper invoked from the layout's mount effect. Pulls the
// FCM/APNs device token from the OS and PUTs it to /auth/push-token. Safe to
// call on every cold start — backend is idempotent.
// Human-readable device identity (expo-device). Reported to the backend so the
// owner admin roster shows what each tester is actually running.
function deviceInfo() {
  return {
    device_model: Device.modelName || undefined,                    // "iPhone 15 Pro", "Pixel 7"
    device_brand: Device.brand || Device.manufacturer || undefined, // "Apple", "Google", "Samsung"
    os_name: Device.osName || Platform.OS,                          // "iOS", "Android"
    os_version: Device.osVersion || undefined,                      // "18.1", "14"
  };
}

async function registerForPushNotifications() {
  if (Platform.OS === "web") return;
  // Always report the device identity — even if push is denied/unavailable — so
  // the admin roster knows what every tester is on. The backend token field is
  // optional, so a device-only update is valid.
  const info = deviceInfo();
  const reportDeviceOnly = () =>
    api.put("/auth/push-token", { platform: Platform.OS, ...info }).catch(() => {});

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
      // No push — still record the device, then leave (WS fallback handles Hails).
      await reportDeviceOnly();
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
    if (!tokenData?.data) {
      await reportDeviceOnly();
      return;
    }

    await api.put("/auth/push-token", {
      token: tokenData.data,
      platform: Platform.OS,
      ...info,
    });
  } catch (e) {
    // Permission denied, simulator, or other token-fetch failure. Non-fatal —
    // still try to record the device identity for the roster.
    await reportDeviceOnly();
    if (__DEV__) console.warn("Push token registration failed:", e);
  }
}

export default function AppLayout() {
  const { user } = useAuth();
  const router = useRouter();
  const [settings] = useSettings();
  const insets = useSafeAreaInsets();
  // Android edge-to-edge (app.json edgeToEdgeEnabled) draws the tab bar BEHIND
  // the system nav buttons. Lift it by the real device bottom inset so the tabs
  // clear the nav bar. iOS keeps the original 88/24 exactly (contribution 0), so
  // its layout is byte-for-byte unchanged. StepDrawer adds the SAME inset to its
  // anchor so it stays flush on top of this now-taller bar.
  const navInset = Platform.OS === "android" ? insets.bottom : 0;


  // Mount the live walkie-talkie WebSocket listener once for the entire
  // (app) shell — incoming PTT transmissions auto-play even when the user is
  // on the Map, Music, Hub or Settings tab. The getter is read on every
  // incoming frame, so switching active community in Comms is reflected
  // immediately without reopening the socket.
  useLiveWalkieListener(() => settings.activeThreadId || settings.activeCommunityId, () => user?.id);

  useEffect(() => {
    if (user === null) router.replace("/(auth)/login");
  }, [user, router]);

  // ===== Push notifications =====
  //
  // Register on mount (handles cold-start tokens) and re-register whenever
  // the auth user changes — covers logout → login → re-login flows so the
  // token gets re-saved against the new user's row.
  useEffect(() => {
    if (!user) return;
    registerForPushNotifications();
  }, [user]);

  // ===== Clear the app-icon badge =====
  // A backgrounded Hail/YOHB push carries `badge: 1`, so iOS stamps the app
  // icon. Nothing ever reset it, so the badge stuck forever. Opening the app
  // means you've read it — so zero the badge on launch AND every time the app
  // returns to the foreground. (Foreground pushes set no badge — see the
  // notification handler's shouldSetBadge:false — so there's nothing to clear
  // while already open.)
  useEffect(() => {
    if (Platform.OS === "web") return;
    const clear = () => { Notifications.setBadgeCountAsync(0).catch(() => {}); };
    clear();
    const sub = AppState.addEventListener("change", (st) => { if (st === "active") clear(); });
    return () => sub.remove();
  }, []);

  // Start phone-call detection (ducks Nova while on a call). No-op until the
  // native detector module ships in a build — see src/callState.ts.
  useEffect(() => { initCallDetection(); }, []);

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

  // Foreground delivery listener — fires while the app is open. We DON'T
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
      if (data?.type === "share") {
        shareBus.emit({
          kind: (data.kind as any) || "music",
          fromHandle: String(data.from_handle || "Driver"),
          fromId: String(data.from_id || ""),
          payload: data.payload || {},
        });
      }
    });
    return () => sub.remove();
  }, []);

  // Tap-to-open listener — fires when the user taps the OS notification
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
      // Tapped a share push from the lockscreen / banner -> open the relevant
      // tab (music for a song, map for a route, comms for a clip).
      if (data?.type === "share") {
        const k = String(data.kind || "music");
        router.push((k === "route" ? "/(app)/map" : k === "comm" ? "/(app)/talk" : "/(app)/music") as any);
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
            // Solid #141416 — the SAME surface as the step drawer (StepDrawer.tsx)
            // so the bottom chrome reads as one continuous dark material.
            backgroundColor: "#141416",
            borderTopColor: "rgba(255,255,255,0.12)",
            borderTopWidth: StyleSheet.hairlineWidth,
            height: 88 + navInset,
            paddingBottom: 10 + navInset,
            paddingTop: 8,
            position: "absolute",
            // allow the elevated mic to overflow upward
            overflow: "visible",
          },
          // Solid dark surface (no blur) so the color stays exactly #141416.
          tabBarBackground: () => null,
          tabBarActiveTintColor: "#2DEC86",
          tabBarInactiveTintColor: "#FFFFFF",
          // Center the icon+label block and give the word room: a small gap under
          // the icon (marginTop), padding + lineHeight under the label so the text
          // is never clipped at the bar's bottom edge.
          // paddingVertical 0: the items get the FULL content row (~70px). With
          // paddingVertical:6 the usable height was 58px, but mic(38)+label(23)=61px
          // overflowed and clipped the word at the bottom. Zero padding + the gap
          // below leaves the icon+label centered with room to spare.
          tabBarItemStyle: { paddingVertical: 0 },
          tabBarLabelStyle: { fontSize: 15, fontWeight: "600", letterSpacing: 0, marginTop: 5, lineHeight: 18 },
        }}
      >
        <Tabs.Screen name="map" options={{
          tabBarLabel: "Map",
          tabBarButtonTestID: "tab-map",
          tabBarIcon: ({ color }) => <Ionicons name="navigate" size={34} color={color} />,
        }} />
        <Tabs.Screen name="talk" options={{
          tabBarLabel: ({ color }) => (
            <Text style={{ color, fontSize: 15, fontWeight: "600" }}>Comms</Text>
          ),
          tabBarButtonTestID: "tab-talk",
          tabBarButton: (props) => <CommsTabButton {...props} selfId={user?.id} />,
          tabBarIcon: ({ color }) => <Ionicons name="mic" size={38} color={color} />,
        }} />
        {/* Voice screen is no longer represented in the bottom tab bar — the
            press-and-hold mic now lives inside the map's search bar (Google
            Maps-style). We keep the route file registered with href:null so
            any deep links into /voice still resolve without crashing. */}
        <Tabs.Screen name="voice" options={{ href: null }} />
        <Tabs.Screen name="music" options={{
          tabBarLabel: "Music",
          tabBarButtonTestID: "tab-music",
          tabBarIcon: ({ color }) => <Ionicons name="musical-notes" size={34} color={color} />,
        }} />
        {/* Hub is now reached via the circular profile avatar on the right
            edge of the map search bar (mirrors Google Maps). Hidden from the
            bottom bar but still navigable via router.push("/(app)/hub"). */}
        <Tabs.Screen name="hub" options={{ href: null }} />
        <Tabs.Screen name="settings" options={{ href: null }} />
        <Tabs.Screen name="drive-mode" options={{ href: null }} />
        <Tabs.Screen name="garage" options={{ href: null }} />
        <Tabs.Screen name="admin" options={{ href: null }} />
        {/* TEMP (Mapbox migration Phase 1) — throwaway test route, no tab. STRIP BEFORE MERGE. */}
        <Tabs.Screen name="mapbox-test" options={{ href: null }} />
      </Tabs>

      {/* Global voice transcript banner (FAB removed — the elevated mic in the tab bar is the new CTA) */}
      <VoiceController />

      {/* App-wide "someone is transmitting" banner so live comms are visible
          on every tab while foregrounded (audio already plays globally). */}
      <CommsTalkingToast />

      {/* Global "a member shared a song / route / clip with you" toast. */}
      <ShareToast />
    </View>
  );
}
