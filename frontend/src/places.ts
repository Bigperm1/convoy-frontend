// places.ts — Google Places (New) REST helpers, shared by the full-screen
// NavSearchScreen (and available to the inline DestinationSearch bar). The
// legacy /maps/api/place/* endpoints aren't available to projects that enabled
// Places after 1 Mar 2025, so we use Places (New): POST :autocomplete for
// predictions + GET /v1/places/{id} for the resolved location.
//
// BILLING (Jeff, 2026-09-24: "go on 1,2 and 4" — cost fix #4 of the 09-17 unit-economics
// research). What Google's session-pricing page ACTUALLY says — the research's "session
// tokens save ~$17/mo" and my first cut of this file both had it wrong; Codex caught it:
//   * Place Details is billed by the priciest field in its mask. `displayName` is a Pro
//     field ($17/1000, 5k free a month); `location` + `formattedAddress` are Essentials
//     ($5/1000, 10k free). So the pick's label now comes from the autocomplete prediction's
//     `structuredFormat.mainText` — the same "Tim Hortons" that displayName returned, already
//     in the response we paid for — and Details asks for Essentials fields only.
//   * A `sessionToken` shared by a search's autocompletes and its Details: when the Details
//     is Essentials, autocompletes 1–12 still bill per request ($2.83/1000, 10k free) and 13+
//     are free. When the Details asks for ANY Pro/Enterprise field, the autocompletes are free
//     but the Details is billed as Enterprise + Atmosphere ($25/1000, 1k free) regardless of
//     the fields — which is why the mask must stay Essentials.
//   * Never reuse a token after its Details call: Google then bills the whole session as
//     token-less. A search that never reaches Details bills per request, exactly as before.
// Verified live 2026-09-24 (curl, production key, status codes only): body `sessionToken`
// → 200 with `structuredFormat.mainText` present; `?sessionToken=` on Details → 200.
import { GOOGLE_MAPS_KEY } from "./api";

/** `main` is the prediction's primary line ("Tim Hortons", "123 Main St") — the free label. */
export type Suggestion = { place_id: string; description: string; main?: string };
export type PlaceResult = { lat: number; lng: number; label: string };
/** One autocomplete → Place Details search, for billing. Make one with newPlacesSession(),
 *  pass it to every autocompletePlaces() of that search and to the placeDetails() that ends
 *  it, then drop it. */
export type PlacesSession = { token: string };

const KEY = GOOGLE_MAPS_KEY;

// URL- and filename-safe base64 alphabet: what Google accepts for a session token.
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function newPlacesSession(): PlacesSession {
  let token = "";
  for (let i = 0; i < 32; i++) token += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
  return { token };
}

export async function autocompletePlaces(
  input: string,
  origin?: { lat: number; lng: number },
  session?: PlacesSession | null
): Promise<Suggestion[]> {
  try {
    const body: any = { input };
    if (origin) {
      body.locationBias = {
        circle: { center: { latitude: origin.lat, longitude: origin.lng }, radius: 50000.0 },
      };
    }
    if (session?.token) body.sessionToken = session.token;
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
        main: s.placePrediction.structuredFormat?.mainText?.text || undefined,
      }));
  } catch {
    return [];
  }
}

/** Resolve a prediction to coordinates. `labelHint` is the prediction's `main` (or its
 *  description) — it becomes the label so Details never has to ask for the Pro-tier
 *  `displayName`; the Essentials `formattedAddress` is the fallback. */
export async function placeDetails(
  place_id: string,
  session?: PlacesSession | null,
  labelHint?: string
): Promise<PlaceResult | null> {
  try {
    const qs = session?.token ? `?sessionToken=${encodeURIComponent(session.token)}` : "";
    const res = await fetch(`https://places.googleapis.com/v1/places/${place_id}${qs}`, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": KEY,
        // Essentials fields ONLY — see the billing note at the top of this file.
        "X-Goog-FieldMask": "location,formattedAddress",
      },
    });
    const data = await res.json();
    if (!data.location) return null;
    return {
      lat: data.location.latitude,
      lng: data.location.longitude,
      label: labelHint || data.formattedAddress || "",
    };
  } catch {
    return null;
  }
}
