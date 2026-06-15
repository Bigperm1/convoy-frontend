// ConvoyMapbox.tsx — NATIVE map (iOS/Android) built on @rnmapbox/maps (Mapbox).
//
// PARALLEL to ConvoyMap.tsx (react-native-maps / Google). This is the Mapbox
// re-implementation, built up incrementally behind a settings toggle so the
// proven Google map keeps working untouched while we port it feature-by-feature.
// map.tsx spreads the SAME props into whichever engine the toggle selects, so
// this is a literal drop-in for ConvoyMap.
//
// PORTED SO FAR:
//   • base Mapbox map — dark Standard/night (3D buildings) or satellite (hybrid)
//   • follow / chase camera — Mapbox NATIVE course-follow (smooth glide; speed/corner zoom + 45° tilt), powered by a visible LocationPuck
//   • self car puck + every peer car (rotated GR Corolla PNGs)
//   • routes — gray alternates + the SELECTED glowing GREEN ribbon, tap-to-select,
//     ETA pills, dest pin, route-preview fit-to-bounds, plus a LIVE traffic-
//     congestion gradient on the previewed route (Mapbox Directions)
//   • map overlays — community hazard / police pins, ON-ROUTE speed cameras,
//     category place pins (gas price chips / fuel badges / named places), and
//     the destination arrival-weather chip
//
// MarkerView note: unlike react-native-maps (which captured each marker's child
// view into a native bitmap — needing the Android "snapshot-settle" delay and
// hard-coded text widths to avoid clipping "$2.07" → "$2."), Mapbox MarkerView
// renders the real RN view. So all of that ceremony is gone here.
//
// NOT YET PORTED (each ships later as a FREE OTA increment; props still accepted
// and ignored for now): the maneuver turn-arrow, avatar route-snapping, and
// carrying the congestion gradient THROUGH active navigation (today it's preview-
// only — promoting it is part of the later, drive-tested Mapbox routing swap).
//
// COORDINATE ORDER: Mapbox uses [longitude, latitude] arrays (GeoJSON order) —
// the OPPOSITE of react-native-maps' { latitude, longitude }. Every coordinate
// handed to Mapbox below is [lng, lat].

import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Image, StyleSheet, Pressable } from "react-native";
import Mapbox, { MapView, Camera, MarkerView, ShapeSource, LineLayer, UserTrackingMode, LocationPuck, Models, ModelLayer } from "@rnmapbox/maps";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { getVehiclePngOrDefault, getVehicleTint } from "./vehicleAssets";
import type { Peer, Hazard, UserLocation } from "./ConvoyMap";
import type { WeatherKind } from "./weatherLayer";
import { fetchMapboxCongestion, buildCongestionGradient } from "./mapboxDirections";

// 1×1 fully transparent PNG — a REAL bundled asset, not a data-URI (@rnmapbox's
// Images may not load a data-URI at runtime, which would let the default dot fall
// back). Registered as a Mapbox image and used as the LocationPuck's artwork so
// the native location layer stays MOUNTED + VISIBLE (which powers
// Camera.followUserLocation) while drawing NOTHING — the blue location dot under
// the car is gone but the chase-cam still tracks.
const EMPTY_PUCK_IMG = require("../assets/images/empty-puck.png");

type LatLng = { lat: number; lng: number };

// Mirrors ConvoyMapProps from ConvoyMap.tsx so the two engines are swappable.
// Kept as a separate copy during the migration; once Mapbox is the only engine,
// ConvoyMap.tsx is deleted and this becomes the single source of truth.
interface ConvoyMapboxProps {
  center?: { lat: number; lng: number; heading?: number } | null;
  user?: UserLocation | null;
  hideSelfMarker?: boolean;
  mapView?: "heading_up" | "north_up";
  // Base-map mode — drives the Mapbox style + light preset directly. mapType/
  // mapDark are still accepted (shared MapEngine props) but unused by this engine.
  mapMode?: "satellite" | "dawn" | "day" | "dusk" | "night";
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

// Self-car 3D model. GLB is ~1.9 units long in its own space; common-3d treats
// units as meters, so a real GR Corolla (~4.37m) ≈ 2.3x. Bumped to 3 for map
// presence. Both of these are OTA-tunable — adjust freely after first render.
const CAR_MODEL_SCALE = 6;
const CAR_MODEL_HEADING_OFFSET = 0; // deg; if the car faces wrong, try 90/180/270 (and/or negate heading)
// Self-illumination for the 3D car per light preset. Dawn + night are dim, so
// the tinted paint renders near-black with only scene light — lift those so the
// color shows. Bright presets (day/dusk/satellite) already light it, so keep 0
// to preserve real 3D shading. 0 = fully scene-lit, 1 = fully self-lit (flat).
const CAR_EMISSIVE_BY_MODE: Record<string, number> = {
  satellite: 0,
  day: 0,
  dusk: 0,
  dawn: 0.55,
  night: 0.85,
};

// ----- Marker icon assets (shared with the Google engine) -----
const HAZARD_ICONS: Record<string, any> = {
  police: require("../assets/images/police.png"),
};
const HAZARD_ICON_DEFAULT = require("../assets/images/hazard.png");
const CAMERA_ICON = require("../assets/images/speed_camera.png");

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

// ===== Route line styling (brand green, sampled from new_logo_icons.png) =====
// The selected route is a glowing neon-green ribbon matching the app icon's route
// line: a saturated green GLOW underlay (wide + blurred) beneath a thick bright
// green CORE. Replaces the old blue/navy line.
//
// IMPORTANT — emissive: every route layer sets `lineEmissiveStrength: 1`. The
// Mapbox Standard style applies its 3D SCENE LIGHTING to custom layers, so at the
// "night" preset it DIMS them — which is why the line looked dark ("forest green",
// and the old blue looked near-black). Emissive strength 1 makes the line self-lit
// so it renders at full brightness regardless of the night lighting.
const ROUTE_GREEN_CORE = "#2DEC86"; // bright neon-green core (the visible line)
const ROUTE_GREEN_GLOW = "#00E070"; // saturated green halo (blurred underlay)

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

// Decode a Google encoded polyline → [{latitude, longitude}]. Engine-agnostic;
// copied from ConvoyMap so this file stays self-contained during the migration.
// Returns [] on bad input so a malformed polyline never crashes the map.
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

// Speed cameras are drawn ONLY within this corridor (metres) of the active route
// so they don't clutter the rest of the map — keeps the ones on the road you're
// routed along, drops ones on unrelated nearby streets.
const ROUTE_CAMERA_CORRIDOR_M = 150;

// Min distance (metres) from a point to a segment A→B, via a local
// equirectangular projection centred on the point (accurate at street scale).
function distPointToSegM(pLat: number, pLng: number, aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const cosLat = Math.cos(toRad(pLat));
  const x = (lng: number) => toRad(lng - pLng) * cosLat * R;
  const y = (lat: number) => toRad(lat - pLat) * R;
  const ax = x(aLng), ay = y(aLat), bx = x(bLng), by = y(bLat);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((0 - ax) * dx + (0 - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

type CarPoint = { id: string; lat: number; lng: number; color?: string; heading?: number; leader?: boolean; peer?: Peer };
type PlacePoint = { id: string; lat: number; lng: number; label: string; price?: string; isGas?: boolean; cheapest?: boolean };

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

// ===== HazardMarker =====
// Community hazard / police pin — a flat icon image (police.png for police,
// hazard.png otherwise). Tap → details; long-press → the standard hazard menu.
function HazardMarker({ hazard, onPress, onLongPress }: { hazard: Hazard; onPress?: () => void; onLongPress?: () => void }) {
  const src = HAZARD_ICONS[hazard.kind] || HAZARD_ICON_DEFAULT;
  return (
    <MarkerView coordinate={[hazard.lng, hazard.lat]} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
      <Pressable onPress={onPress} onLongPress={onLongPress} hitSlop={6}>
        <Image source={src} style={styles.hazardIcon} resizeMode="contain" fadeDuration={0} />
      </Pressable>
    </MarkerView>
  );
}

// ===== CameraMarker =====
// Fixed speed-camera pin (OpenStreetMap). Pins only — the proximity voice alert
// is handled in map.tsx. No press handler.
function CameraMarker({ lat, lng }: { lat: number; lng: number }) {
  // The Image is wrapped in a sized View: MarkerView positions a child view at
  // the coordinate and reads its measured size — a BARE <Image> child can
  // measure 0×0 (before the bitmap loads) and render invisibly, which is why
  // cameras alone didn't show. The explicit-size wrapper gives MarkerView a
  // stable box to place immediately. (Every other marker already wraps its
  // image in a View/Pressable, so only cameras were affected.)
  return (
    <MarkerView coordinate={[lng, lat]} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
      <View style={styles.cameraIconWrap}>
        <Image source={CAMERA_ICON} style={styles.cameraIcon} resizeMode="contain" fadeDuration={0} />
      </View>
    </MarkerView>
  );
}

// ===== PlaceMarker =====
// Category quick-search result pin: gas price chip / fuel badge / named place.
// The "Place pins" setting (showPins) hides the pure pin GLYPHS (teardrop under
// a name, gas-pump badge) while ALWAYS keeping price chips and name labels. A
// no-price gas station with pins off has nothing to draw → no marker at all.
function PlaceMarker({ place, onPress, showPins = true }: { place: PlacePoint; onPress?: (p: PlacePoint) => void; showPins?: boolean }) {
  let content: React.ReactNode = null;
  if (place.isGas) {
    if (place.price) {
      content = (
        <View style={[styles.placeLabel, styles.placePriceLabel, place.cheapest ? styles.placePriceCheapest : null]}>
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
      <View style={styles.placePinWrap}>
        <View style={styles.placeLabel}>
          <Text style={[styles.placeLabelText, styles.placeTextCenter]} numberOfLines={1}>{place.label}</Text>
        </View>
        {showPins && (
          <View style={styles.locPin}>
            {/* Black (larger) behind yellow (smaller) = a clean black outline. */}
            <Ionicons name="location" size={32} color="#000000" />
            <Ionicons name="location" size={25} color="#FFD60A" style={styles.locPinInner} />
          </View>
        )}
      </View>
    );
  }
  if (!content) return null;
  return (
    <MarkerView coordinate={[place.lng, place.lat]} anchor={place.isGas ? { x: 0.5, y: 0.5 } : { x: 0.5, y: 1 }} allowOverlap>
      <Pressable onPress={() => onPress?.(place)} hitSlop={6}>{content}</Pressable>
    </MarkerView>
  );
}

// ===== DestWeatherMarker =====
// Arrival-weather chip floating just above the destination pin.
function DestWeatherMarker({ lat, lng, weather }: { lat: number; lng: number; weather: { kind: WeatherKind; temp: string } }) {
  const ic = destWxIcon(weather.kind);
  return (
    <MarkerView coordinate={[lng, lat]} anchor={{ x: 0.5, y: 1 }} allowOverlap>
      <View style={styles.destWxChip}>
        {ic.mci
          ? <MaterialCommunityIcons name={ic.name as any} size={14} color={ic.color} />
          : <Ionicons name={ic.name as any} size={14} color={ic.color} />}
        <Text style={styles.destWxText}>{weather.temp}</Text>
      </View>
    </MarkerView>
  );
}

function ConvoyMapbox(props: ConvoyMapboxProps) {
  const {
    center, user, peers, hideSelfMarker, mapView = "heading_up",
    mapMode = "satellite", leaderUserId, show3dBuildings = true,
    followUser = false, onUserPan, navigationActive = false, userSpeedMs,
    distanceToManeuverM, onMapPress, onMapLongPress, onPeerPress, onMapReady,
    routes = [], selectedRouteIndex = 0, onSelectRoute, destination,
    hazards, speedCameras, places, showPlacePins = true, destWeather,
    onHazardPress, onHazardLongPress, onPlacePress,
  } = props;

  const cameraRef = useRef<React.ElementRef<typeof Camera>>(null);
  const readyRef = useRef(false);
  const gesturingRef = useRef(false);
  // Tracks which destination we've already framed (preview fit-to-bounds) so we
  // don't re-fit on every route recompute / GPS tick.
  const fittedDestRef = useRef<string | null>(null);
  // Live traffic-congestion gradient for the route preview (Mapbox Directions).
  // Null unless we have a fetched congestion route to paint (preview-only).
  const [congestionRoute, setCongestionRoute] = useState<{ coordinates: [number, number][]; gradient: any } | null>(null);

  // ----- Base-map style (one code path, driven by mapMode) -----
  // "satellite"              → satellite-with-streets imagery (matches Google sat).
  // dawn / day / dusk / night → Mapbox STANDARD style; the time-of-day lighting is
  //   applied via the <StyleImport> child below (config.lightPreset = mapMode),
  //   which gives the dark/tilted vector basemap with auto 3D buildings.
  const useStandard = mapMode !== "satellite";
  const styleURL = useStandard
    ? "mapbox://styles/mapbox/standard"
    : Mapbox.StyleURL.SatelliteStreet;

  // Map bearing the camera is using right now (heading-up while following /
  // navigating, else north). CarMarker subtracts this so every car rides
  // nose-forward up the rotated road.
  const selfHeadingDeg = typeof user?.heading === "number" && Number.isFinite(user.heading) ? user.heading : 0;
  const mapHeadingDeg = mapView === "heading_up" && (navigationActive || followUser) ? selfHeadingDeg : 0;

  // Initial camera target for first paint (avoids a flash at null-island).
  const initLat = center?.lat ?? user?.lat;
  const initLng = center?.lng ?? user?.lng;

  // ===== Route geometry → GeoJSON =====
  // One LineString feature per route, tagged with its index. The LineLayers
  // below filter on that index to draw alternates vs. the selected ribbon.
  // Typed loosely (any) to avoid GeoJSON tuple-type friction.
  const routeFC: any = useMemo(() => ({
    type: "FeatureCollection",
    features: (routes || [])
      .map((r, i) => {
        const coords = decodePolyline(r.polyline).map((p) => [p.longitude, p.latitude]);
        return coords.length >= 2
          ? { type: "Feature", properties: { index: i }, geometry: { type: "LineString", coordinates: coords } }
          : null;
      })
      .filter(Boolean),
  }), [routes]);

  // Tap an alternate route line → select it (same as tapping its ETA pill).
  const handleRoutePress = (e: any) => {
    const idx = e?.features?.[0]?.properties?.index;
    if (typeof idx === "number") onSelectRoute?.(idx);
  };

  // ===== Native follow / chase camera =====
  // Mapbox's NATIVE course-follow camera — the smooth, interpolated tracking its
  // own navigation uses — driven declaratively by the follow props below. The
  // <LocationPuck> mounted in the map is what ACTIVATES Mapbox's native location
  // layer that this camera tracks; that puck must be VISIBLE to start the layer (a
  // hidden location component does NOT start it — which is exactly why the camera
  // sat on the world at cold start and didn't chase). With the layer live, native
  // follow both centres on cold start and glides during nav.
  //   • followUserLocation = track the driver (followUser; parent drops it on a pan)
  //   • followUserMode     = course-up while heading-up, else plain follow
  //   • followZoomLevel    = speed/corner chase zoom while navigating, fixed follow zoom otherwise
  //   • followPitch        = 45° while navigating heading-up, flat otherwise
  const headingUp = mapView === "heading_up";
  const followZoom = Math.round(
    (navigationActive ? chaseZoom(kmhFromMs(userSpeedMs), distanceToManeuverM) : FOLLOW_ZOOM) * 10,
  ) / 10;
  const followPitchDeg = navigationActive && headingUp ? CHASE_PITCH_DEG : 0;

  // When nav ends while NOT following (the driver had panned away), flatten the
  // tilt / heading back to a calm north-up overview. While following, the native
  // follow props already drop the pitch — no imperative move needed.
  useEffect(() => {
    if (navigationActive) return;
    const cam = cameraRef.current;
    if (!cam || !readyRef.current || followUser) return;
    try { cam.setCamera({ pitch: 0, heading: 0, zoomLevel: FREE_ZOOM, animationDuration: 350, animationMode: "easeTo" }); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationActive]);

  // ===== Preview: fit the camera to ALL route options =====
  // When routes are computed and we're NOT navigating, frame the whole set of
  // options (Google's route-overview behavior). Fires ONCE per destination
  // (fittedDestRef), and only matters when not actively following — the native
  // follow owns the camera during follow/nav, so this won't fight the chase cam.
  useEffect(() => {
    const cam = cameraRef.current;
    if (!destination) { fittedDestRef.current = null; return; }
    if (!cam || !readyRef.current || navigationActive || followUser || (routes?.length ?? 0) === 0) return;
    const key = `${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}`;
    if (fittedDestRef.current === key) return;

    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    const add = (lat: number, lng: number) => {
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
    };
    (routes || []).forEach((r) => decodePolyline(r.polyline).forEach((p) => add(p.latitude, p.longitude)));
    if (user && typeof user.lat === "number" && typeof user.lng === "number") add(user.lat, user.lng);
    add(destination.lat, destination.lng);
    if (!Number.isFinite(minLat)) return;

    fittedDestRef.current = key;
    try {
      cam.setCamera({
        bounds: { ne: [maxLng, maxLat], sw: [minLng, minLat], paddingTop: 140, paddingBottom: 340, paddingLeft: 60, paddingRight: 60 },
        heading: 0,
        pitch: 0,
        animationDuration: 600,
        animationMode: "easeTo",
      });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, destination, navigationActive, followUser]);

  // ===== Route congestion gradient (Mapbox Directions) — PREVIEW only =====
  // On a new destination (and while NOT navigating) fetch the live driving-traffic
  // route from Mapbox and paint it as a congestion-coloured line. Keyed ONLY on
  // the destination so a GPS tick never refetches; the origin is the user's spot
  // at fetch time. Cleared when there's no destination or once navigation starts
  // (during active guidance the chase cam + Google geometry own the screen —
  // unifying that is the later, drive-tested routing swap). Fails soft to null.
  useEffect(() => {
    if (navigationActive || !destination) { setCongestionRoute(null); return; }
    const oLat = center?.lat ?? user?.lat;
    const oLng = center?.lng ?? user?.lng;
    if (typeof oLat !== "number" || typeof oLng !== "number" ||
        typeof destination.lat !== "number" || typeof destination.lng !== "number") {
      setCongestionRoute(null);
      return;
    }
    const ctrl = new AbortController();
    let cancelled = false;
    fetchMapboxCongestion({ lat: oLat, lng: oLng }, { lat: destination.lat, lng: destination.lng }, { signal: ctrl.signal })
      .then((res) => {
        if (cancelled) return;
        if (!res) { setCongestionRoute(null); return; }
        setCongestionRoute({ coordinates: res.coordinates, gradient: buildCongestionGradient(res.coordinates, res.congestion) });
      })
      .catch(() => { if (!cancelled) setCongestionRoute(null); });
    return () => { cancelled = true; ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination?.lat, destination?.lng, navigationActive]);

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
  // The self car is rendered as a 3D GLB model (ModelLayer) instead of the flat
  // PNG; peers stay PNG MarkerViews. Pulled out here so the model layer below has
  // its live coordinate + heading.
  const selfCar = cars.find((c) => c.id === SELF_ID);
  // Tint for the single white GLB → the user's chosen GRC paint (one render, 5 colors).
  const selfTint = getVehicleTint(selfCar?.color);
  // Lift the paint out of the dark on the dim light presets (dawn/night).
  const selfEmissive = CAR_EMISSIVE_BY_MODE[mapMode] ?? 0;

  const visibleHazards = (hazards || []).filter((h) => h && typeof h.lat === "number" && typeof h.lng === "number");
  const showRoutes = !!destination && routeFC.features.length > 0;

  // Speed cameras render ONLY along the SELECTED route (within the corridor), so
  // they don't clutter the rest of the map. No selected route → no camera pins.
  // The OSM fetch is unchanged; this just picks the on-route subset to draw, and
  // the proximity VOICE alert in map.tsx still uses the full set — so no camera
  // warnings are lost, this is purely about decluttering the visual pins.
  const onRouteCameras = useMemo(() => {
    const cams = speedCameras || [];
    if (cams.length === 0) return [];
    const line = decodePolyline(routes?.[selectedRouteIndex]?.polyline);
    if (line.length < 2) return [];
    return cams.filter((c) => {
      let best = Infinity;
      for (let i = 0; i + 1 < line.length; i++) {
        const d = distPointToSegM(c.lat, c.lng, line[i].latitude, line[i].longitude, line[i + 1].latitude, line[i + 1].longitude);
        if (d < best) best = d;
        if (best <= ROUTE_CAMERA_CORRIDOR_M) break;
      }
      return best <= ROUTE_CAMERA_CORRIDOR_M;
    });
  }, [speedCameras, routes, selectedRouteIndex]);

  // Preview congestion gradient is shown whenever we have a fetched congestion
  // route, a destination, and we're not navigating. When on, it REPLACES the
  // solid blue selected ribbon (so there's only one line for the active route).
  const showCongestion = !!congestionRoute && !navigationActive && !!destination;
  const congestionFeature: any = useMemo(
    () => congestionRoute
      ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: congestionRoute.coordinates } }
      : null,
    [congestionRoute],
  );

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
        onDidFinishLoadingMap={() => { readyRef.current = true; onMapReady?.(); }}
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
        {/* Mapbox Standard "night" config — turns on the dark 3D-building
            basemap. Only mounted when the Standard style is active (roadmap +
            dark); harmless no-op for the satellite/street styles. 3D buildings
            are on by default in Standard, so only the light preset is set. */}
        {useStandard && (
          <Mapbox.StyleImport id="basemap" existing config={{ lightPreset: mapMode, show3dObjects: show3dBuildings }} />
        )}

        {/* Register the self-car 3D model once for the map. Referenced by id
            ("convoyCar") from the ModelLayer below. */}
        <Models models={{ convoyCar: "https://upload.higgsfield.ai/user_3Esn44ZOJFPf9WVoTekRPGSBe28/6891a037-7cb1-4d7c-83f0-dd004ab46846.glb" }} />

        {/* Mapbox's native location layer — REQUIRED to power the Camera's
            followUserLocation (a hidden/unmounted location component doesn't start
            the native engine, which stops the chase cam). So we keep it VISIBLE
            but give it fully TRANSPARENT artwork (top/bearing/shadow image = a 1×1
            clear PNG) and disable the pulse: the engine runs and the camera
            follows, but no blue dot is drawn under the car. `scale` only scales
            the custom images, not the default native dot — which is why scale={0}
            alone never hid it. The GR Corolla MarkerView stays the self-car on top. */}
        <Mapbox.Images images={{ convoyEmptyPuck: EMPTY_PUCK_IMG }} />
        <LocationPuck
          visible
          topImage="convoyEmptyPuck"
          bearingImage="convoyEmptyPuck"
          shadowImage="convoyEmptyPuck"
          pulsing={{ isEnabled: false }}
          puckBearing="course"
          puckBearingEnabled
        />

        <Camera
          ref={cameraRef}
          followUserLocation={followUser}
          followUserMode={headingUp ? UserTrackingMode.FollowWithCourse : UserTrackingMode.Follow}
          followZoomLevel={followZoom}
          followPitch={followPitchDeg}
          defaultSettings={
            typeof initLat === "number" && typeof initLng === "number"
              ? { centerCoordinate: [initLng, initLat], zoomLevel: FOLLOW_ZOOM }
              : undefined
          }
        />

        {/* ===== Routes ===== gray alternates first, then the SELECTED glowing
            green ribbon (green glow under, bright green core on top). All in the
            "middle" slot so the Standard style's street labels stay legible on
            top of the line. Tap an alternate to select it (ShapeSource onPress).
            While previewing, the solid blue ribbon is REPLACED by the live
            congestion gradient (the convoy-congestion source just below) — the
            selected casing/core are hidden by filtering them to a non-existent
            index rather than unmounting, since ShapeSource children must always
            be elements (never a boolean). */}
        {showRoutes && (
          <ShapeSource id="convoy-routes" shape={routeFC} onPress={handleRoutePress}>
            <LineLayer
              id="route-alts"
              slot="middle"
              filter={["!=", ["get", "index"], selectedRouteIndex] as any}
              style={{ lineColor: "#9AA0A6", lineWidth: 5, lineCap: "round", lineJoin: "round", lineOpacity: 0.85, lineEmissiveStrength: 1 }}
            />
            <LineLayer
              id="route-sel-casing"
              slot="middle"
              filter={(showCongestion ? ["==", ["get", "index"], -1] : ["==", ["get", "index"], selectedRouteIndex]) as any}
              style={{ lineColor: ROUTE_GREEN_GLOW, lineWidth: 24, lineBlur: 8, lineOpacity: 0.55, lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1 }}
            />
            <LineLayer
              id="route-sel-core"
              slot="middle"
              filter={(showCongestion ? ["==", ["get", "index"], -1] : ["==", ["get", "index"], selectedRouteIndex]) as any}
              style={{ lineColor: ROUTE_GREEN_CORE, lineWidth: 12, lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1 }}
            />
          </ShapeSource>
        )}

        {/* ===== Live traffic-congestion gradient (preview) ===== Mapbox
            Directions driving-traffic, painted as a cased ribbon whose CORE is a
            congestion gradient — blue when clear, warming to yellow / orange /
            red where traffic slows. Replaces the solid blue selected ribbon
            while previewing. `lineMetrics` enables the line-progress gradient. */}
        {showCongestion && congestionFeature && (
          <ShapeSource id="convoy-congestion" shape={congestionFeature} lineMetrics>
            <LineLayer
              id="cong-casing"
              slot="middle"
              style={{ lineColor: ROUTE_GREEN_GLOW, lineWidth: 24, lineBlur: 8, lineOpacity: 0.55, lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1 }}
            />
            <LineLayer
              id="cong-core"
              slot="middle"
              style={{ lineGradient: congestionRoute!.gradient, lineWidth: 12, lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1 }}
            />
          </ShapeSource>
        )}

        {/* Destination pin (red dot). */}
        {destination && (
          <MarkerView coordinate={[destination.lng, destination.lat]} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={styles.destPin} />
          </MarkerView>
        )}

        {/* Route ETA pills — on each ALTERNATE route's midpoint, preview only.
            The selected route's ETA already shows in the bottom Drive card, so
            it's skipped here. Tap a pill to switch to that route. */}
        {destination && !navigationActive && (routes || []).map((r: any, i: number) => {
          if (i === selectedRouteIndex) return null;
          const pts = decodePolyline(r.polyline);
          if (pts.length === 0) return null;
          const mid = pts[Math.floor(pts.length / 2)];
          const label = r.duration_in_traffic_text || r.duration_text || "";
          if (!label) return null;
          return (
            <MarkerView key={`eta_${i}_${selectedRouteIndex}`} coordinate={[mid.longitude, mid.latitude]} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
              <Pressable onPress={() => onSelectRoute?.(i)} hitSlop={6}>
                <View style={styles.etaPillAlt}>
                  <Text style={styles.etaPillTextAlt}>{label}</Text>
                </View>
              </Pressable>
            </MarkerView>
          );
        })}

        {/* Community hazard / police pins. */}
        {visibleHazards.map((h) => (
          <HazardMarker
            key={`hz_${h.id}`}
            hazard={h}
            onPress={() => onHazardPress?.(h)}
            onLongPress={() => onHazardLongPress?.(h)}
          />
        ))}

        {/* Speed cameras — only those along the active route (decluttered). */}
        {onRouteCameras.map((c) => (
          <CameraMarker key={`cam_${c.id}`} lat={c.lat} lng={c.lng} />
        ))}

        {/* Category quick-search place pins. */}
        {(places || []).map((p) => (
          <PlaceMarker key={`place_${p.id}`} place={p} onPress={onPlacePress} showPins={showPlacePins} />
        ))}

        {/* Arrival-weather chip floating above the destination. */}
        {destination && destWeather && (
          <DestWeatherMarker lat={destination.lat} lng={destination.lng} weather={destWeather} />
        )}

        {/* Self car as a 3D GLB model (ModelLayer). Lives in the map's geo space
            (rotates/tilts with the world), unlike the screen-space PNG MarkerView.
            modelRotation z = world heading + offset. Renders only if ModelLayer is
            present in the running native build — this OTA is the test for that. */}
        {selfCar && (
          <ShapeSource
            id="convoy-self-car"
            shape={{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [selfCar.lng, selfCar.lat] } }}
          >
            <ModelLayer
              id="convoy-self-car-model"
              slot="top"
              style={{
                modelId: "convoyCar",
                modelType: "location-indicator",
                modelColor: selfTint.color,
                modelColorMixIntensity: selfTint.mix,
                modelEmissiveStrength: selfEmissive,
                modelScale: [CAR_MODEL_SCALE, CAR_MODEL_SCALE, CAR_MODEL_SCALE],
                modelRotation: [0, 0, ((selfCar.heading ?? 0) + CAR_MODEL_HEADING_OFFSET)],
                modelCastShadows: true,
                modelReceiveShadows: false,
              }}
            />
          </ShapeSource>
        )}

        {/* Car markers — PEERS only (self is the 3D model above). MarkerViews
            always render above the route LineLayers, and we declare the cars LAST
            so they sit on top of the other pins too. */}
        {cars.filter((c) => c.id !== SELF_ID).map((c) => (
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
  // Route ETA pill (alternate routes, preview mode).
  etaPillAlt: {
    backgroundColor: "rgba(28,28,30,0.95)",
    borderColor: "rgba(255,255,255,0.25)",
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 13,
  },
  etaPillTextAlt: { color: "#C9C9CE", fontSize: 12, fontWeight: "700" },
  // Destination pin (red dot with white ring).
  destPin: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: "#FF453A", borderWidth: 3, borderColor: "#FFFFFF",
  },
  // Hazard / camera icons.
  hazardIcon: { width: 40, height: 40 },
  cameraIconWrap: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  cameraIcon: { width: 28, height: 28 },
  // Place pins (gas price chips / fuel badges / named places).
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
  locPin: { alignItems: "center", justifyContent: "center" },
  locPinInner: { position: "absolute" },
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
  // Arrival-weather chip.
  destWxChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(22,22,24,0.92)",
    borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4,
    marginBottom: 8,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
    shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  destWxText: { color: "#fff", fontSize: 12, fontWeight: "700", letterSpacing: -0.2 },
});
