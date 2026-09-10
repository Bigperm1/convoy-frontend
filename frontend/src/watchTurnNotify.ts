// watchTurnNotify — Tier-0 wrist tap: an iPhone local notification mirrors to a paired Watch
// when the phone is locked. Used ONLY when the watch app is not reachable for a directional
// tap (src/watchLink.ts). Reads permission; never prompts (src/permissionGate.ts owns prompts).
// Suppressed while the phone screen is on — the in-app banner already shows the turn.
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";

let lastId: string | null = null;

export async function notifyTurnOnWrist(p: { glyph: string; street: string; distM: number }): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  if (AppState.currentState === "active") return false;
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (perm.status !== "granted") return false;
    if (lastId) { Notifications.dismissNotificationAsync(lastId).catch(() => {}); lastId = null; }
    lastId = await Notifications.scheduleNotificationAsync({
      content: {
        title: `${p.glyph || "→"} ${p.distM >= 1000 ? `${(p.distM / 1000).toFixed(1)} km` : `${Math.round(p.distM)} m`}`,
        body: p.street,
        data: { type: "turn-wrist" },
      },
      trigger: null,
    });
    return true;
  } catch { return false; }
}
