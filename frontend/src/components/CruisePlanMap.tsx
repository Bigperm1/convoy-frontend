// CruisePlanMap.tsx — plan a cruise ON the map instead of through a search box.
//
// Jeff, 2026-07-29: "when you create a cruise you can see the route drawn on a map in
// that page and you can zoom in and add stops while zoomed in and out, so you're
// planning the route on the map."
//
// Deliberately NOT built on ConvoyMapbox. That component is the drive surface: chase
// camera, lockstep rAF pose pushing, peers, hazards, self-car model, road snap. A
// planner needs none of it and wants the exact opposite of a follow camera — the
// driver's finger owns the viewport. So this is a plain MapView with three layers and
// a tap handler, which also means nothing here can perturb the surface people navigate
// with.
//
// Camera rule: fit to the points when the SET of points changes, and never again. A
// planner that re-framed on every edit would fight the pinch the user just did. Adding
// a stop by tapping therefore leaves the viewport exactly where they put it.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { MapView, Camera, ShapeSource, LineLayer, MarkerView } from '@rnmapbox/maps';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import { fetchMapboxRouteVia } from '../mapboxDirections';
import { decodePolyline } from '../nav';
import { getMapMode, getSettings } from '../settings';

export type PlanPoint = { lat: number; lng: number; label?: string };

// Mapbox style per the user's map-mode setting, so the planner looks like the app.
function planStyleUrl(): string {
  const mode = getMapMode(getSettings());
  if (mode === 'satellite') return 'mapbox://styles/mapbox/satellite-streets-v12';
  if (mode === 'night' || mode === 'dusk') return 'mapbox://styles/mapbox/dark-v11';
  return 'mapbox://styles/mapbox/streets-v12';
}

export default function CruisePlanMap({
  start, stops, end, onAddStop, height = 260,
}: {
  start: PlanPoint | null;
  stops: PlanPoint[];
  end: PlanPoint | null;
  onAddStop: (p: PlanPoint) => void;
  height?: number;
}) {
  const cameraRef = useRef<React.ElementRef<typeof Camera> | null>(null);
  const [line, setLine] = useState<[number, number][]>([]);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  // Every point in visiting order — the line's waypoints and the fit bounds.
  const ordered = useMemo(() => {
    const out: PlanPoint[] = [];
    if (start) out.push(start);
    for (const s of stops) if (typeof s?.lat === 'number' && typeof s?.lng === 'number') out.push(s);
    if (end) out.push(end);
    return out;
  }, [start, stops, end]);

  // A signature of WHERE the points are. Drives both the route fetch and the one-shot
  // camera fit, so an unrelated re-render (a label edit, say) does neither.
  const sig = useMemo(
    () => ordered.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|'),
    [ordered],
  );

  // Draw the real driving route through the points, not straight lines between them —
  // the whole value of planning on a map is seeing the roads it will actually use.
  useEffect(() => {
    if (ordered.length < 2) { setLine([]); return; }
    let cancelled = false;
    const ctrl = new AbortController();
    setBusy(true);
    (async () => {
      try {
        const via = ordered.slice(1, -1).map((p): [number, number] => [p.lng, p.lat]);
        const r = await fetchMapboxRouteVia(
          { lat: ordered[0].lat, lng: ordered[0].lng },
          via,
          { lat: ordered[ordered.length - 1].lat, lng: ordered[ordered.length - 1].lng },
          undefined,
          { signal: ctrl.signal },
        );
        if (cancelled) return;
        if (r?.polyline) {
          setLine(decodePolyline(r.polyline).map((p): [number, number] => [p.lng, p.lat]));
          setHint(null);
        } else {
          // Straight-line fallback so the planner still shows the SHAPE of the trip;
          // saying so matters, because a straight line is not a route.
          setLine(ordered.map((p) => [p.lng, p.lat]));
          setHint('Showing direct lines — could not route through these points yet.');
        }
      } catch {
        if (!cancelled) setLine(ordered.map((p) => [p.lng, p.lat]));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; try { ctrl.abort(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Live camera zoom, so the +/- buttons can step from wherever the user pinched to.
  // @rnmapbox's Camera has zoomTo but no zoomBy, so we track it ourselves.
  const zoomRef = useRef(11);
  const stepZoom = (delta: number) => {
    const next = Math.max(2, Math.min(19, zoomRef.current + delta));
    zoomRef.current = next;
    try { cameraRef.current?.zoomTo(next, 220); } catch {}
  };

  const fitToPoints = () => {
    if (!cameraRef.current || ordered.length === 0) return;
    try {
      if (ordered.length === 1) {
        cameraRef.current.setCamera({
          centerCoordinate: [ordered[0].lng, ordered[0].lat],
          zoomLevel: 12, animationDuration: 450,
        });
        return;
      }
      let minLng = ordered[0].lng, maxLng = ordered[0].lng;
      let minLat = ordered[0].lat, maxLat = ordered[0].lat;
      for (const p of ordered) {
        if (p.lng < minLng) minLng = p.lng; if (p.lng > maxLng) maxLng = p.lng;
        if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
      }
      cameraRef.current.fitBounds([maxLng, maxLat], [minLng, minLat], [48, 32], 450);
    } catch {}
  };

  // Fit ONCE per change of the point set. Not on every render, or the user's pinch
  // would be undone under their finger. Adding a stop by tapping deliberately does NOT
  // re-frame: the map stays exactly where they put it.
  const fittedRef = useRef<string>('');
  useEffect(() => {
    if (!sig || sig === fittedRef.current) return;
    const first = fittedRef.current === '';
    fittedRef.current = sig;
    // Only auto-fit on the FIRST set of points (or when the map had nothing). After
    // that the viewport is the planner's.
    if (first) fitToPoints();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const routeFC: any = {
    type: 'FeatureCollection',
    features: line.length >= 2
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } }]
      : [],
  };

  return (
    <View style={[styles.wrap, { height }]}>
      <MapView
        style={StyleSheet.absoluteFill}
        styleURL={planStyleUrl()}
        projection="mercator"
        scaleBarEnabled={false}
        logoEnabled={false}
        attributionEnabled={false}
        // Tap anywhere to pin a stop. The planner's whole point, and the reason this
        // does not reuse the drive map (which routes taps to POIs and pin-drops).
        onPress={(f: any) => {
          const c = f?.geometry?.coordinates;
          if (!Array.isArray(c) || c.length < 2) return;
          onAddStop({ lat: c[1], lng: c[0] });
        }}
        onCameraChanged={(e: any) => {
          const z = e?.properties?.zoom;
          if (typeof z === 'number' && Number.isFinite(z)) zoomRef.current = z;
        }}
      >
        <Camera ref={cameraRef} />

        {line.length >= 2 && (
          <ShapeSource id="cruise-plan-route" shape={routeFC}>
            <LineLayer
              id="cruise-plan-casing"
              style={{ lineColor: '#0B0B0C', lineWidth: 8, lineOpacity: 0.5, lineCap: 'round', lineJoin: 'round' }}
            />
            <LineLayer
              id="cruise-plan-core"
              style={{ lineColor: COLORS.primary, lineWidth: 4, lineCap: 'round', lineJoin: 'round' }}
            />
          </ShapeSource>
        )}

        {start && (
          <MarkerView coordinate={[start.lng, start.lat]} anchor={{ x: 0.5, y: 1 }}>
            <View style={[styles.pin, styles.pinStart]}>
              <Ionicons name="flag" size={12} color="#0B0B0C" />
            </View>
          </MarkerView>
        )}

        {stops.map((s, i) => (
          <MarkerView key={`plan-stop-${i}-${s.lat.toFixed(5)},${s.lng.toFixed(5)}`} coordinate={[s.lng, s.lat]} anchor={{ x: 0.5, y: 1 }}>
            <View style={[styles.pin, styles.pinStop]}>
              <Text style={styles.pinNum}>{i + 1}</Text>
            </View>
          </MarkerView>
        ))}

        {end && (
          <MarkerView coordinate={[end.lng, end.lat]} anchor={{ x: 0.5, y: 1 }}>
            <View style={[styles.pin, styles.pinEnd]}>
              <Ionicons name="location" size={12} color="#FFFFFF" />
            </View>
          </MarkerView>
        )}
      </MapView>

      {/* Zoom controls: pinch works, but a planner is often used one-handed while
          scrolling a form, and a scroll-view parent eats some pinches. */}
      <View style={styles.zoomCol}>
        <TouchableOpacity style={styles.zoomBtn} onPress={() => stepZoom(1)} hitSlop={6}>
          <Ionicons name="add" size={18} color={COLORS.text} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.zoomBtn} onPress={() => stepZoom(-1)} hitSlop={6}>
          <Ionicons name="remove" size={18} color={COLORS.text} />
        </TouchableOpacity>
        {/* Re-frame the whole cruise on demand — the counterpart to never auto-fitting. */}
        <TouchableOpacity style={styles.zoomBtn} onPress={fitToPoints} hitSlop={6}>
          <Ionicons name="scan" size={16} color={COLORS.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.tapHint} pointerEvents="none">
        {busy ? <ActivityIndicator size="small" color={COLORS.primary} /> : null}
        <Text style={styles.tapHintText} numberOfLines={2}>
          {hint || 'Tap the map to add a stop'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 14, overflow: 'hidden', marginTop: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', backgroundColor: '#0B0B0C',
  },
  pin: {
    width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#0B0B0C',
  },
  pinStart: { backgroundColor: COLORS.primary },
  pinStop: { backgroundColor: '#FFFFFF' },
  pinEnd: { backgroundColor: '#E4002B' },
  pinNum: { color: '#0B0B0C', fontSize: 12, fontWeight: '800' },
  zoomCol: { position: 'absolute', right: 8, top: 8, gap: 6 },
  zoomBtn: {
    width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(18,18,22,0.82)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
  },
  tapHint: {
    position: 'absolute', left: 8, bottom: 8, flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8, maxWidth: '78%',
    backgroundColor: 'rgba(18,18,22,0.82)',
  },
  tapHintText: { color: '#C7CCD1', fontSize: 11, fontWeight: '600' },
});
