// pttNotification.ts — local notification when an incoming PTT clip arrives
// while the app is backgrounded.
//
// Push notifications (Emergent / FCM) handle the offline / killed-state Hails.
// THIS module handles the in-between state: app is OPEN but BACKGROUNDED, the
// user gets a PTT message, and we want a banner so they know without having to
// resurface the app.
//
// Key behaviors:
//   - Throttled to one notification per 4 seconds (a chatty channel would
//     otherwise flood the lockscreen with banners while the user is driving).
//   - Auto-dismisses 6 seconds after firing — this is just a "heads up", not
//     an actionable notification, so we clear it from the tray.
//   - Web is a no-op; expo-notifications local notifications do nothing in
//     the browser preview.
//
// Created June 2025 alongside the audio-mode + duration-tracking fixes.

import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

const THROTTLE_MS = 4000;
const AUTO_DISMISS_MS = 6000;

let lastFiredAt = 0;
let lastIdentifier: string | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export async function showTransmitNotification(handle: string) {
  if (Platform.OS === "web") return;
  const now = Date.now();
  if (now - lastFiredAt < THROTTLE_MS) return;
  lastFiredAt = now;

  try {
    // Best-effort dismiss of the previous "is transmitting" banner so we
    // don't pile up a stack of identical notifications during a long
    // back-and-forth conversation.
    if (lastIdentifier) {
      Notifications.dismissNotificationAsync(lastIdentifier).catch(() => {});
    }
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }

    // `null` trigger = fire immediately. This works while the app is
    // foregrounded too — but the caller already gates on AppState != "active"
    // so we only ever land here when backgrounded.
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: "🎙 Convoy comms",
        body: `${handle} is transmitting`,
        // No `sound` field — the actual PTT audio plays through the speaker
        // already; an extra notification chime would just collide.
        data: { type: "ptt-transmit" },
      },
      trigger: null,
    });
    lastIdentifier = id;

    dismissTimer = setTimeout(() => {
      if (lastIdentifier) {
        Notifications.dismissNotificationAsync(lastIdentifier).catch(() => {});
        lastIdentifier = null;
      }
    }, AUTO_DISMISS_MS);
  } catch {
    // Permissions denied / running in simulator without notification support.
    // The PTT audio still plays — losing the banner is non-fatal.
  }
}
