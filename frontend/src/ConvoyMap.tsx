import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, SafeAreaView } from 'react-native';
import { GoogleMapsView } from '@googlemaps/react-native-navigation-sdk';

export default function ConvoyMap() {
  const mapRef = useRef(null);

  useEffect(() => {
    // Map initialization
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <GoogleMapsView
        ref={mapRef}
        style={styles.map}
        initialCamera={{
          bearing: 0,
          target: {
            latitude: 37.78,
            longitude: -122.41,
          },
          tilt: 0,
          zoom: 12,
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  map: { flex: 1 },
});