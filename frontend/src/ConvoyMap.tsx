import React, { useEffect, useRef, forwardRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { NavigationView } from '@googlemaps/react-native-navigation-sdk';

export interface Peer {
  userId: string;
  lat: number;
  lng: number;
  heading: number;
  speed?: number;
  carBody: string;
  carColor?: string;
  user: {
    heading: number;
    carBody: string;
    carColor?: string;
    lat: number;
    lng: number;
    speed?: number;
  };
  onRoute: React.Dispatch<any>;
}

export interface Hazard {
  id: string;
  lat: number;
  lng: number;
  type: string;
  subtype?: string;
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

const ConvoyMap = forwardRef<any, Props>(function ConvoyMap(props, ref) {
  const navViewRef = useRef<any>(null);

  return (
    <View style={styles.container}>
      <NavigationView
        ref={navViewRef}
        style={styles.map}
        androidStylingOptions={{}}
        iOSStylingOptions={{}}
        onMapReady={() => {}}
        onRouteChanged={() => {}}
        onArrival={() => {}}
      />
    </View>
  );
});

export default ConvoyMap;

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
});