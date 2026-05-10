import React, { useEffect, useRef, useState, useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, Platform, Image, Animated } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import * as Speech from "expo-speech";
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
  const wsRef = useRef<WebSocket | null>(null);

  const activeRoute: NavRoute | null = routes[selectedRouteIndex] || null;
  const encodedPolyline = activeRoute?.polyline || null;

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

  // Dispute = "not there anymore" → +1 disputes. When community downvotes
  // sufficiently, the hazard auto-hides (see filtering below).
  const disputeHazard = async (h: Hazard) => {
    try {
      if (SUPABASE_ENABLED && supabase) {
        // Try the disputes column first; gracefully ignore if it doesn't exist.
        const { error } = await supabase.from("hazards").update({ disputes: (h.disputes || 0) + 1 }).eq("id", h.id);
        if (error && /column.*disputes/i.test(error.message || "")) {
          // Column missing — fall back to expiring the hazard early so the dispute still has effect.
          await supabase.from("hazards").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", h.id);
        }
      } else {
        await api.post(`/hazards/${h.id}/dispute`).catch(() => {});
      }
      setSelected(null);
    } catch {}
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
        user={{ ...coords, heading: 0 }}
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
        onHazardPress={(h) => setSelected(h)}
        onPeerPress={(p) => {
          // Find the matching presence record (has online_at, etc.) — fallback to bare peer
          const full = presence.peers.find((pp) => pp.user_id === p.user_id);
          setSelectedPeer(full || { user_id: p.user_id, handle: p.handle, lat: p.lat, lng: p.lng, carType: p.carType });
        }}
        onExternalAlertPress={(a) => Alert.alert(`${a.type}${a.subtype ? " · " + a.subtype : ""}`, "Live alert from Convoy feed.")}
        onRoute={setRoute}
      />

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

        {Platform.OS === "web" ? (
          <View style={{ marginHorizontal: 12 }}>
            <DestinationSearch
              origin={coords}
              onSelect={(loc) => { setDestination(loc); setShowSteps(true); }}
              onClear={() => { setDestination(null); setRoute(null); setShowSteps(false); }}
            />
          </View>
        ) : (
          <View style={{ marginHorizontal: 12 }}>
            <DestinationSearch
              origin={coords}
              onSelect={(loc) => { setDestination(loc); setShowSteps(true); }}
              onClear={() => { setDestination(null); setRoute(null); setShowSteps(false); }}
            />
          </View>
        )}
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

      {/* ===== Route preview card (shown only when NOT actively navigating) ===== */}
      {destination && route && navMode === "preview" && (
        <Glass radius={20} style={styles.routeCard}>
          <View style={styles.routeRow}>
            <View style={styles.routeIcon}><Ionicons name="navigate" size={22} color="#fff" /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.routeTo} numberOfLines={1}>To {destination.label}</Text>
              <Text style={styles.routeMeta}>{route.duration_text} · {route.distance_text}{routes[selectedRouteIndex]?.summary ? ` · via ${routes[selectedRouteIndex].summary}` : ""}</Text>
            </View>
            <TouchableOpacity testID="route-clear" onPress={clearRoute} style={{ padding: 4 }}>
              <Ionicons name="close-circle" size={24} color={COLORS.textDim} />
            </TouchableOpacity>
          </View>

          {/* Alternates picker — tappable chips when there are >1 routes */}
          {routes.length > 1 && (
            <View style={styles.altsRow}>
              {routes.map((r, i) => {
                const sel = i === selectedRouteIndex;
                return (
                  <TouchableOpacity
                    key={i}
                    testID={`alt-${i}`}
                    onPress={() => setSelectedRouteIndex(i)}
                    activeOpacity={0.85}
                    style={[styles.altChip, sel && styles.altChipActive]}
                  >
                    <View style={[styles.altDot, { backgroundColor: sel ? "#0A84FF" : "#8E8E93" }]} />
                    <View>
                      <Text style={[styles.altDur, sel && { color: COLORS.text }]}>{r.duration_text}</Text>
                      <Text style={styles.altSum} numberOfLines={1}>{r.summary || (i === 0 ? "Fastest" : `Alt ${i}`)}</Text>
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

      {/* ===== Turn-by-turn navigation overlays ===== */}
      {navMode === "turn-by-turn" && activeRoute && tbt.active && (() => {
        const stepIdx = Math.min(tbt.stepIndex + 1, activeRoute.steps.length - 1); // upcoming step
        const upcoming = activeRoute.steps[stepIdx];
        const verb = maneuverVerb(upcoming?.maneuver);
        return (
          <>
            {/* Top maneuver banner */}
            <SafeAreaView edges={["top"]} style={styles.navTopWrap} pointerEvents="box-none">
              <Glass radius={20} style={styles.navTopCard}>
                <View style={styles.navTopRow}>
                  <View style={styles.maneuverBig}>
                    <Ionicons name={maneuverIcon(upcoming?.maneuver)} size={36} color="#fff" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.navDist}>{fmtDistanceM(tbt.distanceToManeuverM)}</Text>
                    <Text style={styles.navInst} numberOfLines={2}>{verb}{upcoming?.html ? " · " + upcoming.html : ""}</Text>
                  </View>
                  <TouchableOpacity testID="nav-mute" onPress={() => setNavMuted((m) => !m)} style={styles.navIconBtn}>
                    <Ionicons name={navMuted ? "volume-mute" : "volume-high"} size={20} color={COLORS.text} />
                  </TouchableOpacity>
                </View>
              </Glass>
            </SafeAreaView>

            {/* Bottom ETA + End bar */}
            <Glass radius={20} style={styles.navBottomCard}>
              <View style={styles.navBottomRow}>
                <View style={styles.etaBlock}>
                  <Text style={styles.etaBig}>{fmtEtaSec(tbt.etaSeconds)}</Text>
                  <Text style={styles.etaLabel}>ETA</Text>
                </View>
                <View style={styles.etaDivider} />
                <View style={styles.etaBlock}>
                  <Text style={styles.etaBig}>{fmtDistanceM(tbt.distanceRemainingM)}</Text>
                  <Text style={styles.etaLabel}>Remaining</Text>
                </View>
                <TouchableOpacity testID="end-nav" onPress={endNav} style={styles.endBtn} activeOpacity={0.85}>
                  <Ionicons name="close" size={20} color="#fff" />
                  <Text style={styles.endBtnText}>End</Text>
                </TouchableOpacity>
              </View>
            </Glass>
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

      {showReport && (
        <Glass radius={20} style={styles.reportPanel} testID="report-panel">
          {([["police", "shield-checkmark", "Police"], ["accident", "alert-circle", "Accident"], ["road", "warning", "Hazard"], ["traffic", "car", "Traffic"]] as const).map(([k, ico, lbl]) => (
            <TouchableOpacity key={k} testID={`report-${k}`} style={styles.reportBtn} onPress={() => reportHazard(k)}>
              <View style={[styles.reportIco, { backgroundColor: hazardColor(k) + "33" }]}>
                <Ionicons name={ico as any} size={18} color={hazardColor(k)} />
              </View>
              <Text style={styles.reportText}>{lbl}</Text>
            </TouchableOpacity>
          ))}
        </Glass>
      )}

      {/* ===== Speedometer HUD (bottom-left glass overlay) =====
          Pulls live speed from coords.speed (m/s) → km/h. Floors small values
          to 0 so a stationary GPS jitter doesn't read "1 km/h". */}
      <SpeedometerHUD speedMs={coords?.speed} />

      {/*
        Right-edge "peek tab" for the hazard reporter.
        - Anchored to the right edge of the screen.
        - INACTIVE: slides 67% off-screen, leaving ~33% of the square visible
          like a drawer pull. Tap once to slide it fully out + open the panel.
        - ACTIVE: fully on-screen at translateX = 0.
        We animate translateX with Animated.spring for a tactile feel.
      */}
      <ReportPeekTab
        active={showReport}
        onPress={() => setShowReport((s) => !s)}
      />

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
  navTopWrap: { position: "absolute", top: 0, left: 0, right: 0 },
  navTopCard: { marginHorizontal: 12, marginTop: 4 },
  navTopRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  maneuverBig: { width: 64, height: 64, borderRadius: 16, backgroundColor: "#0A84FF", alignItems: "center", justifyContent: "center" },
  navDist: { color: COLORS.text, fontSize: 26, fontWeight: "700", letterSpacing: -0.5 },
  navInst: { color: COLORS.textDim, fontSize: 13, marginTop: 2 },
  navIconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(118,118,128,0.32)", alignItems: "center", justifyContent: "center" },
  navBottomCard: { position: "absolute", left: 12, right: 12, bottom: 110 },
  navBottomRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 14 },
  etaBlock: { alignItems: "flex-start" },
  etaBig: { color: COLORS.text, fontSize: 22, fontWeight: "700", letterSpacing: -0.4 },
  etaLabel: { color: COLORS.textDim, fontSize: 11, marginTop: 2, letterSpacing: 0.4 },
  etaDivider: { width: StyleSheet.hairlineWidth, height: 36, backgroundColor: COLORS.hairline },
  endBtn: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#FF3B30", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 14 },
  endBtnText: { color: "#fff", fontWeight: "700", letterSpacing: 0.3 },

  selectedCard: { position: "absolute", left: 12, right: 12, bottom: 200 },
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
  // Speedometer HUD (bottom-left glass). Sits above the bottom nav so it never
  // gets covered by the safe-area band. Uses a tabular monospaced font so the
  // 1-3 digit number doesn't shift the layout as it ticks up/down while driving.
  speedHudWrap: { position: "absolute", left: 12, bottom: 130, zIndex: 6 },
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
