// Web implementation using @vis.gl/react-google-maps
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { APIProvider, Map, AdvancedMarker, useMap } from "@vis.gl/react-google-maps";
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
const hazardSymbol = (k: string) =>
  k === "police" ? "🛡" : k === "accident" ? "✕" : k === "traffic" ? "🚗" : "⚠";

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
          mapId="convoy-driver-map"
          mapTypeId="hybrid"
          gestureHandling="greedy"
          disableDefaultUI={true}
          zoomControl={true}
          tilt={45}
          colorScheme="DARK"
        >
          {/* User pin */}
          <AdvancedMarker position={user} zIndex={10}>
            <div style={{
              width: 36, height: 36, borderRadius: 18,
              background: COLORS.primary, border: "3px solid #fff",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 0 0 8px rgba(10,132,255,0.25)",
              transform: `rotate(${user.heading || 0}deg)`,
            }}>
              <span style={{ color: "#fff", fontSize: 16, transform: "translateY(-1px)" }}>▲</span>
            </div>
          </AdvancedMarker>

          {/* Peers */}
          {peers.map((p) => (
            <AdvancedMarker key={p.user_id} position={p}>
              <div style={{
                width: 30, height: 30, borderRadius: 15,
                background: COLORS.success, border: "2px solid rgba(0,0,0,0.4)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <span style={{ color: "#fff", fontSize: 14 }}>🚙</span>
              </div>
            </AdvancedMarker>
          ))}

          {/* Hazards (Waze-style) */}
          {hazards.map((h) => (
            <AdvancedMarker key={h.id} position={h} onClick={() => onHazardPress(h)}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", cursor: "pointer" }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 22,
                  background: hazardColor(h.kind),
                  border: "2.5px solid rgba(255,255,255,0.9)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                }}>
                  <span style={{ color: "#fff", fontSize: 20, fontWeight: 700 }}>{hazardSymbol(h.kind)}</span>
                </div>
                <div style={{
                  width: 0, height: 0,
                  borderLeft: "6px solid transparent",
                  borderRight: "6px solid transparent",
                  borderTop: `9px solid ${hazardColor(h.kind)}`,
                  marginTop: -2,
                }} />
              </div>
            </AdvancedMarker>
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
