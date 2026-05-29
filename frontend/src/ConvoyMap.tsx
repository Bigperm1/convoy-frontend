// ConvoyMap — React Native map component for Convoy.
//
// ARCHITECTURE:
//   EAS build (react-native-maps available):
//     - show3DMap=false → MapView provider="google" mapType="hybrid"  (2D satellite)
//     - show3DMap=true  → MapView provider="google" mapType="hybridFlyover" iOS /
//                         "hybrid" Android (3D building extrusion where available)
//     - Navigation SDK chase cam: uses @googlemaps/react-native-navigation-sdk
//       NavigationView when the native module is installed; falls back to the
//       animateCamera-based chase cam if the package is not yet linked.
//   Expo Go: stylized SVG route preview fallback (no native modules).

import React, { useEffect, useMemo, useRef } from "react";
import { View, Text, StyleSheet, Dimensions, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Path, Circle, G, Defs, LinearGradient as SvgGrad, Stop, Rect, Text as SvgText } from "react-native-svg";
import { COLORS } from "./theme";
import type { ExternalAlert, ExternalAlertType } from "./externalFeed";
import CarMarker from "./CarMarker";
import { BearingTracker } from "./bearing";

// ---- Lazy-load react-native-maps (not available in Expo Go) ----
let MapView: any = null;
let Marker: any = null;
let Polyline: any = null;
try {
  const m = require("react-native-maps");
  MapView = m.default;
  Marker = m.Marker;
  Polyline = m.Polyline;
} catch {}

// ---- Lazy-load Navigation SDK (requires separate native setup) ----
// When @googlemaps/react-native-navigation-sdk is installed and linked,
// we use its NavigationView which provides a GPU-accelerated chase cam
// that is much smoother than animateCamera() and supports richer turn
// indicators. Falls back gracefully if the package is not installed yet.
let NavigationView: any = null;
let NavSDK: any = null;
try {
  const sdk = require("@googlemaps/react-native-navigation-sdk");
  NavigationView = sdk.NavigationView;
  NavSDK = sdk;
} catch {}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

// ---- Chase-cam constants (used by animateCamera fallback) ----
const CHASE_PITCH_DEG = 45;
const CHASE_ZOOM_CITY = 18;
const CHASE_ZOOM_HIGHWAY = 16;
const CHASE_KMH_CITY = 30;
const CHASE_KMH_HIGHWAY = 100;
const CHASE_ANIM_MS = 600;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}
function kmhFromMs(speedMs: number | undefined | null): number {
  if (typeof speedMs !== "number" || !Number.isFinite(speedMs) || speedMs < 0) return 0;
  return speedMs * 3.6;
}
function chaseZoomForSpeed(kmh: number): number {
  if (kmh <= CHASE_KMH_CITY) return CHASE_ZOOM_CITY;
  if (kmh >= CHASE_KMH_HIGHWAY) return CHASE_ZOOM_HIGHWAY;
  const t = (kmh - CHASE_KMH_CITY) / (CHASE_KMH_HIGHWAY - CHASE_KMH_CITY);
  return lerp(CHASE_ZOOM_CITY, CHASE_ZOOM_HIGHWAY, t);
}

export type Hazard = { id: string; kind: string; lat: number; lng: number; reporter_handle?: string; confirms?: number; disputes?: number };
export type Peer = { user_id: string; handle?: string; lat: number; lng: number; carType?: string; carBody?: string; carColor?: string; activeColor?: string; heading?: number; topSpeed?: number };
export type LatLng = { lat: number; lng: number };

type Props = {
  center: LatLng;
  user: { lat: number; lng: number; heading?: number; carBody?: string; carColor?: string };
  hideSelfMarker?: boolean;
  peers: Peer[];
  leaderUserId?: string | null;
  hazards: Hazard[];
  externalAlerts?: ExternalAlert[];
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
  mapView?: "heading_up" | "north_up";
  // Layer toggles
  show3DMap?: boolean;
  onMapPress?: () => void;
  onHazardPress: (h: Hazard) => void;
  onHazardLongPress?: (h: Hazard) => void;
  onPeerPress?: (p: Peer) => void;
  onExternalAlertPress?: (a: ExternalAlert) => void;
  onRoute?: (info: any) => void;
};

const CONVOY_GOLD = "#FFD60A";

const hazardColor = (k: string) =>
  k === "police" ? "#3478F6" : k === "accident" ? "#FF453A" : "#FF9F0A";
const hazardIcon = (k: string): any =>
  k === "police" ? "shield-checkmark" : k === "accident" ? "alert-circle" : k === "traffic" ? "car" : "warning";

const extColor = (t: ExternalAlertType) =>
  t === "POLICE" ? "#3478F6" : t === "ACCIDENT" ? "#FF453A" : t === "JAM" ? "#FF9F0A"
  : t === "HAZARD" ? "#FFD60A" : t === "CONSTRUCTION" ? "#FF9500" : t === "WEATHER" ? "#5AC8FA" : "#8E8E93";
const extIcon = (t: ExternalAlertType): any =>
  t === "POLICE" ? "shield" : t === "ACCIDENT" ? "warning" : t === "JAM" ? "swap-vertical"
  : t === "HAZARD" ? "alert" : t === "CONSTRUCTION" ? "construct" : t === "WEATHER" ? "cloudy" : "ellipse";

function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b: number, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += ((result & 1) ? ~(result >> 1) : (result >> 1));
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += ((result & 1) ? ~(result >> 1) : (result >> 1));
    points.push({ lat: lat * 1e-5, lng: lng * 1e-5 });
  }
  return points;
}

export default function ConvoyMap({
  center, user, hideSelfMarker = false, peers, leaderUserId, hazards, externalAlerts = [],
  highlightConvoy = true, destination, encodedPolyline, routes = [], selectedRouteIndex = 0,
  onSelectRoute, followUser = false, onUserPan, navigationActive = false, userSpeedMs,
  mapView = "heading_up", show3DMap = false, onMapPress, onHazardPress, onHazardLongPress,
  onPeerPress, onExternalAlertPress,
}: Props) {
  const mapRef = useRef<any>(null);
  const bearingRef = useRef(new BearingTracker());

  // ---- Determine map type based on 3D toggle and platform ----
  // hybridFlyover = iOS 3D tilted aerial with building extrusions
  // hybrid = satellite + road labels (2D, works both platforms)
  const mapType = show3DMap
    ? (Platform.OS === "ios" ? "hybridFlyover" : "hybrid")
    : "hybrid";

  // ---- Navigation SDK chase cam ----
  // When the Navigation SDK native module is available, we initialise it
  // and let it own the camera during navigationActive. Otherwise fall back
  // to the animateCamera useEffect path below.
  const navSDKAvailable = !!NavigationView;

  useEffect(() => {
    if (!navSDKAvailable || !navigationActive || !NavSDK) return;
    // Initialise the Nav SDK navigator for the current session.
    // The SDK takes over the camera from react-native-maps so we just need
    // to keep it alive while navigation is active.
    let navigator: any = null;
    (async () => {
      try {
        navigator = await NavSDK.getNavigator();
        // Set camera to follow-my-location mode (chase cam)
        await navigator.setFollowingPerspective(NavSDK.CameraPerspective.TILTED);
        await navigator.setNightMode(NavSDK.NightMode.AUTO);
      } catch { /* SDK not fully configured, fall through */ }
    })();
    return () => {
      // Detach on cleanup — camera returns to react-native-maps control
      if (navigator) {
        try { navigator.cleanup?.(); } catch {}
      }
    };
  }, [navSDKAvailable, navigationActive]);

  // ---- animateCamera fallback (used when Nav SDK is not installed) ----
  const lastCamRef = useRef<{ lat: number; lng: number; heading: number } | null>(null);
  const userGestureRef = useRef<number>(0);

  useEffect(() => {
    if (navSDKAvailable) return; // Nav SDK handles camera
    if (!navigationActive) return;
    if (!mapRef.current) return;
    if (Date.now() - userGestureRef.current < 5000) return;
    const heading = (typeof user.heading === "number" && Number.isFinite(user.heading)) ? user.heading : 0;
    const last = lastCamRef.current;
    if (last) {
      const R = 6371000;
      const dLat = (user.lat - last.lat) * Math.PI / 180;
      const dLng = (user.lng - last.lng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(last.lat * Math.PI / 180) * Math.cos(user.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
      const distM = 2 * R * Math.asin(Math.sqrt(a));
      const headingDelta = Math.abs(heading - last.heading);
      if (distM < 5 && headingDelta < 5) return;
    }
    lastCamRef.current = { lat: user.lat, lng: user.lng, heading };
    const zoom = chaseZoomForSpeed(kmhFromMs(userSpeedMs));
    const isHeadingUp = mapView === "heading_up";
    try {
      mapRef.current.animateCamera(
        { center: { latitude: user.lat, longitude: user.lng }, pitch: isHeadingUp ? CHASE_PITCH_DEG : 0, heading: isHeadingUp ? heading : 0, zoom },
        { duration: CHASE_ANIM_MS }
      );
    } catch {}
  }, [navigationActive, user.lat, user.lng, user.heading, userSpeedMs, mapView, navSDKAvailable]);

  // ---- Re-center when followUser flips true (not navigating) ----
  useEffect(() => {
    if (!followUser || navigationActive) return;
    if (!mapRef.current) return;
    try {
      mapRef.current.animateCamera(
        { center: { latitude: user.lat, longitude: user.lng } },
        { duration: 600 }
      );
    } catch {}
  }, [followUser]);

  // ---- Re-center to flat view when navigation deactivates ----
  useEffect(() => {
    if (navigationActive) return;
    if (!mapRef.current) return;
    if (Date.now() - userGestureRef.current < 5000) return;
    try {
      mapRef.current.animateCamera(
        { center: { latitude: center.lat, longitude: center.lng }, pitch: 0, heading: 0, zoom: 15 },
        { duration: 400 }
      );
    } catch {}
  }, [navigationActive]);

  const region = useMemo(
    () => followUser
      ? { latitude: user.lat, longitude: user.lng, latitudeDelta: 0.008, longitudeDelta: 0.008 }
      : { latitude: center.lat, longitude: center.lng, latitudeDelta: 0.05, longitudeDelta: 0.05 },
    [followUser, user.lat, user.lng, center.lat, center.lng]
  );

  const routePolylines = useMemo(() => {
    if (routes.length > 0) {
      return routes.map((r, i) => ({
        coords: decodePolyline(r.polyline).map((p) => ({ latitude: p.lat, longitude: p.lng })),
        isSelected: i === selectedRouteIndex,
        color: r.color ?? (i === 0 ? '#34C759' : i === 1 ? '#FF9500' : '#FF3B30'),
        index: i,
      }));
    }
    if (encodedPolyline) {
      return [{ coords: decodePolyline(encodedPolyline).map((p) => ({ latitude: p.lat, longitude: p.lng })), isSelected: true, color: '#34C759', index: 0 }];
    }
    return [];
  }, [routes, encodedPolyline, selectedRouteIndex]);

  // ---- No native maps (Expo Go) ----
  if (!MapView) {
    return <RoutePreviewFallback {...{ center, user, peers, hazards, externalAlerts, highlightConvoy, destination, encodedPolyline, routes, selectedRouteIndex, onSelectRoute, onHazardPress, onExternalAlertPress }} />;
  }

  // ---- Full Google Maps (EAS build) ----
  return (
    <MapView
      ref={mapRef}
      provider="google"
      mapType={mapType}
      style={StyleSheet.absoluteFill}
      minZoomLevel={3}
      maxZoomLevel={20}
      initialRegion={region}
      region={(navigationActive || !followUser) ? undefined : region}
      showsCompass={!navigationActive}
      rotateEnabled
      zoomTapEnabled={false}
      pitchEnabled
      showsTraffic
      onPress={onMapPress ? () => onMapPress() : undefined}
      onRegionChangeComplete={(_region: any, details: any) => {
        if ((details as any)?.isGesture) {
          userGestureRef.current = Date.now();
          onUserPan?.();
        }
      }}
    >
      {!hideSelfMarker && (
        <Marker coordinate={{ latitude: user.lat, longitude: user.lng }} anchor={{ x: 0.5, y: 0.5 }} zIndex={10} flat>
          <CarMarker
            body={(user.carBody as any) || "sedan"}
            color={user.carColor}
            heading={bearingRef.current.get("self", user.lat, user.lng, user.heading)}
            size={48}
          />
        </Marker>
      )}

      {peers.map((p) => {
        const isLeader = !!leaderUserId && p.user_id === leaderUserId;
        return (
          <Marker key={p.user_id} coordinate={{ latitude: p.lat, longitude: p.lng }} anchor={{ x: 0.5, y: 0.5 }} flat zIndex={isLeader ? 1000 : 1} onPress={() => onPeerPress?.(p)}>
            <View style={styles.peerWrap}>
              <CarMarker body={(p.carBody as any) || "sedan"} color={p.carColor} activeColor={p.activeColor} heading={bearingRef.current.get(p.user_id, p.lat, p.lng, p.heading)} size={isLeader ? 56 : 48} />
              {!!p.carType && (
                <View style={[styles.carPill, isLeader && styles.carPillLeader]}>
                  <Text numberOfLines={1} style={[styles.carPillText, isLeader && styles.carPillTextLeader]}>{isLeader ? "★ " : ""}{p.carType}</Text>
                </View>
              )}
            </View>
          </Marker>
        );
      })}

      {hazards.map((h) => (
        <Marker key={`u-${h.id}`} coordinate={{ latitude: h.lat, longitude: h.lng }} anchor={{ x: 0.5, y: 1 }} onPress={() => onHazardPress(h)} onCalloutPress={() => onHazardLongPress?.(h)}>
          <View style={styles.hazardWrap}>
            <View style={[styles.hazardBubble, { backgroundColor: hazardColor(h.kind) }, highlightConvoy && { borderColor: CONVOY_GOLD, borderWidth: 3, shadowColor: CONVOY_GOLD, shadowOpacity: 0.6, shadowRadius: 6 }]}>
              <Ionicons name={hazardIcon(h.kind)} size={22} color="#fff" />
            </View>
            <View style={[styles.hazardTail, { borderTopColor: highlightConvoy ? CONVOY_GOLD : hazardColor(h.kind) }]} />
          </View>
        </Marker>
      ))}

      {externalAlerts.map((a) => (
        <Marker key={`x-${a.id}`} coordinate={{ latitude: a.lat, longitude: a.lng }} anchor={{ x: 0.5, y: 1 }} onPress={() => onExternalAlertPress?.(a)} tracksViewChanges={false}>
          <View style={styles.extWrap}>
            <View style={[styles.extBubble, { backgroundColor: extColor(a.type) }]}>
              <Ionicons name={extIcon(a.type)} size={16} color="#fff" />
            </View>
            <View style={[styles.extTail, { borderTopColor: extColor(a.type) }]} />
          </View>
        </Marker>
      ))}

      {destination && (
        <Marker coordinate={{ latitude: destination.lat, longitude: destination.lng }} anchor={{ x: 0.5, y: 1 }}>
          <View style={[styles.hazardBubble, { backgroundColor: COLORS.danger }]}>
            <Ionicons name="flag" size={22} color="#fff" />
          </View>
        </Marker>
      )}

      {Polyline && routePolylines.filter(r => !r.isSelected).map((r) => (
        <Polyline key={`alt-${r.index}`} coordinates={r.coords} strokeColor={`${r.color}73`} strokeWidth={4} tappable onPress={() => onSelectRoute?.(r.index)} zIndex={1} />
      ))}
      {Polyline && routePolylines.filter(r => r.isSelected).map((r) => (
        <Polyline key={`sel-${r.index}`} coordinates={r.coords} strokeColor={r.color} strokeWidth={6} zIndex={2} />
      ))}
    </MapView>
  );
}

// ---- Expo Go SVG fallback (unchanged) ----
function RoutePreviewFallback({ center, user, peers, hazards, externalAlerts = [], highlightConvoy = true, destination, encodedPolyline, routes = [], selectedRouteIndex = 0, onSelectRoute, onHazardPress, onExternalAlertPress }: Props) {
  const bearingRef = useRef(new BearingTracker());
  const decodedRoutes = useMemo(() => {
    if (routes.length > 0) return routes.map((r) => decodePolyline(r.polyline));
    if (encodedPolyline) return [decodePolyline(encodedPolyline)];
    return [];
  }, [routes, encodedPolyline]);
  const allRoutePoints = decodedRoutes.flat();

  const allLats = [user.lat, ...peers.map(p => p.lat), ...hazards.map(h => h.lat), ...externalAlerts.map(a => a.lat), ...allRoutePoints.map(p => p.lat)];
  const allLngs = [user.lng, ...peers.map(p => p.lng), ...hazards.map(h => h.lng), ...externalAlerts.map(a => a.lng), ...allRoutePoints.map(p => p.lng)];
  if (destination) { allLats.push(destination.lat); allLngs.push(destination.lng); }
  const minLat = Math.min(...allLats), maxLat = Math.max(...allLats);
  const minLng = Math.min(...allLngs), maxLng = Math.max(...allLngs);
  const padLat = Math.max(0.005, (maxLat - minLat) * 0.15);
  const padLng = Math.max(0.005, (maxLng - minLng) * 0.15);
  const W = SCREEN_W, H = SCREEN_H;
  const project = (lat: number, lng: number) => ({
    x: ((lng - (minLng - padLng)) / ((maxLng + padLng) - (minLng - padLng))) * W,
    y: H - ((lat - (minLat - padLat)) / ((maxLat + padLat) - (minLat - padLat))) * H,
  });
  const userXY = project(user.lat, user.lng);
  const destXY = destination ? project(destination.lat, destination.lng) : null;
  const routePaths = decodedRoutes.map((pts) => {
    if (pts.length < 2) return null;
    return "M " + pts.map((p) => { const xy = project(p.lat, p.lng); return `${xy.x.toFixed(1)} ${xy.y.toFixed(1)}`; }).join(" L ");
  });

  return (
    <View style={StyleSheet.absoluteFill}>
      <Svg width={W} height={H}>
        <Defs>
          <SvgGrad id="bg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#0E1A2D" /><Stop offset="1" stopColor="#070D18" />
          </SvgGrad>
        </Defs>
        <Rect x="0" y="0" width={W} height={H} fill="url(#bg)" />
        <Path d={`M -50 ${H * 0.18} Q ${W * 0.35} ${H * 0.08}, ${W * 0.65} ${H * 0.2} T ${W + 50} ${H * 0.24} L ${W + 50} ${H * 0.42} L -50 ${H * 0.4} Z`} fill="#1F3322" opacity={0.5} />
        {[...Array(8)].map((_, i) => (
          <Path key={`g${i}`} d={`M 0 ${(i * H) / 8} H ${W}`} stroke="rgba(120,130,140,0.08)" strokeWidth={1} />
        ))}
        {routePaths.map((d, i) => {
          if (!d || i === selectedRouteIndex) return null;
          return <Path key={`alt-${i}`} d={d} stroke="#8E8E93" strokeWidth={5} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.7} onPress={onSelectRoute ? () => onSelectRoute(i) : undefined} />;
        })}
        {routePaths[selectedRouteIndex] && (
          <G>
            <Path d={routePaths[selectedRouteIndex] as string} stroke="#0A84FF" strokeWidth={9} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.95} />
            <Path d={routePaths[selectedRouteIndex] as string} stroke="#FFFFFF" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 10" opacity={0.5} />
          </G>
        )}
        {peers.map((p) => {
          const xy = project(p.lat, p.lng);
          return (
            <G key={p.user_id}>
              <Circle cx={xy.x} cy={xy.y} r={11} fill={COLORS.success} fillOpacity={0.2} />
              <Circle cx={xy.x} cy={xy.y} r={6} fill={COLORS.success} stroke="#fff" strokeWidth={2} />
              {!!p.carType && (
                <SvgText x={xy.x} y={xy.y + 22} fontSize="10" fontWeight="600" fill="#fff" textAnchor="middle" stroke="rgba(0,0,0,0.65)" strokeWidth="2.5" paintOrder="stroke">
                  {p.carType.length > 22 ? p.carType.slice(0, 20) + "\u2026" : p.carType}
                </SvgText>
              )}
            </G>
          );
        })}
        {hazards.map((h) => {
          const xy = project(h.lat, h.lng);
          const c = hazardColor(h.kind);
          return (
            <G key={`u-${h.id}`}>
              {highlightConvoy && <Circle cx={xy.x} cy={xy.y} r={13} fill="none" stroke={CONVOY_GOLD} strokeWidth={2} />}
              <Circle cx={xy.x} cy={xy.y} r={14} fill={c} fillOpacity={0.25} />
              <Circle cx={xy.x} cy={xy.y} r={9} fill={c} stroke={highlightConvoy ? CONVOY_GOLD : "#fff"} strokeWidth={highlightConvoy ? 2.5 : 2} />
            </G>
          );
        })}
        {externalAlerts.map((a) => {
          const xy = project(a.lat, a.lng);
          const c = extColor(a.type);
          const s = 7;
          return (
            <G key={`x-${a.id}`}>
              <Circle cx={xy.x} cy={xy.y} r={11} fill={c} fillOpacity={0.22} />
              <Path d={`M ${xy.x} ${xy.y - s} L ${xy.x + s} ${xy.y} L ${xy.x} ${xy.y + s} L ${xy.x - s} ${xy.y} Z`} fill={c} stroke="#fff" strokeWidth={1.5} />
            </G>
          );
        })}
        {destXY && (
          <G>
            <Circle cx={destXY.x} cy={destXY.y} r={14} fill={COLORS.danger} fillOpacity={0.3} />
            <Circle cx={destXY.x} cy={destXY.y} r={9} fill={COLORS.danger} stroke="#fff" strokeWidth={2} />
          </G>
        )}
        <G>
          <Circle cx={userXY.x} cy={userXY.y} r={26} fill={COLORS.primary} fillOpacity={0.16} />
        </G>
      </Svg>
      {!hideSelfMarker && (
        <View pointerEvents="none" style={{ position: "absolute", left: userXY.x - 22, top: userXY.y - 22, width: 44, height: 44 }}>
          <CarMarker body={(user.carBody as any) || "sedan"} color={user.carColor} heading={bearingRef.current.get("self", user.lat, user.lng, user.heading)} size={44} />
        </View>
      )}
      {routes.length === 0 && !encodedPolyline && (
        <View style={styles.notice} pointerEvents="none">
          <Text style={styles.noticeTitle}>Route preview</Text>
          <Text style={styles.noticeText}>Search a destination to see your route. Full satellite tiles unlock with an EAS dev build.</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  peerWrap: { alignItems: "center" },
  carPill: { marginTop: 3, backgroundColor: "rgba(20,20,24,0.82)", borderColor: "rgba(255,255,255,0.20)", borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, maxWidth: 160, ...Platform.select({ ios: { shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } }, android: { elevation: 3 } }) },
  carPillLeader: { backgroundColor: "rgba(255,199,0,0.95)", borderColor: "#1a1a1a" },
  carPillText: { color: "#fff", fontSize: 10, fontWeight: "600", letterSpacing: 0.2 },
  carPillTextLeader: { color: "#1a1a1a", fontWeight: "700" },
  hazardWrap: { alignItems: "center" },
  hazardBubble: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(255,255,255,0.9)" },
  hazardTail: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 9, borderLeftColor: "transparent", borderRightColor: "transparent", marginTop: -1 },
  extWrap: { alignItems: "center" },
  extBubble: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(255,255,255,0.85)", transform: [{ rotate: "45deg" }] },
  extTail: { width: 0, height: 0, borderLeftWidth: 4, borderRightWidth: 4, borderTopWidth: 6, borderLeftColor: "transparent", borderRightColor: "transparent", marginTop: -1 },
  notice: { position: "absolute", left: 24, right: 24, bottom: 220, alignItems: "center" },
  noticeTitle: { color: COLORS.text, fontSize: 14, fontWeight: "600", marginBottom: 4 },
  noticeText: { color: COLORS.textDim, textAlign: "center", fontSize: 12, lineHeight: 17 },
});
