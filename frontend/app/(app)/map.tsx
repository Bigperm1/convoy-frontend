import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, Platform, Image, Animated, Modal, Linking, Switch, PanResponder, TextInput, AppState, Pressable } from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import Constants from "expo-constants";
import { api, formatErr, wsUrl } from "../../src/api";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { useRouter, useFocusEffect } from "expo-router";
import Glass, { GlassFill, hudTint, drawerTint, glassLift } from "../../src/Glass";
import ConvoyMapbox, { type Hazard, type Peer, contrastingRouteColor } from "../../src/ConvoyMapbox";
import DestinationSearch from "../../src/DestinationSearch";
import UpdateReadyPill from "../../src/UpdateReadyPill";
import CategoryPills, { PlaceResult } from "../../src/components/CategoryPills";
import LogoMenu from "../../src/components/LogoMenu";
import { supabase, SUPABASE_ENABLED, SupaHazard } from "../../src/supabase";
import { voiceBus, geocodeQuery } from "../../src/voiceBus";
import { useCommunityRoutes, createCommunityRoute, CommunityRoute } from "../../src/communityRoutes";
import TurnByTurnNav, { SpeedPill } from "../../src/components/TurnByTurnNav";
import { MapNowPlaying } from "../../src/components/MapNowPlaying";
import { ReportToast, MusicToast, HailToast, InfoToast } from "../../src/components/AlertToast";
import { HazardDrawer, ReportPeekTab } from "../../src/components/FloatingButtons";
import StepDrawer, { StepDrawerHandle, DRAWER_HEIGHT } from "../../src/components/StepDrawer";
import { hailBus } from "../../src/hailBus";
import { subscribeAvatarHold } from "../../src/avatarHoldBus";
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { ensureLocationPermission as askLocationPermission, askPermission } from "../../src/permissionGate";
import { useSettings, getSettings, updateSettings, updateSettings as updateGlobalSettings, getMapMode, getMapModeChoice, getAvatarMode, setAvatarMode, getSelfMarkerType, getClassPaint, getVehicleClass, unitForCountry, getSpeedAlertMode, getRouteColor } from "../../src/settings";
import { getProximityTier, setLatestTier } from "../../src/proximityAudio";
import { useConvoyPresence, ConvoyPresencePeer } from "../../src/convoyPresence";
import { BearingTracker } from "../../src/bearing";
import PeerModal from "../../src/PeerModal";
import LiveRosterSheet from "../../src/LiveRosterSheet";
import ShareSheet from "../../src/ShareSheet";
import {
  fetchRoutes, fetchAiRoute, NavRoute, useTurnByTurn, maneuverVerb,
  fmtDistanceM, fmtManeuverDist, fmtEtaSec, stopSpeech, announce, haversineMeters,
  useRouteTrafficRefresh, fetchRouteViaStops,
} from "../../src/nav";
import { getDepartureBearing, noteCourse, orderRoutesForward, UTURN_ONLY_TOLERANCE_DEG } from "../../src/departureBearing";
import { shareablePosition, shareablePositionAsync, noteCarConnected, noteFix, hydrateLocationPrivacy, parkEndedByHeadUnit, headUnitAttachedRaw } from "../../src/locationPrivacy";
import CarDriveList from "../../src/CarDriveList";
import { subscribeBgFix } from "../../src/navNotification";
import { type CongestionLevel } from "../../src/mapboxDirections";
import { useMapView2D, toggleMapView2D, resetMapView2D } from "../../src/mapViewMode";
import { logEvent } from "../../src/crashBreadcrumb";
import { optimizeStopOrder, isSameOrder, ROUTABLE_MAX_STOPS } from "../../src/routeOptimizer";
import { usePitstop } from "../../src/pitstop";
import { recordTrip, consumeTakeAgain, cachePeerPbs } from "../../src/trips";
import PitstopCard from "../../src/components/PitstopCard";
import { useConvoyCarPlay } from "../../src/carplay/ConvoyCarPlay";
import { setCarState, setCarPeers, subscribeCarGesture } from "../../src/carplay/carStore";
import { useVoice } from "../../src/useVoice";
import WeatherHUD from "../../src/components/WeatherHUD";
import { useWeatherLayer, useDestinationWeather, useDailyForecast, pickForecastAt, weatherKind } from "../../src/weatherLayer";
import { useSpeedCameras } from "../../src/speedCameras";
import { useDriveBcEvents } from "../../src/driveBcEvents";
import { usePowerMode } from "../../src/powerMode";
import { useSpeedLimit, getSpeedLimitDebug } from "../../src/speedLimit";
import { playSpeedDing } from "../../src/speedDing";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { addRecentRoute } from "../../src/recentRoutes";
import { prepareRouteGreeting, playPreparedGreeting, clearPreparedGreeting } from "../../src/novaGreeting";
import { useSavedPlaces, saveSavedPlace, removeSavedPlace, resolveTarget, ensureSavedPlacesLoaded, matchSavedPlace, predictDestination, recordDeparture, type SavedPlace } from "../../src/savedPlaces";
import { recordDrive, matchAiRoute, viaPointsFor, ensureAiRoutesLoaded } from "../../src/aiRoutes";
import { askScout } from "../../src/askScout";
import { recordOver, habitualOverKmh } from "../../src/speedProfile";
import NavSearchScreen from "../../src/NavSearchScreen";
import { CarouselMember } from "../../src/components/MemberCarousel";
import { shareInbox } from "../../src/shareInbox";
import { cruisePlot } from "../../src/cruisePlot";
import { startNavBanner, stopNavBanner, updateNavBanner, swapNavRoute, isNavSessionLive, acquireBgLocation, askAlwaysLocationOnce, getNavStartedAt, CAR_NAV_KEY } from "../../src/navNotification";
import { onCarNavStarted } from "../../src/carplay/carActions";
import { PoliceBadgeIcon } from "../../src/components/MapControlIcons";
import CompassNeedle from '../../src/components/CompassNeedle';
import { startHeatProbe, stopHeatProbe } from '../../src/heatProbe';

type RouteInfo = {
  distance_text: string;
  duration_text: string;
  steps: { html: string; distance_text: string; maneuver?: string }[];
};

const maneuverIcon = (m?: string, html?: string): any => {
  // Routes API v2 maneuvers are UPPER_SNAKE ("TURN_LEFT", "RAMP_RIGHT", …);
  // legacy/cached data is lower-kebab ("turn-left"). Lowercase so ONE set of
  // substring checks covers both. The old code tested lowercase against the
  // uppercase enum, never matched, and every turn fell through to a straight
  // arrow. Check the COMPOUND maneuvers (uturn/merge/ramp) before the bare
  // left/right tests, since their names also contain "left"/"right" and would
  // otherwise be drawn as a plain turn arrow.
  // Keep this DIRECTIONALLY consistent with the car banner's maneuverDir() feeding
  // <ManeuverArrow> (ConvoyCarPlay.tsx) so the phone + head unit never show a
  // different arrow for the same turn. Ramp/exit was "swap-horizontal" (a ⇄) — wrong; it's a rightward
  // exit like CarPlay's ↗.
  const fromCode = (s: string): string | null => {
    if (s.includes("uturn") || s.includes("u-turn")) return "arrow-undo";
    if (s.includes("merge")) return "git-merge";
    if (s.includes("ramp") || s.includes("exit") || s.includes("fork")) return "arrow-redo";
    if (s.includes("left")) return "arrow-back";
    if (s.includes("right")) return "arrow-forward";
    return null;
  };
  const code = m ? fromCode(m.toLowerCase()) : null;
  if (code) return code;
  // Maneuver missing/unhelpful (DEPART, STRAIGHT, or blank) — the instruction
  // text reliably carries the direction ("Turn left onto Main St"). Scan it with
  // word boundaries so street names ("Wright St", "Leftbank Ave") don't trip a
  // false turn.
  const h = (html || "").toLowerCase();
  if (/\bu-?turn\b/.test(h)) return "arrow-undo";
  if (/\bmerge\b/.test(h)) return "git-merge";
  if (/\b(exit|ramp|fork)\b/.test(h)) return "arrow-redo";
  if (/\bleft\b/.test(h)) return "arrow-back";
  if (/\bright\b/.test(h)) return "arrow-forward";
  return "arrow-up";
};

// ---- Foreground-location permission, resolved AT MOST once per launch ----
// Reads the saved status first and only fires the OS prompt when it's still
// "undetermined" (the genuine first launch). All three location consumers
// (initial fix + continuous watcher + turn-by-turn watcher) funnel through
// here, and an in-flight lock means simultaneous callers on a cold start share
// ONE request instead of stacking duplicate prompts.
//
// NOTE: iOS only persists "Allow While Using App". If a tester taps "Allow
// Once", iOS resets the status to undetermined on the next cold start, so the
// prompt legitimately returns — that's an OS behavior we can't suppress. The
// fix below stops the APP from ever re-prompting once permission is granted.
let _locPermInFlight: Promise<boolean> | null = null;
async function ensureLocationPermission(): Promise<boolean> {
  if (_locPermInFlight) return _locPermInFlight;
  _locPermInFlight = (async () => {
    try {
      let { status } = await Location.getForegroundPermissionsAsync();
      if (status === "undetermined") {
        // Through the shared gate so this can never land on top of another OS
        // sheet (mic / notifications). Location is the FIRST thing asked for,
        // because the Map is the landing screen and is useless without it.
        // See src/permissionGate.ts.
        status = (await askLocationPermission()) as typeof status;
      }
      return status === "granted";
    } catch {
      return false;
    }
  })();
  const granted = await _locPermInFlight;
  _locPermInFlight = null;   // allow a fresh re-read later (e.g. after Settings change)
  return granted;
}

// Add stops / Saved route pills are designed but hidden until their features
// (multi-stop routing + saved places) are built. Flip to true to reveal them.
const SHOW_EXTRA_ROUTE_PILLS = false;

// The bottom tab bar's fixed height (mirrors app/(app)/_layout.tsx). Banners
// float just above it; the FABs + speedo + weather lift above the active
// banner. The tab bar itself ALWAYS stays visible so the user can leave Maps.
const TAB_BAR_H = Platform.OS === 'ios' ? 86 : 84;

const LAST_LOC_KEY = "convoy:lastLoc";

// Once-per-app-session guard for the CarPlay "Always location" CTA below —
// module-level so a map remount (tab switches) can't re-nag mid-drive.
let _carAlwaysCtaShownThisSession = false;

// Format a Date as a 12-hour clock like "10:42 AM" without relying on Intl
// (Hermes' Intl is limited on device, so we build the string by hand).
function fmtClock(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m < 10 ? "0" + m : m} ${ampm}`;
}

// ===== Proactive-reroute hazard helpers =====
// Only these hazard kinds justify suggesting a detour — a police pin doesn't
// slow you down, so it never triggers a reroute prompt.
const REROUTE_HAZARD_KINDS = new Set(["accident", "road", "traffic"]);

// Spoken phrase fragment: "there's <X> ahead".
function hazardReason(kind: string): string {
  switch (kind) {
    case "accident": return "an accident";
    case "road": return "a road hazard";
    case "traffic": return "heavy traffic";
    default: return "a holdup";
  }
}
// Short prompt title for the on-screen Yes/No dialog.
function hazardTitle(kind: string): string {
  switch (kind) {
    case "accident": return "Accident ahead";
    case "road": return "Road hazard ahead";
    case "traffic": return "Heavy traffic ahead";
    default: return "Slowdown ahead";
  }
}
// Nearest reroute-worthy hazard that lies AHEAD on the way to the destination
// (closer to the destination than we currently are) and within ~3 km. Returns
// its kind + distance rounded to whole km (min 1), or null if none qualifies.
function nearestHazardAhead(
  origin: { lat: number; lng: number },
  dest: { lat: number; lng: number },
  hazards: { kind: string; lat: number; lng: number }[]
): { kind: string; distKm: number } | null {
  const myDistToDest = haversineMeters(origin, dest);
  let best: { kind: string; distM: number } | null = null;
  for (const h of hazards || []) {
    if (!h || !REROUTE_HAZARD_KINDS.has(h.kind)) continue;
    if (typeof h.lat !== "number" || typeof h.lng !== "number") continue;
    const distM = haversineMeters(origin, { lat: h.lat, lng: h.lng });
    if (distM > 3000) continue;                                  // not close yet
    if (haversineMeters({ lat: h.lat, lng: h.lng }, dest) > myDistToDest) continue; // behind us
    if (!best || distM < best.distM) best = { kind: h.kind, distM };
  }
  if (!best) return null;
  return { kind: best.kind, distKm: Math.max(1, Math.round(best.distM / 1000)) };
}

// Sample a handful of [lng,lat] waypoints along the part of `coords` (a route's full
// decoded geometry) that lies AHEAD of `origin`. Feeding these to fetchAiRoute pins a
// fresh Directions request to YOUR current route, so it returns your route's LIVE
// traffic-aware remaining time — the thing tbt.etaSeconds (a static proportional
// estimate) can't tell us. Returns [] when there isn't enough road left to sample.
function routeAheadViaPoints(
  coords: [number, number][] | undefined,
  origin: { lat: number; lng: number },
  maxVia = 8
): [number, number][] {
  if (!coords || coords.length < 4) return [];
  let ni = 0, bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const dLng = coords[i][0] - origin.lng, dLat = coords[i][1] - origin.lat;
    const d = dLng * dLng + dLat * dLat;
    if (d < bestD) { bestD = d; ni = i; }
  }
  const interior = coords.slice(ni + 1, coords.length - 1); // ahead of the car, exclude dest
  if (interior.length < 2) return [];
  if (interior.length <= maxVia) return interior;
  const out: [number, number][] = [];
  const step = interior.length / maxVia;
  for (let i = 0; i < maxVia; i++) out.push(interior[Math.floor(i * step + step / 2)]);
  return out;
}

// Meters from point p to segment a–b, all [lng,lat]. Local equirectangular projection
// (accurate at the short distances used here). Used to tell if an alt point still lies
// ON the current route.
function distPointToSegM(p: [number, number], a: [number, number], b: [number, number]): number {
  const latRef = ((p[1] + a[1] + b[1]) / 3) * Math.PI / 180;
  const mLat = 111320, mLng = 111320 * Math.cos(latRef);
  const px = p[0] * mLng, py = p[1] * mLat, ax = a[0] * mLng, ay = a[1] * mLat, bx = b[0] * mLng, by = b[1] * mLat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
function minDistToPathM(p: [number, number], path: [number, number][], tol: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const d = distPointToSegM(p, path[i], path[i + 1]);
    if (d < best) best = d;
    if (best <= tol) break;
  }
  return best;
}

// Where an alternative route DIVERGES from the current one — the last point the two share
// before the alt peels off (the exit / turn you'd need to take). Returns that point + the
// distance to it along the alt (≈ how far ahead the decision is), so the offer can be
// timed to give lane-change notice. null if they don't split within the search window
// (decision still too far ahead to surface).
const DIVERGE_TOL_M = 35;          // within this of the current path = still "together"
const DIVERGE_SEARCH_M = 14000;    // give up looking past this far ahead
function routeDivergence(
  cur: [number, number][] | undefined,
  alt: [number, number][] | undefined
): { lat: number; lng: number; distM: number } | null {
  if (!cur || !alt || cur.length < 2 || alt.length < 2) return null;
  let distM = 0;
  let prev = alt[0];
  for (let i = 1; i < alt.length; i++) {
    // Accumulate BEFORE the split test, so an early divergence reports the real distance
    // to the split (not 0). Return the first point that LEFT the route ≈ the exit/turn.
    distM += haversineMeters({ lat: prev[1], lng: prev[0] }, { lat: alt[i][1], lng: alt[i][0] });
    if (minDistToPathM(alt[i], cur, DIVERGE_TOL_M) > DIVERGE_TOL_M) {
      return { lat: alt[i][1], lng: alt[i][0], distM };
    }
    prev = alt[i];
    if (distM > DIVERGE_SEARCH_M) break;
  }
  return null;
}

// The alt route step nearest a point (its spoken instruction, e.g. "Take exit 12 toward …"),
// so the offer can name the maneuver + lane the driver should get ready for.
function maneuverNear(route: NavRoute | null, lat: number, lng: number): string | null {
  const steps = route?.steps;
  if (!steps?.length) return null;
  let best: string | null = null, bestD = Infinity;
  for (const s of steps) {
    const st = s.start; if (!st) continue;
    const d = haversineMeters({ lat, lng }, { lat: st.lat, lng: st.lng });
    if (d < bestD) { bestD = d; best = (s.html || "").replace(/<[^>]+>/g, "").trim() || null; }
  }
  return bestD <= 250 ? best : null;
}


// How long the map stays where the driver put it before the chase cam takes back
// over. Expressed once so the timestamp and the fast-path timer cannot drift.
const PAN_RECENTER_MS = 20000;
// How quiet the foreground watch must go before background fixes take over. The nav
// watch delivers at ~1-2 Hz, so 3s means "the fg watch has genuinely stopped" (a
// locked screen) rather than "we're between fixes".
const BG_FIX_TAKEOVER_MS = 3000;

// ===== Nova speeding-alert lines =====
// tier 1 = light/humorous nudge (~20 over); tier 2 = firmer warning (~40 over).
// `over` is the amount over the limit in the driver's own unit; `hey` is an
// optional "<call sign>, " prefix. First letter is capitalized so it reads right
// whether or not a call sign is present.
function speedingLine(tier: 1 | 2, over: number, hey: string): string {
  const nudges = [
    `${hey}lead foot much? You're ${over} over the limit, save it for the track.`,
    `${hey}the GR is loving this, but the speed limit isn't. You're ${over} over.`,
    `${hey}someone's in a hurry. That's ${over} over the limit, keep it sensible.`,
    `${hey}feeling spicy? You're ${over} over the posted limit. Ease off a touch.`,
    `${hey}easy does it, speed racer. You're ${over} over the limit.`,
  ];
  const warns = [
    `${hey}slow it down. You're ${over} over the limit. That's a serious ticket and a real risk.`,
    `${hey}ease off now. ${over} over the posted limit is pushing your luck.`,
    `${hey}bring it back down. You're ${over} over the limit, this one's not worth it.`,
    `${hey}seriously, back off the throttle. ${over} over is dangerous territory.`,
    `${hey}dial it back now. You're ${over} over the limit — that's a real risk to everyone.`,
  ];
  const pool = tier === 2 ? warns : nudges;
  const raw = pool[Math.floor(Math.random() * pool.length)];
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Pick a random entry from a non-empty pool.
function pick<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

// ===== Nova line pools — ≥5 variations each so she doesn't repeat herself =====
const REROUTE_ACCEPT_LINES = [
  "Okay, taking the faster route.",
  "Got it, switching to the quicker way.",
  "Rerouting you to the faster road now.",
  "Done — we'll take the faster route.",
  "Sure thing, jumping on the quicker route.",
];

// Relative time for the "shared X ago" credit on a received route.
function shareRelTime(ms?: number): string {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const SPEED_CAMERA_LINES = [
  "Speed camera ahead.",
  "Heads up, speed camera coming up.",
  "Speed camera ahead, watch your speed.",
  "Camera ahead — ease off a touch.",
  "Speed camera just ahead, keep it legal.",
];

// Hazard-ahead callouts keyed by hazard kind, so the phrasing fits each kind,
// with a generic fallback for anything else.
const HAZARD_AHEAD_LINES: Record<string, string[]> = {
  police: [
    "Heads up, police reported ahead.",
    "Police spotted ahead, mind your speed.",
    "Cops reported up ahead.",
    "Heads up — police on the road ahead.",
    "Police ahead, keep it clean.",
  ],
  accident: [
    "Accident reported ahead.",
    "Heads up, crash reported up ahead.",
    "There's an accident on the road ahead.",
    "Accident ahead, take it easy.",
    "Collision reported ahead, stay sharp.",
  ],
  traffic: [
    "Traffic reported ahead.",
    "Heads up, slow traffic ahead.",
    "Congestion reported up ahead.",
    "Traffic building ahead.",
    "Slowdown reported on the road ahead.",
  ],
};
const HAZARD_AHEAD_FALLBACK = [
  "Hazard on the road ahead.",
  "Heads up, hazard reported ahead.",
  "Something on the road ahead, stay alert.",
  "Hazard reported up ahead.",
  "Watch out, hazard ahead.",
];
function hazardAheadLine(kind: string): string {
  return pick(HAZARD_AHEAD_LINES[kind] ?? HAZARD_AHEAD_FALLBACK);
}

// Report-confirmation lines. `label` is the hazard kind ("Police", "Hazard", …).
function reportConfirmLine(label: string): string {
  return pick([
    `${label} reported. Thanks driver.`,
    `${label} on the map. Thanks for the heads up.`,
    `Got it — ${label.toLowerCase()} reported. Nice one.`,
    `${label} reported. The convoy's got your back.`,
    `Thanks driver, ${label.toLowerCase()} is on the map.`,
  ]);
}

export default function MapScreen() {
  const { user, token, refresh } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const navInset = Platform.OS === "android" ? insets.bottom : 0;
  const [coords, setCoords] = useState<{ lat: number; lng: number; heading?: number; speed?: number } | null>(null);

  // ---- Personal Best speed tracking ----
  // sessionMaxSpeed: highest km/h seen since the screen mounted (in-memory only).
  // We compare it against the user's persisted top_speed_record on each tick;
  // once we beat the persisted record we PUT it to the backend, throttled to
  // at most once every 60s to keep battery + network use low while driving.
  const [sessionMaxSpeed, setSessionMaxSpeed] = useState(0);
  const lastTopSyncAtRef = useRef(0);
  // Heading tracker — resolves a stable marker heading from GPS heading when
  // moving, or inferred travel bearing when GPS heading is missing/zero, so a
  // parked car keeps pointing its last direction of travel instead of snapping
  // north. Shared across self + peers (keyed by id).
  const bearingTrackerRef = useRef(new BearingTracker());
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [showReport, setShowReport] = useState(false);
  const [selected, setSelected] = useState<Hazard | null>(null);
  const [destination, setDestination] = useState<{ lat: number; lng: number; label: string } | null>(null);
  // When a crew member shares a route, the recipient gets this metadata so the
  // preview can show WHO shared it + WHEN, and so we hold off auto-start (they
  // press Start themselves). Matched to the active destination by coords, so it
  // self-clears the moment they pick a different destination.
  const [sharedRouteMeta, setSharedRouteMeta] = useState<{ handle?: string; at?: number; lat: number; lng: number } | null>(null);
  // Category-pill nearby-search results, shown as tappable pins on the map.
  const [placePins, setPlacePins] = useState<PlaceResult[]>([]);
  // Category pills hidden by default; toggled by the green icon on the search bar.
  const [pillsVisible, setPillsVisible] = useState(false);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  // ── ADD STOP (Jeff, 2026-07-28) ────────────────────────────────────────────
  // Interior waypoints between the driver and the destination, in travel order.
  // `label` is editable — the whole point of the rename is that "Stop 1" is useless
  // on a road trip but "Tim's in Hope" tells you what the stop IS.
  const [stops, setStops] = useState<{ lat: number; lng: number; label: string }[]>([]);
  const [stopPickerOpen, setStopPickerOpen] = useState(false);
  // Keyed by the stop's COORDINATES, not its array index: Scout can reorder `stops`
  // while this modal is open (2026-07-29), and an index would then rename whichever
  // stop happened to land in that slot.
  const [renameStop, setRenameStop] = useState<{ lat: number; lng: number; name: string } | null>(null);
  // Whether the turn-by-turn step list is expanded (slide-up). Lifts the FAB
  // stack / speedo / weather above the expanded drawer so they aren't covered.
  const [stepsExpanded, setStepsExpanded] = useState(false);
  // Slide-up "share route to members" sheet. Replaces the old Supabase
  // community-route write so route sharing works with no Supabase backend
  // config (shares the destination to specific members via /notifications/share).
  const [routeShareOpen, setRouteShareOpen] = useState(false);
  const [live, setLive] = useState<"connecting" | "live" | "off">("connecting");
  // Multi-route state — primary "Route Line" (blue) + alternates (gray)
  const [routes, setRoutes] = useState<NavRoute[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  // Turn-by-turn navigation state
  const [navMode, setNavMode] = useState<"preview" | "turn-by-turn">("preview");
  // Nova mute — the turn-by-turn banner's speaker button. Persisted so it sticks
  // across drives/launches; synced if the stored value loads/changes after mount.
  const [navMuted, setNavMuted] = useState<boolean>(() => getSettings().novaMuted ?? false);
  // ---- UI refinement state (post-field-test) ----
  // Search bar visibility — auto-hides when navigation starts so the destination
  // search field doesn't cover the map. A small magnifying-glass FAB appears in
  // its place to bring it back when the driver wants to change course.
  const [searchVisible, setSearchVisible] = useState(true);
  // Full-screen destination search (NavSearchScreen) — opens on a search-bar
  // tap. navRoster holds the active community's members so the "drive to a
  // friend" carousel can show offline members greyed out.
  const [navSearchOpen, setNavSearchOpen] = useState(false);
  const [navRoster, setNavRoster] = useState<{ id: string; handle: string; car_color?: string; is_admin?: boolean }[]>([]);
  // Layers control state — driven by the new bottom-right Layers FAB.
  // mapType:    "hybrid" = satellite + labels (default), "roadmap" = flat road view.
  // showTraffic / showTransit / showHazards toggle their respective overlays.
  // layersOpen drives the layers bottom sheet modal.
  const [showTraffic, setShowTraffic] = useState(true);
  const [showHazards, setShowHazards] = useState(true);
  const [layersOpen, setLayersOpen] = useState(false);
  // Custom saved-place naming modal (cross-platform; Alert.prompt is iOS-only).
  const [savePlaceModal, setSavePlaceModal] = useState<{ lat: number; lng: number } | null>(null);
  const [savePlaceName, setSavePlaceName] = useState("");
  // Position history buffer — keeps the last 30s of GPS samples so the user
  // can report a hazard "5 seconds ago" (matches Waze-style flow where the
  // driver passes the hazard before they react and tap the button).
  const posHistoryRef = useRef<{ lat: number; lng: number; ts: number }[]>([]);
  // FULL driven-path trace for the current turn-by-turn trip (AI-route learning). Unlike
  // posHistoryRef (a 30s ring), this accumulates the WHOLE drive while navigating; on
  // arrival, if the destination is a saved place, it's decimated + persisted (aiRoutes.ts)
  // as the habitual path. Reset at each Start; appended in the location watcher.
  const driveTraceRef = useRef<{ lat: number; lng: number; ts: number }[]>([]);
  // Map follow-mode flag (Bug 7 fix). Default ON so the map auto-centers on
  // the user when the screen first loads. The instant the user pans the map
  // with a finger gesture, `onUserPan` callback flips this to false and the
  // map stops chasing the user — they're free to inspect any region. Tapping
  // the Recenter FAB flips it back to true and ConvoyMap fires animateCamera
  // to snap home. Turn-by-turn navigation overrides this entirely (chase-cam
  // ALWAYS tracks during active nav regardless of this flag).
  const [isFollowing, setIsFollowing] = useState(true);

  // Transient toast state for "Police reported" / "Hazard reported" feedback.
  const [alertConfirm, setAlertConfirm] = useState<string | null>(null);
  // Pass-by "still there?" prompt. Set when we drive within ~120m of a
  // community hazard that isn't ours. Two "Gone" votes (from any drivers)
  // removes the marker for everyone. promptedHazardsRef ensures we ask at most
  // once per hazard per session so the card never nags on every GPS tick.
  const [passPrompt, setPassPrompt] = useState<Hazard | null>(null);
  const promptedHazardsRef = useRef<Set<string>>(new Set());
  const passPromptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Music broadcast toast — surfaced when the community admin pushes a track
  // via Music screen → "🎵 jeff: Smooth Operator — Sade". Auto-dismisses 5s.
  const [musicToast, setMusicToast] = useState<string | null>(null);
  const musicToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generic info toast (e.g. tapping the still-learning AI route chip). Auto-dismisses.
  const [infoToast, setInfoToast] = useState<string | null>(null);
  const infoToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showInfoToast = (msg: string) => {
    setInfoToast(msg);
    if (infoToastTimer.current) clearTimeout(infoToastTimer.current);
    infoToastTimer.current = setTimeout(() => setInfoToast(null), 4500);
  };
  // Hail toast — surfaced when a peer pushes us via POST /api/notifications/hail.
  // Two delivery paths feed this:
  //   - OS push notification while app is foregrounded (via hailBus from _layout)
  //   - Raw WebSocket frame (via livePtt listener — see useEffect below)
  // Both write to this single state slot so the UI is identical regardless
  // of transport.
  const [hailToast, setHailToast] = useState<string | null>(null);
  const hailToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Right-edge Navigation Action Drawer — peeked 80% off-screen by default
  // when turn-by-turn is engaged. Tap the visible 20% to expand and see the
  // current maneuver + End. Auto-collapses on tap-out / route end.
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  // Preview-card collapse state — when the driver starts moving (or taps the
  // map) the big preview card collapses into a minimal "Trip Summary" pill at
  // the top so the 3D chase view has the whole screen.
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  // Measured height of the preview "Drive" banner so the FABs/speedo/weather
  // lift to sit exactly above it (it floats just above the tab bar).
  const [previewBannerH, setPreviewBannerH] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  const activeRoute: NavRoute | null = routes[selectedRouteIndex] || null;

  // Auto-hide the search bar when actually navigating (turn-by-turn engaged).
  // When nav stops, we don't auto-show — the driver explicitly taps the FAB
  // or returns to preview. This mirrors Apple/Google Maps behavior.
  useEffect(() => {
    if (navMode === "turn-by-turn") setSearchVisible(false);
  }, [navMode]);

  const navAutoStartedRef = useRef(false);
  // Auto-start arms ONLY after we've seen the car essentially stopped (<=2 km/h)
  // since the destination was set, so picking a recent/saved/search WHILE MOVING
  // shows the preview instead of instantly starting nav + voicing the greeting.
  const autoStartArmedRef = useRef(false);
  // One-shot guard so the Nova greeting fires once per destination (not on
  // every route recompute / reroute).
  const greetedDestRef = useRef<string | null>(null);
  // Reset the one-shot auto-start guard whenever the destination changes.
  useEffect(() => { navAutoStartedRef.current = false; autoStartArmedRef.current = false; greetedDestRef.current = null; clearPreparedGreeting(); }, [destination]);

  // Auto-START turn-by-turn once the driver begins moving (≥ 5 km/h) with a route
  // set. Replaces the old "collapse to a trip-summary pill" flow — the new
  // turn-by-turn UI (TurnByTurnNav + StepDrawer) now pops up on its own when you
  // drive off, instead of a stale pill sitting where the new UI belongs. Fires at
  // most once per destination (navAutoStartedRef, set inside startNav) and never
  // fights a manual End.
  useEffect(() => {
    if (!destination || !route) return;
    if (navMode === "turn-by-turn") return;
    if (navAutoStartedRef.current) return;
    // A SHARED route waits for the recipient to press Start themselves — never
    // auto-start it out from under them.
    if (sharedRouteMeta &&
        Math.abs(destination.lat - sharedRouteMeta.lat) < 1e-6 &&
        Math.abs(destination.lng - sharedRouteMeta.lng) < 1e-6) return;
    const kmh = (coords?.speed && coords.speed > 0) ? coords.speed * 3.6 : 0;
    if (kmh <= 2) autoStartArmedRef.current = true;
    if (autoStartArmedRef.current && kmh >= 5) startNav();
  }, [coords?.speed, destination, route, navMode, sharedRouteMeta]);

  // ---- Full-screen search wiring ----
  // A picked place behaves exactly like the inline bar's onSelect.
  const onSearchSelectPlace = (loc: { lat: number; lng: number; label: string }) => {
    setDestination(loc);
    setShowSteps(true);
    setSearchVisible(false);
  };
  // A tapped category result pin routes straight to it (same flow as a picked
  // search result) and clears the remaining category pins from the map.
  const handlePlacePinPress = (p: PlaceResult) => {
    setPlacePins([]);
    onSearchSelectPlace({ lat: p.lat, lng: p.lng, label: p.label });
  };
  // Tapping a live friend routes to their current position and, once the route
  // computes, rolls straight into turn-by-turn (Google-Maps "directions to a
  // contact" feel). pendingFriendStartRef bridges the async route fetch.
  const pendingFriendStartRef = useRef(false);
  const onSearchSelectFriend = (m: CarouselMember) => {
    if (typeof m.lat !== "number" || typeof m.lng !== "number") return;
    pendingFriendStartRef.current = true;
    setDestination({ lat: m.lat, lng: m.lng, label: m.handle || "Friend" });
    setShowSteps(true);
    setSearchVisible(false);
  };
  useEffect(() => {
    if (!pendingFriendStartRef.current) return;
    if (activeRoute && navMode !== "turn-by-turn") {
      pendingFriendStartRef.current = false;
      startNav();
    }
  }, [activeRoute, navMode]);
  // Fetch the active community roster when the search opens (same pattern as
  // ShareSheet) so offline members appear greyed in the friend carousel.
  useEffect(() => {
    if (!navSearchOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const s = getSettings();
        let cid: string | null = s?.activeCommunityId ?? null;
        if (!cid) {
          const { data } = await api.get("/communities/mine");
          cid = Array.isArray(data) && data[0]?.id ? data[0].id : null;
        }
        if (!cid) { if (!cancelled) setNavRoster([]); return; }
        const [meRes, cRes] = await Promise.all([
          api.get("/auth/me").catch(() => ({ data: null as any })),
          api.get(`/communities/${cid}`),
        ]);
        const myId = meRes?.data?.id;
        const roster = (cRes?.data?.members_users || [])
          .filter((mem: any) => mem && mem.id && mem.id !== myId)
          .map((mem: any) => ({ id: mem.id, handle: mem.handle, car_color: mem.car_color, is_admin: mem.is_admin }));
        if (!cancelled) setNavRoster(roster);
      } catch {
        if (!cancelled) setNavRoster([]);
      }
    })();
    return () => { cancelled = true; };
  }, [navSearchOpen]);

  // ----- Receive a shared route -----
  // A crew member's shared route lands in shareInbox (via the ShareToast). We
  // consume it once — on the ping if this screen is already mounted, else on
  // next focus — and set it as our destination. The destination→routes effect
  // then computes OUR own route from OUR location and the Drive preview shows.
  const applyPendingRoute = useCallback(() => {
    const r = shareInbox.takeRoute();
    if (!r) return;
    setDestination({ lat: r.lat, lng: r.lng, label: r.label });
    // Remember who/when so the preview can credit the sharer and we hold off
    // auto-start (the destination→routes effect still recomputes the route from
    // THIS member's own GPS to the shared destination — see that effect).
    setSharedRouteMeta({ handle: r.fromHandle, at: r.sharedAt, lat: r.lat, lng: r.lng });
    setShowSteps(true);
    setSearchVisible(false);
  }, []);
  useEffect(() => shareInbox.subscribe(applyPendingRoute), [applyPendingRoute]);
  useFocusEffect(applyPendingRoute);

  // When destination clears, reset both UI states so a fresh search restarts clean.
  useEffect(() => {
    if (!destination) {
      setPreviewCollapsed(false);
      setSearchVisible(true);
    }
  }, [destination]);

  const [settings] = useSettings();
  // Saved places (Home/Work/custom). The time-of-day prediction now surfaces as
  // the PREDICTIVE row in the search screen (NavSearchScreen), not an on-map banner.
  const [savedPlaces] = useSavedPlaces();
  // Base-map mode is the single source of truth (settings.mapMode), controllable
  // from the Settings screen AND the on-map Layers sheet. The Mapbox engine uses
  // mapMode directly (the Google/web engines that consumed the derived
  // mapType/mapDark were retired along with ConvoyMap.tsx).
  const mapMode = getMapMode(settings);
  // The RAW chosen mode (may be "auto") — for the Layers sheet's radio selection.
  const mapModeChoice = getMapModeChoice(settings);
  // Live map bearing (deg) reported by the engine — drives the Compass FAB's
  // needle rotation. northSignal is a monotonic counter the Compass FAB bumps to
  // ask the engine to animate back to north-up (heading 0).
  const [mapHeading, setMapHeading] = useState(0);
  const [northSignal, setNorthSignal] = useState(0);
  // Bumped by the "Crew" pill (replaces the old zoom +/- buttons): frames self +
  // all live/partial peers in one north-up overview.
  const [crewSignal, setCrewSignal] = useState(0);
  // Transient north-up override. The Compass FAB sets this so a tap faces TRUE
  // NORTH (and recenters on the car) even while in heading-up chase: it routes the
  // camera through the engine's north-up follow path, which has no lockstep
  // fighting the heading. Cleared on a manual pan or when nav starts, so the
  // user's heading-up setting resumes naturally.
  const [northUpHold, setNorthUpHold] = useState(false);
  // Hold-to-activate "Avatar" panel (opened by long-pressing the Map tab button,
  // signalled via avatarHoldBus). Auto-dismisses ~5s after the last interaction.
  const [avatarPanelOpen, setAvatarPanelOpen] = useState(false);
  // True while the weather chip's 5-day forecast pop-out is showing — used to hide
  // the zoom stack (which sits right where the forecast card expands).
  const [weatherForecastOpen, setWeatherForecastOpen] = useState(false);
  const avatarPanelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armAvatarPanelDismiss = () => {
    if (avatarPanelTimer.current) clearTimeout(avatarPanelTimer.current);
    avatarPanelTimer.current = setTimeout(() => setAvatarPanelOpen(false), 5000);
  };
  // Map tab long-press → open the Avatar panel and start the auto-dismiss timer.
  useEffect(() => {
    const off = subscribeAvatarHold(() => { setAvatarPanelOpen(true); armAvatarPanelDismiss(); });
    return () => { off(); if (avatarPanelTimer.current) clearTimeout(avatarPanelTimer.current); };
  }, []);
  const showWeatherLayer = (settings as any).showWeatherLayer ?? true;
  // Live weather for the on-map HUD — current conditions at the user's GPS
  // position, fetched only while the Weather layer is enabled (auto-refresh ~5 min).
  const { weather } = useWeatherLayer(coords?.lat ?? null, coords?.lng ?? null, showWeatherLayer);
  // 7-day daily forecast for the driver's location — feeds the tappable
  // WeatherHUD chip's pop-up outlook. Gated on the same weather-layer toggle.
  const dailyForecast = useDailyForecast(coords?.lat ?? null, coords?.lng ?? null, showWeatherLayer);
  // Destination arrival weather — hourly forecast at the destination; we pick
  // the hour matching your ETA (now + route duration) and surface it as a
  // weather chip on the end pin. Gated on the weather layer toggle + a route.
  const destForecast = useDestinationWeather(destination?.lat ?? null, destination?.lng ?? null, showWeatherLayer && !!destination);
  const destWeather = useMemo(() => {
    if (!destination || !destForecast) return null;
    const durS = activeRoute?.duration_in_traffic_s ?? activeRoute?.duration_s ?? 0;
    const cond = pickForecastAt(destForecast, Date.now() + durS * 1000);
    if (!cond) return null;
    const t = Math.round(settings.speedUnit === "mph" ? cond.tempF : cond.tempC);
    return { kind: weatherKind(cond), temp: `${t}\u00b0` };
  }, [destination, destForecast, activeRoute?.duration_in_traffic_s, activeRoute?.duration_s, settings.speedUnit]);

  // Fixed speed cameras (OpenStreetMap), fetched around the driver and cached.
  // Drives both the map pins and the Nova proximity voice alert below.
  const speedCamerasEnabled = (settings as any).speedCameras !== false;
  const speedCameras = useSpeedCameras(coords?.lat ?? null, coords?.lng ?? null, speedCamerasEnabled);
  // Official BC road events (DriveBC Open511) — accidents/construction/closures.
  const roadIncidentsEnabled = (settings as any).roadIncidents !== false;
  const roadEventsAll = useDriveBcEvents(coords?.lat ?? null, coords?.lng ?? null, roadIncidentsEnabled);
  // Severity split (Settings → Map Layers): red = major/moderate, grey = minor.
  // Filtered HERE so hiding grey pins also silences their (nonexistent) callouts
  // and hiding red pins silences the major/moderate voice alerts below.
  // HEAT (identity, 2026-08-15): memoised. The inline .filter() minted a NEW ARRAY on
  // every phone render. That chained ConvoyCarPlay's 25-field setCarState (roadEvents is
  // in its dep list, src/carplay/ConvoyCarPlay.tsx:1151) to the phone's render rate, and
  // defeated ConvoyMapbox's incidentFC memo (src/ConvoyMapbox.tsx:1697), which rebuilt the
  // incident FeatureCollection — and re-uploaded the ShapeSource — every render.
  // `settings` is the whole-object dep because the reads below go through `as any` (the
  // exhaustive-deps rule can't form a member path through a TSAsExpression). useSettings
  // hands out a BRAND NEW object on every write (src/settings.ts:483, `cached = {...}`),
  // so this still recomputes the instant either toggle flips. Contents/order unchanged.
  const roadEventsFiltered = useMemo(() => roadEventsAll.filter((e: any) =>
    e.severity === "MAJOR" || e.severity === "MODERATE"
      ? (settings as any).roadIncidentsRed !== false   // red: ON by default
      : (settings as any).roadIncidentsGrey === true   // grey: OPT-IN (off on first launch — "the grey is just too much")
  ), [roadEventsAll, settings]);
  // Collapse near-duplicates (tester: red + grey pins stacking on each other —
  // DriveBC often files the same closure twice, once per direction/severity).
  // RED (major/moderate) sorts first so it always wins the spot; anything within
  // ~250 m of an already-kept event is dropped. O(n²) is fine at DriveBC counts.
  // HEAT (identity, 2026-08-15): the O(n²) haversine dedupe now runs only when the
  // filtered list actually changes, not on every phone render. Body is byte-for-byte the
  // old IIFE — same sort, same 250 m rule, same order out.
  const roadEvents = useMemo(() => {
    const sorted = [...roadEventsFiltered].sort((a: any, b: any) => {
      const ra = a.severity === "MAJOR" || a.severity === "MODERATE" ? 0 : 1;
      const rb = b.severity === "MAJOR" || b.severity === "MODERATE" ? 0 : 1;
      return ra - rb;
    });
    const kept: typeof sorted = [];
    for (const e of sorted) {
      if (kept.some((k: any) => haversineMeters({ lat: k.lat, lng: k.lng }, { lat: e.lat, lng: e.lng }) < 250)) continue;
      kept.push(e);
    }
    return kept;
  }, [roadEventsFiltered]);
  // Posted speed limit for the road you're on (OpenStreetMap maxspeed via
  // Overpass). Feeds the speedometer's over-limit pulse; null when the road has
  // no maxspeed tag, in which case the pill simply stays neutral.
  const speedLimitKmh = useSpeedLimit(coords?.lat ?? null, coords?.lng ?? null, true);

  // ===== Speed alerts (Nova / Ding / Off) =====
  // Mode from settings: 'nova' speaks a humorous nudge, 'ding' plays a chime
  // (single ~21 km/h over, double ~41 over), 'off' is silent. Posted limit comes
  // from useSpeedLimit (OpenStreetMap). Each threshold has its OWN independent
  // 5-minute cooldown and re-arms the instant you drop back under it: it fires
  // once on crossing, won't nag while you sit above the line, but alerts again on
  // a fresh transgression — and the +41 warning can fire even if the +21 nudge
  // just did (they're tracked separately). Thresholds are km/h; the spoken amount
  // is converted to the driver's unit. navMuted silences the SPOKEN mode only —
  // the ding is a non-voice alert the driver explicitly opted into, so it keeps
  // playing even when Nova's voice is muted.
  const SPEED_TIER1_OVER_KMH = 21;
  const SPEED_TIER2_OVER_KMH = 41;
  const SPEED_ALERT_COOLDOWN_MS = 300000; // 5 min, per threshold
  const speedTier1Ref = useRef({ last: 0, armed: true });
  const speedTier2Ref = useRef({ last: 0, armed: true });
  useEffect(() => {
    const mode = getSpeedAlertMode(settings);
    if (mode === "off") return;
    if (!speedLimitKmh || speedLimitKmh <= 0) return;
    const kmh = (coords?.speed && coords.speed > 0) ? coords.speed * 3.6 : 0;
    if (kmh < 5) return;
    const overKmh = kmh - speedLimitKmh;
    const now = Date.now();
    // Learn the habitual over-margin, then (if adaptive is on) raise ONLY the tier-1
    // nudge toward it — buffered + hard-capped at 35 over so a habitual speeder still
    // gets nudged, and tier-2 (the firmer alert) is untouched.
    recordOver(overKmh);
    let tier1Over = SPEED_TIER1_OVER_KMH;
    if (getSettings().adaptiveSpeedAlerts !== false) {
      const hab = habitualOverKmh();
      if (hab != null) tier1Over = Math.max(SPEED_TIER1_OVER_KMH, Math.min(35, Math.round(hab) + 5));
    }
    // Re-arm each threshold the moment you drop back under it.
    if (overKmh < tier1Over) speedTier1Ref.current.armed = true;
    if (overKmh < SPEED_TIER2_OVER_KMH) speedTier2Ref.current.armed = true;
    // Fire the HIGHEST crossed threshold whose own cooldown currently allows it.
    let tier: 0 | 1 | 2 = 0;
    if (overKmh >= SPEED_TIER2_OVER_KMH) {
      const t = speedTier2Ref.current;
      if (t.armed || now - t.last >= SPEED_ALERT_COOLDOWN_MS) { t.last = now; t.armed = false; tier = 2; }
    } else if (overKmh >= tier1Over) {
      const t = speedTier1Ref.current;
      if (t.armed || now - t.last >= SPEED_ALERT_COOLDOWN_MS) { t.last = now; t.armed = false; tier = 1; }
    }
    if (tier === 0) return;
    if (mode === "ding") { void playSpeedDing(tier === 2); return; }
    // mode === "nova": spoken nudge (announce() also honors the Nova master switch).
    if (navMuted) return;
    const mph = settings.speedUnit === "mph";
    const overDisp = Math.max(1, Math.round(mph ? overKmh / 1.60934 : overKmh));
    const cs = (getSettings().callSign || "").trim();
    try { announce(speedingLine(tier, overDisp, cs ? `${cs}, ` : "")); } catch {}
  }, [coords?.speed, speedLimitKmh, navMuted, settings.speedUnit, settings.speedAlertMode, settings.novaSpeeding]);

  // Optional Convoy alert sound — chime when a NEW community hazard appears
  const prevHazardIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set(hazards.map((h) => h.id));
    if (settings.alertSound && prevHazardIdsRef.current.size > 0) {
      const newOnes = [...ids].filter((id) => !prevHazardIdsRef.current.has(id));
      if (newOnes.length > 0) {
        // Soft platform chime — best-effort, silent if unavailable
        try {
          if (Platform.OS === "web" && typeof window !== "undefined") {
            // Tiny 880Hz beep via WebAudio
            const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
            if (Ctx) {
              const ctx = new Ctx();
              const o = ctx.createOscillator(); const g = ctx.createGain();
              o.connect(g); g.connect(ctx.destination);
              o.frequency.value = 880; o.type = "sine";
              g.gain.setValueAtTime(0.0001, ctx.currentTime);
              g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
              g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
              o.start(); o.stop(ctx.currentTime + 0.5);
            }
          }
        } catch { /* ignore */ }
      }
    }
    prevHazardIdsRef.current = ids;
  }, [hazards, settings.alertSound]);

  // Latest GPS coords mirror — lets the route fetch read the current origin
  // WITHOUT taking `coords` as an effect dependency. Depending on `coords`
  // re-fired this effect every GPS tick (~1/sec), which hammered the Directions
  // API and reset the user's selected alternate back to 0 every second (so a
  // tapped route never stayed yellow). We now fetch only when the destination
  // or route options change, reading the live origin from this ref.
  const coordsRef = useRef(coords);
  useEffect(() => { coordsRef.current = coords; }, [coords]);

  // Dedupe key so Nova announces the route options at most once per destination.
  const announcedRoutesForRef = useRef<string>("");
  // Unified multi-route directions (web + native). Fetches up to 3 alternates with `alternatives=true`.
  // Routes are SORTED by current traffic-aware ETA (fastest first) and tagged with
  // a rank-based color: green (fastest) / orange (2nd) / red (3rd+) so the user
  // can see at-a-glance which polyline is the best pick.
  // Honors avoid-tolls/highways/ferries route preferences from settings.
  useEffect(() => {
    const origin = coordsRef.current;
    if (!destination || !origin) {
      setRoutes([]); setSelectedRouteIndex(0); setRoute(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const avoid = {
        tolls: settings.avoidTolls,
        highways: settings.avoidHighways,
        ferries: settings.avoidFerries,
      };
      // STOPS PINNED → one via-route through them, and no alternates. Mapbox returns a
      // single route for a via request, which is right: once the driver has pinned the
      // shape of the trip, "alternate ways through your own waypoints" is meaningless.
      // The via route is an ordinary NavRoute (segment durations, congestion, refresh
      // uuid) so the accurate ETA and live traffic keep working through stops.
      if (stops.length) {
        const viaRoute = await fetchRouteViaStops(origin, stops, destination, avoid);
        if (cancelled) return;
        if (viaRoute) {
          const only = [{ ...viaRoute, color: '#2DEC86' }] as any[];
          setRoutes(only);
          setSelectedRouteIndex(0);
          setRoute({
            distance_text: viaRoute.distance_text,
            duration_text: viaRoute.duration_text,
            polyline: viaRoute.polyline,
          } as any);
          return;
        }
        // Via fetch failed (network, or a stop Mapbox can't snap to a road) — fall
        // through to the normal origin→destination routes rather than showing nothing.
        // SAY SO. The fall-through is the right behaviour (a route beats a blank map)
        // but it silently drops the stop, so the drawer chips and the stop pins claim a
        // trip the line does not actually make. That mismatch is what "it didn't make
        // the change completely" feels like from the driver's seat, whatever caused it.
        showInfoToast("Couldn't route through that stop — showing the direct route.");
      }
      // ── DEPART THE WAY THE CAR IS POINTING (2026-07-30) ───────────────────
      // Jeff: "parked at work I start a route and it makes me do a U-turn when I
      // can easily go forward." We were sorting purely by ETA, blind to which way
      // the car faced — and on a two-way street Mapbox returns BOTH directions as
      // alternatives (verified: Inverness St gives alt0 departing 181 deg and alt1
      // departing 1 deg), so picking "fastest" picked the U-turn roughly half the
      // time. orderReroutesForward already encodes exactly the right preference and
      // has been doing this for reroutes since long before; the initial pick simply
      // never got the same treatment. Compass sample runs CONCURRENTLY with the
      // route fetch so it costs no added latency, and a null facing falls straight
      // through to plain fastest-first — i.e. today's behaviour.
      const [raw, facing] = await Promise.all([
        fetchRoutes(origin, destination, avoid),
        getDepartureBearing(),
      ]);
      if (cancelled) return;
      // Forward-departing options first (each group fastest-first), so index 0 —
      // the selected, green route — is the quickest one that does NOT turn you
      // around. When nothing departs forward the order is unchanged: sometimes a
      // U-turn genuinely is the only way out.
      const sorted = orderRoutesForward(raw, facing ?? undefined);
      // Color-rank: green (fastest) → orange (mid) → red (slowest). Cast to
      // any so we can attach an extra `color` field without modifying the
      // shared NavRoute type in src/nav.ts.
      // Cap at two options — fastest + best traffic-aware alternate.
      const results = sorted.slice(0, 2).map((r, i) => ({
        ...r,
        color: i === 0 ? '#2DEC86' : '#9AA0A6',
      })) as any[];
      setRoutes(results);
      setSelectedRouteIndex(0);
      // ── A REAL SCENIC ROUTE (2026-07-29) ──────────────────────────────────
      // Jeff: "make the scenic on the maps the same as cruise."
      // Until now "Scenic" was only a LABEL: routeKindFor calls index 0 "best" and
      // index 1 "scenic", so the Scenic option was just Mapbox's first alternate —
      // normally another freeway with a different colour. The cruise planner's
      // Scenic excludes MOTORWAYS, which genuinely pushes the line onto back roads,
      // so bring the same definition here.
      //
      // Fetched as its own request (one per destination change, never per GPS tick)
      // and appended as an explicitly `kind: 'scenic'` route — routeKindFor honours
      // an explicit kind over the positional guess, so the colours follow.
      //
      // Skipped when it is not worth offering: identical to the fastest line (no
      // motorway on this trip anyway), or absurdly longer. Motorway-free across a
      // mountain range can mean hours of logging road, which is not a scenic route,
      // it is a mistake — 2.5x the fastest time is the cut-off.
      try {
        const scenicRaw = await fetchRoutes(origin, destination, { ...avoid, highways: true });
        if (!cancelled && !navActiveRef.current && scenicRaw.length) {
          const sc: any = scenicRaw[0];
          const bestSec = results[0]?.duration_in_traffic_s ?? results[0]?.duration_s ?? 0;
          const scSec = sc.duration_in_traffic_s ?? sc.duration_s ?? 0;
          const dup = results.some((r: any) => r.polyline === sc.polyline);
          const sane = !bestSec || !scSec || scSec <= bestSec * 2.5;
          if (!dup && sane) {
            sc.kind = 'scenic';
            // REPLACE the freeway alternate rather than appending. routeKindFor is
            // positional when a route carries no explicit kind, so leaving the
            // alternate at index 1 would label IT "scenic" too — two scenic-coloured
            // lines, one of them a freeway. The documented palette is Best / Scenic /
            // AI, and the alternate only ever occupied the Scenic slot by accident.
            // If this fetch fails we simply keep the old behaviour, so nothing is lost.
            setRoutes((prev) => (prev.length && prev[0]?.polyline === results[0]?.polyline
              ? [prev[0], sc]
              : prev));
          }
        }
      } catch {}
      const r0 = results[0];
      setRoute(r0 ? {
        distance_text: r0.distance_text,
        duration_text: r0.duration_text,
        steps: r0.steps.map((s: any) => ({ html: s.html, distance_text: s.distance_text, maneuver: s.maneuver })),
      } : null);

      // Nova announces the route options at plot time (C). Only when there's a
      // real choice (>=2 routes), not muted, once per destination, and only while
      // stopped/slow so it doesn't talk over the Start greeting on auto-start.
      if (results.length >= 2 && !getSettings().novaMuted) {
        const destKey = `${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}`;
        const slowEnough = ((coordsRef.current?.speed ?? 0) * 3.6) < 5;
        if (announcedRoutesForRef.current !== destKey && slowEnough) {
          announcedRoutesForRef.current = destKey;
          const fastest = results[0].duration_in_traffic_s ?? results[0].duration_s ?? 0;
          const second = results[1].duration_in_traffic_s ?? results[1].duration_s ?? 0;
          const diffMin = Math.max(0, Math.round((second - fastest) / 60));
          const cs = (getSettings().callSign || "").trim();
          const hey = cs ? `Hey ${cs}, ` : "";
          const line = diffMin >= 1
            ? `${hey}I found ${results.length} routes. The fastest saves about ${diffMin} ${diffMin === 1 ? "minute" : "minutes"} — it's the one I've highlighted.`
            : `${hey}I found ${results.length} routes — they're about the same time. I've picked the fastest.`;
          try { announce(line); } catch {}
        }
      }

      // ===== Pre-designed CRUISE route (Hub P3) =====
      // A consumed cruisePlot pin (below) stashed the via points and set this
      // destination. Replay meeting-point → stops → end through fetchAiRoute (the
      // same via-waypoint path the learned-routes feature uses) and append it as
      // the AI slot, auto-selected — so the pre-designed line is what's highlighted
      // and Best/Scenic stay one tap away.
      try {
        const cv = pendingCruiseViaRef.current;
        if (cv && Math.abs(cv.destLat - destination.lat) < 1e-6 && Math.abs(cv.destLng - destination.lng) < 1e-6) {
          pendingCruiseViaRef.current = null;
          const cruiseRoute = await fetchAiRoute(
            { lat: origin.lat, lng: origin.lng },
            // fetchAiRoute/fetchMapboxRouteVia take interior waypoints as
            // [lng, lat] TUPLES (Mapbox coordinate order) — not {lat,lng}.
            cv.via.map((p): [number, number] => [p.lng, p.lat]),
            { lat: destination.lat, lng: destination.lng },
            // A cruise planned as SCENIC is re-routed motorway-free, so the line the
            // crew drives has the shape its creator chose. Without this the plot path
            // silently rebuilt a fastest route through the same stops.
            {
              tolls: settings.avoidTolls,
              highways: settings.avoidHighways || !!cv.scenic,
              ferries: settings.avoidFerries,
            },
          );
          if (!cancelled && !navActiveRef.current && cruiseRoute?.polyline) {
            (cruiseRoute as any).cruise = true; // chip reads "Cruise" instead of "AI"
            // Same closure trap as the AI append: build on what is CURRENTLY in state
            // so the scenic route fetched above survives, and select the cruise line.
            let cruiseIdx = 0;
            setRoutes((prev) => {
              const base = (prev.length ? prev : results).slice(0, 2);
              cruiseIdx = base.length;
              return [...base, cruiseRoute as any];
            });
            setSelectedRouteIndex(cruiseIdx);
            return; // the learned-AI append below would clobber the cruise slot
          }
        }
      } catch {}

      // ===== AI route (P3) — the habitual path to a saved place. =====
      // If this destination is a saved place we've driven to before AND we're starting
      // from near that learned trace's origin, replay the stored path through Mapbox so
      // it comes back as a real traffic-aware route, then append it as the AI slot. Async
      // + best-effort: Best/Scenic already showed above; this just adds a 3rd option. Only
      // appended while still previewing (never clobbers an active-nav / rerouted set).
      try {
        await ensureSavedPlacesLoaded();
        await ensureAiRoutesLoaded();
        if (cancelled) return;
        const place = matchSavedPlace(destination.lat, destination.lng);
        const ai = place ? matchAiRoute(place.id, origin.lat, origin.lng) : undefined;
        if (ai) {
          const aiRoute = await fetchAiRoute(
            { lat: origin.lat, lng: origin.lng },
            viaPointsFor(ai),
            { lat: destination.lat, lng: destination.lng },
            { tolls: settings.avoidTolls, highways: settings.avoidHighways, ferries: settings.avoidFerries },
          );
          if (!cancelled && !navActiveRef.current && aiRoute?.polyline && aiRoute.polyline !== results[0]?.polyline) {
            // Functional update, appending to whatever is CURRENTLY there: rebuilding
            // from the captured `results` would silently drop the scenic route fetched
            // above (it lands in state, not in this closure).
            setRoutes((prev) => {
              const base = prev.length ? prev : results;
              if (base.some((r: any) => r?.polyline === aiRoute.polyline)) return base;
              return [...base, aiRoute as any];
            });
          }
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [destination, stops, settings.avoidTolls, settings.avoidHighways, settings.avoidFerries]);

  // When a destination is picked, drop follow-mode so the camera can zoom out to
  // frame all route options (ConvoyMap fits to the polylines). The Recenter FAB
  // re-enables follow when the driver wants to track their car again.
  useEffect(() => {
    if (destination) { setIsFollowing(false); setPlacePins([]); }
  }, [destination]);

  // Mirror RouteInfo whenever the user picks a different alternate
  useEffect(() => {
    const r = routes[selectedRouteIndex];
    if (!r) return;
    setRoute({
      distance_text: r.distance_text,
      duration_text: r.duration_text,
      steps: r.steps.map((s) => ({ html: s.html, distance_text: s.distance_text, maneuver: s.maneuver })),
    });
  }, [routes, selectedRouteIndex]);

  // ----- Personable Nova route greeting (pre-load) -----
  // The moment a route is plotted (preview), pre-fetch + pre-synthesize Nova's
  // greeting in the background so it can play INSTANTLY when the driver taps
  // Start. Once per destination, quiet while muted. Actual playback + parking of
  // the first turn callout happens in startNav -> playPreparedGreeting.
  useEffect(() => {
    if (!destination || !activeRoute) return;
    if (navMuted) return;
    const key = `${destination.lat.toFixed(4)},${destination.lng.toFixed(4)}`;
    if (greetedDestRef.current === key) return;
    greetedDestRef.current = key;
    prepareRouteGreeting({
      destination: { lat: destination.lat, lng: destination.lng },
      destinationName: destination.label,
      destinationCity: destination.label,
      route: activeRoute,
      weatherKind: destWeather?.kind ?? null,
      temperature: destWeather?.temp ?? null,
    }, key);
  }, [destination, activeRoute, destWeather, navMuted]);

  // LIVE TRAFFIC while driving. The route's per-segment durations are a snapshot from
  // when it was fetched; on a multi-hour trip that snapshot is stale long before you
  // arrive, so a jam or a construction slowdown that appears mid-drive would never
  // reach the ETA (Jeff, 2026-07-26: "I wanted it to calculate everything on the trip
  // including traffic/construction"). Every 2 min this re-pulls ONLY the annotations
  // for the geometry we're already on and writes them back onto the SELECTED route —
  // the ETA's suffix table sees the totals move and rebuilds, and the congestion
  // gradient recolours, both on the next tick. Never changes the route itself.
  // ── CONGESTION PROBE (2026-07-29) ───────────────────────────────────────────
  // Jeff sat in an hour of traffic watching a fully green line. Two completely
  // different bugs produce that, and NOTHING readable from this machine tells them
  // apart:
  //   (a) Mapbox reported heavy/severe and we failed to PAINT it, or
  //   (b) Mapbox reported low/unknown for that road and the paint was faithful.
  // Live-API testing showed (b) is entirely plausible: on his Langley stretch
  // 44-73% of segments come back null (-> "unknown" -> base green), and three
  // highway segments moving at under half the posted limit were labelled "low".
  // But the same testing showed congestion_numeric DOES report heavy/severe
  // correctly on a well-covered Hwy 1 run, so the source is not simply broken.
  // (The first theory — a missing enable_refresh -> no uuid -> frozen snapshot —
  // was DISPROVEN against the live API: the uuid comes back either way.)
  //
  // So log what the app actually holds. One row when guidance starts, then only
  // when the worst level CHANGES — a jam appearing is exactly the transition in
  // question, and it bounds the rows at a handful per drive instead of one per
  // 2-minute tick. Next drive in traffic decides (a) vs (b) with data.
  const congestionProbeRef = useRef<{ key: string; worst: string } | null>(null);
  const probeCongestion = useCallback((cong: CongestionLevel[] | undefined, when: string) => {
    try {
      const c = cong || [];
      const n = c.length;
      const count = (l: string) => c.reduce((a, v) => a + (v === l ? 1 : 0), 0);
      const sev = count("severe"), hvy = count("heavy"), mod = count("moderate");
      const worst = sev ? "severe" : hvy ? "heavy" : mod ? "moderate" : n ? "low/unknown" : "none";
      const key = String(activeRouteRef.current?.polyline || "").slice(0, 24);
      const prev = congestionProbeRef.current;
      if (prev && prev.key === key && prev.worst === worst) return;  // nothing new to say
      congestionProbeRef.current = { key, worst };
      logEvent(
        `congestion-probe ${when} worst=${worst} n=${n} `
        + `severe=${sev} heavy=${hvy} moderate=${mod} `
        + `low=${count("low")} unknown=${count("unknown")} `
        + `speedKmh=${Math.round((coordsRef.current?.speed ?? 0) * 3.6)}`,
      );
    } catch {}
  }, []);
  // At guidance start: what did the route we are about to drive come with?
  useEffect(() => {
    if (navMode !== "turn-by-turn") { congestionProbeRef.current = null; return; }
    probeCongestion(activeRoute?.congestion as CongestionLevel[] | undefined, "start");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navMode, activeRoute?.polyline]);


  useRouteTrafficRefresh(activeRoute, navMode === "turn-by-turn", useCallback((patch) => {
    probeCongestion(patch.congestion, "refresh");
    setRoutes((prev) => {
      if (!prev.length) return prev;
      const i = selectedRouteIndex;
      const cur = prev[i];
      if (!cur) return prev;
      const next = prev.slice();
      next[i] = { ...cur, segDurations: patch.segDurations, congestion: patch.congestion };
      return next;
    });
    // cbRef inside the hook always holds the latest callback, so depending on the
    // selected index here is safe and keeps the write pointed at the right route.
  }, [selectedRouteIndex, probeCongestion]));

  // "TAKE IT AGAIN" — the Drives screen hands a recorded trip over and we rebuild it as a
  // live route: same destination, same stops, same order. Read-once (consume) so coming
  // back to the map later can never silently restart an old drive. Runs on focus rather
  // than mount because the map is a TAB and stays mounted the whole session.
  useFocusEffect(useCallback(() => {
    const t = consumeTakeAgain();
    if (!t) return;
    if (typeof t.destLat === "number" && typeof t.destLng === "number") {
      setStops(t.stops?.length ? t.stops.map((st) => ({ lat: st.lat, lng: st.lng, label: st.label })) : []);
      setDestination({ lat: t.destLat, lng: t.destLng, label: t.destLabel || "Drive" });
      setShowSteps(true);
    }
  }, []));

  // ── SCOUT REORDERS THE STOPS (2026-07-29) ───────────────────────────────────
  // Jeff: "if I plot a stop near the end of the route and then add another that's
  // BEFORE it, Scout should reroute the best route based on the two added stops and
  // the end destination — it should re-organise the route stops. With Google Maps I
  // have to re-organise them myself."
  //
  // Origin and final destination stay put; everything pinned in between is fair game.
  // The ORDER is computed exactly (src/routeOptimizer.ts — Mapbox Optimization for up
  // to 10 stops, a matrix + 2-opt on the device beyond that); Scout ANNOUNCES it. The
  // language model is deliberately not in this loop: an LLM guessing a visiting order
  // would be slower and occasionally wrong, and wrong here means sending the driver
  // the long way with nothing on screen to reveal it.
  //
  // Reordering `stops` is all that is needed — the route-fetch effect already keys on
  // `stops`, so the new order re-plots through fetchRouteViaStops, and the off-route
  // handler now preserves stops, so nothing un-does it mid-drive.
  //
  // LOOP GUARD: the signature is the stop SET (sorted), not the order. Reordering the
  // same set therefore does NOT re-trigger this — otherwise setStops would feed itself
  // forever. A genuinely new or removed stop changes the set and earns a fresh pass.
  const optimizedSetRef = useRef<string>("");
  useEffect(() => {
    if (!destination || stops.length < 2) { optimizedSetRef.current = ""; return; }
    const sig = stops
      .map((st) => `${st.lat.toFixed(5)},${st.lng.toFixed(5)}`)
      .sort()
      .join("|");
    if (optimizedSetRef.current === sig) return;
    const origin = coordsRef.current;
    if (!origin) return;
    if (stops.length > ROUTABLE_MAX_STOPS) {
      // Directions itself refuses more than 25 coordinates, so this many stops cannot
      // be drawn as one route at all — say so rather than silently dropping any.
      optimizedSetRef.current = sig;
      showInfoToast(`${ROUTABLE_MAX_STOPS} stops is the most one route can hold.`);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      const res = await optimizeStopOrder(
        origin,
        stops,
        destination,
        { tolls: settings.avoidTolls, highways: settings.avoidHighways, ferries: settings.avoidFerries },
        { signal: ctrl.signal },
      );
      if (cancelled || !res) return;
      optimizedSetRef.current = sig;                 // set handled, whatever the answer
      if (isSameOrder(res.order)) return;            // already optimal — stay quiet
      const reordered = res.order.map((i) => stops[i]);
      setStops(reordered);
      const n = reordered.length;
      const savedMin = res.savedSec ? Math.round(res.savedSec / 60) : 0;
      const savedPart = savedMin >= 1 ? ` — saves about ${savedMin} ${savedMin === 1 ? "minute" : "minutes"}` : "";
      showInfoToast(`Scout reordered your ${n} stops for the fastest route${savedPart}.`);
      if (!getSettings().novaMuted) {
        try {
          const cs = (getSettings().callSign || "").trim();
          announce(`${cs ? cs + ", " : ""}I put your ${n} stops in the fastest order${savedPart}.`);
        } catch {}
      }
    })();
    return () => { cancelled = true; try { ctrl.abort(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, destination?.lat, destination?.lng, settings.avoidTolls, settings.avoidHighways, settings.avoidFerries]);

  // PITSTOP — a stopwatch when the car parks at a gas/food place.
  //
  // ROUTED ONLY (Jeff, 2026-07-27). It deliberately does NOT run on an idle map: a
  // pitstop only means something against a trip, and without a route the car sitting
  // on a driveway near a cafe is just a parked car. Gating on turn-by-turn also kills
  // the whole class of false positives at home/work, and stops the Places lookup
  // firing for anyone who never navigates. Detection + the "why this doesn't touch
  // the ETA" note live in src/pitstop.ts.
  const pitstop = usePitstop(coords, settings.pitstop !== false && navMode === "turn-by-turn");

  // Mirror the pitstop to the car surface. Phone owns detection; CarPlay/Android Auto
  // just draw it, per the standing "CarPlay matches the phone" rule.
  useEffect(() => {
    try {
      setCarState({
        pitstopActive: !!pitstop.active,
        pitstopLabel: pitstop.label || '',
        pitstopKind: pitstop.kind || 'rest',
        pitstopElapsedS: pitstop.elapsedS || 0,
      });
    } catch {}
  }, [pitstop.active, pitstop.label, pitstop.kind, pitstop.elapsedS]);

  // Turn-by-turn engine — speaks instructions, advances steps, computes ETA / distance remaining
  // What Scout SAYS on arrival. Saved name wins, so a destination you searched by address
  // that happens to be one of your places still speaks as "Lake" rather than the street.
  // Falls through to whatever the destination was picked as — a POI name ("Denny's") or
  // the address string. nav.ts's cleanArrivalLabel trims an over-long formatted address
  // and refuses a bare coordinate pair.
  const arrivalDestLabel = useMemo(() => {
    if (!destination) return null;
    const saved = matchSavedPlace(destination.lat, destination.lng);
    return saved?.label || destination.label || null;
  }, [destination?.lat, destination?.lng, destination?.label]);

  const tbt = useTurnByTurn(activeRoute, coords, navMode === "turn-by-turn", {
    mute: navMuted,
    destLabel: arrivalDestLabel,
    onArrive: () => {
      // Auto-finish the trip on arrival. The engine already spoke the (varied)
      // arrival line, so do NOT call stopSpeech() here — that would cut it off
      // mid-word. Otherwise run the SAME full teardown the Clear button does
      // (drop destination, route line, step drawer) so reaching the destination
      // ends the route on its own, with no Exit tap. navMode→preview clears the
      // TTS queue but leaves the in-flight arrival clip playing to the end.
      navAutoStartedRef.current = true;  // stay stopped until a new destination is set
      // Learn the habitual path to this place BEFORE we drop the destination.
      maybeLearnDrive(destination);
      // RECORD THE DRIVE — also before the teardown below nulls everything out.
      // Distance/duration come from the route rather than an integral of GPS fixes:
      // raw GPS accumulates jitter (a parked phone invents hundreds of metres), and the
      // route figure is the one the driver was shown all trip. The polyline is kept ON
      // DEVICE for playback; only distance/duration/when go to the server. See
      // src/trips.ts for why that split exists.
      try {
        const done = activeRoute;
        // Date.now() as the LAST resort only. It used to be the only fallback, and it
        // makes startedAt === endedAt — a real 32 km drive recorded as 0.0 minutes
        // (2026-07-30). getNavStartedAt() is the slim route's stamp, written by
        // startNavBanner on every nav start on every surface, so it survives any path
        // that missed the React baseline.
        const startedAt = tripBaselineRef.current?.startedAt || getNavStartedAt() || Date.now();
        if (done) {
          void recordTrip({
            startedAt,
            distanceM: done.distance_m || 0,
            durationS: Math.max(0, (Date.now() - startedAt) / 1000),
            destLabel: destination?.label || done.summary || "Drive",
            polyline: done.polyline || "",
            stops: stops.length ? stops.map((st) => ({ label: st.label, lat: st.lat, lng: st.lng })) : undefined,
            destLat: destination?.lat,
            destLng: destination?.lng,
            // PB for this drive. sessionMaxSpeed is the fastest km/h since the map
            // mounted, which for a normal drive IS this trip's max.
            topSpeedKmh: sessionMaxSpeed,
            userId: user?.id ? String(user.id) : undefined,
            handle: (user as any)?.handle || undefined,
            communityId: getSettings().activeCommunityId || undefined,
          });
        }
      } catch {}
      tripBaselineRef.current = null;
      pendingRerouteRef.current = null;
      clearOffer();
      setDestination(null);
      setRoutes([]);
      setRoute(null);
      setShowSteps(false);
      setNavMode("preview");
      slideStepDrawerDown();
    },
    onOffRoute: () => {
      if (!coords || !destination) return;
      // The driver deliberately went a different way — recompute silently and let the
      // turn engine re-anchor to the new line (nav.ts) so guidance picks it up at once.
      //
      // ⚠ THIS IS WHY "ADD STOP" APPEARED TO DO NOTHING (2026-07-29). Jeff: "when I
      // added the stop it kept the same route, the original route — it didn't make the
      // change completely." Adding a stop mid-drive swaps in a via-route whose first
      // leg can leave the road the car is currently on, so the turn engine reports
      // off-route once during the swap. This handler then re-plotted with plain
      // origin→destination and NO stops, and setRoutes threw the via-route away —
      // restoring the exact original line. The stop stayed in the chips, so the state
      // and the map disagreed. Every mid-drive re-plot has to go through the pinned
      // stops, or it un-does them.
      const avoid = {
        tolls: settings.avoidTolls,
        highways: settings.avoidHighways,
        ferries: settings.avoidFerries,
      };
      const pinned = stopsRef.current;
      (pinned.length
        ? fetchRouteViaStops(coords, pinned, destination, avoid).then((r) => (r ? [r] : []))
        : fetchRoutes(coords, destination, avoid)
      ).then((res) => {
        if (res.length > 0) {
          // Prefer the fastest reroute that continues in the direction the car is
          // already facing, so going off-course never auto-selects a U-turn line.
          // U-turn-only gate here, NOT the departure gate — see
          // UTURN_ONLY_TOLERANCE_DEG. Mid-drive the fastest continuation routinely
          // starts with an ordinary turn, and the 75° departure gate was demoting
          // those below slower straight-on lines.
          const ordered = orderRoutesForward(res, coords?.heading, UTURN_ONLY_TOLERANCE_DEG);
          setRoutes(ordered.slice(0, 2));
          setSelectedRouteIndex(0);
          // Re-baseline to the new route: the driver deliberately changed path, so the
          // "running late vs plan" check must measure the route they're now on, not the old one.
          tripBaselineRef.current = { startedAt: Date.now(), plannedSec: ordered[0]?.duration_in_traffic_s ?? ordered[0]?.duration_s ?? (tbtEtaRef.current || 0) };
        }
      });
    },
  });

  // ── KEEP OFF-ROUTE ALIVE WITH THE SCREEN OFF (2026-07-30) ──────────────────
  // Tester: "routing with the screen off, CarPlay doesn't re-route if I take a
  // different route — I have to open the phone, then it re-routes."
  //
  // Off-route detection lives in useTurnByTurn, and it only ever sees the positions
  // THIS screen hands it. The only continuous source was the foreground
  // watchPositionAsync above, which iOS stops delivering once the phone locks — so
  // `coords` froze, the off-route streak counters never advanced, and onOffRoute could
  // not fire. The background task kept running the whole time (it holds the banner,
  // the car marker and the speed limit up) but had no off-route logic of its own.
  // Unlocking resumed the watch, the engine saw one huge jump, and re-routed at once —
  // which is why it looked like opening the phone "caused" the reroute.
  //
  // Rather than duplicate the detection (perpendicular distance + heading gate +
  // missed-maneuver fast path + three streak thresholds — a second copy would drift),
  // the background task now publishes each fix and we feed it to the SAME engine.
  //
  // PRIORITY GATE, matching the car surface's mirror>fgwatch>bgtask rule: only apply a
  // background fix when the foreground watch has gone quiet. While the phone is awake
  // both are live and the fg watch is the fresher, higher-accuracy source, so it must
  // win; the moment it stops, this takes over seamlessly.
  useEffect(() => {
    if (navMode !== "turn-by-turn") return;
    return subscribeBgFix((f) => {
      if (Date.now() - lastFgFixAtRef.current < BG_FIX_TAKEOVER_MS) return;
      setCoords((cur) => ({
        lat: f.lat,
        lng: f.lng,
        heading: typeof f.heading === "number" ? f.heading : cur?.heading,
        speed: typeof f.speed === "number" ? f.speed : (cur?.speed ?? 0),
      }));
    });
  }, [navMode]);

  // ===== Lane guidance (Mapbox) — REMOVED 2026-08-13 =====
  // Jeff: "lets completely remove the turn arrow banner from phone and carplay/aa."
  // The lane cues fed only that row, so the per-session Mapbox Directions call that
  // fetched them went with it; the fetch/match helpers were deleted from
  // src/mapboxDirections.ts too.

  // ===== Proactive reroute recommendation (Nova) =====
  // While navigating, every 60s we re-check live traffic from the current
  // position. If a meaningfully faster route exists (>=5 min faster on its own,
  // or >=2 min faster when a reported incident sits on the road ahead), Nova
  // speaks up and a Yes/No prompt offers the switch. We NEVER reroute silently —
  // the driver always confirms (spoken question + tap). Accepting reuses the
  // SAME setRoutes/setSelectedRouteIndex(0) swap the off-route auto-reroute uses,
  // so the turn engine picks up the new line cleanly. Everything reads from refs
  // so the interval closure never goes stale.
  const tbtEtaRef = useRef(0);
  useEffect(() => { tbtEtaRef.current = tbt.etaSeconds; }, [tbt.etaSeconds]);
  // Full live turn-by-turn snapshot for the in-drive voice Q&A handler (reads it from a
  // ref so the voiceBus subscription never answers from a stale closure).
  const tbtRef = useRef(tbt);
  useEffect(() => { tbtRef.current = tbt; }, [tbt]);
  // 2D convoy view (see src/mapViewMode.ts). Drives the FAB label AND is handed to the
  // map engine below so pitch + marker art follow it.
  const view2D = useMapView2D();
  const hazardsRef = useRef<Hazard[]>([]);
  useEffect(() => { hazardsRef.current = hazards; }, [hazards]);
  const destRef = useRef(destination);
  useEffect(() => { destRef.current = destination; }, [destination]);
  const activeRouteRef = useRef<NavRoute | null>(activeRoute);
  useEffect(() => { activeRouteRef.current = activeRoute; }, [activeRoute]);
  // PINNED STOPS, readable from callbacks that resolve later (off-route re-plot, the
  // faster-route checker). Those run from render closures captured seconds earlier, so
  // reading `stops` directly there would silently use a stale list.
  const stopsRef = useRef(stops);
  useEffect(() => { stopsRef.current = stops; }, [stops]);
  const navMutedRef = useRef(navMuted);
  useEffect(() => { navMutedRef.current = navMuted; }, [navMuted]);
  // Sync the mute from the persisted setting once it loads / changes elsewhere.
  useEffect(() => { setNavMuted(settings.novaMuted ?? false); }, [settings.novaMuted]);
  const rerouteBusyRef = useRef(false);        // a check is in flight
  const rerouteShowingRef = useRef(false);     // a prompt is currently up
  const rerouteSuppressUntilRef = useRef(0);   // hush window after accept/decline
  // Trip baseline for the "is my route running late?" check: set at Start to the launch
  // time + the route's planned (traffic-aware) total duration, so mid-drive we can tell
  // whether the route is now taking LONGER than originally promised (an accident /
  // construction appeared). Cleared on arrival / clear / end.
  const tripBaselineRef = useRef<{ startedAt: number; plannedSec: number } | null>(null);
  // An ARMED reroute candidate, validated by the 60s check but HELD until the driver is
  // approaching the point where the alt peels off the current route (the exit/turn), so
  // the offer lands with lane-change notice — not 8 km early or already past the ramp. The
  // coords monitor below pops it when within the lead window. null = nothing armed.
  const pendingRerouteRef = useRef<{
    route: NavRoute; title: string; subtitle: string;
    savedMin: number; lateMin: number; etaSec: number;
    divLat: number; divLng: number; cause: string; maneuver: string | null;
  } | null>(null);
  // The visual reroute offer currently on screen — Google-style INLINE: the blue
  // offer line + a tappable "Save X min" pill at the divergence point, drawn on
  // the live map (the old RerouteCard modal is gone — Jeff: no popups). null = none.
  type RerouteOffer = { route: NavRoute; title: string; subtitle: string; savedMin: number; etaMin: number; arrival: string; lateMin: number; divLat: number; divLng: number };
  const [rerouteOffer, setRerouteOffer] = useState<RerouteOffer | null>(null);
  // STABLE IDENTITY for the map's `routes` prop. This was previously built inline in
  // the JSX — `rerouteOffer ? [...routes, {...}] : routes` — which minted a BRAND NEW
  // ARRAY on every single render for as long as an offer was on screen. Every consumer
  // downstream keys a useMemo on `routes`, so all of them were invalidated per render
  // and recomputed from scratch: routeProj (full decodePolyline + projectOntoRoute of
  // the car onto the whole line), onRouteCameras (decode + an O(cameras × line-points)
  // corridor scan), the fit-bounds memo (decodes EVERY route), and the route render
  // memo. That storm ran precisely when the driver was off-route and a reroute offer
  // was up — the same moment Jeff reports the car drifting and the line misbehaving.
  // ⚠ MUST stay above the `if (!coords) return` early return (:3023) — a hook below it
  // changes the hook count when the first fix lands and React throws. See CARPLAY.md
  // rule 1; that trap cost two crashes on 2026-07-24.
  // Pure identity fix: the array CONTENTS are byte-for-byte what they were.
  const displayRoutes = useMemo(
    () => (rerouteOffer ? [...routes, { ...(rerouteOffer.route as any), kind: "offer" }] : routes),
    [rerouteOffer, routes],
  );
  // Mirror of the on-screen offer in a ref, so the hands-free voice callback (which
  // resolves seconds later from a stale render closure) reads the CURRENT offer, not a
  // captured one. Kept in sync by showOffer()/clearOffer().
  const rerouteOfferRef = useRef<RerouteOffer | null>(null);
  const showOffer = (o: RerouteOffer) => { rerouteOfferRef.current = o; setRerouteOffer(o); };
  const clearOffer = () => { rerouteOfferRef.current = null; setRerouteOffer(null); };

  const checkForFasterRoute = useCallback(async () => {
    if (!getSettings().novaMidDrive) return;
    if (rerouteBusyRef.current || rerouteShowingRef.current) return;
    const now = Date.now();
    if (now < rerouteSuppressUntilRef.current) return;
    const origin = coordsRef.current;
    const dest = destRef.current;
    const cur = activeRouteRef.current;
    const baseline = tripBaselineRef.current;
    if (!origin || !dest || !cur || !baseline) return;
    // A baseline whose plan hasn't landed yet (adopted drive) would make lateSec below
    // equal the whole trip, so every alternative would read as a rescue. Wait for it.
    if (!(baseline.plannedSec > 0)) return;
    if (tbtEtaRef.current && tbtEtaRef.current < 240) return; // almost there — don't bother
    // STOPS PINNED → no offers. The candidates below come from a plain origin→dest
    // fetch, so every one of them SKIPS the driver's stops; accepting one silently
    // deleted the trip they built (same failure as onOffRoute above). A faster line
    // that misses your fuel stop is not a faster route. Same reasoning as
    // fetchRouteViaStops returning a single line: alternates through fixed waypoints
    // are meaningless.
    if (stopsRef.current.length) return;

    rerouteBusyRef.current = true;
    try {
      const s = getSettings();
      const avoid = { tolls: s.avoidTolls, highways: s.avoidHighways, ferries: s.avoidFerries };
      // (1) MY route's LIVE remaining — replay my own geometry ahead through traffic.
      // tbt.etaSeconds is a STATIC proportional estimate (nav.ts) that can't see a new
      // jam, so we pin a fresh Directions request to my route via its own waypoints.
      const via = routeAheadViaPoints(cur.coordinates as any, origin);
      if (via.length < 3) return; // not enough road left to measure my route reliably
      const [mine, fresh] = await Promise.all([
        fetchAiRoute(origin, via, dest, avoid),
        fetchRoutes(origin, dest, avoid),
      ]);
      if (!fresh.length) return;
      // MY route's LIVE remaining. Do NOT fall back to tbtEtaRef here — that's the
      // STATIC proportional estimate (nav.ts) that can't see a new jam, i.e. the exact
      // bug this rework fixes. If the live replay failed, skip and retry next interval.
      const mineRemain = mine?.duration_in_traffic_s ?? mine?.duration_s;
      if (!mineRemain) return;
      // (2) Best fresh alternative from here.
      const best = fresh.reduce((a, b) =>
        ((b.duration_in_traffic_s ?? b.duration_s) < (a.duration_in_traffic_s ?? a.duration_s) ? b : a));
      const bestEta = best.duration_in_traffic_s ?? best.duration_s;
      if (best.polyline && cur.polyline && best.polyline === cur.polyline) return; // same line

      // (3) Is my trip running LATE vs the plan I started with, AND does the alternative
      // meaningfully beat my LIVE remaining? Both compared on traffic-aware times.
      const elapsedSec = (now - baseline.startedAt) / 1000;
      const lateSec = (elapsedSec + mineRemain) - baseline.plannedSec; // projected vs planned arrival
      const savedSec = mineRemain - bestEta;                            // alt vs staying
      const hz = nearestHazardAhead(origin, dest, hazardsRef.current);
      const DELAY_MIN = 180, SAVE_MIN = 120;
      const degraded = lateSec >= DELAY_MIN;
      const worthwhile = savedSec >= SAVE_MIN;
      // Fire when the route degraded AND a better one exists; also on a big standalone
      // saving (>=5 min) or a known incident ahead with a worthwhile saving.
      const shouldOffer = (degraded && worthwhile) || savedSec >= 300 || (!!hz && worthwhile);
      if (!shouldOffer) { pendingRerouteRef.current = null; return; } // situation resolved

      // Where does the alt peel off the current route? We HOLD the offer until the driver
      // is approaching that split, so it lands with lane-change notice. If the split is
      // still too far to find, wait — the next checks will catch it as we close in.
      const div = routeDivergence(cur.coordinates as any, best.coordinates as any);
      if (!div) { pendingRerouteRef.current = null; return; }

      const savedMin = Math.max(1, Math.round(savedSec / 60));
      const lateMin = Math.max(0, Math.round(lateSec / 60));
      const cause = hz
        ? `there's ${hazardReason(hz.kind)} about ${hz.distKm} ${hz.distKm === 1 ? "kilometer" : "kilometers"} ahead`
        : (degraded ? `your route's running about ${Math.max(1, lateMin)} ${lateMin === 1 ? "minute" : "minutes"} behind` : "traffic shifted ahead");

      // ARM it — the coords monitor pops the card when within lead range of the split.
      pendingRerouteRef.current = {
        route: best,
        title: hz ? hazardTitle(hz.kind) : (degraded ? "Your route slowed down" : "Faster route found"),
        subtitle: hz
          ? `Reported ${hazardReason(hz.kind)} ahead`
          : (degraded ? `About ${Math.max(1, lateMin)} min behind your start estimate` : "Live traffic shifted in your favor"),
        savedMin, lateMin, etaSec: bestEta,
        divLat: div.lat, divLng: div.lng,
        cause, maneuver: maneuverNear(best, div.lat, div.lng),
      };
    } catch {
      // ignore — try again on the next interval
    } finally {
      rerouteBusyRef.current = false;
    }
  }, []);

  // Reroute card accept / decline. Mirror the old Alert button handlers exactly:
  // same hush windows + the setRoutes([best]) swap. Plain functions (recreated
  // each render) so they always read the current offer, never a stale one.
  const acceptReroute = () => {
    const offer = rerouteOfferRef.current; // ref, so the voice path reads the live offer
    rerouteShowingRef.current = false;
    rerouteSuppressUntilRef.current = Date.now() + 120000; // settle 2 min
    pendingRerouteRef.current = null;
    clearOffer();
    if (offer?.route) {
      setRoutes([offer.route]);     // same swap the off-route path uses
      setSelectedRouteIndex(0);
      // Re-baseline to the route we just switched to — otherwise we keep measuring
      // "late" against the OLD plan and re-fire the offer after the suppress expires.
      tripBaselineRef.current = { startedAt: Date.now(), plannedSec: offer.route.duration_in_traffic_s ?? offer.route.duration_s };
      if (!navMutedRef.current) { try { announce(pick(REROUTE_ACCEPT_LINES)); } catch {} }
    }
  };
  const declineReroute = () => {
    rerouteShowingRef.current = false;
    rerouteSuppressUntilRef.current = Date.now() + 300000; // hush 5 min
    pendingRerouteRef.current = null;
    clearOffer();
  };

  // Drive the check on a 60s interval, only while actively navigating.
  useEffect(() => {
    if (navMode !== "turn-by-turn") return;
    rerouteShowingRef.current = false; // fresh drive starts clean
    pendingRerouteRef.current = null;
    const id = setInterval(() => { void checkForFasterRoute(); }, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navMode]);

  // Pop the ARMED reroute the instant the driver is within lane-change notice of the split
  // (the exit/turn where the alt leaves the current route). Speed-aware so the lead time is
  // roughly constant — a fixed distance would warn too early in town / too late on the
  // highway. Runs on every GPS tick (the 60s check only re-arms the candidate).
  useEffect(() => {
    if (navMode !== "turn-by-turn") return;
    // A live INLINE offer auto-expires once the driver reaches/passes the split
    // without taking it — the blue line and pill quietly disappear (no modal to
    // dismiss, matching Google's behavior). Same speed-aware past-ramp guard the
    // arming path uses below.
    if (rerouteShowingRef.current) {
      const o = rerouteOfferRef.current;
      if (o && coords) {
        const dPass = haversineMeters({ lat: coords.lat, lng: coords.lng }, { lat: o.divLat, lng: o.divLng });
        const spdNow = Math.max(coords.speed ?? 0, 8);
        if (dPass < Math.max(180, spdNow * 8)) declineReroute();
      }
      return;
    }
    if (Date.now() < rerouteSuppressUntilRef.current) return;
    const pend = pendingRerouteRef.current;
    if (!pend || !coords) return;
    const distM = haversineMeters({ lat: coords.lat, lng: coords.lng }, { lat: pend.divLat, lng: pend.divLng });
    const spd = Math.max(coords.speed ?? 0, 8);                    // m/s floor: pops even when stopped
    const passedRampM = Math.max(180, spd * 8);                    // ~8s past-ramp guard (speed-aware)
    if (distM < passedRampM) { pendingRerouteRef.current = null; return; } // too late for this split — drop it
    const showWithinM = Math.max(400, Math.min(3000, spd * 75));   // ~75s of lead, clamped
    if (distM > showWithinM) return;                               // not yet — keep waiting
    // Within the lead window → pop the card + speak it now.
    pendingRerouteRef.current = null;
    rerouteShowingRef.current = true;
    const distText = fmtDistanceM(distM);
    const etaMin = Math.max(1, Math.round(pend.etaSec / 60));
    const arrival = fmtClock(new Date(Date.now() + pend.etaSec * 1000));
    const savedLabel = `${pend.savedMin} ${pend.savedMin === 1 ? "minute" : "minutes"}`;
    const cs = (getSettings().callSign || "").trim();
    const hey = cs ? `Hey ${cs}, ` : "";
    const line = pend.maneuver
      ? `${hey}In ${distText}, ${pend.maneuver}. That route saves about ${savedLabel}. Want to switch?`
      : `${hey}${pend.cause}. A faster route's coming up in ${distText}, saves about ${savedLabel}. Want to switch?`;
    // Card always shows (the tap fallback). When hands-free is on + not muted, Scout
    // SPEAKS the prompt and listens for a spoken yes/no — answering by voice mirrors the
    // card buttons. We ignore the voice result if the driver already tapped (offer gone).
    showOffer({
      route: pend.route,
      title: pend.title,
      subtitle: pend.maneuver ? `${pend.maneuver} · in ${distText}` : `${pend.subtitle} · in ${distText}`,
      savedMin: pend.savedMin, etaMin, arrival, lateMin: pend.lateMin,
      divLat: pend.divLat, divLng: pend.divLng,
    });
    const handsFree = getSettings().scoutHandsFree !== false && !navMutedRef.current;
    if (handsFree) {
      void askScout(line).then((r) => {
        if (!r || !rerouteShowingRef.current) return; // already tapped / dismissed
        if (r.yes) acceptReroute();
        else if (r.no) declineReroute();
        // anything else → leave the card up for a tap
      });
    } else if (!navMutedRef.current) {
      try { announce(line); } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords, navMode]);

  // ===== Convoy health monitor (Scout) =====
  // Two crew-proximity callouts, both read-only over community-scoped presence (so
  // every live peer is a fellow club member), both edge-triggered + hushed, and both
  // respecting novaVoice + the convoyAlerts setting:
  //   A) SPREADING OUT — ONLY while the crew is driving a SHARED CONVOY ROUTE together
  //      (onConvoyRouteRef). Each member's phone runs this locally, so everyone on the
  //      route hears it when a peer falls well behind. Silent on solo/ad-hoc drives.
  //   B) CLOSING IN — whenever a club member comes within 5 km of you (no route needed):
  //      a positive "the crew's closing in" heads-up.
  const peerListRef = useRef<Peer[]>([]);
  const onConvoyRouteRef = useRef(false);
  const convoySpreadHushRef = useRef(0);
  const convoyWasSpreadRef = useRef(false);
  const nearPeersRef = useRef<Map<string, boolean>>(new Map());
  const proximityHushRef = useRef(0);
  // Format a metres distance in the driver's chosen unit.
  const fmtDist = (m: number, mph?: boolean) => mph
    ? `${(m / 1609.34).toFixed(m < 16093 ? 1 : 0)} miles`
    : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} kilometers`;

  // A) Spreading out — SHARED CONVOY ROUTE only.
  useEffect(() => {
    const id = setInterval(() => {
      const s = getSettings();
      if (s.novaVoice === false || s.convoyAlerts === false || navMutedRef.current) return;
      // Gate: only while the crew is actually driving a shared convoy route together.
      if (!onConvoyRouteRef.current) { convoyWasSpreadRef.current = false; return; }
      if (Date.now() < convoySpreadHushRef.current) return;
      const me = coordsRef.current;
      const live = (peerListRef.current || []).filter(
        (p) => p && p.status !== "parked" && typeof p.lat === "number" && typeof p.lng === "number"
      );
      if (!me || live.length < 2) { convoyWasSpreadRef.current = false; return; }
      let far: Peer | null = null, farD = 0;
      for (const p of live) {
        const d = haversineMeters({ lat: me.lat, lng: me.lng }, { lat: p.lat as number, lng: p.lng as number });
        if (d > farD) { farD = d; far = p; }
      }
      const SPREAD_M = 2500;
      if (farD >= SPREAD_M && !convoyWasSpreadRef.current && far) {
        convoyWasSpreadRef.current = true;
        convoySpreadHushRef.current = Date.now() + 300000; // 5 min hush
        try { announce(`Heads up — the convoy's spreading out. ${far.handle || "Someone"} is about ${fmtDist(farD, s.speedUnit === "mph")} away.`); } catch {}
      } else if (farD < SPREAD_M * 0.7) {
        convoyWasSpreadRef.current = false; // back together → re-arm
      }
    }, 30000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // B) Closing in — a club member comes within 5 km. Per-peer edge trigger with
  // hysteresis (re-arms past 6.5 km) + a 90 s global hush so a clustering crew doesn't
  // chatter. No route required — this is the everyday "your crew is nearby" heads-up.
  useEffect(() => {
    const id = setInterval(() => {
      const s = getSettings();
      if (s.novaVoice === false || s.convoyAlerts === false || navMutedRef.current) return;
      const me = coordsRef.current;
      if (!me) return;
      const live = (peerListRef.current || []).filter(
        (p) => p && p.status !== "parked" && typeof p.lat === "number" && typeof p.lng === "number" && p.user_id
      );
      const NEAR_M = 5000, REARM_M = 6500;
      const seen = new Set<string>();
      for (const p of live) {
        const pid = p.user_id as string;
        seen.add(pid);
        const d = haversineMeters({ lat: me.lat, lng: me.lng }, { lat: p.lat as number, lng: p.lng as number });
        const wasNear = nearPeersRef.current.get(pid) === true;
        if (!wasNear && d <= NEAR_M) {
          nearPeersRef.current.set(pid, true);
          if (Date.now() >= proximityHushRef.current) {
            proximityHushRef.current = Date.now() + 90000;
            try { announce(`${p.handle || "A club member"} is within ${fmtDist(d, s.speedUnit === "mph")} — the crew's closing in.`); } catch {}
          }
        } else if (wasNear && d >= REARM_M) {
          nearPeersRef.current.set(pid, false); // moved off → re-arm for the next approach
        }
      }
      // Forget peers who dropped out of presence so a later rejoin can alert again.
      for (const k of Array.from(nearPeersRef.current.keys())) if (!seen.has(k)) nearPeersRef.current.delete(k);
    }, 30000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== Departure IQ (Scout) =====
  // When you're parked at a predictable time, proactively offer a one-tap drive to
  // where you're probably headed (predictDestination's time-of-day heuristic) — the
  // Hairpin flavor of Apple Maps' "Predicted Destinations". A dismissible pill in
  // the search bar, plus Nova SAYS the offer once ("Heading home? About 22 minutes
  // right now") — gated on settings.departureIQVoice and everything announce()
  // already respects (Nova master switch, ducking, mute-during-calls). One shot per
  // parked session — re-arms only after you actually drive away; dismiss hushes it.
  const [departSuggest, setDepartSuggest] = useState<{ place: SavedPlace; reason: string; etaText?: string } | null>(null);
  const departPromptedRef = useRef(false);
  const departHushRef = useRef(0);
  // ── DO NOT PITCH THE NEXT TRIP AS THE DRIVER ARRIVES (Jeff, 2026-08-12) ──────
  // "every time I finish a route Scout tells me 'heading to the lake, about 3:40'".
  // Exactly what the code did: ending a drive clears navMode and destination, which are the
  // two things that gate this prompt, and the driver is by definition parked — so arrival
  // opened the gate and immediately fired. Departure IQ is for someone about to LEAVE, and a
  // driver who just pulled in is the one person we know is not.
  // Hush for a while after any drive ends. It is a timestamp, not a timer, because iOS
  // suspends JS timers with the phone locked in a mount.
  const ARRIVE_HUSH_MS = 15 * 60 * 1000;
  const departBusyRef = useRef(false);
  useEffect(() => {
    const c = coords;
    if (!c) return;
    if ((c.speed ?? 0) > 2.5) { // ~9 km/h → you've driven off; re-arm + clear
      // …but not back into a hush. Driving away after arriving used to re-arm instantly,
      // so the next time the car stopped — a shop, a light, the school run — Scout pitched
      // the same destination again. That is the "every time I open the app" half of the
      // complaint.
      if (Date.now() >= departHushRef.current) departPromptedRef.current = false;
      if (departSuggest) setDepartSuggest(null);
      return;
    }
    if (getSettings().departureIQ === false) return;
    if (navMode === "turn-by-turn" || destination) return;        // already going somewhere
    if (departPromptedRef.current || departBusyRef.current) return;
    if (Date.now() < departHushRef.current) return;
    if ((c.speed ?? 0) > 1.5) return;                              // must be parked
    // Predict from ANY parked spot, not just saved places — predictDestination
    // carries its own 250 m "you're already there" guard, so the old
    // at-a-saved-place gate was hiding the feature for most parking spots.
    const pred = predictDestination(new Date(), c.lat, c.lng);
    if (!pred) return;
    departBusyRef.current = true;
    departPromptedRef.current = true;                              // one shot per parked session
    (async () => {
      let etaText: string | undefined;
      try {
        const r = await fetchRoutes({ lat: c.lat, lng: c.lng }, { lat: pred.place.lat, lng: pred.place.lng }, {
          tolls: settings.avoidTolls, highways: settings.avoidHighways, ferries: settings.avoidFerries,
        });
        const best = r[0];
        if (best) etaText = best.duration_in_traffic_text || best.duration_text;
      } catch {}
      setDepartSuggest({ place: pred.place, reason: pred.reason, etaText });
      // Nova makes the offer out loud (once per parked session). "22 min" reads
      // badly in TTS — expand the units for the spoken line only.
      if (getSettings().departureIQVoice !== false) {
        const spokenEta = etaText
          ? ` About ${etaText.replace(/\bhrs?\b/g, "hours").replace(/\bhr\b/g, "hour").replace(/\bmins?\b/g, "minutes").replace(/\b1 minutes\b/, "1 minute").replace(/\b1 hours\b/, "1 hour")} right now.`
          : "";
        announce(`${pred.reason.charAt(0).toUpperCase()}${pred.reason.slice(1)}?${spokenEta}`);
      }
      departBusyRef.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords, navMode, destination]);

  // System nav-notification banner — keeps the current turn on screen as a
  // heads-up notification even when Convoy is backgrounded (home/lock screen).
  // A background location task drives it. iOS works on the current build;
  // Android lights up after the next native build (permissions staged in
  // app.json). navBgActiveRef tracks whether the bg task is driving updates; if
  // it isn't (e.g. background-location permission denied), the second effect
  // drives the banner from the live foreground GPS coords instead.
  const navBgActiveRef = useRef(false);
  // Departure-IQ learning: nav started toward a saved place → log the departure
  // time, so "leave for work / head home" suggestions calibrate to when this
  // driver ACTUALLY leaves (predictDestination only offers inside the learned
  // window). Once per nav session (the ref), custom places included.
  const departLoggedRef = useRef(false);
  // Arm the arrive-hush the moment guidance stops, however it stopped — arrival,
  // auto-finish, or End. Also blocks the re-arm below, since the driver is stationary at
  // the place they just drove to.
  const wasNavigatingRef = useRef(false);
  useEffect(() => {
    const nav = navMode === "turn-by-turn";
    if (wasNavigatingRef.current && !nav) {
      departHushRef.current = Date.now() + ARRIVE_HUSH_MS;
      departPromptedRef.current = true;      // and do not re-offer for this stop
    }
    wasNavigatingRef.current = nav;
  }, [navMode]);
  useEffect(() => {
    if (navMode !== "turn-by-turn") { departLoggedRef.current = false; return; }
    if (departLoggedRef.current || !destination) return;
    const sp = matchSavedPlace(destination.lat, destination.lng);
    // Record WHERE we left from, not just when. "from work I head home" and "at 9am I head
    // to work" are the same clock in different places; without the origin nothing can tell
    // those two habits apart, which is how standing at home once suggested the lake.
    if (sp) {
      departLoggedRef.current = true;
      const c = coordsRef.current;
      recordDeparture(sp, new Date(),
        c && typeof c.lat === "number" ? { lat: c.lat, lng: c.lng } : undefined);
    }
  }, [navMode, destination]);
  // ── THE TEARDOWN FLAP, FIXED (2026-08-18) ──────────────────────────────────
  // This effect used to depend on [navMode, activeRoute, destination?.label], so EVERY
  // activeRoute identity change — a reroute, and every traffic refresh (which mints a
  // new route object with identical geometry, see useRouteTrafficRefresh above) — ran
  // stopNavBanner() + startNavBanner() mid-drive. stopNavBanner is the UNIVERSAL
  // teardown: navigating:false (released the car's North-Up hold — Say Phin 8/17),
  // ribbon + strip cleared and ownership dropped, bg-location hold released, and the
  // restart re-anchored the cold engine at step 0 on a route whose first endpoint was
  // already behind the driver (the rem-GROWING / inflated-ETA fork, seen twice 8/17).
  // Now: the SESSION starts/stops ONLY on navMode; route changes swap IN PLACE.
  // bannerSessionRef: has THIS component started a banner session for the current
  // turn-by-turn stint? Start happens on the first (mode, route) pairing regardless of
  // which arrives first; stop happens ONLY when navMode leaves turn-by-turn.
  const bannerSessionRef = useRef(false);
  useEffect(() => {
    if (navMode !== "turn-by-turn") return;
    // CLEANUP-ONLY BY DESIGN — do not merge this into the route effect below. Its one
    // job is firing the teardown exactly when navMode leaves turn-by-turn (or the
    // screen unmounts). Merging it back recreates the stop+start-on-every-traffic-
    // refresh flap this pair of effects exists to kill (the 8/17 rem-GROWING bug).
    return () => {
      bannerSessionRef.current = false;
      navBgActiveRef.current = false;
      stopNavBanner();
    };
  }, [navMode]);
  useEffect(() => {
    if (navMode !== "turn-by-turn" || !activeRoute) return;
    // isNavSessionLive heals danglers (review fix): if an out-of-band teardown — a
    // different JS context, a car-surface End — killed the session while navMode
    // stayed turn-by-turn, re-START on the next route change instead of feeding
    // swaps to a dead session. A start that threw also re-runs here (the .catch
    // resets the flag) instead of silencing the stint.
    if (!bannerSessionRef.current || !isNavSessionLive()) {
      bannerSessionRef.current = true;
      startNavBanner(activeRoute, destination?.label)
        .then((bg) => { navBgActiveRef.current = bg; })
        .catch(() => { bannerSessionRef.current = false; });
    } else {
      // In-place swap: keeps step progress on same-geometry swaps (traffic refresh),
      // re-anchors at step 0 only for genuinely new geometry (a reroute, computed
      // from the current position). Never touches navigating/holds/ownership.
      void swapNavRoute(activeRoute, destination?.label);
      // Bg-location retry (review fix): the old per-route-change restart accidentally
      // re-acquired the background feed, healing a mid-drive "Always" grant or a
      // transient first-acquire failure. Keep that healing on the same cadence.
      if (!navBgActiveRef.current) {
        acquireBgLocation("nav")
          .then((ok) => { if (ok) navBgActiveRef.current = true; })
          .catch(() => {});
      }
    }
  }, [navMode, activeRoute, destination?.label]);
  useEffect(() => {
    if (navMode === "turn-by-turn" && coords && !navBgActiveRef.current) {
      updateNavBanner(coords.lat, coords.lng);
    }
  }, [coords, navMode]);

  // ---- Map follow / manual-pan + auto-recenter ----
  // The driver can pan the map freely even while moving or under guidance; after
  // 10s of no further panning the camera snaps back to centre on their car.
  // Wall-clock of the last FOREGROUND watch fix, so the background subscriber knows
  // when the fg watch has gone quiet (screen locked) and it should take over.
  const lastFgFixAtRef = useRef(0);
  const recenterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRecenterTimer = () => {
    if (recenterTimerRef.current) { clearTimeout(recenterTimerRef.current); recenterTimerRef.current = null; }
  };
  // ── AUTO-RECENTER IS A TIMESTAMP, NOT A TIMER (2026-07-30) ──────────────────
  // Jeff: "plotted a route, turned the screen off, and when I turned the phone back
  // on it re-oriented weird" — the map came back FLAT and NORTH-UP mid-drive.
  //
  // Two things had to line up. First, dropping follow during navigation orphans the
  // camera completely: the imperative lockstep that owns bearing+pitch requires
  // followUser (ConvoyMapbox lockReadyRef), and native follow is deliberately OFF
  // while heading-up (followUserLocation = ... && !headingUp). So with followUser
  // false there is NO camera driver at all, and the map sits at the style default —
  // north-up, no pitch. Exactly the screenshot.
  //
  // Second, the thing meant to rescue it was `setTimeout(..., 20000)`. iOS SUSPENDS
  // JS TIMERS WHILE THE PHONE IS LOCKED, which is precisely the state being described
  // — screen off, phone in a mount. The 20s recenter never fired, so the orphaned
  // camera stayed orphaned for the rest of the drive. This codebase has been bitten
  // by that exact trap twice before (the CarPlay alert modals that never dismissed);
  // the standing rule from it is: never hinge driver-facing behaviour on a JS timer.
  //
  // So the deadline is now a TIMESTAMP, released from the GPS-fix handler — which
  // keeps arriving with the screen off because background location does. The timer is
  // kept only as a fast path for the ordinary unlocked case; whichever fires first
  // wins, and both are idempotent.
  const panHoldUntilRef = useRef(0);
  const handleUserPan = () => {
    setIsFollowing(false);            // driver took control — stop chasing
    setNorthUpHold(false);            // a manual pan releases the compass north-up hold
    clearRecenterTimer();
    panHoldUntilRef.current = Date.now() + PAN_RECENTER_MS;
    recenterTimerRef.current = setTimeout(() => { setIsFollowing(true); }, PAN_RECENTER_MS);
  };
  const recenterNow = () => { clearRecenterTimer(); panHoldUntilRef.current = 0; setIsFollowing(true); };
  // Called from the position watch on every fix. Cheap, and the only release path
  // that survives a locked screen.
  const releasePanHoldIfDue = () => {
    const until = panHoldUntilRef.current;
    if (!until || Date.now() < until) return;
    panHoldUntilRef.current = 0;
    clearRecenterTimer();
    setIsFollowing(true);
  };
  useEffect(() => () => clearRecenterTimer(), []); // tidy on unmount
  // User map-zoom offset, driven by the +/- buttons on the left. Rides on the
  // follow zoom inside ConvoyMapbox (clamped there too). Negative = wider, positive = closer.
  const [zoomOffset, setZoomOffset] = useState(0);

  const startNav = () => {
    if (!activeRoute) return;
    navAutoStartedRef.current = true;
    // Fresh AI-route trace for this trip (learn the path we actually drive this time).
    driveTraceRef.current = [];
    // Capture the trip baseline (start time + planned traffic-aware duration) so the
    // proactive-reroute check can tell if the route later runs LONGER than promised.
    tripBaselineRef.current = { startedAt: Date.now(), plannedSec: activeRoute.duration_in_traffic_s ?? activeRoute.duration_s };
    // Begin guidance centred on the car (a destination pick had dropped follow to
    // frame the route options).
    clearRecenterTimer();
    setIsFollowing(true);
    setNorthUpHold(false);            // guidance is heading-up chase, not the compass north-up hold
    if (destination) addRecentRoute({ label: destination.label, lat: destination.lat, lng: destination.lng });
    // Clear any prior speech/state FIRST, then reserve + play the greeting. The
    // turn engine's activate path no longer resets the speech gate, so whatever
    // we queue here (greeting audio + the in-flight hold) survives until it ends.
    stopSpeech();
    // Play the greeting pre-loaded during preview, BEFORE the engine's first
    // turn callout (which is parked behind it). Runs before setNavMode so the
    // reservation is in place when the turn engine speaks.
    if (!navMuted) void playPreparedGreeting();
    setShowSteps(false);
    setNavMode("turn-by-turn");
  };
  // AI-route LEARNING: when a trip finishes, if the destination is a saved place AND we
  // actually drove to it (the trace ends near the destination), persist the decimated
  // driven path as the habitual route to that place. Consumes the trace either way so a
  // new trip starts clean. Pass the destination explicitly (onArrive clears it first).
  const maybeLearnDrive = (dest?: { lat: number; lng: number } | null) => {
    const d = dest ?? destination;
    const trace = driveTraceRef.current;
    driveTraceRef.current = [];
    if (!d || trace.length < 4) return;
    const place = matchSavedPlace(d.lat, d.lng);
    if (!place) return;
    const last = trace[trace.length - 1];
    // Only learn a REAL completion — the path must end near the destination.
    if (haversineMeters({ lat: last.lat, lng: last.lng }, { lat: d.lat, lng: d.lng }) > 250) return;
    void recordDrive({ placeId: place.id, trace });
  };

  const endNav = () => {
    // A 2D choice lasts exactly as long as the drive did — Jeff: "it sticks till route
    // ends or manually pushed button again."
    resetMapView2D();
    stopSpeech();
    maybeLearnDrive();
    tripBaselineRef.current = null;
    pendingRerouteRef.current = null;
    clearOffer();
    navAutoStartedRef.current = true;  // stay stopped until a new destination is set
    setNavMode("preview");
  };

  // END pressed on the HEAD UNIT — a FULL stop, not the phone's "drop to preview".
  //
  // THE GHOST-DESTINATION BUG (Jeff, 2026-07-24: "carplay had a gps location already
  // programmed in ... I could only get rid of it by plotting a destination from the
  // phone, but it came back when the phone route ended"):
  // endNav() deliberately KEEPS `destination` so the phone can show its preview
  // drawer and let you restart the same trip. But `activeRoute` therefore survives,
  // and the CarPlay mirror writes `routePolyline: route?.polyline` on EVERY tick
  // (preview is mirrored on purpose, for the route fan-out). So on the car the
  // ribbon reappeared the instant nav ended — and CarPlay has no preview drawer and
  // no clear button, so there was no way to dismiss it from the driver's seat:
  // pressing End cleared the car store and the next mirror tick put it straight back.
  // The car has no "preview" concept, so End from the car clears the destination and
  // the selected route as well — the same trio the phone's own Clear button uses.
  const endNavFromCar = useCallback(() => {
    endNav();
    setDestination(null);
    setRoute(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- CarPlay / Android Auto mirror (Phase 1) ----
  // Mirrors the active route + live turn-by-turn state onto the car display.
  // Consumes the SAME tbt/route the phone UI uses — no second engine, no double
  // voice. Safe no-op on web and on any build without the CarPlay native module.
  // ----- Agentic Scout on CarPlay: mic map-button → tap-to-talk toggle -----
  // Uses the same useVoice pipeline as the phone's hold-to-talk (agent endpoint
  // + legacy fallback). Tap starts listening, second tap stops + sends. The
  // recording/busy state mirrors into carStore so the car surface can show the
  // "Listening…/Thinking…" pill (a native map button has no pressed state).
  const scoutVoice = useVoice();
  const scoutVoiceRef = useRef(scoutVoice);
  scoutVoiceRef.current = scoutVoice;
  const toggleScoutMic = useCallback(async () => {
    const v = scoutVoiceRef.current;
    try {
      if (v.recording) {
        const uri = await v.stop();
        if (uri) await v.transcribe(uri);
      } else if (!v.busy) {
        await v.start();
      }
    } catch {}
  }, []);
  useEffect(() => {
    setCarState({ scoutListening: scoutVoice.recording, scoutThinking: !scoutVoice.recording && scoutVoice.busy });
  }, [scoutVoice.recording, scoutVoice.busy]);
  // Tap on the RN-surface Scout mic button (in the CarPlay car window) rides the
  // carStore gesture bus back to here — same JS context — and toggles the mic.
  useEffect(() => subscribeCarGesture((g) => { if (g.kind === "scoutMic") void toggleScoutMic(); }), [toggleScoutMic]);

  const { connected: carConnected } = useConvoyCarPlay({ route: activeRoute, routes, selectedRouteIndex, tbt, user: coords, destination, peers, onEnd: endNavFromCar, weather, onReportPolice: () => reportAlert('police'), onScoutMic: toggleScoutMic, selfUserId: user?.id,
    // Mirror the phone's map markers onto the CarPlay live map, with the SAME 'when
    // active' gates the phone uses. speedCameras/roadEvents are already [] when their
    // layer is off (hooks self-gate); hazards → the visible set (disputes<2); places →
    // the search pins only when the pins setting is on.
    hazards: hazards.filter(isHazardVisible),
    speedCameras,
    roadEvents,
    places: (settings.showPlacePins !== false ? placePins : []),
  });
  // Driver tapped "Show map" on the car-list face (see carListMode below). Resets on
  // head-unit detach and on nav end, so every car drive STARTS in list mode.
  const [carListMapOverride, setCarListMapOverride] = useState(false);
  useEffect(() => {
    if (!carConnected || navMode !== "turn-by-turn") setCarListMapOverride(false);
  }, [carConnected, navMode]);

  // HEAT PROBE — one row per 60 s of guidance. Jeff's 2-hour drive on build 73 ended
  // with the phone too hot to charge, and the analysis that followed is arithmetic, not
  // measurement: it assumes rAF runs at 60 Hz, when app.json sets
  // CADisableMinimumFrameDurationOnPhone and RN's display link caps nothing, while both
  // MapViews are pinned to 60. If rAF is at 120 the whole budget doubles. This measures
  // it, plus the battery tell that distinguishes "warm" from "iOS is refusing the
  // charger". Scoped to guidance so an idle map never spends INSERTs, and keyed on
  // carConnected so a car drive and a phone-only drive are comparable rows.
  // See src/heatProbe.ts. Costs one row/minute while navigating and nothing otherwise.
  useEffect(() => {
    if (navMode !== "turn-by-turn") return;
    startHeatProbe(`surface=${carConnected ? "car" : "phone"}`);
    return stopHeatProbe;
  }, [navMode, carConnected]);

  // ── CarPlay crew feed ──────────────────────────────────────────────────────
  // WHY: the car surface fed carStore from the LEGACY REST/WS `peers` map, which is
  // essentially always empty since presence became the live feed — so the car had no
  // crew. The CarPlay Crew button gathered 0 peers and silently self-zoomed, and the
  // car map drew no convoy, while the pill (counting presence) said "2 Crew".
  //
  // ⚠ HOOK PLACEMENT IS LOAD-BEARING. This MUST stay above map.tsx's
  // `if (!coords) return <Locating…>` early return. Two crashes today came from
  // putting these hooks BELOW it: with no GPS fix the hooks did not run, then once
  // coords arrived the hook count changed and React threw "Rendered more hooks than
  // during the previous render" — fatal, and it surfaced as an opaque native abort.
  // peerList is built after that return, so we read peerListRef (kept fresh there)
  // on an interval instead of deriving a render-time dependency.
  const lastCrewSigRef = useRef('');
  useEffect(() => {
    if (!carConnected) return;
    const push = () => {
      const list = peerListRef.current || [];
      // Coordinates rounded to ~11 m so GPS jitter alone cannot retrigger a write.
      const sig = list
        // Appearance is part of the signature: a peer repainting their car or switching
        // marker style must reach the head unit, and it never moves them, so a
        // position-only signature would suppress the write entirely.
        .map((p) => `${p.user_id}:${p.lat?.toFixed(4) ?? ''}:${p.lng?.toFixed(4) ?? ''}:${p.status ?? ''}`
          + `:${(p as any).marker ?? ''}:${(p as any).cls ?? ''}:${(p as any).activeColor || (p as any).carColor || ''}`)
        .join('|');
      if (sig === lastCrewSigRef.current) return;
      lastCrewSigRef.current = sig;
      setCarPeers(
        list
          .filter((p) => p && p.user_id)
          .map((p) => ({
            id: String(p.user_id),
            handle: p.handle || 'Driver',
            lat: typeof p.lat === 'number' ? p.lat : undefined,
            lng: typeof p.lng === 'number' ? p.lng : undefined,
            heading: typeof p.heading === 'number' ? p.heading : undefined,
            status: (p.status === 'parked' ? 'parked' : 'live') as 'live' | 'parked',
            // Mirror the SAME fields the phone map derives its peer look from, so the
            // two surfaces cannot drift into different answers.
            marker: ((p as any).marker === 'class' || (p as any).marker === 'arrow')
              ? (p as any).marker as 'class' | 'arrow' : undefined,
            cls: typeof (p as any).cls === 'string' ? (p as any).cls : undefined,
            color: (p as any).activeColor || (p as any).carColor || undefined,
          })),
        'phone',
      );
    };
    push();
    const id = setInterval(push, 2000);   // bounded write rate, no render coupling
    return () => clearInterval(id);
  }, [carConnected]);

  // ---- Plot a pre-designed cruise route (Hub P3) ----
  // Consumes the cruisePlot one-shot (set by the arrival push handler or the
  // cruise detail sheet): stash the via points for the route-fetch effect and set
  // the destination to the cruise end — the effect then builds meeting-point →
  // stops → end as the auto-selected route. Never clobbers active navigation
  // (re-pins the payload so it applies after the current drive ends).
  const pendingCruiseViaRef = useRef<{ via: { lat: number; lng: number }[]; destLat: number; destLng: number; scenic?: boolean } | null>(null);
  // Double-tap pin-drop: the previous single tap (time + coord). Ref, not state —
  // it must never re-render the map between the two taps. (Up here with the other
  // hooks — the render body below the no-coords early return can't declare refs.)
  const lastMapTapRef = useRef<{ t: number; lat: number; lng: number; sx?: number; sy?: number } | null>(null);
  useEffect(() => {
    const consume = () => {
      const c = cruisePlot.take();
      if (!c) return;
      if (navActiveRef.current) { cruisePlot.set(c); return; }
      const dest = c.end ?? c.venue;
      const via = (c.end ? [c.venue, ...c.stops] : c.stops).map((p) => ({ lat: p.lat, lng: p.lng }));
      pendingCruiseViaRef.current = { via, destLat: dest.lat, destLng: dest.lng, scenic: !!c.scenic };
      setDestination({ lat: dest.lat, lng: dest.lng, label: dest.label || c.title || "Cruise finish" });
    };
    const un = cruisePlot.subscribe(consume);
    consume(); // cold start: the push was tapped before this screen mounted
    return un;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Adopt a car-started navigation session (CarPlay-standalone Wave 3) ----
  // A route can now be STARTED from the head unit (Search on the car's nav bar →
  // carActions.startCarNav) with the phone in a pocket. Two adoption paths:
  //  • live (bus): the car starts nav while this screen is mounted → follow along now;
  //  • cold (persisted CAR_NAV_KEY): the phone opens mid-drive → resume seamlessly.
  // Adoption = setDestination + setNavMode ONLY: the destination-keyed route-fetch
  // effect rebuilds full routes from the CURRENT position, activeRoute derives, and
  // the nav-banner + turn engines fire off navMode — no startNav(), so the Nova
  // greeting (already played in the car) never replays. stopNavBanner clears the
  // key on any nav end, so a finished/ended drive can't re-adopt.
  useEffect(() => {
    const adopt = (dest: { lat: number; lng: number; label?: string }, startedAt?: number) => {
      if (navActiveRef.current) return; // already navigating — never clobber
      setDestination({ lat: dest.lat, lng: dest.lng, label: dest.label || "" });
      // TRIP BASELINE (2026-07-31). Adoption deliberately skips startNav() — which is
      // the ONLY other place this is set — so a car-started drive arrived with a null
      // baseline and onArrive fell back to `Date.now()`, recording started_at ==
      // ended_at. Jeff's 2026-07-30 drive landed in the trips table as 32.3 km in
      // 0.0 MINUTES, which is exactly the usage number he now watches.
      // startedAt comes from CAR_NAV_KEY on the cold path (the head unit's real start);
      // the live bus fires the instant the car starts nav, so now() is right there.
      // plannedSec is 0 until the route lands — see the effect below that fills it, and
      // the `> 0` guard on the running-late check, because a 0 plan would read as
      // infinitely late and fire reroute offers all drive.
      tripBaselineRef.current = { startedAt: startedAt || Date.now(), plannedSec: 0 };
      setNavMode("turn-by-turn");
    };
    const un = onCarNavStarted(({ dest }) => adopt(dest));
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(CAR_NAV_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (typeof saved?.dest?.lat !== "number" || typeof saved?.dest?.lng !== "number") return;
        // Stale-session guard: only adopt a car drive from the last 12h.
        if (Date.now() - (saved.startedAt || 0) > 12 * 3600_000) return;
        adopt(saved.dest, typeof saved.startedAt === "number" ? saved.startedAt : undefined);
      } catch {}
    })();
    return un;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Complete an ADOPTED baseline once its route lands. adopt() can only stamp the
  // start time — the route is rebuilt asynchronously from the current position — so
  // plannedSec arrives one render later. Only ever fills a 0; never re-baselines a
  // drive that already has a plan.
  useEffect(() => {
    if (navMode !== "turn-by-turn" || !activeRoute) return;
    const b = tripBaselineRef.current;
    if (!b || b.plannedSec > 0) return;
    tripBaselineRef.current = {
      startedAt: b.startedAt,
      plannedSec: activeRoute.duration_in_traffic_s ?? activeRoute.duration_s ?? 0,
    };
  }, [navMode, activeRoute]);

  // CarPlay ⇄ "Always" location CTA (CarPlay-standalone). Drive-tested ground truth
  // (2026-07-14): with only "While Using", iOS freezes GPS the moment the screen
  // locks — even with a live CarPlay scene — so the car marker stops until the
  // screen wakes. iOS shows the Always upgrade dialog at most once (the one-shot
  // askAlwaysLocationOnce), so the recovery path is Settings. Ask ONCE per app
  // session, only when a head unit is actually connected (the moment it matters).
  // Mirror the Always-permission state onto the car surface so the crew pill can go
  // RED while it is missing (Jeff, 2026-07-30). Re-read on every foreground, because
  // the only way to fix it is a trip to Settings and the driver comes straight back —
  // the pill has to be white again by then or the tell is worse than useless.
  // getBackgroundPermissionsAsync only READS; it never prompts, so this is safe to
  // run outside permissionGate (see the gate's own rule: only PROMPTS are serialized).
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const bg = await Location.getBackgroundPermissionsAsync();
        if (alive) setCarState({ alwaysLocation: !!bg?.granted });
      } catch {}
    };
    void read();
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') void read(); });
    return () => { alive = false; sub.remove(); };
  }, []);

  useEffect(() => {
    if (!carConnected || _carAlwaysCtaShownThisSession) return;
    (async () => {
      try {
        const bg = await Location.getBackgroundPermissionsAsync();
        if (bg.granted || _carAlwaysCtaShownThisSession) return;
        _carAlwaysCtaShownThisSession = true;
        // QUEUED, not fired immediately. This is a modal that wants the driver's
        // attention, so it goes through the same serializer as the OS permission
        // prompts — otherwise it lands ON TOP of the location disclosure when a head
        // unit is connected at first launch (seen in the CarPlay sim 2026-07-25:
        // both were on screen at once, which is exactly the "bombarded with allows"
        // pile-up we just removed). askPermission also leaves a gap after the
        // previous sheet dismisses.
        await askPermission(
          () => new Promise<void>((resolve) => {
            Alert.alert(
              "Keep CarPlay tracking while locked",
              'iOS pauses Hairpin’s GPS when your phone locks unless Location is set to "Always" — so the car map freezes until the screen wakes. Set Location to Always and CarPlay keeps moving with the phone in your pocket.',
              [
                { text: "Not now", style: "cancel", onPress: () => resolve() },
                { text: "Open Settings", onPress: () => { void Linking.openSettings(); resolve(); } },
              ],
              { onDismiss: () => resolve() },
            );
          }),
          undefined,
        );
      } catch {}
    })();
  }, [carConnected]);
  // Delete a hazard (by id) — used by the long-press / right-click flow on
  // markers. Optimistically removes from local state on success so the pin
  // disappears immediately. Backend already authorizes (only the original
  // reporter can delete; otherwise the API silently no-ops with 200).
  const deleteHazard = async (hazardId: string) => {
    try {
      await api.delete(`/hazards/${hazardId}`);
      setHazards((prev) => prev.filter((h) => h.id !== hazardId));
    } catch (e) {
      console.warn("deleteHazard failed", e);
    }
  };
  // Wired to ConvoyMap's new `onHazardLongPress` prop. Pops the standard
  // native confirm dialog so a tap on a real pin doesn't accidentally remove
  // it — destructive operations always require a deliberate second tap.
  const handleHazardLongPress = (h: Hazard) => {
    Alert.alert(
      "Remove Alert",
      `Remove this ${h.kind} alert?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => deleteHazard(h.id) },
      ]
    );
  };
  const clearRoute = () => {
    stopSpeech();
    tripBaselineRef.current = null;
    pendingRerouteRef.current = null;
    clearOffer();
    setDestination(null);
    setRoutes([]);
    setRoute(null);
    setShowSteps(false);
    setNavMode("preview");
    // Stops belong to THIS trip — clearing the route drops them too, otherwise the
    // next destination silently inherits the last trip's waypoints.
    setStops([]);
    // Also retract the step drawer so it doesn't dangle on a destination-less map.
    slideStepDrawerDown();
  };

  // ----- Saved places: long-press the map to save Home / Work -----
  const handleMapLongPress = (c: { lat: number; lng: number }) => {
    Alert.alert(
      "Save this spot",
      "Set it as a quick destination for predictions and your Scout greeting.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Home",
          onPress: () => {
            void saveSavedPlace({ kind: "home", lat: c.lat, lng: c.lng });
            try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
            Alert.alert("Saved", "This spot is now your Home.");
          },
        },
        {
          text: "Work",
          onPress: () => {
            void saveSavedPlace({ kind: "work", lat: c.lat, lng: c.lng });
            try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
            Alert.alert("Saved", "This spot is now your Work.");
          },
        },
      ]
    );
  };

  // ----- Bookmark the current destination from the Drive shelf -----
  // Saves the active destination as a quick place. Home/Work are the predictive
  // anchors (used by the greeting + "Head to..." suggestion); "Save" stores it as
  // a custom place. All three appear in the search screen's Saved list.
  const saveCurrentDestination = () => {
    if (!destination) return;
    const d = destination;
    Alert.alert(
      "Save place",
      d.label || "Save this destination for quick access.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Home", onPress: () => { void saveSavedPlace({ kind: "home", lat: d.lat, lng: d.lng, address: d.label }); try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {} } },
        { text: "Work", onPress: () => { void saveSavedPlace({ kind: "work", lat: d.lat, lng: d.lng, address: d.label }); try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {} } },
        { text: "Custom…", onPress: () => { setSavePlaceName(d.label || ""); setSavePlaceModal({ lat: d.lat, lng: d.lng }); } },
      ]
    );
  };

  // Commit the typed custom name from the modal as a custom saved place.
  const commitCustomSave = () => {
    const m = savePlaceModal;
    if (!m) return;
    const name = savePlaceName.trim();
    if (!name) return;
    void saveSavedPlace({ kind: "custom", label: name, lat: m.lat, lng: m.lng });
    try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    setSavePlaceModal(null);
    setSavePlaceName("");
  };

  // ===== Step Drawer =====
  // Slides up from the bottom when a route is selected, lists each maneuver,
  // and auto-hides after 3s. The drawer is fully encapsulated in
  // `components/StepDrawer` — we just hold a ref so we can drive open/close.
  const stepDrawerRef = useRef<StepDrawerHandle | null>(null);
  const stepDrawerAutoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slideStepDrawerUp = () => stepDrawerRef.current?.open();
  const slideStepDrawerDown = () => stepDrawerRef.current?.close();

  // Grabber pan kept for the drag affordance, but swipe-to-collapse was removed
  // with the old trip-summary pill — the Drive banner now stays up until you tap
  // Start (or auto-start by driving off).
  const sheetPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderRelease: () => {},
    })
  ).current;

  // Tap a route polyline on the map (or an alternate chip in the sheet) →
  // SELECT it: highlight that route in convoy-yellow and refresh the ETA,
  // matching native Google Maps where tapping an alternate just previews it.
  // The driver then taps Start to begin turn-by-turn. (Previously this
  // collapsed to the tapped route and jumped straight into navigation, which
  // is why tapping a line never simply "turned it yellow".)
  const handleSelectRoute = (index: number) => {
    // Google-style inline reroute: the offer line is appended AFTER `routes` for
    // display only, so a tap landing past the real list means the driver tapped
    // the blue offer line — switch instantly (same accept path as the pill).
    if (rerouteOfferRef.current && index >= routes.length) { acceptReroute(); return; }
    if (index < 0 || index >= routes.length) return;
    setSelectedRouteIndex(index);
  };
  // Clear the auto-hide timer on unmount so we don't leak.
  useEffect(() => () => {
    if (stepDrawerAutoHideTimer.current) clearTimeout(stepDrawerAutoHideTimer.current);
  }, []);

  // NOTE: there is intentionally NO separate turn-by-turn GPS watcher here.
  // The always-on watcher below (1s, heading+speed) is the single source of
  // `coords` for both the engine and the chase camera. A second nav-only
  // watcher used to run alongside it and called setCoords({lat,lng}) WITHOUT
  // heading/speed, so during nav the two watchers alternated and speed kept
  // flickering to undefined — which made the chase-cam zoom oscillate and the
  // car/heading jitter. One watcher = stable speed, stable zoom, smooth marker.

  // ===== Hail subscription =====
  //
  // Peers can hail us via two transports — both feed `hailBus`:
  //   1. OS push notification (handled in app/(app)/_layout.tsx, which
  //      republishes to `hailBus` so the foregrounded map sees the same toast).
  //   2. Raw WebSocket fallback frame from the backend's `_send_hail_via_ws`
  //      (also forwarded to `hailBus` by the global WS listener).
  // Either way, this effect just pops a 5s toast.
  useEffect(() => {
    const off = hailBus.on(({ fromHandle }) => {
      setHailToast(`👊 ${fromHandle} sent you a YOHB!`);
      if (hailToastTimer.current) clearTimeout(hailToastTimer.current);
      hailToastTimer.current = setTimeout(() => setHailToast(null), 5000);
    });
    return () => {
      off();
      if (hailToastTimer.current) clearTimeout(hailToastTimer.current);
    };
  }, []);

  // ----- Initial location -----
  // Resolve the FIRST GPS fix BEFORE mounting the map at a real position. We
  // intentionally do NOT seed a default (San Francisco) up front: doing so
  // mounted the map there and then JUMPED to the user's real location the
  // instant they tapped "Allow", which reloaded tiles and read as a "glitch".
  // Now the map holds the brief "Locating…" state (capped at 6s) and mounts
  // once, directly where the driver is.
  //
  // Permission is only REQUESTED when its status is still "undetermined" (the
  // very first launch). On every later launch we just READ the status via
  // getForegroundPermissionsAsync, so the OS prompt never reappears.
  useEffect(() => {
    (async () => {
      // 1) Seed INSTANTLY from the location cached on a previous run so the map
      //    mounts near the driver instead of a default (San Francisco) and then
      //    visibly jumping. The intro overlay hides this until a real fix lands.
      try {
        const raw = await AsyncStorage.getItem(LAST_LOC_KEY);
        if (raw) {
          const c = JSON.parse(raw);
          if (typeof c?.lat === "number" && typeof c?.lng === "number") {
            setCoords((cur) => cur ?? { lat: c.lat, lng: c.lng });
          }
        }
      } catch {}
      try {
        if (await ensureLocationPermission()) {
          // OS-cached last fix is instant — seed with it if we had no app cache.
          try {
            const last = await Location.getLastKnownPositionAsync();
            if (last?.coords) setCoords((cur) => cur ?? { lat: last.coords.latitude, lng: last.coords.longitude });
          } catch {}
          const pos = await Promise.race([
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
          ]);
          if (pos && (pos as any).coords) {
            const lat = (pos as any).coords.latitude;
            const lng = (pos as any).coords.longitude;
            setCoords({ lat, lng });
            try { await AsyncStorage.setItem(LAST_LOC_KEY, JSON.stringify({ lat, lng })); } catch {}
            // Cold-start bootstrap. Ungated until 2026-07-31 — opening the app at your
            // desk posted your desk. Async form: this runs before the settings cache or
            // the car spot are necessarily hydrated, and the cache defaults to `partial`.
            try {
              const share = await shareablePositionAsync({ lat, lng, heading: 0, speed: 0 });
              if (share.share) await api.post("/location", { lat: share.lat, lng: share.lng, speed: share.speed, heading: share.heading });
            } catch {}
          }
        }
      } catch {}
      // Last resort: only if we STILL have nothing to show seed San Francisco
      // so the map isn't blank (first launch / denied / no cache / GPS failed).
      setCoords((cur) => cur ?? { lat: 37.7749, lng: -122.4194 });
      loadPeers();
      // One-time "Always" location upgrade ask (CarPlay-standalone). Delayed a few
      // seconds past mount so it never stacks on the foreground prompt / first paint;
      // self-guards (one-shot flag, skips if fg not yet granted — see navNotification).
      setTimeout(() => { void askAlwaysLocationOnce(); }, 6000);
    })();
  }, []);

  // App foreground/background state — gates battery-hungry work (the 1 Hz GPS
  // watcher and the nearby-driver poll) so it pauses while the app is in the
  // background and we're not navigating. The audio session stays active in the
  // background (for PTT + nav voice), which keeps JS timers alive — so without
  // this, GPS + polling would otherwise keep running on the home/lock screen.
  const [appActive, setAppActive] = useState(true);
  // Premium (plugged) vs eco (unplugged) power profile. Drives the battery/heat gates
  // below (3D buildings, GPS accuracy). Always "premium" on a build without expo-battery
  // (build 62), so this is a no-op until build 63 — the premium path never changes.
  const powerMode = usePowerMode();
  const wasActiveRef = useRef(true);
  useEffect(() => {
    const s = AppState.addEventListener("change", (st) => {
      const active = st === "active";
      setAppActive(active);
      // Returning to the foreground (e.g. switching back from another app
      // mid-drive): recenter and pull an immediate fresh fix so the car snaps to
      // where you are NOW. While backgrounded the RAF render loop is frozen and
      // (when not navigating) the GPS watcher is paused, so without this the
      // camera "takes forever to find the car" — it eases up from the stale pose
      // and waits on the watcher's first tick. ConvoyMapbox clears its seed on the
      // same foreground event, so this fresh fix hard-snaps the car + chase cam.
      if (active && !wasActiveRef.current) {
        recenterNow();
        (async () => {
          try {
            const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
            if (pos?.coords) {
              const h = pos.coords.heading;
              const sp = pos.coords.speed;
              setCoords((cur) => ({
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                heading: typeof h === "number" && h > 0 ? h : cur?.heading,
                speed: typeof sp === "number" && sp >= 0 ? sp : (cur?.speed ?? 0),
              }));
            }
          } catch {}
        })();
      }
      wasActiveRef.current = active;
    });
    return () => s.remove();
  }, []);
  // Live nav flag the watcher can read WITHOUT re-subscribing on every nav
  // start/stop (re-subscribing mid-drive would blip GPS). Only appActive flips
  // the watcher; nav state is consulted via this ref.
  const navActiveRef = useRef(false);
  useEffect(() => { navActiveRef.current = navMode === "turn-by-turn"; }, [navMode]);

  // Keep the screen awake the WHOLE time the map screen is open — not just during
  // active turn-by-turn. In the car the phone is plugged in and the driver needs the
  // map visible whether navigating, in convoy mode, or just watching the route, so the
  // old tbt-only gate let it dim mid-drive. Released on unmount; iOS still locks once
  // backgrounded. (Trade-off: foregrounded + parked + unplugged won't auto-dim.)
  useEffect(() => {
    // Prevent Auto-Lock (Settings → Driving, default on): when the user turns it OFF,
    // release the lock and bail so the phone can auto-dim/lock normally.
    if (settings.preventAutoLock === false) { deactivateKeepAwake('convoy-nav').catch(() => {}); return; }
    activateKeepAwakeAsync('convoy-nav').catch(() => {});
    // Re-assert on every return to foreground. iOS clears isIdleTimerDisabled when
    // the app backgrounds (phone locked / CarPlay took over), so without this the
    // screen would start auto-locking again after the first background — which is
    // exactly the "screen sleeps → CarPlay freezes" the tester hit. Re-disabling it
    // here keeps the phone awake for the whole drive, wired or wireless.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') activateKeepAwakeAsync('convoy-nav').catch(() => {});
    });
    return () => { sub.remove(); deactivateKeepAwake('convoy-nav').catch(() => {}); };
  }, [settings.preventAutoLock]);

  // ----- Continuous heading + position watcher -----
  // BestForNavigation accuracy + 1s tick + 0m distance gate so the speedometer
  // updates every second instead of every ~4s/8m. Battery cost is acceptable
  // for a car-enthusiast app — this is the same cadence Google Maps uses.
  // Border-detection: throttle the reverse-geocode lookup to once a minute.
  // (There is no manual unit override any more — the detect is fully automatic;
  // see the SPEED UNITS note further down.)
  const lastUnitCheckRef = useRef<number>(0);
  // Border-detection reverse-geocode is gated on BOTH the 60 s timer AND ~2 km of
  // travel since the last lookup, so a parked or stop-and-go car stops paying for it.
  const lastUnitCheckPosRef = useRef<{ lat: number; lng: number } | null>(null);
  // Throttle backend /location POSTs (live-avatar publish) to ~once / 4s.
  const lastLocPostRef = useRef<number>(0);
  useEffect(() => {
    let sub: any = null;
    (async () => {
      try {
        if (!(await ensureLocationPermission())) return;
        // Battery: don't run the high-accuracy 1 Hz GPS watcher while the app is
        // backgrounded AND we're not navigating — there's no visible map and no
        // route to follow, so it would just drain the battery. Foreground OR an
        // active turn-by-turn route keeps it on. (Backgrounded navigation also
        // has its own bg-location task in navNotification.ts. CarPlay-with-screen-off
        // is fed independently by carPlayBootstrap's acquireBgLocation +
        // startForegroundCarFeed → carStore, so the car map tracks without this watcher.)
        if (!appActive && !navActiveRef.current) return;
        // PREMIUM (plugged): BestForNavigation @ 500ms / 0 m — the smoothest feed.
        // ECO (unplugged, build 63+): High @ 1 s + an 8 m distance gate — still solid
        // nav-grade GPS (the ConvoyMapbox ease loop interpolates between fixes so the car
        // stays smooth) but far less GPS/radio cycling and no callback thrash when stopped.
        // Re-subscribes on plug/unplug via the powerMode dep on this effect.
        sub = await Location.watchPositionAsync(
          powerMode === "eco"
            ? { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 8 }
            // distanceInterval 2 (was 0): let the OS drop sub-2m stationary jitter
            // before it reaches the marker (BestForNavigation is tuned for motion and
            // roams when parked) — the OTA half of the idle-drift fix; the marker's
            // speed-scaled dead-band is the other half. 2m is well below nav needs.
            : { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 500, distanceInterval: 2 },
          (pos) => {
            const h = pos.coords.heading;
            const heading = typeof h === "number" && h > 0 ? h : undefined;
            const sRaw = pos.coords.speed;
            const speed = typeof sRaw === "number" && sRaw >= 0 ? sRaw : 0;  // clamp negatives
            // Remember the last REAL travel course. It is the best "which way does
            // the car face" answer for the first 90s after stopping — no compass
            // calibration, no interference from the car's own steel — and it is what
            // the departure-direction pick prefers before falling back to the
            // magnetometer. See src/departureBearing.ts.
            noteCourse(heading);
            // Survives a locked screen, unlike the 20s timer — see handleUserPan.
            releasePanHoldIfDue();
            // Push to the position history buffer so we can recall where the
            // driver was 5s ago (when they tap a hazard/police report button).
            posHistoryRef.current.push({ lat: pos.coords.latitude, lng: pos.coords.longitude, ts: Date.now() });
            posHistoryRef.current = posHistoryRef.current.filter(p => Date.now() - p.ts < 30000);
            // While navigating, accumulate the WHOLE driven path for AI-route learning.
            // Sampled lightly (skip points <25m from the last) to bound growth on a long
            // drive; recordDrive decimates again on save. Capped so a marathon trip can't
            // grow unbounded in memory.
            if (navActiveRef.current) {
              const t = driveTraceRef.current;
              const lp = t[t.length - 1];
              const far = !lp || haversineMeters({ lat: lp.lat, lng: lp.lng }, { lat: pos.coords.latitude, lng: pos.coords.longitude }) >= 25;
              if (far) {
                t.push({ lat: pos.coords.latitude, lng: pos.coords.longitude, ts: Date.now() });
                if (t.length > 5000) t.splice(0, t.length - 5000);
              }
            }
            lastFgFixAtRef.current = Date.now();   // see the bg-fix subscriber below
            setCoords((cur) => ({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              heading: heading ?? cur?.heading,
              speed,
            }));
            // Live-avatar publish â push our position to the backend on a ~4s
            // throttle so every other driver's /users/nearby (polled by
            // loadPeers) shows us live. Pure REST â no Supabase Realtime needed.
            const nowPost = Date.now();
            // ── /location CADENCE: PRESENCE-AWARE (2026-08-15) ────────────────────
            // VERIFIED, because the obvious assumption is WRONG: /location is not just
            // a write that the 10s /users/nearby poll later reads. The backend ALSO
            // fans it out over the WebSocket as {type:"location"} to every co-member
            // (convoy-backend/server.py:744-750), and BOTH clients ingest those frames
            // straight into their peer map — this file's ws.onmessage below, and
            // src/carplay/carDataService.ts:157 for the CarPlay/AA surfaces. So this
            // POST IS a realtime peer feed; its cadence cannot be stretched blindly.
            //
            // What makes 4s safe: BOTH peer merges let Supabase presence WIN over the
            // WS/REST entry — the peerList merge below ("Presence wins (live & most
            // recent)") and carDataService's emitPeers (presence spread last, line 89)
            // — and presence re-broadcasts every 1.5s (convoyPresence track throttle).
            // So for any peer sharing our ACTIVE community the WS frame is already
            // discarded at render. CarPlay-standalone has shipped on presence alone
            // since Wave 1: carDataService posts no /location at all.
            //
            // Where the WS frame is still the ONLY sub-10s feed: with NO active
            // community we never join a presence channel (presenceChannel === null
            // below), so nothing of ours reaches peers except this POST. Keep 1 Hz
            // there. Stationary stays 12s in every case — a parked car has nothing new
            // to broadcast, and that back-off already slashed radio wakeups at meets.
            const presenceCovering = SUPABASE_ENABLED && !!getSettings().activeCommunityId;
            const postEveryMs = speed > 0.5 ? (presenceCovering ? 4000 : 1000) : 12000;
            if (nowPost - lastLocPostRef.current > postEveryMs) {
              lastLocPostRef.current = nowPost;
              // ── PRIVACY GATE (2026-07-31) ──────────────────────────────────
              // This used to post pos.coords RAW, with no reference to avatarMode
              // and no parked check — a second, ungated pipeline running beside the
              // presence contract. The backend writes it to the user document, fans
              // it out over the WebSocket and serves it from /users/nearby, so
              // walking from the car into a building published the building, once a
              // second, to every connected client. The presence "parked" pin was
              // only ever a client-side render laid over that.
              // Same decision as presence now, from the one module that owns it.
              const share = shareablePosition({
                lat: pos.coords.latitude, lng: pos.coords.longitude,
                heading: heading ?? 0, speed,
              });
              if (share.share) {
                api.post("/location", {
                  lat: share.lat, lng: share.lng,
                  speed: share.speed, heading: share.heading,
                }).catch(() => {});
              }
            }
            const kmh = speed * 3.6;
            // Personal-best tracking (in-memory): ignore stationary jitter (<1 km/h).
            // The throttled PUT to /auth/profile is handled by the existing
            // `useEffect([sessionMaxSpeed, ...])` block below — no duplicate post here.
            if (kmh >= 1) {
              setSessionMaxSpeed((m) => (kmh > m ? kmh : m));
            }
            // Posted speed limit now comes from OpenStreetMap via the
            // useSpeedLimit() hook (Google Roads Speed Limits is a gated, paid
            // endpoint that was disabled on this project). `now` is still used
            // by the border-aware unit auto-detect just below.
            const now = Date.now();
            // Border-aware speed-unit auto-detect.
            //   * Runs ONCE immediately (lastUnitCheckRef===0), then every
            //     60s while the watcher is active so a road-trip from BC
            //     into Washington flips KM/H → MPH within ~1 minute.
            //   * Worldwide via unitForCountry(): mph list (US/UK/Caribbean/
            //     territories) → MPH, everything else → KM/H.
            //   * Fully automatic — no manual override (the SPEED UNITS toggle
            //     was removed); re-checks the country with getSettings() inside
            //     the network callback to avoid the stale-closure trap.
            const unitLast = lastUnitCheckPosRef.current;
            const unitMovedM = unitLast
              ? haversineMeters(unitLast, { lat: pos.coords.latitude, lng: pos.coords.longitude })
              : Infinity;
            if (lastUnitCheckRef.current === 0 || (now - lastUnitCheckRef.current > 60000 && unitMovedM >= 2000)) {
              lastUnitCheckRef.current = now;
              lastUnitCheckPosRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
              const GKEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY;
              if (GKEY) {
                fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${pos.coords.latitude},${pos.coords.longitude}&result_type=country&key=${GKEY}`)
                  .then((r) => r.json())
                  .then((data) => {
                    const country = data?.results?.[0]?.address_components?.find(
                      (c: any) => c.types?.includes('country')
                    )?.short_name;
                    const detected = unitForCountry(country);
                    // Race-safety re-check: settings may have changed while
                    // the network round-trip was in flight.
                    const cur = getSettings();
                    if (detected !== cur.speedUnit) {
                      updateGlobalSettings({ speedUnit: detected }).catch(() => {});
                    }
                  })
                  .catch(() => {});
              }
            }
          }
        );
      } catch {}
    })();
    return () => { try { sub?.remove?.(); } catch {} };
    // Re-subscribe only on foreground/background change (not on every nav
    // start/stop — that's read via navActiveRef to avoid GPS blips mid-drive).
  }, [appActive, powerMode]);

  // ----- Hazard/Police reporting (Waze-style "5s ago" anchor) -----
  // Drivers usually notice a hazard a beat after they pass it. Snapping the
  // report to the GPS sample closest to (now - 5s) places the pin where the
  // user actually saw the hazard, not where they are now (which could be a
  // few hundred meters past it at highway speed).
  const getPos5SecAgo = (): { lat: number; lng: number } => {
    const target = Date.now() - 5000;
    const h = posHistoryRef.current;
    if (!h.length) return { lat: coords?.lat ?? 0, lng: coords?.lng ?? 0 };
    return h.reduce((best, p) =>
      Math.abs(p.ts - target) < Math.abs(best.ts - target) ? p : best
    );
  };

  const reportAlert = async (kind: 'police' | 'road') => {
    const pos = getPos5SecAgo();
    try {
      // Capture the created hazard from the response and drop it on the map
      // IMMEDIATELY. Previously we relied on Supabase Realtime / the WebSocket
      // echo / the 30s poll to bring our own pin back, so the reporter often
      // saw the "reported" toast but no marker. Optimistic add fixes that; the
      // realtime + poll paths still keep every OTHER driver in sync, and the
      // id-dedup below means the echo never double-renders the pin.
      const { data } = await api.post('/hazards', { kind, lat: pos.lat, lng: pos.lng, note: '' });
      if (data && data.id) {
        setHazards((prev) => (prev.some((h) => h.id === data.id) ? prev : [data, ...prev]));
      }
      setAlertConfirm(kind);
      setTimeout(() => setAlertConfirm(null), 2500);
      if (Platform.OS !== 'web') {
        try {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch {}
      }
    } catch (e) {
      console.warn('reportAlert failed', e);
      Alert.alert('Report failed', 'Could not send your report. Check your connection and try again.');
    }
  };

  useEffect(() => {
    let cancelled = false;

    const fetchHazards = async () => {
      // Battery: skip the 30s fallback network poll while backgrounded AND not
      // navigating — no visible map and no active drive, so it would just wake the
      // cellular radio. During backgrounded NAV we keep polling so new hazard-ahead
      // alerts still refresh; the Supabase Realtime channel (below) covers the live
      // case regardless. Foreground always polls, and the initial mount fetch runs
      // (the map screen only mounts foreground). Refs = live values, no stale closure.
      if (!wasActiveRef.current && !navActiveRef.current) return;
      if (SUPABASE_ENABLED && supabase) {
        const { data, error } = await supabase
          .from("hazards")
          .select("*")
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false });
        if (!error && data && !cancelled) {
          setHazards(data.map(toHazard));
          return;
        }
      }
      // Fallback to FastAPI hazards endpoint if Supabase unavailable
      try {
        const { data } = await api.get("/hazards");
        if (!cancelled) setHazards(data);
      } catch {}
    };
    fetchHazards();

    // 30-second polling fallback — catches any hazards missed during a
    // WebSocket reconnect or a Supabase Realtime drop. Cheap (~1KB/poll) and
    // always community-agnostic, so even a driver with no active community
    // still sees every Convoy-network hazard within 30s of it being reported.
    const pollInterval = setInterval(fetchHazards, 30000);

    if (!SUPABASE_ENABLED || !supabase) { setLive("off"); return () => { cancelled = true; clearInterval(pollInterval); }; }

    const channel = supabase
      .channel("public:hazards")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "hazards" },
        (payload: any) => {
          const h = toHazard(payload.new as SupaHazard);
          setHazards((cur) => [h, ...cur.filter((x) => x.id !== h.id)]);
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "hazards" },
        (payload: any) => {
          const h = toHazard(payload.new as SupaHazard);
          setHazards((cur) => cur.map((x) => (x.id === h.id ? h : x)));
        }
      )
      // DELETE fan-out — when one driver disputes a hazard ("Not there") the
      // row is removed from Supabase; this listener pulls the marker off every
      // other driver's map within ~1.5s without needing a full refetch.
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "hazards" },
        (payload: any) => {
          const id = (payload.old as any)?.id;
          if (id) setHazards((cur) => cur.filter((x) => x.id !== id));
        }
      )
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") setLive("live");
        else if (status === "CHANNEL_ERROR" || status === "CLOSED" || status === "TIMED_OUT") setLive("off");
      });

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
      try { if (supabase) supabase.removeChannel(channel); } catch {}
    };
  }, []);

  // ----- Peers: existing WebSocket -----
  useEffect(() => {
    if (!token) return;
    const ws = new WebSocket(wsUrl(token));
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "location" && m.user_id !== user?.id) {
          setPeers((p) => ({
            ...p,
            [m.user_id]: {
              ...p[m.user_id],
              user_id: m.user_id,
              handle: m.handle ?? p[m.user_id]?.handle,
              lat: m.lat,
              lng: m.lng,
              heading: typeof m.heading === "number" ? m.heading : p[m.user_id]?.heading,
              carType: [m.car_make, m.car_model].filter(Boolean).join(" ").trim() || p[m.user_id]?.carType,
              carBody: m.car_type || p[m.user_id]?.carBody,
              carColor: m.car_color || p[m.user_id]?.carColor,
            } as any,
          }));
        }
        // Global hazard fan-out — every Convoy user receives every hazard
        // broadcast regardless of which community (or no community) they're
        // currently in. Dedup by id so the Supabase Realtime INSERT and the
        // WebSocket broadcast (both fire) don't double-render the marker.
        if (m.type === "hazard" && m.hazard && m.hazard.id) {
          setHazards((prev) => {
            if (prev.some((h: any) => h.id === m.hazard.id)) return prev;
            return [m.hazard, ...prev];
          });
        }
        // Vote count changed (someone confirmed/disputed) - merge the fresh
        // confirms/disputes onto the existing pin so every map stays in sync.
        if (m.type === "hazard_update" && m.hazard && m.hazard.id) {
          setHazards((prev) => prev.map((h: any) => (h.id === m.hazard.id ? { ...h, ...m.hazard } : h)));
        }
        // Hazard removed (2 distinct "Gone" votes, reporter delete, or expiry).
        // Pull it off this map immediately and dismiss any open card for it.
        if (m.type === "hazard_removed" && m.id) {
          setHazards((prev) => prev.filter((h: any) => h.id !== m.id));
          setSelected((s) => (s && s.id === m.id ? null : s));
          setPassPrompt((p) => (p && p.id === m.id ? null : p));
        }
        // Music broadcast from the community admin — surface a non-intrusive
        // toast at the bottom-center "🎵 jeff: Smooth Operator — Sade · HQ"
        // that auto-dismisses after 5s. `action: 'stop'` immediately clears it.
        if (m.type === "music_broadcast") {
          if (m.action === "play" && m.track) {
            const who = m.broadcaster_handle || "Admin";
            // Quality badge appended to the toast so listeners can see at a
            // glance what tier the admin is pushing. "Lossless"/"HQ"/"SD"
            // mirror Spotify's own terminology so users intuit instantly.
            const qLabel =
              m.quality === "lossless" ? " · 🎧 Lossless" :
              m.quality === "high"     ? " · HQ" :
              m.quality === "normal"   ? "" : ""; // hide for standard / unknown
            setMusicToast(`🎵 ${who}: ${m.track.name}${m.track.artist ? ` — ${m.track.artist}` : ""}${qLabel}`);
            if (musicToastTimer.current) clearTimeout(musicToastTimer.current);
            musicToastTimer.current = setTimeout(() => setMusicToast(null), 5000);
          } else if (m.action === "stop") {
            if (musicToastTimer.current) clearTimeout(musicToastTimer.current);
            setMusicToast(null);
          }
        }
      } catch {}
    };
    return () => ws.close();
  }, [token, user?.id]);

  const loadPeers = async () => {
    try {
      const { data } = await api.get("/users/nearby");
      setPeers((prev) => {
        const next: Record<string, Peer> = { ...prev };
        (Array.isArray(data) ? data : []).forEach((u: any) => {
          if (u.lat && u.lng) {
            next[u.id] = {
              ...next[u.id],
              user_id: u.id,
              handle: u.handle,
              lat: u.lat,
              lng: u.lng,
              heading: typeof u.heading === "number" ? u.heading : next[u.id]?.heading,
              // /users/nearby returns the full car profile, so peers render in
              // their real GR Corolla paint + body, not a generic marker.
              carType: [u.car_make, u.car_model].filter(Boolean).join(" ").trim() || next[u.id]?.carType,
              carBody: u.car_type || next[u.id]?.carBody,
              carColor: u.car_color || next[u.id]?.carColor,
              // Carry the peer's persisted personal-best speed so the YOHB hail card
              // shows THEIR PB. /users/nearby returns the full profile (incl.
              // top_speed_record), but this mapping never extracted it — so any peer
              // seen via this REST backstop (the common case) always showed "PB —".
              // Long-standing bug. Keep a live presence value if we already have one.
              topSpeed: typeof u.top_speed_record === "number" ? u.top_speed_record : next[u.id]?.topSpeed,
            } as Peer;
          }
        });
        // Stash every PB we just saw for the club leaderboard. The roster endpoint
        // (/communities/:id) does not carry top_speed_record, but THIS pipeline does —
        // it is exactly what the peer card reads for "PB 174 km/h". Caching at the
        // source means the board can never disagree with the card. Fire-and-forget.
        try {
          const pbPairs = Object.entries(next)
            .map(([id, p]: any) => ({ id: String(id), pb: Number(p?.topSpeed) }))
            .filter((p) => p.id && p.pb > 0);
          if (pbPairs.length) void cachePeerPbs(pbPairs);
        } catch {}
        return next;
      });
    } catch {}
  };

  // Live-avatar backstop: poll nearby drivers every 10s. This is the reliable
  // transport (plain REST, independent of Supabase Realtime) that guarantees
  // peers appear even if the presence WebSocket never connects. loadPeers
  // MERGES (never wipes) so live WS/presence updates aren't clobbered.
  useEffect(() => {
    // Battery: pause the 10s network poll while backgrounded — the map isn't
    // visible, so polling peers just wakes the cellular radio for nothing.
    // Refresh once immediately on (re)foreground so peers are fresh on return.
    if (!appActive) return;
    loadPeers();
    const t = setInterval(() => { loadPeers(); }, 10000);
    return () => clearInterval(t);
  }, [appActive]);

  // Force a full state refresh — used by the ⟳ button in the header. Mirrors
  // what a "pull to refresh" would do: requery GPS for a fresh lock, push the
  // new fix to the backend so other drivers see us in real-time, then reload
  // the peer list and external traffic feed. The presence channel's re-track
  // fires automatically because `coords` changes here.
  const forceRefresh = async () => {
    try { Haptics.selectionAsync().catch(() => {}); } catch {}
    try {
      // 1. Fresh GPS fix (5s race so a stale device doesn't hang the UI).
      const pos = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (pos && (pos as any).coords) {
        const lat = (pos as any).coords.latitude;
        const lng = (pos as any).coords.longitude;
        const heading = (pos as any).coords.heading;
        const speed = (pos as any).coords.speed;
        setCoords({
          lat,
          lng,
          heading: typeof heading === "number" && heading > 0 ? heading : (coords?.heading || 0),
          speed: typeof speed === "number" && speed >= 0 ? speed : 0,
        });
        // 2. Push the new fix to the backend so /users/nearby returns us live — but only
        //    what the avatarMode contract allows. This was ungated too, so a manual
        //    refresh while parked published wherever the driver was standing.
        try {
          const share = await shareablePositionAsync({
            lat, lng,
            heading: typeof heading === "number" && heading > 0 ? heading : 0,
            speed: typeof speed === "number" && speed >= 0 ? speed : 0,
          });
          if (share.share) await api.post("/location", { lat: share.lat, lng: share.lng, speed: share.speed, heading: share.heading });
        } catch {}
      }
    } catch {}
    // 3. Reload peer list + community list in parallel so
    //    everything visible on the map snaps to the latest server state.
    try { await Promise.all([loadPeers(), Promise.resolve()]); } catch {}
  };

  const reportHazard = async (kind: string, opts?: { fromVoice?: boolean }) => {
    if (!coords) return;
    // Place pin slightly ahead of the driver's heading (≈40m forward) for accuracy.
    // Without a known heading we just place it at the driver's exact spot.
    const pos = getPos5SecAgo();
    try {
      const { data } = await api.post("/hazards", { kind, lat: pos.lat, lng: pos.lng, note: "" });
      if (data && data.id) {
        setHazards((prev) => (prev.some((x) => x.id === data.id) ? prev : [data, ...prev]));
      }
      setShowReport(false);
      // Voice-driven reports get a spoken acknowledgement so the driver can keep eyes on the road
      if (opts?.fromVoice && !navMuted) {
        const label = kind === "police" ? "Police" : kind === "accident" ? "Accident" : kind === "traffic" ? "Traffic" : "Hazard";
        try { announce(reportConfirmLine(label)); } catch {}
      }
    } catch (e: any) {
      Alert.alert("Report failed", e?.message || formatErr(e));
    }
  };

  // Confirm = "still there" -> +1 confirm (backend tracks distinct voters and
  // refreshes the expiry). Optimistically bump the local count and dismiss any
  // open card / pass-by prompt for this hazard.
  const confirmHazard = async (h: Hazard) => {
    setHazards((cur) => cur.map((x) => (x.id === h.id ? { ...x, confirms: (x.confirms || 1) + 1 } : x)));
    setSelected((s) => (s && s.id === h.id ? null : s));
    setPassPrompt((p) => (p && p.id === h.id ? null : p));
    try { await api.post(`/hazards/${h.id}/confirm`); } catch {}
  };

  // Dispute = "not there anymore" -> a VOTE, not an instant delete. The backend
  // counts DISTINCT drivers who vote "Gone"; once 2 different drivers agree, it
  // removes the pin for everyone and broadcasts hazard_removed over the socket.
  // Here we optimistically bump the local dispute count (so the tapper sees
  // their vote land) and dismiss any open card / pass-by prompt. We do NOT strip
  // the marker locally on a single vote - one driver can't unilaterally erase a
  // real hazard; it takes a second independent confirmation.
  const disputeHazard = async (h: Hazard) => {
    setHazards((cur) => cur.map((x) => (x.id === h.id ? { ...x, disputes: (x.disputes || 0) + 1 } : x)));
    setSelected((s) => (s && s.id === h.id ? null : s));
    setPassPrompt((p) => (p && p.id === h.id ? null : p));
    try { await api.post(`/hazards/${h.id}/dispute`); } catch {}
  };

  const hazardColor = (k: string) =>
    k === "police" ? "#3478F6" : k === "accident" ? COLORS.danger : k === "traffic" ? COLORS.warning : COLORS.warning;
  const hazardIcon = (k: string): any =>
    k === "police" ? "shield-checkmark" : k === "accident" ? "alert-circle" : k === "traffic" ? "car" : "warning";

  // ----- Voice command subscription -----
  // Listens for hazard / navigation intents and acts on them while the map is active.
  useEffect(() => {
    const unsub = voiceBus.subscribe(async (cmd) => {
      const intent = cmd.intent;

      // ===== In-drive Q&A (Scout) =====
      // Answer spoken questions about the trip, hands-free, via the proven announce path.
      // Runs ONLY when the input isn't a recognized action command (so "navigate to…" /
      // "clear route" / hazard reports always win), and only while navigating.
      const ACTION_INTENTS = new Set([
        "navigate_to", "clear_route", "report_police", "report_accident", "report_road", "report_traffic",
      ]);
      if (navActiveRef.current && getSettings().novaVoice !== false && !ACTION_INTENTS.has(intent ?? "")) {
        const q = (cmd.text || "").toLowerCase();
        const tb = tbtRef.current;
        if (q && tb?.active) {
          if (/\b(when|how long|eta|arriv|get there|reach)\b/.test(q)) {
            announce(`You'll arrive around ${fmtClock(new Date(Date.now() + tb.etaSeconds * 1000))}, about ${fmtEtaSec(tb.etaSeconds)} from now.`);
            return;
          }
          if (/\b(next turn|next exit|which way|what.?s next|turn coming)\b/.test(q)) {
            const ar = activeRouteRef.current;
            const up = ar?.steps?.[Math.min(tb.stepIndex + 1, (ar?.steps?.length ?? 1) - 1)];
            const instr = (up?.html || "").replace(/<[^>]+>/g, "").trim() || "continue straight";
            announce(`In ${fmtDistanceM(tb.distanceToManeuverM)}, ${instr}.`);
            return;
          }
          if (/\b(how far|how much (further|longer)|distance|left to go)\b/.test(q)) {
            announce(`About ${fmtDistanceM(tb.distanceRemainingM)} to go.`);
            return;
          }
          if (/\b(ahead|anything|hazard|police|accident|traffic)\b/.test(q)) {
            const me = coordsRef.current, d = destRef.current;
            const hz = (me && d) ? nearestHazardAhead(me, d, hazardsRef.current) : null;
            if (hz) announce(`Yes — ${hazardReason(hz.kind)} about ${hz.distKm} ${hz.distKm === 1 ? "kilometer" : "kilometers"} ahead.`);
            else announce("Nothing reported ahead — you're clear.");
            return;
          }
        }
      }

      if (!intent) return;

      if (intent === "report_police") return reportHazard("police", { fromVoice: true });
      if (intent === "report_accident") return reportHazard("accident", { fromVoice: true });
      if (intent === "report_road") return reportHazard("road", { fromVoice: true });
      if (intent === "report_traffic") return reportHazard("traffic", { fromVoice: true });

      if (intent === "clear_route") {
        clearRoute();
        return;
      }

      if (intent === "navigate_to" && cmd.query) {
        const loc = await geocodeQuery(cmd.query, coords || undefined, true);
        if (loc) {
          setDestination(loc);
          setShowSteps(true);
        } else {
          Alert.alert("Couldn't find that place", `"${cmd.query}"`);
        }
      }
    });
    return unsub;
  }, [coords]);

  // ----- Pass-by hazard check ("still there?") -----
  // When we drive within ~120m of a community hazard that isn't ours, pop a
  // one-time prompt asking if it's still there. "Gone" casts a dispute vote;
  // two distinct drivers voting Gone removes the marker for everyone (the
  // backend enforces the 2-vote threshold). We ask at most once per hazard per
  // session, never for our own pins, and skip very fresh pins so we don't
  // prompt the instant one is reported next to us.
  useEffect(() => {
    if (!coords || !showHazards || passPrompt) return;
    const myHandle = user?.handle;
    for (const h of hazards) {
      if (!h || !h.id) continue;
      if (promptedHazardsRef.current.has(h.id)) continue;
      if ((h.disputes || 0) >= 2) continue;
      if (myHandle && h.reporter_handle === myHandle) continue;
      const created = (h as any).created_at ? new Date((h as any).created_at).getTime() : 0;
      if (created && Date.now() - created < 20000) continue;
      if (distanceKm(coords.lat, coords.lng, h.lat, h.lng) <= 0.12) {
        promptedHazardsRef.current.add(h.id);
        setPassPrompt(h);
        if (passPromptTimer.current) clearTimeout(passPromptTimer.current);
        passPromptTimer.current = setTimeout(
          () => setPassPrompt((p) => (p && p.id === h.id ? null : p)),
          15000
        );
        break;
      }
    }
  }, [coords?.lat, coords?.lng, hazards, showHazards, passPrompt, user?.handle]);

  // Clear the pass-by auto-dismiss timer on unmount so we don't leak.
  useEffect(() => () => { if (passPromptTimer.current) clearTimeout(passPromptTimer.current); }, []);

  // ----- Speed-camera proximity voice alert (Nova) -----
  // Announce ONCE when we come within ~100 m of a fixed speed camera while
  // actually moving (>= 25 km/h); re-arm a camera only after we've left a wider
  // ~600 m radius so a return trip past it can alert again. Respects the nav
  // mute toggle and the Speed Cameras setting.
  const announcedCamsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!coords || !speedCamerasEnabled || speedCameras.length === 0) return;
    const kmh = (coords.speed && coords.speed > 0) ? coords.speed * 3.6 : 0;
    const announced = announcedCamsRef.current;
    for (const c of speedCameras) {
      const dM = distanceKm(coords.lat, coords.lng, c.lat, c.lng) * 1000;
      if (dM > 600) { announced.delete(c.id); continue; }   // re-arm once well past
      if (dM <= 100 && kmh >= 25 && !announced.has(c.id)) {
        announced.add(c.id);
        if (!navMuted) { try { announce(pick(SPEED_CAMERA_LINES)); } catch {} }
      }
    }
  }, [coords?.lat, coords?.lng, speedCameras, speedCamerasEnabled, navMuted]);

  // ----- Hazard / police proximity voice alert (Nova) -----
  // Mirror of the speed-camera alert, but for community hazards: announce ONCE
  // when we come within ~500 m of a hazard while moving (>= 20 km/h), re-arming
  // a given hazard only after we've left a wider ~800 m radius. Police get a
  // "police reported ahead" callout; other kinds get their own phrasing.
  // Respects the nav mute toggle and the Hazards layer toggle. NOTE: distance-
  // only (no heading cone yet), matching the camera alert — a hazard 500 m
  // behind you can still trigger; a forward-cone filter can be added later.
  const announcedHazardsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!coords || !showHazards || hazards.length === 0) return;
    const kmh = (coords.speed && coords.speed > 0) ? coords.speed * 3.6 : 0;
    const announced = announcedHazardsRef.current;
    for (const h of hazards) {
      if (!h || !h.id) continue;
      const dM = distanceKm(coords.lat, coords.lng, h.lat, h.lng) * 1000;
      if (dM > 800) { announced.delete(h.id); continue; }   // re-arm once well past
      if (dM <= 500 && kmh >= 20 && !announced.has(h.id)) {
        announced.add(h.id);
        if (!navMuted) {
          try { announce(hazardAheadLine(h.kind)); } catch {}
        }
      }
    }
  }, [coords?.lat, coords?.lng, hazards, showHazards, navMuted]);

  // ----- DriveBC road-event proximity voice alert (Nova) -----
  // Official incidents from the Open511 feed. Same distance/re-arm shape as the
  // hazard alert, but ONLY the meaningful ones speak: MAJOR/MODERATE within ~800 m
  // while moving. MINOR/UNKNOWN stay silent map pins (no spam for a lane-marking
  // crew 2 km away). Names the road when the feed provides one.
  const announcedIncidentsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!coords || !roadIncidentsEnabled || roadEvents.length === 0) return;
    const kmh = (coords.speed && coords.speed > 0) ? coords.speed * 3.6 : 0;
    const announced = announcedIncidentsRef.current;
    for (const e of roadEvents) {
      if (!e || !e.id) continue;
      const dM = distanceKm(coords.lat, coords.lng, e.lat, e.lng) * 1000;
      if (dM > 1200) { announced.delete(e.id); continue; }       // re-arm once well past
      if (e.severity !== "MAJOR" && e.severity !== "MODERATE") continue; // minor = pin only
      if (dM <= 800 && kmh >= 20 && !announced.has(e.id)) {
        announced.add(e.id);
        if (!navMuted) {
          const what = e.kind === "construction" ? "Roadwork"
            : e.kind === "road" ? "A road closure"
            : e.kind === "weather" ? "A weather hazard"
            : e.kind === "event" ? "A road event"
            : "An incident";
          const where = e.road ? ` on ${e.road}` : "";
          try { announce(`Heads up — ${what.toLowerCase()} reported ahead${where}.`); } catch {}
        }
      }
    }
  }, [coords?.lat, coords?.lng, roadEvents, roadIncidentsEnabled, navMuted]);


  // ----- Deep link: convoy://go?to=work -----
  // Opens straight into a route to a saved place (powers the iOS Shortcuts
  // "when CarPlay connects -> Open Convoy" stopgap). Resolves the ?to= target
  // against saved places and routes there exactly like a picked search result.
  useEffect(() => {
    const handleUrl = async (url: string | null) => {
      if (!url || !/[?&]to=/i.test(url) || !/\bgo\b/i.test(url)) return;
      const m = url.match(/[?&]to=([^&]+)/i);
      if (!m) return;
      await ensureSavedPlacesLoaded();
      const place = resolveTarget(decodeURIComponent(m[1]));
      if (place) onSearchSelectPlace({ lat: place.lat, lng: place.lng, label: place.label });
    };
    Linking.getInitialURL().then(handleUrl).catch(() => {});
    const sub = Linking.addEventListener("url", (e) => { void handleUrl(e.url); });
    return () => { try { sub.remove(); } catch {} };
  }, []);

  // ----- Convoy Realtime Presence (Supabase) -----
  // Live peer broadcast/track via Supabase Realtime. Replaces stale REST polling for online cars.
  // (Must be declared BEFORE any early returns to keep React hook order stable.)
  // Community-scoped only — YVRGRC members see other YVRGRC members, period.
  // When the user is not in / hasn't selected a community, we pass `null` so
  // useConvoyPresence becomes a no-op (no global "everyone on the platform"
  // fanout). This guarantees strangers from outside the crew never appear on
  // the map. The "Avatar Live" privacy toggle also disables presence entirely
  // — when off the user vanishes from every peer's map and the map shows no
  // own marker either.
  // Avatar visibility mode (settings.avatarMode, legacy-synced with avatarLive):
  //   ghost   → never broadcast (opt out, same as the old avatarLive=false)
  //   partial → ALWAYS broadcast: LIVE (follows the car) while a CarPlay/AA head unit
  //             is connected, and PINNED to the last car spot (status "parked") on
  //             disconnect — so your REAL location away from the car is never shared,
  //             only the car's last position. Reconnect resumes live tracking.
  //   full    → same broadcast + pin-on-disconnect behavior.
  const avatarMode = getAvatarMode(settings);
  const baseChannel = settings.activeCommunityId ? `convoy:community:${settings.activeCommunityId}` : null;
  const presenceChannel = avatarMode === "ghost" ? null : baseChannel;

  // Last GPS sample seen WHILE the car head unit was connected — used as the
  // "parked" fallback position in full mode after the unit disconnects.
  // REWORKED 2026-07-20 (Jeff's photo: a parked peer's pin sat on their HOUSE).
  // Three stacked defects put a parked avatar at the driver's real location:
  //  1. The car spot was only recorded while a HEAD UNIT was connected — a peer
  //     without CarPlay/AA never recorded one.
  //  2. With no recorded spot, the parked branch FELL BACK TO LIVE COORDS —
  //     broadcasting exactly the location "parked" exists to hide.
  //  3. It was a bare useRef, wiped on every app restart — so even head-unit users
  //     leaked their home position after a relaunch.
  // Now: the spot is recorded whenever the head unit is connected OR the driver is
  // plainly DRIVING (speed ≥ 2.5 m/s ≈ 9 km/h — above walking pace), so the last
  // recorded point is on the road by construction; it persists across restarts;
  // and when parked with NO known car spot we broadcast NOTHING (buildPayload
  // returns null on null coords → the hub skips track) — absent beats exposed.
  // A parked pin only makes sense once the car is meaningfully elsewhere. Below this the
  // driver is standing next to (or crawling past) the recorded spot, and replacing their
  // live position with it is a lie about where they are. 75 m is well beyond GPS scatter
  // and stop-and-go creep, and well inside "I walked into that building".
  const SELF_PIN_MIN_SEPARATION_M = 75;
  const LAST_CAR_SPOT_KEY = "convoy.lastCarSpot.v1";
  const [privacyHydrated, setPrivacyHydrated] = useState(false);
  const lastCarLocRef = useRef<{ lat: number; lng: number } | null>(null);
  const lastCarLocSavedAtRef = useRef(0);
  useEffect(() => {
    // Hydrate once; never clobber a fresher in-memory value.
    AsyncStorage.getItem(LAST_CAR_SPOT_KEY)
      .then((raw) => {
        if (!raw || lastCarLocRef.current) return;
        const p = JSON.parse(raw);
        if (typeof p?.lat === "number" && typeof p?.lng === "number") lastCarLocRef.current = { lat: p.lat, lng: p.lng };
      })
      .catch(() => {});
    void hydrateLocationPrivacy().then(() => setPrivacyHydrated(true)).catch(() => setPrivacyHydrated(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const lastDrivingAtRef = useRef(0);
  useEffect(() => {
    const driving = (coords?.speed ?? 0) >= 2.5;
    if (driving) lastDrivingAtRef.current = Date.now();
    // SAME ANDROID RULE AS THE GATE CALL BELOW (2026-08-15). This screen is not
    // entitled to assert a head unit on Android — see the long note further down for
    // why (react-native-carplay emits didConnect unconditionally at library load).
    // This is the SECOND writer of convoy.lastCarSpot.v1, the one locationPrivacy does
    // not own, and it was left on the raw flag: without this the phantom still wrote
    // the walking position to disk every 15 s and it HYDRATED AS THE CAR SPOT on the
    // next launch — the house leak, closed on the live path but not on the persisted
    // one. Both writers now agree on what "in the car" means.
    const carAttachedHere = Platform.OS === "android" ? false : !!carConnected;
    if (coords && (carAttachedHere || driving)) {
      lastCarLocRef.current = { lat: coords.lat, lng: coords.lng };
      const now = Date.now();
      if (now - lastCarLocSavedAtRef.current > 15000) {
        lastCarLocSavedAtRef.current = now;
        AsyncStorage.setItem(LAST_CAR_SPOT_KEY, JSON.stringify(lastCarLocRef.current)).catch(() => {});
      }
    }
    // Mirror into src/locationPrivacy, which is what every OTHER transport asks
    // (the /location post above, CLVisit arrivals while the app is suspended).
    // Same key, same thresholds — this block stays the writer the presence payload
    // below already trusts; the module just makes the decision reachable elsewhere.
    // ── ANDROID: THIS SCREEN IS NOT ENTITLED TO ASSERT A HEAD UNIT (2026-08-15) ──
    // `carConnected` comes from useConvoyCarPlay, whose value on Android traces back
    // to react-native-carplay's checkForConnection(), which emits didConnect
    // UNCONDITIONALLY at library load (CarPlayModule.kt:96-98). So CarPlay.connected
    // is true on every Android launch with no car in existence. The hook's
    // spurious-connect guard only covers the first 5 s after the library loads
    // (ANDROID_SPURIOUS_CONNECT_GUARD_MS against a module-scope libLoadedAt stamped
    // once inside getLib()'s cache), so ANY later mount of this screen — a logout and
    // sign back in, any remount of the (app) group inside one JS context — re-runs
    // `if (CarPlay.connected) onConnect()`, sails past the window, and latches
    // `connected` true for the rest of the session.
    //
    // Feeding that into the gate told locationPrivacy a head unit was attached, which
    // sets inCar and publishes RAW live coordinates — the exact class this module was
    // written to kill ("it is supposed to stay on my car which is on the street a
    // block away"). It also made noteFix record a car spot at every fix while WALKING,
    // so the parked pin drifted onto the driver's house.
    //
    // A freshness TTL in the gate does not save us here: this effect re-runs on every
    // coords change, so a latched `true` is re-asserted about once a second — exactly
    // while walking. The source has to be cut, and it is cut here.
    //
    // Nothing is lost on Android. ConvoyCarPlay builds NO templates on Android by
    // construction (setRoot's whole body is inside `if (isIOS)`); the real car surface
    // is AndroidAutoRoot, which CarPlaySession runs natively only when a genuine
    // session exists. That root asserts the flag itself, so Android Auto keeps a
    // true head-unit signal by a shorter and honest path.
    // ── ANDROID: SKIP THE CALL, don't write `false` (2026-08-15 night) ────────────
    // Writing `false` here at every coords change (~1 Hz) CLOBBERED AndroidAutoRoot's
    // one-time `true` within a second of a real AA session starting — the head-unit
    // flag was effectively always false on Android whenever this screen was mounted,
    // and it would also fake a true→false "witnessed park" transition mid-drive (see
    // parkEndedByHeadUnit). This screen isn't entitled to ASSERT a head unit on
    // Android; it isn't entitled to RELEASE one either. AndroidAutoRoot owns both.
    if (Platform.OS !== "android") noteCarConnected(carAttachedHere);
    if (coords) noteFix(coords.lat, coords.lng, coords.speed ?? 0);
  }, [carConnected, coords?.lat, coords?.lng]);

  // Position + status we actually broadcast. PARTIAL or FULL → LIVE while the head
  // unit is connected OR while plainly driving (phone-only drivers used to render as
  // a translucent "parked" car even at highway speed); PINNED to the last car spot
  // otherwise. drivingRecently carries a 90s hysteresis so GPS jitter at a red light
  // doesn't flap live↔parked — and a mid-light flip is harmless anyway, since the
  // pin is the car's own road position by construction.
  // ONE CONTRACT (2026-07-31). This used to be the only place the parked rule lived,
  // computed inline — which is exactly how three ungated /location posters grew up
  // beside it. The rule now lives in src/locationPrivacy and this asks it, so presence
  // and every REST transport cannot drift apart again. It also inherits the tightened
  // position rule there: live coordinates require PROOF the phone is in the car (head
  // unit attached, or moving above walking pace right now), which closes the 90-second
  // window in which walking away from a just-parked car was still published live.
  const drivingRecently = Date.now() - lastDrivingAtRef.current < 90000;
  const shareNow = shareablePosition(
    coords ? { lat: coords.lat, lng: coords.lng, heading: coords.heading || 0, speed: coords.speed || 0 } : null,
  );
  const presencePos = shareNow.share ? { lat: shareNow.lat, lng: shareNow.lng, heading: shareNow.heading } : null;
  const presenceStatus: "live" | "parked" = shareNow.share ? shareNow.status : "parked";
  const presenceParked = presenceStatus === "parked";

  // ----- Throttled top_speed_record sync -----
  // Run whenever sessionMaxSpeed advances. If the new max beats the persisted
  // top_speed_record AND we haven't synced in the last 60s, PUT the new record
  // to /auth/profile and refresh the auth user. Battery-friendly cadence.
  useEffect(() => {
    if (!user) return;
    const persisted = user.top_speed_record || 0;
    if (sessionMaxSpeed <= persisted) return;
    const now = Date.now();
    if (now - lastTopSyncAtRef.current < 60_000) return;
    lastTopSyncAtRef.current = now;
    (async () => {
      try {
        await api.put("/auth/profile", { top_speed_record: Math.round(sessionMaxSpeed * 10) / 10 });
        // Pull the persisted value back into the local `user` so the garage PB,
        // presence broadcast, and anything else reading user.top_speed_record
        // reflect the new record immediately instead of staying stale until the
        // next app launch. Throttled (≤1/min) by the guard above, so the extra
        // /auth/me GET is cheap.
        await refresh();
      } catch {}
    })();
  }, [sessionMaxSpeed, user?.top_speed_record]); // eslint-disable-line react-hooks/exhaustive-deps

  const presence = useConvoyPresence(
    presenceChannel,
    user ? {
      user_id: user.id,
      handle: user.handle,
      // Combine make + model for a friendly pin label, e.g. "Porsche 911 GT3 RS"
      carType: [user.car_make, user.car_model].filter(Boolean).join(" ").trim() || undefined,
      carBody: (user as any).car_type || "sedan",
      // Pass car body silhouette + color so other drivers see the right top-down icon.
      // carColor sourced from LOCAL settings (Garage) first so peers see the
      // paint the driver actually picked, with the backend value as fallback.
      carColor: settings.carColor || user.car_color || undefined,
      // Class appearance: marker/class/paint travel over presence so crew see
      // the exotic (or boat, or Ducati) instead of the GRC avatar.
      marker: getSelfMarkerType(settings),
      cls: getVehicleClass(settings),
      clsPri: getClassPaint(settings).primary,
      clsSec: getClassPaint(settings).secondary,
      arrPri: settings.arrowPaint?.primary,
      arrSec: settings.arrowPaint?.secondary,
      // Personal best — live max-of(sessionMaxSpeed, persisted) so peers see
      // an up-to-date number even before the throttled sync fires.
      topSpeed: Math.max(user.top_speed_record || 0, sessionMaxSpeed),
      // "live" while driving / connected; "parked" when full-mode broadcasting a
      // last-known spot after the car head unit disconnected.
      status: presenceStatus,
    } : null,
    presencePos
  );
  const [selectedPeer, setSelectedPeer] = useState<ConvoyPresencePeer | null>(null);
  // Who's-on roster sheet, opened from the "N live" pill under the search bar
  // (tester request: see who's on → talk to them or drive to them).
  const [rosterOpen, setRosterOpen] = useState(false);

  // ---- Community Routes (admin-shared destinations / cruises) ----
  const { routes: communityRoutes } = useCommunityRoutes(settings.activeCommunityId || null);

  // Is the local driver actively on a SHARED convoy route? True when navigating
  // (turn-by-turn) to a destination that came from a community route (admin cruise
  // share) or was shared to us 1:1 (sharedRouteMeta). Kept in a ref for the 30 s
  // convoy-health monitor so the "spreading out" callout is silent unless the crew
  // is genuinely driving a shared route together.
  useEffect(() => {
    let on = false;
    const dest = destination;
    if (navMode === "turn-by-turn" && dest) {
      const near = (bLat: number, bLng: number) =>
        haversineMeters({ lat: dest.lat, lng: dest.lng }, { lat: bLat, lng: bLng }) < 200;
      if (sharedRouteMeta && near(sharedRouteMeta.lat, sharedRouteMeta.lng)) on = true;
      else if (communityRoutes.some((r) => near(r.dest_lat, r.dest_lng))) on = true;
    }
    onConvoyRouteRef.current = on;
  }, [navMode, destination, sharedRouteMeta, communityRoutes]);

  const [isAdminOfActive, setIsAdminOfActive] = useState(false);
  const [savingRoute, setSavingRoute] = useState(false);
  const [routeToast, setRouteToast] = useState<CommunityRoute | null>(null);
  // Track which route ids we've already seen so we only toast on truly new ones
  const seenRouteIdsRef = useRef<Set<string>>(new Set());

  // Resolve admin status of the active community (refresh when activeCommunityId changes)
  const [activeMapEnabled, setActiveMapEnabled] = useState(true);
  // user_id of the community's admin (= convoy leader). When set, that peer's
  // marker is rendered with a higher zIndex so it never gets buried under
  // teammates when everyone bunches up at a stoplight.
  const [leaderUserId, setLeaderUserId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const cid = settings.activeCommunityId;
    if (!cid) { setIsAdminOfActive(false); setActiveMapEnabled(true); setLeaderUserId(null); return; }
    (async () => {
      try {
        const { data } = await api.get(`/communities/${cid}`);
        if (!cancelled) {
          setIsAdminOfActive(!!data?.is_admin);
          setActiveMapEnabled(data?.map_enabled !== false);
          setLeaderUserId(data?.admin_id || null);
        }
      } catch {
        if (!cancelled) { setIsAdminOfActive(false); setActiveMapEnabled(true); setLeaderUserId(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [settings.activeCommunityId]);

  // Toast banner when the admin shares a NEW route (skip on first hydration)
  useEffect(() => {
    if (communityRoutes.length === 0) { return; }
    // First load — seed seen ids without toasting
    if (seenRouteIdsRef.current.size === 0) {
      communityRoutes.forEach((r) => seenRouteIdsRef.current.add(r.id));
      return;
    }
    const fresh = communityRoutes.find((r) => !seenRouteIdsRef.current.has(r.id));
    if (fresh) {
      seenRouteIdsRef.current.add(fresh.id);
      setRouteToast(fresh);
      // Auto-dismiss after 5s
      setTimeout(() => setRouteToast((t) => (t?.id === fresh.id ? null : t)), 5000);
    }
  }, [communityRoutes]);

  // Publish the proximity tier whenever peers or our coords change. Talk and
  // Music screens subscribe via `useLatestTier()` so they can pick HD/Clear/
  // Standard recording presets and broadcast-quality flags without spinning
  // up their own Supabase presence channels. setLatestTier is a no-op if the
  // value hasn't actually changed, so this is cheap to fire on every delta.
  //
  // IMPORTANT: this effect MUST live above the `if (!coords) return` early
  // return so React sees the same number of hooks on every render (else it
  // throws "Rendered more hooks than during the previous render"). The
  // guards live INSIDE the effect callback, not around the hook call.
  useEffect(() => {
    if (!coords) return;
    // Re-build the merged peer list inline (the post-return `peerList` const
    // isn't reachable here). This mirrors the same merge logic used below.
    const byId: Record<string, { lat: number; lng: number }> = {};
    Object.values(peers).forEach((p: any) => {
      if (typeof p?.lat === "number" && typeof p?.lng === "number") byId[p.user_id] = { lat: p.lat, lng: p.lng };
    });
    presence.peers.forEach((p) => { byId[p.user_id] = { lat: p.lat, lng: p.lng }; });
    const merged = Object.values(byId);
    const tier = getProximityTier(coords.lat, coords.lng, merged);
    setLatestTier(tier, merged.length);
  }, [peers, presence.peers, coords?.lat, coords?.lng]);

  // Load a community route into the active navigation flow
  const loadCommunityRoute = (r: CommunityRoute) => {
    setDestination({ lat: r.dest_lat, lng: r.dest_lng, label: r.dest_label || r.name });
    setShowSteps(true);
    setRouteToast(null);
  };

  // Share the current route with the user's community (any member). Reuses the
  // community-routes pipe so the crew can load the same destination/path from
  // the map. The backend authorizes; on failure we surface the reason.
  const shareRouteToCommunity = async () => {
    if (!destination) return;
    if (!settings.activeCommunityId) {
      Alert.alert("Join a club first", "Select or join a club to share routes with your crew.");
      return;
    }
    try {
      await createCommunityRoute({
        community_id: settings.activeCommunityId,
        name: destination.label || "Shared route",
        dest_label: destination.label,
        dest_lat: destination.lat,
        dest_lng: destination.lng,
        polyline: activeRoute?.polyline || undefined,
      });
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      Alert.alert("Route shared", "Your crew can now load this route from the map.");
    } catch (e: any) {
      Alert.alert("Couldn't share route", e?.response?.data?.detail || e?.message || "Try again");
    }
  };

  // Admin saves the current destination as a shared route for the community
  const saveCurrentDestinationToConvoy = async () => {
    if (!destination || !settings.activeCommunityId) return;
    setSavingRoute(true);
    try {
      await createCommunityRoute({
        community_id: settings.activeCommunityId,
        name: destination.label || "Hairpin cruise",
        dest_label: destination.label,
        dest_lat: destination.lat,
        dest_lng: destination.lng,
        // Save the currently-selected polyline so members can preview the same path instantly
        polyline: activeRoute?.polyline || undefined,
      });
    } catch (e: any) {
      Alert.alert("Couldn't share route", e?.response?.data?.detail || e?.message || "Try again");
    } finally {
      setSavingRoute(false);
    }
  };

  if (!coords) {
    return <View style={styles.loader}><Text style={{ color: COLORS.textDim }}>Locating…</Text></View>;
  }

  // Merge Supabase-presence peers with the legacy REST/WS peers map.
  // Presence wins (live & most recent) when the same user_id appears in both.
  const peerList = (() => {
    const byId: Record<string, Peer> = { ...peers };
    presence.peers.forEach((p) => {
      byId[p.user_id] = {
        user_id: p.user_id,
        handle: p.handle,
        lat: p.lat,
        lng: p.lng,
        carType: p.carType,
        carBody: p.carBody,
        // Carry the peer's paint + heading through so their marker renders in
        // the right color and rotated to their direction of travel. activeColor
        // is the canonical grc_* slug; carColor is the human label fallback.
        carColor: p.carColor,
        activeColor: p.activeColor,
        heading: p.heading,
        // Carry the peer's personal-best top speed through the merge so the YOHB
        // hail card can show their PB even when it's opened from the marker list.
        topSpeed: p.topSpeed,
        // "parked" peers render dimmed (full-mode user with head unit off).
        status: p.status,
        marker: (p as any).marker,
        cls: (p as any).cls,
        clsPri: (p as any).clsPri,
        clsSec: (p as any).clsSec,
        arrPri: (p as any).arrPri,
        arrSec: (p as any).arrSec,
      } as Peer;
    });
    return Object.values(byId);
  })();
  peerListRef.current = peerList; // keep the convoy-health monitor reading the live crew

  const liveDot = live === "live" ? COLORS.success : live === "connecting" ? COLORS.warning : COLORS.danger;
  const liveText = live === "live" ? "Live" : live === "connecting" ? "Connecting" : "Offline";

  // Filter out community-downvoted hazards before rendering
  const visibleHazards = hazards.filter(isHazardVisible);

  // Friend carousel list: every roster member, marked live (with their current
  // location) when they're present in the merged peerList. Offline members are
  // kept so the carousel can show them greyed out.
  const livePeerById = new Map<string, Peer>();
  peerList.forEach((p) => { if (p.user_id) livePeerById.set(p.user_id, p); });
  const navMembers: CarouselMember[] = navRoster.map((m) => {
    const p = livePeerById.get(m.id);
    const isLive = !!p && typeof p.lat === "number" && typeof p.lng === "number";
    return {
      id: m.id,
      handle: m.handle,
      car_color: m.car_color ?? p?.activeColor ?? p?.carColor,
      is_admin: m.is_admin,
      isLive,
      lat: p?.lat,
      lng: p?.lng,
    };
  });

  // Bottom-anchored chrome lift. Banners float just above the always-visible
  // tab bar; the FABs + speedo + weather lift to clear whichever banner is up.
  //   • preview "Drive" banner → lift by its measured height
  //   • turn-by-turn step bar  → lift by the collapsed step-bar height
  const bannerUp = !!destination && !!route && navMode === "preview" && !previewCollapsed;
  const navBarUp = navMode === "turn-by-turn" && tbt.active;
  // Coordinate of the upcoming corner (current step's end) for the locked turn
  // arrow. null on the final/arrival leg so no arrow sits on the destination.
  const maneuverCoord = (() => {
    const steps = activeRoute?.steps;
    if (!tbt.active || !steps || tbt.stepIndex >= steps.length - 1) return null;
    const end = steps[tbt.stepIndex]?.end;
    return end ? { lat: end.lat, lng: end.lng } : null;
  })();
  const STEP_BAR_H = 84;
  // When the step drawer is expanded, also clear the slide-up list (DRAWER_HEIGHT)
  // so the FABs/speedo/weather sit ABOVE it instead of behind it.
  const stepDrawerH = STEP_BAR_H + (stepsExpanded ? DRAWER_HEIGHT : 0);
  const controlsBottom = (bannerUp
    ? TAB_BAR_H + previewBannerH + 12
    : navBarUp
    ? TAB_BAR_H + stepDrawerH + 12
    : TAB_BAR_H + 8) + navInset;
  const weatherBottom = controlsBottom + 68;

  // Mapbox is the only map engine now (the legacy react-native-maps ConvoyMap was
  // retired). Kept as `MapEngine` so the large props block below is untouched.
  const MapEngine = ConvoyMapbox;

  // ── CAR-LIST MODE: the phone shows WRITTEN directions while a head unit navigates
  // (Jeff, 2026-08-16). The whole point is the `!carListMode &&` on <MapEngine>
  // below: unmounting the phone's Mapbox instance kills one of the two measured
  // ~60 Hz camera pumps AND the entire second GL engine — the single biggest
  // OTA-able heat lever (heat probe 2026-08-15: ~115 setCamera/s, two per-instance
  // rAF loops; ConvoyMapbox cancels its loop + bg timer on unmount, verified
  // ConvoyMapbox.tsx:1321). Everything else on this screen — GPS, nav engine, WS,
  // presence, voice — is independent of the map view and stays mounted.
  //
  // Head-unit signal per platform: iOS `carConnected` is reliable (didConnect AND
  // didDisconnect both fire). Android's carConnected traces to the library's
  // unconditional didConnect (spurious-true — see the long note above
  // noteCarConnected), so Android reads the RAW locationPrivacy latch, whose only
  // Android writer is AndroidAutoRoot's genuine session. Raw, not carAttached():
  // the 90 s Android TTL would flip the phone back to the map mid-drive. Fails
  // safe — a killed process resets the latch to false and the phone shows the map.
  // `carListMapOverride` is the driver's "Show map" escape hatch; it resets when
  // the head unit detaches or nav ends, so the next car drive starts in list mode.
  const headUnitHere = Platform.OS === "android" ? headUnitAttachedRaw() : !!carConnected;
  const carListMode = headUnitHere && navMode === "turn-by-turn" && tbt.active
    && !carListMapOverride && (activeRoute?.steps?.length ?? 0) > 0;

  return (
    <View style={styles.c}>
      {!carListMode && <MapEngine
        center={coords}
        // User-chosen route-line color (live; recolors the route core/glow/fade).
        routeColor={getRouteColor(settings)}
        // user.car_type / user.car_color come from the Garage profile (Mongo,
        // hydrated by useAuth). Pass them as carBody/carColor so the "you"
        // marker uses the same SVG silhouette + paint other drivers see.
        // The self marker draws exactly what the crew is being sent — same decision,
        // same coordinates (see src/locationPrivacy). Parked => your car's spot at 0.5
        // opacity, identical to how peers render you. That is what makes the privacy
        // contract checkable from the app instead of taken on trust.
        // Never while navigating. A light longer than the 90s hysteresis would otherwise
        // flip the marker to parked mid-drive — dimming the car and pinning it to a spot
        // you are already sitting on. During a route you are driving by definition.
        // ── ONLY PIN WHEN THE CAR IS ACTUALLY SOMEWHERE ELSE (2026-08-05) ────
        // Shipping selfParked straight off presenceParked was wrong, and it is the
        // "it's glitchy" Jeff reported after several drives. The privacy decision is
        // deliberately CONSERVATIVE about what may leave the device: isParked() is
        // "no head unit and no fix above 2.5 m/s for 90 s", and noteFix only advances
        // the car spot on fixes above that speed. Correct for a broadcast. Wrong for
        // drawing the driver's own position, because a sub-9 km/h CRAWL longer than
        // 90 s — stop-and-go, a drive-thru, a car park, a ferry queue — satisfies it
        // while the driver is still moving. The marker AND the follow camera then
        // FREEZE on the last above-9 km/h point and only jump when you clear 9 km/h
        // again: translucent car, frozen map. ConvoyMapbox:2641 already carries Jeff
        // on the previous incarnation of this exact class — "why cant it just pin
        // point where I am and stick to me? its like its lost."
        //
        // Separation is what distinguishes the two. Walked into a building: the car is
        // a block away. Crawling in traffic: metres. So require a real gap before the
        // marker stops telling the driver where they are — which preserves the case
        // Jeff asked for and kills every crawl.
        //
        // privacyHydrated: the car spot loads from disk asynchronously, so without it
        // the marker seeds at live GPS and teleports one render later.
        // ── WITNESSED PARK BEATS THE 75 m GATE (2026-08-15 night) ────────────
        // The separation gate exists only because GPS can't tell a walk-away from a
        // >90 s crawl. A head-unit DISCONNECT can: the drive provably ended at the
        // spot. So a park that ended with CarPlay/AA detaching pins the marker to the
        // car even from the couch 20 m away — "worked in build 72" was actually the
        // >75 m case; close parks never pinned until this. A crawl can't regress: no
        // disconnect happens mid-drive, and noteFix clears the flag on any driving fix
        // (the unplugged-mid-drive case).
        selfParked={
          presenceParked && navMode !== "turn-by-turn" && privacyHydrated &&
          !!presencePos && !!coords &&
          (parkEndedByHeadUnit() ||
            haversineMeters(coords, presencePos) > SELF_PIN_MIN_SEPARATION_M)
        }
        selfParkedAt={presencePos}
        user={{
          ...coords,
          // Resolve a stable heading: GPS heading when moving, inferred travel
          // bearing otherwise, last-known when stopped (never snaps to north).
          heading: bearingTrackerRef.current.get("self", coords.lat, coords.lng, coords.heading),
          carBody: ((user as any)?.car_type as string) || "sedan",
          // Car paint comes from the Garage, which persists to LOCAL settings
          // (settings.carColor) — NOT the backend user profile. Read settings
          // first so a paint change in the Garage reflects on the map
          // immediately; fall back to the backend value, then undefined.
          carColor: settings.carColor || user?.car_color || undefined,
        }}
        // Privacy: when Avatar Live is OFF we suppress the local "you" marker.
        // Presence channel is also nulled out above so peers don't see us at all.
        hideSelfMarker={getAvatarMode(settings) === "ghost"}
        // How the driver draws themselves — 3D car (default) or 3D green arrow
        // (Garage → Map Appearance). 'photo' is parked → still renders the car.
        selfMarkerType={getSelfMarkerType(settings)}
        selfClassPaint={getClassPaint(settings)}
        selfVehicleClass={getVehicleClass(settings)}
        selfArrowPaint={settings.arrowPaint}
        // Map view mode (radio choice from Settings → MAP VIEW). Drives the
        // chase-cam tilt + bearing. Defaults to "heading_up" so nav feels like
        // Waze/Google out of the box.
        mapView={northUpHold ? 'north_up' : settings.mapView}
        // Live bearing readout + north-reset signal for the Compass FAB.
        onHeading={setMapHeading}
        resetNorthSignal={northSignal}
        fitCrewSignal={crewSignal}
        // Layer controls — driven by the bottom-right Layers FAB.
        mapMode={mapMode}
        // 3D BUILDINGS ARE NOT A POWER SETTING (Jeff, 2026-08-14): "i want 3d buildings no
        // matter what in 3d view". The `powerMode === "premium"` half silently removed them
        // the moment the phone came off the charger — the driver flips no switch and the
        // world flattens. Now purely the user's own toggle.
        // 2D view forces buildings off and the camera flat, whatever the setting says —
        // a flat top-down sprite only reads correctly under a top-down camera.
        show3dBuildings={settings.show3dBuildings !== false && !view2D}
        flatView={view2D}
        peers={peerList}
        leaderUserId={leaderUserId}
        hazards={visibleHazards}
        speedCameras={speedCameras}
        roadEvents={roadEvents}
        highlightConvoy={settings.highlightConvoy}
        destination={destination}
        stops={stops}
        destWeather={destWeather}
        // While a reroute offer is up, append its line for DISPLAY (kind "offer" →
        // blue inline alternate, tappable during nav). Never lands in `routes`
        // state, so the turn engine / chips / CarPlay mirror are untouched.
        routes={displayRoutes}
        selectedRouteIndex={selectedRouteIndex}
        onSelectRoute={handleSelectRoute}
        offerPill={rerouteOffer ? { lat: rerouteOffer.divLat, lng: rerouteOffer.divLng, savedMin: rerouteOffer.savedMin, arrival: rerouteOffer.arrival } : null}
        onOfferAccept={acceptReroute}
        onOfferDismiss={declineReroute}
        // Follow-mode logic, driven by the single `isFollowing` flag (true even
        // during nav). When the driver pans the map — including mid-guidance —
        // ConvoyMap fires `onUserPan`; we drop follow so the camera stops chasing
        // and let them roam, then auto-recenter after 10s idle (or a Recenter
        // tap). startNav re-enables follow so guidance always begins centred.
        followUser={isFollowing}
        zoomOffset={zoomOffset}
        onUserPan={handleUserPan}
        // Chase-cam (3D, heading-rotated, dynamic-zoom) is on whenever turn-
        // by-turn nav is actively running. Pitch defaults to 45° in ConvoyMap.
        navigationActive={navMode === "turn-by-turn" && tbt.active}
        userSpeedMs={coords?.speed}
        // Feeds the dynamic corner zoom: ease wider on the straights, tighten in
        // as the next maneuver approaches.
        distanceToManeuverM={tbt.distanceToManeuverM}
        // The corner the turn arrow locks onto (snaps to the next when completed).
        maneuverCoord={maneuverCoord}
        // DOUBLE-TAP → DROP A PIN (native double-tap-zoom is disabled in
        // ConvoyMapbox; pinch still zooms). The "same spot" test is in SCREEN
        // pixels (sx/sy), NOT world metres — so it works identically zoomed in or
        // out (the old 150m world gate silently failed a double-tap taken while
        // zoomed out, since a few pixels there spans hundreds of metres — that was
        // the "double-tap does nothing" bug). Two taps within 500ms and ~45pt drop
        // the pin at the second tap and run the FULL destination pipeline (routes
        // fetch + Drive drawer with Start). Ignored mid-guidance.
        onMapPress={(c?: { lat: number; lng: number; sx?: number; sy?: number }) => {
          if (!c) return;
          const now = Date.now();
          const last = lastMapTapRef.current;
          lastMapTapRef.current = { t: now, lat: c.lat, lng: c.lng, sx: c.sx, sy: c.sy };
          if (!last || now - last.t > 500) return;
          // Screen-space proximity when we have pixel coords; fall back to a
          // generous world gate only if the payload lacked them.
          const near = (typeof c.sx === "number" && typeof last.sx === "number")
            ? Math.hypot((c.sx - (last.sx ?? 0)), (c.sy ?? 0) - (last.sy ?? 0)) <= 45
            : haversineMeters({ lat: last.lat, lng: last.lng }, c) <= 400;
          if (!near) return;
          lastMapTapRef.current = null; // consumed — a 3rd tap starts fresh
          // DOUBLE-TAP: drop a destination, or ADD A STOP if a trip already exists
          // (2026-07-29, Jeff: "we should also be able to tap the screen to pin and
          // add a stop as well"). With a destination already set, replacing it on a
          // double-tap was the wrong reading of the gesture anyway — you are pointing
          // at somewhere you want to GO PAST, not somewhere to go instead. This also
          // makes stops reachable MID-DRIVE, which is when you actually need one
          // (fuel, food); the old `navMode === "turn-by-turn"` bail meant the map
          // ignored the gesture exactly then. The pin-drop-as-destination path keeps
          // its guard, since silently moving the destination mid-guidance is not
          // something a stray double-tap should be able to do.
          try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch {}
          if (destination) {
            setStops((prev) => [...prev, { lat: c.lat, lng: c.lng, label: `Stop ${prev.length + 1}` }]);
            return;
          }
          if (navMode === "turn-by-turn") return;
          setDestination({ lat: c.lat, lng: c.lng, label: "Dropped pin" });
        }}
        // TAP A BASEMAP POI (restaurant, gas, park…) → the full destination
        // pipeline with the place's real name — same flow as search and pin-drop
        // (routes fetch + Drive drawer with Start; nothing auto-starts). Ignored
        // mid-guidance, same rule as pin-drop.
        onPoiPress={(poi) => {
          if (navMode === "turn-by-turn") return;
          try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
          setDestination({ lat: poi.lat, lng: poi.lng, label: poi.name });
        }}
        onMapLongPress={handleMapLongPress}
        onHazardPress={(h: any) => setSelected(h)}
        onHazardLongPress={handleHazardLongPress}
        onPeerPress={(p: any) => {
          // Open the card with the FULLY-MERGED peer (presence + /users/nearby): car
          // paint + body, PB, heading, online status — the SAME object the marker
          // renders from (which is why the pin is correctly coloured). The old code
          // rebuilt a thin object on the non-presence path, dropping carColor/
          // activeColor (card showed the default dark GRC, not the peer's real paint)
          // and topSpeed (PB showed "—"). livePeerById carries every field.
          setSelectedPeer((livePeerById.get(p.user_id) || p) as any);
        }}
        places={placePins}
        showPlacePins={settings.showPlacePins !== false}
        onPlacePress={handlePlacePinPress}
      />}
      {/* The written-directions face — see the carListMode note above. AFTER the map
          overlays in source order won't hold here (they follow below), so it relies
          on zIndex 50 to paint over every HUD chip; native modals/sheets still
          present above it. */}
      {carListMode && activeRoute && (
        <CarDriveList
          steps={activeRoute.steps}
          stepIndex={tbt.stepIndex}
          distanceToManeuverM={tbt.distanceToManeuverM}
          distanceRemainingM={tbt.distanceRemainingM}
          etaSeconds={tbt.etaSeconds}
          arrivalText={fmtClock(new Date(Date.now() + tbt.etaSeconds * 1000))}
          destinationLabel={destination?.label}
          offer={rerouteOffer ? { title: rerouteOffer.title, subtitle: rerouteOffer.subtitle } : null}
          onOfferAccept={acceptReroute}
          onOfferDismiss={declineReroute}
          onShowMap={() => setCarListMapOverride(true)}
          onEnd={endNav}
        />
      )}

      {/* Speed-limit + avatar/CarPlay diagnostics — gated by the Debug toggle in Settings. */}
      {settings.debugOverlays === true && (
      <View pointerEvents="none" style={{ position: 'absolute', top: 146, left: 8, zIndex: 9999, backgroundColor: 'rgba(0,0,0,0.6)', paddingVertical: 3, paddingHorizontal: 6, borderRadius: 6 }}>
        <Text style={{ color: '#00FF88', fontSize: 11, fontWeight: '600' }}>{`SL ${getSpeedLimitDebug()}`}</Text>
        {/* Partial-avatar / CarPlay-connection probe. Watch `car` flip Y->N when you
            UNPLUG the head unit: if it stays Y, carConnected isn't flipping (the bug).
            prk = parked mode engaged, bc = what we broadcast (live/parked), spot =
            whether a last-car location is known to pin to. */}
        <Text style={{ color: '#FFD60A', fontSize: 11, fontWeight: '600' }}>
          {`AV car=${carConnected ? 'Y' : 'N'} ${avatarMode} prk=${presenceParked ? 'Y' : 'N'} bc=${presenceStatus} spot=${lastCarLocRef.current ? 'Y' : 'N'}`}
        </Text>
      </View>
      )}

      {/* ===== Minimal top bar — Google Maps style =====
          The map extends edge-to-edge behind this. We render JUST the floating
          search-bar pill plus a tiny "live" badge anchored on top of it. No
          dark header card, no separate X button.
          Uses an absolute-positioned View with explicit safe-area paddingTop
          (instead of SafeAreaView) so the bar sits at a predictable distance
          from the dynamic island / status bar across devices, and zIndex:100
          guarantees it stays above the map's overlay markers/controls. */}
      <View style={styles.topBar} pointerEvents="box-none">
        {searchVisible && (
          <View pointerEvents="box-none">
            {/* marginRight clears the absolutely-positioned top-right logo (50 wide,
                right:12) so the search field ends just to its left. 56 leaves a tight
                ~6px gap (was 64/~14px) → more room in the search bar. Pills/overlay
                stay full-width. */}
            <View style={{ marginRight: 56 }}>
              <DestinationSearch
                origin={coords}
                onSelect={(loc) => { setDestination(loc); setShowSteps(true); setSearchVisible(false); }}
                onClear={() => { setDestination(null); setRoute(null); setShowSteps(false); setSearchVisible(true); }}
                onProfilePress={() => router.push("/(app)/hub" as any)}
                onPressField={() => setNavSearchOpen(true)}
                // Departure IQ now lives IN the bar: an "AI" pre-fill + green "Let's go".
                aiSuggest={departSuggest ? { label: `${departSuggest.reason.charAt(0).toUpperCase()}${departSuggest.reason.slice(1)}?`, eta: departSuggest.etaText } : null}
                onAiGo={() => {
                  const p = departSuggest?.place;
                  setDepartSuggest(null);
                  if (p) { setDestination({ lat: p.lat, lng: p.lng, label: p.label }); setShowSteps(true); }
                }}
                onAiDismiss={() => { setDepartSuggest(null); departHushRef.current = Date.now() + 1800000; }}
                // Category pills are hidden by default; the green icon on the right toggles them.
                pillsVisible={pillsVisible}
                onPillsToggle={() => setPillsVisible((v) => { if (v) setPlacePins([]); return !v; })}
              />
            </View>
            {/* Category quick-search pills (Gas / Food / Coffee / …) — hidden until the
                driver taps the green pills icon on the right of the search bar. */}
            {pillsVisible && (
              <CategoryPills origin={coords} onResults={setPlacePins} onSelect={handlePlacePinPress} />
            )}
            {(() => {
              // OTHER crew members only — never count the viewer. peerList already
              // excludes self (presence keys us out; WS/REST filter our own id).
              const liveCount = peerList.length;
              // Actual native build number (v66, v67, …) — reads the installed
              // binary's build, so it tracks whatever build the user is on without
              // a code change. Falls back to the app.json value if unavailable.
              // Runtime version on the pill (Jeff, 2026-07-23): the fastest way to
              // see which testers are orphaned on an old runtime (an OTA only
              // reaches exact runtime matches). Read from expo-updates (the value
              // the update system actually keys on), app.json as fallback.
              let rtv = '';
              let otaTag = '';
              try {
                const U = require('expo-updates');
                rtv = U.runtimeVersion || '';
                // Compact OTA identity: LAST 4 hex of the running update id (update ids
                // are time-ordered UUIDs, so the FIRST hex chars are near-identical
                // across updates — the tail is the discriminating part), or
                // "emb" for the embedded (factory) bundle. THE tell for "is this
                // device actually current" — today alone one runtime carried five
                // different OTAs, and the runtime string can't distinguish them
                // (a tester on a stale OTA looked 'current' by the pill and
                // reported an already-fixed bug as unfixed).
                // Tag = the update's PUBLISH TIME (day·HHMM), not its id. EAS mints a
                // SEPARATE update id per platform inside ONE publish, so iOS and
                // Android on the SAME update always showed different tags — which made
                // a perfectly in-sync Android tester look stale (2026-07-24: iOS 'b37e'
                // vs Android '6d6f', same publish). createdAt is shared by every
                // platform in a publish, so this is comparable ACROSS devices and also
                // says how old the JS is. 'emb' = still on the embedded factory bundle.
                const ts = U.createdAt ? new Date(U.createdAt) : null;
                const p2 = (n: number) => String(n).padStart(2, '0');
                otaTag = U.isEmbeddedLaunch
                  ? 'emb'
                  : (ts ? `${p2(ts.getDate())}·${p2(ts.getHours())}${p2(ts.getMinutes())}` : '');
              } catch {}
              if (!rtv) rtv = (Constants.expoConfig as any)?.runtimeVersion || '';
              const buildNo = Constants.nativeBuildVersion
                || Constants.expoConfig?.ios?.buildNumber
                || String((Constants.expoConfig as any)?.android?.versionCode ?? "");
              return (
                // Tappable (tester request): opens the who's-on roster sheet —
                // every live member with YOHB + Drive-to actions.
                <TouchableOpacity
                  style={styles.liveOverlay}
                  onPress={() => setRosterOpen(true)}
                  activeOpacity={0.8}
                  hitSlop={8}
                >
                  <View style={[styles.liveDotSm, { backgroundColor: liveDot }]} />
                  <Text style={styles.liveOverlayText}>{liveCount} Crew · v{buildNo}{rtv ? ` · ${rtv}` : ''}{otaTag ? ` · ${otaTag}` : ''}</Text>
                </TouchableOpacity>
              );
            })()}
            {/* Stranded-OTA escape hatch: appears the moment a newer update finishes
                downloading (expo-updates "pending" state — see UpdateReadyPill).
                Hidden mid-drive so a tap can never reload during turn-by-turn. */}
            {/* Also hidden while a HEAD UNIT is attached (2026-08-18): tapping the
                pill calls reloadAsync, which kills the whole JS context — including
                the live AA/CarPlay surface. On Android that reads as a connect crash
                and feeds AA's blocklist (the "Hairpin gone from the launcher" report).
                Update lands on the next launch after the drive instead. */}
            <UpdateReadyPill hidden={navMode === "turn-by-turn" || headUnitHere} />
            {/* PITSTOP stopwatch — sits under the crew pill in the free top-centre
                strip, clear of the bottom-left speed/weather HUD and the bottom-right
                FAB stack. Only mounts while a stop is actually confirmed, so it costs
                nothing the rest of the time. */}
            {pitstop.active && (
              <View style={styles.pitstopWrap} pointerEvents="none">
                <PitstopCard
                  kind={pitstop.kind}
                  label={pitstop.label}
                  elapsedS={pitstop.elapsedS}
                  totalS={pitstop.totalS}
                  tint={hudTint()}
                />
              </View>
            )}
          </View>
        )}
      </View>

      {/* Top-right logo — absolutely positioned at the SAME screen spot as the
          Comms/Music headers (top iOS52/Android28, right12) so it's pixel-identical
          across tabs. Rendered after topBar so it overlays and stays tappable. */}
      <View style={styles.mapLogoBacking}>
        <GlassFill tintColor={hudTint()} style={{ borderRadius: 14, overflow: "hidden" }} />
        <LogoMenu size={38} align="right" />
      </View>

      {/* ===== Community Routes — horizontal chip strip (visible when there are shared cruises) ===== */}
      {communityRoutes.length > 0 && navMode === "preview" && !destination && (
        <View style={styles.routesStripWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.routesStrip}
            testID="community-routes-strip"
          >
            {communityRoutes.map((r) => (
              <TouchableOpacity
                key={r.id}
                testID={`community-route-${r.id}`}
                onPress={() => loadCommunityRoute(r)}
                activeOpacity={0.85}
              >
                <Glass radius={14} style={styles.routeChip}>
                  <View style={styles.routeChipInner}>
                    <View style={styles.routeChipIcon}>
                      <Ionicons name="flag" size={14} color={COLORS.warning} />
                    </View>
                    <View style={{ maxWidth: 180 }}>
                      <Text style={styles.routeChipName} numberOfLines={1}>{r.name}</Text>
                      {!!r.created_by && <Text style={styles.routeChipMeta} numberOfLines={1}>by {r.created_by}</Text>}
                    </View>
                  </View>
                </Glass>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ===== "Admin shared a route" toast (auto-dismiss after 5s) ===== */}
      {routeToast && (
        <SafeAreaView edges={["top"]} pointerEvents="box-none" style={styles.routeToastWrap}>
          <Glass radius={16} style={styles.routeToast}>
            <View style={styles.routeToastRow}>
              <View style={styles.routeToastIcon}>
                <Ionicons name="megaphone" size={20} color={COLORS.warning} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.routeToastTitle}>Hairpin route shared</Text>
                <Text style={styles.routeToastSub} numberOfLines={1}>
                  {routeToast.created_by ? `${routeToast.created_by}: ` : ""}{routeToast.name}
                </Text>
              </View>
              <TouchableOpacity testID="route-toast-load" onPress={() => loadCommunityRoute(routeToast)} style={styles.routeToastBtn}>
                <Text style={styles.routeToastBtnText}>Load</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setRouteToast(null)} style={{ padding: 6 }}>
                <Ionicons name="close" size={18} color={COLORS.textDim} />
              </TouchableOpacity>
            </View>
          </Glass>
        </SafeAreaView>
      )}

      {/* Departure IQ now renders INSIDE the search bar (DestinationSearch aiSuggest)
          instead of a separate banner — see the topBar above. */}

      {/* Old collapsed "trip-summary" pill removed — it sat where the new
          turn-by-turn UI belongs and blocked it from showing. Driving off now
          auto-starts turn-by-turn (see navAutoStartedRef effect above). */}

      {/* ===== Route preview banner — "Drive" header, trip summary, Start ===== */}
      {destination && route && navMode === "preview" && !previewCollapsed && (() => {
        const ar = activeRoute;
        // Is this destination already a saved place (within ~160 m)? Drives the
        // bookmark icon's filled/outline state in the header.
        const savedMatch = savedPlaces.find((p) => distanceKm(p.lat, p.lng, destination.lat, destination.lng) <= 0.16);
        const durSec = ar?.duration_in_traffic_s ?? ar?.duration_s ?? 0;
        const durMin = Math.max(1, Math.round(durSec / 60));
        // Big trip-time readout: hours + minutes for trips >= 1h (e.g. "1h 23m"), else
        // the plain minute count with a "min" unit beneath. Keeps the new routes' times
        // consistent with the chips + on-map pills.
        const durHrs = Math.floor(durMin / 60);
        const durBig = durHrs >= 1 ? `${durHrs}h ${durMin % 60}m` : `${durMin}`;
        const arriveStr = fmtClock(new Date(Date.now() + durSec * 1000));
        const distStr = ar?.distance_text ?? route.distance_text;
        // ===== Route options (Best / Scenic / AI) — chip selector. =====
        // Best = fastest (index 0, user color). Scenic = the first alternate (auto-contrasting
        // color). AI = a learned habitual route tagged kind:"ai" (P3) — until then a disabled
        // "Learning…" stub. Tapping a chip selects that route; the summary above updates.
        const userColor = getRouteColor(settings);
        const scenicColor = contrastingRouteColor(userColor);
        const aiIdx = routes.findIndex((r: any) => r?.kind === "ai");
        // Per-route ETA — use the route's pre-formatted duration (formatDuration →
        // hours/min, e.g. "1h 23m" / "45 min"), not a raw minute count, so long trips
        // read as hours + minutes.
        const fmtChipDur = (r: NavRoute | null | undefined) =>
          r ? (r.duration_in_traffic_text || r.duration_text || null) : null;
        const routeChips: { key: string; label: string; idx: number; color: string; sub: string | null; disabled?: boolean }[] = [
          { key: "best", label: "Best", idx: 0, color: userColor, sub: fmtChipDur(routes[0]) },
        ];
        if (routes[1] && aiIdx !== 1) routeChips.push({ key: "scenic", label: "Scenic", idx: 1, color: scenicColor, sub: fmtChipDur(routes[1]) });
        // AI chip: a real learned route if we have one; otherwise a disabled "Learning…"
        // stub ONLY when the destination is a saved place (so it's discoverable that
        // Convoy will learn this trip), hidden for one-off destinations.
        if (aiIdx >= 0) routeChips.push({ key: "ai", label: (routes[aiIdx] as any)?.cruise ? "Cruise" : "AI", idx: aiIdx, color: userColor, sub: fmtChipDur(routes[aiIdx]) });
        else if (savedMatch) routeChips.push({ key: "ai", label: "AI", idx: -1, color: "#9AA0A6", sub: "Learning…", disabled: true });
        // Green summary label — NAME the selected route by its kind ("Best route" /
        // "Scenic route" / "AI route") so it mirrors the chip you picked, falling back to
        // the via-street summary for any unnamed alternate.
        const selChip = routeChips.find((c) => c.idx === selectedRouteIndex);
        const bestLabel =
          selChip?.key === "best" ? "Best route"
          : selChip?.key === "scenic" ? "Scenic route"
          : selChip?.key === "ai" ? ((ar as any)?.cruise ? "Cruise route" : "AI route")
          : ar?.summary ? `via ${ar.summary}` : "Alternate";
        return (
          <View style={[styles.routeSheet, { bottom: TAB_BAR_H + navInset }]} onLayout={(e) => setPreviewBannerH(e.nativeEvent.layout.height)}>
            {/* Liquid Glass behind the drive sheet, clipped to the rounded top. */}
            <GlassFill tintColor={drawerTint()} style={{ borderTopLeftRadius: 22, borderTopRightRadius: 22, overflow: "hidden" }} />
            {/* Grabber — swipe down to collapse to the trip pill. */}
            <View {...sheetPan.panHandlers}>
              <View style={styles.sheetGrabber} />
            </View>

            {/* Header — Drive (yellow) · share to community · close */}
            <View style={styles.bannerHeader}>
              <Text style={styles.bannerDrive}>Drive</Text>
              <View style={styles.bannerHeaderRight}>
                <TouchableOpacity testID="save-destination" onPress={() => { if (savedMatch) { void removeSavedPlace(savedMatch.id); try { Haptics.selectionAsync(); } catch {} } else { saveCurrentDestination(); } }} hitSlop={10}>
                  <Ionicons name={savedMatch ? "bookmark" : "bookmark-outline"} size={21} color={savedMatch ? "#2DEC86" : "#EBEBF5"} />
                </TouchableOpacity>
                <TouchableOpacity testID="share-route" onPress={() => { Haptics.selectionAsync().catch(() => {}); setRouteShareOpen(true); }} hitSlop={10}>
                  <Ionicons name="share-outline" size={22} color="#EBEBF5" />
                </TouchableOpacity>
                <TouchableOpacity testID="route-clear" onPress={clearRoute} hitSlop={10}>
                  <Ionicons name="close" size={24} color="#EBEBF5" />
                </TouchableOpacity>
              </View>
            </View>

            {/* Shared-route credit — who sent it + when. Shown only when this
                destination arrived from a crew member's share. The route itself
                is computed from THIS member's own GPS (the destination→routes
                effect), so it's their route to the sharer's destination. */}
            {sharedRouteMeta &&
              Math.abs(destination.lat - sharedRouteMeta.lat) < 1e-6 &&
              Math.abs(destination.lng - sharedRouteMeta.lng) < 1e-6 && (
                <View style={styles.sharedByRow}>
                  <Ionicons name="share-social" size={14} color="#2DEC86" />
                  <Text style={styles.sharedByText} numberOfLines={1}>
                    Shared by {sharedRouteMeta.handle || "a member"}
                    {sharedRouteMeta.at ? ` · ${shareRelTime(sharedRouteMeta.at)}` : ""} · from your location — press Start
                  </Text>
                </View>
              )}

            <View style={styles.bannerDivider} />

            {/* ── STOPS ── Interior waypoints in travel order. Tap a name to rename it
                ("Stop 1" is useless on a road trip; "Tim's in Hope" is not), × removes.
                Editing either re-runs the route effect through the new via list. */}
            {stops.length > 0 && (
              <View style={styles.stopList}>
                {stops.map((st, i) => (
                  <View key={`${st.lat},${st.lng},${i}`} style={styles.stopRow}>
                    <View style={styles.stopDot}><Text style={styles.stopDotText}>{i + 1}</Text></View>
                    <TouchableOpacity
                      style={{ flex: 1, minWidth: 0 }}
                      onPress={() => setRenameStop({ lat: st.lat, lng: st.lng, name: st.label })}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.stopLabel} numberOfLines={1}>{st.label}</Text>
                      <Text style={styles.stopHint}>Tap to rename</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => { Haptics.selectionAsync().catch(() => {}); setStops((p) => p.filter((_, k) => k !== i)); }}
                      hitSlop={10}
                      testID={`stop-remove-${i}`}
                    >
                      <Ionicons name="close-circle" size={20} color="#8E8E93" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {/* Route options — Best / Scenic / AI. Tap to select; summary below updates. */}
            <View style={styles.routeOptChips}>
              {routeChips.map((c) => {
                const active = c.idx === selectedRouteIndex && !c.disabled;
                return (
                  <TouchableOpacity
                    key={c.key}
                    testID={`route-chip-${c.key}`}
                    activeOpacity={0.85}
                    onPress={() => {
                      Haptics.selectionAsync().catch(() => {});
                      if (c.disabled) {
                        // The AI route only appears once Convoy has learned your habitual
                        // path to this saved place — explain that instead of a dead tap.
                        showInfoToast("AI route learns your usual way here — drive it a few times and it'll appear automatically.");
                      } else {
                        handleSelectRoute(c.idx);
                      }
                    }}
                    style={[styles.routeOptChip, active && styles.routeOptChipActive, c.disabled && styles.routeOptChipDisabled]}
                  >
                    <View style={[
                      styles.routeOptChipSwatch,
                      c.key === "ai"
                        ? { backgroundColor: "#000", borderColor: c.disabled ? "#5A5A5E" : userColor, borderWidth: 2 }
                        : { backgroundColor: c.color },
                    ]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.routeOptChipLabel, active && styles.routeOptChipLabelActive]} numberOfLines={1}>{c.label}</Text>
                      {c.sub ? <Text style={styles.routeOptChipSub} numberOfLines={1}>{c.sub}</Text> : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Summary — duration · arrive time · distance · best-route label */}
            <View style={styles.bannerSummary}>
              <View style={styles.bannerDurCol}>
                <Text style={styles.bannerDurNum}>{durBig}</Text>
                {durHrs < 1 && <Text style={styles.bannerDurUnit}>min</Text>}
              </View>
              <View>
                <View style={styles.bannerArriveRow}>
                  <Text style={styles.bannerArriveLabel}>Arrive</Text>
                  <Text style={styles.bannerArriveTime}>{arriveStr}</Text>
                </View>
                <Text style={styles.bannerDist}>{distStr}</Text>
              </View>
              <Text style={styles.bannerBest}>{bestLabel}</Text>
            </View>

            {/* Pills — Start (yellow). Add stops + Saved designed but hidden. */}
            <View style={styles.bannerPills}>
              <TouchableOpacity testID="start-nav" onPress={startNav} style={[styles.bannerPill, styles.bannerPillStart]} activeOpacity={0.9}>
                <Ionicons name="navigate" size={18} color="#1C1C1E" />
                <Text style={styles.bannerPillStartText}>Start</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.bannerPill, styles.bannerPillBlue]}
                activeOpacity={0.9}
                testID="add-stops"
                onPress={() => { Haptics.selectionAsync().catch(() => {}); setStopPickerOpen(true); }}
              >
                <Ionicons name="add-circle-outline" size={18} color="#fff" />
                <Text style={styles.bannerPillBlueText}>{stops.length ? "Add another" : "Add stop"}</Text>
              </TouchableOpacity>
              {/* SHARE THE PLOTTED ROUTE TO THE CLUB (2026-07-30).
                  The whole feature existed EXCEPT this button: the ShareSheet was
                  mounted below with a correct kind:"route" payload, the sheet already
                  pulls the club roster (GET /communities/{id}) with multi-select, the
                  push goes through /notifications/share, and the receiving half —
                  ShareToast -> shareInbox.setRoute -> applyPendingRoute — plots it and
                  credits the sharer. But setRouteShareOpen was never called from
                  anywhere, so there was no way in. One pill closes it.
                  Disabled until a destination exists, since the payload needs one. */}
              <TouchableOpacity
                style={[styles.bannerPill, styles.bannerPillBlue, !destination && { opacity: 0.5 }]}
                activeOpacity={0.9}
                testID="share-route"
                disabled={!destination}
                onPress={() => { Haptics.selectionAsync().catch(() => {}); setRouteShareOpen(true); }}
              >
                <Ionicons name="share-outline" size={18} color="#fff" />
                <Text style={styles.bannerPillBlueText}>Share</Text>
              </TouchableOpacity>
              {SHOW_EXTRA_ROUTE_PILLS && (
                <>
                  <TouchableOpacity style={[styles.bannerPill, styles.bannerPillBlue]} activeOpacity={0.9} testID="saved-routes">
                    <Ionicons name="bookmark" size={18} color="#fff" />
                    <Text style={styles.bannerPillBlueText}>Saved</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>
        );
      })()}

      {/* ===== Turn-by-turn overlays — Google-Maps-style =====
          Top maneuver banner (always visible) + bottom ETA bar, rendered by
          TurnByTurnNav. All values come from the `tbt` engine. Replaced the
          old right-edge pull-tab drawer.
          !carListMode: the banner painted OVER the car-list face (Say Phin's 10:56
          screenshot — its z-order beats the list's). In list mode the current step
          is already the highlighted row, so the banner is pure duplication there.
          Jeff: "nothing should change when the phone map is active." */}
      {!carListMode && navMode === "turn-by-turn" && activeRoute && tbt.active && (() => {
        const stepIdx = Math.min(tbt.stepIndex + 1, activeRoute.steps.length - 1);
        const upcoming = activeRoute.steps[stepIdx];
        const verb = maneuverVerb(upcoming?.maneuver);
        const instruction = upcoming?.html ? upcoming.html : verb;
        return (
          <TurnByTurnNav
            maneuverIcon={maneuverIcon(upcoming?.maneuver, upcoming?.html)}
            maneuverKey={upcoming?.maneuver}
            distanceToTurn={fmtManeuverDist(tbt.distanceToManeuverM)}
            instruction={instruction}
            eta={fmtEtaSec(tbt.etaSeconds)}
            distanceRemaining={fmtDistanceM(tbt.distanceRemainingM)}
            arrival={fmtClock(new Date(Date.now() + tbt.etaSeconds * 1000))}
            muted={navMuted}
            onToggleMute={() => setNavMuted((m) => { const nv = !m; void updateGlobalSettings({ novaMuted: nv }); return nv; })}
            onEnd={endNav}
          />
        );
      })()}

      {selected && !destination && (
        <Glass radius={20} style={styles.selectedCard}>
          <View style={styles.selRow}>
            <View style={styles.hazardImgWrap}>
              <HazardKindIcon kind={selected.kind} size={46} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.selTitle}>{selected.kind.charAt(0).toUpperCase() + selected.kind.slice(1)}</Text>
              <Text style={styles.selSub}>by {selected.reporter_handle || "anon"}</Text>
              <View style={styles.selStatsRow}>
                <View style={styles.statChip}>
                  <Ionicons name="thumbs-up" size={11} color={COLORS.success} />
                  <Text style={[styles.statChipText, { color: COLORS.success }]}>{selected.confirms || 1}</Text>
                </View>
                <View style={styles.statChip}>
                  <Ionicons name="thumbs-down" size={11} color={COLORS.danger} />
                  <Text style={[styles.statChipText, { color: COLORS.danger }]}>{selected.disputes || 0}</Text>
                </View>
              </View>
            </View>
            <TouchableOpacity onPress={() => setSelected(null)} style={{ padding: 6 }}>
              <Ionicons name="close" size={20} color={COLORS.textDim} />
            </TouchableOpacity>
          </View>
          <View style={styles.selBtnRow}>
            {(!!user?.handle && selected.reporter_handle === user.handle) ? (
              // Your own pin: tap -> Remove (with a native confirm inside
              // handleHazardLongPress). This is the "tap to delete on
              // confirmation" flow for the driver who placed it.
              <TouchableOpacity testID={`remove-${selected.id}`} onPress={() => handleHazardLongPress(selected)} style={[styles.voteBtn, styles.voteBtnDispute, { flex: 1 }]} activeOpacity={0.85}>
                <Ionicons name="trash" size={16} color="#fff" />
                <Text style={styles.voteBtnText}>Remove my alert</Text>
              </TouchableOpacity>
            ) : (
              // Someone else's pin: cast a crowd vote. Two "Gone" votes from
              // distinct drivers removes it for everyone.
              <>
                <TouchableOpacity testID={`dispute-${selected.id}`} onPress={() => disputeHazard(selected)} style={[styles.voteBtn, styles.voteBtnDispute]} activeOpacity={0.85}>
                  <Ionicons name="thumbs-down" size={16} color="#fff" />
                  <Text style={styles.voteBtnText}>Gone</Text>
                </TouchableOpacity>
                <TouchableOpacity testID={`confirm-${selected.id}`} onPress={() => confirmHazard(selected)} style={[styles.voteBtn, styles.voteBtnConfirm]} activeOpacity={0.85}>
                  <Ionicons name="thumbs-up" size={16} color="#fff" />
                  <Text style={styles.voteBtnText}>Still there</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </Glass>
      )}

      {/* ===== Pass-by "still there?" prompt =====
          One-time card shown when we pass within ~120m of another driver's
          alert. "Gone" casts a dispute vote (2 distinct votes removes the pin
          for everyone); "Still there" confirms it. Auto-dismisses after 15s.
          Gated on !selected so it never stacks on the tapped-pin card. */}
      {passPrompt && !selected && (
        <Glass radius={20} style={styles.selectedCard}>
          <View style={styles.selRow}>
            <View style={styles.hazardImgWrap}>
              <HazardKindIcon kind={passPrompt.kind} size={46} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.selTitle}>
                {passPrompt.kind.charAt(0).toUpperCase() + passPrompt.kind.slice(1)} ahead — still there?
              </Text>
              <Text style={styles.selSub}>Help your convoy keep alerts accurate</Text>
            </View>
            <TouchableOpacity onPress={() => setPassPrompt(null)} style={{ padding: 6 }}>
              <Ionicons name="close" size={20} color={COLORS.textDim} />
            </TouchableOpacity>
          </View>
          <View style={styles.selBtnRow}>
            <TouchableOpacity testID={`pass-gone-${passPrompt.id}`} onPress={() => disputeHazard(passPrompt)} style={[styles.voteBtn, styles.voteBtnDispute]} activeOpacity={0.85}>
              <Ionicons name="close-circle" size={16} color="#fff" />
              <Text style={styles.voteBtnText}>Gone</Text>
            </TouchableOpacity>
            <TouchableOpacity testID={`pass-stillthere-${passPrompt.id}`} onPress={() => confirmHazard(passPrompt)} style={[styles.voteBtn, styles.voteBtnConfirm]} activeOpacity={0.85}>
              <Ionicons name="checkmark-circle" size={16} color="#fff" />
              <Text style={styles.voteBtnText}>Still there</Text>
            </TouchableOpacity>
          </View>
        </Glass>
      )}

      {/* ---- HazardDrawer removed in the Google-Maps-style cleanup ----
          Active alerts (police, hazards, Waze) are now surfaced via the
          unified Alerts FAB on the bottom-right. Reporting still works via
          voice commands ("report police", "report accident", etc.); a Report
          UI affordance can be added back to the Alerts sheet if needed. */}

      {/* ===== Speedometer HUD (bottom-left glass overlay) =====
          Pulls live speed from coords.speed (m/s) → km/h. Floors small values
          to 0 so a stationary GPS jitter doesn't read "1 km/h". */}
      {/* Hidden in car-list mode (Jeff, off the 10:56 screenshot) — the speedo and
          weather chips floated over the step list's rows. Map mode unchanged. */}
      {!carListMode && <SpeedPill speedMs={coords?.speed} unit={settings.speedUnit} bottom={controlsBottom} limitKmh={speedLimitKmh} />}
      {/* Now-playing banner — beside the speedo, shifts right when the speed-limit
          sign slides out, ends before the police FAB. Shows only when music plays. */}
      <MapNowPlaying
        bottom={controlsBottom}
        shifted={((coords?.speed ?? 0) * 3.6) > 0.5 && (speedLimitKmh ?? 0) > 0}
        onOpen={() => router.push("/(app)/music")}
      />
      {/* Weather HUD — compact temp-only chip stacked just above the speedometer
          in the bottom-left HUD column (matches the speedo's box + opacity). */}
      {!carListMode && showWeatherLayer && weather && (
        <View style={{ position: 'absolute', bottom: weatherBottom, left: 12, zIndex: 70 }}>
          <WeatherHUD weather={weather} unit={settings.speedUnit} compact forecast={dailyForecast} onOpenChange={setWeatherForecastOpen} />
        </View>
      )}

{/* The "Crew" pill above the weather chip was REMOVED 2026-07-23 — the crew
          overview now lives in the round FAB stack (bottom-right), replacing police. */}

      {/* ===== Avatar visibility panel (hold the Map tab to open) =====
          Bottom-left card with Full / Partial / Ghost rows in the same green-dot
          radio style as Settings. Tap a row → setAvatarMode + reset the 5s auto-
          dismiss. The weather chip shifts right and the zoom buttons lift up
          (above) so this owns the bottom-left while open. */}
      {avatarPanelOpen && (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => setAvatarPanelOpen(false)}
        />
      )}
      {avatarPanelOpen && (
        <View style={[styles.avatarPanel, { bottom: weatherBottom + 64 }]}>
          <GlassFill tintColor={drawerTint()} style={StyleSheet.absoluteFill} />
          <Text style={styles.avatarPanelTitle}>Avatar</Text>
          {([
            // Copy must match settings/privacy.tsx. The retired "Full: always visible"
            // / "Partial: only while connected" pair promised a difference that never
            // existed in code — avatarMode was only ever tested for === "ghost".
            { key: "visible", label: "Visible", sub: "Your car is on the crew map" },
            { key: "ghost", label: "Ghost", sub: "Hidden — you don't appear to anyone" },
          ] as const).map((m) => {
            const active = getAvatarMode(settings) === m.key;
            return (
              <TouchableOpacity key={m.key} style={styles.avatarRow} activeOpacity={0.7}
                onPress={() => { void setAvatarMode(m.key); armAvatarPanelDismiss(); }}>
                <Ionicons name={active ? "radio-button-on" : "radio-button-off"} size={20} color={active ? "#2DEC86" : "#808080"} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={styles.avatarRowLabel}>{m.label}</Text>
                  <Text style={styles.avatarRowSub}>{m.sub}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      <PeerModal
        peer={selectedPeer ? { ...selectedPeer } as any : null}
        visible={!!selectedPeer}
        onClose={() => setSelectedPeer(null)}
        myCoords={coords}
        myTopSpeed={Math.max(user?.top_speed_record || 0, sessionMaxSpeed)}
        onDriveTo={selectedPeer && typeof selectedPeer.lat === "number" && typeof selectedPeer.lng === "number" ? () => {
          // Tester request: "click on someone on the map and have the map guide
          // me to them" — same flow as picking a search result: destination set
          // to the peer's live position, route drawer with Start slides up.
          const p = selectedPeer;
          setSelectedPeer(null);
          setDestination({ lat: p.lat, lng: p.lng, label: p.handle || "Driver" });
          setShowSteps(true);
        } : undefined}
      />

      {/* Who's-on roster (tap the "N live" pill): every live convoy member,
          nearest first, with YOHB + Drive-to actions per row. */}
      <LiveRosterSheet
        visible={rosterOpen}
        onClose={() => setRosterOpen(false)}
        peers={peerList}
        myCoords={coords}
        onDriveTo={(p) => {
          setRosterOpen(false);
          setDestination({ lat: p.lat, lng: p.lng, label: p.handle || "Driver" });
          setShowSteps(true);
        }}
      />

      {/* (The RerouteCard modal is gone — the mid-drive offer now draws INLINE on
          the map: blue alternate line + tappable "Save X min" pill at the split.
          Detection/voice unchanged; see the proactive-reroute block above.) */}

      {/* Share the current destination to specific community members (push +
          in-app toast via /notifications/share — no Supabase needed). */}
      <ShareSheet
        visible={routeShareOpen}
        onClose={() => setRouteShareOpen(false)}
        share={
          destination
            ? {
                kind: "route",
                name: destination.label,
                dest_label: destination.label,
                dest_lat: destination.lat,
                dest_lng: destination.lng,
                polyline: (activeRoute as any)?.polyline,
              }
            : null
        }
      />

      {/* ===== Bottom-right floating cluster — Layers + Directions =====
          Layers FAB (top) opens a bottom sheet with map type & overlay
          toggles. Directions FAB (bottom) opens the search bar (mirrors
          Google Maps' teal turn-arrow FAB). Both are anchored above the
          tab bar with explicit bottom-right margins so they never collide
          with the speedometer HUD on the left. */}
      {/* Layers / map-settings button - native Google position: top-right,
          just under the search bar. Opens the layers + settings sheet. Hidden
          during turn-by-turn so it never crowds the maneuver banner. */}
      {/* Top-right Layers FAB removed — map layers now live in the Convoy menu
          (tap the logo in the search bar → "Map Layers"). */}

      <View pointerEvents="box-none" style={[styles.fabStack, { bottom: controlsBottom }]}>
        {/* ORDER: Crew on TOP, compass BELOW — this stack is deliberately ordered to
            match the CarPlay map buttons, whose array is [car-crew, car-compass]
            (carActions.ts CAR_MAP_BUTTON_CONFIG). The phone used to be compass-first,
            so the two surfaces read as swapped on a head unit (Jeff, 2026-07-26).
            NOTE this is the ONE place the usual "CarPlay matches the phone" rule runs
            the other way — CarPlay's order is fixed by the template, so the phone moved.
            If you reorder either surface, reorder BOTH. */}
        {/* 2D / 3D VIEW TOGGLE (Jeff, 2026-08-14) — sits directly ABOVE Crew, exactly
            where he asked for it. Pure VIEW switch: the route line stays drawn and
            guidance keeps running; only the camera pitch and the marker art change.
            Resets to 3D when the drive ends (endNav -> resetMapView2D), so a 2D choice
            lasts exactly as long as the drive. The glyph shows what you GET if you press,
            which is the convention for a view switch — cube while flat, flat while 3D. */}
        {/* ONLY WHILE ROUTING (Jeff, 2026-08-18): idle is pinned to the 2D sprite view,
            3D exists only during a drive — so the toggle has nothing to do when no
            route is running and would only offer a rule-breaking idle 3D. */}
        {navMode === "turn-by-turn" && (
        <TouchableOpacity
          testID="view-2d-3d-fab"
          style={[styles.fab, styles.fabPolice]}
          onPress={() => {
            try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
            toggleMapView2D();
          }}
          activeOpacity={0.8}
        >
          <GlassFill tintColor={hudTint()} style={{ borderRadius: 30, overflow: "hidden" }} />
          {/* TEXT ONLY — no glyph (Jeff, 2026-08-15: "remove the square in the button on
              the phone and just make it 2D when 3D is active and vice versa"). The label
              already showed what you GET rather than what you are in, which is the
              convention for a view switch, so only the icon comes out. */}
          <Text style={styles.fabViewLabel}>{view2D ? "3D" : "2D"}</Text>
        </TouchableOpacity>
        )}
        {/* Crew button (replaced the police FAB, 2026-07-23 — Jeff's call): one tap
            frames self + every live/partial peer in a north-up overview. Same round
            glass FAB as the compass below it. Police reporting still lives in voice
            ("report police"), the Report sheet, and the hazard long-press. */}
        <TouchableOpacity
          testID="crew-fit-fab"
          style={[styles.fab, styles.fabPolice]}
          onPress={() => {
            try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
            // Drop follow like a finger pan (arms the 20s auto-recenter) so the
            // overview holds instead of the chase cam snapping straight back.
            handleUserPan();
            setCrewSignal((n) => n + 1);
          }}
          activeOpacity={0.8}
        >
          <GlassFill tintColor={hudTint()} style={{ borderRadius: 30, overflow: "hidden" }} />
          {/* Brand-green people glyph over a white "Crew" label (Jeff, 2026-07-25).
              The CarPlay crew map button uses the SAME green — see CAR_ICON_CREW. */}
          <Ionicons name="people" size={26} color={COLORS.brand} />
          <Text style={styles.fabCrewLabel}>Crew</Text>
        </TouchableOpacity>
        {/* Compass — bottom of stack. The needle rotates opposite the live map
            bearing so North always points north as the map turns; tapping it
            snaps back to the car (recenter) AND faces the map north (heading 0). */}
        <TouchableOpacity
          testID="compass-fab"
          style={styles.fab}
          onPress={() => { setNorthUpHold(true); setNorthSignal((n) => n + 1); recenterNow(); }}
          activeOpacity={0.85}
        >
          <GlassFill tintColor={hudTint()} style={{ borderRadius: 30, overflow: "hidden" }} />
          <View style={{ transform: [{ rotate: `${-mapHeading}deg` }] }}>
            <CompassNeedle size={54} />
          </View>
        </TouchableOpacity>
        {/* Recenter FAB removed — recentering now lives in the compass tap
            (which both recenters on the car and faces north). */}
        {/* Bottom search/arrow FAB removed entirely — the destination search
            bar stays pinned at the top until a route is selected (then the
            guidance banner overlaps it), so a re-summon FAB isn't needed. */}
      </View>

      {/* ===== Layers bottom sheet =====
          Half-screen modal with toggle rows for Satellite, Traffic, Transit,
          Hazards, and a Waze deep-link action. Backdrop tap to dismiss. */}
      {/* ===== Layers + Settings bottom sheet =====
          Full settings panel grouped into sections: MAP LAYERS, PRIVACY,
          MAP VIEW (radio), ROUTE OPTIONS, ALERTS. Replaces the old minimal
          layers sheet. Scrollable so all sections are reachable on small
          phones, capped at 70% of screen height. Waze + external feeds
          rows removed per spec — those toggles live in the full Settings
          screen for power users. */}
      <Modal
        visible={layersOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setLayersOpen(false)}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={styles.sheetBackdrop}
          onPress={() => setLayersOpen(false)}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.sheetCard, { maxHeight: '70%' }]} onPress={() => {}}>
            <View style={styles.sheetGrip} />
            <ScrollView showsVerticalScrollIndicator={false}>
              {/* ----- MAP MODE (radio-style; writes settings.mapMode) ----- */}
              <Text style={styles.layerSectionHeader}>MAP MODE</Text>
              {([
                { key: "auto", label: "Auto", sub: "Follows the time of day" },
                { key: "satellite", label: "Satellite", sub: "Aerial imagery" },
                { key: "dawn", label: "Dawn", sub: "Soft morning light" },
                { key: "day", label: "Day", sub: "Bright daytime" },
                { key: "dusk", label: "Dusk", sub: "Warm evening light" },
                { key: "night", label: "Night", sub: "Dark 3D night map" },
              ] as const).map((m) => (
                <TouchableOpacity key={m.key} style={styles.layerRow} activeOpacity={0.7}
                  onPress={() => { void updateGlobalSettings({ mapMode: m.key }); }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.layerRowLabel}>{m.label}</Text>
                    <Text style={styles.layerRowSub}>{m.sub}</Text>
                  </View>
                  <Ionicons name={mapModeChoice === m.key ? "radio-button-on" : "radio-button-off"} size={22}
                    color={mapModeChoice === m.key ? "#2DEC86" : "#808080"} />
                </TouchableOpacity>
              ))}
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Traffic overlay</Text>
                  <Text style={styles.layerRowSub}>Live congestion colors</Text>
                </View>
                <Switch value={showTraffic} onValueChange={setShowTraffic}
                  trackColor={{ false: '#3A3A3C', true: '#2DEC86' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              {/* Weather layer */}
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Weather</Text>
                  <Text style={styles.layerRowSub}>Temperature, wind & precipitation</Text>
                </View>
                <Switch
                  value={showWeatherLayer}
                  onValueChange={(v) => { void updateSettings({ showWeatherLayer: v }); }}
                  trackColor={{ false: '#3A3A3C', true: '#2DEC86' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Hazards</Text>
                  <Text style={styles.layerRowSub}>Show community + Waze pins</Text>
                </View>
                <Switch value={showHazards} onValueChange={setShowHazards}
                  trackColor={{ false: '#3A3A3C', true: '#2DEC86' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              {/* Official BC road events (DriveBC Open511). BC-only; auto-gated by location. */}
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Road incidents</Text>
                  <Text style={styles.layerRowSub}>Official BC accidents, construction & closures (DriveBC)</Text>
                </View>
                <Switch value={settings.roadIncidents !== false}
                  onValueChange={(v) => { void updateGlobalSettings({ roadIncidents: v }); }}
                  trackColor={{ false: '#3A3A3C', true: '#2DEC86' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>

              {/* 3D Buildings (Mapbox Standard modes only). Toggle off to
                  guarantee the self-car is never hidden behind a building. */}
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>3D Buildings</Text>
                  <Text style={styles.layerRowSub}>Show buildings in 3D (may cover your car)</Text>
                </View>
                <Switch value={settings.show3dBuildings !== false}
                  onValueChange={(v) => { void updateGlobalSettings({ show3dBuildings: v }); }}
                  trackColor={{ false: '#3A3A3C', true: '#2DEC86' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>

              {/* ----- PRIVACY ----- */}
              <Text style={styles.layerSectionHeader}>PRIVACY</Text>
              {/* Avatar visibility now lives in the 3-way Avatar control (Settings
                  + the Map-tab hold panel), the single source of truth via
                  avatarMode. The old binary "Avatar Live" switch was removed here
                  so it can't desync from avatarMode. */}
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Comms Live</Text>
                  <Text style={styles.layerRowSub}>Mute push-to-talk audio</Text>
                </View>
                <Switch value={settings.commsLive !== false} onValueChange={(v) => { void updateGlobalSettings({ commsLive: v }); }}
                  trackColor={{ false: '#3A3A3C', true: '#2DEC86' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>

              {/* ----- MAP VIEW (radio, not toggle) ----- */}
              <Text style={styles.layerSectionHeader}>MAP VIEW</Text>
              {(['heading_up', 'north_up'] as const).map((mode) => (
                <TouchableOpacity
                  key={mode}
                  style={styles.layerRow}
                  activeOpacity={0.7}
                  onPress={() => updateGlobalSettings({ mapView: mode })}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.layerRowLabel}>
                      {mode === 'heading_up' ? '🧭 Heading Up (Chase Cam)' : '⬆️ North Up (Classic)'}
                    </Text>
                    <Text style={styles.layerRowSub}>
                      {mode === 'heading_up' ? '45° behind your car, rotates with you' : 'Top-down, fixed north orientation'}
                    </Text>
                  </View>
                  {settings.mapView === mode && (
                    <Ionicons name="checkmark" size={18} color="#2DEC86" />
                  )}
                </TouchableOpacity>
              ))}

              {/* ----- ROUTE OPTIONS ----- */}
              <Text style={styles.layerSectionHeader}>ROUTE OPTIONS</Text>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Avoid Tolls</Text>
                  <Text style={styles.layerRowSub}>Route around toll roads</Text>
                </View>
                <Switch value={!!settings.avoidTolls} onValueChange={(v) => { void updateGlobalSettings({ avoidTolls: v }); }}
                  trackColor={{ false: '#3A3A3C', true: '#2DEC86' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Avoid Highways</Text>
                  <Text style={styles.layerRowSub}>Prefer surface streets</Text>
                </View>
                <Switch value={!!settings.avoidHighways} onValueChange={(v) => { void updateGlobalSettings({ avoidHighways: v }); }}
                  trackColor={{ false: '#3A3A3C', true: '#2DEC86' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Avoid Ferries</Text>
                  <Text style={styles.layerRowSub}>Skip water crossings</Text>
                </View>
                <Switch value={!!settings.avoidFerries} onValueChange={(v) => { void updateGlobalSettings({ avoidFerries: v }); }}
                  trackColor={{ false: '#3A3A3C', true: '#2DEC86' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>

              {/* ----- ALERTS ----- */}
              <Text style={styles.layerSectionHeader}>ALERTS</Text>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Alert Sound</Text>
                  <Text style={styles.layerRowSub}>Chime on new hazard nearby</Text>
                </View>
                <Switch value={!!settings.alertSound} onValueChange={(v) => { void updateGlobalSettings({ alertSound: v }); }}
                  trackColor={{ false: '#3A3A3C', true: '#2DEC86' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              <View style={[styles.layerRow, { borderBottomWidth: 0 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Highlight Hairpin Reports</Text>
                  <Text style={styles.layerRowSub}>Gold border on community pins</Text>
                </View>
                <Switch value={!!settings.highlightConvoy} onValueChange={(v) => { void updateGlobalSettings({ highlightConvoy: v }); }}
                  trackColor={{ false: '#3A3A3C', true: '#2DEC86' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
            </ScrollView>
            <TouchableOpacity onPress={() => setLayersOpen(false)} style={styles.sheetClose}>
              <Text style={styles.sheetCloseText}>Done</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ===== Report confirmation toast =====
          Brief glassy pill at the bottom-center that confirms a Police or
          Hazard report was sent. Auto-dismisses after 2.5s (set by reportAlert). */}
      <ReportToast kind={alertConfirm as any} />
      {/* Music broadcast toast — shows up when the convoy admin pushes a
          track from the Music screen. Sits slightly higher than the report
          toast so they don't overlap if both fire close together. */}
      <MusicToast message={musicToast} />
      {/* Peer hail toast — bright red, pinned highest so it never gets buried
          under the music broadcast pill. Fed by `hailBus` (push + WS). */}
      <HailToast message={hailToast} />
      {/* Info toast (e.g. the still-learning AI route chip). Floated ABOVE the open
          drive drawer so it isn't hidden behind the sheet. */}
      <InfoToast message={infoToast} bottom={TAB_BAR_H + navInset + previewBannerH + 12} />

      {/* ===== Step Drawer — slide-up turn list =====
          Appears the moment a user taps a route. The active route's maneuvers
          are listed in a dark glassy panel that auto-tucks after 3s so the
          driver gets back to a clear chase-cam view. A small grab pill sits
          on the bottom edge to re-summon it; the drawer's top handle is
          draggable to dismiss with a fling.
          !carListMode: the drawer duplicated the list's own header (ETA · distance ·
          arrival) and painted over its bottom rows (10:56 screenshot). List mode has
          its own Show-map footer + top End; the drawer stays exactly as-is on the map. */}
      {!carListMode && navMode === "turn-by-turn" && activeRoute && tbt.active && (
        <StepDrawer
          ref={stepDrawerRef}
          route={activeRoute as any}
          maneuverIcon={maneuverIcon}
          eta={fmtEtaSec(tbt.etaSeconds)}
          distanceRemaining={fmtDistanceM(tbt.distanceRemainingM)}
          arrival={fmtClock(new Date(Date.now() + tbt.etaSeconds * 1000))}
          onEnd={endNav}
          onVisibilityChange={setStepsExpanded}
        />
      )}

      {/* ===== Full-screen destination search (opens on search-bar tap) ===== */}
      <NavSearchScreen
        visible={navSearchOpen}
        onClose={() => setNavSearchOpen(false)}
        origin={coords}
        members={navMembers}
        onSelectPlace={onSearchSelectPlace}
        onSelectFriend={onSearchSelectFriend}
      />

      {/* ===== ADD STOP: pick a place to pin as a waypoint ===== */}
      {/* Same full-screen search the destination uses — recents, saved places and
          autocomplete all come for free. The only difference is what we do with the
          result: append it to `stops` instead of replacing the destination. */}
      <NavSearchScreen
        visible={stopPickerOpen}
        onClose={() => setStopPickerOpen(false)}
        origin={coords}
        members={navMembers}
        onSelectPlace={(loc: any) => {
          setStopPickerOpen(false);
          if (typeof loc?.lat !== "number" || typeof loc?.lng !== "number") return;
          setStops((prev) => [...prev, { lat: loc.lat, lng: loc.lng, label: loc.label || `Stop ${prev.length + 1}` }]);
        }}
        onSelectFriend={onSearchSelectFriend}
      />

      {/* ===== Rename a stop ===== */}
      <Modal visible={!!renameStop} transparent animationType="fade" onRequestClose={() => setRenameStop(null)}>
        <TouchableOpacity activeOpacity={1} style={styles.nameModalBackdrop} onPress={() => setRenameStop(null)}>
          <TouchableOpacity activeOpacity={1} style={styles.nameModalCard} onPress={() => {}}>
            <Text style={styles.nameModalTitle}>Rename stop</Text>
            <TextInput
              value={renameStop?.name ?? ""}
              onChangeText={(t) => setRenameStop((r) => (r ? { ...r, name: t } : r))}
              placeholder="e.g. Tim's in Hope, Lunch, Fuel up"
              placeholderTextColor="#808080"
              style={styles.nameModalInput}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => {
                if (!renameStop) return;
                const nm = renameStop.name.trim();
                if (nm) setStops((p) => p.map((st) => (st.lat === renameStop.lat && st.lng === renameStop.lng ? { ...st, label: nm } : st)));
                setRenameStop(null);
              }}
            />
            <View style={styles.nameModalRow}>
              <TouchableOpacity onPress={() => setRenameStop(null)} style={[styles.nameModalBtn, styles.nameModalCancel]} activeOpacity={0.85}>
                <Text style={styles.nameModalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  if (!renameStop) return;
                  const nm = renameStop.name.trim();
                  if (nm) setStops((p) => p.map((st) => (st.lat === renameStop.lat && st.lng === renameStop.lng ? { ...st, label: nm } : st)));
                  setRenameStop(null);
                }}
                style={[styles.nameModalBtn, styles.nameModalSave, !(renameStop?.name || "").trim() && { opacity: 0.5 }]}
                activeOpacity={0.9}
                disabled={!(renameStop?.name || "").trim()}
              >
                <Text style={styles.nameModalSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ===== Name a custom saved place (cross-platform TextInput modal) ===== */}
      <Modal visible={!!savePlaceModal} transparent animationType="fade" onRequestClose={() => setSavePlaceModal(null)}>
        <TouchableOpacity activeOpacity={1} style={styles.nameModalBackdrop} onPress={() => setSavePlaceModal(null)}>
          <TouchableOpacity activeOpacity={1} style={styles.nameModalCard} onPress={() => {}}>
            <Text style={styles.nameModalTitle}>Name this place</Text>
            <TextInput
              value={savePlaceName}
              onChangeText={setSavePlaceName}
              placeholder="e.g. Gym, Mom's, Cars and Coffee"
              placeholderTextColor="#808080"
              style={styles.nameModalInput}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={commitCustomSave}
              maxLength={40}
            />
            <View style={styles.nameModalRow}>
              <TouchableOpacity onPress={() => setSavePlaceModal(null)} style={[styles.nameModalBtn, styles.nameModalCancel]} activeOpacity={0.85}>
                <Text style={styles.nameModalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={commitCustomSave} style={[styles.nameModalBtn, styles.nameModalSave, !savePlaceName.trim() && { opacity: 0.5 }]} activeOpacity={0.9} disabled={!savePlaceName.trim()}>
                <Text style={styles.nameModalSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

    </View>
  );
}

// HazardKindIcon — the SAME police.png / hazard.png marker art used on the map,
// reused inside the hazard detail card and the pass-by prompt so the icon is
// identical everywhere (continuity). Police -> police.png; everything else ->
// hazard.png. No colored circle, matching the bare-image map markers.
function HazardKindIcon({ kind, size = 44 }: { kind: string; size?: number }) {
  return (
    <Image
      source={kind === "police" ? require("../../assets/images/police.png") : require("../../assets/images/hazard.png")}
      style={{ width: size, height: size }}
      resizeMode="contain"
    />
  );
}

// Plain JS Haversine — KILOMETRES between two lat/lng (callers ×1000 for
// metres). Used by the hazard/pass-by proximity checks and the saved-place
// match, without pulling in any geo library.
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toHazard(s: SupaHazard): Hazard {
  return {
    id: s.id,
    kind: s.kind,
    lat: s.lat,
    lng: s.lng,
    reporter_handle: s.reporter_handle || "anon",
    confirms: s.confirms,
    disputes: s.disputes,
  };
}


// Community moderation: a hazard hides once it has 2 "Gone" votes. The backend
// also hard-removes at 2 distinct disputing drivers and broadcasts the removal,
// so this is mainly a client-side backstop for the brief window before that
// event arrives (and for any stale row that slips through a poll).
const isHazardVisible = (h: Hazard) => {
  return (h.disputes || 0) < 2;
};

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: "#0A1410" },
  loader: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg },


  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    // Explicit safe-area paddingTop (replaces SafeAreaView's auto inset) —
    // 52 on iOS lands the bar just below the dynamic island/notch, 28 on
    // Android clears the typical status-bar height with room to breathe.
    paddingTop: Platform.OS === 'ios' ? 52 : 28,
    paddingHorizontal: 12,
  },
  // Live-status dot inside the crew/build overlay pill (see `liveOverlay`).
  liveDotSm: { width: 5, height: 5, borderRadius: 3 },
  // Bare-image container for the hazard/police art in the detail card + pass-by
  // prompt. 48×48 keeps the card layout unchanged.
  hazardImgWrap: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },

  // ===== Google-Maps-style route preview bottom sheet =====
  // Floats just above the tab bar (bottom: TAB_BAR_H), full width, top corners
  // only. The FABs + speedo + weather lift above it via `controlsBottom`
  // (driven by the banner's measured height) so nothing sits underneath it.
  routeSheet: {
    position: "absolute", left: 0, right: 0, bottom: TAB_BAR_H,
    backgroundColor: "transparent",
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.12)",
    paddingTop: 8, paddingHorizontal: 16,
    paddingBottom: 16,
    maxHeight: "62%",
    zIndex: 30,
    ...glassLift,
  },
  sheetGrabber: { width: 38, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.22)", alignSelf: "center", marginBottom: 12 },
  // ===== Route preview banner =====
  bannerHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  bannerDrive: { color: "#2DEC86", fontSize: 22, fontWeight: "700", letterSpacing: -0.3 },
  bannerHeaderRight: { flexDirection: "row", alignItems: "center", gap: 18 },
  bannerDivider: { height: StyleSheet.hairlineWidth, backgroundColor: "rgba(255,255,255,0.14)", marginHorizontal: -16, marginBottom: 14 },
  sharedByRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: -2, marginBottom: 10 },
  sharedByText: { color: "#2DEC86", fontSize: 12.5, fontWeight: "700", flex: 1 },
  routeOptChips: { flexDirection: "row", gap: 8, marginBottom: 14 },
  routeOptChip: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" },
  routeOptChipActive: { borderColor: "#2DEC86", backgroundColor: "rgba(45,236,134,0.12)" },
  routeOptChipDisabled: { opacity: 0.5 },
  routeOptChipSwatch: { width: 14, height: 14, borderRadius: 7 },
  routeOptChipLabel: { color: "#F4F4F4", fontSize: 13, fontWeight: "700" },
  routeOptChipLabelActive: { color: "#F4F4F4" },
  routeOptChipSub: { color: "#E5E5EA", fontSize: 11, marginTop: 1, fontWeight: "600" },
  bannerSummary: { flexDirection: "row", alignItems: "flex-start", gap: 18, marginBottom: 16 },
  bannerDurCol: { alignItems: "center" },
  bannerDurNum: { color: "#F4F4F4", fontSize: 30, fontWeight: "700", letterSpacing: -0.5, lineHeight: 32 },
  bannerDurUnit: { color: "#30D158", fontSize: 13, fontWeight: "600", marginTop: 2 },
  bannerArriveRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  bannerArriveLabel: { color: "#30D158", fontSize: 13, fontWeight: "600" },
  bannerArriveTime: { color: "#F4F4F4", fontSize: 16, fontWeight: "600" },
  bannerDist: { color: "#F4F4F4", fontSize: 16, fontWeight: "600", marginTop: 14 },
  bannerBest: { color: "#30D158", fontSize: 14, fontWeight: "600", marginLeft: "auto" },
  bannerPills: { flexDirection: "row", gap: 10 },
  bannerPill: { flex: 1, height: 46, borderRadius: 23, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderWidth: 1, borderColor: "rgba(255,255,255,0.18)" },
  bannerPillStart: { backgroundColor: "#2DEC86" },
  bannerPillStartText: { color: "#1C1C1E", fontSize: 16, fontWeight: "700" },
  bannerPillBlue: { backgroundColor: "#0A84FF" },
  bannerPillBlueText: { color: "#F4F4F4", fontSize: 14, fontWeight: "600" },

  selectedCard: { position: "absolute", left: 12, right: 12, bottom: 200 },

  // Dark circular backing behind the brand logo on the MAP screen only.
  // The logo sits over live map imagery (roads/satellite), so unlike the
  // solid-dark Comms/Music headers it needs a backing to stay crisp over any
  // background. 40×40 circle mirrors the old profile-avatar footprint.
  mapLogoBacking: {
    // EXACTLY matches the search bar: same 50px size, and top === topBar.paddingTop
    // (52 iOS / 28 Android) so it shares the bar's exact top edge → perfectly centered.
    position: 'absolute', top: Platform.OS === 'ios' ? 52 : 28, right: 12, zIndex: 100,
    width: 50,
    height: 50,
    borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
    ...glassLift,
  },

  selRow: { padding: 14, flexDirection: "row", alignItems: "flex-start", gap: 12 },
  selTitle: { color: COLORS.text, fontWeight: "600", fontSize: 16 },
  selSub: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  selStatsRow: { flexDirection: "row", gap: 6, marginTop: 8 },
  statChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: StyleSheet.hairlineWidth, borderColor: COLORS.hairline,
  },
  statChipText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.2 },
  selBtnRow: { flexDirection: "row", paddingHorizontal: 12, paddingBottom: 12, gap: 10 },
  voteBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    paddingVertical: 12, borderRadius: 14,
  },
  voteBtnConfirm: { backgroundColor: COLORS.success },
  voteBtnDispute: { backgroundColor: "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: "rgba(255,69,58,0.5)" },
  voteBtnText: { color: "#F4F4F4", fontWeight: "700", fontSize: 14, letterSpacing: 0.2 },

  // Bottom-right FAB buttons. These are flex children of `fabStack` (which
  // owns the absolute positioning + vertical-column layout), so they must NOT
  // be position:absolute themselves. The old style WAS absolute at a fixed
  // bottom/right, which collapsed every button onto the same spot — the blue
  // Directions FAB landed on top of the pile and read as a stray "blue dot"
  // floating over the map (and tapping it toggled the search bar + logo).
  // Now: 48×48 rounded squares, semi-transparent dark fill, centered white icon.
  fab: {
    width: 60, height: 60,
    borderRadius: 30,
    backgroundColor: "transparent",
    alignItems: "center", justifyContent: "center",
    // No hard white stroke — the clear glass draws its own clean edge; a 1px stroke
    // on top fought it and read as an "unfinished" double edge. Shadow keeps it lifted.
    // Android: no elevation — see glassLift in src/Glass.tsx (the shadow bleeds
    // through the translucent glass as a grey halo = the "two shades" report).
    ...glassLift,
  },
  // Tiny label under the people icon in the Crew FAB (round, bottom-right stack).
  fabCrewLabel: { color: "#FFFFFF", fontSize: 9, fontWeight: "700", letterSpacing: 0.2, marginTop: -1 },
  // 2D/3D toggle label. Its own style because the glyph was removed (Jeff, 2026-08-15) —
  // the text is now the ENTIRE control, so it carries the FAB on its own at the size the
  // icon used to occupy, in brand green like every other glyph in this stack.
  fabViewLabel: { color: COLORS.brand, fontSize: 17, fontWeight: "800", letterSpacing: 0.5 },
  // Hold-to-activate Avatar panel (bottom-left). Dark card matching the other
  // map glass; green-dot radio rows mirror the Settings MAP MODE selector.
  avatarPanel: {
    position: "absolute", left: 12, zIndex: 200, width: 232,
    borderRadius: 16, paddingVertical: 8, paddingHorizontal: 12, overflow: "hidden",
    backgroundColor: "transparent",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.12)",
    ...glassLift,
  },
  avatarPanelTitle: { color: "#FFFFFF", fontSize: 13, fontWeight: "700", letterSpacing: 0.5, marginBottom: 6, marginLeft: 2 },
  avatarRow: { flexDirection: "row", alignItems: "center", paddingVertical: 7 },
  avatarRowLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  avatarRowSub: { color: "#9AA0A6", fontSize: 11, marginTop: 1 },
  // Waze-style colored report buttons - the two primary "report" actions are
  // solid color fills (no border) so they pop against the white utility
  // buttons. Blue police matches the police pin; amber matches the road pin.
  fabPolice: {},
  fabHazard: {},
  // Layers / map-settings button, native Google position (top-right, under the
  // search bar). White rounded square so it reads as a control, distinct from
  // the round action buttons in the bottom cluster.
  layersBtn: {
    position: "absolute",
    right: 12,
    top: Platform.OS === "ios" ? 116 : 92,
    width: 48, height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(28,28,30,0.92)",
    alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
    shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
    elevation: 5,
    zIndex: 50,
  },
  fabInner: { flex: 1, backgroundColor: COLORS.primary, alignItems: "center", justifyContent: "center" },



  // ---- Community Routes (admin-shared cruises) ----
  routesStripWrap: { position: "absolute", left: 0, right: 0, top: 150, zIndex: 5 },
  routesStrip: { paddingHorizontal: 12, gap: 8 },
  routeChip: { },
  routeChipInner: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  routeChipIcon: {
    width: 26, height: 26, borderRadius: 8,
    backgroundColor: COLORS.warning + "22",
    alignItems: "center", justifyContent: "center",
  },
  routeChipName: { color: COLORS.text, fontSize: 13, fontWeight: "600", letterSpacing: -0.1 },
  routeChipMeta: { color: COLORS.textDim, fontSize: 11, marginTop: 1 },
  // Toast banner when a new community route is shared
  routeToastWrap: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center", zIndex: 9999 },
  routeToast: { marginTop: 4, marginHorizontal: 12, alignSelf: "stretch" },
  routeToastRow: { flexDirection: "row", alignItems: "center", padding: 10, gap: 10 },
  routeToastIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: COLORS.warning + "22",
    alignItems: "center", justifyContent: "center",
  },
  routeToastTitle: { color: COLORS.text, fontWeight: "700", fontSize: 13, letterSpacing: 0.1 },
  routeToastSub: { color: COLORS.textDim, fontSize: 12, marginTop: 1 },
  routeToastBtn: { backgroundColor: COLORS.warning, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10 },
  routeToastBtnText: { color: "#000", fontWeight: "700", fontSize: 12, letterSpacing: 0.3 },
  // ===== Bottom-right floating FAB stack — Alerts (top) + Layers + Directions (bottom).
  // Consistent 48×48 rounded squares with semi-transparent dark fills and
  // white icons. Anchored with explicit bottom-right margins so they sit
  // above the tab bar without colliding with the speedometer HUD on the
  // bottom-left.
  fabStack: {
    position: "absolute",
    right: 12,
    bottom: 90,                  // closer to the tab bar drawer per spec
    gap: 10,                     // a touch more breathing room between buttons
    alignItems: "center",
  },
  // ===== Layers / Settings sheet =====
  // New grouped section headers + row styles. The legacy `layerRow` (icon +
  // toggle + chevron) below is left intact for any other consumers, but the
  // sheet itself now uses these layerRowLabel/Sub styles which take up the
  // text column when an inline `Switch` is the trailing element.
  layerSectionHeader: {
    color: '#808080',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 18,
    marginBottom: 6,
    paddingHorizontal: 18,
  },
  layerRowLabel: { color: '#F4F4F4', fontSize: 15, fontWeight: '500' },
  layerRowSub: { color: '#808080', fontSize: 12, marginTop: 2 },
  // Tiny live-status pill that overlays the top edge of the search bar
  // (replaces the old dark header). Green dot + "X live · Y alerts" in a
  // glassy rounded chip — subtle, glanceable, never blocks the map.
  liveOverlay: {
    alignSelf: "center", marginTop: 8,
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 9, paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: "rgba(120,120,128,0.32)",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.18)",
    zIndex: 5,
  },
  liveOverlayText: { color: "#F4F4F4", fontSize: 10, fontWeight: "600", letterSpacing: 0.2 },
  // Pitstop stopwatch, top-centre under the crew pill. Width-capped so a long place
  // name truncates instead of stretching the card across the map.
  pitstopWrap: { marginTop: 8, alignSelf: "center", width: "92%", maxWidth: 380 },
  // ── Add-stop rows in the Drive drawer ──
  stopList: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 6, gap: 6 },
  stopRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 8, paddingHorizontal: 10, borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  stopDot: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(45,236,134,0.18)",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(45,236,134,0.55)",
  },
  stopDotText: { color: "#2DEC86", fontSize: 11, fontWeight: "800" },
  stopLabel: { color: "#FFFFFF", fontSize: 14, fontWeight: "600", letterSpacing: -0.2 },
  stopHint: { color: COLORS.textDim, fontSize: 10.5, fontWeight: "600", marginTop: 1 },
  // ===== Layers bottom sheet =====
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheetCard: {
    backgroundColor: "#15171A",
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 28,
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.12)",
  },
  sheetGrip: { width: 38, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.25)", alignSelf: "center", marginBottom: 14 },
  layerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.07)',
  },
  layerIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  layerLabel: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  layerSub: { color: COLORS.textDim, fontSize: 12, marginTop: 1 },
  sheetClose: { marginTop: 14, alignSelf: "center", paddingHorizontal: 22, paddingVertical: 10, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.10)" },
  sheetCloseText: { color: COLORS.text, fontWeight: "600", fontSize: 14 },
  // Custom saved-place naming modal
  nameModalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", alignItems: "center", padding: 24 },
  nameModalCard: { width: "100%", maxWidth: 420, backgroundColor: "#15171A", borderRadius: 20, padding: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.12)" },
  nameModalTitle: { color: COLORS.text, fontSize: 17, fontWeight: "700", marginBottom: 14, letterSpacing: -0.2 },
  nameModalInput: { backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: "#F4F4F4", fontSize: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.14)" },
  nameModalRow: { flexDirection: "row", gap: 10, marginTop: 16 },
  nameModalBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  nameModalCancel: { backgroundColor: "rgba(255,255,255,0.08)" },
  nameModalCancelText: { color: COLORS.text, fontWeight: "600", fontSize: 15 },
  nameModalSave: { backgroundColor: "#2DEC86" },
  nameModalSaveText: { color: "#1C1C1E", fontWeight: "800", fontSize: 15 },
  // Alerts sheet styles
  alertItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  distPill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, backgroundColor: "rgba(118,118,128,0.35)" },
  distPillText: { color: "#F4F4F4", fontSize: 11, fontWeight: "600" },
});
