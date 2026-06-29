// src/RerouteCard.tsx
//
// The mid-drive reroute offer (native). Replaces the plain Alert.alert Nova used
// to pop — that dialog can't show an image, and the driver wanted to SEE the
// suggested route before accepting. This is a frosted card with a small
// non-interactive map preview of the alternate line, the time it saves, and
// Take it / No thanks. The map reuses react-native-maps (the same stack the main
// map already runs on device), so the preview is guaranteed to render.
//
// Web has no react-native-maps — see RerouteCard.web.tsx for the no-map fallback.

import React, { useMemo, useRef } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import MapView, { Polyline, Marker, PROVIDER_GOOGLE } from "react-native-maps";
import { COLORS } from "./theme";
import { decodePolyline, type NavRoute } from "./nav";
import { congestionColor } from "./mapboxDirections";
import { getSettings, getRouteColor } from "./settings";

type Props = {
  visible: boolean;
  route: NavRoute | null;   // the alternate route to preview
  title: string;            // e.g. "Your route slowed down" / "Faster route found"
  subtitle: string;         // e.g. "About 8 min behind your start estimate"
  // Live stats for the alternate (all optional so older callers still compile).
  savedMin?: number;        // minutes this route saves vs staying
  etaMin?: number;          // alternate's total remaining minutes
  arrival?: string;         // arrival clock, e.g. "5:42 PM"
  lateMin?: number;         // how far behind the original plan you've fallen
  onAccept: () => void;
  onDecline: () => void;
};

type LL = { latitude: number; longitude: number };
type Seg = { coords: LL[]; color: string };

function regionFor(pts: LL[]) {
  if (pts.length === 0) return undefined;
  let minLat = pts[0].latitude, maxLat = pts[0].latitude;
  let minLng = pts[0].longitude, maxLng = pts[0].longitude;
  for (const p of pts) {
    minLat = Math.min(minLat, p.latitude); maxLat = Math.max(maxLat, p.latitude);
    minLng = Math.min(minLng, p.longitude); maxLng = Math.max(maxLng, p.longitude);
  }
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(0.01, (maxLat - minLat) * 1.5),
    longitudeDelta: Math.max(0.01, (maxLng - minLng) * 1.5),
  };
}

export default function RerouteCard({ visible, route, title, subtitle, savedMin, etaMin, arrival, lateMin, onAccept, onDecline }: Props) {
  const mapRef = useRef<MapView | null>(null);
  const pts = useMemo<LL[]>(
    () => (route?.polyline ? decodePolyline(route.polyline).map((p) => ({ latitude: p.lat, longitude: p.lng })) : []),
    [route?.polyline]
  );
  const region = useMemo(() => regionFor(pts), [pts]);
  // Congestion-colored segments: group consecutive same-level pieces into runs and draw
  // each as its own Polyline (robust on react-native-maps), so the preview shows the
  // SAME green→yellow→orange→red live traffic as the main map. Falls back to one solid
  // line in the user's route color when a route has no congestion data.
  const segments = useMemo<Seg[]>(() => {
    const base = getRouteColor(getSettings());
    const coords = route?.coordinates;
    const cong = route?.congestion;
    if (!coords || coords.length < 2) return pts.length >= 2 ? [{ coords: pts, color: base }] : [];
    const runs: Seg[] = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const a = { latitude: coords[i][1], longitude: coords[i][0] };
      const b = { latitude: coords[i + 1][1], longitude: coords[i + 1][0] };
      const color = congestionColor(cong?.[i], base);
      const last = runs[runs.length - 1];
      if (last && last.color === color) last.coords.push(b);
      else runs.push({ coords: [a, b], color });
    }
    return runs;
  }, [route?.coordinates, route?.congestion, pts]);
  const showStats = typeof etaMin === "number" || typeof savedMin === "number";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDecline}>
      <View style={styles.backdrop}>
        <View style={styles.cardWrap}>
          <View style={styles.card}>
            {Platform.OS !== "web" ? (
              <BlurView tint="dark" intensity={75} style={StyleSheet.absoluteFill} />
            ) : (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(18,19,22,0.96)" }]} />
            )}
            <View style={styles.inner}>
              <View style={styles.headerRow}>
                <Ionicons name="navigate-circle" size={22} color={COLORS.brand} />
                <Text style={styles.title} numberOfLines={1}>{title}</Text>
              </View>
              <Text style={styles.sub} numberOfLines={2}>{subtitle}</Text>

              {showStats && (
                <View style={styles.stats}>
                  <View style={styles.etaCol}>
                    <Text style={styles.etaNum}>{etaMin ?? "—"}</Text>
                    <Text style={styles.etaUnit}>min</Text>
                  </View>
                  {!!arrival && (
                    <View>
                      <Text style={styles.statLabel}>Arrive</Text>
                      <Text style={styles.statVal}>{arrival}</Text>
                    </View>
                  )}
                  <View style={styles.saveCol}>
                    {typeof savedMin === "number" && <Text style={styles.saveBig}>{`−${savedMin} min`}</Text>}
                    {typeof lateMin === "number" && lateMin >= 1 && (
                      <Text style={styles.lateText}>{`${lateMin} min behind`}</Text>
                    )}
                  </View>
                </View>
              )}

              <View style={styles.mapBox}>
                {pts.length >= 2 && region ? (
                  <MapView
                    ref={mapRef}
                    key={route?.polyline}
                    style={StyleSheet.absoluteFill}
                    provider={PROVIDER_GOOGLE}
                    initialRegion={region}
                    scrollEnabled={false}
                    zoomEnabled={false}
                    rotateEnabled={false}
                    pitchEnabled={false}
                    toolbarEnabled={false}
                    pointerEvents="none"
                    onMapReady={() => {
                      try {
                        mapRef.current?.fitToCoordinates(pts, {
                          edgePadding: { top: 26, right: 26, bottom: 26, left: 26 },
                          animated: false,
                        });
                      } catch {}
                    }}
                  >
                    {/* Dark casing under the colored runs for contrast on the preview. */}
                    <Polyline coordinates={pts} strokeColor="rgba(0,0,0,0.35)" strokeWidth={9} lineCap="round" lineJoin="round" />
                    {segments.map((seg, i) => (
                      <Polyline key={i} coordinates={seg.coords} strokeColor={seg.color} strokeWidth={6} lineCap="round" lineJoin="round" />
                    ))}
                    <Marker coordinate={pts[0]} anchor={{ x: 0.5, y: 0.5 }}>
                      <View style={styles.startDot} />
                    </Marker>
                    <Marker coordinate={pts[pts.length - 1]} anchor={{ x: 0.5, y: 1 }}>
                      <Ionicons name="location" size={26} color={COLORS.brand} />
                    </Marker>
                  </MapView>
                ) : (
                  <View style={[StyleSheet.absoluteFill, styles.mapFallback]}>
                    <Ionicons name="map" size={28} color={COLORS.textDim} />
                  </View>
                )}
              </View>

              <View style={styles.btnRow}>
                <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={onDecline} activeOpacity={0.85}>
                  <Text style={styles.btnGhostText}>No thanks</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, styles.btnTake]} onPress={onAccept} activeOpacity={0.85}>
                  <Ionicons name="checkmark" size={18} color="#0B0B0C" />
                  <Text style={styles.btnTakeText}>Take it</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", alignItems: "center", padding: 20 },
  cardWrap: { width: "100%", maxWidth: 400 },
  card: { borderRadius: 22, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.18)" },
  inner: { padding: 16 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: COLORS.text, fontSize: 18, fontWeight: "800", letterSpacing: -0.3, flex: 1 },
  sub: { color: COLORS.textDim, fontSize: 13, marginTop: 4, marginBottom: 12 },
  stats: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 12 },
  etaCol: { alignItems: "center" },
  etaNum: { color: COLORS.text, fontSize: 26, fontWeight: "800", lineHeight: 28, letterSpacing: -0.5 },
  etaUnit: { color: COLORS.textDim, fontSize: 12 },
  statLabel: { color: COLORS.textDim, fontSize: 12 },
  statVal: { color: COLORS.text, fontSize: 15, fontWeight: "700" },
  saveCol: { marginLeft: "auto", alignItems: "flex-end" },
  saveBig: { color: "#2DEC86", fontSize: 17, fontWeight: "800" },
  lateText: { color: "#FF9F0A", fontSize: 12, fontWeight: "700", marginTop: 1 },
  mapBox: { height: 180, borderRadius: 14, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.05)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.10)" },
  mapFallback: { alignItems: "center", justifyContent: "center" },
  startDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: "#fff", borderWidth: 3, borderColor: COLORS.brand },
  btnRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  btn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 13, borderRadius: 13 },
  btnGhost: { backgroundColor: "rgba(255,255,255,0.10)" },
  btnGhostText: { color: COLORS.text, fontSize: 15, fontWeight: "700" },
  btnTake: { backgroundColor: COLORS.brand },
  btnTakeText: { color: "#0B0B0C", fontSize: 15, fontWeight: "800" },
});
