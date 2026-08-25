// TripPlayback — watch a recorded drive play back, then take it again.
//
// Jeff, 2026-07-28: "for the users only you can get a visual playback of the route taken
// when clicking on the exact route, and the option to take it again."
//
// The geometry is already on the phone (src/trips.ts keeps the polyline locally and
// deliberately never uploads it), so this is a renderer — no new data, nothing fetched,
// works with no signal.
//
// HOW THE ANIMATION WORKS. Rather than pushing a new GeoJSON slice every frame — which
// would rebuild the source thousands of times on a long route and cook the phone — the
// full line is drawn ONCE and revealed with `lineTrimOffset`. That is a paint-time
// property, so growing the trail is a style update on an unchanged source. The same trick
// the live route uses for its behind-car vanish (see ConvoyMapbox).
//
// The travelling dot is a MarkerView whose coordinate is interpolated along the decoded
// points, so it stays glued to the trail instead of sampling a separate timeline.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Mapbox, { MapView, Camera, ShapeSource, LineLayer, MarkerView } from "@rnmapbox/maps";
import { COLORS } from "../theme";
import { useAccent, useAccentAlpha } from "../appSkin";
import { decodePolyline } from "../nav";
import { fmtKm, fmtDur, type Trip } from "../trips";

// Seconds of wall-clock for a full playback, regardless of how long the drive took —
// a 6-hour road trip and a 20-minute commute should both be watchable.
const PLAY_SECONDS = 12;
const BRAND = "#2DEC86";

export default function TripPlayback({
  trip, visible, onClose, onTakeAgain,
}: {
  trip: Trip | null;
  visible: boolean;
  onClose: () => void;
  onTakeAgain: (t: Trip) => void;
}) {
  const accent = useAccent();
  const againTint = useAccentAlpha(0.12);
  const againEdge = useAccentAlpha(0.55);

  // [lng,lat] for Mapbox (decodePolyline returns {lat,lng}).
  const coords = useMemo<[number, number][]>(() => {
    if (!trip?.polyline) return [];
    try {
      return decodePolyline(trip.polyline).map((p) => [p.lng, p.lat] as [number, number]);
    } catch {
      return [];
    }
  }, [trip?.polyline]);

  const [progress, setProgress] = useState(0);   // 0..1 along the route
  const [playing, setPlaying] = useState(true);
  const rafRef = useRef<number | null>(null);
  const startedRef = useRef<number>(0);
  const baseRef = useRef<number>(0);             // progress when this play leg started

  // Reset whenever a different drive is opened.
  useEffect(() => {
    if (!visible) return;
    setProgress(0);
    setPlaying(true);
    baseRef.current = 0;
    startedRef.current = Date.now();
  }, [visible, trip?.id]);

  useEffect(() => {
    if (!visible || !playing || coords.length < 2) return;
    startedRef.current = Date.now();
    const tick = () => {
      const elapsed = (Date.now() - startedRef.current) / 1000;
      const p = Math.min(1, baseRef.current + elapsed / PLAY_SECONDS);
      setProgress(p);
      if (p >= 1) { setPlaying(false); baseRef.current = 1; return; }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [visible, playing, coords.length]);

  const routeFC = useMemo(() => ({
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates: coords },
  }), [coords]);

  // Where the dot is right now: walk to the point at `progress` and lerp within it.
  const dotAt = useMemo<[number, number] | null>(() => {
    if (coords.length < 2) return null;
    const f = Math.min(1, Math.max(0, progress)) * (coords.length - 1);
    const i = Math.min(coords.length - 2, Math.floor(f));
    const t = f - i;
    const a = coords[i], b = coords[i + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }, [coords, progress]);

  const bounds = useMemo(() => {
    if (coords.length < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of coords) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { ne: [maxX, maxY] as [number, number], sw: [minX, minY] as [number, number] };
  }, [coords]);

  const replay = useCallback(() => {
    baseRef.current = 0;
    setProgress(0);
    startedRef.current = Date.now();
    setPlaying(true);
  }, []);

  const toggle = useCallback(() => {
    if (progress >= 1) { replay(); return; }
    setPlaying((p) => {
      if (p) baseRef.current = progress;      // pausing — remember where we are
      else startedRef.current = Date.now();
      return !p;
    });
  }, [progress, replay]);

  if (!trip) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.page}>
        {Platform.OS !== "web" && coords.length >= 2 ? (
          <MapView style={StyleSheet.absoluteFill} styleURL={Mapbox.StyleURL?.Dark} scaleBarEnabled={false} logoEnabled={false} attributionEnabled={false}>
            {bounds && (
              <Camera
                bounds={{ ...bounds, paddingLeft: 40, paddingRight: 40, paddingTop: 120, paddingBottom: 220 }}
                animationDuration={600}
              />
            )}
            <ShapeSource id="trip-line" shape={routeFC} lineMetrics>
              {/* Faint full route — where the drive went, all at once. */}
              <LineLayer
                id="trip-ghost"
                style={{ lineColor: "#FFFFFF", lineOpacity: 0.18, lineWidth: 5, lineCap: "round", lineJoin: "round" }}
              />
              {/* The travelled part, revealed by trimming rather than by rebuilding the
                  source each frame. */}
              <LineLayer
                id="trip-travelled"
                style={{
                  lineColor: BRAND, lineWidth: 6, lineCap: "round", lineJoin: "round",
                  lineEmissiveStrength: 1,
                  lineTrimOffset: [Math.min(0.999, progress), 1],
                }}
              />
            </ShapeSource>
            {dotAt && (
              <MarkerView coordinate={dotAt} anchor={{ x: 0.5, y: 0.5 }}>
                <View style={styles.dotOuter}><View style={styles.dotInner} /></View>
              </MarkerView>
            )}
          </MapView>
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.noGeo]}>
            <Ionicons name="map-outline" size={34} color={COLORS.textDim} />
            <Text style={styles.noGeoText}>No route was saved for this drive.</Text>
          </View>
        )}

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.closeBtn}>
            <Ionicons name="close" size={22} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.title} numberOfLines={1}>{trip.destLabel}</Text>
            <Text style={styles.sub} numberOfLines={1}>
              {fmtKm(trip.distanceM / 1000)} · {fmtDur(trip.durationS)}
              {trip.stops?.length ? ` · ${trip.stops.length} stop${trip.stops.length === 1 ? "" : "s"}` : ""}
            </Text>
          </View>
        </View>

        {/* Controls */}
        <View style={styles.footer}>
          <View style={styles.scrubTrack}>
            <View style={[styles.scrubFill, { width: `${Math.round(progress * 100)}%`, backgroundColor: accent }]} />
          </View>
          <View style={styles.btnRow}>
            <TouchableOpacity onPress={toggle} style={[styles.playBtn, { backgroundColor: accent }]} activeOpacity={0.85}>
              <Ionicons
                name={progress >= 1 ? "refresh" : playing ? "pause" : "play"}
                size={20}
                color="#04120A"
              />
              <Text style={styles.playText}>{progress >= 1 ? "Replay" : playing ? "Pause" : "Play"}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => onTakeAgain(trip)} style={[styles.againBtn, { backgroundColor: againTint, borderColor: againEdge }]} activeOpacity={0.85}>
              <Ionicons name="navigate" size={18} color={accent} />
              <Text style={[styles.againText, { color: accent }]}>Take it again</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#000" },
  noGeo: { alignItems: "center", justifyContent: "center", gap: 10 },
  noGeoText: { color: COLORS.textDim, fontSize: 13 },
  header: {
    position: "absolute", top: Platform.OS === "ios" ? 56 : 28, left: 12, right: 12,
    flexDirection: "row", alignItems: "center", gap: 12,
  },
  closeBtn: {
    width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  title: { color: "#fff", fontSize: 17, fontWeight: "800", letterSpacing: -0.3 },
  sub: { color: "#fff", opacity: 0.8, fontSize: 12.5, fontWeight: "600", marginTop: 2 },
  footer: {
    position: "absolute", left: 16, right: 16, bottom: Platform.OS === "ios" ? 38 : 22,
    gap: 12,
  },
  scrubTrack: { height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.22)", overflow: "hidden" },
  scrubFill: { height: 4, backgroundColor: BRAND },
  btnRow: { flexDirection: "row", gap: 10 },
  playBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    paddingVertical: 14, borderRadius: 14, backgroundColor: BRAND,
  },
  playText: { color: "#04120A", fontSize: 15, fontWeight: "800" },
  againBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    paddingVertical: 14, borderRadius: 14,
    backgroundColor: "rgba(45,236,134,0.12)", borderWidth: 1, borderColor: "rgba(45,236,134,0.55)",
  },
  againText: { color: BRAND, fontSize: 15, fontWeight: "800" },
  dotOuter: {
    width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(45,236,134,0.30)",
  },
  dotInner: {
    width: 12, height: 12, borderRadius: 6, backgroundColor: BRAND,
    borderWidth: 2, borderColor: "#04120A",
  },
});
