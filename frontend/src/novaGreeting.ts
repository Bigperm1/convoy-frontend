// novaGreeting.ts — the personable, OpenAI-generated route-start greeting.
//
// Assembles the structured drive context the app already has (call sign, time
// of day, destination + saved-place label, traffic, arrival weather), asks the
// backend (POST /api/nova/greeting -> gpt-4o-mini) to turn it into ONE natural
// spoken line, then speaks it through the nav speech queue so it ALWAYS leads
// the first turn callout (reserveGreeting/deliverGreeting/cancelGreeting).
//
// Self-contained and best-effort: any failure (offline, backend down) simply
// means no greeting — it never throws into the caller. map.tsx just calls
// speakRouteGreeting(...) once when a drive begins. The reservation is taken
// SYNCHRONOUSLY on entry so the engine's "Starting navigation…" line is parked
// behind the greeting even when nav starts in the same tick.

import { api } from "./api";
import { reserveGreeting, deliverGreeting, cancelGreeting } from "./nav";
import type { NavRoute } from "./nav";
import { getSettings } from "./settings";
import { matchSavedPlace } from "./savedPlaces";
import type { WeatherKind } from "./weatherLayer";

export type TimeOfDay = "morning" | "afternoon" | "evening" | "night";

export function timeOfDay(d: Date = new Date()): TimeOfDay {
  const h = d.getHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

// Gauge congestion from the traffic-aware ETA vs the free-flow baseline. The
// Routes API request is TRAFFIC_AWARE, so duration_s already reflects current
// traffic; freeflow_s is the no-traffic time. Ratio buckets -> a word the
// greeting can use. Returns undefined when we don't have both numbers.
function trafficLevel(route?: NavRoute | null): "none" | "light" | "moderate" | "heavy" | undefined {
  if (!route) return undefined;
  const traffic = route.duration_s;
  const free = route.freeflow_s;
  if (!free || free <= 0 || !traffic) return undefined;
  const ratio = traffic / free;
  if (ratio < 1.12) return "none";
  if (ratio < 1.28) return "light";
  if (ratio < 1.55) return "moderate";
  return "heavy";
}

// Map the map's WeatherKind to a plain spoken word ("raining", "clear", ...).
function weatherWord(kind?: WeatherKind | null): string | undefined {
  if (!kind) return undefined;
  switch (kind) {
    case "clear-day":
    case "clear-night":
      return "clear";
    case "partly-day":
    case "partly-night":
      return "partly cloudy";
    case "cloudy":
      return "cloudy";
    case "fog":
      return "foggy";
    case "rain":
      return "raining";
    case "snow":
      return "snowing";
    case "thunder":
      return "thunderstorms";
    default:
      return undefined;
  }
}

export type GreetingContext = {
  // Destination coordinate — used to recognize a saved place (Home/Work).
  destination?: { lat: number; lng: number } | null;
  // Fallback name when the destination isn't a saved place (search label / city).
  destinationName?: string | null;
  // City/area for the weather clause ("...raining in Langley").
  destinationCity?: string | null;
  // The selected route (for the traffic read).
  route?: NavRoute | null;
  // Arrival weather already fetched for the destination chip.
  weatherKind?: WeatherKind | null;
  temperature?: string | null;
};

// Build the facts, ask the backend for a line, and speak it. Returns the spoken
// text (or null) in case a caller wants to also show it on screen.
export async function speakRouteGreeting(ctx: GreetingContext): Promise<string | null> {
  // Reserve the leading speech slot IMMEDIATELY (synchronously, before any
  // await) so turn callouts that fire while we fetch are parked behind us.
  reserveGreeting();
  try {
    const s = getSettings();

    // Prefer a saved-place label ("work"/"home"/custom); else the given name.
    let destLabel: string | undefined;
    const match =
      ctx.destination && typeof ctx.destination.lat === "number"
        ? matchSavedPlace(ctx.destination.lat, ctx.destination.lng)
        : undefined;
    if (match) {
      destLabel = match.kind === "home" ? "home" : match.kind === "work" ? "work" : match.label;
    } else if (ctx.destinationName) {
      destLabel = ctx.destinationName;
    }

    const body = {
      call_sign: s.callSign || undefined,
      time_of_day: timeOfDay(),
      destination_label: destLabel,
      destination_city: ctx.destinationCity || undefined,
      traffic: trafficLevel(ctx.route),
      weather: weatherWord(ctx.weatherKind),
      temperature: ctx.temperature || undefined,
    };

    const { data } = await api.post("/nova/greeting", body);
    const text = (data?.text || "").toString().trim();
    if (text) {
      deliverGreeting(text);   // plays greeting, then a pause, then releases the parked turn
      return text;
    }
    cancelGreeting();          // nothing to say — release the parked turn now
    return null;
  } catch {
    // Best-effort only — no greeting on any failure. Release the parked turn.
    cancelGreeting();
    return null;
  }
}
