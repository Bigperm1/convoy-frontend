import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import { api, formatErr, wsUrl } from "../../src/api";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { useRouter } from "expo-router";
import Glass from "../../src/Glass";
import VoiceFAB from "../../src/VoiceFAB";
import ConvoyMap, { Hazard, Peer } from "../../src/ConvoyMap";
import DestinationSearch from "../../src/DestinationSearch";
import { supabase, SUPABASE_ENABLED, SupaHazard } from "../../src/supabase";

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
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [showReport, setShowReport] = useState(false);
  const [selected, setSelected] = useState<Hazard | null>(null);
  const [destination, setDestination] = useState<{ lat: number; lng: number; label: string } | null>(null);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [live, setLive] = useState<"connecting" | "live" | "off">("connecting");
  const wsRef = useRef<WebSocket | null>(null);

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

  const reportHazard = async (kind: string) => {
    if (!coords) return;
    const j = () => (Math.random() - 0.5) * 0.005;
    const lat = coords.lat + j(); const lng = coords.lng + j();
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
    } catch (e: any) {
      Alert.alert("Report failed", e?.message || formatErr(e));
    }
  };

  const confirmHazard = async (h: Hazard) => {
    try {
      if (SUPABASE_ENABLED && supabase) {
        await supabase.from("hazards").update({ confirms: (h.confirms || 1) + 1 }).eq("id", h.id);
      } else {
        await api.post(`/hazards/${h.id}/confirm`);
      }
    } catch {}
  };

  const hazardColor = (k: string) =>
    k === "police" ? "#3478F6" : k === "accident" ? COLORS.danger : k === "traffic" ? COLORS.warning : COLORS.warning;
  const hazardIcon = (k: string): any =>
    k === "police" ? "shield-checkmark" : k === "accident" ? "alert-circle" : k === "traffic" ? "car" : "warning";

  const onIntent = (intent: string | null) => {
    if (intent === "report_police") reportHazard("police");
    else if (intent === "report_accident") reportHazard("accident");
    else if (intent === "report_road") reportHazard("road");
    else if (intent === "report_traffic") reportHazard("traffic");
    else if (intent === "open_talk") router.push("/(app)/talk");
    else if (intent === "open_music") router.push("/(app)/music");
    else if (intent === "open_drive") router.push("/(app)/drive");
  };

  if (!coords) {
    return <View style={styles.loader}><Text style={{ color: COLORS.textDim }}>Locating…</Text></View>;
  }

  const peerList = Object.values(peers);
  const liveDot = live === "live" ? COLORS.success : live === "connecting" ? COLORS.warning : COLORS.danger;
  const liveText = live === "live" ? "Live" : live === "connecting" ? "Connecting" : "Offline";

  return (
    <View style={styles.c}>
      <ConvoyMap
        center={coords}
        user={{ ...coords, heading: 0 }}
        peers={peerList}
        hazards={hazards}
        destination={destination}
        onHazardPress={(h) => setSelected(h)}
        onRoute={setRoute}
      />

      <SafeAreaView edges={["top"]} style={styles.topBar} pointerEvents="box-none">
        <Glass radius={20} style={{ marginHorizontal: 12, marginBottom: 8 }}>
          <View style={styles.topRow}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={styles.title}>Map</Text>
                <View style={[styles.livePill, { borderColor: liveDot + "55" }]} testID="live-pill">
                  <View style={[styles.liveDot, { backgroundColor: liveDot }]} />
                  <Text style={[styles.liveText, { color: liveDot }]}>{liveText}</Text>
                </View>
              </View>
              <Text style={styles.sub}>{user?.handle} · {peerList.length} drivers · {hazards.length} alerts</Text>
            </View>
            <TouchableOpacity testID="refresh-btn" onPress={() => loadPeers()} style={styles.iconBtn}>
              <Ionicons name="refresh" size={18} color={COLORS.text} />
            </TouchableOpacity>
          </View>
        </Glass>

        {Platform.OS === "web" && (
          <View style={{ marginHorizontal: 12 }}>
            <DestinationSearch
              origin={coords}
              onSelect={(loc) => { setDestination(loc); setShowSteps(true); }}
              onClear={() => { setDestination(null); setRoute(null); setShowSteps(false); }}
            />
          </View>
        )}
      </SafeAreaView>

      {destination && route && (
        <Glass radius={20} style={styles.routeCard}>
          <TouchableOpacity testID="route-toggle" onPress={() => setShowSteps((s) => !s)} activeOpacity={0.85}>
            <View style={styles.routeRow}>
              <View style={styles.routeIcon}><Ionicons name="navigate" size={22} color="#fff" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.routeTo} numberOfLines={1}>To {destination.label}</Text>
                <Text style={styles.routeMeta}>{route.duration_text} · {route.distance_text}</Text>
              </View>
              <Ionicons name={showSteps ? "chevron-down" : "chevron-up"} size={20} color={COLORS.textDim} />
              <TouchableOpacity testID="route-clear" onPress={() => { setDestination(null); setRoute(null); setShowSteps(false); }} style={{ marginLeft: 6 }}>
                <Ionicons name="close-circle" size={22} color={COLORS.textDim} />
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
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

      {selected && !destination && (
        <Glass radius={20} style={styles.selectedCard}>
          <View style={{ padding: 14, flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={[styles.hazardBubble, { backgroundColor: hazardColor(selected.kind) }]}>
              <Ionicons name={hazardIcon(selected.kind)} size={22} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.selTitle}>{selected.kind.charAt(0).toUpperCase() + selected.kind.slice(1)}</Text>
              <Text style={styles.selSub}>by {selected.reporter_handle || "anon"} · {selected.confirms || 1} confirms</Text>
            </View>
            <TouchableOpacity testID={`confirm-${selected.id}`} onPress={() => confirmHazard(selected)} style={styles.confirmBtn}>
              <Text style={styles.confirmText}>+1</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setSelected(null)} style={{ padding: 6 }}>
              <Ionicons name="close" size={20} color={COLORS.textDim} />
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

      <TouchableOpacity testID="report-fab" style={styles.fab} onPress={() => setShowReport((s) => !s)} activeOpacity={0.85}>
        <View style={styles.fabInner}>
          <Ionicons name={showReport ? "close" : "add"} size={28} color="#fff" />
        </View>
      </TouchableOpacity>

      <VoiceFAB onIntent={onIntent} />
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
  };
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: "#0A1410" },
  loader: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg },

  topBar: { position: "absolute", top: 0, left: 0, right: 0 },
  topRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  title: { color: COLORS.text, fontSize: 26, fontWeight: "700", letterSpacing: -0.6 },
  sub: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(118,118,128,0.32)", alignItems: "center", justifyContent: "center" },

  livePill: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, backgroundColor: "rgba(255,255,255,0.05)" },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  liveText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },

  hazardBubble: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(255,255,255,0.85)" },

  routeCard: { position: "absolute", left: 12, right: 12, bottom: 110, maxHeight: 360 },
  routeRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  routeIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.primary, alignItems: "center", justifyContent: "center" },
  routeTo: { color: COLORS.text, fontWeight: "600", fontSize: 15 },
  routeMeta: { color: COLORS.success, fontSize: 13, marginTop: 2, fontWeight: "500" },
  stepsList: { maxHeight: 260, paddingHorizontal: 14, paddingTop: 0 },
  stepRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.hairline },
  stepIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: COLORS.primary + "22", alignItems: "center", justifyContent: "center" },
  stepText: { color: COLORS.text, flex: 1, fontSize: 13, lineHeight: 18 },
  stepDist: { color: COLORS.textDim, fontSize: 12 },

  selectedCard: { position: "absolute", left: 12, right: 12, bottom: 200 },
  selTitle: { color: COLORS.text, fontWeight: "600", fontSize: 16 },
  selSub: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  confirmBtn: { paddingHorizontal: 14, paddingVertical: 10, backgroundColor: COLORS.primary + "33", borderRadius: 12, borderWidth: 1, borderColor: COLORS.primary + "55" },
  confirmText: { color: COLORS.primary, fontWeight: "700" },

  fab: { position: "absolute", bottom: 120, right: 18, width: 60, height: 60, borderRadius: 30, overflow: "hidden" },
  fabInner: { flex: 1, backgroundColor: COLORS.primary, alignItems: "center", justifyContent: "center" },

  reportPanel: { position: "absolute", bottom: 190, right: 18, padding: 4, minWidth: 170 },
  reportBtn: { flexDirection: "row", alignItems: "center", padding: 10, gap: 12 },
  reportIco: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  reportText: { color: COLORS.text, fontWeight: "500", fontSize: 14 },
});
