// src/carplay/CarMapView.tsx
//
// Trimmed, standalone Mapbox map for the CarPlay window (Path A). Renders ONLY
// the car dashboard's map: a live @rnmapbox <MapView>, an always-follow heading-up
// chase camera (mirrors the phone's chaseZoom/chasePitch), the 3D GR Corolla
// (ModelLayer), and the active route. Everything else the phone map carries —
// peers, places, weather, hazards, congestion fetches, gesture-pan — is absent so
// this stays small and robust on the late-sizing CarPlay secondary window.
//
// Fed ENTIRELY from carStore (no props from the phone tree, no context providers):
// position/heading/route/paint/mapMode/speed all come from useCarStore(). The
// Mapbox token is set globally by src/initMapbox (already in the bundle).
//
// Styling + camera stay in LOCKSTEP with the phone map: the style constants, the
// chase-cam math, and the polyline decoder are IMPORTED from ConvoyMapbox (named
// exports), never copied — so a phone tweak updates the car too.
//
// GL safety: onDidFailLoadingMap -> onGLError(), which the CarPlay surface uses to
// drop back to the static-image fallback (ConvoyCarPlay's showLive/glFailed).

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Mapbox, {
  MapView,
  Camera,
  ShapeSource,
  LineLayer,
  Models,
} from '@rnmapbox/maps';
import { useCarStore } from './carStore';
import { buildCongestionGradient } from '../mapboxDirections';
import { getVehicleModelUrl, getVehicleModelKey } from '../vehicleAssets';
import {
  CAR_EMISSIVE_BY_MODE,
  ROUTE_GREEN_CORE,
  routeRgba,
  chaseZoom,
  chasePitch,
  kmhFromMs,
  decodePolyline,
  SelfCarModel,
  projectOntoRoute,
  carModelScale,
} from '../ConvoyMapbox';

// Single active route only → it lives at index 0; the alts layer filters it out
// (index != 0) and the casing/core draw it (index == 0), exactly like the phone.
const SELECTED_INDEX = 0;
// Cruising tilt when NOT navigating — the phone uses pitch 0 off-nav, but on the
// car we want the Standard 3D buildings to read, so we hold a gentle tilt. During
// nav we use the phone's speed-aware chasePitch instead.
const CRUISE_PITCH = 45;
// Pull the car camera back a touch vs the phone so more of the road ahead reads on the
// wide head-unit screen. Subtracted from the phone's zoom (Mapbox zoom is log2, so 0.7
// ≈ 1.6x more area) for both nav and cruise.
// Pull the camera back from the phone's chase zoom so more road reads on the wide
// head-unit screen. Applied to BOTH nav AND cruise (which is now speed-aware too).
// Larger = more zoomed out. OTA-tunable.
const CAR_ZOOM_OUT = 1.8;
// EXTRA pull-back while previewing 2+ route options (not navigating), so the Best/Scenic/AI
// fan-out reads on the head unit. Added to CAR_ZOOM_OUT only in multi-route preview; the
// car stays pinned (the proven lockstep chase is untouched — this is purely a zoom value).
const PREVIEW_ZOOM_OUT = 2.2;

// Top padding as a fraction of map height — pins the car near the BOTTOM-MIDDLE of the
// head unit (larger = lower on screen). Applied every frame via getCam, nav AND cruise.
const CAR_LOWER_PAD_FRAC = 0.42;
// Cache miss on a cold bg JS context can leave mapMode undefined → fall back to the
// phone's default look ('dusk'), so the car never shows a bare default style.
const DEFAULT_MODE = 'dusk';
// Positive-frame watchdog: if the GL map hasn't painted a real frame within this
// window after mount, demote to the static surface. The secondary CarPlay window
// can leave the Metal map silently blank, and rnmapbox's onDidFailLoadingMap is a
// DEAD event on iOS — so we trust a POSITIVE paint signal (onDidFinishRenderingFrameFully)
// and treat its absence as failure, rather than waiting for an error that never comes.
const PAINT_WATCHDOG_MS = 6000;

type Props = {
  // Called when the GL map fails or never paints on the CarPlay window, so the
  // surface can fall back to the static <Image>. Driven by onMapLoadingError AND
  // the positive-frame watchdog below (NOT onDidFailLoadingMap — dead on iOS).
  onGLError?: () => void;
};

export default function CarMapView({ onGLError }: Props) {
  const s = useCarStore();
  const [mapH, setMapH] = useState(0);

  // Frame watchdog state. paintedRef flips on the first real rendered frame;
  // firedRef ensures onGLError fires at most once. The map can never get stuck
  // blank: either it paints (watchdog cleared) or the timeout demotes to static.
  const paintedRef = useRef(false);
  const firedRef = useRef(false);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fail = () => {
    if (firedRef.current || paintedRef.current) return;
    firedRef.current = true;
    onGLError?.();
  };
  const markPainted = () => {
    paintedRef.current = true;
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  };

  useEffect(() => {
    // Start the watchdog from MOUNT (after the CarPlay handshake), not connect.
    watchdogRef.current = setTimeout(() => {
      if (!paintedRef.current) fail();
    }, PAINT_WATCHDOG_MS);
    return () => { if (watchdogRef.current) clearTimeout(watchdogRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasFix = typeof s.selfLat === 'number' && typeof s.selfLng === 'number';
  const lat = s.selfLat ?? 0;
  const lng = s.selfLng ?? 0;
  const hdg = s.heading ?? 0;

  // Multi-route PREVIEW mode: the phone mirrors 2+ display routes (Best/Scenic/AI) only
  // while NOT navigating. In nav (or a single route) s.routes is empty → we fall back to
  // the single selected ribbon below (with its trim), exactly as before.
  const previewMulti = !s.navigating && Array.isArray(s.routes) && s.routes.length >= 2;
  const selIdx = s.selectedRouteIndex ?? SELECTED_INDEX;

  // Base-map style — mirror the phone's useStandard logic so the car matches the
  // driver's chosen look. satellite → SatelliteStreet imagery; everything else →
  // Standard with the matching light preset (set via <StyleImport> below).
  const mode = s.mapMode ?? DEFAULT_MODE;
  const useStandard = mode !== 'satellite';
  const styleURL = useStandard ? 'mapbox://styles/mapbox/standard' : Mapbox.StyleURL.SatelliteStreet;
  const emissive = CAR_EMISSIVE_BY_MODE[mode] ?? 0;
  // Color-specific model id so a car-color change swaps the 3D model live (Mapbox
  // caches a model by id; a fixed id won't reload a new .glb until remount).
  const carModelId = 'convoyCar_' + getVehicleModelKey(s.selfCarColor);

  // Speed-aware zoom for BOTH nav AND cruise — chaseZoom with no turn distance is a pure
  // speed→zoom curve (city tighter, highway wider), so cruise now dynamically zooms in/out
  // with speed too. Pulled back by CAR_ZOOM_OUT so more road reads on the wide screen.
  const kmh = kmhFromMs(s.speedMs);
  const followZoom = chaseZoom(kmh, s.navigating ? s.distanceToTurnM : undefined) - CAR_ZOOM_OUT - (previewMulti ? PREVIEW_ZOOM_OUT : 0);
  const followPitch = s.navigating ? chasePitch(kmh) : CRUISE_PITCH;

  // MANDATORY heading-up — mirror the phone: plain Follow + a HELD heading, NOT
  // FollowWithCourse (which wobbles on raw GPS course and spins when stopped). Holding
  // the last good heading keeps the map heading-up even at a standstill.
  const camHdgRef = useRef(hdg);
  if (typeof s.heading === 'number') camHdgRef.current = s.heading;
  const followHeadingDeg = camHdgRef.current;

  // LOCKSTEP camera (see SelfCarModel): a cameraRef on THIS car-window map + a per-frame
  // getCam closure. The car is pinned to a fixed screen spot (near bottom-middle) and the
  // map rotates/translates around it. paintedRef (first rendered frame) + hasFix gate it
  // so we never queue 60fps setCamera calls before the surface is live.
  const cameraRef = useRef<React.ElementRef<typeof Camera> | null>(null);
  const lockReadyRef = useRef(false);
  lockReadyRef.current = paintedRef.current && hasFix;
  const getCam = useCallback(() => ({
    zoomLevel: followZoom,
    pitch: followPitch,
    heading: camHdgRef.current,
    // Bottom-middle: a large paddingTop pushes the pinned car DOWN the wide head-unit.
    padding: { paddingTop: mapH > 0 ? Math.round(mapH * CAR_LOWER_PAD_FRAC) : 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0 },
  }), [followZoom, followPitch, mapH]);

  // Active route → GeoJSON. Only drawn when the polyline decodes to a real line.
  const routeLL = decodePolyline(s.routePolyline);
  const routeCoords = routeLL.map((p) => [p.longitude, p.latitude]);
  const hasRoute = routeCoords.length >= 2;

  // BUFFER the green line off the car (mirror the phone): project the car onto the
  // route and TRIM the line so it starts a speed-aware lead AHEAD of the nose, with a
  // soft transparent→solid fade just past the trim so it doesn't hard-start into the
  // car. Navigating only; preview/cruise keeps the solid line.
  const routeProj = (s.navigating && hasFix && hasRoute) ? projectOntoRoute(lat, lng, routeLL) : null;
  const trimLeadM = Math.max(6, Math.min(16, 6 + (s.speedMs > 0 ? s.speedMs : 0) * 0.34));
  const routeTrimEndFrac = routeProj
    ? Math.max(0, Math.min(0.999, routeProj.frac + trimLeadM / routeProj.totalM))
    : null;
  const fadeSpanFrac = routeProj ? Math.max(0.0008, Math.min(0.06, 20 / routeProj.totalM)) : 0;
  const buildLineFade = (solid: string, clear: string): any => {
    if (routeTrimEndFrac == null) return null;
    const s0 = Math.min(0.997, Math.max(0.0001, routeTrimEndFrac));
    const s1 = Math.min(0.999, Math.max(s0 + 0.0006, s0 + fadeSpanFrac));
    return ['interpolate', ['linear'], ['line-progress'], 0, clear, s0, clear, s1, solid, 1, solid];
  };
  // User-chosen route color (mirrored from the phone via carStore). Core + glow + the
  // near-car fade all derive from it; falls back to brand green.
  const carRouteColor = s.routeColor || ROUTE_GREEN_CORE;
  const coreGrad = buildLineFade(routeRgba(carRouteColor, 1), routeRgba(carRouteColor, 0));
  const glowGrad = buildLineFade(routeRgba(carRouteColor, 1), routeRgba(carRouteColor, 0));
  const routeFC: any = {
    type: 'FeatureCollection',
    features: hasRoute
      ? [{ type: 'Feature', properties: { index: SELECTED_INDEX }, geometry: { type: 'LineString', coordinates: routeCoords } }]
      : [],
  };

  // ===== Live congestion gradient (mirror of the phone) =====
  // The selected route's per-segment congestion + geometry are mirrored from the phone
  // via carStore. Build the SAME green->yellow->orange->red line-progress gradient and
  // paint it on a DEDICATED, NON-TRIMMED layer (a clone of the phone's route-sel-cong) —
  // built from the SAME coordinates the gradient indexes, so line-progress stays aligned.
  // NOTE: like the phone, the gradient must NOT share a layer with lineTrimOffset (a
  // multi-colour gradient flattens to solid when trimmed); the trimmed glow casing below
  // keeps the behind-car vanish, this untrimmed core supplies the colours.
  const carCongGradient = useMemo(() => {
    const coords = s.routeCoordinates;
    const cong = s.routeCongestion as any;
    if (!coords || coords.length < 2 || !cong || cong.length === 0) return null;
    const g = buildCongestionGradient(coords, cong, carRouteColor);
    return Array.isArray(g) ? g : (['interpolate', ['linear'], ['line-progress'], 0, g, 1, g] as any);
  }, [s.routeCoordinates, s.routeCongestion, carRouteColor]);
  const carCongFC: any = {
    type: 'FeatureCollection',
    features: (carCongGradient && s.routeCoordinates && s.routeCoordinates.length >= 2)
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: s.routeCoordinates } }]
      : [],
  };

  // Multi-route PREVIEW geometry → one feature per display route, carrying its precomputed
  // per-kind core `color` + casing `edge` (AI = black core, user-color edge) so a single
  // data-driven layer pair paints all three. lineSortKey floats the SELECTED route on top.
  const previewFC: any = {
    type: 'FeatureCollection',
    features: previewMulti
      ? (s.routes || [])
          .map((r) => {
            const coords = decodePolyline(r.polyline).map((p) => [p.longitude, p.latitude]);
            return coords.length >= 2
              ? { type: 'Feature', properties: { index: r.index, color: r.color, edge: r.edge }, geometry: { type: 'LineString', coordinates: coords } }
              : null;
          })
          .filter(Boolean)
      : [],
  };

  return (
    <MapView
      style={StyleSheet.absoluteFill}
      styleURL={styleURL}
      projection="mercator"
      // Let the GL map present at the head unit's full refresh (clamped by the panel,
      // ~60Hz max — a car display can't do 120). Only meaningful WITH the SelfCarModel
      // interpolation above; on a raw 1Hz feed it just re-renders a stale pose.
      preferredFramesPerSecond={60}
      scaleBarEnabled={false}
      compassEnabled={false}
      rotateEnabled={false}
      pitchEnabled={false}
      logoEnabled={false}
      attributionEnabled={false}
      onLayout={(e: any) => {
        const h = e?.nativeEvent?.layout?.height;
        if (typeof h === 'number' && h > 0 && Math.abs(h - mapH) > 1) setMapH(h);
      }}
      // Real native iOS events (onDidFailLoadingMap is a no-op on iOS — do NOT use):
      // a rendered frame clears the watchdog; a style/tile load error demotes now.
      onDidFinishRenderingFrameFully={markPainted}
      onMapLoadingError={() => fail()}
    >
      {/* Standard basemap with the phone's light preset (3D buildings on). Only
          mounted for Standard; harmless to omit on satellite. `config` is cast to
          any to pass the boolean show3dObjects to native — same as the phone. */}
      {useStandard && (
        <Mapbox.StyleImport id="basemap" existing config={{ lightPreset: mode, show3dObjects: true } as any} />
      )}

      {/* LOCKSTEP camera — NO followUserLocation. SelfCarModel drives this camera
          imperatively (cameraRef.setCamera) on the SAME rAF tick that moves the 3D car,
          with animationMode="none" so each frame is an instant state-set (no second
          native interpolator fighting the JS tween). That pins the car to a fixed screen
          spot (bottom-middle via getCam's padding) and rotates/translates the map AROUND
          it — killing the camera stutter. defaultSettings only seeds the first frame. */}
      {/* NO defaultSettings. It previously flipped undefined→{close camera} when the fix
          landed, and @rnmapbox animates that change as a fly-in from the zoomed-out default
          — the "zoom in from far away" on cold start. With none, there is nothing to
          animate: the camera sits at the style default (hidden behind the CarPlay splash)
          until SelfCarModel's FIRST move HARD-SNAPS it to the car (pushCam, animationMode
          'none' → instant, no fly-in). followUserLocation stays off; the lockstep owns the
          camera exactly as before. */}
      <Camera
        ref={cameraRef}
        followUserLocation={false}
        animationMode="none"
        animationDuration={0}
      />

      {/* Register the self-car 3D model for the chosen paint. */}
      <Models key={carModelId} models={{ [carModelId]: getVehicleModelUrl(s.selfCarColor) }} />

      {/* 3D self car + the native location feed, BOTH driven off ONE rAF-eased pose
          (SelfCarModel, reused verbatim from the phone). This is THE smoothness fix:
          it tweens selfLat/selfLng/heading between ~1Hz GPS ticks at ~60fps and feeds
          the eased point to its own <CustomLocationProvider> AND the car ModelLayer,
          so the follow camera and the 3D car glide in lockstep instead of teleporting
          per tick. Requires <Models/> above (model registration) — keep it. */}
      {hasFix && (
        <SelfCarModel
          lat={lat}
          lng={lng}
          heading={hdg}
          emissive={emissive}
          modelId={carModelId}
          cameraRef={cameraRef}
          getCam={getCam}
          readyRef={lockReadyRef}
          scale={carModelScale(0.7)}
        />
      )}

      {/* Routes. PREVIEW (not navigating, 2+ options): all display routes (Best/Scenic/AI)
          drawn together per-kind via ONE data-driven casing+core pair — the SELECTED route
          full + wide, the others dimmed + thin (lineSortKey floats the selected on top).
          NAV / single route: the existing single selected ribbon below, with the speed-aware
          trim + near-car fade, exactly as before (the proven path is untouched). */}
      {previewMulti ? (
        <ShapeSource id="car-routes-preview" shape={previewFC}>
          <LineLayer
            id="car-preview-casing"
            slot="middle"
            style={{
              lineColor: ['get', 'edge'] as any,
              lineWidth: ['case', ['==', ['get', 'index'], selIdx], 22, 16] as any,
              lineOpacity: ['case', ['==', ['get', 'index'], selIdx], 0.55, 0.4] as any,
              lineSortKey: ['case', ['==', ['get', 'index'], selIdx], 1, 0] as any,
              lineBlur: 6, lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1,
            }}
          />
          <LineLayer
            id="car-preview-core"
            slot="middle"
            style={{
              lineColor: ['get', 'color'] as any,
              lineWidth: ['case', ['==', ['get', 'index'], selIdx], 11, 7] as any,
              lineOpacity: ['case', ['==', ['get', 'index'], selIdx], 1, 0.7] as any,
              lineSortKey: ['case', ['==', ['get', 'index'], selIdx], 1, 0] as any,
              lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1,
            }}
          />
        </ShapeSource>
      ) : hasRoute ? (
        <ShapeSource id="car-route" shape={routeFC} lineMetrics>
          <LineLayer
            id="car-route-alts"
            slot="middle"
            filter={['!=', ['get', 'index'], SELECTED_INDEX] as any}
            style={{ lineColor: '#9AA0A6', lineWidth: 5, lineCap: 'round', lineJoin: 'round', lineOpacity: 0.85, lineEmissiveStrength: 1 }}
          />
          <LineLayer
            id="car-route-sel-casing"
            slot="middle"
            filter={['==', ['get', 'index'], SELECTED_INDEX] as any}
            style={{ lineWidth: 24, lineBlur: 8, lineOpacity: 0.55, lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1, ...(glowGrad ? { lineGradient: glowGrad, lineTrimOffset: [0, routeTrimEndFrac ?? 1] } : { lineColor: carRouteColor }) }}
          />
          <LineLayer
            id="car-route-sel-core"
            slot="middle"
            // Hidden when the congestion core (below) is active, so it can't paint over
            // the colours; the casing above keeps the trim/vanish.
            filter={(carCongGradient ? ['==', ['get', 'index'], -1] : ['==', ['get', 'index'], SELECTED_INDEX]) as any}
            style={{ lineWidth: 12, lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1, ...(coreGrad ? { lineGradient: coreGrad, lineTrimOffset: [0, routeTrimEndFrac ?? 1] } : { lineColor: carRouteColor }) }}
          />
        </ShapeSource>
      ) : null}

      {/* CONGESTION core — the selected route's live traffic gradient, NON-TRIMMED, drawn
          ON TOP of whichever route branch is active (preview or nav). Mirrors the phone's
          route-sel-cong; the glow casing in the branches above keeps the behind-car vanish.
          Built from the SAME mirrored coordinates the gradient indexes, so it stays aligned. */}
      {carCongGradient && (
        <ShapeSource id="car-congestion" shape={carCongFC} lineMetrics>
          <LineLayer
            id="car-cong-core"
            slot="middle"
            style={{ lineGradient: carCongGradient, lineWidth: 12, lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1 }}
          />
        </ShapeSource>
      )}
    </MapView>
  );
}
