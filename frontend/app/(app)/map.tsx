import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, Dimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import Svg, { Circle, Line, Path, Polygon, G } from "react-native-svg";
import { api, formatErr, wsUrl } from "../../src/api";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { useRouter } from "expo-router";
import VoiceFAB from "../../src/VoiceFAB";

const { width } = Dimensions.get("window");
const RADAR = Math.min(width - 32, 380);

type Hazard = { id: string; kind: string; lat: number; lng: number; note?: string; reporter_handle?: string; created_at: string; confirms?: number };
type Peer = { user_id: string; handle?: string; lat: number; lng: number; heading?: number; speed?: number };

export default function MapScreen() {
  const { user, token } = useAuth();
  const router = useRouter();
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [showReport, setShowReport] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      let lat = 37.7749, lng = -122.4194;
      if (status === "granted") {
        try {
          const pos = await Location.getCurrentPositionAsync({});
          lat = pos.coords.latitude;
          lng = pos.coords.longitude;
        } catch {}
      }
      setCoords({ lat, lng });
      try {
        await api.post("/location", { lat, lng, speed: 0, heading: 0 });
      } catch {}
      loadHazards();
      loadNearby();
    })();
  }, []);

  // WebSocket
  useEffect(() => {
    if (!token) return;
    const ws = new WebSocket(wsUrl(token));
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "hazard") {
          setHazards((h) => [msg.hazard, ...h.filter((x) => x.id !== msg.hazard.id)]);
        } else if (msg.type === "location" && msg.user_id !== user?.id) {
          setPeers((p) => ({ ...p, [msg.user_id]: { ...p[msg.user_id], ...msg } }));
        }
      } catch {}
    };
    return () => ws.close();
  }, [token, user?.id]);

  const loadHazards = async () => {
    try {
      const { data } = await api.get("/hazards");
      setHazards(data);
    } catch (e) { /* noop */ }
  };
  const loadNearby = async () => {
    try {
      const { data } = await api.get("/users/nearby");
      const map: Record<string, Peer> = {};
      data.forEach((u: any) => { if (u.lat && u.lng) map[u.id] = { user_id: u.id, handle: u.handle, lat: u.lat, lng: u.lng, heading: u.heading, speed: u.speed }; });
      setPeers(map);
    } catch {}
  };

  const reportHazard = async (kind: string) => {
    if (!coords) return;
    try {
      const jitter = () => (Math.random() - 0.5) * 0.005;
      await api.post("/hazards", { kind, lat: coords.lat + jitter(), lng: coords.lng + jitter(), note: "" });
      setShowReport(false);
      loadHazards();
    } catch (e) {
      Alert.alert("Report failed", formatErr(e));
    }
  };

  // Convert lat/lng to radar coordinates (approx miles offset)
  const projected = useMemo(() => {
    if (!coords) return { hazards: [], peers: [] };
    const toXY = (lat: number, lng: number) => {
      const dx = (lng - coords.lng) * Math.cos((coords.lat * Math.PI) / 180) * 111000; // meters
      const dy = -(lat - coords.lat) * 111000;
      const scale = 0.04; // meters per pixel (radius ~1.2km)
      return { x: dx * scale, y: dy * scale };
    };
    return {
      hazards: hazards.map((h) => ({ ...h, ...toXY(h.lat, h.lng) })),
      peers: Object.values(peers).map((p) => ({ ...p, ...toXY(p.lat, p.lng) })),
    };
  }, [coords, hazards, peers]);

  const hazardColor = (k: string) => k === "police" ? COLORS.danger : k === "accident" ? COLORS.danger : k === "traffic" ? COLORS.warning : COLORS.warning;
  const hazardIcon = (k: string): any => k === "police" ? "shield" : k === "accident" ? "alert-circle" : k === "traffic" ? "car" : "warning";

  const onIntent = (intent: string | null, text?: string) => {
    if (!intent) return;
    if (intent === "report_police") reportHazard("police");
    else if (intent === "report_accident") reportHazard("accident");
    else if (intent === "report_road") reportHazard("road");
    else if (intent === "report_traffic") reportHazard("traffic");
    else if (intent === "open_talk") router.push("/(app)/talk");
    else if (intent === "open_music") router.push("/(app)/music");
    else if (intent === "open_drive") router.push("/(app)/drive");
    else if (intent === "open_map") router.push("/(app)/map");
  };

  return (
    <SafeAreaView style={styles.c} edges={["top"]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>RADAR</Text>
          <Text style={styles.sub}>{user?.handle} · {Object.keys(peers).length} drivers nearby</Text>
        </View>
        <TouchableOpacity testID="refresh-btn" onPress={() => { loadHazards(); loadNearby(); }} style={styles.iconBtn}>
          <Ionicons name="refresh" size={22} color={COLORS.primary} />
        </TouchableOpacity>
      </View>

      <View style={styles.radarWrap}>
        <Svg width={RADAR} height={RADAR}>
          <Circle cx={RADAR / 2} cy={RADAR / 2} r={RADAR / 2 - 2} fill="#06120a" stroke={COLORS.primary} strokeOpacity={0.25} strokeWidth={2} />
          <Circle cx={RADAR / 2} cy={RADAR / 2} r={(RADAR / 2) * 0.66} fill="none" stroke={COLORS.primary} strokeOpacity={0.15} strokeWidth={1} />
          <Circle cx={RADAR / 2} cy={RADAR / 2} r={(RADAR / 2) * 0.33} fill="none" stroke={COLORS.primary} strokeOpacity={0.15} strokeWidth={1} />
          <Line x1={0} y1={RADAR / 2} x2={RADAR} y2={RADAR / 2} stroke={COLORS.primary} strokeOpacity={0.1} />
          <Line x1={RADAR / 2} y1={0} x2={RADAR / 2} y2={RADAR} stroke={COLORS.primary} strokeOpacity={0.1} />

          {/* user (center) */}
          <G>
            <Circle cx={RADAR / 2} cy={RADAR / 2} r={14} fill={COLORS.secondary} fillOpacity={0.2} />
            <Polygon points={`${RADAR / 2},${RADAR / 2 - 10} ${RADAR / 2 - 7},${RADAR / 2 + 6} ${RADAR / 2 + 7},${RADAR / 2 + 6}`} fill={COLORS.secondary} />
          </G>

          {projected.peers.map((p: any) => {
            const cx = RADAR / 2 + p.x;
            const cy = RADAR / 2 + p.y;
            if (cx < 8 || cx > RADAR - 8 || cy < 8 || cy > RADAR - 8) return null;
            return (
              <G key={p.user_id}>
                <Circle cx={cx} cy={cy} r={10} fill={COLORS.primary} fillOpacity={0.2} />
                <Circle cx={cx} cy={cy} r={5} fill={COLORS.primary} />
              </G>
            );
          })}

          {projected.hazards.map((h: any) => {
            const cx = RADAR / 2 + h.x;
            const cy = RADAR / 2 + h.y;
            if (cx < 8 || cx > RADAR - 8 || cy < 8 || cy > RADAR - 8) return null;
            const color = hazardColor(h.kind);
            return (
              <G key={h.id}>
                <Circle cx={cx} cy={cy} r={11} fill={color} fillOpacity={0.25} />
                <Circle cx={cx} cy={cy} r={6} fill={color} />
              </G>
            );
          })}
        </Svg>
        <Text style={styles.scaleText}>~1.2 km radius · live</Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 90 }} testID="hazards-list">
        <Text style={styles.sectionTitle}>ACTIVE ALERTS</Text>
        {hazards.length === 0 && <Text style={styles.empty}>No alerts in your area. Drive safe.</Text>}
        {hazards.map((h) => (
          <View key={h.id} style={styles.hazardRow} testID={`hazard-${h.id}`}>
            <View style={[styles.hazardIcon, { backgroundColor: hazardColor(h.kind) + "33", borderColor: hazardColor(h.kind) }]}>
              <Ionicons name={hazardIcon(h.kind)} size={20} color={hazardColor(h.kind)} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.hazardTitle}>{h.kind.toUpperCase()}</Text>
              <Text style={styles.hazardSub}>by {h.reporter_handle || "anon"} · {h.confirms || 1} confirms</Text>
            </View>
            <TouchableOpacity
              testID={`confirm-${h.id}`}
              onPress={async () => { try { await api.post(`/hazards/${h.id}/confirm`); loadHazards(); } catch {} }}
              style={styles.confirmBtn}
            >
              <Text style={styles.confirmText}>+1</Text>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>

      {/* Report FAB */}
      {showReport && (
        <View style={styles.reportPanel} testID="report-panel">
          {([["police", "shield", "POLICE"], ["accident", "alert-circle", "ACCIDENT"], ["road", "warning", "HAZARD"], ["traffic", "car", "TRAFFIC"]] as const).map(([k, ico, lbl]) => (
            <TouchableOpacity key={k} testID={`report-${k}`} style={styles.reportBtn} onPress={() => reportHazard(k)}>
              <Ionicons name={ico as any} size={26} color={hazardColor(k)} />
              <Text style={styles.reportText}>{lbl}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      <TouchableOpacity testID="report-fab" style={styles.fab} onPress={() => setShowReport((s) => !s)}>
        <Ionicons name={showReport ? "close" : "add"} size={28} color="#000" />
      </TouchableOpacity>

      <VoiceFAB onIntent={onIntent} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 18, paddingBottom: 8 },
  title: { color: COLORS.text, fontSize: 28, fontWeight: "900", letterSpacing: 4 },
  sub: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.surface, alignItems: "center", justifyContent: "center" },
  radarWrap: { alignItems: "center", paddingVertical: 8 },
  scaleText: { color: COLORS.textDim, fontSize: 11, marginTop: 6, letterSpacing: 1.5 },
  list: { flex: 1, paddingHorizontal: 18, marginTop: 4 },
  sectionTitle: { color: COLORS.textDim, fontSize: 11, letterSpacing: 3, marginBottom: 10, marginTop: 8 },
  empty: { color: COLORS.textDim, fontSize: 13, fontStyle: "italic" },
  hazardRow: {
    flexDirection: "row", alignItems: "center", padding: 12, borderRadius: 14,
    backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, marginBottom: 8,
  },
  hazardIcon: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", borderWidth: 1, marginRight: 12 },
  hazardTitle: { color: COLORS.text, fontWeight: "800", letterSpacing: 1.5, fontSize: 13 },
  hazardSub: { color: COLORS.textDim, fontSize: 11, marginTop: 2 },
  confirmBtn: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: COLORS.primary + "22", borderRadius: 8 },
  confirmText: { color: COLORS.primary, fontWeight: "900" },
  fab: {
    position: "absolute", bottom: 100, right: 18, width: 60, height: 60, borderRadius: 30,
    backgroundColor: COLORS.primary, alignItems: "center", justifyContent: "center",
    shadowColor: COLORS.primary, shadowOpacity: 0.5, shadowRadius: 12, elevation: 6,
  },
  reportPanel: {
    position: "absolute", bottom: 170, right: 18, backgroundColor: COLORS.surface,
    borderRadius: 16, padding: 10, borderWidth: 1, borderColor: COLORS.border, gap: 6,
  },
  reportBtn: { flexDirection: "row", alignItems: "center", padding: 10, gap: 10 },
  reportText: { color: COLORS.text, fontWeight: "800", letterSpacing: 1.5, fontSize: 12 },
});
