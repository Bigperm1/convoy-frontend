import React, { useEffect, useRef, useState, useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, Platform, Image, Animated, Modal, Linking, Switch, PanResponder } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import * as Speech from "expo-speech";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { api, formatErr, wsUrl } from "../../src/api";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { useRouter } from "expo-router";
import Glass from "../../src/Glass";
import ConvoyMap, { Hazard, Peer } from "../../src/ConvoyMap";
import DestinationSearch from "../../src/DestinationSearch";
import { supabase, SUPABASE_ENABLED, SupaHazard } from "../../src/supabase";
import { voiceBus, geocodeQuery } from "../../src/voiceBus";
import { useCommunityRoutes, createCommunityRoute, CommunityRoute } from "../../src/communityRoutes";
import Speedometer from "../../src/components/Speedometer";
import { ReportToast, MusicToast } from "../../src/components/AlertToast";
import { HazardDrawer, ReportPeekTab } from "../../src/components/FloatingButtons";
import NavigationPanel from "../../src/components/NavigationPanel";
import StepDrawer, { StepDrawerHandle } from "../../src/components/StepDrawer";
import { useSettings, getSettings, updateSettings as updateGlobalSettings } from "../../src/settings";
import { getProximityTier, setLatestTier } from "../../src/proximityAudio";
import { useConvoyPresence, ConvoyPresencePeer } from "../../src/convoyPresence";
import PeerModal from "../../src/PeerModal";
import {
  fetchDirections, NavRoute, useTurnByTurn, maneuverVerb,
  fmtDistanceM, fmtEtaSec,
} from "../../src/nav";

type RouteInfo = {
  distance_text: string;
  duration_text: string;
  steps: { html: string; distance_text: string; maneuver?: string }[];
};

const maneuverIcon = (m?: string): any => {
  if (!m) return "arrow-up";
  if (m.includes("left")) return "arrow-back";
  if (m.includes("right")) return "arrow-forward";
  if (m.includes("uturn")) return "refresh";
  if (m.includes("merge")) return "git-merge";
  if (m.includes("ramp")) return "swap-horizontal";
  return "arrow-up";
};

export default function MapScreen() {
  const { user, token } = useAuth();
  const router = useRouter();
  const [coords, setCoords] = useState<{ lat: number; lng: number; heading?: number; speed?: number } | null>(null);

  // ---- Personal Best speed tracking ----
  // sessionMaxSpeed: highest km/h seen since the screen mounted (in-memory only).
  // We compare it against the user's persisted top_speed_record on each tick;
  // once we beat the persisted record we PUT it to the backend, throttled to
  // at most once every 60s to keep battery + network use low while driving.
  const [sessionMaxSpeed, setSessionMaxSpeed] = useState(0);
  const lastTopSyncAtRef = useRef(0);
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [showReport, setShowReport] = useState(false);
  const [selected, setSelected] = useState<Hazard | null>(null);
  const [destination, setDestination] = useState<{ lat: number; lng: number; label: string } | null>(null);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [live, setLive] = useState<"connecting" | "live" | "off">("connecting");
  // Multi-route state — primary "Route Line" (blue) + alternates (gray)
  const [routes, setRoutes] = useState<NavRoute[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  // Turn-by-turn navigation state
  const [navMode, setNavMode] = useState<"preview" | "turn-by-turn">("preview");
  const [navMuted, setNavMuted] = useState(false);
  // ---- UI refinement state (post-field-test) ----
  // Search bar visibility — auto-hides when navigation starts so the destination
  // search field doesn't cover the map. A small magnifying-glass FAB appears in
  // its place to bring it back when the driver wants to change course.
  const [searchVisible, setSearchVisible] = useState(true);
  // Layers control state — driven by the new bottom-right Layers FAB.
  // mapType:    "hybrid" = satellite + labels (default), "roadmap" = flat road view.
  // showTraffic / showTransit / showHazards toggle their respective overlays.
  // layersOpen drives the layers bottom sheet modal.
  const [mapType, setMapType] = useState<"hybrid" | "roadmap">("hybrid");
  const [showTraffic, setShowTraffic] = useState(true);
  const [showTransit, setShowTransit] = useState(false);
  const [showHazards, setShowHazards] = useState(true);
  const [layersOpen, setLayersOpen] = useState(false);
  // Position history buffer — keeps the last 30s of GPS samples so the user
  // can report a hazard "5 seconds ago" (matches Waze-style flow where the
  // driver passes the hazard before they react and tap the button).
  const posHistoryRef = useRef<{ lat: number; lng: number; ts: number }[]>([]);
  // Transient toast state for "Police reported" / "Hazard reported" feedback.
  const [alertConfirm, setAlertConfirm] = useState<string | null>(null);
  // Music broadcast toast — surfaced when the community admin pushes a track
  // via Music screen → "🎵 jeff: Smooth Operator — Sade". Auto-dismisses 5s.
  const [musicToast, setMusicToast] = useState<string | null>(null);
  const musicToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Right-edge Navigation Action Drawer — peeked 80% off-screen by default
  // when turn-by-turn is engaged. Tap the visible 20% to expand and see the
  // current maneuver + End. Auto-collapses on tap-out / route end.
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  // Preview-card collapse state — when the driver starts moving (or taps the
  // map) the big preview card collapses into a minimal "Trip Summary" pill at
  // the top so the 3D chase view has the whole screen.
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const activeRoute: NavRoute | null = routes[selectedRouteIndex] || null;
  const encodedPolyline = activeRoute?.polyline || null;

  // Auto-hide the search bar when actually navigating (turn-by-turn engaged).
  // When nav stops, we don't auto-show — the driver explicitly taps the FAB
  // or returns to preview. This mirrors Apple/Google Maps behavior.
  useEffect(() => {
    if (navMode === "turn-by-turn") setSearchVisible(false);
  }, [navMode]);

  // Auto-collapse the preview card once the driver starts moving (speed ≥ 5 km/h).
  // Threshold chosen high enough to ignore GPS jitter at idle; low enough to
  // collapse before the driver has merged onto the freeway.
  useEffect(() => {
    if (!destination || !route) return;          // nothing to collapse yet
    if (navMode === "turn-by-turn") return;      // turn-by-turn UI takes over
    const kmh = (coords?.speed && coords.speed > 0) ? coords.speed * 3.6 : 0;
    if (kmh >= 5 && !previewCollapsed) setPreviewCollapsed(true);
  }, [coords?.speed, destination, route, navMode]);

  // When destination clears, reset both UI states so a fresh search restarts clean.
  useEffect(() => {
    if (!destination) {
      setPreviewCollapsed(false);
      setSearchVisible(true);
    }
  }, [destination]);

  const [settings] = useSettings();

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

  // Unified multi-route directions (web + native). Fetches up to 3 alternates with `alternatives=true`.
  // Routes are SORTED by current traffic-aware ETA (fastest first) and tagged with
  // a rank-based color: green (fastest) / orange (2nd) / red (3rd+) so the user
  // can see at-a-glance which polyline is the best pick.
  // Honors avoid-tolls/highways/ferries route preferences from settings.
  useEffect(() => {
    if (!destination || !coords) {
      setRoutes([]); setSelectedRouteIndex(0); setRoute(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const raw = await fetchDirections(coords, destination, {
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
      const results = sorted.map((r, i) => ({
        ...r,
        color: i === 0 ? '#34C759' : i === 1 ? '#FF9500' : '#FF3B30',
      })) as any[];
      setRoutes(results);
      setSelectedRouteIndex(0);
      const r0 = results[0];
      setRoute(r0 ? {
        distance_text: r0.distance_text,
        duration_text: r0.duration_text,
        steps: r0.steps.map((s: any) => ({ html: s.html, distance_text: s.distance_text, maneuver: s.maneuver })),
      } : null);
    })();
    return () => { cancelled = true; };
  }, [destination, coords, settings.avoidTolls, settings.avoidHighways, settings.avoidFerries]);

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

  // Turn-by-turn engine — speaks instructions, advances steps, computes ETA / distance remaining
  const tbt = useTurnByTurn(activeRoute, coords, navMode === "turn-by-turn", {
    mute: navMuted,
    onArrive: () => { setNavMode("preview"); },
    onOffRoute: () => {
      // Auto-reroute: refetch directions from the current GPS position (honoring user's avoid prefs)
      if (!coords || !destination) return;
      fetchDirections(coords, destination, {
        tolls: settings.avoidTolls,
        highways: settings.avoidHighways,
        ferries: settings.avoidFerries,
      }).then((res) => {
        if (res.length > 0) {
          setRoutes(res);
          setSelectedRouteIndex(0);
          if (!navMuted) Speech.speak("Recalculating route.", { rate: 1.0 });
        }
      });
    },
  });

  const startNav = () => {
    if (!activeRoute) return;
    setShowSteps(false);
    setNavMode("turn-by-turn");
  };
  const endNav = () => {
    Speech.stop();
    setNavMode("preview");
  };
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
    Speech.stop();
    setDestination(null);
    setRoutes([]);
    setRoute(null);
    setShowSteps(false);
    setNavMode("preview");
    // Also retract the step drawer so it doesn't dangle on a destination-less map.
    slideStepDrawerDown();
  };

  // ===== Step Drawer =====
  // Slides up from the bottom when a route is selected, lists each maneuver,
  // and auto-hides after 3s. The drawer is fully encapsulated in
  // `components/StepDrawer` — we just hold a ref so we can drive open/close.
  const stepDrawerRef = useRef<StepDrawerHandle | null>(null);
  const stepDrawerAutoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slideStepDrawerUp = () => stepDrawerRef.current?.open();
  const slideStepDrawerDown = () => stepDrawerRef.current?.close();

  // Tap a route polyline on the map → keep ONLY that route, fire up nav with
  // chase-cam (45° behind the car), and pop the step drawer for 3s so the
  // driver can glance at the turn list before it tucks away.
  const handleSelectRoute = (index: number) => {
    const chosen = routes[index];
    if (!chosen) return;
    setRoutes([chosen]);
    setSelectedRouteIndex(0);
    setShowSteps(false);
    setNavMode("turn-by-turn");
    // Force chase cam on — `mapView` controls bearing-lock + 45° pitch downstream.
    updateGlobalSettings({ mapView: 'heading_up' }).catch(() => {});
    slideStepDrawerUp();
    if (stepDrawerAutoHideTimer.current) clearTimeout(stepDrawerAutoHideTimer.current);
    stepDrawerAutoHideTimer.current = setTimeout(() => {
      slideStepDrawerDown();
    }, 3000);
  };
  // Clear the auto-hide timer on unmount so we don't leak.
  useEffect(() => () => {
    if (stepDrawerAutoHideTimer.current) clearTimeout(stepDrawerAutoHideTimer.current);
  }, []);

  // Continuous GPS watch while in turn-by-turn mode (updates user position for the engine + camera follow)
  useEffect(() => {
    if (navMode !== "turn-by-turn") return;
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") return;
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1500, distanceInterval: 5 },
          (pos) => setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        );
      } catch {}
    })();
    return () => { if (sub) sub.remove(); };
  }, [navMode]);

  // ----- Initial location -----
  useEffect(() => {
    (async () => {
      let lat = 37.7749, lng = -122.4194;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === "granted") {
          const pos = await Promise.race([
            Location.getCurrentPositionAsync({}),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
          ]);
          if (pos && (pos as any).coords) {
            lat = (pos as any).coords.latitude;
            lng = (pos as any).coords.longitude;
          }
        }
      } catch {}
      setCoords({ lat, lng });
      try { await api.post("/location", { lat, lng, speed: 0, heading: 0 }); } catch {}
      loadPeers();
    })();
  }, []);

  // ----- Continuous heading + position watcher -----
  // BestForNavigation accuracy + 1s tick + 0m distance gate so the speedometer
  // updates every second instead of every ~4s/8m. Battery cost is acceptable
  // for a car-enthusiast app — this is the same cadence Google Maps uses.
  // Also drives a throttled Google Roads speed-limit lookup (1×/10s) so the
  // speedo can color-code over/under the posted limit.
  const speedLimitRef = useRef<number | null>(null);
  const lastSpeedLimitFetchRef = useRef<number>(0);
  // Border-detection: throttle the reverse-geocode lookup to once a minute,
  // and only if the user hasn't manually picked a unit in Settings (see
  // `settings.speedUnitManual` — set true when they tap a unit button).
  const lastUnitCheckRef = useRef<number>(0);
  useEffect(() => {
    let sub: any = null;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") return;
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
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
            const kmh = speed * 3.6;
            // Personal-best tracking (in-memory): ignore stationary jitter (<1 km/h).
            // The throttled PUT to /auth/profile is handled by the existing
            // `useEffect([sessionMaxSpeed, ...])` block below — no duplicate post here.
            if (kmh >= 1) {
              setSessionMaxSpeed((m) => (kmh > m ? kmh : m));
            }
            // Google Roads speed-limit lookup — throttled to 1/10s so we
            // stay well under the free-tier quota.
            const now = Date.now();
            if (now - lastSpeedLimitFetchRef.current > 10000) {
              lastSpeedLimitFetchRef.current = now;
              const KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY;
              if (KEY) {
                fetch(`https://roads.googleapis.com/v1/speedLimits?path=${pos.coords.latitude},${pos.coords.longitude}&key=${KEY}`)
                  .then((r) => r.json())
                  .then((d) => {
                    const limit = d?.speedLimits?.[0]?.speedLimit;       // KPH
                    if (typeof limit === 'number') speedLimitRef.current = limit;
                  })
                  .catch(() => {});
              }
            }
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
  }, []);

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
      await api.post('/hazards', { kind, lat: pos.lat, lng: pos.lng, note: '' });
      setAlertConfirm(kind);
      setTimeout(() => setAlertConfirm(null), 2500);
      if (Platform.OS !== 'web') {
        try {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch {}
      }
    } catch (e) {
      console.warn('reportAlert failed', e);
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
          setPeers((p) => ({ ...p, [m.user_id]: { ...p[m.user_id], ...m } }));
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
        // Music broadcast from the community admin — surface a non-intrusive
        // toast at the bottom-center "🎵 jeff: Smooth Operator — Sade" that
        // auto-dismisses after 5s. `action: 'stop'` immediately clears it.
        if (m.type === "music_broadcast") {
          if (m.action === "play" && m.track) {
            const who = m.broadcaster_handle || "Admin";
            setMusicToast(`🎵 ${who}: ${m.track.name}${m.track.artist ? ` — ${m.track.artist}` : ""}`);
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
      const pm: Record<string, Peer> = {};
      data.forEach((u: any) => { if (u.lat && u.lng) pm[u.id] = { user_id: u.id, handle: u.handle, lat: u.lat, lng: u.lng }; });
      setPeers(pm);
    } catch {}
  };

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
    try { await Promise.all([loadPeers(), loadCommunities?.()]); } catch {}
  };

  const reportHazard = async (kind: string, opts?: { fromVoice?: boolean }) => {
    if (!coords) return;
    // Place pin slightly ahead of the driver's heading (≈40m forward) for accuracy.
    // Without a known heading we just place it at the driver's exact spot.
    const lat = coords.lat;
    const lng = coords.lng;
    try {
      if (SUPABASE_ENABLED && supabase) {
        const { error } = await supabase.from("hazards").insert({
          kind, lat, lng, reporter_handle: user?.handle || "anon",
        });
        if (error) throw error;
      } else {
        await api.post("/hazards", { kind, lat, lng, note: "" });
      }
      setShowReport(false);
      // Voice-driven reports get a spoken acknowledgement so the driver can keep eyes on the road
      if (opts?.fromVoice && !navMuted) {
        const label = kind === "police" ? "Police" : kind === "accident" ? "Accident" : kind === "traffic" ? "Traffic" : "Hazard";
        try { Speech.speak(`${label} reported. Thanks driver.`, { rate: 1.0, pitch: 1.0 }); } catch {}
      }
    } catch (e: any) {
      Alert.alert("Report failed", e?.message || formatErr(e));
    }
  };

  // Confirm = "still there" → +1 confirms
  const confirmHazard = async (h: Hazard) => {
    try {
      if (SUPABASE_ENABLED && supabase) {
        await supabase.from("hazards").update({ confirms: (h.confirms || 1) + 1 }).eq("id", h.id);
      } else {
        await api.post(`/hazards/${h.id}/confirm`);
      }
      setSelected(null);
    } catch {}
  };

  // Dispute = "not there anymore" → DELETE the hazard outright.
  // Two layers of safety:
  //   1. Optimistic local removal so the marker disappears from the tapper's
  //      map *immediately*, even before the network round-trip resolves.
  //   2. Supabase DELETE → Realtime DELETE event fans out to every other
  //      driver's map within ~1.5 s (see DELETE listener above).
  // Backend fallback (FastAPI DELETE /api/hazards/{id}) handles non-Supabase
  // environments. The previous "increment disputes counter" behavior was
  // confusing — drivers tapped Not there and the marker stayed on the map.
  const disputeHazard = async (h: Hazard) => {
    // Snapshot id so we don't double-fetch after `selected` clears below.
    const id = h.id;
    // 1) Optimistic local strip — tapper sees the marker vanish instantly.
    setHazards((cur) => cur.filter((x) => x.id !== id));
    setSelected(null);
    // 2) Persist the deletion so other drivers' maps clear too.
    try {
      if (SUPABASE_ENABLED && supabase) {
        const { error } = await supabase.from("hazards").delete().eq("id", id);
        if (error) {
          // RLS or column issue — fall through to backend
          await api.delete(`/hazards/${id}`).catch(() => {});
        }
      } else {
        await api.delete(`/hazards/${id}`).catch(() => {});
      }
    } catch {
      // Even if persistence fails, the optimistic local removal stands.
      // Worst case: a stale row reappears on the next refetch — acceptable
      // tradeoff for instant UI feedback.
    }
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
        const loc = await geocodeQuery(cmd.query, coords || undefined);
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
      // Pass car body silhouette + color so other drivers see the right top-down icon.
      carBody: (user as any).car_type || "sedan",
      carColor: user.car_color || undefined,
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
      } as Peer;
    });
    return Object.values(byId);
  })();
  const liveDot = live === "live" ? COLORS.success : live === "connecting" ? COLORS.warning : COLORS.danger;
  const liveText = live === "live" ? "Live" : live === "connecting" ? "Connecting" : "Offline";

  // Filter out community-downvoted hazards before rendering
  const visibleHazards = hazards.filter(isHazardVisible);

  return (
    <View style={styles.c}>
      <ConvoyMap
        center={coords}
        // user.car_type / user.car_color come from the Garage profile (Mongo,
        // hydrated by useAuth). Pass them as carBody/carColor so the "you"
        // marker uses the same SVG silhouette + paint other drivers see.
        user={{
          ...coords,
          heading: coords.heading || 0,
          carBody: ((user as any)?.car_type as string) || "sedan",
          carColor: user?.car_color || undefined,
        }}
        // Privacy: when Avatar Live is OFF we suppress the local "you" marker.
        // Presence channel is also nulled out above so peers don't see us at all.
        hideSelfMarker={settings.avatarLive === false}
        // Map view mode (radio choice from Settings → MAP VIEW). Drives the
        // chase-cam tilt + bearing. Defaults to "heading_up" so nav feels like
        // Waze/Google out of the box.
        mapView={settings.mapView}
        // Layer controls — driven by the bottom-right Layers FAB.
        mapType={mapType}
        showTraffic={showTraffic}
        showTransit={showTransit}
        showHazards={showHazards}
        peers={peerList}
        leaderUserId={leaderUserId}
        hazards={visibleHazards}
        externalAlerts={[]}
        highlightConvoy={settings.highlightConvoy}
        destination={destination}
        encodedPolyline={encodedPolyline}
        routes={routes}
        selectedRouteIndex={selectedRouteIndex}
        onSelectRoute={handleSelectRoute}
        followUser={navMode === "turn-by-turn"}
        // Chase-cam (3D, heading-rotated, dynamic-zoom) is on whenever turn-
        // by-turn nav is actively running. Pitch defaults to 45° in ConvoyMap.
        navigationActive={navMode === "turn-by-turn" && tbt.active}
        userSpeedMs={coords?.speed}
        // Tap on empty map → close any open search overlay so the driver can
        // peek at the map fullscreen mid-trip without ending navigation.
        onMapPress={() => { if (searchVisible) setSearchVisible(false); }}
        onHazardPress={(h) => setSelected(h)}
        onHazardLongPress={handleHazardLongPress}
        onPeerPress={(p) => {
          // Find the matching presence record (has online_at, etc.) — fallback to bare peer
          const full = presence.peers.find((pp) => pp.user_id === p.user_id);
          setSelectedPeer(full || { user_id: p.user_id, handle: p.handle, lat: p.lat, lng: p.lng, carType: p.carType });
        }}
        onExternalAlertPress={(a) => Alert.alert(`${a.type}${a.subtype ? " · " + a.subtype : ""}`, "Live alert from Convoy feed.")}
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
        {searchVisible && (Platform.OS === "web" ? (
          <View pointerEvents="box-none">
            {/* Subtle live pill overlay — small green dot + live count.
                Anchors to the right above the search bar so it surfaces
                presence at-a-glance without a heavy dark header. */}
            {(() => {
              const selfLive = settings.avatarLive !== false && !!settings.activeCommunityId ? 1 : 0;
              const liveCount = selfLive + peerList.length;
              return (
                <View style={styles.liveOverlay} pointerEvents="none">
                  <View style={[styles.liveDotSm, { backgroundColor: liveDot }]} />
                  <Text style={styles.liveOverlayText}>{liveCount} live · {visibleHazards.length} alerts</Text>
                </View>
              );
            })()}
            <DestinationSearch
              origin={coords}
              onSelect={(loc) => { setDestination(loc); setShowSteps(true); setSearchVisible(false); }}
              onClear={() => { setDestination(null); setRoute(null); setShowSteps(false); setSearchVisible(true); }}
              onProfilePress={() => router.push("/(app)/hub" as any)}
            />
          </View>
        ) : (
          <View pointerEvents="box-none">
            {(() => {
              const selfLive = settings.avatarLive !== false && !!settings.activeCommunityId ? 1 : 0;
              const liveCount = selfLive + peerList.length;
              return (
                <View style={styles.liveOverlay} pointerEvents="none">
                  <View style={[styles.liveDotSm, { backgroundColor: liveDot }]} />
                  <Text style={styles.liveOverlayText}>{liveCount} live · {visibleHazards.length} alerts</Text>
                </View>
              );
            })()}
            <DestinationSearch
              origin={coords}
              onSelect={(loc) => { setDestination(loc); setShowSteps(true); setSearchVisible(false); }}
              onClear={() => { setDestination(null); setRoute(null); setShowSteps(false); setSearchVisible(true); }}
              onProfilePress={() => router.push("/(app)/hub" as any)}
            />
          </View>
        ))}
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

      {/* ===== Route preview — collapses into Trip Summary pill once moving ===== */}
      {destination && route && navMode === "preview" && previewCollapsed && (
        <SafeAreaView edges={["top"]} pointerEvents="box-none" style={styles.tripSummaryWrap}>
          <TouchableOpacity
            testID="trip-summary-pill"
            onPress={() => setPreviewCollapsed(false)}
            activeOpacity={0.85}
          >
            <Glass radius={16} style={styles.tripSummary}>
              <View style={styles.tripSummaryRow}>
                <Ionicons name="navigate" size={16} color="#0A84FF" />
                <Text style={styles.tripSummaryEta} numberOfLines={1}>
                  {(activeRoute?.duration_in_traffic_text || route.duration_text)} · {route.distance_text}
                </Text>
                <Text style={styles.tripSummaryDest} numberOfLines={1}>
                  {destination.label}
                </Text>
                <Ionicons name="chevron-down" size={16} color={COLORS.textDim} />
              </View>
            </Glass>
          </TouchableOpacity>
        </SafeAreaView>
      )}

      {/* ===== Route preview card (full) — shown when NOT collapsed AND NOT navigating ===== */}
      {destination && route && navMode === "preview" && !previewCollapsed && (
        <Glass radius={20} style={styles.routeCard}>
          <View style={styles.routeRow}>
            <View style={styles.routeIcon}><Ionicons name="navigate" size={22} color="#fff" /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.routeTo} numberOfLines={1}>To {destination.label}</Text>
              <Text style={styles.routeMeta}>{route.duration_text} · {route.distance_text}{routes[selectedRouteIndex]?.summary ? ` · via ${routes[selectedRouteIndex].summary}` : ""}</Text>
            </View>
            {/* Collapse-to-pill chevron (manual override of the auto-collapse-on-movement) */}
            <TouchableOpacity testID="route-collapse" onPress={() => setPreviewCollapsed(true)} style={{ padding: 4, marginRight: 2 }}>
              <Ionicons name="chevron-up" size={22} color={COLORS.textDim} />
            </TouchableOpacity>
            <TouchableOpacity testID="route-clear" onPress={clearRoute} style={{ padding: 4 }}>
              <Ionicons name="close-circle" size={24} color={COLORS.textDim} />
            </TouchableOpacity>
          </View>

          {/* Alternates picker — tappable chips when there are >1 routes.
              Shows traffic-aware ETA (`duration_in_traffic_text`) when available
              from Google's Directions API; falls back to free-flow time. */}
          {routes.length > 1 && (
            <View style={styles.altsRow}>
              {routes.map((r, i) => {
                const sel = i === selectedRouteIndex;
                const eta = r.duration_in_traffic_text || r.duration_text;
                const inTraffic = !!r.duration_in_traffic_text && r.duration_in_traffic_s !== r.duration_s;
                return (
                  <TouchableOpacity
                    key={i}
                    testID={`alt-${i}`}
                    onPress={() => setSelectedRouteIndex(i)}
                    activeOpacity={0.85}
                    style={[styles.altChip, sel && styles.altChipActive]}
                  >
                    <View style={[styles.altDot, { backgroundColor: sel ? "#0A84FF" : inTraffic ? "#FF9F0A" : "#8E8E93" }]} />
                    <View>
                      <Text style={[styles.altDur, sel && { color: COLORS.text }]}>{eta}</Text>
                      <Text style={styles.altSum} numberOfLines={1}>
                        {r.summary || (i === 0 ? "Fastest" : `Alt ${i}`)}
                        {inTraffic ? " · in traffic" : ""}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Action row */}
          <View style={styles.actionRow}>
            <TouchableOpacity testID="route-toggle" onPress={() => setShowSteps((s) => !s)} style={styles.secBtn}>
              <Ionicons name={showSteps ? "chevron-down" : "list"} size={18} color={COLORS.text} />
              <Text style={styles.secBtnText}>{showSteps ? "Hide" : "Steps"}</Text>
            </TouchableOpacity>
            {/* Admin-only: share this destination with the active community.
                Hidden if the active community has Map Connect disabled. */}
            {isAdminOfActive && settings.activeCommunityId && activeMapEnabled && (
              <TouchableOpacity
                testID="save-to-convoy"
                onPress={saveCurrentDestinationToConvoy}
                style={[styles.secBtn, savingRoute && { opacity: 0.6 }]}
                disabled={savingRoute}
                activeOpacity={0.85}
              >
                <Ionicons name={savingRoute ? "hourglass" : "share-social"} size={18} color={COLORS.warning} />
                <Text style={[styles.secBtnText, { color: COLORS.warning }]}>{savingRoute ? "Sharing…" : "Share"}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity testID="start-nav" onPress={startNav} style={styles.startBtn} activeOpacity={0.85}>
              <Ionicons name="navigate-circle" size={20} color="#fff" />
              <Text style={styles.startBtnText}>Start</Text>
            </TouchableOpacity>
          </View>

          {showSteps && (
            <ScrollView style={styles.stepsList} contentContainerStyle={{ paddingBottom: 12 }} testID="route-steps">
              {route.steps.map((s, i) => (
                <View key={i} style={styles.stepRow}>
                  <View style={styles.stepIcon}><Ionicons name={maneuverIcon(s.maneuver)} size={16} color={COLORS.primary} /></View>
                  <Text style={styles.stepText} numberOfLines={2}>{s.html}</Text>
                  <Text style={styles.stepDist}>{s.distance_text}</Text>
                </View>
              ))}
            </ScrollView>
          )}
        </Glass>
      )}

      {/* ===== Turn-by-turn overlays — right-edge nav drawer only =====
          The bottom-right ETA / Remaining pill was removed; that data is
          still computed in `tbt` (used by the NavActionDrawer) so callers
          that want it can read it directly. */}
      {navMode === "turn-by-turn" && activeRoute && tbt.active && (() => {
        const stepIdx = Math.min(tbt.stepIndex + 1, activeRoute.steps.length - 1);
        const upcoming = activeRoute.steps[stepIdx];
        const verb = maneuverVerb(upcoming?.maneuver);
        return (
          <>
            {/* Right-edge Navigation Action Drawer — TOP of the right stack.
                Peeked 80% off-screen by default; tap the visible 20% edge to
                expand and see maneuver + End. Tap End → ends nav (which also
                takes the drawer off-screen with the route). */}
            <NavigationPanel
              visible={navDrawerOpen}
              onExpand={() => setNavDrawerOpen(true)}
              onCollapse={() => setNavDrawerOpen(false)}
              maneuverIcon={maneuverIcon(upcoming?.maneuver)}
              distance={fmtDistanceM(tbt.distanceToManeuverM)}
              instruction={`${verb}${upcoming?.html ? " · " + upcoming.html : ""}`}
              muted={navMuted}
              onToggleMute={() => setNavMuted((m) => !m)}
              onEnd={endNav}
            />
          </>
        );
      })()}

      {selected && !destination && (
        <Glass radius={20} style={styles.selectedCard}>
          <View style={styles.selRow}>
            <View style={[styles.hazardBubble, { backgroundColor: hazardColor(selected.kind) }]}>
              <Ionicons name={hazardIcon(selected.kind)} size={22} color="#fff" />
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
            <TouchableOpacity testID={`dispute-${selected.id}`} onPress={() => disputeHazard(selected)} style={[styles.voteBtn, styles.voteBtnDispute]} activeOpacity={0.85}>
              <Ionicons name="thumbs-down" size={16} color="#fff" />
              <Text style={styles.voteBtnText}>Not there</Text>
            </TouchableOpacity>
            <TouchableOpacity testID={`confirm-${selected.id}`} onPress={() => confirmHazard(selected)} style={[styles.voteBtn, styles.voteBtnConfirm]} activeOpacity={0.85}>
              <Ionicons name="thumbs-up" size={16} color="#fff" />
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
      <Speedometer speedMs={coords?.speed} speedLimit={speedLimitRef.current} unit={settings.speedUnit} />

      <PeerModal
        peer={selectedPeer ? { ...selectedPeer } as any : null}
        visible={!!selectedPeer}
        onClose={() => setSelectedPeer(null)}
        myCoords={coords}
      />

      {/* ===== Bottom-right floating cluster — Layers + Directions =====
          Layers FAB (top) opens a bottom sheet with map type & overlay
          toggles. Directions FAB (bottom) opens the search bar (mirrors
          Google Maps' teal turn-arrow FAB). Both are anchored above the
          tab bar with explicit bottom-right margins so they never collide
          with the speedometer HUD on the left. */}
      <View pointerEvents="box-none" style={styles.fabStack}>
        {/* Police report button — top of stack. One-tap: posts a hazard with
            kind='police' at the GPS sample closest to (now - 5s), shows a
            success toast, and fires a haptic on native. */}
        <TouchableOpacity
          testID="report-police-fab"
          style={styles.fab}
          onPress={() => reportAlert('police')}
          activeOpacity={0.75}
        >
          <Ionicons name="shield-checkmark" size={20} color="#3478F6" />
        </TouchableOpacity>
        {/* Road-hazard report button — same flow with kind='road'. */}
        <TouchableOpacity
          testID="report-hazard-fab"
          style={styles.fab}
          onPress={() => reportAlert('road')}
          activeOpacity={0.75}
        >
          <Ionicons name="warning" size={20} color="#FFD60A" />
        </TouchableOpacity>
        <TouchableOpacity
          testID="layers-fab"
          onPress={() => setLayersOpen(true)}
          activeOpacity={0.85}
          style={styles.fab}
        >
          <Ionicons name="layers" size={20} color="#fff" />
        </TouchableOpacity>
        {/* Stop Navigation — appears LEFT of the Directions FAB when a trip
            is active. Identical 42×42 footprint, red bg, white X. Tap to
            cancel the current route and drop back to free-roam map view. */}
        {(navMode === "turn-by-turn" || routes.length > 0) && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TouchableOpacity
              testID="stop-nav-fab"
              onPress={() => { endNav(); clearRoute(); }}
              activeOpacity={0.85}
              style={[styles.fab, styles.stopNavBtn]}
            >
              <Ionicons name="close" size={22} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              testID="directions-fab"
              onPress={() => { setSearchVisible(true); }}
              activeOpacity={0.85}
              style={[styles.fab, styles.fabPrimary]}
            >
              <Ionicons name="navigate" size={20} color="#fff" />
            </TouchableOpacity>
          </View>
        )}
        {!(navMode === "turn-by-turn" || routes.length > 0) && (
          <TouchableOpacity
            testID="directions-fab"
            onPress={() => { setSearchVisible(true); }}
            activeOpacity={0.85}
            style={[styles.fab, styles.fabPrimary]}
          >
            <Ionicons name="navigate" size={20} color="#fff" />
          </TouchableOpacity>
        )}
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
              {/* ----- MAP LAYERS ----- */}
              <Text style={styles.layerSectionHeader}>MAP LAYERS</Text>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Satellite</Text>
                  <Text style={styles.layerRowSub}>Aerial imagery</Text>
                </View>
                <Switch value={mapType === "hybrid"} onValueChange={(v) => setMapType(v ? "hybrid" : "roadmap")}
                  trackColor={{ false: '#3A3A3C', true: '#FFD60A' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Traffic overlay</Text>
                  <Text style={styles.layerRowSub}>Live congestion colors</Text>
                </View>
                <Switch value={showTraffic} onValueChange={setShowTraffic}
                  trackColor={{ false: '#3A3A3C', true: '#FFD60A' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Transit overlay</Text>
                  <Text style={styles.layerRowSub}>Buses, trains, subway</Text>
                </View>
                <Switch value={showTransit} onValueChange={setShowTransit}
                  trackColor={{ false: '#3A3A3C', true: '#FFD60A' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Hazards</Text>
                  <Text style={styles.layerRowSub}>Show community + Waze pins</Text>
                </View>
                <Switch value={showHazards} onValueChange={setShowHazards}
                  trackColor={{ false: '#3A3A3C', true: '#FFD60A' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>

              {/* ----- PRIVACY ----- */}
              <Text style={styles.layerSectionHeader}>PRIVACY</Text>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Avatar Live</Text>
                  <Text style={styles.layerRowSub}>Hide your car from the map</Text>
                </View>
                <Switch value={settings.avatarLive !== false} onValueChange={(v) => updateGlobalSettings({ avatarLive: v })}
                  trackColor={{ false: '#3A3A3C', true: '#FFD60A' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Comms Live</Text>
                  <Text style={styles.layerRowSub}>Mute push-to-talk audio</Text>
                </View>
                <Switch value={settings.commsLive !== false} onValueChange={(v) => updateGlobalSettings({ commsLive: v })}
                  trackColor={{ false: '#3A3A3C', true: '#FFD60A' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
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
                    <Ionicons name="checkmark" size={18} color="#FFD60A" />
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
                <Switch value={!!settings.avoidTolls} onValueChange={(v) => updateGlobalSettings({ avoidTolls: v })}
                  trackColor={{ false: '#3A3A3C', true: '#FFD60A' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Avoid Highways</Text>
                  <Text style={styles.layerRowSub}>Prefer surface streets</Text>
                </View>
                <Switch value={!!settings.avoidHighways} onValueChange={(v) => updateGlobalSettings({ avoidHighways: v })}
                  trackColor={{ false: '#3A3A3C', true: '#FFD60A' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Avoid Ferries</Text>
                  <Text style={styles.layerRowSub}>Skip water crossings</Text>
                </View>
                <Switch value={!!settings.avoidFerries} onValueChange={(v) => updateGlobalSettings({ avoidFerries: v })}
                  trackColor={{ false: '#3A3A3C', true: '#FFD60A' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>

              {/* ----- ALERTS ----- */}
              <Text style={styles.layerSectionHeader}>ALERTS</Text>
              <View style={styles.layerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Alert Sound</Text>
                  <Text style={styles.layerRowSub}>Chime on new hazard nearby</Text>
                </View>
                <Switch value={!!settings.alertSound} onValueChange={(v) => updateGlobalSettings({ alertSound: v })}
                  trackColor={{ false: '#3A3A3C', true: '#FFD60A' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
              </View>
              <View style={[styles.layerRow, { borderBottomWidth: 0 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.layerRowLabel}>Highlight Convoy Reports</Text>
                  <Text style={styles.layerRowSub}>Gold border on community pins</Text>
                </View>
                <Switch value={!!settings.highlightConvoy} onValueChange={(v) => updateGlobalSettings({ highlightConvoy: v })}
                  trackColor={{ false: '#3A3A3C', true: '#FFD60A' }} thumbColor="#FFFFFF" ios_backgroundColor="#3A3A3C" />
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

      {/* ===== Step Drawer — slide-up turn list =====
          Appears the moment a user taps a route. The active route's maneuvers
          are listed in a dark glassy panel that auto-tucks after 3s so the
          driver gets back to a clear chase-cam view. A small grab pill sits
          on the bottom edge to re-summon it; the drawer's top handle is
          draggable to dismiss with a fling. */}
      {routes.length > 0 && (
        <StepDrawer
          ref={stepDrawerRef}
          route={routes[0] as any}
          maneuverIcon={maneuverIcon}
        />
      )}
    </View>
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


// Community moderation: when disputes outweigh confirms by a margin, hide the hazard.
// (Server-side cleanup can also be added via a Supabase trigger or scheduled function.)
const isHazardVisible = (h: Hazard) => {
  const d = h.disputes || 0;
  const c = h.confirms || 1;
  return d < c + 2; // e.g. 0/1 visible, 1/1 visible, 2/1 visible, 3/1 hidden
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

  routeCard: { position: "absolute", left: 12, right: 12, bottom: 110, maxHeight: 460 },
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
  startBtnText: { color: "#fff", fontWeight: "700", fontSize: 15, letterSpacing: 0.3 },
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
  endNavFabText: { color: "#fff", fontWeight: "700", fontSize: 13, letterSpacing: 0.2 },
  etaBig: { color: COLORS.text, fontSize: 22, fontWeight: "700", letterSpacing: -0.4 },
  etaLabel: { color: COLORS.textDim, fontSize: 11, marginTop: 2, letterSpacing: 0.4 },
  etaDivider: { width: StyleSheet.hairlineWidth, height: 36, backgroundColor: COLORS.hairline },
  endBtn: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#FF3B30", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 14 },
  endBtnText: { color: "#fff", fontWeight: "700", letterSpacing: 0.3 },

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
  voteBtnText: { color: "#fff", fontWeight: "700", fontSize: 14, letterSpacing: 0.2 },
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
  // Legacy circular FAB styles kept for reference (now unused).
  fab: { position: "absolute", bottom: 120, right: 18, width: 60, height: 60, borderRadius: 30, overflow: "hidden" },
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
    gap: 8,                      // tighter gap between buttons
    alignItems: "center",
  },
  fab: {
    width: 42, height: 42,
    borderRadius: 10,
    backgroundColor: 'rgba(28,28,30,0.88)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  // Directions = primary action → Convoy blue. Same 42×42 footprint as the
  // others (was 44×44 in spec, but matching the rest reads cleaner).
  fabPrimary: { backgroundColor: "rgba(10,132,255,0.92)" },
  // Stop Navigation — red 42×42 button shown LEFT of Directions while a trip
  // is active. Same footprint, attention-grabbing red bg so the driver knows
  // exactly where to tap to bail out of nav.
  stopNavBtn: { backgroundColor: "#FF3B30" },
  // ===== Layers / Settings sheet =====
  // New grouped section headers + row styles. The legacy `layerRow` (icon +
  // toggle + chevron) below is left intact for any other consumers, but the
  // sheet itself now uses these layerRowLabel/Sub styles which take up the
  // text column when an inline `Switch` is the trailing element.
  layerSectionHeader: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 18,
    marginBottom: 6,
    paddingHorizontal: 18,
  },
  layerRowLabel: { color: '#FFFFFF', fontSize: 15, fontWeight: '500' },
  layerRowSub: { color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 2 },
  // Small badge with the active-alert count pinned to top-right of the Alerts FAB.
  fabBadge: {
    position: "absolute", top: -4, right: -4,
    minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: "#FF3B30",
    alignItems: "center", justifyContent: "center",
    paddingHorizontal: 5,
    borderWidth: 2, borderColor: "rgba(28,28,30,0.85)",
  },
  fabBadgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  // Tiny live-status pill that overlays the top edge of the search bar
  // (replaces the old dark header). Green dot + "X live · Y alerts" in a
  // glassy rounded chip — subtle, glanceable, never blocks the map.
  liveOverlay: {
    position: "absolute", top: -22, alignSelf: "center",
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 9, paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(28,28,30,0.78)",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.18)",
    zIndex: 5,
  },
  liveOverlayText: { color: "#fff", fontSize: 10, fontWeight: "600", letterSpacing: 0.2 },
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
  // Alerts sheet styles
  alertsGroup: { color: COLORS.textDim, fontSize: 11, fontWeight: "700", letterSpacing: 0.7, marginTop: 14, marginBottom: 4, textTransform: "uppercase" },
  alertsEmpty: { color: COLORS.textDim, fontSize: 13, textAlign: "center", marginTop: 22 },
  alertItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  distPill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, backgroundColor: "rgba(118,118,128,0.35)" },
  distPillText: { color: "#fff", fontSize: 11, fontWeight: "600" },
});
