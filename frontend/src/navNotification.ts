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
import { AppState, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { NavRoute, haversineMeters, maneuverVerb, fmtDistanceM, fmtManeuverDist, fmtEtaSec, announce, isPhoneTbtSpeaking } from "./nav";
import { maneuverDir } from "./components/ManeuverArrow";
import { setCarState, setCarSelfPosition } from "./carplay/carStore";
import { getSettings, getMapMode } from "./settings";
import { fetchSpeedLimitWaysAround, nearestLimit } from "./speedLimit";
import { fetchMapboxLaneCues, pickLaneCue, type LaneCue } from "./mapboxDirections";

const NAV_TASK = "convoy-nav-location";
const NAV_NOTIF_ID = "convoy-nav-banner";
const NAV_CHANNEL = "navigation";
const ROUTE_KEY = "convoy:navRoute";
const PROGRESS_KEY = "convoy:navProgress";
// Full encoded overview polyline of the active route, persisted so a COLD CarPlay
// connect (phone map not mounted) can draw the real green ribbon on the car map.
// The slim ROUTE_KEY only holds per-step end-points; this holds the smooth line.
const NAV_POLY_KEY = "convoy:navPolyline";
// Car-started nav hand-off (Wave 3): carActions.startCarNav persists
// { dest:{lat,lng,label}, startedAt } here so map.tsx can ADOPT the session on
// its next mount (phone opened mid-drive). Owned by this module because
// stopNavBanner is the universal nav-teardown — ending nav from ANY surface
// must also end the adoptable session, or a stale key would re-start guidance
// on the next app open.
export const CAR_NAV_KEY = "convoy:carNav";
// Only pop the off-screen banner once the next maneuver is this close — so it
// reads as "your turn is coming up", not a constant ping the whole drive.
const ANNOUNCE_DISTANCE_M = 500;

// distanceM (per step) + paceSPerM (route seconds-per-meter, traffic-aware) were
// added for CarPlay-standalone Wave 2 so a COLD drive computes real ETA/remaining
// on the head unit. Both optional — a route persisted by an older build simply
// shows the turn + distance (the pre-Wave-2 behavior), never a wrong number.
type SlimStep = { endLat: number; endLng: number; maneuver?: string; html: string; distanceM?: number };
type SlimRoute = { steps: SlimStep[]; destLabel?: string; paceSPerM?: number };

// Module-level cache. NOTE: a backgrounded location task can run in a separate
// JS context where these reset, so progress is also mirrored to AsyncStorage.
let _route: SlimRoute | null = null;
let _stepIdx = 0;
let _notifiedStep = -1;

// ── COLD lane guidance ("3D-lanes lite", CarPlay) ────────────────────────────
// One Mapbox guidance fetch per nav session (keyed on the destination) gives us
// per-maneuver lane arrows; each tick then matches the upcoming turn with the
// SAME fail-closed pickLaneCue the phone banner uses. Only runs when the phone
// TBT engine isn't active (warm drives mirror the phone's lanes instead). One
// attempt per route — a fetch failure just means no lanes this session, never
// wrong lanes and never a retry storm on the 3s tick.
let _laneCues: LaneCue[] | null = null;
let _laneKey = "";
let _laneFetching = false;
function ensureLaneCues(lat: number, lng: number, route: SlimRoute): void {
  const last = route.steps[route.steps.length - 1];
  if (!last) return;
  const key = `${last.endLat},${last.endLng}`;
  if (_laneKey === key || _laneFetching) return;
  _laneFetching = true;
  void (async () => {
    try {
      _laneCues = await fetchMapboxLaneCues({ lat, lng }, { lat: last.endLat, lng: last.endLng });
    } catch {
      _laneCues = null;
    } finally {
      _laneKey = key; // one attempt per route, success or not
      _laneFetching = false;
    }
  })();
}
function resetLaneCues(): void {
  _laneCues = null;
  _laneKey = "";
  _laneFetching = false;
}

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

  // Feed the CAR turn-by-turn strip every tick. On a COLD CarPlay connect the phone
  // map isn't mounted, so the warm useConvoyCarPlay mirror never runs — this is the
  // only source of the upcoming maneuver + distance on the car. Done BEFORE the
  // banner-incoming gate below so the car shows the turn even while still far from
  // it. (ETA/distance-remaining stay blank cold — the slim route has no duration.)
  const upNext = steps[Math.min(idx + 1, steps.length - 1)];
  let carInstruction: string;
  if (arriving) {
    carInstruction = route.destLabel ? `Arrive at ${route.destLabel}` : "Arriving";
  } else {
    carInstruction = strip(upNext.html) || maneuverVerb(upNext.maneuver);
  }
  // Real ETA / distance-remaining COLD (Wave 2): remaining = distance to the current
  // step's end + the persisted lengths of every later step; ETA = remaining × the
  // route's traffic-aware pace. Only for routes persisted with the Wave-2 fields —
  // an old slim route keeps the pre-Wave-2 blanks rather than showing a wrong number.
  const paced = typeof route.paceSPerM === "number" && route.paceSPerM > 0;
  let remainM = 0;
  if (paced) {
    remainM = d;
    for (let i = idx + 1; i < steps.length; i++) remainM += steps[i].distanceM || 0;
  }
  const etaS = paced ? Math.max(0, Math.round(remainM * (route.paceSPerM as number))) : 0;
  setCarState({
    navigating: true,
    instruction: carInstruction,
    distanceToTurn: fmtManeuverDist(d),
    distanceToTurnM: Math.round(d),
    destinationLabel: route.destLabel || "",
    // Maneuver glyph for the car banner's arrow box — same derivation as the
    // phone mirror (maneuverDir over the instruction + Mapbox maneuver key).
    maneuverIcon: maneuverDir(carInstruction, arriving ? steps[steps.length - 1]?.maneuver : upNext.maneuver),
    ...(paced
      ? {
          eta: fmtEtaSec(etaS),
          etaSeconds: etaS,
          distanceRemaining: fmtDistanceM(Math.round(remainM)),
          distanceRemainingM: Math.round(remainM),
        }
      : {}),
    // COLD lane guidance — only when the phone engine isn't driving the mirror
    // (its lanes are anchored to the richer route); fail-closed → hidden.
    ...(!isPhoneTbtSpeaking()
      ? { lanes: pickLaneCue(_laneCues, { lat: steps[idx].endLat, lng: steps[idx].endLng }, d) || undefined }
      : {}),
  });
  if (!isPhoneTbtSpeaking()) ensureLaneCues(lat, lng, route);

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

  // COLD spoken guidance (CarPlay-standalone Wave 2): Nova speaks the incoming
  // turn on drives where the phone's TBT engine never ran (app force-quit /
  // never opened — the CarPlay-only case). Reuses the SAME per-turn gate as the
  // banner above (once per step, ≤ANNOUNCE_DISTANCE), and the SAME queue as the
  // phone engine (announce → speak: novaVoice setting, greeting hold, dedupe,
  // music ducking, mute-during-calls all apply). isPhoneTbtSpeaking() is the
  // double-speak guard — while map.tsx's useTurnByTurn is actively guiding, it
  // owns the voice and this stays silent.
  if (!isPhoneTbtSpeaking()) {
    announce(
      arriving
        ? (route.destLabel ? `Arriving at ${route.destLabel}` : "Arriving at your destination")
        : `In ${fmtDistanceM(d)}, ${title}`,
    );
  }
}

// ===== Speed-limit feed for the car map (PART 5) =====
// Module-scope mirror of useSpeedLimit's logic (no React): cache a radius of
// maxspeed ways + the fetch center, throttle Overpass to ~30s, resolve the nearest
// road locally on every tick, and push the result into carStore.speedLimitKmh.
let _slWays: NonNullable<Awaited<ReturnType<typeof fetchSpeedLimitWaysAround>>> = [];
let _slCenter: { lat: number; lng: number } | null = null;
let _slLastFetch = 0;
let _slInFlight = false;
const SL_REFETCH_MOVE_M = 1000;
const SL_MIN_REFETCH_MS = 30000;

function _slHaversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function maybeUpdateSpeedLimit(lat: number, lng: number): void {
  const now = Date.now();
  const moved = _slCenter ? _slHaversineM(_slCenter.lat, _slCenter.lng, lat, lng) : Infinity;
  const needArea = !_slCenter || moved > SL_REFETCH_MOVE_M;
  const throttleOk = now - _slLastFetch > SL_MIN_REFETCH_MS;
  if (needArea && throttleOk && !_slInFlight) {
    _slInFlight = true;
    _slLastFetch = now;
    _slCenter = { lat, lng };
    fetchSpeedLimitWaysAround(lat, lng)
      .then((ways) => {
        _slInFlight = false;
        if (ways) { _slWays = ways; setCarState({ speedLimitKmh: nearestLimit(lat, lng, ways) ?? undefined }); }
        else { _slCenter = null; } // fetch failed — allow a retry after the throttle window
      })
      .catch(() => { _slInFlight = false; _slCenter = null; });
  }
  // Resolve against whatever is cached right now (instant; no network).
  setCarState({ speedLimitKmh: nearestLimit(lat, lng, _slWays) ?? undefined });
}

// Background location task — fires on each location update (foreground AND
// background) and drives the banner. Registered at module load.
let _navTaskTicks = 0;
TaskManager.defineTask(NAV_TASK, async ({ data, error }: any) => {
  if (error) return;
  const locs = data?.locations;
  const loc = locs && locs.length ? locs[locs.length - 1] : null;
  if (!loc?.coords) return;
  _lastFixAt = Date.now(); // feed the GPS stall watchdog
  // Feed the CarPlay surface too: this is the SAME background-location task the
  // car map now relies on (acquireBgLocation). Cheap no-op when CarPlay isn't up.
  const _h = loc.coords.heading;
  const _sp = loc.coords.speed;
  // CRITICAL: position lands first, unconditionally, depends on nothing new. A
  // throw while reading settings/mapMode (cold/headless context) must NEVER skip
  // this write — otherwise selfLat/selfLng stay null, hasFix is false, and the car
  // surface falls back to the CONVOY logo (the build-55 regression).
  // Position through the source-priority gate (lowest priority; yields to the fg watch /
  // phone mirror while they're fresh, takes over when they go stale). speedMs + carDbg
  // stay UNGATED so the bg-tick proof + speed always land even if the position is gated.
  setCarSelfPosition(loc.coords.latitude, loc.coords.longitude, typeof _h === "number" && _h >= 0 ? _h : null, 'bgtask');
  setCarState({
    speedMs: typeof _sp === "number" && _sp >= 0 ? _sp : 0,
    carDbg: "navtask#" + (++_navTaskTicks), // on-screen proof bg ticks are arriving
  });
  // Best-effort metadata — wrapped so it can never block the position write above.
  // (cache may be unhydrated in a separate bg JS context → defaults, which is fine.)
  try {
    setCarState({ selfCarColor: getSettings().carColor, mapMode: getMapMode(getSettings()) });
  } catch {}
  maybeUpdateSpeedLimit(loc.coords.latitude, loc.coords.longitude);
  await updateNavBanner(loc.coords.latitude, loc.coords.longitude);
});

// ===== Shared background-location task (nav banner + CarPlay map) =====
// iOS/expo-location run ONE background location task. Both the nav banner and
// the CarPlay car-map need it, so refcount: it runs while EITHER consumer holds
// it and stops only when BOTH release. This fixes the blank CarPlay map (its old
// feed used FOREGROUND location, which iOS starves when the app is backgrounded
// behind the head unit). Needs "Always" location permission.
const _locConsumers = new Set<string>();

// ===== GPS stall watchdog (CarPlay screen-off freeze, 2026-07-16) =====
// "The GPS still stops on CarPlay when the phone screen is off." Whatever kills
// the flow (a watcher iOS quietly stops delivering to, a bg task that failed to
// start on a cold locked connect and was never retried until the next
// foreground), the recovery is the same: REBUILD both feeds. While any consumer
// holds the shared location lock, track when the last fix landed (any source);
// if nothing has arrived for STALL_MS, tear down + restart the foreground watch
// and re-attempt the background task, stamping a carDbg breadcrumb so a freeze
// self-reports on the head-unit debug overlay. The interval only runs while the
// JS runtime is alive — which a connected CarPlay scene keeps it. This is the
// OTA-side hardening; a fully-native location manager remains the build-scoped
// belt-and-suspenders if freezes persist.
const STALL_MS = 25000;
const STALL_CHECK_MS = 10000;
let _lastFixAt = 0;
let _stallTimer: ReturnType<typeof setInterval> | null = null;
let _stallHeals = 0;
function _startStallWatchdog(): void {
  if (_stallTimer) return;
  _lastFixAt = Date.now(); // grace period from acquisition, not from 1970
  _stallTimer = setInterval(() => {
    if (_locConsumers.size === 0) return;
    if (Date.now() - _lastFixAt <= STALL_MS) return;
    _lastFixAt = Date.now(); // re-arm so a dead-GPS zone doesn't heal-loop every tick
    setCarState({ carDbg: "stallheal#" + (++_stallHeals) });
    stopForegroundCarFeed();
    void startForegroundCarFeed();
    void tryStartBgUpdates(true); // force: rebuild even a session that claims "started"
  }, STALL_CHECK_MS);
}
function _stopStallWatchdog(): void {
  if (_stallTimer) { clearInterval(_stallTimer); _stallTimer = null; }
}

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

export async function startForegroundCarFeed(): Promise<void> {
  if (_fgCarWatch) return;
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    if (!fg.granted) return;
    _fgCarWatch = await Location.watchPositionAsync(
      // 1s/5m (was 2s/15m): the head unit's only continuous feed in several
      // states — 15m gating read as "GPS stopped" at parking-lot speeds.
      { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 5 },
      (loc) => {
        _lastFixAt = Date.now(); // feed the GPS stall watchdog
        const h = loc.coords.heading;
        const sp = loc.coords.speed;
        // Position through the source-priority gate ('fgwatch' — beats the bg task,
        // yields to the phone mirror while it's fresh). speedMs + carDbg stay ungated.
        setCarSelfPosition(loc.coords.latitude, loc.coords.longitude, typeof h === "number" && h >= 0 ? h : null, 'fgwatch');
        setCarState({
          speedMs: typeof sp === "number" && sp >= 0 ? sp : 0,
          carDbg: "fgfeed",
        });
        // Best-effort metadata — wrapped so it can never block the position write.
        try {
          setCarState({ selfCarColor: getSettings().carColor, mapMode: getMapMode(getSettings()) });
        } catch {}
        maybeUpdateSpeedLimit(loc.coords.latitude, loc.coords.longitude);
      }
    );
  } catch {}
}

function stopForegroundCarFeed(): void {
  try { _fgCarWatch?.remove(); } catch {}
  _fgCarWatch = null;
}

// Cold-connect route hydration (PART 4). On a cold CarPlay connect the phone map
// isn't mounted, so nothing mirrors the active route into carStore. Read the
// persisted overview polyline from disk and push it so CarMapView's route layers
// draw the real ribbon. No-op (clears nothing) when there's no persisted route.
export async function hydrateCarRouteFromDisk(): Promise<void> {
  try {
    const poly = await AsyncStorage.getItem(NAV_POLY_KEY);
    if (poly) setCarState({ routePolyline: poly });
  } catch {}
}

// ===== One-time foreground "Always" upgrade ask (CarPlay-standalone Wave 1a) =====
// The bg location task (NAV_TASK) reliably delivers with the phone LOCKED only under
// "Always" authorization — but the only requestBackgroundPermissionsAsync call used to
// live inside acquireBgLocation, which runs on CarPlay connect when the app is already
// backgrounded/locked, where iOS CANNOT present the upgrade prompt (it silently returns
// the current status). So When-In-Use users were never upgraded, and the car map could
// starve once the phone locked while idle. Ask ONCE, from the foreground (map mount),
// where the system alert can actually appear.
//
// UX guards: never chains onto the foreground prompt (if fg isn't granted yet, we skip
// and a later session asks); the flag is set BEFORE requesting so an interrupted prompt
// can never turn into a re-nag loop. iOS shows "Keep Only While Using / Change to
// Always Allow" exactly once; if the user keeps While-Using, later calls are no-ops.
const ASKED_ALWAYS_KEY = "convoy.askedAlways.v1";
export async function askAlwaysLocationOnce(): Promise<void> {
  try {
    if (Platform.OS === "web") return;
    if (await AsyncStorage.getItem(ASKED_ALWAYS_KEY)) return;
    const fg = await Location.getForegroundPermissionsAsync();
    if (!fg.granted) return; // don't chain two permission dialogs — retry next session
    const bg = await Location.getBackgroundPermissionsAsync();
    if (bg.granted) { await AsyncStorage.setItem(ASKED_ALWAYS_KEY, "1"); return; }
    await AsyncStorage.setItem(ASKED_ALWAYS_KEY, "1");
    await Location.requestBackgroundPermissionsAsync().catch(() => {});
  } catch {}
}

// Start (or confirm) the background location task. Extracted from acquireBgLocation
// so it can be RETRIED after a failed cold start — previously one failure at
// CarPlay-connect meant no retry for the whole session (drive feedback 2026-07-14:
// "car marker frozen until the phone screen turns on"). Idempotent via the
// hasStarted check. Returns true when the task is running.
async function tryStartBgUpdates(force = false): Promise<boolean> {
  try {
    const already = await Location.hasStartedLocationUpdatesAsync(NAV_TASK).catch(() => false);
    // `force` (stall watchdog): a wedged session still REPORTS started but
    // delivers nothing — stop it so the start below rebuilds it for real.
    if (already && !force) return true;
    if (already && force) { try { await Location.stopLocationUpdatesAsync(NAV_TASK); } catch {} }
    await Location.startLocationUpdatesAsync(NAV_TASK, {
      accuracy: Location.Accuracy.High,
      // 1s/5m (was 3s/20m): with the phone locked this is the ONLY feed moving
      // the car marker — 3s/20m looked frozen-then-teleporting on the head unit.
      timeInterval: 1000,
      distanceInterval: 5,
      // AutomotiveNavigation tells iOS these updates are for driving, so it keeps
      // the location session alive through a locked screen instead of throttling/
      // pausing it as it does for the generic (Other) type. NOTE the drive-tested
      // ground truth (2026-07-14): with only "When In Use" permission, iOS still
      // TIES DELIVERY TO THE SCREEN on a cold locked launch — a live CarPlay scene
      // does NOT count as "in use". "Always" is the only authorization that keeps
      // fixes flowing with the phone locked in a pocket (what Waze/Google run on).
      // With When-In-Use the task can only deliver-through-lock if it STARTED
      // while the app was in use — which is why the AppState retry below matters.
      activityType: Location.LocationActivityType.AutomotiveNavigation,
      showsBackgroundLocationIndicator: true,
      pausesUpdatesAutomatically: false,
      foregroundService: {
        notificationTitle: "Hairpin navigation",
        notificationBody: "Turn-by-turn directions are active",
        notificationColor: "#2DEC86",
      },
    });
    return true;
  } catch (e) {
    // Background updates couldn't start (likely needs "Always"). Surface the reason
    // on the car overlay instead of swallowing it.
    setCarState({ carDbg: "bgstart:err:" + String(e).slice(0, 40) });
    return false;
  }
}

// Self-healing: whenever the app comes to the FOREGROUND, re-attempt the background
// start if a consumer (CarPlay / nav banner) still holds the location lock and the
// task isn't running. Covers both recovery paths: (a) the user just granted "Always"
// in iOS Settings (the in-app CTA deep-links there) — the task can now start;
// (b) still on When-In-Use — starting the task while the app IS in use arms iOS's
// documented continued-background-updates mode (blue indicator), so fixes keep
// flowing after the next lock for the rest of the session. Module-scope: registered
// once at import (this module loads at app boot via carPlayBootstrap).
if (Platform.OS !== "web") {
  AppState.addEventListener("change", (st) => {
    if (st !== "active" || _locConsumers.size === 0) return;
    void (async () => {
      const ok = await tryStartBgUpdates();
      if (ok) setCarState({ carDbg: "bgstart:healed" });
    })();
  });
}

export async function acquireBgLocation(tag: string): Promise<boolean> {
  _locConsumers.add(tag);
  _startStallWatchdog(); // self-heal a feed that dies while the lock is held
  try {
    const already = await Location.hasStartedLocationUpdatesAsync(NAV_TASK).catch(() => false);
    if (already) { void startForegroundCarFeed(); return true; }
    // Try for "Always" (keeps the car map fed while the phone is FULLY
    // backgrounded behind the head unit). Note: when this runs from a cold CarPlay
    // connect the app is backgrounded, so iOS CANNOT show the upgrade prompt here —
    // it silently returns the current status. The foreground ask lives in
    // askAlwaysLocationOnce (map mount) + the CarPlay-connect CTA in map.tsx.
    // NEVER ask for background before FOREGROUND is granted. On iOS
    // requestBackgroundPermissionsAsync() with nothing granted surfaces the
    // WHEN-IN-USE prompt itself — which fired here on a CarPlay connect and landed on
    // top of the location disclosure (sim, 2026-07-25), defeating the whole point of
    // the disclosure and breaking Google's "explain before you ask" requirement.
    // Foreground is requested through permissionGate (disclosure first); this only
    // upgrades once that has been granted, and otherwise just reads the status.
    let canBg = false;
    try {
      const fgNow = await Location.getForegroundPermissionsAsync();
      canBg = fgNow.granted
        ? (await Location.requestBackgroundPermissionsAsync()).granted
        : (await Location.getBackgroundPermissionsAsync()).granted;
    } catch {}
    if (!canBg) setCarState({ carDbg: "bg:no-always" }); // head-unit-visible breadcrumb
    // ALWAYS start the foreground feed (self-guards via _fgCarWatch; released with the
    // shared lock). It is the only CONTINUOUS main-context writer that lands selfLat in
    // the carStore the CarPlay surface reads. Previously this ran only `if (!canBg)`, so
    // on "Always" it was skipped — leaving the car surface with no fix (CONVOY logo)
    // whenever the phone backgrounded behind the head unit while idle (not navigating).
    await startForegroundCarFeed();
    const started = await tryStartBgUpdates();
    return started || canBg;
  } catch {
    return false;
  }
}

export async function releaseBgLocation(tag: string): Promise<void> {
  _locConsumers.delete(tag);
  if (_locConsumers.size > 0) return; // another consumer still needs it
  _stopStallWatchdog();
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
      // Traffic-aware average pace (s/m) — lets the cold bg task turn remaining
      // meters into a live ETA without the phone engine (Wave 2).
      paceSPerM: route.distance_m > 0 && route.duration_s > 0 ? route.duration_s / route.distance_m : undefined,
      steps: (route.steps || []).map((s) => ({
        endLat: s.end.lat, endLng: s.end.lng, maneuver: s.maneuver, html: s.html,
        distanceM: typeof s.distance_m === "number" ? s.distance_m : undefined,
      })),
    };
    _route = slim;
    _stepIdx = 0;
    _notifiedStep = -1; // -1 so the FIRST turn still announces when it's incoming
    resetLaneCues();    // fresh route → fresh lane-guidance fetch (cold CarPlay lanes)
    try {
      await AsyncStorage.setItem(ROUTE_KEY, JSON.stringify(slim));
      await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify({ idx: 0, notified: -1 }));
      // Persist the full overview polyline for the cold-CarPlay car map (PART 4).
      await AsyncStorage.setItem(NAV_POLY_KEY, route.polyline || "");
      // Feed it into carStore immediately too, so a car already connected draws it
      // without waiting for the next cold read.
      setCarState({ routePolyline: route.polyline || "" });
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
  resetLaneCues();
  try {
    await AsyncStorage.removeItem(ROUTE_KEY);
    await AsyncStorage.removeItem(PROGRESS_KEY);
    await AsyncStorage.removeItem(NAV_POLY_KEY);
    // End the adoptable car-started session too (Wave 3) — nav ended on any
    // surface must not re-adopt on the next phone open.
    await AsyncStorage.removeItem(CAR_NAV_KEY);
  } catch {}
  // Clear the car map's route + TBT strip so the ribbon and maneuver disappear on nav end.
  setCarState({ routePolyline: "", navigating: false, instruction: "", distanceToTurn: "", distanceToTurnM: 0, eta: "", distanceRemaining: "", etaSeconds: 0, distanceRemainingM: 0, lanes: undefined });
  // Release our hold; the shared task keeps running if CarPlay still needs it.
  await releaseBgLocation("nav");
  try { await Notifications.dismissNotificationAsync(NAV_NOTIF_ID); } catch {}
  try { await Notifications.cancelScheduledNotificationAsync(NAV_NOTIF_ID); } catch {}
}
