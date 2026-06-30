// src/RerouteCard.tsx
//
// The mid-drive reroute offer (native). Replaces the plain Alert.alert Nova used
// to pop — that dialog can't show an image, and the driver wanted to SEE the
// suggested route before accepting. This is a frosted card with a small
// non-interactive map preview of the alternate line, the time it saves, and
// Take it / No thanks.
//
// The preview is a Mapbox STATIC image (same public token + `path` overlay the
// CarPlay static fallback uses), NOT a live GL map: a 180px non-interactive
// thumbnail doesn't need a GL surface, and a GL map inside a React Native <Modal>
// is a known second-surface attach hazard (it can render blank). A static <Image>
// renders reliably, spins up nothing, and lets the app drop both react-native-maps
// AND the in-modal GL dependency. (Live congestion colours still show on the main
// nav map; the preview uses the route's solid colour.)
//
// Web: RerouteCard.web.tsx is the platform variant.

import React, { useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { BlurView } from "expo-blur";
import { COLORS } from "./theme";
import { decodePolyline, type NavRoute } from "./nav";
import { MAPBOX_PUBLIC_TOKEN } from "./initMapbox";
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

// Dark style to match the frosted card; @2x for crisp lines on a small box.
const STATIC_STYLE = "mapbox/dark-v11";
const STATIC_W = 640;
const STATIC_H = 320;
const STATIC_URL_MAX = 8000; // Mapbox static URL ceiling; drop the end pin if over.

// Build a Mapbox Static Images URL: the encoded route polyline as a coloured
// `path` overlay + an end pin, auto-framed to the route. Google's precision-5
// overview polyline is a drop-in for Mapbox `path` (same as the CarPlay fallback).
function buildStaticUrl(polyline: string, hex: string, end: [number, number] | null): string | null {
  if (!polyline) return null;
  const col = hex.replace("#", "");
  const path = `path-6+${col}-1(${encodeURIComponent(polyline)})`;
  const tail = `/auto/${STATIC_W}x${STATIC_H}@2x?padding=22&access_token=${MAPBOX_PUBLIC_TOKEN}`;
  const stem = `https://api.mapbox.com/styles/v1/${STATIC_STYLE}/static/`;
  if (end) {
    const withPin = `${path},pin-s+${col}(${end[0].toFixed(5)},${end[1].toFixed(5)})`;
    const url = `${stem}${withPin}${tail}`;
    if (url.length <= STATIC_URL_MAX) return url;
  }
  const pathOnly = `${stem}${path}${tail}`;
  return pathOnly.length <= STATIC_URL_MAX ? pathOnly : null;
}

export default function RerouteCard({ visible, route, title, subtitle, savedMin, etaMin, arrival, lateMin, onAccept, onDecline }: Props) {
  const end = useMemo<[number, number] | null>(() => {
    if (route?.coordinates && route.coordinates.length) return route.coordinates[route.coordinates.length - 1] as [number, number];
    if (route?.polyline) { const d = decodePolyline(route.polyline); const last = d[d.length - 1]; return last ? [last.lng, last.lat] : null; }
    return null;
  }, [route?.coordinates, route?.polyline]);

  const mapUrl = useMemo(
    () => (route?.polyline ? buildStaticUrl(route.polyline, getRouteColor(getSettings()), end) : null),
    [route?.polyline, end]
  );

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
                {mapUrl ? (
                  <Image source={{ uri: mapUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} cachePolicy="memory-disk" />
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
  btnRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  btn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 13, borderRadius: 13 },
  btnGhost: { backgroundColor: "rgba(255,255,255,0.10)" },
  btnGhostText: { color: COLORS.text, fontSize: 15, fontWeight: "700" },
  btnTake: { backgroundColor: COLORS.brand },
  btnTakeText: { color: "#0B0B0C", fontSize: 15, fontWeight: "800" },
});
