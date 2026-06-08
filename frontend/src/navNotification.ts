// navNotification.ts — system navigation banner (heads-up notification) that
// keeps showing the current turn even when Convoy is backgrounded or the phone
// is on the home screen. A background location task recomputes the upcoming
// maneuver from the active route and pops a fresh notification each time the
// step changes (so the banner appears per-turn, ~5s, swipe-up to dismiss, tap
// to reopen Convoy).
//
// Platform notes:
//  - iOS: works on the CURRENT build — background location mode + notifications
//    are already provisioned (app.json UIBackgroundModes: location). Requires
//    "Always" location permission to keep updating while fully backgrounded.
//  - Android: needs the background-location + foreground-service permissions
//    staged in app.json (next native build). Until then it degrades to
//    foreground-only updates and never crashes (all native calls are guarded).
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { NavRoute, haversineMeters, maneuverVerb, fmtDistanceM } from "./nav";

const NAV_TASK = "convoy-nav-location";
const NAV_NOTIF_ID = "convoy-nav-banner";
const NAV_CHANNEL = "navigation";
const ROUTE_KEY = "convoy:navRoute";
const PROGRESS_KEY = "convoy:navProgress";

type SlimStep = { endLat: number; endLng: number; maneuver?: string; html: string };
type SlimRoute = { steps: SlimStep[]; destLabel?: string };

// Module-level cache. NOTE: a backgrounded location task can run in a separate
// JS context where these reset, so progress is also mirrored to AsyncStorage.
let _route: SlimRoute | null = null;
let _stepIdx = 0;
let _notifiedStep = -1;

function strip(s: string): string {
  return (s || "").replace(/<[^>]+>/g, "").trim();
}

async function postBanner(title: string, body: string): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: NAV_NOTIF_ID,
      content: {
        title,
        body,
        data: { nav: true },
        color: "#FFD60A",
        sticky: Platform.OS === "android",
        priority: Notifications.AndroidNotificationPriority.HIGH,
        // (no sound — Nova already speaks the turn; iOS shows a silent banner)
      } as any,
      // Immediate. On Android we target the high-importance nav channel so it
      // pops as a heads-up banner.
      trigger: (Platform.OS === "android" ? { channelId: NAV_CHANNEL } : null) as any,
    });
  } catch {}
}

// Compute the current maneuver from the stored route + a GPS position and pop a
// fresh banner ONLY when the step changes (or on arrival) so it appears once
// per turn rather than spamming on every GPS tick.
export async function updateNavBanner(lat: number, lng: number): Promise<void> {
  let route = _route;
  if (!route) {
    try { const raw = await AsyncStorage.getItem(ROUTE_KEY); if (raw) route = JSON.parse(raw); } catch {}
  }
  if (!route || !route.steps || route.steps.length === 0) return;
  const steps = route.steps;

  // Restore progress (so the bg task's separate context never walks backward).
  let startIdx = _stepIdx;
  let notified = _notifiedStep;
  try {
    const raw = await AsyncStorage.getItem(PROGRESS_KEY);
    if (raw) { const p = JSON.parse(raw); startIdx = Math.max(startIdx, p.idx ?? 0); notified = Math.max(notified, p.notified ?? -1); }
  } catch {}

  let idx = Math.min(startIdx, steps.length - 1);
  let d = haversineMeters({ lat, lng }, { lat: steps[idx].endLat, lng: steps[idx].endLng });
  while (idx < steps.length - 1 && d < 25) {
    idx += 1;
    d = haversineMeters({ lat, lng }, { lat: steps[idx].endLat, lng: steps[idx].endLng });
  }
  _stepIdx = idx;

  const arriving = idx >= steps.length - 1 && d < 60;
  const stepKey = arriving ? steps.length : idx;

  // Same step as last banner → just persist progress, no re-pop.
  if (stepKey === notified) {
    _notifiedStep = notified;
    try { await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify({ idx, notified })); } catch {}
    return;
  }
  _notifiedStep = stepKey;
  try { await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify({ idx, notified: stepKey })); } catch {}

  let title: string;
  let body: string;
  if (arriving) {
    title = "Arriving at destination";
    body = route.destLabel || "You're almost there";
  } else {
    const next = steps[Math.min(idx + 1, steps.length - 1)];
    title = strip(next.html) || maneuverVerb(next.maneuver);
    body = `In ${fmtDistanceM(d)}`;
  }
  await postBanner(title, body);
}

// Background location task — fires on each location update (foreground AND
// background) and drives the banner. Registered at module load.
TaskManager.defineTask(NAV_TASK, async ({ data, error }: any) => {
  if (error) return;
  const locs = data?.locations;
  const loc = locs && locs.length ? locs[locs.length - 1] : null;
  if (!loc?.coords) return;
  await updateNavBanner(loc.coords.latitude, loc.coords.longitude);
});

// Begin the nav banner for a route. Returns true if the background location task
// started (banner will keep updating while backgrounded); false means it'll
// only update while the app is foregrounded (caller drives it via updateNavBanner).
export async function startNavBanner(route: NavRoute, destLabel?: string): Promise<boolean> {
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) { try { await Notifications.requestPermissionsAsync(); } catch {} }

    if (Platform.OS === "android") {
      try {
        await Notifications.setNotificationChannelAsync(NAV_CHANNEL, {
          name: "Navigation",
          importance: Notifications.AndroidImportance.HIGH,
          enableVibrate: false,
          showBadge: false,
        });
      } catch {}
    }

    const slim: SlimRoute = {
      destLabel,
      steps: (route.steps || []).map((s) => ({
        endLat: s.end.lat, endLng: s.end.lng, maneuver: s.maneuver, html: s.html,
      })),
    };
    _route = slim;
    _stepIdx = 0;
    _notifiedStep = 0;
    try {
      await AsyncStorage.setItem(ROUTE_KEY, JSON.stringify(slim));
      await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify({ idx: 0, notified: 0 }));
    } catch {}

    // Immediate first banner so the driver sees it the moment nav starts.
    const firstNext = slim.steps[Math.min(1, Math.max(0, slim.steps.length - 1))];
    if (firstNext) await postBanner(strip(firstNext.html) || "Navigating", "Navigation started");

    // Background location keeps the banner updating while backgrounded. Needs
    // "Always" on iOS / background permission on Android — best-effort.
    let canBackground = false;
    try { canBackground = (await Location.requestBackgroundPermissionsAsync()).granted; } catch {}
    if (!canBackground) return false;

    try {
      const already = await Location.hasStartedLocationUpdatesAsync(NAV_TASK).catch(() => false);
      if (!already) {
        await Location.startLocationUpdatesAsync(NAV_TASK, {
          accuracy: Location.Accuracy.High,
          timeInterval: 3000,
          distanceInterval: 20,
          showsBackgroundLocationIndicator: true,
          pausesUpdatesAutomatically: false,
          foregroundService: {
            notificationTitle: "Convoy navigation",
            notificationBody: "Turn-by-turn directions are active",
            notificationColor: "#FFD60A",
          },
        });
      }
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

export async function stopNavBanner(): Promise<void> {
  _route = null;
  _stepIdx = 0;
  _notifiedStep = -1;
  try {
    await AsyncStorage.removeItem(ROUTE_KEY);
    await AsyncStorage.removeItem(PROGRESS_KEY);
  } catch {}
  try {
    const started = await Location.hasStartedLocationUpdatesAsync(NAV_TASK).catch(() => false);
    if (started) await Location.stopLocationUpdatesAsync(NAV_TASK);
  } catch {}
  try { await Notifications.dismissNotificationAsync(NAV_NOTIF_ID); } catch {}
  try { await Notifications.cancelScheduledNotificationAsync(NAV_NOTIF_ID); } catch {}
}
