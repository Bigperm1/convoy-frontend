import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert, Dimensions, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import Svg, { Path, Circle, G, Defs, LinearGradient as SvgGrad, Stop, Rect, Line } from "react-native-svg";
import { api, formatErr, wsUrl } from "../../src/api";
import { useAuth } from "../../src/auth";
import { COLORS } from "../../src/theme";
import { useRouter } from "expo-router";
import Glass from "../../src/Glass";
import VoiceFAB from "../../src/VoiceFAB";

const { width, height } = Dimensions.get("window");
const MAP_W = width;
const MAP_H = height;

type Hazard = { id: string; kind: string; lat: number; lng: number; reporter_handle?: string; created_at: string; confirms?: number };
type Peer = { user_id: string; handle?: string; lat: number; lng: number; heading?: number; speed?: number };

export default function MapScreen() {
  const { user, token } = useAuth();
  const router = useRouter();
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [showReport, setShowReport] = useState(false);
  const [selected, setSelected] = useState<Hazard | null>(null);
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

  const project = (la: number, ln: number) => {
    if (!coords) return { x: MAP_W / 2, y: MAP_H / 2 };
    const dx = (ln - coords.lng) * Math.cos((coords.lat * Math.PI) / 180) * 111000;
    const dy = -(la - coords.lat) * 111000;
    const scale = 0.06;
    return { x: MAP_W / 2 + dx * scale, y: MAP_H / 2 + dy * scale };
  };

  const projected = useMemo(() => ({
    hazards: hazards.map((h) => ({ ...h, ...project(h.lat, h.lng) })),
    peers: Object.values(peers).map((p) => ({ ...p, ...project(p.lat, p.lng) })),
  }), [coords, hazards, peers]);

  const hazardColor = (k: string) => k === "police" ? "#3478F6" : k === "accident" ? COLORS.danger : k === "traffic" ? COLORS.warning : COLORS.warning;
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
    <View style={styles.c}>
      {/* Stylized "satellite" map background */}
      <SatelliteMap />

      {/* Driver pin (center) */}
      <View style={[styles.youPulse, { left: MAP_W / 2 - 32, top: MAP_H / 2 - 32 }]} />
      <View style={[styles.youDot, { left: MAP_W / 2 - 14, top: MAP_H / 2 - 14 }]}>
        <Ionicons name="navigate" size={16} color="#fff" style={{ transform: [{ rotate: "30deg" }] }} />
      </View>

      {/* Peer drivers */}
      {projected.peers.map((p: any) => {
        if (p.x < 30 || p.x > MAP_W - 30 || p.y < 80 || p.y > MAP_H - 120) return null;
        return (
          <View key={p.user_id} style={[styles.peerDot, { left: p.x - 12, top: p.y - 12 }]} testID={`peer-${p.user_id}`}>
            <Ionicons name="car-sport" size={14} color="#fff" />
          </View>
        );
      })}

      {/* Hazard pins (Waze style) */}
      {projected.hazards.map((h: any) => {
        if (h.x < 24 || h.x > MAP_W - 24 || h.y < 80 || h.y > MAP_H - 120) return null;
        const c = hazardColor(h.kind);
        return (
          <TouchableOpacity
            key={h.id}
            testID={`hazard-${h.id}`}
            onPress={() => setSelected(h)}
            style={[styles.hazardPin, { left: h.x - 22, top: h.y - 44 }]}
            activeOpacity={0.8}
          >
            <View style={[styles.hazardBubble, { backgroundColor: c }]}>
              <Ionicons name={hazardIcon(h.kind)} size={22} color="#fff" />
            </View>
            <View style={[styles.hazardTail, { borderTopColor: c }]} />
          </TouchableOpacity>
        );
      })}

      {/* Top header */}
      <SafeAreaView edges={["top"]} style={styles.topBar} pointerEvents="box-none">
        <Glass radius={20} style={{ marginHorizontal: 12 }}>
          <View style={styles.topRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Map</Text>
              <Text style={styles.sub}>{user?.handle} · {Object.keys(peers).length} drivers · {hazards.length} alerts</Text>
            </View>
            <TouchableOpacity testID="refresh-btn" onPress={load} style={styles.iconBtn}>
              <Ionicons name="refresh" size={18} color={COLORS.text} />
            </TouchableOpacity>
          </View>
        </Glass>
      </SafeAreaView>

      {/* Selected hazard card */}
      {selected && (
        <Glass radius={20} style={styles.selectedCard}>
          <View style={{ padding: 14, flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={[styles.hazardBubble, { backgroundColor: hazardColor(selected.kind), width: 48, height: 48, borderRadius: 24 }]}>
              <Ionicons name={hazardIcon(selected.kind)} size={22} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.selTitle}>{selected.kind.charAt(0).toUpperCase() + selected.kind.slice(1)}</Text>
              <Text style={styles.selSub}>by {selected.reporter_handle || "anon"} · {selected.confirms || 1} confirms</Text>
            </View>
            <TouchableOpacity testID={`confirm-${selected.id}`} onPress={async () => { try { await api.post(`/hazards/${selected.id}/confirm`); load(); } catch {} }} style={styles.confirmBtn}>
              <Text style={styles.confirmText}>+1</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setSelected(null)} style={{ padding: 6 }}>
              <Ionicons name="close" size={20} color={COLORS.textDim} />
            </TouchableOpacity>
          </View>
        </Glass>
      )}

      {/* Report panel */}
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

// Stylized satellite-look map (Google Maps satellite vibe via SVG)
function SatelliteMap() {
  return (
    <View style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
        <Defs>
          <SvgGrad id="terrain" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#1B2A1A" />
            <Stop offset="0.5" stopColor="#0F1A15" />
            <Stop offset="1" stopColor="#0A1410" />
          </SvgGrad>
          <SvgGrad id="water" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#0E2240" />
            <Stop offset="1" stopColor="#091628" />
          </SvgGrad>
        </Defs>
        <Rect x="0" y="0" width={MAP_W} height={MAP_H} fill="url(#terrain)" />

        {/* terrain green blobs */}
        <Path d={`M -50 ${MAP_H * 0.15} Q ${MAP_W * 0.3} ${MAP_H * 0.05}, ${MAP_W * 0.6} ${MAP_H * 0.18} T ${MAP_W + 50} ${MAP_H * 0.22} L ${MAP_W + 50} ${MAP_H * 0.4} L -50 ${MAP_H * 0.38} Z`} fill="#1F3322" opacity={0.7} />
        <Path d={`M -50 ${MAP_H * 0.7} Q ${MAP_W * 0.4} ${MAP_H * 0.62}, ${MAP_W * 0.7} ${MAP_H * 0.78} T ${MAP_W + 50} ${MAP_H * 0.85} L ${MAP_W + 50} ${MAP_H + 50} L -50 ${MAP_H + 50} Z`} fill="#162A1A" opacity={0.8} />

        {/* water */}
        <Path d={`M ${MAP_W * 0.55} ${MAP_H * 0.35} Q ${MAP_W * 0.7} ${MAP_H * 0.4}, ${MAP_W * 0.85} ${MAP_H * 0.5} T ${MAP_W + 100} ${MAP_H * 0.7} L ${MAP_W + 100} ${MAP_H * 0.42} L ${MAP_W * 0.6} ${MAP_H * 0.3} Z`} fill="url(#water)" />

        {/* major roads */}
        {[
          { d: `M -20 ${MAP_H * 0.32} Q ${MAP_W * 0.4} ${MAP_H * 0.36}, ${MAP_W * 0.7} ${MAP_H * 0.42} T ${MAP_W + 20} ${MAP_H * 0.5}` },
          { d: `M ${MAP_W * 0.18} -20 Q ${MAP_W * 0.22} ${MAP_H * 0.3}, ${MAP_W * 0.18} ${MAP_H * 0.55} T ${MAP_W * 0.25} ${MAP_H + 20}` },
          { d: `M -20 ${MAP_H * 0.62} Q ${MAP_W * 0.3} ${MAP_H * 0.66}, ${MAP_W * 0.65} ${MAP_H * 0.7} T ${MAP_W + 20} ${MAP_H * 0.75}` },
          { d: `M ${MAP_W * 0.7} -20 Q ${MAP_W * 0.65} ${MAP_H * 0.25}, ${MAP_W * 0.6} ${MAP_H * 0.55} T ${MAP_W * 0.55} ${MAP_H + 20}` },
        ].map((r, i) => (
          <G key={i}>
            <Path d={r.d} stroke="#3D4A55" strokeWidth={9} fill="none" strokeLinecap="round" />
            <Path d={r.d} stroke="#5B6878" strokeWidth={3} fill="none" strokeLinecap="round" />
            <Path d={r.d} stroke="#FFE08A" strokeWidth={1} fill="none" strokeDasharray="2 14" opacity={0.4} />
          </G>
        ))}

        {/* small streets grid blocks */}
        {[...Array(10)].map((_, i) => (
          <Line key={`gh${i}`} x1={0} y1={(i * MAP_H) / 10 + 30} x2={MAP_W} y2={(i * MAP_H) / 10 + 24} stroke="rgba(120,130,140,0.15)" strokeWidth={1} />
        ))}
        {[...Array(8)].map((_, i) => (
          <Line key={`gv${i}`} x1={(i * MAP_W) / 8 + 10} y1={0} x2={(i * MAP_W) / 8 + 14} y2={MAP_H} stroke="rgba(120,130,140,0.12)" strokeWidth={1} />
        ))}

        {/* building footprints */}
        {[...Array(40)].map((_, i) => {
          const x = ((i * 137) % (MAP_W - 30)) + 15;
          const y = ((i * 211) % (MAP_H - 200)) + 100;
          const w = 14 + (i % 3) * 6;
          const h = 12 + (i % 4) * 4;
          return <Rect key={`b${i}`} x={x} y={y} width={w} height={h} rx={2} fill={i % 2 ? "#1A2230" : "#202830"} opacity={0.7} />;
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: "#0A1410" },

  topBar: { position: "absolute", top: 0, left: 0, right: 0 },
  topRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  title: { color: COLORS.text, fontSize: 26, fontWeight: "700", letterSpacing: -0.6 },
  sub: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(118,118,128,0.32)", alignItems: "center", justifyContent: "center" },

  youPulse: { position: "absolute", width: 64, height: 64, borderRadius: 32, backgroundColor: COLORS.primary, opacity: 0.18 },
  youDot: { position: "absolute", width: 28, height: 28, borderRadius: 14, backgroundColor: COLORS.primary, alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: "#fff" },

  peerDot: { position: "absolute", width: 24, height: 24, borderRadius: 12, backgroundColor: COLORS.success, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(0,0,0,0.4)" },

  hazardPin: { position: "absolute", alignItems: "center" },
  hazardBubble: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(255,255,255,0.85)" },
  hazardTail: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 9, borderLeftColor: "transparent", borderRightColor: "transparent", marginTop: -1 },

  selectedCard: { position: "absolute", left: 12, right: 12, bottom: Platform.OS === "ios" ? 200 : 190 },
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
