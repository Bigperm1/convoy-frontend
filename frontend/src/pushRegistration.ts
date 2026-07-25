// pushRegistration.ts — device identity + Expo push token registration.
//
// Moved out of app/(app)/_layout.tsx on 2026-07-25 so it can be re-run from
// anywhere once permission is actually granted, and so the app shell no longer
// owns a permission decision.
//
// KEY SPLIT (this is the whole point of the file):
//   • reportDevice()  — NEVER prompts. Records what device a tester is on so the
//     admin roster is complete even when push is denied or unavailable. Safe to
//     call at login.
//   • registerPushToken() — only fetches an Expo push token when notification
//     permission is ALREADY granted. It does not ask. Asking is the caller's job,
//     on the screen where notifications make sense, via permissionGate.
//
// Previously the app shell prompted for notifications the instant the user logged
// in, which is exactly the "bombarded with the allows right when you login" report.
import { Platform } from "react-native";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { api } from "./api";

function deviceInfo() {
  return {
    device_model: Device.modelName || undefined,                    // "iPhone 15 Pro", "Pixel 7"
    device_brand: Device.brand || Device.manufacturer || undefined, // "Apple", "Google", "Samsung"
    os_name: Device.osName || Platform.OS,                          // "iOS", "Android"
    os_version: Device.osVersion || undefined,                      // "18.1", "14"
  };
}

/** Record the device on the roster. Never prompts; safe at login. */
export async function reportDevice(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await api.put("/auth/push-token", { platform: Platform.OS, ...deviceInfo() });
  } catch {
    /* roster reporting is best-effort */
  }
}

/**
 * Fetch + save the Expo push token, but ONLY if notification permission is already
 * granted. Returns true when a token was stored. Falls back to a device-only report
 * on any failure so the roster still gets the device.
 */
export async function registerPushToken(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  const info = deviceInfo();
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (perm.status !== "granted") {
      // No push — still record the device (WS fallback delivers Hails).
      await reportDevice();
      return false;
    }
    // Expo push token ("ExponentPushToken[...]"). Expo's hosted push service relays
    // to FCM (Android) / APNs (iOS), so the backend only POSTs to Expo.
    const projectId =
      (Constants as any)?.expoConfig?.extra?.eas?.projectId ??
      (Constants as any)?.easConfig?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    if (!tokenData?.data) {
      await reportDevice();
      return false;
    }
    await api.put("/auth/push-token", { token: tokenData.data, platform: Platform.OS, ...info });
    return true;
  } catch (e) {
    await reportDevice();
    if (__DEV__) console.warn("Push token registration failed:", e);
    return false;
  }
}
