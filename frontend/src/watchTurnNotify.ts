// watchTurnNotify — Tier-0 wrist tap: an iPhone local notification mirrors to a paired Watch
// when the phone is locked. Used ONLY when the watch app is not reachable for a directional
// tap (src/watchLink.ts). Reads permission; never prompts (src/permissionGate.ts owns prompts).
// Suppressed while the phone screen is on — the in-app banner already shows the turn.
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";

let lastId: string | null = null;

export type TurnWristResult = "sent" | "suppressed" | "failed";

// Read through a call, not inline: TS narrows a property access and would then insist the second
// check below is unreachable — but AppState.currentState genuinely changes across the await.
const appIsForeground = () => AppState.currentState === "active";

export async function notifyTurnOnWrist(p: { glyph: string; street: string; distM: number }): Promise<TurnWristResult> {
  if (Platform.OS !== "ios") return "suppressed";
  if (appIsForeground()) return "suppressed";
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (perm.status !== "granted") return "failed";
    // The await above is not free — the user can have brought the app forward while it ran, and
    // scheduling then pops a banner over the map. Re-read AppState on THIS side of it.
    if (appIsForeground()) return "suppressed";
    if (lastId) { Notifications.dismissNotificationAsync(lastId).catch(() => {}); lastId = null; }
    lastId = await Notifications.scheduleNotificationAsync({
      content: {
        title: `${p.glyph || "→"} ${p.distM >= 1000 ? `${(p.distM / 1000).toFixed(1)} km` : `${Math.round(p.distM)} m`}`,
        body: p.street,
        data: { type: "turn-wrist" },
        // Every wrist tap shares one category, so the Watch coalesces them into a single
        // notification group instead of a stack of one-per-turn cards.
        categoryIdentifier: "turn",
      },
      trigger: null,
    });
    return "sent";
  } catch { return "failed"; }
}

/** Drop the turn card off the wrist when the drive ends — nothing else clears it. */
export function clearTurnWrist(): void {
  if (!lastId) return;
  const id = lastId;
  lastId = null;
  try { Notifications.dismissNotificationAsync(id).catch(() => {}); } catch {}
}
