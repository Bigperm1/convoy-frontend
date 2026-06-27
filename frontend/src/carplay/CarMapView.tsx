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

import React, { useState, useRef, useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Mapbox, {
  MapView,
  Camera,
  ShapeSource,
  LineLayer,
  Models,
  UserTrackingMode,
} from '@rnmapbox/maps';
import { useCarStore } from './carStore';
import { getVehicleModelUrl } from '../vehicleAssets';
import {
  CAR_EMISSIVE_BY_MODE,
  FOLLOW_ZOOM,
  FOLLOW_LOWER_PAD_FRAC,
  ROUTE_GREEN_CORE,
  ROUTE_GREEN_GLOW,
  chaseZoom,
  chasePitch,
  kmhFromMs,
  decodePolyline,
  SelfCarModel,
  projectOntoRoute,
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
const CAR_ZOOM_OUT = 0.7;
// Pull back MORE during active nav — the phone's tight chase zoom read "way too close"
// on the head unit. Larger = more road ahead while routing. OTA-tunable.
const CAR_ZOOM_OUT_NAV = 1.5;
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

  // Base-map style — mirror the phone's useStandard logic so the car matches the
  // driver's chosen look. satellite → SatelliteStreet imagery; everything else →
  // Standard with the matching light preset (set via <StyleImport> below).
  const mode = s.mapMode ?? DEFAULT_MODE;
  const useStandard = mode !== 'satellite';
  const styleURL = useStandard ? 'mapbox://styles/mapbox/standard' : Mapbox.StyleURL.SatelliteStreet;
  const emissive = CAR_EMISSIVE_BY_MODE[mode] ?? 0;

  // Chase camera (phone math): speed-aware zoom + pitch while navigating, calm cruise
  // framing otherwise. Pulled back vs the phone's raw chase so more road reads on the
  // wide head-unit — MORE during nav (the tight chase zoom was too close).
  const kmh = kmhFromMs(s.speedMs);
  const followZoom = s.navigating
    ? chaseZoom(kmh, s.distanceToTurnM) - CAR_ZOOM_OUT_NAV
    : FOLLOW_ZOOM - CAR_ZOOM_OUT;
  const followPitch = s.navigating ? chasePitch(kmh) : CRUISE_PITCH;
  const followPadding = (s.navigating && mapH > 0)
    ? { paddingTop: Math.round(mapH * FOLLOW_LOWER_PAD_FRAC), paddingBottom: 0, paddingLeft: 0, paddingRight: 0 }
    : undefined;

  // MANDATORY heading-up — mirror the phone: plain Follow + a HELD heading, NOT
  // FollowWithCourse (which wobbles on raw GPS course and spins when stopped). Holding
  // the last good heading keeps the map heading-up even at a standstill.
  const camHdgRef = useRef(hdg);
  if (typeof s.heading === 'number') camHdgRef.current = s.heading;
  const followHeadingDeg = camHdgRef.current;

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
  const coreGrad = buildLineFade('rgba(45,236,134,1)', 'rgba(45,236,134,0)');
  const glowGrad = buildLineFade('rgba(0,224,112,1)', 'rgba(0,224,112,0)');
  const routeFC: any = {
    type: 'FeatureCollection',
    features: hasRoute
      ? [{ type: 'Feature', properties: { index: SELECTED_INDEX }, geometry: { type: 'LineString', coordinates: routeCoords } }]
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

      {/* Heading-up chase camera. Zoom/pitch/padding mirror the phone during nav.
          It follows the eased CustomLocationProvider that <SelfCarModel/> emits
          below (the smooth interpolated track), not raw GPS. */}
      <Camera
        followUserLocation={hasFix}
        followUserMode={UserTrackingMode.Follow}
        followZoomLevel={followZoom}
        followHeading={followHeadingDeg}
        followPitch={followPitch}
        followPadding={followPadding}
        defaultSettings={hasFix ? { centerCoordinate: [lng, lat], zoomLevel: followZoom, heading: followHeadingDeg } : undefined}
      />

      {/* Register the self-car 3D model for the chosen paint. */}
      <Models models={{ convoyCar: getVehicleModelUrl(s.selfCarColor) }} />

      {/* 3D self car + the native location feed, BOTH driven off ONE rAF-eased pose
          (SelfCarModel, reused verbatim from the phone). This is THE smoothness fix:
          it tweens selfLat/selfLng/heading between ~1Hz GPS ticks at ~60fps and feeds
          the eased point to its own <CustomLocationProvider> AND the car ModelLayer,
          so the follow camera and the 3D car glide in lockstep instead of teleporting
          per tick. Requires <Models/> above (model registration) — keep it. */}
      {hasFix && (
        <SelfCarModel lat={lat} lng={lng} heading={hdg} emissive={emissive} />
      )}

      {/* Route — gray alternates (filtered out for the single active route),
          then the green glow casing + bright core. Imported route colors keep
          this in lockstep with the phone's selected ribbon. */}
      {hasRoute && (
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
            style={{ lineWidth: 24, lineBlur: 8, lineOpacity: 0.55, lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1, ...(glowGrad ? { lineGradient: glowGrad, lineTrimOffset: [0, routeTrimEndFrac ?? 1] } : { lineColor: ROUTE_GREEN_GLOW }) }}
          />
          <LineLayer
            id="car-route-sel-core"
            slot="middle"
            filter={['==', ['get', 'index'], SELECTED_INDEX] as any}
            style={{ lineWidth: 12, lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1, ...(coreGrad ? { lineGradient: coreGrad, lineTrimOffset: [0, routeTrimEndFrac ?? 1] } : { lineColor: ROUTE_GREEN_CORE }) }}
          />
        </ShapeSource>
      )}
    </MapView>
  );
}
