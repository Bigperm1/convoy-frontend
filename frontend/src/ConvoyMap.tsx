// ConvoyMap â Google Navigation SDK map component for Convoy.
//
// ARCHITECTURE:
//   Uses @googlemaps/react-native-navigation-sdk exclusively.
//   No react-native-maps. No other map library.
//
//   NavigationView   â full-screen map surface (Google Maps tiles + nav UI)
//   MapViewController â programmatic markers, polylines, camera
//   NavigationViewController â chase-cam during active navigation
//   Expo Go fallback â SVG route preview (no native modules available)

import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { View, Text, StyleSheet, Dimensions, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Svg, {
  Path, Circle, G, Defs,
  LinearGradient as SvgGrad, Stop, Rect,
  Text as SvgText,
} from "react-native-svg";
import { COLORS } from "./theme";
import type { ExternalAlert, ExternalAlertType } from "./externalFeed";
import CarMarker from "./CarMarker";
import { BearingTracker } from "./bearing";

// ââ Lazy-load Navigation SDK (not available in Expo Go) ââââââââââââââââââââââââââââââ
let NavigationView: any = null;
let NavMapColorScheme: any = null;
try {
  const sdk = require("@googlemaps/react-native-navigation-sdk");
  NavigationView = sdk.NavigationView;
  NavMapColorScheme = sdk.MapColorScheme ?? null;
} catch {}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

// ââ Types ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
export type Hazard = {
  id: string; kind: string; lat: number; lng: number;
  reporter_handle?: string; confirms?: number; disputes?: number;
};
export type Peer = {
  user_id: string; handle?: string; lat: number; lng: number;
  carType?: string; carBody?: string; carColor?: string;
  activeColor?: string; heading?: number; topSpeed?: number;
};
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
  mapType?: string;
  show3DMap?: boolean;
  onMapPress?: () => void;
  onHazardPress: (h: Hazard) => void;
  onHazardLongPress?: (h: Hazard) => void;
  onPeerPress?: (p: Peer) => void;
  onExternalAlertPress?: (a: ExternalAlert) => void;
  onRoute?: (info: any) => void;
};

// ââ Helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const CONVOY_GOLD = "#FFD60A";

const hazardColor = (k: string) =>
  k === "police" ? "#3478F6" : k === "accident" ? "#FF453A" : "#FF9F0A";
const hazardIcon = (k: string): any =>
  k === "police" ? "shield-checkmark" : k === "accident" ? "alert-circle"
  : k === "traffic" ? "car" : "warning";

const extColor = (t: ExternalAlertType) =>
  t === "POLICE" ? "#3478F6" : t === "ACCIDENT" ? "#FF453A"
  : t === "JAM" ? "#FF9F0A" : t === "HAZARD" ? "#FFD60A"
  : t === "CONSTRUCTION" ? "#FF9500" : t === "WEATHER" ? "#5AC8FA" : "#8E8E93";
const extIcon = (t: ExternalAlertType): any =>
  t === "POLICE" ? "shield" : t === "ACCIDENT" ? "warning"
  : t === "JAM" ? "swap-vertical" : t === "HAZARD" ? "alert"
  : t === "CONSTRUCTION" ? "construct" : t === "WEATHER" ? "cloudy" : "ellipse";

function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b: number, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push({ lat: lat * 1e-5, lng: lng * 1e-5 });
  }
  return points;
}

const routePolylineId = (i: number) => `route_${i}`;
const hazardMarkerId   = (id: string) => `hazard_${id}`;
const extAlertMarkerId = (id: string) => `ext_${id}`;
const peerMarkerId     = (id: string) => `peer_${id}`;
const SELF_MARKER_ID   = "convoy_self";
const DEST_MARKER_ID   = "convoy_dest";

// ââ Main component âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
export default function ConvoyMap({
  center, user, hideSelfMarker = false, peers, leaderUserId,
  hazards, externalAlerts = [], highlightConvoy = true,
  destination, encodedPolyline, routes = [], selectedRouteIndex = 0,
  onSelectRoute, followUser = false, onUserPan, navigationActive = false,
  userSpeedMs, mapView = "heading_up", show3DMap = false,
  onMapPress, onHazardPress, onHazardLongPress, onPeerPress, onExternalAlertPress,
}: Props) {
  const bearingRef = useRef(new BearingTracker());
  const mapVCRef   = useRef<any>(null);
  const navVCRef   = useRef<any>(null);
  const liveMarkerIds   = useRef<Set<string>>(new Set());
  const livePolylineIds = useRef<Set<string>>(new Set());
  const userGestureRef  = useRef<number>(0);

  // â Decoded polylines âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const routePolylines = useMemo(() => {
    if (routes.length > 0) {
      return routes.map((r, i) => ({
        id: routePolylineId(i),
        coords: decodePolyline(r.polyline).map(p => ({ lat: p.lat, lng: p.lng })),
        isSelected: i === selectedRouteIndex,
        color: r.color ?? (i === 0 ? "#34C759" : i === 1 ? "#FF9500" : "#FF3B30"),
        index: i,
      }));
    }
    if (encodedPolyline) {
      return [{ id: routePolylineId(0), coords: decodePolyline(encodedPolyline).map(p => ({ lat: p.lat, lng: p.lng })), isSelected: true, color: "#34C759", index: 0 }];
    }
    return [];
  }, [routes, encodedPolyline, selectedRouteIndex]);

  // â Sync markers to native map ââââââââââââââââââââââââââââââââââââââââââââââââââ
  const syncMarkers = useCallback((vc: any) => {
    if (!vc) return;
    const desired = new Set<string>();
    if (!hideSelfMarker) {
      desired.add(SELF_MARKER_ID);
      vc.addMarker({ id: SELF_MARKER_ID, position: { lat: user.lat, lng: user.lng }, title: "", flat: true, zIndex: 10 });
    }
    if (destination) {
      desired.add(DEST_MARKER_ID);
      vc.addMarker({ id: DEST_MARKER_ID, position: { lat: destination.lat, lng: destination.lng }, title: "Destination", zIndex: 5 });
    }
    for (const h of hazards) {
      const mid = hazardMarkerId(h.id);
      desired.add(mid);
      vc.addMarker({ id: mid, position: { lat: h.lat, lng: h.lng }, title: h.kind, zIndex: 3 });
    }
    for (const a of externalAlerts) {
      const mid = extAlertMarkerId(a.id);
      desired.add(mid);
      vc.addMarker({ id: mid, position: { lat: a.lat, lng: a.lng }, title: a.type, zIndex: 2 });
    }
    for (const p of peers) {
      const mid = peerMarkerId(p.user_id);
      desired.add(mid);
      vc.addMarker({ id: mid, position: { lat: p.lat, lng: p.lng }, title: p.handle ?? p.user_id, zIndex: p.user_id === leaderUserId ? 100 : 1 });
    }
    for (const id of liveMarkerIds.current) {
      if (!desired.has(id)) { try { vc.removeMarker(id); } catch {} }
    }
    liveMarkerIds.current = desired;
  }, [hideSelfMarker, user, destination, hazards, externalAlerts, peers, leaderUserId]);

  // â Sync polylines to native map âââââââââââââââââââââââââââââââââââââââââââââââ
  const syncPolylines = useCallback((vc: any) => {
    if (!vc) return;
    const desired = new Set<string>();
    for (const r of routePolylines) {
      desired.add(r.id);
      vc.addPolyline({ id: r.id, points: r.coords, color: r.isSelected ? r.color : `${r.color}73`, width: r.isSelected ? 6 : 4, zIndex: r.isSelected ? 2 : 1, clickable: !r.isSelected });
    }
    for (const id of livePolylineIds.current) {
      if (!desired.has(id)) { try { vc.removePolyline(id); } catch {} }
    }
    livePolylineIds.current = desired;
  }, [routePolylines]);

  useEffect(() => { syncMarkers(mapVCRef.current); }, [syncMarkers]);
  useEffect(() => { syncPolylines(mapVCRef.current); }, [syncPolylines]);

  // â Chase cam via NavigationViewController âââââââââââââââââââââââââââââââââââ
  useEffect(() => {
    if (!navVCRef.current || !navigationActive) return;
    try {
      navVCRef.current.setFollowingPerspective(mapView === "heading_up" ? "TILTED" : "TOP_DOWN_NORTH_UP");
    } catch {}
  }, [navigationActive, mapView]);

  // â Recenter when nav ends or followUser changes ââââââââââââââââââââââââââââ
  useEffect(() => {
    const vc = mapVCRef.current;
    if (!vc || Date.now() - userGestureRef.current < 5000) return;
    if (followUser || !navigationActive) {
      try {
        vc.moveCamera({ target: { lat: user.lat, lng: user.lng }, zoom: 15, tilt: 0, bearing: 0 });
      } catch {}
    }
  }, [followUser, navigationActive, user.lat, user.lng]);

  // â NavigationView callbacks ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const onMapViewControllerCreated = useCallback((vc: any) => {
    mapVCRef.current = vc;
    try { vc.moveCamera({ target: { lat: center.lat, lng: center.lng }, zoom: 15, tilt: 0, bearing: 0 }); } catch {}
    syncMarkers(vc);
    syncPolylines(vc);
  }, [center, syncMarkers, syncPolylines]);

  const onNavigationViewControllerCreated = useCallback((vc: any) => {
    navVCRef.current = vc;
  }, []);

  const onMapClick = useCallback((_latLng: any) => {
    userGestureRef.current = Date.now();
    onUserPan?.();
    onMapPress?.();
  }, [onMapPress, onUserPan]);

  const onMarkerClick = useCallback((marker: any) => {
    const id: string = marker?.id ?? "";
    if (id.startsWith("hazard_")) {
      const h = hazards.find(x => x.id === id.replace("hazard_", ""));
      if (h) onHazardPress(h);
    } else if (id.startsWith("ext_")) {
      const a = externalAlerts.find(x => x.id === id.replace("ext_", ""));
      if (a) onExternalAlertPress?.(a);
    } else if (id.startsWith("peer_")) {
      const p = peers.find(x => x.user_id === id.replace("peer_", ""));
      if (p) onPeerPress?.(p);
    }
  }, [hazards, externalAlerts, peers, onHazardPress, onExternalAlertPress, onPeerPress]);

  // â No native SDK (Expo Go) ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  if (!NavigationView) {
    return (
      <RoutePreviewFallback
        {...{ center, user, peers, hazards, externalAlerts, highlightConvoy,
              destination, encodedPolyline, routes, selectedRouteIndex,
              onSelectRoute, onHazardPress, onExternalAlertPress }}
      />
    );
  }

  // â Full Google Navigation SDK map âââââââââââââââââââââââââââââââââââââââââââ
  return (
    <View style={StyleSheet.absoluteFill}>
      <NavigationView
        style={StyleSheet.absoluteFill}
        mapColorScheme={NavMapColorScheme?.DARK ?? "DARK"}
        trafficEnabled
        buildingsEnabled={show3DMap}
        myLocationEnabled
        myLocationButtonEnabled={false}
        compassEnabled={!navigationActive}
        headerEnabled={navigationActive}
        footerEnabled={navigationActive}
        tripProgressBarEnabled={navigationActive}
        speedometerEnabled={navigationActive}
        speedLimitIconEnabled={navigationActive}
        recenterButtonEnabled={false}
        onMapClick={onMapClick}
        onMarkerClick={onMarkerClick}
        onMapViewControllerCreated={onMapViewControllerCreated}
        onNavigationViewControllerCreated={onNavigationViewControllerCreated}
      />
    </View>
  );
}

// ââ Expo Go SVG fallback ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function RoutePreviewFallback({
  center, user, hideSelfMarker = false, peers, hazards, externalAlerts = [], highlightConvoy = true,
  destination, encodedPolyline, routes = [], selectedRouteIndex = 0,
  onSelectRoute, onHazardPress, onExternalAlertPress,
}: Props) {
  const bearingRef = useRef(new BearingTracker());
  const decodedRoutes = useMemo(() => {
    if (routes.length > 0) return routes.map(r => decodePolyline(r.polyline));
    if (encodedPolyline) return [decodePolyline(encodedPolyline)];
    return [];
  }, [routes, encodedPolyline]);
  const allRoutePoints = decodedRoutes.flat();
  const allLats = [user.lat, ...peers.map((p: Peer) => p.lat), ...hazards.map((h: Hazard) => h.lat),
    ...externalAlerts.map((a: ExternalAlert) => a.lat), ...allRoutePoints.map(p => p.lat)];
  const allLngs = [user.lng, ...peers.map((p: Peer) => p.lng), ...hazards.map((h: Hazard) => h.lng),
    ...externalAlerts.map((a: ExternalAlert) => a.lng), ...allRoutePoints.map(p => p.lng)];
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
  const routePaths = decodedRoutes.map(pts => {
    if (pts.length < 2) return null;
    return "M " + pts.map(p => { const xy = project(p.lat, p.lng); return `${xy.x.toFixed(1)} ${xy.y.toFixed(1)}`; }).join(" L ");
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
        {[...Array(8)].map((_, i) => (<Path key={`g${i}`} d={`M 0 ${(i * H) / 8} H ${W}`} stroke="rgba(120,130,140,0.08)" strokeWidth={1} />))}
        {routePaths.map((d, i) => {
          if (!d || i === selectedRouteIndex) return null;
          return <Path key={`alt-${i}`} d={d} stroke="#8E8E93" strokeWidth={5} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.7} onPress={onSelectRoute ? () => onSelectRoute(i) : undefined} />;
        })}
        {routePaths[selectedRouteIndex] && (<G><Path d={routePaths[selectedRouteIndex] as string} stroke="#0A84FF" strokeWidth={9} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.95} /><Path d={routePaths[selectedRouteIndex] as string} stroke="#FFFFFF" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 10" opacity={0.5} /></G>)}
        {peers.map((p: Peer) => { const xy = project(p.lat, p.lng); return (<G key={p.user_id}><Circle cx={xy.x} cy={xy.y} r={11} fill={COLORS.success} fillOpacity={0.2} /><Circle cx={xy.x} cy={xy.y} r={6} fill={COLORS.success} stroke="#fff" strokeWidth={2} />{!!p.carType && (<SvgText x={xy.x} y={xy.y + 22} fontSize="10" fontWeight="600" fill="#fff" textAnchor="middle" stroke="rgba(0,0,0,0.65)" strokeWidth="2.5">{p.carType.length > 22 ? p.carType.slice(0, 20) + "\u2026" : p.carType}</SvgText>)}</G>); })}
        {hazards.map((h: Hazard) => { const xy = project(h.lat, h.lng); const c = hazardColor(h.kind); return (<G key={`u-${h.id}`}>{highlightConvoy && <Circle cx={xy.x} cy={xy.y} r={13} fill="none" stroke={CONVOY_GOLD} strokeWidth={2} />}<Circle cx={xy.x} cy={xy.y} r={14} fill={c} fillOpacity={0.25} /><Circle cx={xy.x} cy={xy.y} r={9} fill={c} stroke={highlightConvoy ? CONVOY_GOLD : "#fff"} strokeWidth={highlightConvoy ? 2.5 : 2} /></G>); })}
        {externalAlerts.map((a: ExternalAlert) => { const xy = project(a.lat, a.lng); const c = extColor(a.type); const s = 7; return (<G key={`x-${a.id}`}><Circle cx={xy.x} cy={xy.y} r={11} fill={c} fillOpacity={0.22} /><Path d={`M ${xy.x} ${xy.y - s} L ${xy.x + s} ${xy.y} L ${xy.x} ${xy.y + s} L ${xy.x - s} ${xy.y} Z`} fill={c} stroke="#fff" strokeWidth={1.5} /></G>); })}
        {destXY && (<G><Circle cx={destXY.x} cy={destXY.y} r={14} fill={COLORS.danger} fillOpacity={0.3} /><Circle cx={destXY.x} cy={destXY.y} r={9} fill={COLORS.danger} stroke="#fff" strokeWidth={2} /></G>)}
        <G><Circle cx={userXY.x} cy={userXY.y} r={26} fill={COLORS.primary} fillOpacity={0.16} /></G>
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
  notice: { position: "absolute", left: 24, right: 24, bottom: 220, alignItems: "center" },
  noticeTitle: { color: COLORS.text, fontSize: 14, fontWeight: "600", marginBottom: 4 },
  noticeText: { color: COLORS.textDim, textAlign: "center", fontSize: 12, lineHeight: 17 },
});
