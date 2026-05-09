// Lightweight pub/sub for voice command results.
// Any screen can subscribe to react to recognized intents.

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
  origin?: { lat: number; lng: number }
): Promise<{ lat: number; lng: number; label: string } | null> {
  const KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY as string;
  if (!KEY || !query) return null;

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
