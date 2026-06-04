// ConvoyMap.tsx — NATIVE map (iOS/Android) built on react-native-maps.
//
// WHY react-native-maps (not the Google Navigation SDK):
//   The Navigation SDK requires a config plugin, native TOS acceptance, and a
//   Google-authorized "Navigation SDK" product on the API key — none of which
//   were provisioned, so <NavigationView> rendered blank (the map "never
//   worked" on device). react-native-maps renders the standard Google base map
//   using the `googleMapsApiKey` already set in app.json, with no special
//   authorization. All the premium feel (satellite imagery, custom car
//   markers, chase-cam, route polylines) lives here and is engine-agnostic.
//
// This file mirrors the behavior of ConvoyMap.web.tsx (vis.gl) so web + native
// look and behave the same. The web file is unchanged.

import React, { forwardRef, useEffect, useRef, useState } from "react";
import { View, Image, StyleSheet, Platform } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { getVehiclePngOrDefault } from "./vehicleAssets";

export interface Peer {
  user_id: string;
  handle?: string;
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  carType?: string;
  carBody?: string;
  carColor?: string;
  activeColor?: string;
  topSpeed?: number;
  online_at?: string;
  onRoute?: React.Dispatch<any>;
}

export interface Hazard {
  id: string;
  kind: string;
  lat: number;
  lng: number;
  subtype?: string;
  confirms?: number;
  disputes?: number;
  reporter_handle?: string;
  reportedAt?: string;
}

export interface UserLocation {
  heading?: number;
  carBody?: string;
  carColor?: string;
  lat?: number;
  lng?: number;
  speed?: number;
}

type LatLng = { lat: number; lng: number };

interface ConvoyMapProps {
  center?: { lat: number; lng: number; heading?: number } | null;
  user?: UserLocation | null;
  hideSelfMarker?: boolean;
  mapView?: "heading_up" | "north_up";
  mapType?: "hybrid" | "roadmap";
  peers?: Record<string, Peer> | Peer[] | null;
  leaderUserId?: string | null;
  hazards?: Hazard[] | null;
  externalAlerts?: any[];
  highlightConvoy?: boolean;
  destination?: LatLng | null;
  encodedPolyline?: string | null;
  routes?: { polyline: string; color?: string }[];
  selectedRouteIndex?: number;
  onSelectRoute?: (index: number) => void;
  followUser?: boolean;
  onUserPan?: () => void;
  navigationActive?: boolean;
  userSpeedMs?: number;
  showTraffic?: boolean;
  onMapPress?: () => void;
  onHazardPress?: (h: Hazard) => void;
  onHazardLongPress?: (h: Hazard) => void;
  onPeerPress?: (p: Peer) => void;
  onExternalAlertPress?: (a: any) => void;
  onRoute?: (info: any) => void;
  onMapReady?: () => void;
  [key: string]: any;
}

const SELF_ID = "self";

// ===== Chase-cam tuning — mirrors ConvoyMap.web.tsx =====
const CHASE_PITCH_DEG = 45;
const CHASE_ZOOM_CITY = 18;
const CHASE_ZOOM_HIGHWAY = 16;
const CHASE_KMH_CITY = 30;
const CHASE_KMH_HIGHWAY = 100;
const FREE_ZOOM = 15;
const FOLLOW_ZOOM = 17;

function lerp(a: number, b: number, t: number) { const k = Math.max(0, Math.min(1, t)); return a + (b - a) * k; }
function kmhFromMs(s: number | undefined | null) { return typeof s === "number" && Number.isFinite(s) && s >= 0 ? s * 3.6 : 0; }
function chaseZoomForSpeed(kmh: number) {
  if (kmh <= CHASE_KMH_CITY) return CHASE_ZOOM_CITY;
  if (kmh >= CHASE_KMH_HIGHWAY) return CHASE_ZOOM_HIGHWAY;
  return lerp(CHASE_ZOOM_CITY, CHASE_ZOOM_HIGHWAY, (kmh - CHASE_KMH_CITY) / (CHASE_KMH_HIGHWAY - CHASE_KMH_CITY));
}

// Decode a Google encoded polyline into [{latitude, longitude}]. react-native-maps
// has no built-in decoder (unlike vis.gl's geometry lib on web), so we inline the
// standard algorithm. Returns [] on bad input so a malformed polyline never crashes.
function decodePolyline(encoded?: string | null): { latitude: number; longitude: number }[] {
  if (!encoded) return [];
  const points: { latitude: number; longitude: number }[] = [];
  let index = 0, lat = 0, lng = 0;
  try {
    while (index < encoded.length) {
      let b: number, shift = 0, result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
      lat += dlat;
      shift = 0; result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
      lng += dlng;
      points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
    }
  } catch { return points; }
  return points;
}

const HAZARD_COLOR: Record<string, string> = {
  police: "#3478F6", accident: "#FF453A", road: "#FF9F0A", traffic: "#FF9F0A",
};

// Always hide Google's transit overlay (SkyTrain / bus / subway lines + station
// icons). Convoy is a driving app, so transit lines are clutter. customMapStyle
// only affects the "standard" (roadmap) base map; satellite/hybrid never draws
// these overlays anyway, so applying this unconditionally is safe.
const HIDE_TRANSIT_STYLE: any[] = [
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];

type CarPoint = { id: string; lat: number; lng: number; color?: string; heading?: number; leader?: boolean; peer?: Peer };

// ===== CarMarker =====
// A single car marker (self or peer). The custom <Image> child of a
// react-native-maps <Marker> must be captured into a native snapshot AFTER the
// PNG has loaded, or iOS renders a default blue placeholder dot instead of the
// car. We start with tracksViewChanges=true so the loaded image is captured,
// then flip it false (battery saver) once the image's onLoad fires + a frame.
// Re-enables tracking whenever the color or heading changes so the snapshot
// refreshes (e.g. user changes paint in the Garage, or the car turns).
function CarMarker({ car, onPress }: { car: CarPoint; onPress?: () => void }) {
  const [track, setTrack] = useState(true);
  const size = car.leader ? 52 : 44;
  // The marker is captured into a native bitmap sized to this view's bounds.
  // A rotated square of side `size` needs up to size*√2 (≈1.41×) to avoid
  // clipping its corners, so the OUTER box is 1.5× and centers the rotated car
  // inside it. The transparent margin is invisible but stops the top/bottom/
  // corner clipping seen on denser screens (1080/1440).
  const box = Math.ceil(size * 1.5);
  const src = getVehiclePngOrDefault(car.color);

  // Whenever the visual inputs change, re-enable tracking so the marker
  // re-snapshots with the new paint / rotation, then settle it off again.
  // The settle is generous (1200ms) so high-density devices finish decoding
  // the PNG before we freeze the snapshot — a short timer froze a half-painted
  // (clipped) car on 1080/1440 screens while 720 finished in time.
  useEffect(() => {
    setTrack(true);
    const t = setTimeout(() => setTrack(false), 1200);
    return () => clearTimeout(t);
  }, [src, car.color, car.heading]);

  return (
    <Marker
      identifier={car.id}
      coordinate={{ latitude: car.lat, longitude: car.lng }}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      tracksViewChanges={track}
      zIndex={car.id === SELF_ID || car.leader ? 1000 : 1}
      onPress={() => { if (car.peer) onPress?.(); }}
    >
      {/* Oversized transparent box so the rotated car never clips at its bounds. */}
      <View style={{ width: box, height: box, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: size, height: size, transform: [{ rotate: `${car.heading || 0}deg` }] }}>
          <Image
            source={src as any}
            style={{ width: size, height: size, resizeMode: "contain" }}
            fadeDuration={0}
            // The instant the PNG paints, force one more snapshot so the car
            // (not a blue placeholder or half-rendered frame) is captured.
            onLoad={() => { setTrack(true); setTimeout(() => setTrack(false), 400); }}
          />
        </View>
      </View>
    </Marker>
  );
}

const ConvoyMap = forwardRef<any, ConvoyMapProps>((props, ref) => {
  const {
    center, user, peers, hideSelfMarker, mapView = "heading_up",
    mapType = "hybrid", leaderUserId, hazards, highlightConvoy,
    destination, routes = [], selectedRouteIndex = 0, onSelectRoute,
    followUser = false, onUserPan, navigationActive = false, userSpeedMs,
    showTraffic = true, onMapPress, onHazardPress, onHazardLongPress,
    onPeerPress, onMapReady,
  } = props;

  const mapRef = useRef<MapView | null>(null);
  const readyRef = useRef(false);
  // Throttle camera commits: skip ticks where the user barely moved.
  const lastCamRef = useRef<{ lat: number; lng: number; heading: number } | null>(null);
  // Suppress the onUserPan callback while WE are the ones moving the camera
  // (programmatic animateCamera fires onPanDrag-adjacent region changes).
  const selfMovingRef = useRef(false);
  // Tracks which destination we've already framed (zoom-to-fit) so we don't
  // re-fit on every route recompute / GPS tick.
  const fittedDestRef = useRef<string | null>(null);

  // ----- Base-map type: "roadmap" -> standard, otherwise satellite/hybrid. -----
  const resolvedMapType: "standard" | "hybrid" = mapType === "roadmap" ? "standard" : "hybrid";

  // ----- Initial region (only used for uncontrolled first paint) -----
  const initialRegion =
    center && typeof center.lat === "number"
      ? { latitude: center.lat, longitude: center.lng, latitudeDelta: 0.02, longitudeDelta: 0.02 }
      : user && typeof user.lat === "number"
      ? { latitude: user.lat as number, longitude: user.lng as number, latitudeDelta: 0.02, longitudeDelta: 0.02 }
      : undefined;

  // ===== Camera control =====
  // followUser (free-roam) → follow position at a fixed zoom, north-up, flat.
  // navigationActive (chase cam) → speed-zoom, heading-up (unless north_up), 45° pitch.
  const commitCamera = (force = false) => {
    const m = mapRef.current;
    if (!m || !readyRef.current) return;
    const lat = user?.lat ?? center?.lat;
    const lng = user?.lng ?? center?.lng;
    if (typeof lat !== "number" || typeof lng !== "number") return;

    const heading = (typeof user?.heading === "number" && Number.isFinite(user.heading)) ? user.heading : 0;
    const isHeadingUp = mapView === "heading_up";

    let zoom = FREE_ZOOM;
    let pitch = 0;
    let camHeading = 0;

    if (navigationActive) {
      zoom = chaseZoomForSpeed(kmhFromMs(userSpeedMs));
      pitch = isHeadingUp ? CHASE_PITCH_DEG : 0;
      camHeading = isHeadingUp ? heading : 0;
    } else if (followUser) {
      zoom = FOLLOW_ZOOM;
    } else if (!force) {
      // Not following and not navigating — let the user roam freely.
      return;
    }

    // Throttle: skip < 3m + < 3° heading change (unless forced).
    if (!force) {
      const last = lastCamRef.current;
      if (last) {
        const R = 6371000;
        const dLat = ((lat - last.lat) * Math.PI) / 180;
        const dLng = ((lng - last.lng) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos((last.lat * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        const distM = 2 * R * Math.asin(Math.sqrt(a));
        if (distM < 3 && Math.abs(camHeading - last.heading) < 3) return;
      }
    }
    lastCamRef.current = { lat, lng, heading: camHeading };

    selfMovingRef.current = true;
    try {
      m.animateCamera(
        { center: { latitude: lat, longitude: lng }, heading: camHeading, pitch, zoom },
        { duration: force ? 350 : 700 }
      );
    } catch {}
    // Release the self-moving guard after the animation window.
    setTimeout(() => { selfMovingRef.current = false; }, (force ? 350 : 700) + 120);
  };

  // Drive the camera on every relevant change.
  useEffect(() => {
    commitCamera(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.lat, user?.lng, user?.heading, userSpeedMs, followUser, navigationActive, mapView]);

  // When nav ends, flatten the camera back to north-up free-roam.
  useEffect(() => {
    if (navigationActive) return;
    const m = mapRef.current;
    if (!m || !readyRef.current) return;
    if (followUser) return; // commitCamera handles the follow case
    selfMovingRef.current = true;
    try { m.animateCamera({ pitch: 0, heading: 0, zoom: FREE_ZOOM }, { duration: 350 }); } catch {}
    setTimeout(() => { selfMovingRef.current = false; }, 480);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationActive]);

  // ===== Preview: fit the camera to ALL alternative routes =====
  // When routes are computed and we're NOT navigating, zoom out to frame the
  // whole set of options end-to-end (Google's route-overview behavior). Guarded
  // by fittedDestRef so it fires ONCE per destination, not on every recompute.
  useEffect(() => {
    const m = mapRef.current;
    if (!destination) { fittedDestRef.current = null; return; }
    if (!m || !readyRef.current || navigationActive || routes.length === 0) return;
    const key = `${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}`;
    if (fittedDestRef.current === key) return;
    const pts: { latitude: number; longitude: number }[] = [];
    routes.forEach((r: { polyline: string }) => decodePolyline(r.polyline).forEach((c) => pts.push(c)));
    if (user && typeof user.lat === "number" && typeof user.lng === "number") {
      pts.push({ latitude: user.lat, longitude: user.lng });
    }
    pts.push({ latitude: destination.lat, longitude: destination.lng });
    if (pts.length < 2) return;
    fittedDestRef.current = key;
    selfMovingRef.current = true;
    try {
      m.fitToCoordinates(pts, {
        edgePadding: { top: 140, right: 60, bottom: 340, left: 60 },
        animated: true,
      });
    } catch {}
    setTimeout(() => { selfMovingRef.current = false; }, 900);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, destination, navigationActive]);

  // ===== Build the car-marker list (self + peers) =====
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

  const visibleHazards = (hazards || []).filter((h: Hazard) => h && typeof h.lat === "number" && typeof h.lng === "number");

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={initialRegion}
        mapType={resolvedMapType}
        customMapStyle={HIDE_TRANSIT_STYLE}
        showsTraffic={!!showTraffic}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        rotateEnabled
        pitchEnabled
        toolbarEnabled={false}
        onMapReady={() => { readyRef.current = true; commitCamera(true); onMapReady?.(); }}
        onPress={() => onMapPress?.()}
        onPanDrag={() => { if (!selfMovingRef.current) onUserPan?.(); }}
      >
        {/* Car markers — self + every peer. Each is a rotated top-down PNG of
            the GR Corolla in the driver's paint (default Heavy Metal).
            Rendered via CarMarker so the PNG is snapshot-captured AFTER load
            (avoids the iOS blue-placeholder-dot bug). */}
        {cars.map((c) => (
          <CarMarker key={c.id} car={c} onPress={() => { if (c.peer) onPeerPress?.(c.peer); }} />
        ))}

        {/* Community hazard pins. Gold ring when Highlight Convoy is on. */}
        {visibleHazards.map((h: Hazard) => (
          <Marker
            key={`hz_${h.id}`}
            coordinate={{ latitude: h.lat, longitude: h.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            zIndex={5}
            onPress={() => onHazardPress?.(h)}
          >
            <View style={[
              styles.hazardPin,
              { backgroundColor: HAZARD_COLOR[h.kind] || "#FF9F0A" },
              highlightConvoy && styles.hazardPinConvoy,
            ]} />
          </Marker>
        ))}

        {/* Destination pin. */}
        {destination && (
          <Marker coordinate={{ latitude: destination.lat, longitude: destination.lng }} anchor={{ x: 0.5, y: 0.5 }} zIndex={6}>
            <View style={styles.destPin} />
          </Marker>
        )}

        {/* Route polylines — Google style: gray alternates first, then the
            SELECTED route drawn LAST (on top) in bright app-yellow. Each line is
            keyed by the current selection so react-native-maps fully REMOUNTS it
            when selection changes — without that, iOS keeps the old stroke color
            and the selected line renders with a stale/default (blue) stroke. */}
        {destination && routes.map((r: { polyline: string }, i: number) => {
          if (i === selectedRouteIndex) return null; // selected drawn on top below
          const coords = decodePolyline(r.polyline);
          if (coords.length === 0) return null;
          return (
            <Polyline
              key={`alt_${i}_${selectedRouteIndex}`}
              coordinates={coords}
              strokeColor="#9AA0A6"
              strokeWidth={4}
              zIndex={1}
              tappable
              onPress={() => onSelectRoute?.(i)}
              lineCap="round"
              lineJoin="round"
            />
          );
        })}
        {destination && routes[selectedRouteIndex] && (() => {
          const coords = decodePolyline(routes[selectedRouteIndex].polyline);
          if (coords.length === 0) return null;
          return (
            <Polyline
              key={`sel_${selectedRouteIndex}`}
              coordinates={coords}
              strokeColor="#FFD60A"
              strokeWidth={7}
              zIndex={3}
              lineCap="round"
              lineJoin="round"
            />
          );
        })()}
      </MapView>
    </View>
  );
});

ConvoyMap.displayName = "ConvoyMap";
export default ConvoyMap;

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  // Round hazard dot with a white ring; gold ring overrides white for Convoy reports.
  hazardPin: {
    width: 26, height: 26, borderRadius: 13,
    borderWidth: 3, borderColor: "#FFFFFF",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 3, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 4 },
    }),
  },
  hazardPinConvoy: { borderColor: "#FFD60A" },
  destPin: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: "#FF453A", borderWidth: 3, borderColor: "#FFFFFF",
  },
});
