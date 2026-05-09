// Web implementation using @vis.gl/react-google-maps with Directions support
import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet } from "react-native";
import { APIProvider, Map, Marker, useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import { COLORS } from "./theme";
import type { ExternalAlert, ExternalAlertType } from "./externalFeed";

const KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY as string;

export type Hazard = { id: string; kind: string; lat: number; lng: number; reporter_handle?: string; confirms?: number };
export type Peer = { user_id: string; handle?: string; lat: number; lng: number };
export type LatLng = { lat: number; lng: number };

type Props = {
  center: LatLng;
  user: { lat: number; lng: number; heading?: number };
  peers: Peer[];
  hazards: Hazard[];
  externalAlerts?: ExternalAlert[];
  destination?: LatLng | null;
  encodedPolyline?: string | null;
  onHazardPress: (h: Hazard) => void;
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
const HAZARD_GLYPHS: Record<string, string> = { police: "🛡", accident: "✕", road: "!", traffic: "▲" };

export default function ConvoyMap({ center, user, peers, hazards, externalAlerts = [], destination, encodedPolyline, onHazardPress, onExternalAlertPress, onRoute }: Props) {
  if (!KEY) return <View style={styles.fb}><Text style={{ color: "#fff" }}>Google Maps key missing</Text></View>;
  return (
    <View style={StyleSheet.absoluteFill}>
      <APIProvider apiKey={KEY} libraries={["places", "routes"]}>
        <Map
          style={{ width: "100%", height: "100%" }}
          defaultCenter={center}
          defaultZoom={15}
          mapTypeId="hybrid"
          gestureHandling="greedy"
          disableDefaultUI={true}
          zoomControl={true}
        >
          <Marker position={user} icon={dotIcon(COLORS.primary, "▲", 36)} zIndex={1000} />
          {peers.map((p) => (
            <Marker key={p.user_id} position={p} icon={dotIcon(COLORS.success, "🚗", 30)} title={p.handle || "driver"} />
          ))}
          {hazards.map((h) => (
            <Marker key={`u-${h.id}`} position={h} icon={pinIcon(hazardColor(h.kind), HAZARD_GLYPHS[h.kind] || "!")} onClick={() => onHazardPress(h)} title={`${h.kind} · by ${h.reporter_handle || "anon"}`} />
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
          {destination && <Directions origin={user} destination={destination} onRoute={onRoute} encodedPolyline={encodedPolyline} />}
          <Recenter target={center} />
        </Map>
      </APIProvider>
    </View>
  );
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
