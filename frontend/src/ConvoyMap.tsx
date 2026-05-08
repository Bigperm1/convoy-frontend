// Native implementation using react-native-maps (works in EAS dev build / production)
import React from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "./theme";

let MapView: any = null;
let Marker: any = null;
try {
  // Lazy require — react-native-maps requires native config that's only present in EAS builds.
  // Falls back to a placeholder gracefully in Expo Go.
  const m = require("react-native-maps");
  MapView = m.default;
  Marker = m.Marker;
} catch {}

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
const hazardIcon = (k: string): any =>
  k === "police" ? "shield-checkmark" : k === "accident" ? "alert-circle" : k === "traffic" ? "car" : "warning";

export default function ConvoyMap({ center, user, peers, hazards, onHazardPress }: Props) {
  if (!MapView) {
    return (
      <View style={styles.fb}>
        <Ionicons name="map" size={48} color={COLORS.primary} />
        <Text style={styles.fbTitle}>Google Maps</Text>
        <Text style={styles.fbText}>
          Native Google Maps requires an EAS development build. Use the web preview to interact with the live map.
        </Text>
      </View>
    );
  }

  const region = {
    latitude: center.lat, longitude: center.lng,
    latitudeDelta: 0.02, longitudeDelta: 0.02,
  };

  return (
    <MapView
      provider="google"
      mapType="hybrid"
      style={StyleSheet.absoluteFill}
      initialRegion={region}
      region={region}
      showsCompass={false}
      showsMyLocationButton={false}
      showsUserLocation={false}
      pitchEnabled={true}
      rotateEnabled={true}
    >
      <Marker coordinate={{ latitude: user.lat, longitude: user.lng }} anchor={{ x: 0.5, y: 0.5 }} zIndex={10}>
        <View style={styles.youDot}>
          <Ionicons name="navigate" size={16} color="#fff" style={{ transform: [{ rotate: `${user.heading || 0}deg` }] }} />
        </View>
      </Marker>

      {peers.map((p) => (
        <Marker key={p.user_id} coordinate={{ latitude: p.lat, longitude: p.lng }} anchor={{ x: 0.5, y: 0.5 }}>
          <View style={styles.peerDot}>
            <Ionicons name="car-sport" size={14} color="#fff" />
          </View>
        </Marker>
      ))}

      {hazards.map((h) => (
        <Marker
          key={h.id}
          coordinate={{ latitude: h.lat, longitude: h.lng }}
          anchor={{ x: 0.5, y: 1 }}
          onPress={() => onHazardPress(h)}
        >
          <View style={styles.hazardWrap}>
            <View style={[styles.hazardBubble, { backgroundColor: hazardColor(h.kind) }]}>
              <Ionicons name={hazardIcon(h.kind)} size={22} color="#fff" />
            </View>
            <View style={[styles.hazardTail, { borderTopColor: hazardColor(h.kind) }]} />
          </View>
        </Marker>
      ))}
    </MapView>
  );
}

const styles = StyleSheet.create({
  fb: { flex: 1, backgroundColor: "#0A1410", alignItems: "center", justifyContent: "center", padding: 32 },
  fbTitle: { color: COLORS.text, fontSize: 22, fontWeight: "700", marginTop: 14, letterSpacing: -0.4 },
  fbText: { color: COLORS.textDim, textAlign: "center", marginTop: 8, fontSize: 13, lineHeight: 19 },
  youDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: COLORS.primary, alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: "#fff" },
  peerDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: COLORS.success, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(0,0,0,0.4)" },
  hazardWrap: { alignItems: "center" },
  hazardBubble: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(255,255,255,0.9)" },
  hazardTail: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 9, borderLeftColor: "transparent", borderRightColor: "transparent", marginTop: -1 },
});
