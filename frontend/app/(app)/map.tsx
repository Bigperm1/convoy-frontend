import React, { useEffect, useRef, useState, useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, Platform, Image, Animated } from "react-native";
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
import { useExternalAlerts, registerExternalFeedBackgroundTask } from "../../src/externalFeed";
import { useSettings } from "../../src/settings";
import { useConvoyPresence, ConvoyPresencePeer } from "../../src/convoyPresence";
import PeerModal from "../../src/PeerModal";
import {
  fetchDirections, NavRoute, useTurnByTurn, maneuverVerb,
  fmtDistanceM, fmtEtaSec,
} from "../../src/nav";
import { useCommunityRoutes, createCommunityRoute, CommunityRoute } from "../../src/communityRoutes";

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

  // ----- External alerts feed (Waze-style polling, dedup + auto-clear) -----
  const externalFeed = useExternalAlerts(60_000);
  const [settings] = useSettings();
  useEffect(() => {
    // Best-effort iOS/Android background fetch (≥15min cadence). Foreground polling above is the primary path.
    registerExternalFeedBackgroundTask().catch(() => {});
  }, []);

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
  // The "Route Line" = blue selected route; alternates render gray and are tappable to swap.
  // Honors avoid-tolls/highways/ferries route preferences from settings.
  useEffect(() => {
    if (!destination || !coords) {
      setRoutes([]); setSelectedRouteIndex(0); setRoute(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const results = await fetchDirections(coords, destination, {
        tolls: settings.avoidTolls,
        highways: settings.avoidHighways,
        ferries: settings.avoidFerries,
      });
      if (cancelled) return;
      setRoutes(results);
      setSelectedRouteIndex(0);
      const r0 = results[0];
      setRoute(r0 ? {
        distance_text: r0.distance_text,
        duration_text: r0.duration_text,
        steps: r0.steps.map((s) => ({ html: s.html, distance_text: s.distance_text, maneuver: s.maneuver })),
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
  const clearRoute = () => {
    Speech.stop();
    setDestination(null);
    setRoutes([]);
    setRoute(null);
    setShowSteps(false);
    setNavMode("preview");
  };

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
  // Updates `coords.heading` as the user drives so the car silhouette on the
  // map rotates the right way. Uses moderate frequency to keep battery sane.
  useEffect(() => {
    let sub: any = null;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") return;
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: 4000, distanceInterval: 8 },
          (pos) => {
            const h = pos.coords.heading;
            const heading = typeof h === "number" && h >= 0 ? h : undefined;
            const sRaw = pos.coords.speed;
            const speed = typeof sRaw === "number" && sRaw >= 0 ? sRaw : undefined;
            setCoords((cur) => ({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              heading: heading ?? cur?.heading,
              speed: speed ?? cur?.speed,
            }));
            // Personal-best tracking: convert m/s → km/h, ignore stationary jitter (<1 km/h)
            if (typeof speed === "number") {
              const kmh = speed * 3.6;
              if (kmh >= 1) {
                setSessionMaxSpeed((m) => (kmh > m ? kmh : m));
              }
            }
          }
        );
      } catch {}
    })();
    return () => { try { sub?.remove?.(); } catch {} };
  }, []);

  // ----- Hazards: Supabase Realtime subscription (with REST fallback) -----
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

    if (!SUPABASE_ENABLED || !supabase) { setLive("off"); return; }

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
  // Channel name follows the active community in Coms. Falls back to global.
  const presenceChannel = settings.activeCommunityId
    ? `convoy:community:${settings.activeCommunityId}`
    : "convoy:global";

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
        peers={peerList}
        leaderUserId={leaderUserId}
        hazards={visibleHazards}
        externalAlerts={externalFeed.alerts}
        highlightConvoy={settings.highlightConvoy}
        destination={destination}
        encodedPolyline={encodedPolyline}
        routes={routes}
        selectedRouteIndex={selectedRouteIndex}
        onSelectRoute={(i) => setSelectedRouteIndex(i)}
        followUser={navMode === "turn-by-turn"}
        // Chase-cam (3D, heading-rotated, dynamic-zoom) is on whenever turn-
        // by-turn nav is actively running. Pitch defaults to 45° in ConvoyMap.
        navigationActive={navMode === "turn-by-turn" && tbt.active}
        userSpeedMs={coords?.speed}
        // Tap on empty map → close any open search overlay so the driver can
        // peek at the map fullscreen mid-trip without ending navigation.
        onMapPress={() => { if (searchVisible) setSearchVisible(false); }}
        onHazardPress={(h) => setSelected(h)}
        onPeerPress={(p) => {
          // Find the matching presence record (has online_at, etc.) — fallback to bare peer
          const full = presence.peers.find((pp) => pp.user_id === p.user_id);
          setSelectedPeer(full || { user_id: p.user_id, handle: p.handle, lat: p.lat, lng: p.lng, carType: p.carType });
        }}
        onExternalAlertPress={(a) => Alert.alert(`${a.type}${a.subtype ? " · " + a.subtype : ""}`, "Live alert from Convoy feed.")}
        onRoute={setRoute}
      />

      {/* Header card + search bar — both hidden in full-screen map mode
          (i.e. when searchVisible=false). The 🔍 FAB below is the only
          way back to them, keeping the entire screen for the map. */}
      {searchVisible && (
        <SafeAreaView edges={["top"]} style={styles.topBar} pointerEvents="box-none">
        <Glass radius={20} style={{ marginHorizontal: 12, marginBottom: 8 }}>
          <View style={styles.topRow}>
            <Image source={require("../../assets/images/brand-mark.png")} style={styles.headerMark} resizeMode="contain" />
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={styles.title}>Map</Text>
                <View style={[styles.livePill, { borderColor: liveDot + "55" }]} testID="live-pill">
                  <View style={[styles.liveDot, { backgroundColor: liveDot }]} />
                  <Text style={[styles.liveText, { color: liveDot }]}>{liveText}</Text>
                </View>
              </View>
              <Text style={styles.sub}>{user?.handle} · {peerList.length} drivers · {visibleHazards.length} alerts · {externalFeed.alerts.length} live</Text>
            </View>
            <TouchableOpacity testID="refresh-btn" onPress={() => loadPeers()} style={styles.iconBtn}>
              <Ionicons name="refresh" size={18} color={COLORS.text} />
            </TouchableOpacity>
            <TouchableOpacity testID="settings-btn" onPress={() => router.push("/(app)/settings" as any)} style={styles.iconBtn}>
              <Ionicons name="options-outline" size={18} color={COLORS.text} />
            </TouchableOpacity>
          </View>
        </Glass>

        {searchVisible && (Platform.OS === "web" ? (
          <View style={{ marginHorizontal: 12 }}>
            <DestinationSearch
              origin={coords}
              onSelect={(loc) => { setDestination(loc); setShowSteps(true); setSearchVisible(false); }}
              onClear={() => { setDestination(null); setRoute(null); setShowSteps(false); setSearchVisible(true); }}
            />
          </View>
        ) : (
          <View style={{ marginHorizontal: 12 }}>
            <DestinationSearch
              origin={coords}
              onSelect={(loc) => { setDestination(loc); setShowSteps(true); setSearchVisible(false); }}
              onClear={() => { setDestination(null); setRoute(null); setShowSteps(false); setSearchVisible(true); }}
            />
          </View>
        ))}
      </SafeAreaView>
      )}

      {/* Magnifier ⇄ Close toggle FAB.
          - When search is hidden → 🔍 (tap to reveal header + search)
          - When search is shown  → ✕ (tap to dismiss)
          Always rendered so the driver always has a one-tap way to flip
          between fullscreen-map and search modes. */}
      <SafeAreaView edges={["top"]} pointerEvents="box-none" style={styles.searchFabWrap}>
        <TouchableOpacity
          testID="show-search-fab"
          onPress={() => setSearchVisible((v) => !v)}
          activeOpacity={0.85}
          style={styles.searchFab}
        >
          <Ionicons name={searchVisible ? "close" : "search"} size={20} color="#fff" />
        </TouchableOpacity>
      </SafeAreaView>

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

      {/* ===== Turn-by-turn overlays — ETA pill + right-edge nav drawer ===== */}
      {navMode === "turn-by-turn" && activeRoute && tbt.active && (() => {
        const stepIdx = Math.min(tbt.stepIndex + 1, activeRoute.steps.length - 1);
        const upcoming = activeRoute.steps[stepIdx];
        const verb = maneuverVerb(upcoming?.maneuver);
        return (
          <>
            {/* Bottom-right ETA pill — bottom of the right-side stack.
                Sits below the Hazard drawer and above the Hub tab icon. */}
            <Glass radius={16} style={styles.tripDataRight}>
              <View style={styles.tripDataInner}>
                <Text style={styles.tripDataValue}>{fmtEtaSec(tbt.etaSeconds)}</Text>
                <Text style={styles.tripDataLabel}>ETA</Text>
                <View style={styles.tripDataDivider} />
                <Text style={styles.tripDataValue}>{fmtDistanceM(tbt.distanceRemainingM)}</Text>
                <Text style={styles.tripDataLabel}>Remaining</Text>
              </View>
            </Glass>

            {/* Right-edge Navigation Action Drawer — TOP of the right stack.
                Peeked 80% off-screen by default; tap the visible 20% edge to
                expand and see maneuver + End. Tap End → ends nav (which also
                takes the drawer off-screen with the route). */}
            <NavActionDrawer
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

      {/* ---- Right-edge peek drawer ----
           Sits 75% off-screen by default, leaving just the leading edge of
           the Police + Hazard icons visible ("drawer pull" affordance).
           Tap the peeking edge → animates fully out. Tap an icon (when
           fully out) → reports to Supabase + auto-snaps back to peek.
           Replaces the previous <ReportPeekTab> blue-tab entirely. */}
      <HazardDrawer
        visible={showReport}
        onExpand={() => setShowReport(true)}
        onCollapse={() => setShowReport(false)}
        onReport={(kind) => reportHazard(kind)}
      />

      {/* ===== Speedometer HUD (bottom-left glass overlay) =====
          Pulls live speed from coords.speed (m/s) → km/h. Floors small values
          to 0 so a stationary GPS jitter doesn't read "1 km/h". */}
      <SpeedometerHUD speedMs={coords?.speed} />

      <PeerModal
        peer={selectedPeer ? { ...selectedPeer } as any : null}
        visible={!!selectedPeer}
        onClose={() => setSelectedPeer(null)}
        myCoords={coords}
      />
    </View>
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

// Right-edge "peek tab" for hazard reporting.
// Inactive: tucked off-screen with ~33% peeking out (drawer-pull affordance).
// Active: animated slide to fully-visible at the right edge of the screen.
const PEEK_W = 56;          // square edge length
const PEEK_VISIBLE_RATIO = 0.33;
const PEEK_HIDDEN_TX = PEEK_W * (1 - PEEK_VISIBLE_RATIO); // 67% off-screen

// Speedometer HUD — bottom-left glass overlay.
// Pulls speed (m/s) from the location watcher, converts to km/h (×3.6),
// and floors to 0 below 1 km/h so a stationary GPS doesn't read "1".
//
// Smoothing buffer: GPS speed momentarily drops to 0 mid-drive (tunnel,
// urban canyon, brief signal stutter). Without smoothing the HUD flickers
// 65 → 0 → 65 in under a second. We hold the previous reading for up to
// HOLD_MS (2s) before allowing it to fall to 0. Any non-zero reading
// resets the hold and updates immediately.
const SPEEDO_HOLD_MS = 2000;
function SpeedometerHUD({ speedMs }: { speedMs?: number }) {
  // rawKmh: this tick's converted speed (>=1 km/h or 0)
  const rawKmh = (() => {
    if (typeof speedMs !== "number" || !Number.isFinite(speedMs) || speedMs < 0) return 0;
    const v = speedMs * 3.6;
    return v < 1 ? 0 : Math.round(v);
  })();

  // displayKmh: what the UI actually shows. Starts at 0 and only falls to 0
  // after we've held the last positive value for SPEEDO_HOLD_MS.
  const [displayKmh, setDisplayKmh] = useState(0);
  // Last non-zero reading + timestamp — survives across renders.
  const lastNonZeroRef = useRef<{ value: number; ts: number }>({ value: 0, ts: 0 });
  // Pending fall-to-zero timer so we can cancel if speed comes back.
  const fallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Always clear any in-flight fall-to-zero whenever a new reading arrives.
    if (fallTimerRef.current) {
      clearTimeout(fallTimerRef.current);
      fallTimerRef.current = null;
    }

    if (rawKmh > 0) {
      // Live speed — show immediately, remember it.
      lastNonZeroRef.current = { value: rawKmh, ts: Date.now() };
      setDisplayKmh(rawKmh);
      return;
    }

    // rawKmh === 0. If we have a recent positive reading, hold it briefly.
    const last = lastNonZeroRef.current;
    const elapsed = Date.now() - last.ts;
    if (last.value > 0 && elapsed < SPEEDO_HOLD_MS) {
      // Keep showing the last value — don't update state, just schedule fall.
      const remaining = SPEEDO_HOLD_MS - elapsed;
      fallTimerRef.current = setTimeout(() => {
        // Only fall to 0 if we haven't seen a positive reading since.
        if (lastNonZeroRef.current.ts === last.ts) {
          setDisplayKmh(0);
        }
      }, remaining);
    } else {
      // No recent positive reading — drop to 0 immediately.
      setDisplayKmh(0);
    }
  }, [rawKmh]);

  // Cleanup the timer on unmount.
  useEffect(() => () => {
    if (fallTimerRef.current) clearTimeout(fallTimerRef.current);
  }, []);

  return (
    <View style={styles.speedHudWrap} pointerEvents="none">
      <Glass radius={14} style={styles.speedHud}>
        <View style={styles.speedHudInner}>
          <Text style={styles.speedHudValue}>{displayKmh}</Text>
          <Text style={styles.speedHudUnit}>KM/H</Text>
        </View>
      </Glass>
    </View>
  );
}
/**
 * Right-edge peek drawer.
 *
 * Two states animated via translateX:
 *   - peeked  (default, !visible) — 75% off-screen, only the leading edge of
 *             the icons sticks out as a "drawer pull" affordance.
 *   - open    (visible=true)      — translateX = 0, full icons visible.
 *
 * Tapping the peek edge fires `onExpand` (parent flips visible→true).
 * Tapping an icon when OPEN fires `onReport(kind)` (parent inserts into
 * Supabase + sets visible→false, auto-snapping back to peek).
 *
 * Accident + Traffic deliberately removed — high-priority only.
 */
const DRAWER_W = 84;                  // outer width of the drawer (icon + padding)
const DRAWER_PEEK_TX = DRAWER_W * 0.80; // 80% off-screen when peeked (per spec)
function HazardDrawer({
  visible,
  onExpand,
  onCollapse,
  onReport,
}: {
  visible: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onReport: (kind: string) => void;
}) {
  const tx = useRef(new Animated.Value(visible ? 0 : DRAWER_PEEK_TX)).current;
  useEffect(() => {
    Animated.spring(tx, {
      toValue: visible ? 0 : DRAWER_PEEK_TX,
      useNativeDriver: true,
      friction: 9,
      tension: 80,
    }).start();
  }, [visible, tx]);

  // Auto-collapse after 5 s of no interaction. Cleared/reset on tap (since the
  // tap will either fire a report — which collapses anyway — or, when peeked,
  // expand and start a fresh 5 s window). Without this the drawer stays open
  // forever if the driver glances away mid-trip and forgets it.
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => onCollapse(), 5000);
    return () => clearTimeout(t);
  }, [visible, onCollapse]);

  const handle = (kind: string) => {
    if (!visible) {
      onExpand();
      return;
    }
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch {}
    onReport(kind);
  };

  return (
    <Animated.View
      style={[styles.drawerWrap, { transform: [{ translateX: tx }] }]}
      testID="report-panel"
    >
      <Glass radius={20}>
        <View style={styles.drawerInner}>
          {/* Police (blue) */}
          <TouchableOpacity
            testID="report-police"
            onPress={() => handle("police")}
            activeOpacity={0.85}
            style={[styles.drawerBtn, { backgroundColor: "rgba(10,132,255,0.18)", borderColor: "rgba(10,132,255,0.55)" }]}
          >
            <Ionicons name="shield-checkmark" size={26} color="#0A84FF" />
            <Text style={[styles.drawerBtnText, { color: "#0A84FF" }]}>Police</Text>
          </TouchableOpacity>

          {/* Hazard (orange) — wire schema kind = 'road' to match
              HAZARDS_SUPABASE_SETUP.md check constraint. */}
          <TouchableOpacity
            testID="report-road"
            onPress={() => handle("road")}
            activeOpacity={0.85}
            style={[styles.drawerBtn, { backgroundColor: "rgba(255,159,10,0.18)", borderColor: "rgba(255,159,10,0.55)" }]}
          >
            <Ionicons name="warning" size={26} color="#FF9F0A" />
            <Text style={[styles.drawerBtnText, { color: "#FF9F0A" }]}>Hazard</Text>
          </TouchableOpacity>
        </View>
      </Glass>
    </Animated.View>
  );
}

/**
 * Navigation Action Drawer — peeked 80% off-screen on the right edge,
 * positioned ABOVE the HazardDrawer in the right-side stack.
 *
 * Peeked state shows just the maneuver-icon glyph as a "drawer pull".
 * Tap → expands fully and reveals:
 *    - Big maneuver arrow + distance to next turn
 *    - Truncated step instruction
 *    - Mute toggle
 *    - End-nav red button
 *
 * Replaces the previous full-width top maneuver banner and the bottom-LEFT
 * red End pill — both are now nested in this single right-side drawer to
 * keep the chase-cam center clear (per the "open the middle of the map"
 * directive).
 */
function NavActionDrawer({
  visible,
  onExpand,
  onCollapse,
  maneuverIcon,
  distance,
  instruction,
  muted,
  onToggleMute,
  onEnd,
}: {
  visible: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  maneuverIcon: any;
  distance: string;
  instruction: string;
  muted: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
}) {
  const tx = useRef(new Animated.Value(visible ? 0 : DRAWER_PEEK_TX)).current;
  useEffect(() => {
    Animated.spring(tx, {
      toValue: visible ? 0 : DRAWER_PEEK_TX,
      useNativeDriver: true,
      friction: 9,
      tension: 80,
    }).start();
  }, [visible, tx]);

  // 5 s auto-collapse — same pattern as HazardDrawer. Cleared on unmount or
  // visible→false. The driver shouldn't have to dig out of an open nav
  // overlay if they bumped it accidentally; the chase-cam stays unobstructed.
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => onCollapse(), 5000);
    return () => clearTimeout(t);
  }, [visible, onCollapse]);

  // Peeked: tapping the leading edge expands.
  // Open: tap on a button executes that action; tap on the bare maneuver
  // glyph (where there's no nested button) collapses back to peek.
  if (!visible) {
    return (
      <Animated.View
        style={[styles.navDrawerWrap, { transform: [{ translateX: tx }] }]}
        testID="nav-drawer"
      >
        <TouchableOpacity onPress={onExpand} activeOpacity={0.85}>
          <Glass radius={20}>
            <View style={styles.navDrawerPeek}>
              <Ionicons name={maneuverIcon} size={26} color="#fff" />
            </View>
          </Glass>
        </TouchableOpacity>
      </Animated.View>
    );
  }
  return (
    <Animated.View
      style={[styles.navDrawerWrap, { transform: [{ translateX: tx }] }]}
      testID="nav-drawer-open"
    >
      <Glass radius={20}>
        <View style={styles.navDrawerOpen}>
          {/* Maneuver glyph + distance — tappable to collapse back to peek */}
          <TouchableOpacity onPress={onCollapse} activeOpacity={0.85} style={styles.navDrawerHeader}>
            <Ionicons name={maneuverIcon} size={28} color="#fff" />
            <Text style={styles.navDrawerDist}>{distance}</Text>
          </TouchableOpacity>
          {/* Step instruction (truncated) */}
          <Text style={styles.navDrawerInst} numberOfLines={3}>{instruction}</Text>
          {/* Mute toggle */}
          <TouchableOpacity testID="nav-mute" onPress={onToggleMute} style={styles.navDrawerBtn} activeOpacity={0.85}>
            <Ionicons name={muted ? "volume-mute" : "volume-high"} size={18} color="#fff" />
            <Text style={styles.navDrawerBtnText}>{muted ? "Muted" : "Sound"}</Text>
          </TouchableOpacity>
          {/* End nav (red) */}
          <TouchableOpacity testID="end-nav" onPress={onEnd} style={[styles.navDrawerBtn, styles.navDrawerEndBtn]} activeOpacity={0.85}>
            <Ionicons name="close" size={18} color="#fff" />
            <Text style={styles.navDrawerBtnText}>End</Text>
          </TouchableOpacity>
        </View>
      </Glass>
    </Animated.View>
  );
}


function ReportPeekTab({ active, onPress }: { active: boolean; onPress: () => void }) {
  const tx = useRef(new Animated.Value(active ? 0 : PEEK_HIDDEN_TX)).current;
  useEffect(() => {
    Animated.spring(tx, {
      toValue: active ? 0 : PEEK_HIDDEN_TX,
      useNativeDriver: true,
      friction: 9,
      tension: 90,
    }).start();
  }, [active, tx]);
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.peekWrap, { transform: [{ translateX: tx }] }]}
    >
      <TouchableOpacity
        testID="report-fab"
        onPress={onPress}
        activeOpacity={0.85}
        style={styles.peekBtn}
      >
        <LinearGradient
          colors={active ? ["#FF453A", "#A6201E"] : [COLORS.primary, COLORS.primaryDim]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <Ionicons name={active ? "close" : "warning"} size={26} color="#fff" />
      </TouchableOpacity>
    </Animated.View>
  );
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

  topBar: { position: "absolute", top: 0, left: 0, right: 0 },
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

  // Magnifier FAB — appears top-right when the search bar is hidden
  // (e.g. once navigation has started). Tucked just below the header
  // safe-area band so it doesn't clip with the title pill.
  searchFabWrap: { position: "absolute", top: 0, right: 0, padding: 12, zIndex: 7 },
  searchFab: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: "center", justifyContent: "center",
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
  speedHudWrap: {
    position: "absolute",
    left: 12,
    bottom: 100,           // tab bar (~85) + small gap so it sits above the Map icon
    zIndex: 6,
  },
  speedHud: { },
  speedHudInner: {
    minWidth: 92,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: "center",
  },
  speedHudValue: {
    color: "#FFC700",
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: 1,
    lineHeight: 32,
    fontVariant: ["tabular-nums"],
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      web: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
      default: "monospace",
    }) as any,
    textShadowColor: "rgba(255,199,0,0.45)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  },
  speedHudUnit: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.6,
    marginTop: 2,
  },
  peekWrap: { position: "absolute", right: 0, bottom: 130, width: 56, height: 56 },
  peekBtn: {
    width: 56, height: 56,
    borderTopLeftRadius: 14, borderBottomLeftRadius: 14,
    borderTopRightRadius: 0, borderBottomRightRadius: 0,
    overflow: "hidden",
    alignItems: "center", justifyContent: "center",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: -2, height: 6 } },
      android: { elevation: 8 },
      web: { boxShadow: "-4px 6px 18px rgba(0,0,0,0.4)" } as any,
    }),
  },
  // Legacy circular FAB styles kept for reference (now unused).
  fab: { position: "absolute", bottom: 120, right: 18, width: 60, height: 60, borderRadius: 30, overflow: "hidden" },
  fabInner: { flex: 1, backgroundColor: COLORS.primary, alignItems: "center", justifyContent: "center" },

  reportPanel: { position: "absolute", bottom: 190, right: 18, padding: 4, minWidth: 170 },

  // Slim slide-out hazard drawer — anchored right edge, sits in the MIDDLE
  // of the right-side stack: NavActionDrawer above, ETA pill below.
  drawerWrap: {
    position: "absolute",
    right: 0,            // flush to the edge — only 20% sticks out by default
    bottom: 220,         // leaves room for ETA pill at bottom: 100
    zIndex: 8,
  },
  drawerInner: {
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 10,
    flexDirection: "column",
  },
  drawerBtn: {
    width: 64,
    height: 64,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  drawerBtnText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.4, marginTop: 2 },

  // ---- Right-edge Navigation Action Drawer ----
  // Sits ABOVE the HazardDrawer in the right-side stack. Same peek pattern.
  // When peeked: only the maneuver glyph leading edge sticks out (20%).
  // When open: full vertical column with maneuver, instruction, mute, End.
  navDrawerWrap: {
    position: "absolute",
    right: 0,
    bottom: 360,         // sits above HazardDrawer (which is at bottom: 220)
    zIndex: 9,
  },
  navDrawerPeek: {
    width: 64,
    height: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  navDrawerOpen: {
    width: 180,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  navDrawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  navDrawerDist: { color: "#fff", fontWeight: "800", fontSize: 18, letterSpacing: -0.3 },
  navDrawerInst: { color: COLORS.text, fontSize: 13, lineHeight: 18 },
  navDrawerBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.18)",
  },
  navDrawerEndBtn: {
    backgroundColor: "#FF3B30",
    borderColor: "rgba(255,255,255,0)",
  },
  navDrawerBtnText: { color: "#fff", fontSize: 12, fontWeight: "700", letterSpacing: 0.4 },
  reportBtn: { flexDirection: "row", alignItems: "center", padding: 10, gap: 12 },
  reportIco: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  reportText: { color: COLORS.text, fontWeight: "500", fontSize: 14 },

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
});
