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
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Image } from 'react-native';
import Mapbox, { MapView, Camera, ShapeSource, LineLayer, MarkerView } from '@rnmapbox/maps';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import { fetchMapboxRouteVia } from '../mapboxDirections';
import { decodePolyline } from '../nav';
import { getSettings, getRouteColor } from '../settings';

export type PlanPoint = { lat: number; lng: number; label?: string };

// ── SAME BASEMAP AS THE MAIN MAP, LOCKED TO DUSK (2026-07-30, Jeff's call) ───
// This used to pick between the generic `dark-v11` / `streets-v12` / satellite
// styles, which is why the planner looked nothing like the app: the drive map uses
// Mapbox STANDARD with a time-of-day lightPreset (ConvoyMapbox :1853), giving the
// tilted dark vector basemap with 3D buildings. Same style URL here, and the preset
// is PINNED to 'dusk' rather than following the user's map mode — a planner is used
// indoors at any hour, and dusk is the look the route line and pins were designed
// against, so it stays legible no matter what the driver has set for driving.
const PLAN_STYLE_URL = 'mapbox://styles/mapbox/standard';
const PLAN_LIGHT_PRESET = 'dusk';

export type PlanStyle = 'fastest' | 'scenic';
export type PlanRoute = { polyline: string; coords: [number, number][]; distanceM: number; durationS: number };
export type PlanRoutes = { fastest: PlanRoute | null; scenic: PlanRoute | null };

export default function CruisePlanMap({
  start, stops, end, onAddStop, style = 'fastest', showScenic = true, onRoutes, height = 260,
}: {
  start: PlanPoint | null;
  stops: PlanPoint[];
  end: PlanPoint | null;
  onAddStop: (p: PlanPoint) => void;
  // Which line is the chosen one. The other is still drawn, dimmed, so the trade-off
  // is visible on the map rather than only in a chip — the way Maps shows it.
  style?: PlanStyle;
  // Set false when the caller has withdrawn the scenic option (e.g. it is absurdly
  // longer). Keeps the map honest with the chips instead of drawing a line the UI says
  // does not exist.
  showScenic?: boolean;
  // Both variants handed back so the creator can label the chips with real numbers and
  // store the chosen polyline with the cruise.
  onRoutes?: (r: PlanRoutes) => void;
  height?: number;
}) {
  // The DRIVE map's route colour (settings.routeColor, brand green by default) — not
  // COLORS.primary, which is the UI's system blue and is why the planner's line read as
  // a different feature entirely from the route people navigate.
  const routeColor = getRouteColor(getSettings());
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

  // ── AUTO-FIT, AND WHEN TO STOP ──────────────────────────────────────────────
  // Two bugs were caught here by actually looking at the screen in the simulator
  // (2026-07-29), which is why this is more than a one-liner:
  //
  // 1. The map opened on NEW YORK with the meeting point set to Horseshoe Bay. The
  //    fit ran on the first render, before the GL map had finished loading, so
  //    setCamera was silently dropped — the same "camera before the map is ready"
  //    trap CarMapView's cold-start snap exists to work around. So the fit now also
  //    runs on onDidFinishLoadingMap, and `fittedRef` is only stamped once a fit has
  //    actually been attempted against a READY map.
  // 2. Fitting only the FIRST set of points meant adding an end location never
  //    re-framed to include it. The right rule is not "once" but "until the planner
  //    takes the wheel": keep framing everything while they build the route, and stop
  //    the instant they pan or pinch, so their viewport is never yanked away.
  const mapReadyRef = useRef(false);
  const userMovedRef = useRef(false);
  const fittedRef = useRef<string>('');
  const maybeFit = () => {
    if (!mapReadyRef.current || !sig || sig === fittedRef.current) return;
    if (userMovedRef.current) { fittedRef.current = sig; return; } // their camera now
    fittedRef.current = sig;
    fitToPoints();
  };
  useEffect(() => {
    maybeFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Selected line on top, the alternative dimmed underneath. lineSortKey floats the
  // chosen one so it is never hidden where they overlap.
  const scenicLine = showScenic ? routes.scenic : null;
  const sel = style === 'scenic' ? scenicLine : routes.fastest;
  const other = style === 'scenic' ? routes.fastest : scenicLine;
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
        styleURL={PLAN_STYLE_URL}
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
        onDidFinishLoadingMap={() => { mapReadyRef.current = true; maybeFit(); }}
        onCameraChanged={(e: any) => {
          const z = e?.properties?.zoom;
          if (typeof z === 'number' && Number.isFinite(z)) zoomRef.current = z;
          // A pan or pinch hands the viewport to the planner for good — see maybeFit.
          if (e?.gestures?.isGestureActive) userMovedRef.current = true;
        }}
      >
        <Camera ref={cameraRef} />

        {/* The Standard basemap's lighting — the same StyleImport the drive map uses
            (ConvoyMapbox :2602), pinned to dusk. `existing` targets the style's own
            basemap import rather than adding a second one. */}
        <Mapbox.StyleImport id="basemap" existing config={{ lightPreset: PLAN_LIGHT_PRESET }} />

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
                lineColor: ['case', ['==', ['get', 'sel'], 1], routeColor, '#8E8E93'] as any,
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

        {/* Stops + end use the HAIRPIN BRAND PIN — the same art and the same numbered
            badge the drive map draws (ConvoyMapbox destination pin + stop pins), so a
            planned trip and a live one read identically. The meeting point keeps a flag
            instead: it is a rally point, not a destination, and the drive map has no
            equivalent to copy. */}
        {stops.map((s, i) => (
          <MarkerView key={`plan-stop-${i}-${s.lat.toFixed(5)},${s.lng.toFixed(5)}`} coordinate={[s.lng, s.lat]} anchor={{ x: 0.5, y: 1 }}>
            <View style={styles.brandPinWrap}>
              <Image source={require('../../assets/images/brand-pin.png')} style={styles.brandPin} resizeMode="contain" />
              <View style={styles.brandPinBadge}>
                <Text style={styles.brandPinNum}>{i + 1}</Text>
              </View>
            </View>
          </MarkerView>
        ))}

        {end && (
          <MarkerView coordinate={[end.lng, end.lat]} anchor={{ x: 0.5, y: 1 }}>
            <Image source={require('../../assets/images/brand-pin.png')} style={styles.brandPin} resizeMode="contain" />
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
        <TouchableOpacity
          style={styles.zoomBtn}
          onPress={() => { userMovedRef.current = false; fittedRef.current = sig; fitToPoints(); }}
          hitSlop={6}
        >
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
  pinStart: { backgroundColor: '#2DEC86' },
  // Brand pin, same geometry as the drive map's (ConvoyMapbox brandPin / brandPinBadge):
  // 73x95 source at 34x44, badge centred on the pin's round head.
  brandPin: { width: 34, height: 44 },
  brandPinWrap: { width: 34, height: 44, alignItems: 'center' },
  brandPinBadge: {
    position: 'absolute', top: 5, left: 7, width: 20, height: 20, borderRadius: 10,
    backgroundColor: '#0A1A10', alignItems: 'center', justifyContent: 'center',
  },
  brandPinNum: { color: '#2DEC86', fontSize: 14, fontWeight: '800' },
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
