// haptics.ts — the haptic vocabulary (Jeff, 2026-09-23: Apple-feel batch 1). DESIGN.md §11.
//
// Every haptic in the app is one of these words; nothing new should call expo-haptics directly.
// The rules (animate-expo §8): ONE per user action, in the SAME frame as its visual, never the only
// feedback (many users turn haptics off system-wide), never on a plain
// open/navigate tap, never for something the user didn't cause, never per frame or on scroll.
//
// Fire-and-forget: each returns immediately, and a missing/failed engine is swallowed. From a worklet,
// hop back to the RN runtime first: scheduleOnRN(haptics.snap) — never runOnJS.
import { Platform, Vibration } from "react-native";
import * as Haptics from "expo-haptics";

// Web: off. expo-haptics' web module maps these to navigator.vibrate (ExpoHaptics.web.ts), and a phone
// haptic vocabulary should not start buzzing a browser.
const off = Platform.OS === "web";

function impact(style: Haptics.ImpactFeedbackStyle): void {
  if (off) return;
  Haptics.impactAsync(style).catch(() => {});
}

function notify(type: Haptics.NotificationFeedbackType): void {
  if (off) return;
  Haptics.notificationAsync(type).catch(() => {});
}

export const haptics = {
  /** A VALUE steps: a chip, a two-state toggle, a route choice, a pager detent. */
  tick(): void {
    if (off) return;
    Haptics.selectionAsync().catch(() => {});
  },
  /** Something snaps home, a detent catches, a drag commits, a map button moves the camera. */
  snap(): void {
    impact(Haptics.ImpactFeedbackStyle.Light);
  },
  /** A delete commits. */
  destructive(): void {
    impact(Haptics.ImpactFeedbackStyle.Medium);
  },
  /**
   * Hold-to-talk: the frame the mic goes live — ONE pulse, Medium, not two Heavy
   * (Jeff, 2026-09-23: Apple-feel batch 1, "hold to talk switch").
   * Android: ONE Vibration.vibrate(35) instead of the impact. expo-haptics' Android Medium is a
   * 43 ms waveform at amplitude 50/255 (HapticsImpactType.kt), which useVoice's own comment called
   * faint, so the Scout path used to fire it AND a 35 ms vibrate — two calls to one Vibrator from
   * two native modules for one action. The vibrate — the pulse that comment relied on to be
   * "unmistakable" — is kept, alone. (How the two compare on a device was never measured.)
   */
  micLive(): void {
    if (off) return;
    if (Platform.OS === "android") {
      try { Vibration.vibrate(35); } catch {}
      return;
    }
    impact(Haptics.ImpactFeedbackStyle.Medium);
  },
  /** Hold-to-talk: key-up. */
  micRelease(): void {
    impact(Haptics.ImpactFeedbackStyle.Light);
  },
  /** The user's OWN action succeeded. */
  success(): void {
    notify(Haptics.NotificationFeedbackType.Success);
  },
  /** The user's own action failed. */
  failure(): void {
    notify(Haptics.NotificationFeedbackType.Error);
  },
} as const;

export type HapticName = keyof typeof haptics;
