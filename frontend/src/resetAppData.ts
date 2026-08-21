// Reset app data — the one-tap "fresh install" (Jeff, 2026-08-21: "what would be the
// best way to make sure these users are clean"). Every bug this month that a
// reinstall "fixed" lived in persisted state on the phone: settings, the car-nav
// session (CAR_NAV_KEY), the parked-car spot, cached routes/places, the entitlement
// cache, the breadcrumb queue, the saved sign-in. None of it is reachable from the
// backend. This wipes all of it and restarts the JS so the next launch is what a new
// install sees. AsyncStorage is the ONLY key-value store the app writes (audited 8/21:
// expo-secure-store is imported but never called; supabase persistSession:false).
//
// Deliberately NOT touched: the expo-updates store (a reset must never push anyone
// back to the embedded bundle), OS permissions, and the onboarding-done flags — the
// tour is not "data", and the confirm sheet promises a sign-in screen, not a tour.
//
// Returns true only if a real JS restart was triggered. expo-updates' reloadAsync is
// the production path (the red pill uses it daily); DevSettings.reload is a NO-OP in
// release builds (react-native/Libraries/Utilities/DevSettings.js only installs the
// real one under __DEV__), so it is gated on __DEV__ here and false is returned
// otherwise — the caller then signs out and tells the user to force-quit and reopen,
// because module singletons (settings cache, last location, car spot) would otherwise
// survive and re-persist themselves on the next write.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { logEventReliableAsync } from "./crashBreadcrumb";

const KEEP_KEYS = new Set(["convoy:onboarded:v1", "convoy.onboarding.completed"]);
const RECEIPT_WAIT_MS = 2000;

export async function resetAppData(): Promise<boolean> {
  // Receipt first, and actually awaited (capped so an offline reset never stalls).
  // queueOnFail=false: the queue it would land in is wiped two lines later.
  try {
    await Promise.race([
      logEventReliableAsync("reset-app-data", false),
      new Promise<void>((r) => setTimeout(r, RECEIPT_WAIT_MS)),
    ]);
  } catch {}
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => !KEEP_KEYS.has(k));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  } catch {
    try { await AsyncStorage.clear(); } catch {}
  }
  try {
    const U = require("expo-updates");
    if (U?.isEnabled !== false && typeof U?.reloadAsync === "function") {
      await U.reloadAsync();
      return true;
    }
  } catch {}
  if (__DEV__) {
    try {
      const { DevSettings } = require("react-native");
      if (typeof DevSettings?.reload === "function") { DevSettings.reload(); return true; }
    } catch {}
  }
  return false;
}
