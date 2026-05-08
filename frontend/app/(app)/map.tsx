import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, Dimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import Svg, { Circle, Line, Polygon, G, Defs, RadialGradient, Stop } from "react-native-svg";
import { LinearGradient } from "expo-linear-gradient";
import { api, formatErr, wsUrl } from "../../src/api";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { useRouter } from "expo-router";
import Glass from "../../src/Glass";
import VoiceFAB from "../../src/VoiceFAB";

const { width } = Dimensions.get("window");
const RADAR = Math.min(width - 40, 360);

type Hazard = { id: string; kind: string; lat: number; lng: number; reporter_handle?: string; created_at: string; confirms?: number };
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
          lat = pos.coords.latitude; lng = pos.coords.longitude;
        } catch {}
      }
      setCoords({ lat, lng });
      try { await api.post("/location", { lat, lng, speed: 0, heading: 0 }); } catch {}
      load();
    })();
  }, []);

  useEffect(() => {
    if (!token) return;
    const ws = new WebSocket(wsUrl(token));
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "hazard") setHazards((h) => [m.hazard, ...h.filter((x) => x.id !== m.hazard.id)]);
        else if (m.type === "location" && m.user_id !== user?.id) setPeers((p) => ({ ...p, [m.user_id]: { ...p[m.user_id], ...m } }));
      } catch {}
    };
    return () => ws.close();
  }, [token, user?.id]);

  const load = async () => {
    try {
      const [h, n] = await Promise.all([api.get("/hazards"), api.get("/users/nearby")]);
      setHazards(h.data);
      const pm: Record<string, Peer> = {};
      n.data.forEach((u: any) => { if (u.lat && u.lng) pm[u.id] = { user_id: u.id, handle: u.handle, lat: u.lat, lng: u.lng, heading: u.heading, speed: u.speed }; });
      setPeers(pm);
    } catch {}
  };

  const reportHazard = async (kind: string) => {
    if (!coords) return;
    try {
      const j = () => (Math.random() - 0.5) * 0.005;
      await api.post("/hazards", { kind, lat: coords.lat + j(), lng: coords.lng + j(), note: "" });
      setShowReport(false);
      load();
    } catch (e) { Alert.alert("Report failed", formatErr(e)); }
  };

  const projected = useMemo(() => {
    if (!coords) return { hazards: [], peers: [] };
    const toXY = (la: number, ln: number) => {
      const dx = (ln - coords.lng) * Math.cos((coords.lat * Math.PI) / 180) * 111000;
      const dy = -(la - coords.lat) * 111000;
      const scale = 0.04;
      return { x: dx * scale, y: dy * scale };
    };
    return {
      hazards: hazards.map((h) => ({ ...h, ...toXY(h.lat, h.lng) })),
      peers: Object.values(peers).map((p) => ({ ...p, ...toXY(p.lat, p.lng) })),
    };
  }, [coords, hazards, peers]);

  const hazardColor = (k: string) => k === "police" ? COLORS.danger : k === "accident" ? COLORS.danger : k === "traffic" ? COLORS.warning : COLORS.warning;
  const hazardIcon = (k: string): any => k === "police" ? "shield-checkmark" : k === "accident" ? "alert-circle" : k === "traffic" ? "car" : "warning";

  const onIntent = (intent: string | null) => {
    if (intent === "report_police") reportHazard("police");
    else if (intent === "report_accident") reportHazard("accident");
    else if (intent === "report_road") reportHazard("road");
    else if (intent === "report_traffic") reportHazard("traffic");
    else if (intent === "open_talk") router.push("/(app)/talk");
    else if (intent === "open_music") router.push("/(app)/music");
    else if (intent === "open_drive") router.push("/(app)/drive");
  };

  return (
    <SafeAreaView style={styles.c} edges={["top"]}>
      <LinearGradient colors={["#020308", "#04060E", "#000"]} style={StyleSheet.absoluteFill} pointerEvents="none" />

      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Radar</Text>
          <Text style={styles.sub}>{user?.handle} · {Object.keys(peers).length} drivers nearby</Text>
        </View>
        <TouchableOpacity testID="refresh-btn" onPress={load} style={styles.iconBtn}>
          <Ionicons name="refresh" size={20} color={COLORS.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.radarWrap}>
        <Svg width={RADAR} height={RADAR}>
          <Defs>
            <RadialGradient id="rg" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={COLORS.primary} stopOpacity="0.15" />
              <Stop offset="0.6" stopColor={COLORS.primary} stopOpacity="0.04" />
              <Stop offset="1" stopColor="#000" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={RADAR / 2} cy={RADAR / 2} r={RADAR / 2 - 2} fill="url(#rg)" stroke={COLORS.hairlineStrong} strokeWidth={1} />
          <Circle cx={RADAR / 2} cy={RADAR / 2} r={(RADAR / 2) * 0.66} fill="none" stroke={COLORS.hairline} />
          <Circle cx={RADAR / 2} cy={RADAR / 2} r={(RADAR / 2) * 0.33} fill="none" stroke={COLORS.hairline} />
          <Line x1={0} y1={RADAR / 2} x2={RADAR} y2={RADAR / 2} stroke={COLORS.hairline} />
          <Line x1={RADAR / 2} y1={0} x2={RADAR / 2} y2={RADAR} stroke={COLORS.hairline} />

          <G>
            <Circle cx={RADAR / 2} cy={RADAR / 2} r={16} fill={COLORS.primary} fillOpacity={0.18} />
            <Polygon points={`${RADAR / 2},${RADAR / 2 - 11} ${RADAR / 2 - 8},${RADAR / 2 + 7} ${RADAR / 2 + 8},${RADAR / 2 + 7}`} fill={COLORS.primary} />
          </G>

          {projected.peers.map((p: any) => {
            const cx = RADAR / 2 + p.x; const cy = RADAR / 2 + p.y;
            if (cx < 8 || cx > RADAR - 8 || cy < 8 || cy > RADAR - 8) return null;
            return (
              <G key={p.user_id}>
                <Circle cx={cx} cy={cy} r={11} fill={COLORS.success} fillOpacity={0.2} />
                <Circle cx={cx} cy={cy} r={5} fill={COLORS.success} />
              </G>
            );
          })}
          {projected.hazards.map((h: any) => {
            const cx = RADAR / 2 + h.x; const cy = RADAR / 2 + h.y;
            if (cx < 8 || cx > RADAR - 8 || cy < 8 || cy > RADAR - 8) return null;
            const c = hazardColor(h.kind);
            return (
              <G key={h.id}>
                <Circle cx={cx} cy={cy} r={12} fill={c} fillOpacity={0.25} />
                <Circle cx={cx} cy={cy} r={6} fill={c} />
              </G>
            );
          })}
        </Svg>
        <Text style={styles.scaleText}>1.2 km radius · live</Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 110 }} testID="hazards-list">
        <Text style={styles.sectionTitle}>Active alerts</Text>
        {hazards.length === 0 && <Text style={styles.empty}>No alerts in your area. Drive safe.</Text>}
        {hazards.map((h) => (
          <Glass key={h.id} radius={16} style={{ marginBottom: 8 }}>
            <View style={styles.hazardRow} testID={`hazard-${h.id}`}>
              <View style={[styles.hazardIcon, { backgroundColor: hazardColor(h.kind) + "22", borderColor: hazardColor(h.kind) + "55" }]}>
                <Ionicons name={hazardIcon(h.kind)} size={20} color={hazardColor(h.kind)} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.hazardTitle}>{h.kind.charAt(0).toUpperCase() + h.kind.slice(1)}</Text>
                <Text style={styles.hazardSub}>{h.reporter_handle || "anon"} · {h.confirms || 1} confirms</Text>
              </View>
              <TouchableOpacity testID={`confirm-${h.id}`} onPress={async () => { try { await api.post(`/hazards/${h.id}/confirm`); load(); } catch {} }} style={styles.confirmBtn}>
                <Text style={styles.confirmText}>+1</Text>
              </TouchableOpacity>
            </View>
          </Glass>
        ))}
      </ScrollView>

      {showReport && (
        <Glass radius={20} style={styles.reportPanel} testID="report-panel">
          {([["police", "shield-checkmark", "Police"], ["accident", "alert-circle", "Accident"], ["road", "warning", "Hazard"], ["traffic", "car", "Traffic"]] as const).map(([k, ico, lbl]) => (
            <TouchableOpacity key={k} testID={`report-${k}`} style={styles.reportBtn} onPress={() => reportHazard(k)}>
              <Ionicons name={ico as any} size={22} color={hazardColor(k)} />
              <Text style={styles.reportText}>{lbl}</Text>
            </TouchableOpacity>
          ))}
        </Glass>
      )}
      <TouchableOpacity testID="report-fab" style={styles.fab} onPress={() => setShowReport((s) => !s)} activeOpacity={0.85}>
        <LinearGradient colors={[COLORS.primary, COLORS.primaryDim]} style={styles.fabGrad}>
          <Ionicons name={showReport ? "close" : "add"} size={28} color="#fff" />
        </LinearGradient>
      </TouchableOpacity>

      <VoiceFAB onIntent={onIntent} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg },
  header: { flexDirection: "row", alignItems: "center", padding: 18, paddingBottom: 6 },
  title: { color: COLORS.text, fontSize: 34, fontWeight: "700", letterSpacing: -1 },
  sub: { color: COLORS.textDim, fontSize: 13, marginTop: 2 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(118,118,128,0.24)", alignItems: "center", justifyContent: "center" },
  radarWrap: { alignItems: "center", paddingVertical: 10 },
  scaleText: { color: COLORS.textDim, fontSize: 11, marginTop: 4 },
  list: { flex: 1, paddingHorizontal: 18, marginTop: 8 },
  sectionTitle: { color: COLORS.textDim, fontSize: 13, marginBottom: 10, fontWeight: "500" },
  empty: { color: COLORS.textMute, fontSize: 13 },
  hazardRow: { flexDirection: "row", alignItems: "center", padding: 12 },
  hazardIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, marginRight: 12 },
  hazardTitle: { color: COLORS.text, fontWeight: "600", fontSize: 15 },
  hazardSub: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  confirmBtn: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: COLORS.primary + "22", borderRadius: 10 },
  confirmText: { color: COLORS.primary, fontWeight: "700" },
  fab: { position: "absolute", bottom: 110, right: 18, width: 60, height: 60, borderRadius: 30, overflow: "hidden" },
  fabGrad: { flex: 1, alignItems: "center", justifyContent: "center" },
  reportPanel: { position: "absolute", bottom: 180, right: 18, padding: 6 },
  reportBtn: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 },
  reportText: { color: COLORS.text, fontWeight: "500", fontSize: 14 },
});
