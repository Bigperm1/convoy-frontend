// TripPlayback — watch a recorded drive play back, then take it again.
//
// Jeff, 2026-07-28: "for the users only you can get a visual playback of the route taken
// when clicking on the exact route, and the option to take it again."
// Jeff, 2026-09-03: "can we tackle the Drive replay looking terrible, right now it doesn't
// even work."
//
// The geometry is already on the phone (src/trips.ts keeps the polyline locally and
// deliberately never uploads it), so this is a renderer — no new data, nothing fetched,
// works with no signal.
//
// ── WHAT WAS WRONG (sim-reproduced 2026-09-03, iOS 27 sim, frame-by-frame) ─────────────
// 1. The head dot moved by VERTEX INDEX (`progress × (coords.length − 1)`) while the trail
//    was revealed by LENGTH FRACTION (`lineTrimOffset`). A highway leg is kilometres long
//    with a handful of vertices; the exit hook is 200 m with a dozen. So the dot raced to the
//    hook while the trail was still mid-highway, then crawled while the trail caught up —
//    the two were never together. Both now run on the same clock in METRES.
// 2. The 12-second clock started on open, before the map style/tiles had loaded, so the
//    first seconds (or on a cold phone, the whole playback) ran on a blank grey map. The
//    clock now waits for onDidFinishLoadingMap.
// 3. The trail grew by writing `lineTrimOffset` into the layer STYLE every frame — the exact
//    main-thread read-modify-write per change that the live map removed on 2026-09-01
//    (0x8BADF00D watchdog kills; CLAUDE.md "per-tick state never goes in a layer style").
//    The head was a MarkerView (a native view re-laid-out per frame). Both now ride ONE
//    GeoJSON source — the travelled LineString sliced at the head metre, plus the head
//    point — updated at 12 Hz; every layer style is constant.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, Platform, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Mapbox, { MapView, Camera, ShapeSource, LineLayer, CircleLayer } from "@rnmapbox/maps";
import { COLORS } from "../theme";
import { useAccent, useAccentAlpha } from "../appSkin";
import { decodePolyline } from "../nav";
import { fmtKm, fmtDur, type Trip } from "../trips";

// Seconds of wall-clock for a full playback, regardless of how long the drive took —
// a 6-hour road trip and a 20-minute commute should both be watchable.
const PLAY_SECONDS = 12;
// Source updates per second while playing. The live route ribbon runs its trim at 12 Hz
// for the same reason: smooth to the eye, a fraction of a 60 fps re-render's cost.
const SOURCE_HZ = 12;
const BRAND = "#2DEC86";

type LngLat = [number, number];

/** Cumulative metres at each vertex (equirectangular — fine at route scale). */
function cumulative(coords: LngLat[]): number[] {
  const cum = new Array<number>(coords.length);
  cum[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1], [x1, y1] = coords[i];
    const dy = (y1 - y0) * 111320;
    const dx = (x1 - x0) * 111320 * Math.cos(((y0 + y1) / 2) * Math.PI / 180);
    cum[i] = cum[i - 1] + Math.hypot(dx, dy);
  }
  return cum;
}

/** Point at metre `m` along the line, plus the vertex index it sits after. */
function pointAt(coords: LngLat[], cum: number[], m: number): { p: LngLat; i: number } {
  const total = cum[cum.length - 1];
  if (m <= 0) return { p: coords[0], i: 0 };
  if (m >= total) return { p: coords[coords.length - 1], i: coords.length - 2 };
  let lo = 0, hi = cum.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= m) lo = mid; else hi = mid - 1; }
  const seg = cum[lo + 1] - cum[lo];
  const t = seg > 0 ? (m - cum[lo]) / seg : 0;
  const a = coords[lo], b = coords[lo + 1];
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], i: lo };
}

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
  const coords = useMemo<LngLat[]>(() => {
    if (!trip?.polyline) return [];
    try {
      return decodePolyline(trip.polyline).map((p) => [p.lng, p.lat] as LngLat);
    } catch {
      return [];
    }
  }, [trip?.polyline]);
  const cum = useMemo(() => (coords.length >= 2 ? cumulative(coords) : []), [coords]);
  const totalM = cum.length ? cum[cum.length - 1] : 0;

  const [progress, setProgress] = useState(0);   // 0..1 of the route's LENGTH
  const [playing, setPlaying] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const rafRef = useRef<number | null>(null);
  const startedRef = useRef<number>(0);
  const baseRef = useRef<number>(0);             // progress when this play leg started
  const lastPushRef = useRef<number>(0);

  // Reset whenever a different drive is opened. The map is a fresh MapView per open (it
  // lives inside the Modal), so readiness resets with it.
  useEffect(() => {
    if (!visible) return;
    setProgress(0);
    setPlaying(true);
    setMapReady(false);
    baseRef.current = 0;
    lastPushRef.current = 0;
  }, [visible, trip?.id]);

  // The clock runs only once the map has loaded — otherwise the first seconds play on a
  // blank grey map (or, on a cold phone, the whole thing does).
  useEffect(() => {
    if (!visible || !playing || !mapReady || coords.length < 2) return;
    startedRef.current = Date.now();
    const tick = () => {
      const now = Date.now();
      const elapsed = (now - startedRef.current) / 1000;
      const p = Math.min(1, baseRef.current + elapsed / PLAY_SECONDS);
      if (p >= 1) { setProgress(1); setPlaying(false); baseRef.current = 1; return; }
      if (now - lastPushRef.current >= 1000 / SOURCE_HZ) { lastPushRef.current = now; setProgress(p); }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [visible, playing, mapReady, coords.length]);

  // The whole drive, drawn once: the ghost the trail is revealed over.
  const ghostFC = useMemo(() => ({
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates: coords },
  }), [coords]);

  // Travelled part + head, ONE source, both cut at the same metre. Layer styles below are
  // constant; this is the only thing that changes while playing.
  const liveFC = useMemo(() => {
    if (coords.length < 2 || !totalM) return { type: "FeatureCollection" as const, features: [] as any[] };
    const m = Math.max(0, Math.min(1, progress)) * totalM;
    const { p, i } = pointAt(coords, cum, m);
    const travelled: LngLat[] = coords.slice(0, i + 1);
    travelled.push(p);
    return {
      type: "FeatureCollection" as const,
      features: [
        travelled.length >= 2
          ? { type: "Feature" as const, properties: { kind: "trail" }, geometry: { type: "LineString" as const, coordinates: travelled } }
          : null,
        { type: "Feature" as const, properties: { kind: "head" }, geometry: { type: "Point" as const, coordinates: p } },
      ].filter(Boolean),
    };
  }, [coords, cum, totalM, progress]);

  const bounds = useMemo(() => {
    if (coords.length < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of coords) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { ne: [maxX, maxY] as LngLat, sw: [minX, minY] as LngLat };
  }, [coords]);

  const replay = useCallback(() => {
    baseRef.current = 0;
    lastPushRef.current = 0;
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
          <MapView
            style={StyleSheet.absoluteFill}
            styleURL={Mapbox.StyleURL?.Dark}
            scaleBarEnabled={false}
            logoEnabled={false}
            attributionEnabled={false}
            onDidFinishLoadingMap={() => setMapReady(true)}
          >
            {bounds && (
              <Camera
                bounds={{ ...bounds, paddingLeft: 40, paddingRight: 40, paddingTop: 120, paddingBottom: 220 }}
                animationDuration={0}
              />
            )}
            <ShapeSource id="trip-ghost-src" shape={ghostFC}>
              {/* Faint full route — where the drive went, all at once. */}
              <LineLayer
                id="trip-ghost"
                style={{ lineColor: "#FFFFFF", lineOpacity: 0.18, lineWidth: 5, lineCap: "round", lineJoin: "round" }}
              />
            </ShapeSource>
            <ShapeSource id="trip-live-src" shape={liveFC as any}>
              <LineLayer
                id="trip-travelled"
                filter={["==", ["get", "kind"], "trail"]}
                style={{ lineColor: BRAND, lineWidth: 6, lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1 }}
              />
              <CircleLayer
                id="trip-head-halo"
                filter={["==", ["get", "kind"], "head"]}
                style={{ circleRadius: 11, circleColor: BRAND, circleOpacity: 0.30, circlePitchAlignment: "map" }}
              />
              <CircleLayer
                id="trip-head"
                filter={["==", ["get", "kind"], "head"]}
                style={{ circleRadius: 6, circleColor: BRAND, circleStrokeWidth: 2, circleStrokeColor: "#04120A", circleEmissiveStrength: 1 }}
              />
            </ShapeSource>
          </MapView>
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.noGeo]}>
            <Ionicons name="map-outline" size={34} color={COLORS.textDim} />
            <Text style={styles.noGeoText}>No route was saved for this drive.</Text>
          </View>
        )}

        {/* While the style and tiles load the clock is held; say so instead of showing a
            grey void with a dot creeping across it. */}
        {coords.length >= 2 && !mapReady && (
          <View style={styles.loading} pointerEvents="none">
            <ActivityIndicator color={BRAND} />
            <Text style={styles.loadingText}>Loading map…</Text>
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
              {trip.topSpeedKmh ? ` · top ${Math.round(trip.topSpeedKmh)} km/h` : ""}
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
  loading: {
    position: "absolute", left: 0, right: 0, top: "46%", alignItems: "center", gap: 8,
  },
  loadingText: { color: "#fff", opacity: 0.7, fontSize: 12.5, fontWeight: "600" },
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
});
