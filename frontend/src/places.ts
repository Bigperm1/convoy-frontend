// places.ts — Google Places (New) REST helpers, shared by the full-screen
// NavSearchScreen (and available to the inline DestinationSearch bar). The
// legacy /maps/api/place/* endpoints aren't available to projects that enabled
// Places after 1 Mar 2025, so we use Places (New): POST :autocomplete for
// predictions + GET /v1/places/{id} for the resolved location.
import { GOOGLE_MAPS_KEY } from "./api";

export type Suggestion = { place_id: string; description: string };
export type PlaceResult = { lat: number; lng: number; label: string };

const KEY = GOOGLE_MAPS_KEY;

export async function autocompletePlaces(
  input: string,
  origin?: { lat: number; lng: number }
): Promise<Suggestion[]> {
  try {
    const body: any = { input };
    if (origin) {
      body.locationBias = {
        circle: { center: { latitude: origin.lat, longitude: origin.lng }, radius: 50000.0 },
      };
    }
    const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return (data.suggestions || [])
      .filter((s: any) => s.placePrediction)
      .slice(0, 6)
      .map((s: any) => ({
        place_id: s.placePrediction.placeId,
        description: s.placePrediction.text?.text ?? "",
      }));
  } catch {
    return [];
  }
}

export async function placeDetails(place_id: string): Promise<PlaceResult | null> {
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${place_id}`, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": KEY,
        "X-Goog-FieldMask": "location,displayName,formattedAddress",
      },
    });
    const data = await res.json();
    if (!data.location) return null;
    return {
      lat: data.location.latitude,
      lng: data.location.longitude,
      label: data.displayName?.text || data.formattedAddress || "",
    };
  } catch {
    return null;
  }
}
