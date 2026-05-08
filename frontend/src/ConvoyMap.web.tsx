// Web implementation using @vis.gl/react-google-maps (classic Markers, no Map ID required)
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { APIProvider, Map, Marker, useMap } from "@vis.gl/react-google-maps";
import { COLORS } from "./theme";

const KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY as string;

export type Hazard = { id: string; kind: string; lat: number; lng: number; reporter_handle?: string; confirms?: number };
export type Peer = { user_id: string; handle?: string; lat: number; lng: number };

type Props = {
  center: { lat: number; lng: number };
  user: { lat: number; lng: number; heading?: number };
  peers: Peer[];
  hazards: Hazard[];
  onHazardPress: (h: Hazard) => void;
};

const hazardColor = (k: string) =>
  k === "police" ? "#3478F6" : k === "accident" ? "#FF453A" : k === "traffic" ? "#FF9F0A" : "#FF9F0A";

// Build a Waze-style pin SVG as a data URI for the classic Marker icon
function pinIcon(color: string, glyph: string) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='52' height='62' viewBox='0 0 52 62'>
    <defs><filter id='s' x='-50%' y='-50%' width='200%' height='200%'>
      <feDropShadow dx='0' dy='3' stdDeviation='3' flood-opacity='0.5'/></filter></defs>
    <g filter='url(#s)'>
      <circle cx='26' cy='24' r='22' fill='${color}' stroke='white' stroke-width='3'/>
      <polygon points='20,44 32,44 26,58' fill='${color}' stroke='white' stroke-width='2'/>
      <text x='26' y='32' font-family='Arial,sans-serif' font-size='22' font-weight='bold' text-anchor='middle' fill='white'>${glyph}</text>
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

export default function ConvoyMap({ center, user, peers, hazards, onHazardPress }: Props) {
  if (!KEY) {
    return (
      <View style={styles.fb}>
        <Text style={{ color: "#fff" }}>Google Maps key missing</Text>
      </View>
    );
  }
  return (
    <View style={StyleSheet.absoluteFill}>
      <APIProvider apiKey={KEY}>
        <Map
          style={{ width: "100%", height: "100%" }}
          defaultCenter={center}
          defaultZoom={15}
          mapTypeId="hybrid"
          gestureHandling="greedy"
          disableDefaultUI={true}
          zoomControl={true}
        >
          <Marker
            position={user}
            icon={dotIcon(COLORS.primary, "▲", 36)}
            zIndex={1000}
          />
          {peers.map((p) => (
            <Marker
              key={p.user_id}
              position={p}
              icon={dotIcon(COLORS.success, "🚗", 30)}
              title={p.handle || "driver"}
            />
          ))}
          {hazards.map((h) => (
            <Marker
              key={h.id}
              position={h}
              icon={pinIcon(hazardColor(h.kind), HAZARD_GLYPHS[h.kind] || "!")}
              onClick={() => onHazardPress(h)}
              title={`${h.kind} · by ${h.reporter_handle || "anon"}`}
            />
          ))}
          <Recenter target={center} />
        </Map>
      </APIProvider>
    </View>
  );
}

function Recenter({ target }: { target: { lat: number; lng: number } }) {
  const map = useMap();
  React.useEffect(() => {
    if (map && target) map.panTo(target);
  }, [map, target.lat, target.lng]);
  return null;
}

const styles = StyleSheet.create({
  fb: { flex: 1, backgroundColor: "#0A1410", alignItems: "center", justifyContent: "center" },
});
