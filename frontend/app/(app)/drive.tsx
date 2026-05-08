import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing, Dimensions, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Path, Circle, G, Defs, LinearGradient as SvgGrad, Stop, Rect, Line } from "react-native-svg";
import { COLORS } from "../../src/theme";
import { api } from "../../src/api";
import Glass from "../../src/Glass";
import VoiceFAB from "../../src/VoiceFAB";

const { width, height } = Dimensions.get("window");
const MAP_H = height * 0.62;

// Mock route polyline as a smooth path crossing the screen
const ROUTE_PATH = `M ${width * 0.15} ${MAP_H * 0.95}
  C ${width * 0.25} ${MAP_H * 0.7}, ${width * 0.55} ${MAP_H * 0.65}, ${width * 0.5} ${MAP_H * 0.5}
  S ${width * 0.35} ${MAP_H * 0.25}, ${width * 0.7} ${MAP_H * 0.15}`;

const STREETS = [
  { x1: 0, y1: MAP_H * 0.2, x2: width, y2: MAP_H * 0.25 },
  { x1: 0, y1: MAP_H * 0.55, x2: width, y2: MAP_H * 0.5 },
  { x1: 0, y1: MAP_H * 0.85, x2: width, y2: MAP_H * 0.8 },
  { x1: width * 0.3, y1: 0, x2: width * 0.32, y2: MAP_H },
  { x1: width * 0.6, y1: 0, x2: width * 0.55, y2: MAP_H },
  { x1: width * 0.85, y1: 0, x2: width * 0.9, y2: MAP_H },
];

const HAZARDS_DEMO = [
  { id: "h1", x: width * 0.55, y: MAP_H * 0.5, kind: "police", label: "Police reported · 1.2 km" },
  { id: "h2", x: width * 0.4, y: MAP_H * 0.32, kind: "accident", label: "Accident · 800 m" },
];

export default function DriveScreen() {
  const router = useRouter();
  const [time, setTime] = useState(new Date());
  const [speed, setSpeed] = useState(42);
  const [muted, setMuted] = useState(false);
  const [hazardCount, setHazardCount] = useState(0);
  const [eta, setEta] = useState({ min: 14, distKm: 9.2, arrive: "5:42 PM" });
  const [nextTurn, setNextTurn] = useState({ instr: "Turn right onto Market St", inMeters: 320, icon: "arrow-redo" as const });
  const [alerts, setAlerts] = useState<{ id: string; kind: string; label: string }[]>(HAZARDS_DEMO);
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const t = setInterval(() => {
      setTime(new Date());
      setSpeed((s) => Math.max(0, Math.min(85, s + (Math.random() * 6 - 3))));
      setEta((e) => ({ ...e, min: Math.max(1, e.min - (Math.random() < 0.3 ? 1 : 0)) }));
    }, 1500);
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, useNativeDriver: false, easing: Easing.out(Easing.ease) }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: false }),
      ])
    ).start();
    (async () => {
      try {
        const { data } = await api.get("/hazards");
        setHazardCount(data.length);
      } catch {}
    })();
    return () => clearInterval(t);
  }, []);

  const onIntent = (intent: string | null) => {
    if (intent === "report_police") quickReport("police");
    else if (intent === "report_accident") quickReport("accident");
    else if (intent === "report_road") quickReport("road");
    else if (intent === "open_talk") router.push("/(app)/talk");
    else if (intent === "open_music") router.push("/(app)/music");
    else if (intent === "open_map") router.push("/(app)/map");
  };

  const quickReport = async (kind: string) => {
    try {
      const me = await api.get("/auth/me");
      const lat = me.data.lat || 37.7749;
      const lng = me.data.lng || -122.4194;
      await api.post("/hazards", { kind, lat, lng });
      setHazardCount((c) => c + 1);
      const labels: any = { police: "Police reported · ahead", accident: "Accident reported · ahead", road: "Road hazard · ahead", traffic: "Traffic slowdown · ahead" };
      setAlerts((a) => [{ id: String(Date.now()), kind, label: labels[kind] || kind }, ...a].slice(0, 3));
    } catch {}
  };

  const dismissAlert = (id: string) => setAlerts((a) => a.filter((x) => x.id !== id));

  const hazardColor = (k: string) => k === "police" ? COLORS.danger : k === "accident" ? COLORS.danger : k === "traffic" ? COLORS.warning : COLORS.warning;
  const hazardIcon = (k: string): any => k === "police" ? "shield-checkmark" : k === "accident" ? "alert-circle" : k === "traffic" ? "car" : "warning";

  return (
    <View style={styles.c}>
      {/* Map canvas (mock Apple/Waze style) */}
      <View style={[styles.mapCanvas, { height: MAP_H }]}>
        <LinearGradient colors={["#0E1A2D", "#0A1220", "#070D18"]} style={StyleSheet.absoluteFill} />
        <Svg width={width} height={MAP_H} style={StyleSheet.absoluteFill}>
          <Defs>
            <SvgGrad id="rg" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={COLORS.primary} stopOpacity="1" />
              <Stop offset="1" stopColor={COLORS.accent} stopOpacity="1" />
            </SvgGrad>
          </Defs>

          {/* subtle grid blocks */}
          {[...Array(6)].map((_, i) => (
            <Rect key={`b${i}`} x={(i * width) / 6 + 6} y={MAP_H * 0.08 + (i % 2) * 30} width={(width / 6) - 12} height={50} rx={6} fill="rgba(255,255,255,0.025)" />
          ))}

          {/* streets */}
          {STREETS.map((s, i) => (
            <Line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="rgba(255,255,255,0.08)" strokeWidth={10} strokeLinecap="round" />
          ))}
          {STREETS.map((s, i) => (
            <Line key={`c${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="rgba(255,255,255,0.18)" strokeWidth={1} strokeDasharray="4 8" />
          ))}

          {/* route */}
          <Path d={ROUTE_PATH} stroke="url(#rg)" strokeWidth={9} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.95} />
          <Path d={ROUTE_PATH} stroke="#FFFFFF" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.5} strokeDasharray="2 10" />

          {/* destination flag */}
          <G>
            <Circle cx={width * 0.7} cy={MAP_H * 0.15} r={14} fill="#fff" />
            <Circle cx={width * 0.7} cy={MAP_H * 0.15} r={6} fill={COLORS.danger} />
          </G>

          {/* hazards on map */}
          {alerts.map((h: any, idx) => {
            const x = (HAZARDS_DEMO[idx % HAZARDS_DEMO.length] || HAZARDS_DEMO[0]).x;
            const y = (HAZARDS_DEMO[idx % HAZARDS_DEMO.length] || HAZARDS_DEMO[0]).y;
            const color = hazardColor(h.kind);
            return (
              <G key={h.id}>
                <Circle cx={x} cy={y} r={18} fill={color} fillOpacity={0.15} />
                <Circle cx={x} cy={y} r={10} fill={color} />
              </G>
            );
          })}
        </Svg>

        {/* user location chevron with pulse */}
        <Animated.View
          style={[
            styles.userPulse,
            {
              left: width * 0.15 - 32,
              top: MAP_H * 0.95 - 32,
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
              transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }],
            },
          ]}
        />
        <View style={[styles.userDot, { left: width * 0.15 - 16, top: MAP_H * 0.95 - 16 }]}>
          <Ionicons name="navigate" size={20} color="#fff" style={{ transform: [{ rotate: "30deg" }] }} />
        </View>
      </View>

      {/* Top status bar */}
      <SafeAreaView edges={["top"]} style={styles.topBar} pointerEvents="box-none">
        <Glass radius={20} style={styles.topGlass}>
          <View style={styles.topRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.topTime}>{time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
              <Text style={styles.topMode}>Drive Mode · CarPlay ready</Text>
            </View>
            <View style={styles.alertsPill}>
              <Ionicons name="alert-circle" size={16} color={COLORS.warning} />
              <Text style={styles.alertsPillText}>{hazardCount + alerts.length}</Text>
            </View>
          </View>
        </Glass>
      </SafeAreaView>

      {/* Next turn instruction overlay */}
      <Glass radius={22} style={styles.turnCard}>
        <View style={styles.turnInner}>
          <View style={styles.turnIcon}>
            <Ionicons name={nextTurn.icon} size={32} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.turnDist}>{nextTurn.inMeters} m</Text>
            <Text style={styles.turnInstr}>{nextTurn.instr}</Text>
          </View>
        </View>
      </Glass>

      {/* Hazard alert toasts */}
      <View style={styles.alertsStack} pointerEvents="box-none">
        {alerts.map((a) => (
          <Glass key={a.id} radius={16} style={[styles.alertCard, { borderColor: hazardColor(a.kind) + "55" }]}>
            <View style={styles.alertRow}>
              <View style={[styles.alertDot, { backgroundColor: hazardColor(a.kind) + "33" }]}>
                <Ionicons name={hazardIcon(a.kind)} size={18} color={hazardColor(a.kind)} />
              </View>
              <Text style={styles.alertText}>{a.label}</Text>
              <TouchableOpacity testID={`dismiss-${a.id}`} onPress={() => dismissAlert(a.id)} style={styles.alertClose}>
                <Ionicons name="close" size={16} color={COLORS.textDim} />
              </TouchableOpacity>
            </View>
          </Glass>
        ))}
      </View>

      {/* Bottom HUD */}
      <SafeAreaView edges={["bottom"]} style={styles.bottomWrap} pointerEvents="box-none">
        <Glass radius={24} style={styles.bottomGlass}>
          <View style={styles.bottomInner}>
            <View style={styles.etaBlock}>
              <Text style={styles.etaMin}>{eta.min}</Text>
              <Text style={styles.etaSub}>min</Text>
            </View>
            <View style={styles.etaMeta}>
              <Text style={styles.etaTime}>{eta.arrive}</Text>
              <Text style={styles.etaDist}>{eta.distKm.toFixed(1)} km</Text>
            </View>
            <View style={styles.speedBlock}>
              <Text style={styles.speedVal}>{Math.round(speed)}</Text>
              <Text style={styles.speedUnit}>mph</Text>
            </View>
          </View>

          <View style={styles.actionsRow}>
            <ActionBtn testID="drive-police" icon="shield-checkmark" color={COLORS.danger} label="Police" onPress={() => quickReport("police")} />
            <ActionBtn testID="drive-hazard" icon="warning" color={COLORS.warning} label="Hazard" onPress={() => quickReport("road")} />
            <ActionBtn testID="drive-accident" icon="alert-circle" color={COLORS.danger} label="Accident" onPress={() => quickReport("accident")} />
            <ActionBtn testID="drive-traffic" icon="car" color={COLORS.warning} label="Traffic" onPress={() => quickReport("traffic")} />
          </View>

          <View style={styles.toolRow}>
            <ToolBtn testID="drive-mute" icon={muted ? "volume-mute" : "volume-high"} label={muted ? "Muted" : "Sound"} onPress={() => setMuted((m) => !m)} />
            <ToolBtn testID="drive-talk" icon="mic" label="Talk" onPress={() => router.push("/(app)/talk")} />
            <ToolBtn testID="drive-music" icon="musical-notes" label="Music" onPress={() => router.push("/(app)/music")} />
            <ToolBtn testID="drive-map" icon="map" label="Radar" onPress={() => router.push("/(app)/map")} />
            <ToolBtn testID="drive-end" icon="close-circle" label="End" tone="danger" onPress={() => router.push("/(app)/garage")} />
          </View>
        </Glass>
      </SafeAreaView>

      <VoiceFAB onIntent={onIntent} />
    </View>
  );
}

function ActionBtn({ icon, color, label, onPress, testID }: any) {
  return (
    <TouchableOpacity testID={testID} style={styles.action} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.actionIcon, { backgroundColor: color + "22", borderColor: color + "55" }]}>
        <Ionicons name={icon} size={22} color={color} />
      </View>
      <Text style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function ToolBtn({ icon, label, onPress, tone, testID }: any) {
  const c = tone === "danger" ? COLORS.danger : COLORS.text;
  return (
    <TouchableOpacity testID={testID} style={styles.tool} onPress={onPress} activeOpacity={0.7}>
      <Ionicons name={icon} size={22} color={c} />
      <Text style={[styles.toolLabel, { color: c }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg },
  mapCanvas: { width: "100%", overflow: "hidden" },
  userDot: {
    position: "absolute", width: 32, height: 32, borderRadius: 16,
    alignItems: "center", justifyContent: "center", backgroundColor: COLORS.primary,
    borderWidth: 3, borderColor: "#fff",
  },
  userPulse: { position: "absolute", width: 64, height: 64, borderRadius: 32, backgroundColor: COLORS.primary },
  topBar: { position: "absolute", top: 0, left: 0, right: 0, padding: 12 },
  topGlass: { },
  topRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  topTime: { color: COLORS.text, fontSize: 22, fontWeight: "700", letterSpacing: -0.5 },
  topMode: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  alertsPill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: "rgba(255,159,10,0.15)", borderWidth: 1, borderColor: "rgba(255,159,10,0.3)" },
  alertsPillText: { color: COLORS.warning, fontWeight: "700", fontSize: 13 },

  turnCard: { position: "absolute", top: Platform.OS === "ios" ? 110 : 90, left: 12, right: 12 },
  turnInner: { flexDirection: "row", padding: 14, alignItems: "center", gap: 14 },
  turnIcon: { width: 56, height: 56, borderRadius: 16, backgroundColor: COLORS.primary, alignItems: "center", justifyContent: "center" },
  turnDist: { color: COLORS.text, fontSize: 28, fontWeight: "700", letterSpacing: -0.6 },
  turnInstr: { color: COLORS.textDim, fontSize: 14, marginTop: 2 },

  alertsStack: { position: "absolute", top: Platform.OS === "ios" ? 200 : 180, left: 12, right: 12, gap: 8 },
  alertCard: { borderWidth: 1 },
  alertRow: { flexDirection: "row", alignItems: "center", padding: 10, gap: 10 },
  alertDot: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  alertText: { color: COLORS.text, flex: 1, fontWeight: "500", fontSize: 14 },
  alertClose: { padding: 6 },

  bottomWrap: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 12 },
  bottomGlass: { },
  bottomInner: { flexDirection: "row", padding: 16, alignItems: "center", gap: 16 },
  etaBlock: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  etaMin: { color: COLORS.success, fontSize: 36, fontWeight: "700", letterSpacing: -1 },
  etaSub: { color: COLORS.textDim, fontSize: 14, fontWeight: "600" },
  etaMeta: { flex: 1 },
  etaTime: { color: COLORS.text, fontSize: 16, fontWeight: "600" },
  etaDist: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  speedBlock: { alignItems: "center", paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.06)" },
  speedVal: { color: COLORS.text, fontSize: 24, fontWeight: "700" },
  speedUnit: { color: COLORS.textDim, fontSize: 10, marginTop: -2 },

  actionsRow: { flexDirection: "row", paddingHorizontal: 8, paddingBottom: 6, justifyContent: "space-between" },
  action: { alignItems: "center", flex: 1, paddingVertical: 8 },
  actionIcon: { width: 48, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  actionLabel: { color: COLORS.textDim, fontSize: 11, marginTop: 6, fontWeight: "500" },

  toolRow: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.hairline, paddingVertical: 10, paddingHorizontal: 8, justifyContent: "space-between" },
  tool: { alignItems: "center", flex: 1, paddingVertical: 4 },
  toolLabel: { fontSize: 10, marginTop: 4, fontWeight: "500" },
});
