import React, { forwardRef } from "react";
import { View, Text, StyleSheet } from "react-native";

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

// TEMPORARY SAFE PLACEHOLDER.
// The Google Navigation SDK (@googlemaps/react-native-navigation-sdk) requires a
// config plugin + native init (Terms/init) that are not yet wired in this build.
// Mounting <NavigationView> on launch was hard-crashing the app the moment the map
// screen rendered. Until the SDK is properly configured (or we switch to
// react-native-maps), this component renders a non-native placeholder so the rest of
// the app (login, comms, music, garage) is fully usable. All props/exports are kept
// so map.tsx continues to compile and pass data unchanged.
interface ConvoyMapProps {
  center?: { lat: number; lng: number; heading?: number } | null;
  user?: UserLocation | null;
  hideSelfMarker?: boolean;
  peers?: Record<string, Peer> | Peer[] | null;
  onMapReady?: () => void;
  [key: string]: any;
}

const ConvoyMap = forwardRef<any, ConvoyMapProps>((props, ref) => {
  const { peers } = props;
  const peerCount = Array.isArray(peers)
    ? peers.length
    : peers
    ? Object.keys(peers).length
    : 0;

  return (
    <View style={styles.container} ref={ref as any}>
      <View style={styles.center}>
        <Text style={styles.title}>Map</Text>
        <Text style={styles.sub}>Live map is being set up.</Text>
        {peerCount > 0 ? (
          <Text style={styles.sub}>{peerCount} nearby in your convoy</Text>
        ) : null}
      </View>
    </View>
  );
});

ConvoyMap.displayName = "ConvoyMap";
export default ConvoyMap;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0d0d0f" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { color: "#FFD60A", fontSize: 22, fontWeight: "800", marginBottom: 8 },
  sub: { color: "#98989F", fontSize: 14, marginTop: 2, textAlign: "center" },
});
