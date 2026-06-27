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
  ModelLayer,
  CustomLocationProvider,
  UserTrackingMode,
} from '@rnmapbox/maps';
import { useCarStore } from './carStore';
import { getVehicleModelUrl } from '../vehicleAssets';
import {
  CAR_MODEL_SCALE_SIZED,
  CAR_MODEL_HEADING_OFFSET,
  CAR_EMISSIVE_BY_MODE,
  FOLLOW_ZOOM,
  FOLLOW_LOWER_PAD_FRAC,
  ROUTE_GREEN_CORE,
  ROUTE_GREEN_GLOW,
  chaseZoom,
  chasePitch,
  kmhFromMs,
  decodePolyline,
} from '../ConvoyMapbox';

// Single active route only → it lives at index 0; the alts layer filters it out
// (index != 0) and the casing/core draw it (index == 0), exactly like the phone.
const SELECTED_INDEX = 0;
// Cruising tilt when NOT navigating — the phone uses pitch 0 off-nav, but on the
// car we want the Standard 3D buildings to read, so we hold a gentle tilt. During
// nav we use the phone's speed-aware chasePitch instead.
const CRUISE_PITCH = 45;
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

  // Chase camera (phone math): speed-aware zoom + pitch while navigating, calm
  // cruise framing otherwise. Heading-up via FollowWithCourse.
  const kmh = kmhFromMs(s.speedMs);
  const followZoom = s.navigating ? chaseZoom(kmh, s.distanceToTurnM) : FOLLOW_ZOOM;
  const followPitch = s.navigating ? chasePitch(kmh) : CRUISE_PITCH;
  const followPadding = (s.navigating && mapH > 0)
    ? { paddingTop: Math.round(mapH * FOLLOW_LOWER_PAD_FRAC), paddingBottom: 0, paddingLeft: 0, paddingRight: 0 }
    : undefined;

  // Active route → GeoJSON. Only drawn when the polyline decodes to a real line.
  const routeCoords = decodePolyline(s.routePolyline).map((p) => [p.longitude, p.latitude]);
  const hasRoute = routeCoords.length >= 2;
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

      {/* Feed the carStore position into Mapbox's native location source so the
          follow camera tracks it on the CarPlay window — the car scene has no
          device GPS of its own. Mirrors the phone's SelfCarModel provider. */}
      <CustomLocationProvider coordinate={[lng, lat]} heading={hdg} />

      {/* Heading-up chase camera. Zoom/pitch/padding mirror the phone during nav. */}
      <Camera
        followUserLocation={hasFix}
        followUserMode={UserTrackingMode.FollowWithCourse}
        followZoomLevel={followZoom}
        followPitch={followPitch}
        followPadding={followPadding}
        defaultSettings={hasFix ? { centerCoordinate: [lng, lat], zoomLevel: followZoom } : undefined}
      />

      {/* Register the self-car 3D model for the chosen paint. */}
      <Models models={{ convoyCar: getVehicleModelUrl(s.selfCarColor) }} />

      {/* 3D self car at the live position, rotated to the travel direction.
          Style object is the phone's verbatim, using the imported constants. */}
      {hasFix && (
        <ShapeSource
          id="car-self"
          shape={{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lng, lat] } }}
        >
          <ModelLayer
            id="car-self-model"
            slot="top"
            style={{
              modelId: 'convoyCar',
              modelType: 'common-3d',
              modelEmissiveStrength: emissive,
              modelScale: CAR_MODEL_SCALE_SIZED,
              modelRotation: [0, 0, hdg + CAR_MODEL_HEADING_OFFSET],
              modelCastShadows: false,
              modelReceiveShadows: false,
            }}
          />
        </ShapeSource>
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
            style={{ lineWidth: 24, lineBlur: 8, lineOpacity: 0.55, lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1, lineColor: ROUTE_GREEN_GLOW }}
          />
          <LineLayer
            id="car-route-sel-core"
            slot="middle"
            filter={['==', ['get', 'index'], SELECTED_INDEX] as any}
            style={{ lineWidth: 12, lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1, lineColor: ROUTE_GREEN_CORE }}
          />
        </ShapeSource>
      )}
    </MapView>
  );
}
