// Lightweight pub/sub for voice command results.
// Any screen can subscribe to react to recognized intents.

import { GOOGLE_MAPS_KEY } from "./api";

export type VoiceCommand = {
  text: string;
  intent: string | null;
  query?: string;
  ts: number;
};

type Listener = (cmd: VoiceCommand) => void;
const listeners = new Set<Listener>();

export const voiceBus = {
  emit(cmd: VoiceCommand) {
    listeners.forEach((l) => {
      try { l(cmd); } catch (e) { /* ignore listener errors */ }
    });
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

// Simple Google geocoding helper for "navigate to <place>" voice queries.
// Falls back to Place Find From Text if geocoding doesn't resolve.
export async function geocodeQuery(
  query: string,
  origin?: { lat: number; lng: number },
  nearestFirst = false
): Promise<{ lat: number; lng: number; label: string } | null> {
  const KEY = GOOGLE_MAPS_KEY;
  if (!KEY || !query) return null;

  // 0) Nearest-first (voice "grab a coffee at Starbucks" → the CLOSEST match).
  //    Nearby Search with rankby=distance returns places sorted nearest→far, so
  //    results[0] is the closest one matching the spoken keyword. Only used when
  //    we have the driver's location AND the caller asked for nearest (voice
  //    navigate), so typed address search keeps its exact-match behavior. Falls
  //    through to Find Place / Geocoding below if it returns nothing.
  if (nearestFirst && origin) {
    try {
      const u = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
      u.searchParams.set("keyword", query);
      u.searchParams.set("location", `${origin.lat},${origin.lng}`);
      u.searchParams.set("rankby", "distance");
      u.searchParams.set("key", KEY);
      const res = await fetch(u.toString());
      const data = await res.json();
      if (data.status === "OK" && data.results?.[0]?.geometry?.location) {
        const r = data.results[0];
        return {
          lat: r.geometry.location.lat,
          lng: r.geometry.location.lng,
          label: r.name || r.vicinity || query,
        };
      }
    } catch {}
  }

  // 1) Try Find Place From Text — handles POIs ("nearest gas station") + landmarks
  try {
    const u = new URL("https://maps.googleapis.com/maps/api/place/findplacefromtext/json");
    u.searchParams.set("input", query);
    u.searchParams.set("inputtype", "textquery");
    u.searchParams.set("fields", "geometry,name,formatted_address");
    if (origin) u.searchParams.set("locationbias", `circle:50000@${origin.lat},${origin.lng}`);
    u.searchParams.set("key", KEY);
    const res = await fetch(u.toString());
    const data = await res.json();
    if (data.status === "OK" && data.candidates?.[0]?.geometry?.location) {
      const c = data.candidates[0];
      return {
        lat: c.geometry.location.lat,
        lng: c.geometry.location.lng,
        label: c.name || c.formatted_address || query,
      };
    }
  } catch {}

  // 2) Fallback to plain Geocoding API
  try {
    const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    u.searchParams.set("address", query);
    u.searchParams.set("key", KEY);
    const res = await fetch(u.toString());
    const data = await res.json();
    if (data.status === "OK" && data.results?.[0]) {
      const r = data.results[0];
      return {
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
        label: r.formatted_address || query,
      };
    }
  } catch {}

  return null;
}
