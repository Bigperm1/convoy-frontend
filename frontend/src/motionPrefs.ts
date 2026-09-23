// motionPrefs.ts — the user's Reduce Motion / Reduce Transparency settings, LIVE
// (Jeff, 2026-09-23: Apple-feel batch 1). DESIGN.md §11.
//
// Why not Reanimated's useReducedMotion() alone: it returns the value read ONCE when the app started
// and never re-renders (react-native-reanimated 4.1.7 src/hook/useReducedMotion.ts), so flipping the
// switch in iOS Settings mid-drive would be ignored until a cold start. It seeds the first render here
// (no flash of the wrong motion), and AccessibilityInfo keeps it live.
//
// One native listener per setting for the whole app, however many components ask — the press wrapper
// sits on dozens of controls at once. Subscribed while anything is mounted, removed when nothing is.
// ⚠ Reanimated's own ReduceMotion.System (the default on withTiming/withSpring/layout builders) still
// follows the LAUNCH value; this hook is for the choices a component makes itself (scale vs tint).
import { useSyncExternalStore } from "react";
import { AccessibilityInfo, Platform, type EmitterSubscription } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

type Pref = {
  subscribe: (onChange: () => void) => () => void;
  get: () => boolean | null;
};

function livePref(
  event: "reduceMotionChanged" | "reduceTransparencyChanged",
  query: () => Promise<boolean>,
  supported: boolean,
): Pref {
  let value: boolean | null = null; // null = not read yet; the hook falls back to its seed
  const listeners = new Set<() => void>();
  let sub: EmitterSubscription | null = null;

  const set = (next: boolean) => {
    if (next === value) return;
    value = next;
    listeners.forEach((l) => l());
  };

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      if (supported && !sub) {
        sub = AccessibilityInfo.addEventListener(event, set);
        // Re-read on (re)subscribe: the setting may have changed while nothing was listening.
        query().then(set, () => {});
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && sub) {
          sub.remove();
          sub = null;
        }
      };
    },
    get: () => (supported ? value : false),
  };
}

const reduceMotion = livePref(
  "reduceMotionChanged",
  () => AccessibilityInfo.isReduceMotionEnabled(),
  true,
);

// Reduce Transparency is an iOS setting (RN: "reduceTransparencyChanged" is iOS-only). False elsewhere.
const reduceTransparency = livePref(
  "reduceTransparencyChanged",
  () => AccessibilityInfo.isReduceTransparencyEnabled(),
  Platform.OS === "ios",
);

/** True when the user asked for less motion. Live; seeded from the launch value. */
export function useReduceMotion(): boolean {
  const seed = useReducedMotion();
  const live = useSyncExternalStore(reduceMotion.subscribe, reduceMotion.get, reduceMotion.get);
  return live ?? seed;
}

/**
 * True when the user asked for less transparency (iOS only; always false elsewhere). Live. There is no
 * launch value to seed from, so the first render reads false until the one native read lands.
 */
export function useReduceTransparency(): boolean {
  const live = useSyncExternalStore(
    reduceTransparency.subscribe,
    reduceTransparency.get,
    reduceTransparency.get,
  );
  return live ?? false;
}
