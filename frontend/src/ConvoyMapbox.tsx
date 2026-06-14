// ConvoyMapbox.tsx — NATIVE map (iOS/Android) built on @rnmapbox/maps (Mapbox).
//
// PARALLEL to ConvoyMap.tsx (react-native-maps / Google). This is the Mapbox
// re-implementation, built up incrementally behind a settings toggle so the
// proven Google map keeps working untouched while we port it feature-by-feature.
// map.tsx spreads the SAME props into whichever engine the toggle selects, so
// this is a literal drop-in for ConvoyMap.
//
// INCREMENT 1 (this version) renders:
//   • the base Mapbox map (dark vector style, or satellite for "hybrid")
//   • the follow / chase camera (free-roam follow + turn-by-turn zoom & 45° tilt)
//   • the self car puck + every peer car (rotated GR Corolla PNGs)
//
// NOT YET PORTED (each ships later as a FREE OTA increment; the props are still
// accepted and simply ignored for now): routes / polylines, hazards, speed
// cameras, place pins, destination + arrival-weather chip, the maneuver turn-
// arrow, avatar route-snapping, live traffic, and route-preview fit-to-bounds.
//
// COORDINATE ORDER: Mapbox uses [longitude, latitude] arrays (GeoJSON order) —
// the OPPOSITE of react-native-maps' { latitude, longitude }. Every coordinate
// handed to Mapbox below is [lng, lat].

import React, { useEffect, useRef } from "react";
import { View, Image, StyleSheet, Pressable } from "react-native";
import Mapbox, { MapView, Camera, MarkerView } from "@rnmapbox/maps";
import { getVehiclePngOrDefault } from "./vehicleAssets";
import type { Peer, Hazard, UserLocation } from "./ConvoyMap";
import type { WeatherKind } from "./weatherLayer";

type LatLng = { lat: number; lng: number };

// Mirrors ConvoyMapProps from ConvoyMap.tsx so the two engines are swappable.
// Kept as a separate copy during the migration; once Mapbox is the only engine,
// ConvoyMap.tsx is deleted and this becomes the single source of truth.
interface ConvoyMapboxProps {
  center?: { lat: number; lng: number; heading?: number } | null;
  user?: UserLocation | null;
  hideSelfMarker?: boolean;
  mapView?: "heading_up" | "north_up";
  mapType?: "hybrid" | "roadmap";
  mapDark?: boolean;
  peers?: Record<string, Peer> | Peer[] | null;
  leaderUserId?: string | null;
  hazards?: Hazard[] | null;
  speedCameras?: { id: string; lat: number; lng: number }[];
  places?: { id: string; lat: number; lng: number; label: string; price?: string; isGas?: boolean; cheapest?: boolean }[];
  showPlacePins?: boolean;
  externalAlerts?: any[];
  highlightConvoy?: boolean;
  destination?: LatLng | null;
  destWeather?: { kind: WeatherKind; temp: string } | null;
  encodedPolyline?: string | null;
  routes?: { polyline: string; color?: string }[];
  selectedRouteIndex?: number;
  onSelectRoute?: (index: number) => void;
  followUser?: boolean;
  onUserPan?: () => void;
  navigationActive?: boolean;
  userSpeedMs?: number;
  distanceToManeuverM?: number;
  maneuverCoord?: { lat: number; lng: number } | null;
  showTraffic?: boolean;
  onMapPress?: () => void;
  onMapLongPress?: (c: { lat: number; lng: number }) => void;
  onHazardPress?: (h: Hazard) => void;
  onHazardLongPress?: (h: Hazard) => void;
  onPeerPress?: (p: Peer) => void;
  onPlacePress?: (p: any) => void;
  onExternalAlertPress?: (a: any) => void;
  onRoute?: (info: any) => void;
  onMapReady?: () => void;
  [key: string]: any;
}

const SELF_ID = "self";

// ===== Chase-cam tuning — mirrors ConvoyMap.tsx =====
const CHASE_PITCH_DEG = 45;
const CHASE_ZOOM_CITY = 17;
const CHASE_ZOOM_HIGHWAY = 15;
const CHASE_KMH_CITY = 30;
const CHASE_KMH_HIGHWAY = 100;
const FREE_ZOOM = 15;
const FOLLOW_ZOOM = 17;
const CORNER_ZOOM = 18.5;
const CORNER_FAR_M = 280;
const CORNER_NEAR_M = 70;

function lerp(a: number, b: number, t: number) { const k = Math.max(0, Math.min(1, t)); return a + (b - a) * k; }
function kmhFromMs(s: number | undefined | null) { return typeof s === "number" && Number.isFinite(s) && s >= 0 ? s * 3.6 : 0; }
function chaseZoomForSpeed(kmh: number) {
  if (kmh <= CHASE_KMH_CITY) return CHASE_ZOOM_CITY;
  if (kmh >= CHASE_KMH_HIGHWAY) return CHASE_ZOOM_HIGHWAY;
  return lerp(CHASE_ZOOM_CITY, CHASE_ZOOM_HIGHWAY, (kmh - CHASE_KMH_CITY) / (CHASE_KMH_HIGHWAY - CHASE_KMH_CITY));
}
function chaseZoom(kmh: number, distToManeuverM?: number) {
  const base = chaseZoomForSpeed(kmh);
  if (typeof distToManeuverM !== "number" || !Number.isFinite(distToManeuverM) || distToManeuverM <= 0) return base;
  const t = (CORNER_FAR_M - distToManeuverM) / (CORNER_FAR_M - CORNER_NEAR_M);
  return Math.max(base, lerp(base, CORNER_ZOOM, t));
}

type CarPoint = { id: string; lat: number; lng: number; color?: string; heading?: number; leader?: boolean; peer?: Peer };

// ===== CarMarker =====
// One car (self or peer) as a Mapbox MarkerView — a real RN view pinned to a
// coordinate. MarkerView draws in SCREEN space (it does not rotate with the
// map), so to make the car point up the road in heading-up we rotate the PNG by
// (carHeading − mapHeading), exactly like ConvoyMap. One code path on both
// platforms (MarkerView is screen-space on each), which also sidesteps
// react-native-maps' Android bitmap-capture sliver bug entirely.
function CarMarker({ car, mapHeading = 0, onPress }: { car: CarPoint; mapHeading?: number; onPress?: () => void }) {
  const src = getVehiclePngOrDefault(car.color);
  const heading = typeof car.heading === "number" && Number.isFinite(car.heading) ? car.heading : 0;
  const rotation = (((heading - mapHeading) % 360) + 360) % 360;
  return (
    <MarkerView coordinate={[car.lng, car.lat]} anchor={{ x: 0.5, y: 0.5 }} allowOverlap allowOverlapWithPuck>
      <Pressable onPress={() => { if (car.peer) onPress?.(); }} hitSlop={8}>
        <Image
          source={src}
          style={[styles.car, { transform: [{ rotate: `${rotation}deg` }] }]}
          resizeMode="contain"
          fadeDuration={0}
        />
      </Pressable>
    </MarkerView>
  );
}

function ConvoyMapbox(props: ConvoyMapboxProps) {
  const {
    center, user, peers, hideSelfMarker, mapView = "heading_up",
    mapType = "hybrid", mapDark = false, leaderUserId,
    followUser = false, onUserPan, navigationActive = false, userSpeedMs,
    distanceToManeuverM, onMapPress, onMapLongPress, onPeerPress, onMapReady,
  } = props;

  const cameraRef = useRef<React.ElementRef<typeof Camera>>(null);
  const readyRef = useRef(false);
  const gesturingRef = useRef(false);

  // ----- Base-map style -----
  // "hybrid"  → satellite-with-streets imagery (matches Google satellite/hybrid)
  // "roadmap" → dark vector when Dark is on, else the standard street style
  const styleURL =
    mapType === "hybrid"
      ? Mapbox.StyleURL.SatelliteStreet
      : mapDark
      ? Mapbox.StyleURL.Dark
      : Mapbox.StyleURL.Street;

  // Map bearing the camera is using right now (heading-up while following /
  // navigating, else north). CarMarker subtracts this so every car rides
  // nose-forward up the rotated road.
  const selfHeadingDeg = typeof user?.heading === "number" && Number.isFinite(user.heading) ? user.heading : 0;
  const mapHeadingDeg = mapView === "heading_up" && (navigationActive || followUser) ? selfHeadingDeg : 0;

  // Initial camera target for first paint (avoids a flash at null-island).
  const initLat = center?.lat ?? user?.lat;
  const initLng = center?.lng ?? user?.lng;

  // ===== Camera control (mirrors ConvoyMap.commitCamera) =====
  const commitCamera = (force = false) => {
    const cam = cameraRef.current;
    if (!cam || !readyRef.current) return;
    if (!followUser && !force) return; // honor a manual pan-away
    const lat = user?.lat ?? center?.lat;
    const lng = user?.lng ?? center?.lng;
    if (typeof lat !== "number" || typeof lng !== "number") return;

    const heading = typeof user?.heading === "number" && Number.isFinite(user.heading) ? user.heading : 0;
    const isHeadingUp = mapView === "heading_up";
    let zoomLevel = FREE_ZOOM;
    let pitch = 0;
    let camHeading = 0;

    if (navigationActive) {
      zoomLevel = chaseZoom(kmhFromMs(userSpeedMs), distanceToManeuverM);
      pitch = isHeadingUp ? CHASE_PITCH_DEG : 0;
      camHeading = isHeadingUp ? heading : 0;
    } else if (followUser) {
      zoomLevel = FOLLOW_ZOOM;
      camHeading = isHeadingUp ? heading : 0;
    } else if (!force) {
      return;
    }

    try {
      cam.setCamera({
        centerCoordinate: [lng, lat],
        heading: camHeading,
        pitch,
        zoomLevel,
        animationDuration: force ? 350 : 700,
        animationMode: "easeTo",
      });
    } catch {}
  };

  // Drive the camera on every relevant change.
  useEffect(() => {
    commitCamera(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.lat, user?.lng, user?.heading, userSpeedMs, distanceToManeuverM, followUser, navigationActive, mapView]);

  // When nav ends, flatten back to north-up free-roam (unless still following,
  // which commitCamera already handles).
  useEffect(() => {
    if (navigationActive) return;
    const cam = cameraRef.current;
    if (!cam || !readyRef.current || followUser) return;
    try { cam.setCamera({ pitch: 0, heading: 0, zoomLevel: FREE_ZOOM, animationDuration: 350, animationMode: "easeTo" }); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationActive]);

  // ===== Build the car list (self + peers) =====
  const cars: CarPoint[] = [];
  if (!hideSelfMarker && user && typeof user.lat === "number" && typeof user.lng === "number") {
    cars.push({ id: SELF_ID, lat: user.lat, lng: user.lng, color: user.carColor, heading: user.heading });
  }
  const peerList: Peer[] = Array.isArray(peers) ? peers : peers ? Object.values(peers) : [];
  peerList.forEach((p) => {
    if (p && typeof p.lat === "number" && typeof p.lng === "number") {
      cars.push({
        id: "peer_" + p.user_id, lat: p.lat, lng: p.lng,
        color: p.activeColor || p.carColor, heading: p.heading,
        leader: !!leaderUserId && p.user_id === leaderUserId, peer: p,
      });
    }
  });

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        styleURL={styleURL}
        projection="mercator"
        scaleBarEnabled={false}
        compassEnabled={false}
        logoEnabled
        attributionEnabled
        logoPosition={{ bottom: 8, left: 8 }}
        attributionPosition={{ bottom: 8, right: 8 }}
        pitchEnabled
        rotateEnabled
        onDidFinishLoadingMap={() => { readyRef.current = true; commitCamera(true); onMapReady?.(); }}
        onPress={() => onMapPress?.()}
        onLongPress={(f: any) => {
          const c = f?.geometry?.coordinates;
          if (Array.isArray(c) && typeof c[0] === "number") onMapLongPress?.({ lat: c[1], lng: c[0] });
        }}
        onCameraChanged={(state: any) => {
          // gestures.isGestureActive cleanly separates a real finger-pan from our
          // own setCamera moves — no self-moving guard flag needed (unlike the
          // Google engine). Fire onUserPan once per gesture so follow drops and
          // the camera stops chasing until Recenter / auto-recenter.
          const active = !!state?.gestures?.isGestureActive;
          if (active && !gesturingRef.current) { gesturingRef.current = true; onUserPan?.(); }
          else if (!active && gesturingRef.current) { gesturingRef.current = false; }
        }}
      >
        <Camera
          ref={cameraRef}
          defaultSettings={
            typeof initLat === "number" && typeof initLng === "number"
              ? { centerCoordinate: [initLng, initLat], zoomLevel: FOLLOW_ZOOM }
              : undefined
          }
        />

        {cars.map((c) => (
          <CarMarker key={c.id} car={c} mapHeading={mapHeadingDeg} onPress={() => { if (c.peer) onPeerPress?.(c.peer); }} />
        ))}
      </MapView>
    </View>
  );
}

export default ConvoyMapbox;

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  car: { width: 46, height: 46 },
});
