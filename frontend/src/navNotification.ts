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
import {
  NavRoute, haversineMeters, maneuverVerb, fmtDistanceM, fmtManeuverDist, fmtEtaSec, announce, isPhoneTbtSpeaking,
  arrivalLine, ARRIVE_M, ARRIVE_SETTLE_M, ARRIVE_SETTLE_SPEED_MS, ARRIVE_SETTLE_MS, ARRIVE_SPEAK_MAX_LATE_MS,
} from "./nav";
import { maneuverDir } from "./components/ManeuverArrow";
import { setCarState, setCarSelfPosition } from "./carplay/carStore";
import { getSettings, getMapMode } from "./settings";
import { updateSpeedLimit } from "./speedLimit";
import { fetchMapboxLaneCues, pickLaneCue, type LaneCue } from "./mapboxDirections";
import { recordTrip } from "./trips";

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
// How often updateNavBanner may hit the disk looking for a route it does not have.
// See the call site: this runs at 1 Hz on two feeds, and answers "no route" almost
// every time.
const ROUTE_LOOKUP_THROTTLE_MS = 10_000;
// ── STALE ROUTES ARE WHY SCOUT TALKS TO AN EMPTY CAR (2026-07-31) ───────────
// Jeff: "scout for some reason just says things when hairpin is not even on."
//
// ROUTE_KEY is written by startNavBanner and removed ONLY by stopNavBanner — i.e. only
// when a route actually ENDS. Arrival has been failing for weeks, so routes routinely
// never ended and the persisted one survives app restarts indefinitely. The cold engine
// then keeps evaluating that dead route on every background fix, and when you happen to
// drive near its old destination it fires arrival and SPEAKS — with the app closed,
// because speak() has no foreground gate and fireColdArrival is reachable from the
// background location task.
//
// Today made it far more likely: the gate widened from a hidden 25 m radius to
// remaining < 50 m plus a crow-fly tier (80 m / 400 m / stopped 90 s), so a stale route
// now has a much bigger trigger area.
//
// A route older than this cannot be the one the driver is on. Drop it.
const MAX_PERSISTED_ROUTE_AGE_MS = 6 * 3600_000;
// Written by src/auth.tsx (its USER_KEY). Read directly rather than importing that
// module: auth pulls in @react-native-google-signin, whose spec calls
// TurboModuleRegistry.getEnforcing at MODULE SCOPE — that throws when the native
// module isn't registered, and this file runs inside a HEADLESS background task where
// it may not be. Importing it would risk killing the very task that feeds the car.
// The duplication is one string, cross-referenced from both sides.
const USER_CACHE_KEY = "convoy_user";

// distanceM (per step) + paceSPerM (route seconds-per-meter, traffic-aware) were
// added for CarPlay-standalone Wave 2 so a COLD drive computes real ETA/remaining
// on the head unit. Both optional — a route persisted by an older build simply
// shows the turn + distance (the pre-Wave-2 behavior), never a wrong number.
type SlimStep = { endLat: number; endLng: number; maneuver?: string; html: string; distanceM?: number };
// totalM / startedAt / destLat / destLng were added 2026-07-31 so a COLD arrival can
// recordTrip. Jeff: trips are his usage gauge ("so i can also gauge if people are using
// hairpin"), so a car-started drive that never touches the phone must still count.
// All optional — a route persisted by an older build simply records nothing rather than
// recording a wrong number.
type SlimRoute = {
  steps: SlimStep[]; destLabel?: string; paceSPerM?: number;
  totalM?: number; startedAt?: number; destLat?: number; destLng?: number;
};

// Module-level cache. NOTE: a backgrounded location task can run in a separate
// JS context where these reset, so progress is also mirrored to AsyncStorage.
let _route: SlimRoute | null = null;
let _stepIdx = 0;
let _notifiedStep = -1;
let _routeLookAt = 0;

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
// ── COLD ARRIVAL: Android Auto gets what the phone got (2026-07-31) ─────────
// Jeff's standing rule, restated: *"if you find that 'android doesnt do this' please
// make it work."* Auto-finish lived only in useTurnByTurn, which is mounted by
// map.tsx. That is fine on iOS — a CarPlay connect brings up the app's main React
// root, so map.tsx is there and owns arrival. It is NOT fine on Android: Android
// Auto runs a SEPARATE AppRegistry root ("AndroidAuto"), deliberately, because the
// main root is not running (that is the whole reason AndroidAutoRoot bootstraps its
// own feeds). So an AA-started drive had NO arrival at all and the route ran forever.
//
// This is the surface-independent engine — the bg task and the foreground car feed
// both drive it — so putting arrival here fixes AA and covers cold CarPlay for free.
// It uses the constants EXPORTED from nav.ts, not copies, so the two engines cannot
// drift; and it defers entirely to the phone engine whenever that one is live, so a
// warm drive behaves exactly as it did and can never fire twice.
let _coldArrived = false;
let _coldSettleSince: number | null = null;
let _coldSettleTimer: ReturnType<typeof setTimeout> | null = null;
// Set SYNCHRONOUSLY the instant any teardown starts, cleared by startNavBanner.
// stopNavBanner nulls _route synchronously but AWAITS the AsyncStorage removals, and
// updateNavBanner re-loads the route from storage whenever _route is null — so for the
// length of those awaits a GPS tick could resurrect the just-ended route and fire a
// SECOND arrival (two spoken lines, teardown twice). Applies to the phone's teardown
// as much as this one, since both funnel through stopNavBanner.
let _navEnding = false;
// Best-effort PB for a cold drive: the fastest fix THIS context saw. A drive that
// started in another context reports 0, which recordTrip already treats as "unknown".
let _coldMaxSpeedMs = 0;

function resetColdArrival(): void {
  _coldArrived = false;
  _navEnding = false;
  _coldMaxSpeedMs = 0;
  _coldSettleSince = null;
  if (_coldSettleTimer) { clearTimeout(_coldSettleTimer); _coldSettleTimer = null; }
}

// Record a car-started drive. The phone's onArrive does this from React state; a
// headless context has none, so everything comes off what startNavBanner persisted
// plus the cached user (there is no AuthProvider out here).
//
// ROUTED DRIVES ONLY, deliberately — the only caller is arrival, and arrival only
// exists while navigating. Free driving is never recorded, which is what makes the
// count a clean "people are actually using Hairpin to get somewhere" number.
// recordTrip's own <500 m guard then drops routes abandoned in the driveway.
async function recordColdTrip(r: SlimRoute | null, polyline: string): Promise<void> {
  if (!r?.startedAt || !(r.totalM && r.totalM > 0)) return;   // pre-2026-07-31 route
  let userId: string | undefined;
  let handle: string | undefined;
  try {
    const raw = await AsyncStorage.getItem(USER_CACHE_KEY);
    const u = raw ? JSON.parse(raw) : null;
    // Same shape guard auth.tsx applies: a half-written blob must not become a
    // "signed in" user and attribute someone else's drive.
    if (u && typeof u.id === "string") { userId = u.id; handle = u.handle || undefined; }
  } catch {}
  if (!userId) return;   // signed out / unknown — recordTrip could not attribute it anyway
  let communityId: string | undefined;
  try { communityId = getSettings().activeCommunityId || undefined; } catch {}
  await recordTrip({
    startedAt: r.startedAt,
    distanceM: r.totalM,
    // Elapsed wall-clock, exactly as the phone computes it — not the route's planned
    // duration, which would ignore traffic and every stop along the way.
    durationS: Math.max(0, (Date.now() - r.startedAt) / 1000),
    destLabel: r.destLabel || "Drive",
    polyline,
    destLat: r.destLat,
    destLng: r.destLng,
    topSpeedKmh: _coldMaxSpeedMs > 0 ? _coldMaxSpeedMs * 3.6 : 0,
    userId, handle, communityId,
  });
}

async function fireColdArrival(late: boolean): Promise<void> {
  if (_coldArrived) return;
  _coldArrived = true;
  if (_coldSettleTimer) { clearTimeout(_coldSettleTimer); _coldSettleTimer = null; }
  // Capture BEFORE the teardown: stopNavBanner nulls _route synchronously and removes
  // NAV_POLY_KEY, so reading either afterwards would record an empty drive.
  const done = _route;
  let poly = "";
  try { poly = (await AsyncStorage.getItem(NAV_POLY_KEY)) || ""; } catch {}
  // Same order the phone uses: speak FIRST (stopNavBanner doesn't stop speech, so the
  // line plays out), then the universal teardown. stopNavBanner already clears the
  // route + navigating flag on the car, drops the persisted route/progress/CAR_NAV
  // keys, releases the bg-location hold and dismisses the notification — it IS the
  // cold equivalent of map.tsx's teardown. destinationLabel is the one thing it never
  // owned, so clear it here or the head unit keeps naming a place you already left.
  // ⚠ SPEAK ONLY DURING A LIVE DRIVE. speak() has no foreground gate and this function is
  // reachable from the BACKGROUND location task, so an unconditional announce here is how
  // the app talks to nobody. A car session (head unit attached) or a foregrounded app is
  // the proof that someone is actually there to hear it; otherwise tear down in silence.
  const liveDrive = _locConsumers.has('androidauto') || _locConsumers.has('carplay')
    || AppState.currentState === 'active';
  if (!late && liveDrive) { try { announce(arrivalLine()); } catch {} }
  // Before the teardown, and never allowed to block it — a failed upload must cost a
  // leaderboard row, never leave the route stuck on the head unit.
  try { await recordColdTrip(done, poly); } catch {}
  try { await stopNavBanner(); } catch {}
  try { setCarState({ destinationLabel: "" }); } catch {}
}

// Mirrors the phone's arrival logic exactly (nav.ts). Returns true once it has fired.
// Distance still to run to the DESTINATION, or null when this route cannot express it.
// Mirrors nav.ts's `remaining`, and exists for the same reason: `idx >= stepCount - 1`
// is really a 25 m gate (the advance loop only moves on inside 25 m of a step end, and
// the last two step ends are both the destination), so gating on it made ARRIVE_SETTLE_M
// unreachable.
//
// ⚠ RETURNS NULL RATHER THAN A GUESS. A slim route persisted before the Wave-2 fields
// existed has no per-step distanceM, so summing would yield `d` on EVERY step — and
// `d < ARRIVE_M` two steps out would auto-finish the drive miles early. Fail back to the
// old last-step gate instead; conservative is correct here.
function coldRemainingM(steps: SlimStep[], idx: number, d: number): number | null {
  let sum = d;
  for (let i = idx + 1; i < steps.length; i++) {
    const m = steps[i].distanceM;
    if (typeof m !== "number" || !Number.isFinite(m)) return null;   // legacy route
    sum += m;
  }
  return sum;
}

function evaluateColdArrival(steps: SlimStep[], idx: number, stepCount: number, d: number, speedMs?: number): void {
  // The phone engine owns arrival whenever it is running — it also records the trip
  // and learns the drive, which this path cannot. Never race it.
  if (isPhoneTbtSpeaking() || _coldArrived || _navEnding) return;
  const rem = coldRemainingM(steps, idx, d);
  // Same axis as nav.ts when the route supports it; the old 25 m-equivalent gate when not.
  const dDest = rem ?? (idx >= stepCount - 1 ? d : Number.POSITIVE_INFINITY);
  const isLast = dDest < Number.POSITIVE_INFINITY;
  if (isLast && dDest < ARRIVE_M) { void fireColdArrival(false); return; }
  if (isLast && dDest < ARRIVE_SETTLE_M && Math.max(0, speedMs ?? 0) < ARRIVE_SETTLE_SPEED_MS) {
    const now = Date.now();
    if (_coldSettleSince == null) {
      _coldSettleSince = now;
      if (_coldSettleTimer) clearTimeout(_coldSettleTimer);
      _coldSettleTimer = setTimeout(() => {
        _coldSettleTimer = null;
        const since = _coldSettleSince;
        if (since == null) return;   // moved off again before this landed
        void fireColdArrival(Date.now() - since > ARRIVE_SETTLE_MS + ARRIVE_SPEAK_MAX_LATE_MS);
      }, ARRIVE_SETTLE_MS);
    } else if (now - _coldSettleSince >= ARRIVE_SETTLE_MS) {
      void fireColdArrival(false);
    }
    return;
  }
  _coldSettleSince = null;
  if (_coldSettleTimer) { clearTimeout(_coldSettleTimer); _coldSettleTimer = null; }
}

export async function updateNavBanner(lat: number, lng: number, speedMs?: number): Promise<void> {
  if (_navEnding) return;   // a teardown is in flight; do not resurrect it from storage
  let route = _route;
  if (!route) {
    // ── DON'T RE-READ THE DISK EVERY FIX WHEN THERE IS NO ROUTE (2026-07-31) ──
    // This is on a 1 Hz path and, since 0717548 this morning, on TWO of them (the bg
    // task and the foreground car feed). With Android Auto connected and no route —
    // the ordinary free-drive case — `_route` is null forever, so every single fix did
    // an AsyncStorage round-trip, twice a second, for as long as the feed ran. That is
    // pure waste: a route started in THIS context sets `_route` directly in
    // startNavBanner, so the only thing this read can discover is a route persisted by
    // a DIFFERENT (headless) context, which a few seconds of delay cannot hurt.
    const nowLook = Date.now();
    if (nowLook - _routeLookAt > ROUTE_LOOKUP_THROTTLE_MS) {
      _routeLookAt = nowLook;
      try { const raw = await AsyncStorage.getItem(ROUTE_KEY); if (raw) route = JSON.parse(raw); } catch {}
      // A route with no startedAt was persisted before that field existed (2026-07-31),
      // so by definition it is old too. Either way: not the drive we are on.
      const startedAt = (route as SlimRoute | null)?.startedAt;
      if (route && (!startedAt || nowLook - startedAt > MAX_PERSISTED_ROUTE_AGE_MS)) {
        route = null;
        try { await stopNavBanner(); } catch {}   // clears the keys AND releases the location hold
        return;
      }
    }
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

  // Auto-finish for a car-started drive (see resetColdArrival's header). Evaluated
  // before the banner writes below so the last thing the driver sees is the teardown,
  // not a freshly-posted "Arriving" banner for a route that just ended.
  if (typeof speedMs === "number" && speedMs > _coldMaxSpeedMs) _coldMaxSpeedMs = speedMs;
  evaluateColdArrival(steps, idx, steps.length, d, speedMs);
  if (_coldArrived) return;

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
  // ── ONE WRITER FOR THE CAR'S TBT STRIP (2026-07-31) ────────────────────────
  // Jeff, first reported 31 July and again after several drives: the CarPlay ETA banner
  // "glitches all the time" — numbers jumping AND the banner redrawing. Phone only ever
  // reads the turn engine directly; ONLY CarPlay reads carStore, which is exactly the
  // surface he named.
  //
  // Cause: TWO engines wrote these same fields, ungated against each other.
  //   warm (ConvoyCarPlay mirror, while tbt.active): the 3-tier segment ETA,
  //         fmtDistanceM (metre precision), distances off the live route
  //   cold (here, every fix): remainM * paceSPerM — a FLAT average pace — and
  //         fmtManeuverDist, which rounds to the nearest 10 m under 300 m
  // Two different answers alternating into one banner: the numbers jump, and every
  // write notifies carStore so CarSurface re-renders — the flicker. The comment on the
  // warm mirror already ASSUMED this exclusivity ("the mirror only overwrites once tbt
  // goes active, whose richer numbers then win legitimately"); nothing enforced it.
  //
  // Worsened today: 0717548 added a SECOND cold caller (startForegroundCarFeed), so the
  // cold writer ran on two feeds instead of one — roughly double the fighting, which is
  // why "a couple of days ago" became "all the time".
  //
  // isPhoneTbtSpeaking() is the arbiter already used for lanes and for cold arrival.
  // When the phone engine owns guidance, the cold path writes NONE of the strip.
  const phoneOwnsStrip = isPhoneTbtSpeaking();
  setCarState({
    ...(phoneOwnsStrip ? {} : {
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
      // COLD lane guidance — its lanes are anchored to the richer route when the phone
      // engine is driving, so they belong to the same owner; fail-closed → hidden.
      lanes: pickLaneCue(_laneCues, { lat: steps[idx].endLat, lng: steps[idx].endLng }, d) || undefined,
    }),
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

// Posted speed limit for the car surfaces. This used to be a SECOND, near-identical
// copy of the phone's pipeline (its own ways cache, centre, throttle and in-flight
// flag) — which is exactly why the sign was "kinda random and not always in sync
// with CarPlay/phone": two caches, fetched at different times from different
// positions, resolving independently. It also lacked the phone's stale-cache
// self-heal. speedLimit.ts now owns ONE pipeline; this just feeds it a position and
// mirrors the shared value into carStore.
function maybeUpdateSpeedLimit(lat: number, lng: number): void {
  setCarState({ speedLimitKmh: updateSpeedLimit(lat, lng) ?? undefined });
}

// Background location task — fires on each location update (foreground AND
// background) and drives the banner. Registered at module load.
let _navTaskTicks = 0;
// ── BACKGROUND FIX BUS (2026-07-30) ─────────────────────────────────────────
// Tester report: "routing with the screen off, CarPlay does not re-route if I take a
// different route — I have to open the phone, then it re-routes."
//
// Root cause: off-route detection lives in useTurnByTurn (nav.ts), which only sees
// positions the MAP SCREEN hands it, and map.tsx's only continuous source is a
// foreground watchPositionAsync. Lock the phone and that watch stops delivering, so
// `coords` freezes, the streak counters never advance, and onOffRoute can never fire.
// THIS task keeps running the whole time — it is what holds the banner, the car marker
// and the speed limit alive — but it had no off-route logic of its own, so nothing
// noticed the driver had left the line. Unlocking resumes the watch, the engine sees a
// huge jump, and it re-routes instantly. Exactly the reported behaviour.
//
// The fix is deliberately NOT to reimplement off-route detection here. That logic is
// subtle (perpendicular distance, heading gate, missed-maneuver fast path, three
// different streak thresholds) and a second copy would drift from the first — the same
// duplication that gave the route trim two different formulas for months. Instead the
// background fix is PUBLISHED, and map.tsx feeds it to the one existing engine.
type BgFix = { lat: number; lng: number; heading?: number; speed?: number };
const _bgFixListeners = new Set<(f: BgFix) => void>();
export function subscribeBgFix(fn: (f: BgFix) => void): () => void {
  _bgFixListeners.add(fn);
  return () => { _bgFixListeners.delete(fn); };
}
function _emitBgFix(f: BgFix): void {
  _bgFixListeners.forEach((l) => { try { l(f); } catch {} });
}

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
  // Position AND SPEED through the source-priority gate (lowest priority; yields to the
  // fg watch / phone mirror while they're fresh, takes over when they go stale). speed
  // rides the gate as of 2026-07-30 — it drives the chase-zoom curve, so a fix that was
  // rejected for position must not move the framing either. carDbg stays ungated: it is
  // the on-screen proof that bg ticks are arriving and must land regardless.
  setCarSelfPosition(
    loc.coords.latitude, loc.coords.longitude,
    typeof _h === "number" && _h >= 0 ? _h : null,
    'bgtask',
    typeof _sp === "number" && _sp >= 0 ? _sp : 0,
  );
  setCarState({
    carDbg: "navtask#" + (++_navTaskTicks), // on-screen proof bg ticks are arriving
  });
  // Hand the same fix to any foreground consumer (map.tsx -> useTurnByTurn), so
  // off-route detection and re-routing keep working with the screen off. Emitted
  // AFTER the unconditional position write above and wrapped by the bus itself, so a
  // listener that throws can never cost the car surface its fix.
  _emitBgFix({
    lat: loc.coords.latitude,
    lng: loc.coords.longitude,
    heading: typeof _h === "number" && _h >= 0 ? _h : undefined,
    speed: typeof _sp === "number" && _sp >= 0 ? _sp : 0,
  });
  // Best-effort metadata — wrapped so it can never block the position write above.
  // (cache may be unhydrated in a separate bg JS context → defaults, which is fine.)
  try {
    setCarState({ selfCarColor: getSettings().carColor, mapMode: getMapMode(getSettings()) });
  } catch {}
  maybeUpdateSpeedLimit(loc.coords.latitude, loc.coords.longitude);
  await updateNavBanner(
    loc.coords.latitude, loc.coords.longitude,
    typeof _sp === "number" && _sp >= 0 ? _sp : 0,
  );
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
        // Position AND SPEED through the source-priority gate ('fgwatch' — beats the bg
        // task, yields to the phone mirror while it's fresh). See the bgtask write above
        // for why speed now rides the gate. carDbg stays ungated.
        setCarSelfPosition(
          loc.coords.latitude, loc.coords.longitude,
          typeof h === "number" && h >= 0 ? h : null,
          'fgwatch',
          typeof sp === "number" && sp >= 0 ? sp : 0,
        );
        setCarState({ carDbg: "fgfeed" });
        // Best-effort metadata — wrapped so it can never block the position write.
        try {
          setCarState({ selfCarColor: getSettings().carColor, mapMode: getMapMode(getSettings()) });
        } catch {}
        maybeUpdateSpeedLimit(loc.coords.latitude, loc.coords.longitude);
        // Drive the cold nav engine from THIS feed too, not just the bg task. The bg
        // task needs "Always" location; this watch only needs "While using", and while
        // Android Auto is projecting the app counts as in use. Without this, a cold AA
        // drive on a While-using grant had no step tracking and so no arrival at all.
        // Gated on the phone engine being idle so a warm drive keeps exactly one caller
        // (map.tsx's) and the banner can't be posted twice per turn.
        if (!isPhoneTbtSpeaking()) {
          void updateNavBanner(
            loc.coords.latitude, loc.coords.longitude,
            typeof sp === "number" && sp >= 0 ? sp : 0,
          );
        }
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
      // Trip baseline for a COLD arrival's recordTrip (see recordColdTrip).
      totalM: route.distance_m > 0 ? route.distance_m : undefined,
      startedAt: Date.now(),
      destLat: route.steps?.[route.steps.length - 1]?.end?.lat,
      destLng: route.steps?.[route.steps.length - 1]?.end?.lng,
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
    resetColdArrival();  // a new route must be able to arrive again
    _routeLookAt = 0;    // and be discoverable by the other feed at once
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

// When this nav session started, from the slim route startNavBanner persists on EVERY
// surface. Synchronous, so onArrive can use it as a last-resort trip baseline instead
// of Date.now() — which silently recorded 0-minute drives. Null when nothing is active.
export function getNavStartedAt(): number | null {
  return _route?.startedAt ?? null;
}

export async function stopNavBanner(): Promise<void> {
  _navEnding = true;   // close the resurrect-from-storage window (see the flag's note)
  _route = null;
  _stepIdx = 0;
  _notifiedStep = -1;
  _coldSettleSince = null;
  if (_coldSettleTimer) { clearTimeout(_coldSettleTimer); _coldSettleTimer = null; }
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
