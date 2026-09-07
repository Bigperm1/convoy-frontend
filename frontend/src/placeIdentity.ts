// placeIdentity — WHAT is at the destination, so Scout can arrive by name (2026-09-06).
//
// Jeff: "add to the scout arrival not only the saved locations but also what you can pull up on
// the details on the address that is the end destination … if i enter 100 9420 200 a street
// langley BC what do you know about this location?" Measured with the app's own key: a text
// search on that address only echoes the address back, but a NEARBY search at the geocoded
// point with a 40 m radius returns exactly one business at Unit 100 — International
// Motorsports Motorcycle Company, a store, rating 4.4, open/closed known — and the whole
// complex within 150 m. That nearby call is what this module makes, once per plotted
// destination, cached, so the arrival line can say the name (and the closer can be chosen by
// what the place IS — src/arrivalEndings.ts). The pure parts (candidate pick, speech name) are
// gated by tools/sim-qc/place_identity_test.mts under plain Node; the network part is not.
//
// Cost: one Places Nearby (New) call per plotted destination, Enterprise field mask (open-now +
// editorial summary) ≈ US$0.04. The destination coordinate already goes to Google for search.
import { GOOGLE_MAPS_KEY, api } from "./api";

import {
  type ArrivalPlace, type PlaceCandidate, PLACE_SEARCH_RADIUS_M, pickArrivalPlace, validQuip,
} from "./placeIdentityCore";
export * from "./placeIdentityCore";

const _cache = new Map<string, Promise<ArrivalPlace | null>>();
const cacheKey = (lat: number, lng: number) => `${lat.toFixed(5)},${lng.toFixed(5)}`;

async function nearby(lat: number, lng: number): Promise<PlaceCandidate[]> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_MAPS_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.primaryType,places.types,places.formattedAddress,places.location,places.currentOpeningHours.openNow,places.editorialSummary",
    },
    body: JSON.stringify({
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: PLACE_SEARCH_RADIUS_M } },
      maxResultCount: 10, rankPreference: "DISTANCE",
    }),
  });
  const data: any = await res.json();
  return (data?.places || []).map((p: any) => ({
    placeId: p.id ?? null, name: p.displayName?.text ?? "", primaryType: p.primaryType ?? null,
    types: p.types ?? [], formattedAddress: p.formattedAddress ?? null,
    lat: p.location?.latitude, lng: p.location?.longitude,
    openNow: typeof p.currentOpeningHours?.openNow === "boolean" ? p.currentOpeningHours.openNow : null,
    summary: p.editorialSummary?.text ?? null,
  }));
}

/** Ask the backend for a one-line closer written for THIS place (Claude Haiku, cached server-side). */
async function fetchQuip(place: ArrivalPlace): Promise<string | null> {
  try {
    const { data } = await api.post("/scout/arrival-quip", {
      name: place.name, primaryType: place.primaryType, types: place.types.slice(0, 6), summary: place.summary,
    }, { timeout: 8000 });
    return validQuip(data?.quip);
  } catch { return null; }
}

/**
 * Resolve the business at a destination, once per coordinate (cached for the process). Never
 * throws; null means "nothing to say beyond the label". The generated quip rides on the result
 * when the backend answers in time; the canned type closers cover the rest.
 */
export function resolveDestinationPlace(
  dest: { lat: number; lng: number; label?: string | null },
  opts?: { quip?: boolean },
): Promise<ArrivalPlace | null> {
  const key = cacheKey(dest.lat, dest.lng);
  const hit = _cache.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      const place = pickArrivalPlace(dest, await nearby(dest.lat, dest.lng));
      if (place && opts?.quip !== false) place.quip = await fetchQuip(place);
      return place;
    } catch { return null; }
  })();
  _cache.set(key, p);
  return p;
}
