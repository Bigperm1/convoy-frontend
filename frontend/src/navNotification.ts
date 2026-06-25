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
import { setCarState } from "./carplay/carStore";

const NAV_TASK = "convoy-nav-location";
const NAV_NOTIF_ID = "convoy-nav-banner";
const NAV_CHANNEL = "navigation";
const ROUTE_KEY = "convoy:navRoute";
const PROGRESS_KEY = "convoy:navProgress";
// Only pop the off-screen banner once the next maneuver is this close — so it
// reads as "your turn is coming up", not a constant ping the whole drive.
const ANNOUNCE_DISTANCE_M = 500;

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
        color: "#2DEC86",
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

  // ONLY surface the banner when the next maneuver is actually incoming (within
  // ANNOUNCE_DISTANCE) or we're arriving. Previously it popped on every step
  // change — often a turn that's still kilometres away — so it re-banner-ed the
  // whole drive. Far from the turn we stay quiet and just remember progress; the
  // banner now behaves like Google's "turn left in 400 m", once per turn.
  const incoming = arriving || d <= ANNOUNCE_DISTANCE_M;
  if (!incoming) {
    try { await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify({ idx, notified })); } catch {}
    return;
  }

  // Already announced THIS turn's incoming banner → don't re-pop on every fix.
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
  // Feed the CarPlay surface too: this is the SAME background-location task the
  // car map now relies on (acquireBgLocation). Cheap no-op when CarPlay isn't up.
  const _h = loc.coords.heading;
  const _sp = loc.coords.speed;
  setCarState({
    selfLat: loc.coords.latitude,
    selfLng: loc.coords.longitude,
    heading: typeof _h === "number" && _h >= 0 ? _h : null,
    speedMs: typeof _sp === "number" && _sp >= 0 ? _sp : 0,
  });
  await updateNavBanner(loc.coords.latitude, loc.coords.longitude);
});

// ===== Shared background-location task (nav banner + CarPlay map) =====
// iOS/expo-location run ONE background location task. Both the nav banner and
// the CarPlay car-map need it, so refcount: it runs while EITHER consumer holds
// it and stops only when BOTH release. This fixes the blank CarPlay map (its old
// feed used FOREGROUND location, which iOS starves when the app is backgrounded
// behind the head unit). Needs "Always" location permission.
const _locConsumers = new Set<string>();

// ===== Foreground fallback feed for the CarPlay car-map =====
// The background task (NAV_TASK) only starts with "Always" location permission.
// Most users grant only "When In Use", so without a fallback carStore never gets
// a GPS fix once the phone backgrounds behind the head unit OR whenever the
// phone map screen (whose mirror writes coords into carStore) isn't the
// foreground screen — which is exactly why the CarPlay map sat on the logo
// fallback instead of drawing. This foreground watch feeds carStore DIRECTLY so
// the car map draws whenever the Convoy app is foreground (the phone-in-the-
// mount case), on plain "When In Use". It runs only while a consumer (CarPlay /
// nav banner) holds the shared location lock, and is released with it.
let _fgCarWatch: Location.LocationSubscription | null = null;

async function startForegroundCarFeed(): Promise<void> {
  if (_fgCarWatch) return;
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    if (!fg.granted) return;
    _fgCarWatch = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 2000, distanceInterval: 15 },
      (loc) => {
        const h = loc.coords.heading;
        const sp = loc.coords.speed;
        setCarState({
          selfLat: loc.coords.latitude,
          selfLng: loc.coords.longitude,
          heading: typeof h === "number" && h >= 0 ? h : null,
          speedMs: typeof sp === "number" && sp >= 0 ? sp : 0,
        });
      }
    );
  } catch {}
}

function stopForegroundCarFeed(): void {
  try { _fgCarWatch?.remove(); } catch {}
  _fgCarWatch = null;
}

export async function acquireBgLocation(tag: string): Promise<boolean> {
  _locConsumers.add(tag);
  try {
    const already = await Location.hasStartedLocationUpdatesAsync(NAV_TASK).catch(() => false);
    if (already) { void startForegroundCarFeed(); return true; }
    // Try for "Always" (keeps the car map fed while the phone is FULLY
    // backgrounded behind the head unit). If it isn't granted we no longer give
    // up: start a foreground feed (covers the app-foreground / phone-in-mount
    // case on "When In Use") AND still attempt the background updates — a nav app
    // with the location background mode + the background-location indicator can
    // keep them flowing without "Always" on many devices.
    let canBg = false;
    try { canBg = (await Location.requestBackgroundPermissionsAsync()).granted; } catch {}
    if (!canBg) await startForegroundCarFeed();
    try {
      await Location.startLocationUpdatesAsync(NAV_TASK, {
        accuracy: Location.Accuracy.High,
        timeInterval: 3000,
        distanceInterval: 20,
        showsBackgroundLocationIndicator: true,
        pausesUpdatesAutomatically: false,
        foregroundService: {
          notificationTitle: "Convoy navigation",
          notificationBody: "Turn-by-turn directions are active",
          notificationColor: "#2DEC86",
        },
      });
      return true;
    } catch {
      // Background updates couldn't start (likely needs "Always"). The foreground
      // feed above still keeps the car map alive while the app is foregrounded.
      return canBg;
    }
  } catch {
    return false;
  }
}

export async function releaseBgLocation(tag: string): Promise<void> {
  _locConsumers.delete(tag);
  if (_locConsumers.size > 0) return; // another consumer still needs it
  stopForegroundCarFeed();
  try {
    const started = await Location.hasStartedLocationUpdatesAsync(NAV_TASK).catch(() => false);
    if (started) await Location.stopLocationUpdatesAsync(NAV_TASK);
  } catch {}
}

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
    _notifiedStep = -1; // -1 so the FIRST turn still announces when it's incoming
    try {
      await AsyncStorage.setItem(ROUTE_KEY, JSON.stringify(slim));
      await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify({ idx: 0, notified: -1 }));
    } catch {}

    // No "Navigation started" banner — the off-screen banner should appear ONLY
    // when a maneuver is incoming (handled by updateNavBanner's proximity gate),
    // not the moment nav starts.

    // Background location keeps the banner updating while backgrounded. Needs
    // "Always" on iOS / background permission on Android — best-effort.
    return await acquireBgLocation("nav");
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
  // Release our hold; the shared task keeps running if CarPlay still needs it.
  await releaseBgLocation("nav");
  try { await Notifications.dismissNotificationAsync(NAV_NOTIF_ID); } catch {}
  try { await Notifications.cancelScheduledNotificationAsync(NAV_NOTIF_ID); } catch {}
}
