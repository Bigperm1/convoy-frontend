import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
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
      n.data.forEach((u: any) => { if (u.lat && u.lng) pm[u.id] = { user_id: u.id, handle: u.handle, lat: u.lat, lng: u.lng }; });
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
    return (
      <View style={styles.loader}>
        <Text style={{ color: COLORS.textDim }}>Locating…</Text>
      </View>
    );
  }

  const peerList = Object.values(peers);

  return (
    <View style={styles.c}>
      <ConvoyMap
        center={coords}
        user={{ ...coords, heading: 0 }}
        peers={peerList}
        hazards={hazards}
        onHazardPress={(h) => setSelected(h)}
      />

      {/* Top header */}
      <SafeAreaView edges={["top"]} style={styles.topBar} pointerEvents="box-none">
        <Glass radius={20} style={{ marginHorizontal: 12 }}>
          <View style={styles.topRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Map</Text>
              <Text style={styles.sub}>{user?.handle} · {peerList.length} drivers · {hazards.length} alerts</Text>
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
            <View style={[styles.hazardBubble, { backgroundColor: hazardColor(selected.kind) }]}>
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

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: "#0A1410" },
  loader: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg },

  topBar: { position: "absolute", top: 0, left: 0, right: 0 },
  topRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  title: { color: COLORS.text, fontSize: 26, fontWeight: "700", letterSpacing: -0.6 },
  sub: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(118,118,128,0.32)", alignItems: "center", justifyContent: "center" },

  hazardBubble: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(255,255,255,0.85)" },

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
