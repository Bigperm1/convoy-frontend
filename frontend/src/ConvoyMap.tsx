import React, { forwardRef } from "react";
import { View, Image, StyleSheet } from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import { getVehiclePngOrDefault } from "./vehicleAssets";

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

// react-native-maps implementation (Google provider).
// Renders the user's car + every community member's car as top-down PNG markers,
// rotated to heading. The Google Navigation SDK (chase cam) will be wired back in
// later as a selectable map mode; this keeps the app stable and the map working now.
interface ConvoyMapProps {
  center?: { lat: number; lng: number; heading?: number } | null;
  user?: UserLocation | null;
  hideSelfMarker?: boolean;
  peers?: Record<string, Peer> | Peer[] | null;
  onMapReady?: () => void;
  [key: string]: any;
}

const DEFAULT_REGION = {
  latitude: 37.7749,
  longitude: -122.4194,
  latitudeDelta: 0.02,
  longitudeDelta: 0.02,
};

function CarImage({ color, heading }: { color?: string; heading?: number }) {
  return (
    <Image
      source={getVehiclePngOrDefault(color)}
      style={[styles.car, { transform: [{ rotate: (heading || 0) + "deg" }] }]}
      resizeMode="contain"
    />
  );
}

const ConvoyMap = forwardRef<any, ConvoyMapProps>((props, ref) => {
  const { user, peers, hideSelfMarker, center, onMapReady } = props;

  const peerList: Peer[] = Array.isArray(peers)
    ? peers
    : peers
    ? Object.values(peers)
    : [];

  const focusLat =
    (user && typeof user.lat === "number" && user.lat) ||
    (center && center.lat) ||
    DEFAULT_REGION.latitude;
  const focusLng =
    (user && typeof user.lng === "number" && user.lng) ||
    (center && center.lng) ||
    DEFAULT_REGION.longitude;

  const region = {
    latitude: focusLat,
    longitude: focusLng,
    latitudeDelta: 0.02,
    longitudeDelta: 0.02,
  };

  const showSelf =
    !hideSelfMarker &&
    user &&
    typeof user.lat === "number" &&
    typeof user.lng === "number";

  return (
    <View style={styles.container} ref={ref as any}>
      <MapView
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={region}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        onMapReady={() => {
          if (typeof onMapReady === "function") onMapReady();
        }}
      >
        {showSelf ? (
          <Marker
            key="self"
            coordinate={{ latitude: user!.lat as number, longitude: user!.lng as number }}
            anchor={{ x: 0.5, y: 0.5 }}
            flat
          >
            <CarImage color={user!.carColor} heading={user!.heading} />
          </Marker>
        ) : null}

        {peerList.map((p) =>
          p && typeof p.lat === "number" && typeof p.lng === "number" ? (
            <Marker
              key={"peer_" + p.user_id}
              coordinate={{ latitude: p.lat, longitude: p.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              flat
            >
              <CarImage color={p.carColor} heading={p.heading} />
            </Marker>
          ) : null
        )}
      </MapView>
    </View>
  );
});

ConvoyMap.displayName = "ConvoyMap";
export default ConvoyMap;

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  car: { width: 44, height: 44 },
});
