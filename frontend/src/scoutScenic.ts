// scoutScenic.ts — ask Scout which roads are worth driving, then resolve them to
// real places.
//
// This is the one part of route planning where a language model genuinely earns its
// place. Ordering stops and choosing between two lines is exact maths and lives in
// routeOptimizer.ts / the Directions API. But knowing that the Sea-to-Sky, the Fraser
// Canyon or Chilliwack Lake Road are good DRIVES is world knowledge that no routing API
// holds and no amount of geometry recovers.
//
// ⚠ THE MODEL NEVER RETURNS COORDINATES — it returns searchable NAMES, and we geocode
// them here. That is deliberate and it is the safety property of the whole feature: a
// model asked for lat/lng will happily produce plausible numbers for a place that does
// not exist, and an unverifiable waypoint would send a convoy down a road that isn't
// there. A name either resolves through a real geocoder or it is dropped.
//
// Fails soft in every direction. The backend endpoint may not be deployed yet, the key
// may be missing, a suggestion may not geocode — in all cases the caller gets a shorter
// list (or none) and the planner simply doesn't offer suggestions.
import { api } from "./api";
import { autocompletePlaces, placeDetails } from "./places";

export type ScoutStop = { lat: number; lng: number; label: string; why?: string };

export async function scoutScenicStops(opts: {
  origin: { lat: number; lng: number; label?: string };
  dest?: { lat: number; lng: number; label?: string } | null;
  hours?: number;
  note?: string;
  maxStops?: number;
}): Promise<{ stops: ScoutStop[]; unavailable: boolean }> {
  let suggestions: Array<{ name: string; why?: string }> = [];
  try {
    const { data } = await api.post("/routes/scenic-suggest", {
      origin_lat: opts.origin.lat,
      origin_lng: opts.origin.lng,
      origin_label: opts.origin.label || undefined,
      dest_lat: opts.dest?.lat,
      dest_lng: opts.dest?.lng,
      dest_label: opts.dest?.label || undefined,
      hours: opts.hours,
      note: opts.note,
      max_stops: opts.maxStops ?? 3,
    });
    suggestions = Array.isArray(data?.places) ? data.places : [];
    // An empty list with source "none" means the server could not ask (no key, or the
    // endpoint is deployed but unconfigured) — distinct from "nothing to suggest".
    if (!suggestions.length && data?.source === "none") return { stops: [], unavailable: true };
  } catch {
    // 404 = this build is pointed at a backend without the endpoint yet.
    return { stops: [], unavailable: true };
  }

  // Resolve each NAME through the same place search the rest of the app uses. A
  // suggestion that does not resolve is silently dropped — better a shorter list than
  // a pin nobody can verify.
  const out: ScoutStop[] = [];
  for (const s of suggestions) {
    const name = (s?.name || "").trim();
    if (!name) continue;
    try {
      const sugs = await autocompletePlaces(name, opts.origin);   // bias to the driver's region
      const first = sugs?.[0];
      if (!first) continue;
      const p = await placeDetails(first.place_id);
      if (!p || typeof p.lat !== "number" || typeof p.lng !== "number") continue;
      out.push({ lat: p.lat, lng: p.lng, label: p.label || name, why: s.why });
    } catch {
      // keep going — one bad suggestion must not lose the others
    }
  }
  return { stops: out, unavailable: false };
}
