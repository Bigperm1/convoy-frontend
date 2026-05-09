// Native (Expo Go) ConvoyMap fallback with route preview.
// Until the user runs an EAS dev build, react-native-maps native module isn't available.
// This component renders a stylized SVG canvas with: peer dots, hazard pins, user position,
// and (when a destination + encoded polyline are passed) the decoded route as an animated path.

import React, { useMemo } from "react";
import { View, Text, StyleSheet, Dimensions, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Path, Circle, G, Defs, LinearGradient as SvgGrad, Stop, Rect, Text as SvgText } from "react-native-svg";
import { COLORS } from "./theme";
import type { ExternalAlert, ExternalAlertType } from "./externalFeed";
import CarMarker from "./CarMarker";

let MapView: any = null;
let Marker: any = null;
let Polyline: any = null;
try {
  const m = require("react-native-maps");
  MapView = m.default;
  Marker = m.Marker;
  Polyline = m.Polyline;
} catch {}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

export type Hazard = { id: string; kind: string; lat: number; lng: number; reporter_handle?: string; confirms?: number; disputes?: number };
export type Peer = { user_id: string; handle?: string; lat: number; lng: number; carType?: string; carBody?: string; carColor?: string; heading?: number };
export type LatLng = { lat: number; lng: number };

type Props = {
  center: LatLng;
  user: { lat: number; lng: number; heading?: number };
  peers: Peer[];
  // user_id of the convoy leader (community admin). Their marker is rendered
  // with a higher zIndex so it stays on top when the convoy bunches up at a stop.
  leaderUserId?: string | null;
  hazards: Hazard[];
  externalAlerts?: ExternalAlert[];
  highlightConvoy?: boolean;
  destination?: LatLng | null;
  encodedPolyline?: string | null;
  routes?: { polyline: string }[];
  selectedRouteIndex?: number;
  onSelectRoute?: (index: number) => void;
  followUser?: boolean;
  onHazardPress: (h: Hazard) => void;
  onPeerPress?: (p: Peer) => void;
  onExternalAlertPress?: (a: ExternalAlert) => void;
  onRoute?: (info: any) => void;
};

const CONVOY_GOLD = "#FFD60A";

const hazardColor = (k: string) =>
  k === "police" ? "#3478F6" : k === "accident" ? "#FF453A" : k === "traffic" ? "#FF9F0A" : "#FF9F0A";
const hazardIcon = (k: string): any =>
  k === "police" ? "shield-checkmark" : k === "accident" ? "alert-circle" : k === "traffic" ? "car" : "warning";

// External (Waze-style) alert visuals — map normalized type → color/icon
const extColor = (t: ExternalAlertType) =>
  t === "POLICE" ? "#3478F6"
    : t === "ACCIDENT" ? "#FF453A"
    : t === "JAM" ? "#FF9F0A"
    : t === "HAZARD" ? "#FFD60A"
    : t === "CONSTRUCTION" ? "#FF9500"
    : t === "WEATHER" ? "#5AC8FA"
    : "#8E8E93";
const extIcon = (t: ExternalAlertType): any =>
  t === "POLICE" ? "shield"
    : t === "ACCIDENT" ? "warning"
    : t === "JAM" ? "swap-vertical"
    : t === "HAZARD" ? "alert"
    : t === "CONSTRUCTION" ? "construct"
    : t === "WEATHER" ? "cloudy"
    : "ellipse";

// Google Maps polyline decoder
function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b: number, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;
    points.push({ lat: lat * 1e-5, lng: lng * 1e-5 });
  }
  return points;
}

export default function ConvoyMap({ center, user, peers, leaderUserId, hazards, externalAlerts = [], highlightConvoy = true, destination, encodedPolyline, routes = [], selectedRouteIndex = 0, onSelectRoute, followUser = false, onHazardPress, onPeerPress, onExternalAlertPress }: Props) {
  // ---- Real Google Maps (EAS dev build) ----
  if (MapView) {
    // When following user (turn-by-turn), zoom in tighter; otherwise wider preview
    const region = followUser
      ? { latitude: user.lat, longitude: user.lng, latitudeDelta: 0.008, longitudeDelta: 0.008 }
      : { latitude: center.lat, longitude: center.lng, latitudeDelta: 0.05, longitudeDelta: 0.05 };

    // Build all route polylines: alternates (gray) first, then selected (blue) on top
    const routePolylines = routes.length > 0
      ? routes.map((r, i) => ({
          coords: decodePolyline(r.polyline).map((p) => ({ latitude: p.lat, longitude: p.lng })),
          isSelected: i === selectedRouteIndex,
          index: i,
        }))
      : encodedPolyline
        ? [{ coords: decodePolyline(encodedPolyline).map((p) => ({ latitude: p.lat, longitude: p.lng })), isSelected: true, index: 0 }]
        : [];

    return (
      <MapView provider="google" mapType="hybrid" style={StyleSheet.absoluteFill} initialRegion={region} region={region}>
        <Marker coordinate={{ latitude: user.lat, longitude: user.lng }} anchor={{ x: 0.5, y: 0.5 }} zIndex={10}>
          <View style={styles.youDot}><Ionicons name="navigate" size={16} color="#fff" /></View>
        </Marker>
        {peers.map((p) => {
          const isLeader = !!leaderUserId && p.user_id === leaderUserId;
          return (
            <Marker
              key={p.user_id}
              coordinate={{ latitude: p.lat, longitude: p.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              flat
              // Convoy leaders sit on top so they remain visible when teammates
              // bunch up at red lights / parking lots / starting line.
              zIndex={isLeader ? 1000 : 1}
              onPress={() => onPeerPress?.(p)}
            >
              <View style={styles.peerWrap}>
                <CarMarker
                  body={(p.carBody as any) || "sedan"}
                  color={p.carColor}
                  heading={p.heading || 0}
                  size={isLeader ? 56 : 48}
                />
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
          <Marker key={`u-${h.id}`} coordinate={{ latitude: h.lat, longitude: h.lng }} anchor={{ x: 0.5, y: 1 }} onPress={() => onHazardPress(h)}>
            <View style={styles.hazardWrap}>
              <View style={[
                styles.hazardBubble,
                { backgroundColor: hazardColor(h.kind) },
                highlightConvoy && { borderColor: CONVOY_GOLD, borderWidth: 3, shadowColor: CONVOY_GOLD, shadowOpacity: 0.6, shadowRadius: 6 },
              ]}>
                <Ionicons name={hazardIcon(h.kind)} size={22} color="#fff" />
              </View>
              <View style={[styles.hazardTail, { borderTopColor: highlightConvoy ? CONVOY_GOLD : hazardColor(h.kind) }]} />
            </View>
          </Marker>
        ))}
        {externalAlerts.map((a) => (
          <Marker
            key={`x-${a.id}`}
            coordinate={{ latitude: a.lat, longitude: a.lng }}
            anchor={{ x: 0.5, y: 1 }}
            onPress={() => onExternalAlertPress?.(a)}
            tracksViewChanges={false}
          >
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
        {/* Render alternates first (gray), then the selected route on top (blue). Tappable. */}
        {Polyline && routePolylines.filter(r => !r.isSelected).map((r) => (
          <Polyline
            key={`alt-${r.index}`}
            coordinates={r.coords}
            strokeColor="#8E8E93"
            strokeWidth={4}
            tappable
            onPress={() => onSelectRoute?.(r.index)}
          />
        ))}
        {Polyline && routePolylines.filter(r => r.isSelected).map((r) => (
          <Polyline
            key={`sel-${r.index}`}
            coordinates={r.coords}
            strokeColor="#0A84FF"
            strokeWidth={6}
          />
        ))}
      </MapView>
    );
  }

  // ---- Expo Go fallback: stylized SVG route preview ----
  return <RoutePreviewFallback {...{ center, user, peers, hazards, externalAlerts, highlightConvoy, destination, encodedPolyline, routes, selectedRouteIndex, onSelectRoute, onHazardPress, onExternalAlertPress }} />;
}

function RoutePreviewFallback({ center, user, peers, hazards, externalAlerts = [], highlightConvoy = true, destination, encodedPolyline, routes = [], selectedRouteIndex = 0, onSelectRoute, onHazardPress }: Props) {
  // Decode all routes (or the legacy single polyline)
  const decodedRoutes = useMemo(() => {
    if (routes.length > 0) return routes.map((r) => decodePolyline(r.polyline));
    if (encodedPolyline) return [decodePolyline(encodedPolyline)];
    return [];
  }, [routes, encodedPolyline]);
  const allRoutePoints = decodedRoutes.flat();

  // Build bounding box across user + destination + ALL route points (incl. alternates)
  const allLats: number[] = [user.lat, ...peers.map((p) => p.lat), ...hazards.map((h) => h.lat), ...externalAlerts.map((a) => a.lat), ...allRoutePoints.map((p) => p.lat)];
  const allLngs: number[] = [user.lng, ...peers.map((p) => p.lng), ...hazards.map((h) => h.lng), ...externalAlerts.map((a) => a.lng), ...allRoutePoints.map((p) => p.lng)];
  if (destination) { allLats.push(destination.lat); allLngs.push(destination.lng); }
  const minLat = Math.min(...allLats), maxLat = Math.max(...allLats);
  const minLng = Math.min(...allLngs), maxLng = Math.max(...allLngs);
  const padLat = Math.max(0.005, (maxLat - minLat) * 0.15);
  const padLng = Math.max(0.005, (maxLng - minLng) * 0.15);

  const W = SCREEN_W;
  const H = SCREEN_H;
  const project = (lat: number, lng: number) => ({
    x: ((lng - (minLng - padLng)) / ((maxLng + padLng) - (minLng - padLng))) * W,
    y: H - ((lat - (minLat - padLat)) / ((maxLat + padLat) - (minLat - padLat))) * H,
  });

  const userXY = project(user.lat, user.lng);
  const destXY = destination ? project(destination.lat, destination.lng) : null;

  // Build SVG path strings for each route
  const routePaths = decodedRoutes.map((pts) => {
    if (pts.length < 2) return null;
    return "M " + pts.map((p) => { const xy = project(p.lat, p.lng); return `${xy.x.toFixed(1)} ${xy.y.toFixed(1)}`; }).join(" L ");
  });

  return (
    <View style={StyleSheet.absoluteFill}>
      <Svg width={W} height={H}>
        <Defs>
          <SvgGrad id="bg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#0E1A2D" />
            <Stop offset="1" stopColor="#070D18" />
          </SvgGrad>
        </Defs>
        <Rect x="0" y="0" width={W} height={H} fill="url(#bg)" />

        {/* faint terrain blobs */}
        <Path d={`M -50 ${H * 0.18} Q ${W * 0.35} ${H * 0.08}, ${W * 0.65} ${H * 0.2} T ${W + 50} ${H * 0.24} L ${W + 50} ${H * 0.42} L -50 ${H * 0.4} Z`} fill="#1F3322" opacity={0.5} />
        <Path d={`M -50 ${H * 0.72} Q ${W * 0.4} ${H * 0.62}, ${W * 0.7} ${H * 0.78} T ${W + 50} ${H * 0.85} L ${W + 50} ${H + 50} L -50 ${H + 50} Z`} fill="#162A1A" opacity={0.6} />

        {/* grid */}
        {[...Array(8)].map((_, i) => (
          <Path key={`g${i}`} d={`M 0 ${(i * H) / 8} H ${W}`} stroke="rgba(120,130,140,0.08)" strokeWidth={1} />
        ))}

        {/* Alternate routes (gray, drawn first/below the active one) */}
        {routePaths.map((d, i) => {
          if (!d || i === selectedRouteIndex) return null;
          return (
            <Path
              key={`alt-${i}`}
              d={d}
              stroke="#8E8E93"
              strokeWidth={5}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.7}
              onPress={onSelectRoute ? () => onSelectRoute(i) : undefined}
            />
          );
        })}

        {/* Active "Route Line" — Google Maps blue */}
        {routePaths[selectedRouteIndex] && (
          <G>
            <Path d={routePaths[selectedRouteIndex] as string} stroke="#0A84FF" strokeWidth={9} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.95} />
            <Path d={routePaths[selectedRouteIndex] as string} stroke="#FFFFFF" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 10" opacity={0.5} />
          </G>
        )}

        {/* peers */}
        {peers.map((p) => {
          const xy = project(p.lat, p.lng);
          return (
            <G key={p.user_id}>
              <Circle cx={xy.x} cy={xy.y} r={11} fill={COLORS.success} fillOpacity={0.2} />
              <Circle cx={xy.x} cy={xy.y} r={6} fill={COLORS.success} stroke="#fff" strokeWidth={2} />
              {!!p.carType && (
                <SvgText
                  x={xy.x}
                  y={xy.y + 22}
                  fontSize="10"
                  fontWeight="600"
                  fill="#fff"
                  textAnchor="middle"
                  stroke="rgba(0,0,0,0.65)"
                  strokeWidth="2.5"
                  paintOrder="stroke"
                >
                  {p.carType.length > 22 ? p.carType.slice(0, 20) + "…" : p.carType}
                </SvgText>
              )}
            </G>
          );
        })}

        {/* hazards */}
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

        {/* external (Waze) alerts — slightly smaller diamond shape to distinguish from user reports */}
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

        {/* destination */}
        {destXY && (
          <G>
            <Circle cx={destXY.x} cy={destXY.y} r={14} fill={COLORS.danger} fillOpacity={0.3} />
            <Circle cx={destXY.x} cy={destXY.y} r={9} fill={COLORS.danger} stroke="#fff" strokeWidth={2} />
          </G>
        )}

        {/* user */}
        <G>
          <Circle cx={userXY.x} cy={userXY.y} r={18} fill={COLORS.primary} fillOpacity={0.2} />
          <Circle cx={userXY.x} cy={userXY.y} r={10} fill={COLORS.primary} stroke="#fff" strokeWidth={3} />
        </G>
      </Svg>

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
  youDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: COLORS.primary, alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: "#fff" },
  // Peer marker — car icon + tiny make/model pill underneath
  peerWrap: { alignItems: "center" },
  peerDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: COLORS.success, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(0,0,0,0.4)" },
  carPill: {
    marginTop: 3,
    backgroundColor: "rgba(20,20,24,0.82)",
    borderColor: "rgba(255,255,255,0.20)",
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 8,
    maxWidth: 160,
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 3 },
    }),
  },
  // Pill style for the convoy leader — Convoy yellow background with dark text
  // and a slightly heavier shadow so the leader stays glanceable in any pile-up.
  carPillLeader: {
    backgroundColor: "rgba(255,199,0,0.95)",
    borderColor: "#1a1a1a",
  },
  carPillText: { color: "#fff", fontSize: 10, fontWeight: "600", letterSpacing: 0.2 },
  carPillTextLeader: { color: "#1a1a1a", fontWeight: "700" },
  hazardWrap: { alignItems: "center" },
  hazardBubble: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(255,255,255,0.9)" },
  hazardTail: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 9, borderLeftColor: "transparent", borderRightColor: "transparent", marginTop: -1 },
  // Smaller diamond-bubble for external (Waze-style) alerts so they're visually distinct from user-reported pins
  extWrap: { alignItems: "center" },
  extBubble: {
    width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: "rgba(255,255,255,0.85)",
    transform: [{ rotate: "45deg" }],
  },
  extTail: { width: 0, height: 0, borderLeftWidth: 4, borderRightWidth: 4, borderTopWidth: 6, borderLeftColor: "transparent", borderRightColor: "transparent", marginTop: -1 },
  notice: { position: "absolute", left: 24, right: 24, bottom: 220, alignItems: "center" },
  noticeTitle: { color: COLORS.text, fontSize: 14, fontWeight: "600", marginBottom: 4 },
  noticeText: { color: COLORS.textDim, textAlign: "center", fontSize: 12, lineHeight: 17 },
});
