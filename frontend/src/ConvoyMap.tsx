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

import React, { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Image, StyleSheet, Platform, Easing } from "react-native";
import MapView, { Marker, MarkerAnimated, AnimatedRegion, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { getVehiclePngOrDefault } from "./vehicleAssets";
import type { WeatherKind } from "./weatherLayer";

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
  // Live distance (m) to the next maneuver, from the turn-by-turn engine. Drives
  // the dynamic "ease wider, tighten into the corner" chase zoom.
  distanceToManeuverM?: number;
  showTraffic?: boolean;
  onMapPress?: () => void;
  onHazardPress?: (h: Hazard) => void;
  onHazardLongPress?: (h: Hazard) => void;
  onPeerPress?: (p: Peer) => void;
  onPlacePress?: (p: { id: string; lat: number; lng: number; label: string; price?: string; isGas?: boolean; cheapest?: boolean }) => void;
  onExternalAlertPress?: (a: any) => void;
  onRoute?: (info: any) => void;
  onMapReady?: () => void;
  [key: string]: any;
}

const SELF_ID = "self";

// Destination arrival-weather chip icon: map a WeatherKind to an icon + tint.
// `mci` selects MaterialCommunityIcons (fog) vs Ionicons (everything else).
function destWxIcon(kind: WeatherKind): { name: string; color: string; mci: boolean } {
  switch (kind) {
    case "clear-day": return { name: "sunny", color: "#FFD60A", mci: false };
    case "clear-night": return { name: "moon", color: "#DCE3F0", mci: false };
    case "partly-day": return { name: "partly-sunny", color: "#FFD60A", mci: false };
    case "partly-night": return { name: "cloudy-night", color: "#DCE3F0", mci: false };
    case "cloudy": return { name: "cloud", color: "#AEB4BD", mci: false };
    case "fog": return { name: "weather-fog", color: "#AEB4BD", mci: true };
    case "rain": return { name: "rainy", color: "#5AC8FA", mci: false };
    case "snow": return { name: "snow", color: "#EAF6FF", mci: false };
    case "thunder": return { name: "thunderstorm", color: "#FFD60A", mci: false };
    default: return { name: "partly-sunny", color: "#FFD60A", mci: false };
  }
}

// ===== Chase-cam tuning — mirrors ConvoyMap.web.tsx =====
const CHASE_PITCH_DEG = 45;
// Baseline chase zoom is deliberately a notch WIDER than before (was 18/16) so
// in portrait you see more of the road ahead. We tighten back in near corners
// (see cornerZoom below), so this trades default closeness for situational
// awareness without losing detail at the turn.
const CHASE_ZOOM_CITY = 17;
const CHASE_ZOOM_HIGHWAY = 15;
const CHASE_KMH_CITY = 30;
const CHASE_KMH_HIGHWAY = 100;
const FREE_ZOOM = 15;
const FOLLOW_ZOOM = 17;
// Dynamic corner zoom: as the next maneuver approaches, ease the camera in to
// this tighter level so the turn is easy to read in portrait. Beyond FAR we sit
// at the (wider) speed baseline; within NEAR we're fully zoomed to CORNER.
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
// Blend the speed baseline with a corner zoom-in. `t` goes 0 (>= FAR from the
// turn) → 1 (<= NEAR). We never zoom out below the speed baseline, only tighten
// in toward CORNER_ZOOM as the maneuver nears, and the 700ms animateCamera makes
// it read as a smooth ease rather than a snap.
function chaseZoom(kmh: number, distToManeuverM?: number) {
  const base = chaseZoomForSpeed(kmh);
  if (typeof distToManeuverM !== "number" || !Number.isFinite(distToManeuverM) || distToManeuverM <= 0) return base;
  const t = (CORNER_FAR_M - distToManeuverM) / (CORNER_FAR_M - CORNER_NEAR_M);
  return Math.max(base, lerp(base, CORNER_ZOOM, t));
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

// Round only the GENTLE bends of a route line so it reads as smooth curves,
// while leaving SHARP turns (e.g. 90-degree intersection turns) as EXACT
// vertices so they stay crisp and on the road. This is *selective* Chaikin
// corner-cutting: at each interior vertex we measure the turn deviation and only
// round it when it's below `maxRoundDeg`. The previous version cut every corner
// unconditionally, which pulled sharp turns off the road and across buildings
// (and away from the route-snapped car). Endpoints are always kept exact.
function turnDeviationDeg(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
  c: { latitude: number; longitude: number }
): number {
  const kx = Math.cos((b.latitude * Math.PI) / 180); // shrink longitude at this latitude
  const v1x = (b.longitude - a.longitude) * kx, v1y = b.latitude - a.latitude;
  const v2x = (c.longitude - b.longitude) * kx, v2y = c.latitude - b.latitude;
  const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
  if (m1 === 0 || m2 === 0) return 0;
  let cos = (v1x * v2x + v1y * v2y) / (m1 * m2);
  cos = cos < -1 ? -1 : cos > 1 ? 1 : cos;
  return (Math.acos(cos) * 180) / Math.PI; // 0 = dead straight, 90 = right-angle turn
}

function smoothPath(
  pts: { latitude: number; longitude: number }[],
  iterations = 2,
  maxRoundDeg = 35
): { latitude: number; longitude: number }[] {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    if (p.length < 3) return p;
    const out: { latitude: number; longitude: number }[] = [p[0]];
    for (let i = 1; i < p.length - 1; i++) {
      const a = p[i - 1], b = p[i], c = p[i + 1];
      if (turnDeviationDeg(a, b, c) >= maxRoundDeg) {
        // Sharp turn (intersection) — keep the corner exact so it stays a real
        // 90-degree corner sitting on the road.
        out.push(b);
      } else {
        // Gentle bend — cut the corner lightly toward each neighbour so it
        // rounds. Only a 25% pull, and only on shallow angles, so the line
        // never visibly leaves the road.
        out.push({
          latitude: b.latitude * 0.75 + a.latitude * 0.25,
          longitude: b.longitude * 0.75 + a.longitude * 0.25,
        });
        out.push({
          latitude: b.latitude * 0.75 + c.latitude * 0.25,
          longitude: b.longitude * 0.75 + c.longitude * 0.25,
        });
      }
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
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

// Dark "night" styling for the STANDARD (roadmap) base map. customMapStyle only
// affects the standard map — satellite/hybrid ignore it — so this visibly takes
// effect only when Satellite is OFF. Transit is hidden here too so the dark map
// matches the light map's clutter level. (Standard Google night-mode palette.)
const DARK_MAP_STYLE: any[] = [
  { elementType: "geometry", stylers: [{ color: "#1d2c4d" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8ec3b9" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1a3646" }] },
  { featureType: "administrative.country", elementType: "geometry.stroke", stylers: [{ color: "#4b6878" }] },
  { featureType: "administrative.land_parcel", elementType: "labels.text.fill", stylers: [{ color: "#64779e" }] },
  { featureType: "administrative.province", elementType: "geometry.stroke", stylers: [{ color: "#4b6878" }] },
  // Building FILL is set explicitly (not just the stroke below). Android's Google
  // Maps SDK fills man_made geometry with its own default — the navy "building
  // blocks" look we want — while iOS leaves it nearly transparent (flat, washed
  // out). Pinning the fill makes iOS render buildings like Android instead of
  // each SDK falling back to a different default. Tune this hex if the blocks
  // read too light/dark on a real device.
  { featureType: "landscape.man_made", elementType: "geometry.fill", stylers: [{ color: "#2a3f6a" }] },
  { featureType: "landscape.man_made", elementType: "geometry.stroke", stylers: [{ color: "#334e87" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#023e58" }] },
  { featureType: "poi", elementType: "geometry", stylers: [{ color: "#283d6a" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#6f9ba5" }] },
  { featureType: "poi", elementType: "labels.text.stroke", stylers: [{ color: "#1d2c4d" }] },
  { featureType: "poi.park", elementType: "geometry.fill", stylers: [{ color: "#023e58" }] },
  { featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#3C7680" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#304a7d" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#98a5be" }] },
  { featureType: "road", elementType: "labels.text.stroke", stylers: [{ color: "#1d2c4d" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#2c6675" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#255763" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#b0d5ce" }] },
  { featureType: "road.highway", elementType: "labels.text.stroke", stylers: [{ color: "#023e58" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0e1626" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#4e6d70" }] },
];

type CarPoint = { id: string; lat: number; lng: number; color?: string; heading?: number; speedMs?: number; leader?: boolean; peer?: Peer };

// Snapshot settle windows for CarMarker. react-native-maps captures the marker's
// child view into a native bitmap; on Android that capture can come back
// blank/partial at high pixel density (1080p/1440p) if frozen too early (the
// vanishing-avatar bug), so we give it a much longer window to settle before
// turning the snapshot OFF — so we're not re-capturing every frame (that
// continuous capture was the on-the-move stutter). iOS captures almost instantly.
const SNAPSHOT_SETTLE_MS = Platform.OS === "android" ? 3000 : 1200;
const SNAPSHOT_RELOAD_MS = Platform.OS === "android" ? 2000 : 400;

// ===== Avatar route-snapping helper =====
// Project a lat/lng onto the nearest point of a polyline (the route line) and
// report the perpendicular distance in metres. Equirectangular projection —
// plenty accurate for the short segments of a road geometry, and cheap enough
// to run on every GPS fix.
function nearestOnPolyline(
  lat: number,
  lng: number,
  pts: { latitude: number; longitude: number }[]
): { latitude: number; longitude: number; distM: number } | null {
  if (!pts || pts.length < 2) return null;
  const kx = Math.cos((lat * Math.PI) / 180); // longitude shrink at this latitude
  const px = lng * kx, py = lat;
  let bestLat = pts[0].latitude, bestLng = pts[0].longitude, bestD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].longitude * kx, ay = pts[i].latitude;
    const bx = pts[i + 1].longitude * kx, by = pts[i + 1].latitude;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx, cy = ay + t * dy;
    const ex = px - cx, ey = py - cy;
    const d = ex * ex + ey * ey;
    if (d < bestD) { bestD = d; bestLat = cy; bestLng = cx / kx; }
  }
  return { latitude: bestLat, longitude: bestLng, distM: Math.sqrt(bestD) * 111320 };
}

// ===== CarMarker =====
// A single car marker (self or peer), rendered via react-native-maps' NATIVE
// `image` prop — NOT a captured child <View>/<Image>. The view→bitmap capture
// path collapsed the tall, narrow car PNG into a full-height ~1px-wide sliver on
// Android under the New Architecture; resizeMode / resizeMethod / collapsable
// fixes couldn't beat it because they all still went through that capture. The
// native image prop draws the bundled PNG directly: no capture, no sliver, and
// it behaves identically on iOS. Marker size now comes from the asset itself
// (the 44 / @2x 88 / @3x 132 px set in assets/vehicles), it rotates to heading
// via the native `rotation` prop, and glides between fixes via an AnimatedRegion.
const CarMarker = React.memo(function CarMarker({ car, onPress }: { car: CarPoint; onPress?: () => void }) {
  const src = getVehiclePngOrDefault(car.color);

  // ===== Smooth gliding position =====
  // Snapping the marker to each raw GPS fix made the car "jump". Instead we keep
  // an AnimatedRegion and ease the coordinate toward each new fix over ~1s so the
  // car glides like native Google Maps. Persisted via ref across re-renders.
  const coord = useRef(
    new AnimatedRegion({ latitude: car.lat, longitude: car.lng, latitudeDelta: 0, longitudeDelta: 0 })
  ).current;
  useEffect(() => {
    const anim = coord.timing({
      latitude: car.lat,
      longitude: car.lng,
      latitudeDelta: 0,
      longitudeDelta: 0,
      // Linear easing = constant-velocity glide. The default ease-in-out made
      // the car accelerate mid-segment then decelerate at each fix (~1s), which
      // reads as a subtle pulse. Duration is a touch longer than the fix cadence
      // so a slightly-late fix interrupts an in-progress glide rather than
      // letting the car stop and restart (which would stutter).
      duration: 1100,
      easing: Easing.linear,
      useNativeDriver: false,
    } as any);
    anim.start();
    return () => { try { (anim as any).stop?.(); } catch {} };
  }, [car.lat, car.lng, coord]);

  // ===== Heading hold at low speed =====
  // GPS heading swings wildly near 0 speed, which spins the car in place at
  // stops/lights. Hold the last heading until we're actually moving (>~5km/h).
  const [displayHeading, setDisplayHeading] = useState(car.heading || 0);
  useEffect(() => {
    const moving = typeof car.speedMs === "number" ? car.speedMs >= 1.4 : true;
    if (moving && typeof car.heading === "number" && Number.isFinite(car.heading)) {
      setDisplayHeading(car.heading);
    }
  }, [car.heading, car.speedMs]);

  return (
    <MarkerAnimated
      identifier={car.id}
      coordinate={coord as any}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      rotation={displayHeading}
      image={src as any}
      tracksViewChanges={false}
      zIndex={car.id === SELF_ID || car.leader ? 1000 : 1}
      onPress={() => { if (car.peer) onPress?.(); }}
    />
  );
}, (prev, next) => {
  // Skip re-render unless THIS car's own data changed. Without this, every peer
  // marker re-rendered on every self GPS fix (the parent rebuilds the cars list
  // each tick) — a big chunk of the moving-stutter. The self marker still
  // updates because its own lat/lng/heading change each fix.
  const a = prev.car, b = next.car;
  return a.id === b.id && a.lat === b.lat && a.lng === b.lng
    && a.color === b.color && a.heading === b.heading
    && a.speedMs === b.speedMs && a.leader === b.leader;
});

// ===== RouteEtaMarker =====
// A small ETA pill (e.g. "32 min") pinned at the midpoint of a route polyline,
// like native Google Maps. Selected route → convoy-yellow; alternates → grey.
// Tapping it selects that route (same as tapping the line). Same snapshot dance
// as CarMarker: track on until the pill paints, then settle off for battery.
function RouteEtaMarker({ coordinate, label, selected, onPress }: {
  coordinate: { latitude: number; longitude: number };
  label: string; selected: boolean; onPress?: () => void;
}) {
  const [track, setTrack] = useState(true);
  useEffect(() => {
    setTrack(true);
    // Shared Android-aware settle window (3000ms Android / 1200 iOS). The old
    // hardcoded 800ms froze the bitmap before the ETA text reliably painted on
    // Android, so the pill could capture blank/clipped — same too-early-freeze
    // the camera/place markers hit. Re-armed on label/selection change.
    const t = setTimeout(() => setTrack(false), SNAPSHOT_SETTLE_MS);
    return () => clearTimeout(t);
  }, [label, selected]);
  return (
    <Marker
      coordinate={coordinate}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={track}
      zIndex={selected ? 4 : 2}
      onPress={onPress}
    >
      <View style={[styles.etaPill, selected ? styles.etaPillSel : styles.etaPillAlt]}>
        <Text style={[styles.etaPillText, selected ? styles.etaPillTextSel : styles.etaPillTextAlt]}>{label}</Text>
      </View>
    </Marker>
  );
}

// ===== CameraMarker =====
// A fixed speed-camera pin (OpenStreetMap), drawn via react-native-maps' NATIVE
// `image` prop — NOT a captured child <View>/<Ionicons>.
//
// Speed-camera pin. Rendered as a CHILD <Image> inside the Marker (the exact
// path HazardMarker/police use and which is proven to render on Android),
// NOT via the native `image` prop. The `image` prop on react-native-maps
// Android is unreliable for JS-bundled / OTA-delivered PNGs — it left cameras
// blank on Android even after the glyph→PNG swap and the tracksViewChanges fix.
// Hazards and police, which use a child <Image>, render fine on the same
// devices, so we mirror them exactly. Density variants (@2x/@3x) size it.
const CAMERA_ICON = require("../assets/images/speed_camera.png");

function CameraMarker({ lat, lng }: { lat: number; lng: number }) {
  // Track on mount so the child <Image> bitmap is captured once the PNG has
  // loaded, then freeze so we're not re-rasterizing every pin on every commit.
  const [track, setTrack] = useState(true);
  useEffect(() => {
    setTrack(true);
    const t = setTimeout(() => setTrack(false), SNAPSHOT_SETTLE_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <Marker
      coordinate={{ latitude: lat, longitude: lng }}
      anchor={{ x: 0.5, y: 0.5 }}
      zIndex={4}
      tracksViewChanges={track}
    >
      <Image source={CAMERA_ICON} style={styles.cameraIcon} resizeMode="contain" />
    </Marker>
  );
}

// ===== HazardMarker =====
// Community hazard / police pin, rendered as a flat ICON image (police.png for
// police reports, hazard.png for everything else) with NO colored circle behind
// it. Same Android snapshot-settle dance as the other custom markers so the
// bitmap isn't frozen before the image paints. resizeMode "contain" preserves
// whatever aspect ratio the source PNGs have, so sizing is just the box below.
const HAZARD_ICONS: Record<string, any> = {
  police: require("../assets/images/police.png"),
};
const HAZARD_ICON_DEFAULT = require("../assets/images/hazard.png");

function HazardMarker({ hazard, onPress }: { hazard: Hazard; onPress?: () => void }) {
  const [track, setTrack] = useState(true);
  useEffect(() => {
    setTrack(true);
    const t = setTimeout(() => setTrack(false), SNAPSHOT_SETTLE_MS);
    return () => clearTimeout(t);
  }, [hazard.kind]);
  const src = HAZARD_ICONS[hazard.kind] || HAZARD_ICON_DEFAULT;
  return (
    <Marker
      coordinate={{ latitude: hazard.lat, longitude: hazard.lng }}
      anchor={{ x: 0.5, y: 0.5 }}
      zIndex={5}
      tracksViewChanges={track}
      onPress={onPress}
    >
      <Image source={src} style={styles.hazardIcon} resizeMode="contain" />
    </Marker>
  );
}

// ===== PlaceMarker =====
// Category quick-search result pin (gas price chip / fuel badge / named place).
// Uses the same Android snapshot dance as the other text markers — WITHOUT it
// the price/name bitmap is captured before the text lays out and freezes clipped
// ("$2." instead of "$2.07", "Noo" instead of the full name). Re-armed whenever
// the label/price changes so a fresh search re-captures cleanly.
type PlacePoint = { id: string; lat: number; lng: number; label: string; price?: string; isGas?: boolean; cheapest?: boolean };

function PlaceMarker({ place, onPress, showPins = true }: { place: PlacePoint; onPress?: (p: PlacePoint) => void; showPins?: boolean }) {
  const [track, setTrack] = useState(true);
  useEffect(() => {
    setTrack(true);
    const t = setTimeout(() => setTrack(false), SNAPSHOT_SETTLE_MS);
    return () => clearTimeout(t);
  }, [place.label, place.price, place.isGas, place.cheapest, showPins]);
  // Explicit widths sized to the text. Android react-native-maps mis-measures
  // the intrinsic width of Text inside a custom marker view, so the bitmap
  // freezes too narrow and clips ("$2.07" -> "$2."). A hard width (border-box,
  // so it already includes padding + border) forces Yoga to lay the chip out
  // wide enough BEFORE the snapshot is taken — no dependence on text
  // measurement. Per-char estimates are generous so we over-size rather than
  // clip; names cap at the label maxWidth and ellipsize beyond.
  const priceWidth = place.price ? place.price.length * 10 + 18 : undefined;
  const nameWidth = Math.min(150, (place.label?.length || 0) * 8 + 18);
  // Non-gas pins capture the OUTER wrap (label + icon column), not the label,
  // so the wrap needs its own explicit width or Android can still collapse it
  // and clip the label inside. Sized to the label, floored at the icon width.
  const wrapWidth = Math.max(nameWidth, 34);

  // Marker content. The "Place pins" setting (showPins) hides the pure pin
  // GLYPHS — the teardrop under a name and the gas-pump badge for a station
  // with no price — while ALWAYS keeping price chips and name labels. A
  // no-price gas station with pins off has nothing left to draw, so we render
  // no marker at all for it.
  let content: React.ReactNode = null;
  if (place.isGas) {
    if (place.price) {
      content = (
        <View style={[styles.placeLabel, styles.placePriceLabel, place.cheapest ? styles.placePriceCheapest : null, { width: priceWidth }]}>
          <Text style={[styles.placeLabelText, styles.placePriceText, styles.placeTextCenter]} numberOfLines={1}>{place.price}</Text>
        </View>
      );
    } else if (showPins) {
      content = (
        <View style={styles.gasGlyph}>
          <MaterialCommunityIcons name="gas-station" size={20} color="#FFD60A" />
        </View>
      );
    }
  } else {
    content = (
      <View style={[styles.placePinWrap, { width: wrapWidth }]}>
        <View style={[styles.placeLabel, { width: nameWidth }]}>
          <Text style={[styles.placeLabelText, styles.placeTextCenter]} numberOfLines={1}>{place.label}</Text>
        </View>
        {showPins && (
          <View style={styles.locPin}>
            {/* Black border = a slightly larger black pin behind a smaller
                yellow one; the black rim shows through as a clean outline. */}
            <Ionicons name="location" size={32} color="#000000" />
            <Ionicons name="location" size={25} color="#FFD60A" style={styles.locPinInner} />
          </View>
        )}
      </View>
    );
  }
  if (!content) return null;
  return (
    <Marker
      coordinate={{ latitude: place.lat, longitude: place.lng }}
      anchor={place.isGas ? { x: 0.5, y: 0.5 } : { x: 0.5, y: 1 }}
      zIndex={place.cheapest ? 5 : 4}
      tracksViewChanges={track}
      onPress={() => onPress?.(place)}
    >
      {content}
    </Marker>
  );
}

// ===== DestWeatherMarker =====
// Arrival-weather chip floating above the destination pin. Same snapshot dance
// so the temperature text isn't captured clipped on Android.
function DestWeatherMarker({ coordinate, weather }: {
  coordinate: { latitude: number; longitude: number };
  weather: { kind: WeatherKind; temp: string };
}) {
  const [track, setTrack] = useState(true);
  useEffect(() => {
    setTrack(true);
    const t = setTimeout(() => setTrack(false), SNAPSHOT_SETTLE_MS);
    return () => clearTimeout(t);
  }, [weather.kind, weather.temp]);
  const ic = destWxIcon(weather.kind);
  return (
    <Marker coordinate={coordinate} anchor={{ x: 0.5, y: 1 }} zIndex={7} tappable={false} tracksViewChanges={track}>
      <View style={[styles.destWxChip, { width: weather.temp.length * 8 + 44 }]}>
        {ic.mci
          ? <MaterialCommunityIcons name={ic.name as any} size={14} color={ic.color} />
          : <Ionicons name={ic.name as any} size={14} color={ic.color} />}
        <Text style={styles.destWxText}>{weather.temp}</Text>
      </View>
    </Marker>
  );
}

const ConvoyMap = forwardRef<any, ConvoyMapProps>((props, ref) => {
  const {
    center, user, peers, hideSelfMarker, mapView = "heading_up",
    mapType = "hybrid", mapDark = false, leaderUserId, hazards, speedCameras, highlightConvoy,
    destination, destWeather, encodedPolyline, routes = [], selectedRouteIndex = 0, onSelectRoute,
    followUser = false, onUserPan, navigationActive = false, userSpeedMs, distanceToManeuverM,
    showTraffic = true, onMapPress, onMapLongPress, onHazardPress, onHazardLongPress,
    onPeerPress, onMapReady, places, onPlacePress, showPlacePins = true,
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

  // ----- Traffic re-assert after a base-map style change -----
  // Google Maps drops the native traffic layer when `customMapStyle` (or the
  // map type) is re-applied — e.g. switching into dark mode. Because the
  // `showsTraffic` PROP is still true, react-native-maps never re-sends it, so
  // live traffic silently vanishes until the user toggles a layer (which forces
  // a re-apply — exactly the "toggle the map type and it comes back" symptom).
  // We reproduce that toggle automatically: whenever the style key changes,
  // briefly flip traffic off then back on so the native trafficEnabled flag is
  // re-asserted on the fresh base map.
  const [trafficReassert, setTrafficReassert] = useState(true);
  useEffect(() => {
    setTrafficReassert(false);
    const t = setTimeout(() => setTrafficReassert(true), 120);
    return () => clearTimeout(t);
  }, [mapDark, resolvedMapType]);

  // ----- Initial region (only used for uncontrolled first paint) -----
  const initialRegion =
    center && typeof center.lat === "number"
      ? { latitude: center.lat, longitude: center.lng, latitudeDelta: 0.02, longitudeDelta: 0.02 }
      : user && typeof user.lat === "number"
      ? { latitude: user.lat as number, longitude: user.lng as number, latitudeDelta: 0.02, longitudeDelta: 0.02 }
      : undefined;

  // ===== Route-snapping the avatar =====
  // Decoded active route line (only while navigating) + the self position to
  // display: snapped onto that line when we're close to it (≤ 40 m), else raw
  // GPS. Threaded into BOTH the chase camera and the avatar marker so the puck
  // rides the green/blue route line like native Google Maps instead of drifting
  // off-road on noisy fixes. Beyond 40 m we keep the raw fix (you're genuinely
  // off-route; the turn-by-turn engine handles rerouting).
  const activePolyPts = useMemo(() => {
    if (!navigationActive) return null;
    const enc = (routes[selectedRouteIndex] || routes[0])?.polyline || encodedPolyline;
    const pts = enc ? decodePolyline(enc) : [];
    return pts.length >= 2 ? pts : null;
  }, [navigationActive, routes, selectedRouteIndex, encodedPolyline]);

  const selfDisplay = useMemo(() => {
    if (!user || typeof user.lat !== "number" || typeof user.lng !== "number") return null;
    if (activePolyPts) {
      const snap = nearestOnPolyline(user.lat, user.lng, activePolyPts);
      if (snap && snap.distM < 40) return { lat: snap.latitude, lng: snap.longitude };
    }
    return { lat: user.lat, lng: user.lng };
  }, [user?.lat, user?.lng, activePolyPts]);

  // ===== Camera control =====
  // followUser (free-roam) → follow position at a fixed zoom, north-up, flat.
  // navigationActive (chase cam) → speed-zoom, heading-up (unless north_up), 45° pitch.
  const commitCamera = (force = false) => {
    const m = mapRef.current;
    if (!m || !readyRef.current) return;
    const lat = selfDisplay?.lat ?? center?.lat;
    const lng = selfDisplay?.lng ?? center?.lng;
    if (typeof lat !== "number" || typeof lng !== "number") return;

    const heading = (typeof user?.heading === "number" && Number.isFinite(user.heading)) ? user.heading : 0;
    const isHeadingUp = mapView === "heading_up";

    let zoom = FREE_ZOOM;
    let pitch = 0;
    let camHeading = 0;

    if (navigationActive) {
      zoom = chaseZoom(kmhFromMs(userSpeedMs), distanceToManeuverM);
      pitch = isHeadingUp ? CHASE_PITCH_DEG : 0;
      camHeading = isHeadingUp ? heading : 0;
    } else if (followUser) {
      zoom = FOLLOW_ZOOM;
      // Honor the Heading-Up / North-Up setting outside active navigation too.
      // Free-roam follow rotates to course but stays FLAT (no 45° chase tilt —
      // that's reserved for turn-by-turn). This ALSO keeps the map heading-up
      // during any window where turn-by-turn is engaged (followUser true) but
      // the engine hasn't yet flagged tbt.active (navigationActive false), so it
      // no longer snaps back to north mid-drive.
      camHeading = isHeadingUp ? heading : 0;
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
  }, [user?.lat, user?.lng, user?.heading, userSpeedMs, distanceToManeuverM, followUser, navigationActive, mapView]);

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
    // Snapped-to-route position while navigating (see selfDisplay) so the avatar
    // rides the line instead of wandering off-road; raw GPS otherwise.
    const sLat = selfDisplay?.lat ?? user.lat;
    const sLng = selfDisplay?.lng ?? user.lng;
    cars.push({ id: SELF_ID, lat: sLat, lng: sLng, color: user.carColor, heading: user.heading, speedMs: user.speed });
  }
  const peerList: Peer[] = Array.isArray(peers) ? peers : peers ? Object.values(peers) : [];
  peerList.forEach((p) => {
    if (p && typeof p.lat === "number" && typeof p.lng === "number") {
      cars.push({
        id: "peer_" + p.user_id, lat: p.lat, lng: p.lng,
        color: p.activeColor || p.carColor, heading: p.heading, speedMs: p.speed,
        leader: !!leaderUserId && p.user_id === leaderUserId, peer: p,
      });
    }
  });

  // Decode each route once per routes change (memoized so it doesn't recompute
  // on every GPS tick). smoothPath now rounds only GENTLE bends and keeps sharp
  // turns (>= 35-degree deviation, i.e. 90-degree intersection turns) as exact
  // on-road vertices — curves read smooth, corners stay crisp and never cut
  // across buildings.
  const smoothedRouteCoords = useMemo(
    () => (routes || []).map((r: { polyline: string }) => smoothPath(decodePolyline(r.polyline))),
    [routes]
  );

  const visibleHazards = (hazards || []).filter((h: Hazard) => h && typeof h.lat === "number" && typeof h.lng === "number");

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={initialRegion}
        mapType={resolvedMapType}
        customMapStyle={mapDark ? DARK_MAP_STYLE : HIDE_TRANSIT_STYLE}
        showsTraffic={!!showTraffic && trafficReassert}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        rotateEnabled
        pitchEnabled
        toolbarEnabled={false}
        onMapReady={() => { readyRef.current = true; commitCamera(true); onMapReady?.(); }}
        onPress={() => onMapPress?.()}
        onLongPress={(e: any) => {
          const co = e?.nativeEvent?.coordinate;
          if (co && typeof co.latitude === "number") onMapLongPress?.({ lat: co.latitude, lng: co.longitude });
        }}
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
        {/* Community hazard / police pins — flat icon images, no circle. */}
        {visibleHazards.map((h: Hazard) => (
          <HazardMarker key={`hz_${h.id}`} hazard={h} onPress={() => onHazardPress?.(h)} />
        ))}

        {/* Fixed speed cameras (OpenStreetMap). Pins only — the proximity
            voice alert is handled in map.tsx. */}
        {(speedCameras || []).map((c: { id: string; lat: number; lng: number }) => (
          <CameraMarker key={`cam_${c.id}`} lat={c.lat} lng={c.lng} />
        ))}

        {/* Destination pin. */}
        {destination && (
          <Marker coordinate={{ latitude: destination.lat, longitude: destination.lng }} anchor={{ x: 0.5, y: 0.5 }} zIndex={6}>
            <View style={styles.destPin} />
          </Marker>
        )}

        {/* Arrival-weather chip — floats just above the destination pin showing
            the forecast for your estimated arrival time. Separate marker,
            anchored bottom-center, so the pin stays exactly on the coordinate. */}
        {destination && destWeather && (
          <DestWeatherMarker
            coordinate={{ latitude: destination.lat, longitude: destination.lng }}
            weather={destWeather}
          />
        )}

        {/* Category quick-search result pins (from the search-bar pills). Tap a
            pin to route there — handled by onPlacePress up in map.tsx. Rendered
            via PlaceMarker so the price/name bitmap is captured AFTER the text
            lays out (fixes the Android clip: "$2." → "$2.07", "Noo" → full name). */}
        {(places || []).map((p: PlacePoint) => (
          <PlaceMarker key={`place_${p.id}`} place={p} onPress={onPlacePress} showPins={showPlacePins} />
        ))}

        {/* Route polylines — Google style: gray alternates first, then the
            SELECTED route drawn LAST (on top) in bright app-yellow. Each line is
            keyed by the current selection so react-native-maps fully REMOUNTS it
            when selection changes — without that, iOS keeps the old stroke color
            and the selected line renders with a stale/default (blue) stroke. */}
        {destination && routes.map((r: { polyline: string }, i: number) => {
          if (i === selectedRouteIndex) return null; // selected drawn on top below
          const coords = smoothedRouteCoords[i] || [];
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
          const coords = smoothedRouteCoords[selectedRouteIndex] || [];
          if (coords.length === 0) return null;
          // Google-Maps-style route line: a darker-blue CASING drawn first
          // (wider, lower zIndex) with a brighter blue CORE on top, so the line
          // reads as a thick rounded ribbon with a crisp edge against satellite/
          // dark basemaps — instead of a thin flat stroke. Both keyed by the
          // selection so iOS fully remounts them (stale-stroke-color workaround).
          return (
            <React.Fragment key={`sel_${selectedRouteIndex}`}>
              <Polyline
                key={`sel_casing_${selectedRouteIndex}`}
                coordinates={coords}
                strokeColor="#0A3D91"
                strokeWidth={13}
                zIndex={2}
                lineCap="round"
                lineJoin="round"
              />
              <Polyline
                key={`sel_core_${selectedRouteIndex}`}
                coordinates={coords}
                strokeColor="#2A8CFF"
                strokeWidth={9}
                zIndex={3}
                lineCap="round"
                lineJoin="round"
              />
            </React.Fragment>
          );
        })()}

        {/* Route ETA pills — native-style time marker at each route's midpoint.
            Preview only (hidden during active turn-by-turn). Tap to select. */}
        {destination && !navigationActive && routes.map((r: any, i: number) => {
          const coords = decodePolyline(r.polyline);
          if (coords.length === 0) return null;
          const mid = coords[Math.floor(coords.length / 2)];
          const label = r.duration_in_traffic_text || r.duration_text || "";
          if (!label) return null;
          return (
            <RouteEtaMarker
              key={`eta_${i}_${selectedRouteIndex}`}
              coordinate={mid}
              label={label}
              selected={i === selectedRouteIndex}
              onPress={() => onSelectRoute?.(i)}
            />
          );
        })}
      </MapView>
    </View>
  );
});

ConvoyMap.displayName = "ConvoyMap";
export default ConvoyMap;

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  // Route ETA pill (time marker on each route, preview mode)
  etaPill: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 13, borderWidth: 1 },
  etaPillSel: { backgroundColor: "#0A84FF", borderColor: "rgba(0,0,0,0.2)" },
  etaPillAlt: { backgroundColor: "rgba(28,28,30,0.95)", borderColor: "rgba(255,255,255,0.25)" },
  etaPillText: { fontSize: 12, fontWeight: "700" },
  etaPillTextSel: { color: "#FFFFFF" },
  etaPillTextAlt: { color: "#C9C9CE" },
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
  hazardIcon: { width: 40, height: 40 },
  cameraIcon: { width: 34, height: 34 },
  placePinWrap: { alignItems: "center", maxWidth: 150 },
  placeLabel: {
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 6, marginBottom: 1,
    maxWidth: 150,
    borderWidth: 1, borderColor: "rgba(0,0,0,0.55)",
    shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 2, shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  placeLabelText: { color: "#000000", fontSize: 11, fontWeight: "700" },
  placeTextCenter: { textAlign: "center" },
  // Stacked location pin: black (larger) behind yellow (smaller) = black border.
  locPin: { alignItems: "center", justifyContent: "center" },
  locPinInner: { position: "absolute" },
  // 1px transparent child for parked/empty pool slots (kept mounted, opacity 0).
  placeHiddenDot: { width: 1, height: 1 },
  placePriceLabel: { backgroundColor: "#FFD60A", borderWidth: 1, borderColor: "rgba(0,0,0,0.55)" },
  placePriceCheapest: { backgroundColor: "#30D158", borderColor: "rgba(0,0,0,0.55)" },
  placePriceText: { color: "#0A0A0A", fontSize: 13, fontWeight: "800" },
  gasGlyph: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(20,20,22,0.92)",
    borderWidth: 1, borderColor: "rgba(255,214,10,0.6)",
    shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 2,
  },
  destPin: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: "#FF453A", borderWidth: 3, borderColor: "#FFFFFF",
  },
  destWxChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(22,22,24,0.92)",
    borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4,
    marginBottom: 8,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 5 },
    }),
  },
  destWxText: { color: "#fff", fontSize: 12, fontWeight: "700", letterSpacing: -0.2 },
});
