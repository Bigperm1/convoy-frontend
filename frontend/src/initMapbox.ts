// initMapbox.ts — set the Mapbox PUBLIC access token once at app startup, before
// any MapView renders. Imported for its side effect at the top of
// app/_layout.tsx.
//
// The public token (pk.*) is safe to ship in the client — it is NOT the secret
// download token (sk.*) used to fetch the native SDK at build time.
//
// Guarded in try/catch: until a native build actually includes @rnmapbox/maps,
// the native module may be absent at runtime, so failing soft here keeps the app
// from crashing on this JS-only migration branch before the first Mapbox build.
import Mapbox from '@rnmapbox/maps';

try {
  Mapbox.setAccessToken(
    'pk.eyJ1IjoiY29udm95LWRyaXZldG9nZXRoZXIiLCJhIjoiY21xY3d4c2NwMHd4ejJycHI1dmMyaHBkdSJ9.GRbIfYU5BUoA_-Uo9sQhqA'
  );
} catch (e) {
  console.warn('[initMapbox] setAccessToken failed (native module not present yet?)', e);
}
