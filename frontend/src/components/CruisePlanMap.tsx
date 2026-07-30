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

export type PlanStyle = 'fastest' | 'scenic';
export type PlanRoute = { polyline: string; coords: [number, number][]; distanceM: number; durationS: number };
export type PlanRoutes = { fastest: PlanRoute | null; scenic: PlanRoute | null };

export default function CruisePlanMap({
  start, stops, end, onAddStop, style = 'fastest', onRoutes, height = 260,
}: {
  start: PlanPoint | null;
  stops: PlanPoint[];
  end: PlanPoint | null;
  onAddStop: (p: PlanPoint) => void;
  // Which line is the chosen one. The other is still drawn, dimmed, so the trade-off
  // is visible on the map rather than only in a chip — the way Maps shows it.
  style?: PlanStyle;
  // Both variants handed back so the creator can label the chips with real numbers and
  // store the chosen polyline with the cruise.
  onRoutes?: (r: PlanRoutes) => void;
  height?: number;
}) {
  const cameraRef = useRef<React.ElementRef<typeof Camera> | null>(null);
  const [routes, setRoutes] = useState<PlanRoutes>({ fastest: null, scenic: null });
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const onRoutesRef = useRef(onRoutes);
  onRoutesRef.current = onRoutes;

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

  // Draw the real driving routes through the points, not straight lines between them —
  // the whole value of planning on a map is seeing the roads it will actually use.
  //
  // BOTH variants are fetched: the fastest route, and a SCENIC one that excludes
  // motorways. That exclusion is what makes "scenic" mean something here — note that
  // the drive map's own "Scenic" is only a LABEL on Mapbox's first alternate
  // (ConvoyMapbox routeKindFor: index 0 = best, index 1 = "scenic"), which is usually
  // just another freeway. Excluding motorways genuinely pushes the line onto back
  // roads. Two requests per edit is fine — planning is not a hot loop.
  useEffect(() => {
    if (ordered.length < 2) {
      setRoutes({ fastest: null, scenic: null });
      onRoutesRef.current?.({ fastest: null, scenic: null });
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setBusy(true);
    (async () => {
      const o = { lat: ordered[0].lat, lng: ordered[0].lng };
      const d = { lat: ordered[ordered.length - 1].lat, lng: ordered[ordered.length - 1].lng };
      const via = ordered.slice(1, -1).map((p): [number, number] => [p.lng, p.lat]);
      const grab = async (avoidHighways: boolean): Promise<PlanRoute | null> => {
        try {
          const r = await fetchMapboxRouteVia(
            o, via, d,
            { tolls: false, highways: avoidHighways, ferries: false },
            { signal: ctrl.signal },
          );
          if (!r?.polyline) return null;
          return {
            polyline: r.polyline,
            coords: decodePolyline(r.polyline).map((p): [number, number] => [p.lng, p.lat]),
            distanceM: r.distance_m,
            durationS: r.duration_s,
          };
        } catch { return null; }
      };
      const [fastest, scenic] = await Promise.all([grab(false), grab(true)]);
      if (cancelled) return;
      setRoutes({ fastest, scenic });
      onRoutesRef.current?.({ fastest, scenic });
      // A straight line is NOT a route, so say so rather than quietly implying one.
      setHint(fastest || scenic ? null : 'Could not route through these points yet.');
      setBusy(false);
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

  // Selected line on top, the alternative dimmed underneath. lineSortKey floats the
  // chosen one so it is never hidden where they overlap.
  const sel = style === 'scenic' ? routes.scenic : routes.fastest;
  const other = style === 'scenic' ? routes.fastest : routes.scenic;
  const routeFC: any = {
    type: 'FeatureCollection',
    features: [
      ...(other && other.coords.length >= 2
        ? [{ type: 'Feature', properties: { sel: 0 }, geometry: { type: 'LineString', coordinates: other.coords } }]
        : []),
      ...(sel && sel.coords.length >= 2
        ? [{ type: 'Feature', properties: { sel: 1 }, geometry: { type: 'LineString', coordinates: sel.coords } }]
        : []),
    ],
  };
  const hasAnyLine = routeFC.features.length > 0;

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

        {hasAnyLine && (
          <ShapeSource id="cruise-plan-route" shape={routeFC}>
            <LineLayer
              id="cruise-plan-casing"
              style={{
                lineColor: '#0B0B0C',
                lineWidth: ['case', ['==', ['get', 'sel'], 1], 8, 6] as any,
                lineOpacity: ['case', ['==', ['get', 'sel'], 1], 0.5, 0.3] as any,
                lineCap: 'round', lineJoin: 'round',
                lineSortKey: ['get', 'sel'] as any,
              }}
            />
            <LineLayer
              id="cruise-plan-core"
              style={{
                lineColor: ['case', ['==', ['get', 'sel'], 1], COLORS.primary, '#8E8E93'] as any,
                lineWidth: ['case', ['==', ['get', 'sel'], 1], 4, 2.5] as any,
                lineOpacity: ['case', ['==', ['get', 'sel'], 1], 1, 0.75] as any,
                lineCap: 'round', lineJoin: 'round',
                lineSortKey: ['get', 'sel'] as any,
              }}
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
