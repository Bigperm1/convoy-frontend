import React, { forwardRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { NavigationView } from '@googlemaps/react-native-navigation-sdk';

export interface Peer {
  user_id?: string;
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

interface Props {
  center?: { lat: number; lng: number; heading?: number; speed?: number };
  user?: Peer;
  peers?: Peer[];
  hazards?: Hazard[];
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