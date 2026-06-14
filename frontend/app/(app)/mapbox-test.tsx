// app/(app)/mapbox-test.tsx — THROWAWAY DEV SCREEN (Mapbox migration, Phase 1).
//
// Bare-minimum Mapbox map to confirm tiles render on the first native build that
// includes @rnmapbox/maps. Reachable via the temporary "Mapbox Test [DEV]" row in
// Settings. Does NOT touch the real map screen; react-native-maps is unaffected.
//
// STRIP BEFORE MERGE: delete this file, the Settings entry, and the
// `<Tabs.Screen name="mapbox-test" .../>` line in app/(app)/_layout.tsx.
//
// The public access token is set globally in src/initMapbox.ts — not set here.
import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import Mapbox, { MapView, Camera } from '@rnmapbox/maps';

export default function MapboxTest() {
  // @rnmapbox/maps is native-only; show a placeholder on web instead of crashing.
  if (Platform.OS === 'web') {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>Mapbox test is native-only.</Text>
      </View>
    );
  }
  return (
    <MapView style={{ flex: 1 }} styleURL={Mapbox.StyleURL.Dark}>
      {/* lng, lat — Surrey BC */}
      <Camera centerCoordinate={[-122.84, 49.18]} zoomLevel={11} />
    </MapView>
  );
}

const styles = StyleSheet.create({
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  fallbackText: { color: '#888', fontSize: 14 },
});
