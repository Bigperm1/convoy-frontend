import React, { forwardRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { NavigationView } from '@googlemaps/react-native-navigation-sdk';

// Used for remote peers on the map
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

// Used for hazard markers
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

// Used for the local user's own position (no user_id needed)
export interface UserLocation {
  heading?: number;
  carBody?: string;
  carColor?: string;
  lat?: number;
  lng?: number;
  speed?: number;
}

interface Props {
  center?: { lat: number; lng: number; heading?: number; speed?: number };
  user?: UserLocation;
  peers?: Peer[];
  hazards?: Hazard[];
  hideSelfMarker?: boolean;
  mapView?: string;
  mapType?: string;
  onHazardPress?: (h: Hazard) => void;
  onPeerPress?: (p: Peer) => void;
  onExternalAlertPress?: (a: any) => void;
}

const ConvoyMap = forwardRef<any, Props>(function ConvoyMap(_props, _ref) {
  return (
    <View style={styles.container}>
      <NavigationView
        style={styles.map}
        androidStylingOptions={{}}
        iOSStylingOptions={{}}
        onMapReady={() => {}}
      />
    </View>
  );
});

export default ConvoyMap;

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
});