// src/carplay/CarMapView.tsx
//
// Trimmed, standalone Mapbox map for the CarPlay window (Path A). Renders ONLY
// the car dashboard's map: a live @rnmapbox <MapView> with the Standard "day"
// basemap, an always-follow heading-up camera, the 3D GR Corolla (ModelLayer),
// and the active route. Everything else the phone map carries — peers, places,
// weather, hazards, congestion fetches, gesture-pan — is intentionally absent so
// this is small and robust on the late-sizing CarPlay secondary window.
//
// Fed ENTIRELY from carStore (no props from the phone tree, no context
// providers): position/heading/route/paint all come from useCarStore(). The
// Mapbox token is set globally by src/initMapbox (already in the bundle), so no
// per-root token wiring is needed.
//
// Styling stays in LOCKSTEP with the phone map: the car/route style constants and
// the polyline decoder are IMPORTED from ConvoyMapbox (named exports), never
// copied — so a tweak to the phone's route color or car scale updates both.
//
// GL safety: onDidFailLoadingMap -> onGLError(), which the CarPlay surface uses
// to drop back to the static-image fallback (ConvoyCarPlay's showLive/glFailed).

import React from 'react';
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
  ROUTE_GREEN_CORE,
  ROUTE_GREEN_GLOW,
  decodePolyline,
} from '../ConvoyMapbox';

// The car map is always the Standard "day" preset — bright + legible on a head
// unit. Emissive matches the phone's day value so the tinted paint shades the same.
const CAR_STYLE_URL = 'mapbox://styles/mapbox/standard';
const DAY_EMISSIVE = CAR_EMISSIVE_BY_MODE.day ?? 0;
// Single active route only → it lives at index 0; the alts layer filters it out
// (index != 0) and the casing/core draw it (index == 0), exactly like the phone.
const SELECTED_INDEX = 0;

type Props = {
  // Called when the GL map fails to load on the CarPlay window, so the surface
  // can fall back to the static <Image>. Wired to MapView.onDidFailLoadingMap.
  onGLError?: () => void;
};

export default function CarMapView({ onGLError }: Props) {
  const s = useCarStore();
  const hasFix = typeof s.selfLat === 'number' && typeof s.selfLng === 'number';
  const lat = s.selfLat ?? 0;
  const lng = s.selfLng ?? 0;
  const hdg = s.heading ?? 0;

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
      styleURL={CAR_STYLE_URL}
      projection="mercator"
      scaleBarEnabled={false}
      compassEnabled={false}
      rotateEnabled={false}
      pitchEnabled={false}
      logoEnabled={false}
      attributionEnabled={false}
      onDidFailLoadingMap={() => onGLError?.()}
    >
      {/* Standard "day" basemap (3D buildings on). `config` is cast to any to pass
          the boolean show3dObjects to native — same value the phone map sends (it
          types through its props index signature). */}
      <Mapbox.StyleImport id="basemap" existing config={{ lightPreset: 'day', show3dObjects: true } as any} />

      {/* Feed the carStore position into Mapbox's native location source so the
          follow camera tracks it on the CarPlay window — the car scene has no
          device GPS of its own. Mirrors the phone's SelfCarModel provider. */}
      <CustomLocationProvider coordinate={[lng, lat]} heading={hdg} />

      {/* Always-follow, heading-up (course), FIXED zoom. No gesture handlers. */}
      <Camera
        followUserLocation={hasFix}
        followUserMode={UserTrackingMode.FollowWithCourse}
        followZoomLevel={FOLLOW_ZOOM}
        defaultSettings={hasFix ? { centerCoordinate: [lng, lat], zoomLevel: FOLLOW_ZOOM } : undefined}
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
              modelEmissiveStrength: DAY_EMISSIVE,
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
