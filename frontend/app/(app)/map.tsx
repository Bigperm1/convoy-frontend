import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, Platform, Image, Animated, Modal, Linking, Switch, PanResponder, TextInput, AppState } from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { api, formatErr, wsUrl } from "../../src/api";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { useRouter, useFocusEffect } from "expo-router";
import Glass from "../../src/Glass";
import ConvoyMap, { Hazard, Peer } from "../../src/ConvoyMap";
import ConvoyMapbox from "../../src/ConvoyMapbox";
import DestinationSearch from "../../src/DestinationSearch";
import CategoryPills, { PlaceResult } from "../../src/components/CategoryPills";
import LogoMenu from "../../src/components/LogoMenu";
import { supabase, SUPABASE_ENABLED, SupaHazard } from "../../src/supabase";
import { voiceBus, geocodeQuery } from "../../src/voiceBus";
import { useCommunityRoutes, createCommunityRoute, CommunityRoute } from "../../src/communityRoutes";
import TurnByTurnNav, { SpeedPill } from "../../src/components/TurnByTurnNav";
import { ReportToast, MusicToast, HailToast } from "../../src/components/AlertToast";
import { HazardDrawer, ReportPeekTab } from "../../src/components/FloatingButtons";
import StepDrawer, { StepDrawerHandle, DRAWER_HEIGHT } from "../../src/components/StepDrawer";
import { hailBus } from "../../src/hailBus";
import { useSettings, getSettings, updateSettings, updateSettings as updateGlobalSettings, getMapMode, mapModeToLegacy } from "../../src/settings";
import { getProximityTier, setLatestTier } from "../../src/proximityAudio";
import { useConvoyPresence, ConvoyPresencePeer } from "../../src/convoyPresence";
import { BearingTracker } from "../../src/bearing";
import PeerModal from "../../src/PeerModal";
import ShareSheet from "../../src/ShareSheet";
import {
  fetchRoutes, fetchDirections, NavRoute, useTurnByTurn, maneuverVerb,
  fmtDistanceM, fmtEtaSec, stopSpeech, announce, haversineMeters,
} from "../../src/nav";
import { fetchMapboxLaneCues, pickLaneCue, type LaneCue } from "../../src/mapboxDirections";
import { useConvoyCarPlay } from "../../src/carplay/ConvoyCarPlay";
import WeatherHUD from "../../src/components/WeatherHUD";
import { useWeatherLayer, useDestinationWeather, useDailyForecast, pickForecastAt, weatherKind } from "../../src/weatherLayer";
import { useSpeedCameras } from "../../src/speedCameras";
import { useSpeedLimit } from "../../src/speedLimit";
import ConvoyLogo from "../../src/components/ConvoyLogo";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { addRecentRoute } from "../../src/recentRoutes";
import { prepareRouteGreeting, playPreparedGreeting, clearPreparedGreeting } from "../../src/novaGreeting";
import { useSavedPlaces, saveSavedPlace, removeSavedPlace, resolveTarget, ensureSavedPlacesLoaded } from "../../src/savedPlaces";
import NavSearchScreen from "../../src/NavSearchScreen";
import { CarouselMember } from "../../src/components/MemberCarousel";
import { shareInbox } from "../../src/shareInbox";
import { startNavBanner, stopNavBanner, updateNavBanner } from "../../src/navNotification";
import RerouteCard from "../../src/RerouteCard";
import { PoliceBadgeIcon } from "../../src/components/MapControlIcons";
import CompassNeedle from '../../src/components/CompassNeedle';

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
  const fromCode = (s: string): string | null => {
    if (s.includes("uturn") || s.includes("u-turn")) return "refresh";
    if (s.includes("merge")) return "git-merge";
    if (s.includes("ramp")) return "swap-horizontal";
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
  if (/\bu-?turn\b/.test(h)) return "refresh";
  if (/\bmerge\b/.test(h)) return "git-merge";
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
        status = (await Location.requestForegroundPermissionsAsync()).status;
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

// Cold-start intro overlay state. Module-level so it persists across map
// re-mounts within a single app launch — the logo cover only plays once, on a
// true cold start, not every time you tab back to the map.
let _introPlayed = false;
const LAST_LOC_KEY = "convoy:lastLoc";

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

// Spoken when the DRIVER deliberately goes a different way than the planned
// route (the off-route auto-reroute path) — playful, not a dry "recalculating".
const SPLIT_DECISION_LINES = [
  "Looks like you made a split decision. Recalculating.",
  "I hope that gamble pays off. New route coming up.",
  "Going rogue, huh? Let me catch up.",
  "Bold move. Finding you a new line.",
  "Off the beaten path — I like it. One sec.",
  "Okay, your call. Sorting you a new route.",
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
  // Cold-start intro overlay (logo on black until the first fix lands).
  const introFade = useRef(new Animated.Value(_introPlayed ? 0 : 1)).current;
  const [introVisible, setIntroVisible] = useState(!_introPlayed);

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
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [showSteps, setShowSteps] = useState(false);
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
  const encodedPolyline = activeRoute?.polyline || null;

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
  // mapMode directly; the Google/web engines use the derived mapType/mapDark.
  const mapMode = getMapMode(settings);
  const { mapType, mapDark } = mapModeToLegacy(mapMode);
  // Live map bearing (deg) reported by the engine — drives the Compass FAB's
  // needle rotation. northSignal is a monotonic counter the Compass FAB bumps to
  // ask the engine to animate back to north-up (heading 0).
  const [mapHeading, setMapHeading] = useState(0);
  const [northSignal, setNorthSignal] = useState(0);
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
  // Posted speed limit for the road you're on (OpenStreetMap maxspeed via
  // Overpass). Feeds the speedometer's over-limit pulse; null when the road has
  // no maxspeed tag, in which case the pill simply stays neutral.
  const speedLimitKmh = useSpeedLimit(coords?.lat ?? null, coords?.lng ?? null, true);

  // ===== Nova speeding alerts =====
  // Humorous nudge at ~20 km/h over the posted limit; a firmer warning at ~40
  // over. Posted limit comes from useSpeedLimit (OpenStreetMap). Honors the nav
  // mute. Each tier speaks at most once per ~45s, escalates immediately when you
  // cross into the warning tier, and re-arms only after you drop back under the
  // nudge line — so it never nags continuously. Thresholds are in km/h (per the
  // spec); the spoken amount is converted to the driver's unit.
  const SPEED_NUDGE_OVER_KMH = 20;
  const SPEED_WARN_OVER_KMH = 40;
  const speedAlertLastRef = useRef(0);
  const speedAlertTierRef = useRef<0 | 1 | 2>(0);
  const speedAlertCountRef = useRef(0);
  useEffect(() => {
    if (navMuted) return;
    if (!settings.novaSpeeding) return;
    if (!speedLimitKmh || speedLimitKmh <= 0) return;
    const kmh = (coords?.speed && coords.speed > 0) ? coords.speed * 3.6 : 0;
    if (kmh < 5) return;
    const overKmh = kmh - speedLimitKmh;
    if (overKmh < SPEED_NUDGE_OVER_KMH) { speedAlertTierRef.current = 0; return; } // sensible — re-arm
    const tier: 1 | 2 = overKmh >= SPEED_WARN_OVER_KMH ? 2 : 1;
    const now = Date.now();
    // Speak when we cross INTO a higher tier, or after the per-tier cooldown.
    if (tier <= speedAlertTierRef.current && now - speedAlertLastRef.current < 45000) return;
    const escalated = tier > speedAlertTierRef.current;
    speedAlertTierRef.current = tier;
    speedAlertLastRef.current = now;
    // Every-3rd throttle (#7): on top of the 45s-per-tier cooldown, only every
    // 3rd qualifying trigger actually speaks, so sustained speeding nags far
    // less. Crossing into a HIGHER tier (the serious-warning band) resets the
    // counter so that more urgent alert always speaks immediately rather than
    // being swallowed by the throttle.
    if (escalated) speedAlertCountRef.current = 0;
    const speak3rd = speedAlertCountRef.current % 3 === 0;
    speedAlertCountRef.current += 1;
    if (!speak3rd) return;
    const mph = settings.speedUnit === "mph";
    const overDisp = Math.max(1, Math.round(mph ? overKmh / 1.60934 : overKmh));
    const cs = (getSettings().callSign || "").trim();
    try { announce(speedingLine(tier, overDisp, cs ? `${cs}, ` : "")); } catch {}
  }, [coords?.speed, speedLimitKmh, navMuted, settings.speedUnit, settings.novaSpeeding]);

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
      const raw = await fetchRoutes(origin, destination, {
        tolls: settings.avoidTolls,
        highways: settings.avoidHighways,
        ferries: settings.avoidFerries,
      });
      if (cancelled) return;
      // Sort by traffic-aware ETA when available, else fall back to free-flow
      // duration. This mirrors what Google Maps does in its "Best route" pick.
      const sorted = [...raw].sort((a, b) => {
        const da = a.duration_in_traffic_s ?? a.duration_s ?? 0;
        const db = b.duration_in_traffic_s ?? b.duration_s ?? 0;
        return da - db;
      });
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
    })();
    return () => { cancelled = true; };
  }, [destination, settings.avoidTolls, settings.avoidHighways, settings.avoidFerries]);

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

  // Turn-by-turn engine — speaks instructions, advances steps, computes ETA / distance remaining
  const tbt = useTurnByTurn(activeRoute, coords, navMode === "turn-by-turn", {
    mute: navMuted,
    onArrive: () => {
      // The engine already spoke the (varied) arrival line. End navigation here
      // WITHOUT endNav()/stopSpeech() — that would cut the arrival line off
      // mid-word. Mirror endNav's state changes minus the speech kill; flipping
      // navMode runs the engine's teardown (clears the queue) but leaves the
      // in-flight arrival clip playing to the end.
      navAutoStartedRef.current = true;  // stay stopped until a new destination is set
      setNavMode("preview");
    },
    onOffRoute: () => {
      if (!coords || !destination) return;
      // The driver deliberately went a different way. React IMMEDIATELY with a
      // playful Nova quip (don't wait for the network fetch), then swap to the
      // recomputed route — the turn engine re-anchors to the new line (nav.ts) so
      // guidance picks it up at once.
      if (!navMuted) { try { announce(pick(SPLIT_DECISION_LINES)); } catch {} }
      fetchRoutes(coords, destination, {
        tolls: settings.avoidTolls,
        highways: settings.avoidHighways,
        ferries: settings.avoidFerries,
      }).then((res) => {
        if (res.length > 0) {
          setRoutes(res.slice(0, 2));
          setSelectedRouteIndex(0);
        }
      });
    },
  });

  // ===== Lane guidance (Mapbox) =====
  // One Directions call per navigation session fetches per-maneuver lane cues;
  // we match the upcoming Google maneuver to the nearest cue at render time and
  // show lanes only when they agree (pickLaneCue is fail-closed).
  const [laneCues, setLaneCues] = useState<LaneCue[] | null>(null);
  useEffect(() => {
    const steps = activeRoute?.steps;
    if (!(navMode === "turn-by-turn") || !steps || steps.length === 0) { setLaneCues(null); return; }
    const o = steps[0].start, d = steps[steps.length - 1].end;
    let cancelled = false;
    const ctrl = new AbortController();
    fetchMapboxLaneCues(o, d, { signal: ctrl.signal })
      .then((c) => { if (!cancelled) setLaneCues(c); })
      .catch(() => {});
    return () => { cancelled = true; ctrl.abort(); };
  }, [activeRoute, navMode]);

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
  const hazardsRef = useRef<Hazard[]>([]);
  useEffect(() => { hazardsRef.current = hazards; }, [hazards]);
  const destRef = useRef(destination);
  useEffect(() => { destRef.current = destination; }, [destination]);
  const activeRouteRef = useRef<NavRoute | null>(activeRoute);
  useEffect(() => { activeRouteRef.current = activeRoute; }, [activeRoute]);
  const navMutedRef = useRef(navMuted);
  useEffect(() => { navMutedRef.current = navMuted; }, [navMuted]);
  // Sync the mute from the persisted setting once it loads / changes elsewhere.
  useEffect(() => { setNavMuted(settings.novaMuted ?? false); }, [settings.novaMuted]);
  const rerouteBusyRef = useRef(false);        // a check is in flight
  const rerouteShowingRef = useRef(false);     // a prompt is currently up
  const rerouteSuppressUntilRef = useRef(0);   // hush window after accept/decline
  // The visual reroute offer currently on screen (mini-map card). null = none.
  const [rerouteOffer, setRerouteOffer] = useState<{ route: NavRoute; title: string; subtitle: string } | null>(null);

  const checkForFasterRoute = useCallback(async () => {
    if (!getSettings().novaMidDrive) return;
    if (rerouteBusyRef.current || rerouteShowingRef.current) return;
    const now = Date.now();
    if (now < rerouteSuppressUntilRef.current) return;
    const origin = coordsRef.current;
    const dest = destRef.current;
    const cur = activeRouteRef.current;
    if (!origin || !dest || !cur) return;
    const curEta = tbtEtaRef.current;
    if (!curEta || curEta < 240) return; // almost there — don't bother

    rerouteBusyRef.current = true;
    try {
      const s = getSettings();
      const fresh = await fetchRoutes(origin, dest, {
        tolls: s.avoidTolls, highways: s.avoidHighways, ferries: s.avoidFerries,
      });
      if (!fresh.length) return;
      // Fastest live option from where we are right now.
      const best = fresh.reduce((a, b) => (b.duration_s < a.duration_s ? b : a));
      if (best.polyline && cur.polyline && best.polyline === cur.polyline) return; // same line
      const savedSec = curEta - best.duration_s;
      const hz = nearestHazardAhead(origin, dest, hazardsRef.current);
      const bigSaving = savedSec >= 300;            // >=5 min on its own
      const hazardSaving = !!hz && savedSec >= 120;  // >=2 min + a known incident ahead
      if (!bigSaving && !hazardSaving) return;

      const mins = Math.max(1, Math.round(savedSec / 60));
      const minLabel = `${mins} ${mins === 1 ? "minute" : "minutes"}`;
      const cs = (s.callSign || "").trim();
      const hey = cs ? `Hey ${cs}, ` : "";
      const where = hz
        ? `there's ${hazardReason(hz.kind)} about ${hz.distKm} ${hz.distKm === 1 ? "kilometer" : "kilometers"} ahead`
        : "traffic is building ahead";
      const spoken = `${hey}${where}. A faster route saves about ${minLabel}. Want me to switch?`;

      rerouteShowingRef.current = true;
      if (!navMutedRef.current) { try { announce(spoken); } catch {} }
      // Show the visual reroute card (a mini-map preview of `best`) instead of a
      // plain text alert. acceptReroute / declineReroute (below) handle the tap —
      // accepting runs the SAME setRoutes([best]) swap the off-route path uses.
      setRerouteOffer({
        route: best,
        title: hz ? hazardTitle(hz.kind) : "Faster route available",
        subtitle: hz
          ? `Reported ${hazardReason(hz.kind)} ahead · saves about ${minLabel}`
          : `A faster route saves about ${minLabel} on current traffic`,
      });
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
    const offer = rerouteOffer;
    rerouteShowingRef.current = false;
    rerouteSuppressUntilRef.current = Date.now() + 120000; // settle 2 min
    setRerouteOffer(null);
    if (offer?.route) {
      setRoutes([offer.route]);     // same swap the off-route path uses
      setSelectedRouteIndex(0);
      if (!navMutedRef.current) { try { announce(pick(REROUTE_ACCEPT_LINES)); } catch {} }
    }
  };
  const declineReroute = () => {
    rerouteShowingRef.current = false;
    rerouteSuppressUntilRef.current = Date.now() + 300000; // hush 5 min
    setRerouteOffer(null);
  };

  // Drive the check on a 60s interval, only while actively navigating.
  useEffect(() => {
    if (navMode !== "turn-by-turn") return;
    rerouteShowingRef.current = false; // fresh drive starts clean
    const id = setInterval(() => { void checkForFasterRoute(); }, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navMode]);

  // System nav-notification banner — keeps the current turn on screen as a
  // heads-up notification even when Convoy is backgrounded (home/lock screen).
  // A background location task drives it. iOS works on the current build;
  // Android lights up after the next native build (permissions staged in
  // app.json). navBgActiveRef tracks whether the bg task is driving updates; if
  // it isn't (e.g. background-location permission denied), the second effect
  // drives the banner from the live foreground GPS coords instead.
  const navBgActiveRef = useRef(false);
  useEffect(() => {
    if (navMode !== "turn-by-turn" || !activeRoute) return;
    startNavBanner(activeRoute, destination?.label)
      .then((bg) => { navBgActiveRef.current = bg; })
      .catch(() => {});
    return () => { navBgActiveRef.current = false; stopNavBanner(); };
  }, [navMode, activeRoute, destination?.label]);
  useEffect(() => {
    if (navMode === "turn-by-turn" && coords && !navBgActiveRef.current) {
      updateNavBanner(coords.lat, coords.lng);
    }
  }, [coords, navMode]);

  // ---- Map follow / manual-pan + auto-recenter ----
  // The driver can pan the map freely even while moving or under guidance; after
  // 10s of no further panning the camera snaps back to centre on their car.
  const recenterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRecenterTimer = () => {
    if (recenterTimerRef.current) { clearTimeout(recenterTimerRef.current); recenterTimerRef.current = null; }
  };
  const handleUserPan = () => {
    setIsFollowing(false);            // driver took control — stop chasing
    clearRecenterTimer();
    recenterTimerRef.current = setTimeout(() => { setIsFollowing(true); }, 10000); // auto-recenter after 10s idle
  };
  const recenterNow = () => { clearRecenterTimer(); setIsFollowing(true); };
  useEffect(() => () => clearRecenterTimer(), []); // tidy on unmount
  // User map-zoom offset, driven by the +/- buttons on the left. Rides on the
  // follow zoom inside ConvoyMapbox (clamped there too). Negative = wider, positive = closer.
  const [zoomOffset, setZoomOffset] = useState(0);

  const startNav = () => {
    if (!activeRoute) return;
    navAutoStartedRef.current = true;
    // Begin guidance centred on the car (a destination pick had dropped follow to
    // frame the route options).
    clearRecenterTimer();
    setIsFollowing(true);
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
  const endNav = () => {
    stopSpeech();
    navAutoStartedRef.current = true;  // stay stopped until a new destination is set
    setNavMode("preview");
  };

  // ---- CarPlay / Android Auto mirror (Phase 1) ----
  // Mirrors the active route + live turn-by-turn state onto the car display.
  // Consumes the SAME tbt/route the phone UI uses — no second engine, no double
  // voice. Safe no-op on web and on any build without the CarPlay native module.
  useConvoyCarPlay({ route: activeRoute, tbt, user: coords, destination, peers, onEnd: endNav });
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
    setDestination(null);
    setRoutes([]);
    setRoute(null);
    setShowSteps(false);
    setNavMode("preview");
    // Also retract the step drawer so it doesn't dangle on a destination-less map.
    slideStepDrawerDown();
  };

  // ----- Saved places: long-press the map to save Home / Work -----
  const handleMapLongPress = (c: { lat: number; lng: number }) => {
    Alert.alert(
      "Save this spot",
      "Set it as a quick destination for predictions and your Nova greeting.",
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
            try { await api.post("/location", { lat, lng, speed: 0, heading: 0 }); } catch {}
          }
        }
      } catch {}
      // Last resort: only if we STILL have nothing to show seed San Francisco
      // so the map isn't blank (first launch / denied / no cache / GPS failed).
      setCoords((cur) => cur ?? { lat: 37.7749, lng: -122.4194 });
      loadPeers();
    })();
  }, []);

  // ===== Cold-start intro overlay reveal =====
  // Fade the logo cover the moment we have ANY location to show (cached / OS
  // last-known / fresh fix), or after a hard 7s cap so we never get stuck on
  // the logo. _introPlayed gates it to a single play per app launch.
  useEffect(() => {
    if (_introPlayed) return;
    const reveal = () => {
      if (_introPlayed) return;
      _introPlayed = true;
      Animated.timing(introFade, { toValue: 0, duration: 450, useNativeDriver: true })
        .start(() => setIntroVisible(false));
    };
    if (coords) { reveal(); return; }
    const t = setTimeout(reveal, 7000);
    return () => clearTimeout(t);
  }, [coords]);

  // App foreground/background state — gates battery-hungry work (the 1 Hz GPS
  // watcher and the nearby-driver poll) so it pauses while the app is in the
  // background and we're not navigating. The audio session stays active in the
  // background (for PTT + nav voice), which keeps JS timers alive — so without
  // this, GPS + polling would otherwise keep running on the home/lock screen.
  const [appActive, setAppActive] = useState(true);
  useEffect(() => {
    const s = AppState.addEventListener("change", (st) => setAppActive(st === "active"));
    return () => s.remove();
  }, []);
  // Live nav flag the watcher can read WITHOUT re-subscribing on every nav
  // start/stop (re-subscribing mid-drive would blip GPS). Only appActive flips
  // the watcher; nav state is consulted via this ref.
  const navActiveRef = useRef(false);
  useEffect(() => { navActiveRef.current = navMode === "turn-by-turn"; }, [navMode]);

  // ----- Continuous heading + position watcher -----
  // BestForNavigation accuracy + 1s tick + 0m distance gate so the speedometer
  // updates every second instead of every ~4s/8m. Battery cost is acceptable
  // for a car-enthusiast app — this is the same cadence Google Maps uses.
  // Border-detection: throttle the reverse-geocode lookup to once a minute,
  // and only if the user hasn't manually picked a unit in Settings (see
  // `settings.speedUnitManual` — set true when they tap a unit button).
  const lastUnitCheckRef = useRef<number>(0);
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
        // has its own bg-location task in navNotification.ts.)
        if (!appActive && !navActiveRef.current) return;
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 500, distanceInterval: 0 },
          (pos) => {
            const h = pos.coords.heading;
            const heading = typeof h === "number" && h >= 0 ? h : undefined;
            const sRaw = pos.coords.speed;
            const speed = typeof sRaw === "number" && sRaw >= 0 ? sRaw : 0;  // clamp negatives
            // Push to the position history buffer so we can recall where the
            // driver was 5s ago (when they tap a hazard/police report button).
            posHistoryRef.current.push({ lat: pos.coords.latitude, lng: pos.coords.longitude, ts: Date.now() });
            posHistoryRef.current = posHistoryRef.current.filter(p => Date.now() - p.ts < 30000);
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
            // Battery: while moving, publish every 1s so peers see smooth
            // movement (the 1.1.4 "1s avatar" behavior). While effectively
            // stationary (< ~2 km/h - parked, or GPS jitter), back off to one
            // post every 12s: a parked car has nothing new to broadcast, and
            // this slashes cellular-radio wakeups during meets and stops.
            const postEveryMs = speed > 0.5 ? 1000 : 12000;
            if (nowPost - lastLocPostRef.current > postEveryMs) {
              lastLocPostRef.current = nowPost;
              api.post("/location", {
                lat: pos.coords.latitude, lng: pos.coords.longitude,
                speed, heading: heading ?? 0,
              }).catch(() => {});
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
            //   * Skips entirely if the user has manually chosen a unit
            //     (settings.speedUnitManual === true).
            //   * Runs ONCE immediately (lastUnitCheckRef===0), then every
            //     60s while the watcher is active so a road-trip from BC
            //     into Washington flips KM/H → MPH within ~1 minute.
            //   * US → MPH, everywhere else (Canada/Mexico/EU/etc) → KM/H.
            //   * Reads from getSettings() (module-level, always-fresh) to
            //     avoid the stale-closure trap that the React state copy
            //     would create inside this useEffect([]).
            const liveSettings = getSettings();
            if (!liveSettings.speedUnitManual && (lastUnitCheckRef.current === 0 || now - lastUnitCheckRef.current > 60000)) {
              lastUnitCheckRef.current = now;
              const GKEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY;
              if (GKEY) {
                fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${pos.coords.latitude},${pos.coords.longitude}&result_type=country&key=${GKEY}`)
                  .then((r) => r.json())
                  .then((data) => {
                    const country = data?.results?.[0]?.address_components?.find(
                      (c: any) => c.types?.includes('country')
                    )?.short_name;
                    const detected: 'kmh' | 'mph' = country === 'US' ? 'mph' : 'kmh';
                    // Race-safety re-check: settings may have changed while
                    // the network round-trip was in flight.
                    const cur = getSettings();
                    if (!cur.speedUnitManual && detected !== cur.speedUnit) {
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
  }, [appActive]);

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
            } as Peer;
          }
        });
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
          heading: typeof heading === "number" && heading >= 0 ? heading : (coords?.heading || 0),
          speed: typeof speed === "number" && speed >= 0 ? speed : 0,
        });
        // 2. Push the new fix to the backend so /users/nearby returns us live.
        try { await api.post("/location", { lat, lng, speed: speed || 0, heading: heading || 0 }); } catch {}
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
  const presenceChannel = (settings.activeCommunityId && settings.avatarLive !== false)
    ? `convoy:community:${settings.activeCommunityId}`
    : null;

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
      // Personal best — live max-of(sessionMaxSpeed, persisted) so peers see
      // an up-to-date number even before the throttled sync fires.
      topSpeed: Math.max(user.top_speed_record || 0, sessionMaxSpeed),
    } : null,
    coords ? { lat: coords.lat, lng: coords.lng, heading: coords.heading || 0 } : null
  );
  const [selectedPeer, setSelectedPeer] = useState<ConvoyPresencePeer | null>(null);

  // ---- Community Routes (admin-shared destinations / cruises) ----
  const { routes: communityRoutes } = useCommunityRoutes(settings.activeCommunityId || null);
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
      Alert.alert("Join a community first", "Select or join a community to share routes with your crew.");
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
        name: destination.label || "Convoy cruise",
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
      } as Peer;
    });
    return Object.values(byId);
  })();
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

  // Mapbox migration (Phase 2): pick the map engine behind the settings toggle.
  // ConvoyMapbox and ConvoyMap accept identical props, so only the element type
  // changes — the props block below stays exactly the same.
  const MapEngine = settings.mapboxEngine ? ConvoyMapbox : ConvoyMap;

  return (
    <View style={styles.c}>
      <MapEngine
        center={coords}
        // user.car_type / user.car_color come from the Garage profile (Mongo,
        // hydrated by useAuth). Pass them as carBody/carColor so the "you"
        // marker uses the same SVG silhouette + paint other drivers see.
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
        hideSelfMarker={settings.avatarLive === false}
        // Map view mode (radio choice from Settings → MAP VIEW). Drives the
        // chase-cam tilt + bearing. Defaults to "heading_up" so nav feels like
        // Waze/Google out of the box.
        mapView={settings.mapView}
        // Live bearing readout + north-reset signal for the Compass FAB.
        onHeading={setMapHeading}
        resetNorthSignal={northSignal}
        // Layer controls — driven by the bottom-right Layers FAB.
        mapMode={mapMode}
        show3dBuildings={settings.show3dBuildings !== false}
        mapType={mapType}
        mapDark={mapDark}
        peers={peerList}
        leaderUserId={leaderUserId}
        hazards={visibleHazards}
        speedCameras={speedCameras}
        externalAlerts={[]}
        highlightConvoy={settings.highlightConvoy}
        destination={destination}
        destWeather={destWeather}
        encodedPolyline={encodedPolyline}
        routes={routes}
        selectedRouteIndex={selectedRouteIndex}
        onSelectRoute={handleSelectRoute}
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
        // Tap on empty map → close any open search overlay so the driver can
        // peek at the map fullscreen mid-trip without ending navigation.
        onMapPress={() => { /* search bar stays pinned until a route is selected — no auto-hide on map tap */ }}
        onMapLongPress={handleMapLongPress}
        onHazardPress={(h: any) => setSelected(h)}
        onHazardLongPress={handleHazardLongPress}
        onPeerPress={(p: any) => {
          // Find the matching presence record (freshest — has online_at, topSpeed,
          // etc.). Always preserve the peer's PB: prefer the live presence value,
          // else fall back to whatever the tapped marker carried, so the YOHB
          // card's PB never drops to "—" when we actually have the number.
          const full = presence.peers.find((pp) => pp.user_id === p.user_id);
          setSelectedPeer(
            full
              ? { ...full, topSpeed: full.topSpeed ?? p.topSpeed }
              : { user_id: p.user_id, handle: p.handle, lat: p.lat, lng: p.lng, carType: p.carType, topSpeed: p.topSpeed }
          );
        }}
        onExternalAlertPress={(a: any) => Alert.alert(`${a.type}${a.subtype ? " · " + a.subtype : ""}`, "Live alert from Convoy feed.")}
        places={placePins}
        showPlacePins={settings.showPlacePins !== false}
        onPlacePress={handlePlacePinPress}
        onRoute={setRoute}
      />

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
            {/* marginRight clears the absolutely-positioned top-right logo (54 + gap)
                so the search field ends to its left. Pills/overlay stay full-width. */}
            <View style={{ marginRight: 64 }}>
              <DestinationSearch
                origin={coords}
                onSelect={(loc) => { setDestination(loc); setShowSteps(true); setSearchVisible(false); }}
                onClear={() => { setDestination(null); setRoute(null); setShowSteps(false); setSearchVisible(true); }}
                onProfilePress={() => router.push("/(app)/hub" as any)}
                onPressField={() => setNavSearchOpen(true)}
              />
            </View>
            {/* Category quick-search pills (Gas / Food / Coffee / …) directly
                under the search bar, Google-Maps style. Results drop as pins. */}
            <CategoryPills origin={coords} onResults={setPlacePins} onSelect={handlePlacePinPress} />
            {(() => {
              const selfLive = settings.avatarLive !== false && !!settings.activeCommunityId ? 1 : 0;
              const liveCount = selfLive + peerList.length;
              return (
                <View style={styles.liveOverlay} pointerEvents="none">
                  <View style={[styles.liveDotSm, { backgroundColor: liveDot }]} />
                  <Text style={styles.liveOverlayText}>{liveCount} live · {visibleHazards.length} alerts · v3</Text>
                </View>
              );
            })()}
          </View>
        )}
      </View>

      {/* Top-right logo — absolutely positioned at the SAME screen spot as the
          Comms/Music headers (top iOS52/Android28, right12) so it's pixel-identical
          across tabs. Rendered after topBar so it overlays and stays tappable. */}
      <View style={styles.mapLogoBacking}><LogoMenu size={Platform.OS === 'ios' ? 34 : 40} align="right" /></View>

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
                <Text style={styles.routeToastTitle}>Convoy route shared</Text>
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
        const arriveStr = fmtClock(new Date(Date.now() + durSec * 1000));
        const distStr = ar?.distance_text ?? route.distance_text;
        const bestLabel = selectedRouteIndex === 0 ? "Best route" : (ar?.summary ? `via ${ar.summary}` : "Alternate");
        return (
          <View style={[styles.routeSheet, { bottom: TAB_BAR_H + navInset }]} onLayout={(e) => setPreviewBannerH(e.nativeEvent.layout.height)}>
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

            {/* Summary — duration · arrive time · distance · best-route label */}
            <View style={styles.bannerSummary}>
              <View style={styles.bannerDurCol}>
                <Text style={styles.bannerDurNum}>{durMin}</Text>
                <Text style={styles.bannerDurUnit}>min</Text>
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
              {SHOW_EXTRA_ROUTE_PILLS && (
                <>
                  <TouchableOpacity style={[styles.bannerPill, styles.bannerPillBlue]} activeOpacity={0.9} testID="add-stops">
                    <Ionicons name="add-circle-outline" size={18} color="#fff" />
                    <Text style={styles.bannerPillBlueText}>Add stops</Text>
                  </TouchableOpacity>
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
          old right-edge pull-tab drawer. */}
      {navMode === "turn-by-turn" && activeRoute && tbt.active && (() => {
        const stepIdx = Math.min(tbt.stepIndex + 1, activeRoute.steps.length - 1);
        const upcoming = activeRoute.steps[stepIdx];
        const verb = maneuverVerb(upcoming?.maneuver);
        const instruction = upcoming?.html ? upcoming.html : verb;
        const lanes = pickLaneCue(laneCues, maneuverCoord, tbt.distanceToManeuverM);
        return (
          <TurnByTurnNav
            maneuverIcon={maneuverIcon(upcoming?.maneuver, upcoming?.html)}
            distanceToTurn={fmtDistanceM(tbt.distanceToManeuverM)}
            instruction={instruction}
            eta={fmtEtaSec(tbt.etaSeconds)}
            distanceRemaining={fmtDistanceM(tbt.distanceRemainingM)}
            arrival={fmtClock(new Date(Date.now() + tbt.etaSeconds * 1000))}
            muted={navMuted}
            onToggleMute={() => setNavMuted((m) => { const nv = !m; void updateGlobalSettings({ novaMuted: nv }); return nv; })}
            onEnd={endNav}
            lanes={lanes}
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
      <SpeedPill speedMs={coords?.speed} unit={settings.speedUnit} bottom={controlsBottom} limitKmh={speedLimitKmh} />
      {/* Weather HUD — compact temp-only chip stacked just above the speedometer
          in the bottom-left HUD column (matches the speedo's box + opacity). */}
      {showWeatherLayer && weather && (
        <View style={{ position: 'absolute', left: 12, bottom: weatherBottom, zIndex: 55 }}>
          <WeatherHUD weather={weather} unit={settings.speedUnit} compact forecast={dailyForecast} />
        </View>
      )}

      {/* ===== Zoom +/- buttons (left column, styled like the speedo/weather pills) ===== */}
      <View style={[styles.zoomStack, { bottom: weatherBottom + 64 }]}>
        <TouchableOpacity testID="zoom-in-fab" style={styles.zoomBtn} activeOpacity={0.8}
          onPress={() => setZoomOffset((z) => Math.min(3, z + 1))}>
          <Ionicons name="add" size={26} color="#fff" />
        </TouchableOpacity>
        <View style={styles.zoomDivider} />
        <TouchableOpacity testID="zoom-out-fab" style={styles.zoomBtn} activeOpacity={0.8}
          onPress={() => setZoomOffset((z) => Math.max(-5, z - 1))}>
          <Ionicons name="remove" size={26} color="#fff" />
        </TouchableOpacity>
      </View>
      <PeerModal
        peer={selectedPeer ? { ...selectedPeer } as any : null}
        visible={!!selectedPeer}
        onClose={() => setSelectedPeer(null)}
        myCoords={coords}
        myTopSpeed={Math.max(user?.top_speed_record || 0, sessionMaxSpeed)}
      />

      {/* Nova's mid-drive reroute offer — frosted card with a mini-map preview
          of the suggested alternate route (replaces the old text alert). */}
      <RerouteCard
        visible={!!rerouteOffer}
        route={rerouteOffer?.route ?? null}
        title={rerouteOffer?.title ?? ""}
        subtitle={rerouteOffer?.subtitle ?? ""}
        onAccept={acceptReroute}
        onDecline={declineReroute}
      />

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
        {/* Compass — top of stack. The needle rotates opposite the live map
            bearing so North always points north as the map turns; tapping it
            animates the map back to north-up (heading 0). */}
        <TouchableOpacity
          testID="compass-fab"
          style={styles.fab}
          onPress={() => setNorthSignal((n) => n + 1)}
          activeOpacity={0.85}
        >
          <View style={{ transform: [{ rotate: `${-mapHeading}deg` }] }}>
            <CompassNeedle size={54} />
          </View>
        </TouchableOpacity>
        {/* Police report button. One-tap: posts a hazard with kind='police' at
            the GPS sample closest to (now - 5s), shows a success toast, and
            fires a haptic on native. */}
        <TouchableOpacity
          testID="report-police-fab"
          style={[styles.fab, styles.fabPolice]}
          onPress={() => reportAlert('police')}
          activeOpacity={0.8}
        >
          <PoliceBadgeIcon size={40} />
        </TouchableOpacity>
        {/* ===== Recenter FAB =====
            Only visible when follow-mode is OFF (the user has panned away from
            their position). Tap → flips `isFollowing` back to true which both
            (a) re-binds the map's `region` prop in ConvoyMap so subsequent
            GPS updates track the user, AND (b) fires an animateCamera() snap
            to the current coord for instant feedback. Active state is shown
            with a tinted accent so the user understands the toggle. */}
        {!isFollowing && (
          <TouchableOpacity
            testID="recenter-fab"
            onPress={recenterNow}
            activeOpacity={0.85}
            style={styles.fab}
          >
            <Ionicons name="locate" size={40} color="#fff" />
          </TouchableOpacity>
        )}
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
                  <Ionicons name={mapMode === m.key ? "radio-button-on" : "radio-button-off"} size={22}
                    color={mapMode === m.key ? "#2DEC86" : "#808080"} />
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
                  trackColor={{ false: '#3A3A3C', true: '#5AC8FA' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Hazards</Text>
                  <Text style={styles.layerRowSub}>Show community + Waze pins</Text>
                </View>
                <Switch value={showHazards} onValueChange={setShowHazards}
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
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Avatar Live</Text>
                  <Text style={styles.layerRowSub}>Hide your car from the map</Text>
                </View>
                <Switch value={settings.avatarLive !== false} onValueChange={(v) => { void updateGlobalSettings({ avatarLive: v }); }}
                  trackColor={{ false: '#3A3A3C', true: '#2DEC86' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
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
                  <Text style={styles.layerRowLabel}>Highlight Convoy Reports</Text>
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

      {/* ===== Step Drawer — slide-up turn list =====
          Appears the moment a user taps a route. The active route's maneuvers
          are listed in a dark glassy panel that auto-tucks after 3s so the
          driver gets back to a clear chase-cam view. A small grab pill sits
          on the bottom edge to re-summon it; the drawer's top handle is
          draggable to dismiss with a fling. */}
      {navMode === "turn-by-turn" && activeRoute && tbt.active && (
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

      {/* ===== Cold-start intro overlay — logo on black until first fix ===== */}
      {introVisible && (
        <Animated.View pointerEvents="auto" style={[styles.introOverlay, { opacity: introFade }]}>
          <ConvoyLogo size={132} />
          <Text style={styles.introWord}>CONVOY</Text>
        </Animated.View>
      )}
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

// AlertItem — single row inside the Alerts bottom sheet. Icon chip + title +
// subtitle + (optional) distance pill. Reused for police, hazards, and Waze
// alerts so the visual rhythm is identical across categories.
function AlertItem({ icon, iconColor, title, subtitle, distanceKm: dk }: {
  icon: any; iconColor: string; title: string; subtitle?: string; distanceKm: number | null;
}) {
  return (
    <View style={styles.alertItem}>
      <View style={[styles.layerIcon, { backgroundColor: iconColor + "22" }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.layerLabel}>{title}</Text>
        {!!subtitle && <Text style={styles.layerSub} numberOfLines={1}>{subtitle}</Text>}
      </View>
      {dk !== null && (
        <View style={styles.distPill}>
          <Text style={styles.distPillText}>{dk < 1 ? `${Math.round(dk * 1000)} m` : `${dk.toFixed(1)} km`}</Text>
        </View>
      )}
    </View>
  );
}

// Plain JS Haversine — meters between two lat/lng. Used by the Alerts sheet
// to surface "how far away" without pulling in any geo library.
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// LayerRow — a single switch row in the Layers bottom sheet. Colored icon
// chip + label/subtitle + native Switch. Tapping the row also toggles for
// fat-finger friendliness while driving.
function LayerRow({ icon, iconColor, label, value, onToggle }: {
  icon: any; iconColor: string; label: string; value: boolean; onToggle: (v: boolean) => void;
}) {
  return (
    <TouchableOpacity activeOpacity={0.7} onPress={() => onToggle(!value)} style={styles.layerRow}>
      <View style={[styles.layerIcon, { backgroundColor: iconColor + "22" }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <Text style={[styles.layerLabel, { flex: 1 }]}>{label}</Text>
      <Switch value={value} onValueChange={onToggle} trackColor={{ false: "#3A3A3C", true: iconColor + "88" }} thumbColor={value ? iconColor : "#f4f3f4"} />
    </TouchableOpacity>
  );
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
  // Header row container — lays out the Glass card and the Search/X square
  // button side-by-side. Right padding gives the square button breathing room
  // from the screen edge so it doesn't bleed into the Dynamic Island/notch.
  topBarRow: { flexDirection: "row", alignItems: "stretch", gap: 8, paddingRight: 12 },
  // ===== Compact "Control Cluster" header (slim, search-bar-height) =====
  // Two stacked rows inside the Glass card: title strip on top, status line
  // pinned to the bottom edge. Padding is intentionally tight so the card
  // matches the search bar's vertical footprint and the X button to the right.
  headerCard: { paddingVertical: 8, paddingHorizontal: 12 },
  headerTopRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerMarkSm: { width: 22, height: 22 },
  // Title shrinks to fit on small phones while keeping the "Convoy" identity
  // anchor to the left. letterSpacing trimmed because the larger size already
  // had personality; at 16px we don't need it.
  titleSm: { color: COLORS.text, fontSize: 16, fontWeight: "700", letterSpacing: -0.2, marginLeft: 2 },
  // Live status pill — same color logic as the old one, just smaller paddings
  // so it nests cleanly inside the 22px title row.
  livePillSm: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  liveDotSm: { width: 5, height: 5, borderRadius: 3 },
  liveTextSm: { fontSize: 9, fontWeight: "700", letterSpacing: 0.4 },
  // Refresh + Settings — a row of small icon buttons. 28×28 so the touch
  // target stays usable while keeping the band slim. They sit immediately to
  // the right of the title pill, just left of the X square.
  iconBtnSm: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(118,118,128,0.18)",
  },
  // Status footer — single-line band along the bottom edge of the header card.
  // numberOfLines=1 + ellipsis keeps the layout stable when peer/alert counts
  // hit double digits or the handle is long.
  statusFooter: {
    color: COLORS.textDim,
    fontSize: 11,
    marginTop: 4,
    letterSpacing: 0.1,
  },
  topRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  headerMark: { width: 36, height: 36 },
  title: { color: COLORS.text, fontSize: 26, fontWeight: "700", letterSpacing: -0.6 },
  sub: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(118,118,128,0.32)", alignItems: "center", justifyContent: "center" },

  livePill: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, backgroundColor: "rgba(255,255,255,0.05)" },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  liveText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },

  hazardBubble: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(255,255,255,0.85)" },
  // Bare-image container for the hazard/police art in the detail card + pass-by
  // prompt. Same 48×48 footprint as hazardBubble so the card layout is unchanged.
  hazardImgWrap: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },

  routeCard: { position: "absolute", left: 12, right: 12, bottom: 110, maxHeight: 460 },

  // ===== Google-Maps-style route preview bottom sheet =====
  // Floats just above the tab bar (bottom: TAB_BAR_H), full width, top corners
  // only. The FABs + speedo + weather lift above it via `controlsBottom`
  // (driven by the banner's measured height) so nothing sits underneath it.
  routeSheet: {
    position: "absolute", left: 0, right: 0, bottom: TAB_BAR_H,
    backgroundColor: "#141416",
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.12)",
    paddingTop: 8, paddingHorizontal: 16,
    paddingBottom: 16,
    maxHeight: "62%",
    zIndex: 30,
    shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: -4 }, elevation: 14,
  },
  sheetGrabber: { width: 38, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.22)", alignSelf: "center", marginBottom: 12 },
  // ===== Route preview banner =====
  bannerHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  bannerDrive: { color: "#2DEC86", fontSize: 22, fontWeight: "700", letterSpacing: -0.3 },
  bannerHeaderRight: { flexDirection: "row", alignItems: "center", gap: 18 },
  bannerDivider: { height: StyleSheet.hairlineWidth, backgroundColor: "rgba(255,255,255,0.14)", marginHorizontal: -16, marginBottom: 14 },
  sharedByRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: -2, marginBottom: 10 },
  sharedByText: { color: "#2DEC86", fontSize: 12.5, fontWeight: "700", flex: 1 },
  bannerSummary: { flexDirection: "row", alignItems: "flex-start", gap: 18, marginBottom: 16 },
  bannerDurCol: { alignItems: "center" },
  bannerDurNum: { color: "#F4F4F4", fontSize: 30, fontWeight: "700", letterSpacing: -0.5, lineHeight: 32 },
  bannerDurUnit: { color: "#808080", fontSize: 13, marginTop: 2 },
  bannerArriveRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  bannerArriveLabel: { color: "#808080", fontSize: 13 },
  bannerArriveTime: { color: "#F4F4F4", fontSize: 16, fontWeight: "600" },
  bannerDist: { color: "#F4F4F4", fontSize: 16, fontWeight: "600", marginTop: 3 },
  bannerBest: { color: "#30D158", fontSize: 14, fontWeight: "600", marginLeft: "auto" },
  bannerPills: { flexDirection: "row", gap: 10 },
  bannerPill: { flex: 1, height: 46, borderRadius: 23, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderWidth: 1, borderColor: "rgba(255,255,255,0.18)" },
  bannerPillStart: { backgroundColor: "#2DEC86" },
  bannerPillStartText: { color: "#1C1C1E", fontSize: 16, fontWeight: "700" },
  bannerPillBlue: { backgroundColor: "#0A84FF" },
  bannerPillBlueText: { color: "#F4F4F4", fontSize: 14, fontWeight: "600" },
  sheetHeaderRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 12 },
  sheetDest: { color: COLORS.text, fontSize: 19, fontWeight: "700", letterSpacing: -0.3 },
  sheetMeta: { color: COLORS.success, fontSize: 13, marginTop: 3, fontWeight: "500" },
  sheetHeaderBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(118,118,128,0.22)" },
  routeOptsRow: { flexDirection: "row", gap: 10, paddingBottom: 12 },
  routeOpt: { flex: 1, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.10)", backgroundColor: "rgba(255,255,255,0.04)" },
  routeOptActive: { borderColor: "#2DEC86", backgroundColor: "rgba(45,236,134,0.12)" },
  routeOptEta: { color: COLORS.text, fontSize: 16, fontWeight: "700", letterSpacing: -0.2 },
  routeOptEtaActive: { color: "#2DEC86" },
  routeOptSum: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  routeOptSumActive: { color: "rgba(45,236,134,0.85)" },
  sheetActions: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 2 },
  sheetSecBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 13, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.12)", backgroundColor: "rgba(255,255,255,0.05)" },
  sheetSecText: { color: COLORS.text, fontWeight: "600", fontSize: 14 },
  sheetStartBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 14, backgroundColor: "#2DEC86" },
  sheetStartText: { color: "#0A0A0A", fontWeight: "800", fontSize: 16, letterSpacing: 0.2 },
  routeRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  routeIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.primary, alignItems: "center", justifyContent: "center" },
  routeTo: { color: COLORS.text, fontWeight: "600", fontSize: 15 },
  routeMeta: { color: COLORS.success, fontSize: 13, marginTop: 2, fontWeight: "500" },
  // Alternates row
  altsRow: { flexDirection: "row", paddingHorizontal: 10, paddingBottom: 8, gap: 8, flexWrap: "wrap" },
  altChip: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: COLORS.hairline, backgroundColor: "rgba(255,255,255,0.04)" },
  altChipActive: { borderColor: "#0A84FF", backgroundColor: "rgba(10,132,255,0.18)" },
  altDot: { width: 8, height: 8, borderRadius: 4 },
  altDur: { color: COLORS.textDim, fontWeight: "600", fontSize: 13 },
  altSum: { color: COLORS.textDim, fontSize: 11, maxWidth: 130 },
  // Action row (Steps + Start)
  actionRow: { flexDirection: "row", paddingHorizontal: 12, paddingBottom: 12, gap: 10 },
  secBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1, borderColor: COLORS.hairline, backgroundColor: "rgba(255,255,255,0.04)" },
  secBtnText: { color: COLORS.text, fontWeight: "600", fontSize: 14 },
  startBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, borderRadius: 14, backgroundColor: "#0A84FF" },
  startBtnText: { color: "#F4F4F4", fontWeight: "700", fontSize: 15, letterSpacing: 0.3 },
  // Steps
  stepsList: { maxHeight: 220, paddingHorizontal: 14, paddingTop: 0 },
  stepRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.hairline },
  stepIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: COLORS.primary + "22", alignItems: "center", justifyContent: "center" },
  stepText: { color: COLORS.text, flex: 1, fontSize: 13, lineHeight: 18 },
  stepDist: { color: COLORS.textDim, fontSize: 12 },

  // ---- Turn-by-turn nav overlays ----
  // Turn-by-turn top maneuver banner. `marginTop: 8` adds clearance below the
  // status bar / Dynamic Island so the banner doesn't crowd the camera cutout.
  navTopWrap: { position: "absolute", top: 0, left: 0, right: 0 },
  navTopCard: { marginHorizontal: 12, marginTop: 12 },
  navTopRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  maneuverBig: { width: 64, height: 64, borderRadius: 16, backgroundColor: "#0A84FF", alignItems: "center", justifyContent: "center" },
  navDist: { color: COLORS.text, fontSize: 26, fontWeight: "700", letterSpacing: -0.5 },
  navInst: { color: COLORS.textDim, fontSize: 13, marginTop: 2 },
  navIconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(118,118,128,0.32)", alignItems: "center", justifyContent: "center" },
  navBottomCard: { position: "absolute", left: 12, right: 12, bottom: 110 },
  navBottomRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 14 },
  etaBlock: { alignItems: "flex-start" },

  // Bottom-RIGHT trip data pill (turn-by-turn). ETA stacked over Remaining,
  // tucked just above the rightmost "Hub" footer tab. Compact width so it
  // doesn't span the screen — center stays clear for the chase view.
  tripDataRight: {
    position: "absolute",
    right: 12,
    bottom: 100,
    zIndex: 6,
  },
  tripDataInner: {
    minWidth: 110,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: "flex-end",
  },
  tripDataValue: { color: COLORS.text, fontWeight: "800", fontSize: 18, letterSpacing: -0.3, lineHeight: 22 },
  tripDataLabel: { color: COLORS.textDim, fontSize: 10, fontWeight: "700", letterSpacing: 0.6, marginTop: -1 },
  tripDataDivider: { height: 1, alignSelf: "stretch", backgroundColor: "rgba(255,255,255,0.08)", marginVertical: 6 },

  // End-nav red pill — bottom-LEFT just above the speedometer. Small footprint
  // so the speedometer + Map tab icon are still legible underneath.
  endNavFab: {
    position: "absolute",
    left: 12,
    bottom: 158,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: "#FF3B30",
    zIndex: 7,
    shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  endNavFabText: { color: "#F4F4F4", fontWeight: "700", fontSize: 13, letterSpacing: 0.2 },
  etaBig: { color: COLORS.text, fontSize: 22, fontWeight: "700", letterSpacing: -0.4 },
  etaLabel: { color: COLORS.textDim, fontSize: 11, marginTop: 2, letterSpacing: 0.4 },
  etaDivider: { width: StyleSheet.hairlineWidth, height: 36, backgroundColor: COLORS.hairline },
  endBtn: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#FF3B30", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 14 },
  endBtnText: { color: "#F4F4F4", fontWeight: "700", letterSpacing: 0.3 },

  selectedCard: { position: "absolute", left: 12, right: 12, bottom: 200 },

  // Square Search/X button — sits to the right of the Map bar in a single
  // horizontal row. Matches the Glass card's vertical footprint so the two
  // read as one continuous toolbar across the screen. Slightly tighter radius
  // than the Glass card (16 vs 20) so the silhouette reads as "button" not
  // "second card".
  searchSquare: {
    width: 56,
    alignSelf: "stretch",       // grow to fill the row's intrinsic height
    minHeight: 56,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(10,132,255,0.92)", // matches Apple Maps blue
    shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },

  // Dark circular backing behind the brand logo on the MAP screen only.
  // The logo sits over live map imagery (roads/satellite), so unlike the
  // solid-dark Comms/Music headers it needs a backing to stay crisp over any
  // background. 40×40 circle mirrors the old profile-avatar footprint.
  mapLogoBacking: {
    position: 'absolute', top: Platform.OS === 'ios' ? 47 : 28, right: 12, zIndex: 100,
    width: Platform.OS === 'ios' ? 46 : 54,
    height: Platform.OS === 'ios' ? 46 : 54,
    borderRadius: Platform.OS === 'ios' ? 23 : 27,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(20,20,22,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },

  // Trip Summary pill — collapsed view of the route preview card. Renders at
  // the very top, single line, tappable to expand back into the full card.
  tripSummaryWrap: { position: "absolute", top: 0, left: 60, right: 60, paddingTop: 4, zIndex: 8 },
  tripSummary: {},
  tripSummaryRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 14 },
  tripSummaryEta: { color: COLORS.text, fontWeight: "700", fontSize: 13, letterSpacing: 0.2 },
  tripSummaryDest: { color: COLORS.textDim, fontSize: 12, flex: 1 },
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
  // (legacy, kept for reference but unused)
  confirmBtn: { paddingHorizontal: 14, paddingVertical: 10, backgroundColor: COLORS.primary + "33", borderRadius: 12, borderWidth: 1, borderColor: COLORS.primary + "55" },
  confirmText: { color: COLORS.primary, fontWeight: "700" },

  // Right-edge "peek tab" wrapper. Anchored to right=0 so the slide-out animation
  // tucks 67% of the square off-screen when inactive (33% peeking) and lands at
  // x=0 when active. Square corners on the right edge, rounded on the left edge
  // so it reads as a drawer pull rather than a button.
  // Speedometer HUD — bottom-LEFT corner above the "Map" footer tab icon.
  // Placed flush against the left edge so the chase-cam center is fully open.
  // ===== Speedometer HUD (bottom-left) =====
  // Square 64×64 badge mirroring the right-side FAB stack — same edge gutter
  // (12) and same bottom anchor (90) for visual symmetry. Inner Text nodes
  // render the speed number + unit label. Background color is set inline on
  // the View (dark / orange / red) by SpeedometerHUD based on speed vs limit.
  // Bottom-right FAB buttons. These are flex children of `fabStack` (which
  // owns the absolute positioning + vertical-column layout), so they must NOT
  // be position:absolute themselves. The old style WAS absolute at a fixed
  // bottom/right, which collapsed every button onto the same spot — the blue
  // Directions FAB landed on top of the pile and read as a stray "blue dot"
  // floating over the map (and tapping it toggled the search bar + logo).
  // Now: 48×48 rounded squares, semi-transparent dark fill, centered white
  // icon. fabPrimary (blue Directions) / stopNavBtn (red Stop) / the inline
  // recenter blue override just the fill.
  fab: {
    width: 60, height: 60,
    borderRadius: 30,
    backgroundColor: "rgba(28,28,30,0.92)",
    alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
    shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  zoomStack: {
    position: "absolute", left: 12, zIndex: 55, width: 60,
    borderRadius: 16, overflow: "hidden",
    backgroundColor: "rgba(22,22,24,0.92)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.12)",
    shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 5,
  },
  zoomBtn: { width: 58, height: 52, alignItems: "center", justifyContent: "center" },
  zoomDivider: { height: 1, backgroundColor: "rgba(255,255,255,0.12)" },
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
  fab2: {
    width: 42, height: 42,
    borderRadius: 10,
    backgroundColor: 'rgba(28,28,30,0.88)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  // Directions = primary action → Convoy blue. Same 42×42 footprint as the
  // others (was 44×44 in spec, but matching the rest reads cleaner).
  fabPrimary: {},
  // Stop Navigation — red 42×42 button shown LEFT of Directions while a trip
  // is active. Same footprint, attention-grabbing red bg so the driver knows
  // exactly where to tap to bail out of nav.
  stopNavBtn: { backgroundColor: "#FF3B30", borderWidth: 0 },
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
  // Small badge with the active-alert count pinned to top-right of the Alerts FAB.
  fabBadge: {
    position: "absolute", top: -4, right: -4,
    minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: "#FF3B30",
    alignItems: "center", justifyContent: "center",
    paddingHorizontal: 5,
    borderWidth: 2, borderColor: "rgba(28,28,30,0.85)",
  },
  fabBadgeText: { color: "#F4F4F4", fontSize: 10, fontWeight: "700" },
  // Tiny live-status pill that overlays the top edge of the search bar
  // (replaces the old dark header). Green dot + "X live · Y alerts" in a
  // glassy rounded chip — subtle, glanceable, never blocks the map.
  liveOverlay: {
    alignSelf: "center", marginTop: 8,
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 9, paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(28,28,30,0.78)",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.18)",
    zIndex: 5,
  },
  liveOverlayText: { color: "#F4F4F4", fontSize: 10, fontWeight: "600", letterSpacing: 0.2 },
  // ===== Layers bottom sheet =====
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheetCard: {
    backgroundColor: "#15171A",
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 28,
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.12)",
  },
  sheetGrip: { width: 38, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.25)", alignSelf: "center", marginBottom: 14 },
  sheetTitle: { color: COLORS.text, fontSize: 18, fontWeight: "700", marginBottom: 12, letterSpacing: -0.2 },
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
  alertsGroup: { color: COLORS.textDim, fontSize: 11, fontWeight: "700", letterSpacing: 0.7, marginTop: 14, marginBottom: 4, textTransform: "uppercase" },
  alertsEmpty: { color: COLORS.textDim, fontSize: 13, textAlign: "center", marginTop: 22 },
  alertItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  distPill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, backgroundColor: "rgba(118,118,128,0.35)" },
  distPillText: { color: "#F4F4F4", fontSize: 11, fontWeight: "600" },
  // Cold-start intro overlay — logo on black covering everything until the
  // first location fix lands, then fades out.
  introOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
    alignItems: "center", justifyContent: "center",
    gap: 18,
    zIndex: 100000,
  },
  introWord: { color: "#2DEC86", fontSize: 22, fontWeight: "800", letterSpacing: 6, marginLeft: 6 },
});
