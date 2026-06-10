// novaGreeting.ts — the personable, OpenAI-generated route greeting.
//
// Assembles the structured drive context the app already has (call sign, time
// of day, destination + saved-place label, traffic, arrival weather) and asks
// the backend (POST /api/nova/greeting -> gpt-4o-mini) for ONE natural spoken
// line. To keep it snappy, the line is fetched AND pre-synthesized to audio
// during the route-preview stage (prepareRouteGreeting), then played the
// instant the driver taps Start (playPreparedGreeting) — so there's no network
// wait at Start. The greeting always leads the first turn callout, which is
// parked behind it (reserve/deliver/cancel in nav.ts).
//
// Best-effort: any failure (offline, backend down) just means no greeting — it
// never throws into the caller.

import { api } from "./api";
import { reserveGreeting, deliverGreetingAudio, cancelGreeting } from "./nav";
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
// traffic; freeflow_s is the no-traffic time. Returns undefined without both.
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
    case "clear-night": return "clear";
    case "partly-day":
    case "partly-night": return "partly cloudy";
    case "cloudy": return "cloudy";
    case "fog": return "foggy";
    case "rain": return "raining";
    case "snow": return "snowing";
    case "thunder": return "thunderstorms";
    default: return undefined;
  }
}

export type GreetingContext = {
  // Destination coordinate — used to recognize a saved place (Home/Work).
  destination?: { lat: number; lng: number } | null;
  // Fallback name when the destination isn't a saved place (search label / city).
  destinationName?: string | null;
  // City/area for the weather clause.
  destinationCity?: string | null;
  // The selected route (for the traffic read).
  route?: NavRoute | null;
  // Arrival weather already fetched for the destination chip.
  weatherKind?: WeatherKind | null;
  temperature?: string | null;
};

// ---- Prepared-greeting cache ----
// prepareRouteGreeting() fills this during route preview; playPreparedGreeting()
// consumes it at Start. Keyed by destination so a new destination re-prepares.
let _preparedKey: string | null = null;
let _preparedAudio: { b64: string; mime: string } | null = null;
let _preparing: Promise<void> | null = null;

// Pre-fetch the LLM line AND pre-synthesize its audio while the route preview is
// on screen, so playPreparedGreeting() can speak instantly at Start. Best-effort
// and idempotent per destination key.
export function prepareRouteGreeting(ctx: GreetingContext, key: string): void {
  if (getSettings().novaGreeting === false) return;
  if (_preparedKey === key && (_preparedAudio || _preparing)) return;
  _preparedKey = key;
  _preparedAudio = null;
  _preparing = (async () => {
    try {
      const s = getSettings();

      // Prefer a saved-place label ("work"/"home"/custom); else the given name.
      let destLabel: string | undefined;
      const match =
        ctx.destination && typeof ctx.destination.lat === "number"
          ? matchSavedPlace(ctx.destination.lat, ctx.destination.lng)
          : undefined;
      if (match) destLabel = match.kind === "home" ? "home" : match.kind === "work" ? "work" : match.label;
      else if (ctx.destinationName) destLabel = ctx.destinationName;

      const { data } = await api.post("/nova/greeting", {
        call_sign: s.callSign || undefined,
        time_of_day: timeOfDay(),
        destination_label: destLabel,
        destination_city: ctx.destinationCity || undefined,
        traffic: trafficLevel(ctx.route),
        weather: weatherWord(ctx.weatherKind),
        temperature: ctx.temperature || undefined,
      });
      const text = (data?.text || "").toString().trim();
      if (!text) return;

      // Pre-synthesize so Start -> instant playback (no /tts round-trip then).
      const tts = await api.post("/tts", { text, voice: "nova" });
      const b64 = tts?.data?.audio_b64;
      if (b64) _preparedAudio = { b64, mime: tts?.data?.mime || "audio/mp3" };
    } catch {
      _preparedAudio = null;
    } finally {
      _preparing = null;
    }
  })();
}

// Play the prepared greeting NOW (called at Start). Reserves the speech slot so
// the engine's first turn callout is parked behind it; waits for prep if it's
// still in flight; releases the parked callout if there's no greeting to play.
export async function playPreparedGreeting(): Promise<void> {
  if (getSettings().novaGreeting === false) return;
  reserveGreeting();
  try {
    if (_preparing) await _preparing;
    if (_preparedAudio) deliverGreetingAudio(_preparedAudio.b64, _preparedAudio.mime);
    else cancelGreeting();
  } catch {
    cancelGreeting();
  } finally {
    _preparedAudio = null; // consume so a later Start doesn't replay it
    _preparedKey = null;
  }
}

// Drop any prepared greeting (destination changed / route cleared).
export function clearPreparedGreeting(): void {
  _preparedAudio = null;
  _preparing = null;
  _preparedKey = null;
}
