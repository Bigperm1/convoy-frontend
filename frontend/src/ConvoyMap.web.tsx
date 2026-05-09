// Web implementation using @vis.gl/react-google-maps with Directions support
import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet } from "react-native";
import { APIProvider, Map, Marker, useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import { COLORS } from "./theme";
import type { ExternalAlert, ExternalAlertType } from "./externalFeed";

const KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY as string;

export type Hazard = { id: string; kind: string; lat: number; lng: number; reporter_handle?: string; confirms?: number };
export type Peer = { user_id: string; handle?: string; lat: number; lng: number; carType?: string; carBody?: string; carColor?: string; heading?: number };
export type LatLng = { lat: number; lng: number };

type Props = {
  center: LatLng;
  user: { lat: number; lng: number; heading?: number };
  peers: Peer[];
  leaderUserId?: string | null;
  hazards: Hazard[];
  externalAlerts?: ExternalAlert[];
  highlightConvoy?: boolean;
  destination?: LatLng | null;
  encodedPolyline?: string | null;
  onHazardPress: (h: Hazard) => void;
  onPeerPress?: (p: Peer) => void;
  onExternalAlertPress?: (a: ExternalAlert) => void;
  onRoute?: (info: { distance_text: string; duration_text: string; steps: { html: string; distance_text: string; maneuver?: string }[] } | null) => void;
};

const hazardColor = (k: string) =>
  k === "police" ? "#3478F6" : k === "accident" ? "#FF453A" : k === "traffic" ? "#FF9F0A" : "#FF9F0A";

const extColor = (t: ExternalAlertType) =>
  t === "POLICE" ? "#3478F6"
    : t === "ACCIDENT" ? "#FF453A"
    : t === "JAM" ? "#FF9F0A"
    : t === "HAZARD" ? "#FFD60A"
    : t === "CONSTRUCTION" ? "#FF9500"
    : t === "WEATHER" ? "#5AC8FA"
    : "#8E8E93";
const EXT_GLYPHS: Record<ExternalAlertType, string> = {
  POLICE: "🚨", ACCIDENT: "⚠", JAM: "▼", HAZARD: "!",
  CONSTRUCTION: "⚒", WEATHER: "☁", OTHER: "•",
};

function pinIcon(color: string, glyph: string) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='52' height='62' viewBox='0 0 52 62'>
    <defs><filter id='s' x='-50%' y='-50%' width='200%' height='200%'><feDropShadow dx='0' dy='3' stdDeviation='3' flood-opacity='0.5'/></filter></defs>
    <g filter='url(#s)'>
      <circle cx='26' cy='24' r='22' fill='${color}' stroke='white' stroke-width='3'/>
      <polygon points='20,44 32,44 26,58' fill='${color}' stroke='white' stroke-width='2'/>
      <text x='26' y='32' font-family='Arial,sans-serif' font-size='22' font-weight='bold' text-anchor='middle' fill='white'>${glyph}</text>
    </g></svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}
// Smaller diamond pin for external (Waze-feed) alerts to differentiate from user-reported hazards
function diamondIcon(color: string, glyph: string) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='38' height='44' viewBox='0 0 38 44'>
    <defs><filter id='ds' x='-50%' y='-50%' width='200%' height='200%'><feDropShadow dx='0' dy='2' stdDeviation='2' flood-opacity='0.45'/></filter></defs>
    <g filter='url(#ds)'>
      <polygon points='19,2 36,18 19,34 2,18' fill='${color}' stroke='white' stroke-width='2.5'/>
      <polygon points='15,34 23,34 19,42' fill='${color}' stroke='white' stroke-width='1.5'/>
      <text x='19' y='23' font-family='Arial,sans-serif' font-size='14' font-weight='bold' text-anchor='middle' fill='white'>${glyph}</text>
    </g></svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}
function dotIcon(color: string, glyph: string, size = 32) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'>
    <circle cx='${size / 2}' cy='${size / 2}' r='${size / 2 - 2}' fill='${color}' stroke='white' stroke-width='2'/>
    <text x='${size / 2}' y='${size / 2 + 5}' font-family='Arial' font-size='14' font-weight='bold' text-anchor='middle' fill='white'>${glyph}</text>
  </svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}

// Top-down car icon for peers — colored by their car_color and rotated to match
// the heading from expo-location. Mirrors the path data in `src/CarMarker.tsx`
// so the look is identical on web and native.
const CAR_BODY_PATHS_WEB: Record<string, string> = {
  sedan:      "M50 10 L70 24 L72 78 L66 92 L34 92 L28 78 L30 24 Z",
  coupe:      "M50 10 L70 24 L74 60 L70 84 L58 92 L42 92 L30 84 L26 60 L30 24 Z",
  sports:     "M50 8 L74 26 L78 64 L72 86 L60 92 L40 92 L28 86 L22 64 L26 26 Z",
  suv:        "M50 8 L72 22 L74 78 L70 92 L30 92 L26 78 L28 22 Z",
  truck:      "M50 8 L70 18 L72 44 L74 92 L26 92 L28 44 L30 18 Z",
  // Aggressive hot-hatch: pointed nose, pronounced front + rear fender flares,
  // mid-body waist, squared-off rear deck. Spoiler is layered separately below.
  hatch:      "M50 6 L60 12 L78 24 L80 32 L72 50 L80 68 L82 80 L78 90 L22 90 L18 80 L20 68 L28 50 L20 32 L22 24 L40 12 Z",
  van:        "M50 10 L74 22 L76 90 L70 94 L30 94 L24 90 L26 22 Z",
  motorcycle: "M50 10 L60 30 L62 70 L56 90 L44 90 L38 70 L40 30 Z",
};
// Optional rear-wing/spoiler overlay drawn AFTER the body. Only the hot-hatch
// gets one (per design — wide rear wing + endplates).
const CAR_SPOILER_PATHS_WEB: Record<string, string | undefined> = {
  hatch: "M14 84 L86 84 L88 92 L12 92 Z M12 80 L18 80 L18 92 L12 92 Z M82 80 L88 80 L88 92 L82 92 Z",
};
const CAR_WINDSHIELD_WEB: Record<string, string> = {
  motorcycle: "M44 30 L56 30 L56 42 L44 42 Z",
  truck:      "M36 22 L64 22 L66 38 L34 38 Z",
  van:        "M34 22 L66 22 L66 36 L34 36 Z",
};
const DEFAULT_WINDSHIELD_WEB = "M38 26 L62 26 L65 44 L35 44 Z";

function resolveCarColorWeb(input?: string | null): string {
  if (!input) return "#0A84FF";
  const t = String(input).trim();
  if (!t) return "#0A84FF";
  if (t.startsWith("#") || t.startsWith("rgb")) return t;
  // Tiny inline lookup for the named palette used in Garage. Keep this in sync
  // with CAR_COLORS in src/CarMarker.tsx — duplicated to avoid web/native cross-import issues.
  const named: Record<string, string> = {
    "bayside blue": "#0A84FF", "nardo gray": "#8E8E93", "guards red": "#FF453A",
    "yellow": "#FFD60A", "pearl white": "#F2F2F7", "jet black": "#1A1A1A",
    "forest green": "#30D158", "dawn orange": "#FF9F0A", "plum purple": "#BF5AF2",
    "carbon": "#3A3A3C", "midnight silver": "#AEAEB2", "cyber brown": "#A2845E",
  };
  return named[t.toLowerCase()] || "#0A84FF";
}

function carIconDataUrl(body: string | undefined | null, color: string | undefined | null, heading: number | undefined | null, size = 44): string {
  const fill = resolveCarColorWeb(color);
  const safeBody = body && CAR_BODY_PATHS_WEB[body] ? body : "sedan";
  const path = CAR_BODY_PATHS_WEB[safeBody];
  const wind = CAR_WINDSHIELD_WEB[safeBody] || DEFAULT_WINDSHIELD_WEB;
  const spoiler = CAR_SPOILER_PATHS_WEB[safeBody];
  const angle = Number.isFinite(heading as number) ? Math.round((heading as number) % 360) : 0;
  const spoilerEls = spoiler
    ? `<path d='${spoiler}' fill='rgba(0,0,0,0.55)' transform='translate(0 1)'/>
       <path d='${spoiler}' fill='url(#g)' stroke='white' stroke-width='1.5' stroke-linejoin='round'/>`
    : "";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 100 100'>
    <defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0' stop-color='${fill}' stop-opacity='1'/><stop offset='1' stop-color='${fill}' stop-opacity='0.78'/>
    </linearGradient></defs>
    <g transform='rotate(${angle} 50 50)'>
      <path d='${path}' fill='rgba(0,0,0,0.45)' transform='translate(0 2)'/>
      <path d='${path}' fill='url(#g)' stroke='white' stroke-width='2' stroke-linejoin='round'/>
      ${spoilerEls}
      <path d='${wind}' fill='rgba(255,255,255,0.55)'/>
      <rect x='48' y='50' width='4' height='26' rx='1' fill='rgba(0,0,0,0.18)'/>
    </g></svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}
// Peer pin with car make/model pill underneath. Width adapts to label length.
function peerPinWithLabel(color: string, label: string) {
  // sanitize for SVG embed
  const txt = (label || "").replace(/[<>&"']/g, "").slice(0, 28);
  const charW = 6;     // approx px per char @ 11pt
  const padX = 10;
  const pillW = Math.max(36, txt.length * charW + padX * 2);
  const W = Math.max(40, pillW + 6);
  const H = 60;
  const dotR = 14;
  const pillH = 18;
  const pillY = 36;
  const pillX = (W - pillW) / 2;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}'>
    <defs><filter id='ps' x='-50%' y='-50%' width='200%' height='200%'><feDropShadow dx='0' dy='2' stdDeviation='2' flood-opacity='0.45'/></filter></defs>
    <g filter='url(#ps)'>
      <circle cx='${W / 2}' cy='${dotR + 2}' r='${dotR}' fill='${color}' stroke='white' stroke-width='2'/>
      <text x='${W / 2}' y='${dotR + 6}' font-family='Arial' font-size='14' font-weight='bold' text-anchor='middle' fill='white'>🚗</text>
      ${txt ? `<rect x='${pillX}' y='${pillY}' width='${pillW}' height='${pillH}' rx='6' ry='6' fill='rgba(20,20,24,0.85)' stroke='rgba(255,255,255,0.25)' stroke-width='1'/>
      <text x='${W / 2}' y='${pillY + 12}' font-family='Arial' font-size='10' font-weight='600' text-anchor='middle' fill='white'>${txt}</text>` : ''}
    </g></svg>`;
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    size: { width: W, height: H } as any,
    anchorY: dotR + 2, // anchor at the dot center
  };
}
const HAZARD_GLYPHS: Record<string, string> = { police: "🛡", accident: "✕", road: "!", traffic: "▲" };

// Build a community pin with optional gold border (Convoy users)
function communityPin(color: string, glyph: string, gold: boolean) {
  const ringStroke = gold ? `<circle cx='26' cy='24' r='25' fill='none' stroke='#FFD60A' stroke-width='3'/>` : "";
  const innerBorder = gold ? "#FFD60A" : "white";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='56' height='66' viewBox='-2 -2 56 66'>
    <defs><filter id='cs' x='-50%' y='-50%' width='200%' height='200%'><feDropShadow dx='0' dy='3' stdDeviation='3' flood-opacity='0.55'/></filter></defs>
    <g filter='url(#cs)'>
      ${ringStroke}
      <circle cx='26' cy='24' r='22' fill='${color}' stroke='${innerBorder}' stroke-width='3'/>
      <polygon points='20,44 32,44 26,58' fill='${color}' stroke='${innerBorder}' stroke-width='2'/>
      <text x='26' y='32' font-family='Arial,sans-serif' font-size='22' font-weight='bold' text-anchor='middle' fill='white'>${glyph}</text>
    </g></svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}

export default function ConvoyMap({ center, user, peers, leaderUserId, hazards, externalAlerts = [], highlightConvoy = true, destination, encodedPolyline, routes = [], selectedRouteIndex = 0, onSelectRoute, followUser = false, onHazardPress, onPeerPress, onExternalAlertPress, onRoute }: Props) {
  if (!KEY) return <View style={styles.fb}><Text style={{ color: "#fff" }}>Google Maps key missing</Text></View>;
  return (
    <View style={StyleSheet.absoluteFill}>
      <APIProvider apiKey={KEY} libraries={["places", "routes", "geometry"]}>
        <Map
          style={{ width: "100%", height: "100%" }}
          defaultCenter={center}
          defaultZoom={followUser ? 17 : 15}
          mapTypeId="hybrid"
          gestureHandling="greedy"
          disableDefaultUI={true}
          zoomControl={true}
        >
          <Marker position={user} icon={dotIcon(COLORS.primary, "▲", 36)} zIndex={1000} />
          {peers.map((p) => {
            const isLeader = !!leaderUserId && p.user_id === leaderUserId;
            // Leader marker is slightly larger AND given a high zIndex so it
            // floats above teammates whenever the convoy stacks up at a stop.
            const sz = isLeader ? 56 : 44;
            const url = carIconDataUrl(p.carBody, p.carColor, p.heading, sz);
            return (
              <Marker
                key={p.user_id}
                position={p}
                icon={{
                  url,
                  scaledSize: { width: sz, height: sz } as any,
                  size: { width: sz, height: sz } as any,
                  anchor: { x: sz / 2, y: sz / 2 } as any,
                } as any}
                title={`${isLeader ? "★ " : ""}${p.handle || "driver"}${p.carType ? " · " + p.carType : ""}`}
                zIndex={isLeader ? 1000 : 1}
                onClick={() => onPeerPress?.(p)}
              />
            );
          })}
          {hazards.map((h) => (
            <Marker key={`u-${h.id}`} position={h} icon={communityPin(hazardColor(h.kind), HAZARD_GLYPHS[h.kind] || "!", highlightConvoy)} onClick={() => onHazardPress(h)} title={`${h.kind} · by ${h.reporter_handle || "anon"}${highlightConvoy ? " · CONVOY" : ""}`} />
          ))}
          {externalAlerts.map((a) => (
            <Marker
              key={`x-${a.id}`}
              position={{ lat: a.lat, lng: a.lng }}
              icon={diamondIcon(extColor(a.type), EXT_GLYPHS[a.type] || "•")}
              onClick={() => onExternalAlertPress?.(a)}
              title={`${a.type}${a.subtype ? " · " + a.subtype : ""} (live feed)`}
              zIndex={500}
            />
          ))}
          {destination && (
            <Marker position={destination} icon={dotIcon("#FF453A", "★", 34)} title="Destination" />
          )}
          {/* Multi-route layer: gray alternates + blue selected, all from pre-decoded polylines */}
          {destination && routes.length > 0 && (
            <RoutesLayer routes={routes} selectedIndex={selectedRouteIndex} onSelect={onSelectRoute} />
          )}
          {/* Legacy fallback when no routes[] given */}
          {destination && routes.length === 0 && (
            <Directions origin={user} destination={destination} onRoute={onRoute} encodedPolyline={encodedPolyline} />
          )}
          <Recenter target={followUser ? user : center} />
        </Map>
      </APIProvider>
    </View>
  );
}

// Renders pre-decoded route polylines as native google.maps.Polyline objects.
// Alternates are rendered first (gray, lower zIndex) so the selected route (blue) sits on top.
function RoutesLayer({ routes, selectedIndex, onSelect }: {
  routes: { polyline: string }[];
  selectedIndex: number;
  onSelect?: (index: number) => void;
}) {
  const map = useMap();
  const polysRef = useRef<any[]>([]);

  useEffect(() => {
    if (!map || !(window as any).google?.maps) return;
    const G = (window as any).google.maps;

    // Tear down previous polylines
    polysRef.current.forEach((pl) => pl.setMap(null));
    polysRef.current = [];

    routes.forEach((r, i) => {
      const path = G.geometry.encoding.decodePath(r.polyline);
      const isSelected = i === selectedIndex;
      const pl = new G.Polyline({
        path,
        map,
        strokeColor: isSelected ? "#0A84FF" : "#8E8E93",
        strokeOpacity: isSelected ? 0.95 : 0.7,
        strokeWeight: isSelected ? 6 : 4,
        zIndex: isSelected ? 500 : 100,
        clickable: true,
      });
      pl.addListener("click", () => onSelect?.(i));
      polysRef.current.push(pl);
    });

    return () => { polysRef.current.forEach((pl) => pl.setMap(null)); polysRef.current = []; };
  }, [map, routes, selectedIndex, onSelect]);

  return null;
}

function Directions({ origin, destination, onRoute, encodedPolyline }: { origin: LatLng; destination: LatLng; onRoute?: Props["onRoute"]; encodedPolyline?: string | null }) {
  const map = useMap();
  const routesLib = useMapsLibrary("routes");
  const renderer = useRef<any>(null);
  const service = useRef<any>(null);

  useEffect(() => {
    if (!map || !routesLib) return;
    if (!service.current) service.current = new routesLib.DirectionsService();
    if (!renderer.current) {
      renderer.current = new routesLib.DirectionsRenderer({
        map,
        suppressMarkers: true,
        polylineOptions: { strokeColor: "#0A84FF", strokeOpacity: 0.95, strokeWeight: 6 },
      });
    } else {
      renderer.current.setMap(map);
    }
    service.current.route(
      {
        origin,
        destination,
        travelMode: "DRIVING",
        provideRouteAlternatives: false,
      },
      (res: any, status: string) => {
        if (status !== "OK" || !res) {
          if (onRoute) onRoute(null);
          return;
        }
        renderer.current.setDirections(res);
        const leg = res.routes[0]?.legs[0];
        if (leg && onRoute) {
          onRoute({
            distance_text: leg.distance?.text || "",
            duration_text: leg.duration?.text || "",
            steps: (leg.steps || []).map((s: any) => ({
              html: (s.instructions || "").replace(/<[^>]+>/g, ""),
              distance_text: s.distance?.text || "",
              maneuver: s.maneuver,
            })),
          });
        }
      }
    );
    return () => { if (renderer.current) renderer.current.setMap(null); };
  }, [map, routesLib, origin.lat, origin.lng, destination.lat, destination.lng]);

  return null;
}

function Recenter({ target }: { target: LatLng }) {
  const map = useMap();
  useEffect(() => { if (map && target) map.panTo(target); }, [map, target.lat, target.lng]);
  return null;
}

const styles = StyleSheet.create({ fb: { flex: 1, backgroundColor: "#0A1410", alignItems: "center", justifyContent: "center" } });
