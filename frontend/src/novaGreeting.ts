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

import { api, TTS_FETCH_TIMEOUT_LONG_MS } from "./api";
import { reserveGreeting, deliverGreetingAudio, cancelGreeting } from "./nav";
import type { NavRoute } from "./nav";
import { getSettings, getNovaVoice } from "./settings";
import { logEvent } from "./crashBreadcrumb";
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
  // The first PENDING stop's spoken name, on a multi-stop run.
  //
  // Composed HERE rather than by the caller, and that placement is the whole point.
  // map.tsx originally packed "Canadian Tire, then home" into destinationName — but
  // the saved-place match below runs FIRST and wins, so on the single most common
  // errand shape (a stop on the way home) the composed string was silently thrown
  // away and Nova announced only the destination. Which is the bug Jeff reported:
  // "it announced Superstore while it was routing me to Canadian Tire first."
  viaName?: string | null;
  // City/area for the weather clause. The app STOPPED sending this on 2026-09-11: the only
  // value it ever had was the destination label, which for a saved place is "Work", and the
  // template dutifully said "It's cloudy in Work." The backend now ends the weather clause on
  // "when you arrive" instead. Left in the type so a real locality can be wired later.
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
/** Generation token. A prepare is two awaits deep (/nova/greeting then /tts — ≥ 3.7 s in the field on
 *  2026-09-11), and a destination change or an added stop starts another one while the first is still
 *  in flight. Without this the superseded prepare still wrote `_preparedAudio` and cleared `_preparing`
 *  when it finished, so Start could play the OLD destination's line — the single-destination greeting
 *  on a multi-stop run, which is the exact 08-31 bug shape — or a late failure of the stale prepare
 *  could wipe a good greeting. Reproduced 2026-09-11 across five interleavings. Every write below is
 *  guarded by `gen === _gen`. */
let _gen = 0;

// Pre-fetch the LLM line AND pre-synthesize its audio while the route preview is
// on screen, so playPreparedGreeting() can speak instantly at Start. Best-effort
// and idempotent per destination key.
export function prepareRouteGreeting(ctx: GreetingContext, key: string): void {
  if (getSettings().novaGreeting === false) return;
  if (_preparedKey === key && (_preparedAudio || _preparing)) return;
  _preparedKey = key;
  _preparedAudio = null;
  const gen = ++_gen;
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
      // Prefix the stop AFTER the saved-place match, so "home" survives as the tail.
      // The ternary is load-bearing: with no saved match AND no destinationName,
      // destLabel is undefined, and a plain `if (viaName && destLabel)` would drop
      // the stop too — leaving a multi-stop drive with no label at all.
      if (ctx.viaName) destLabel = destLabel ? `${ctx.viaName}, then ${destLabel}` : ctx.viaName;

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
      // Receipt (2026-09-10, Jeff: "can you tell me what it said to me this morning" — nothing had recorded
      // it): the line, its source (claude | template — the template is several clipped sentences), once
      // per prepared destination. Bounded by construction (one per route preview).
      if (gen !== _gen) return;                       // superseded while /nova/greeting was in flight
      try { logEvent(`greet-prep src=${data?.source ?? "?"} len=${text.length} text="${text.slice(0, 200).replace(/"/g, "'")}"`); } catch {}
      if (!text) return;

      // Pre-synthesize so Start -> instant playback (no /tts round-trip then).
      const tts = await api.post("/tts", { text, voice: getNovaVoice(s) }, { timeout: TTS_FETCH_TIMEOUT_LONG_MS });
      const b64 = tts?.data?.audio_b64;
      if (gen !== _gen) return;                       // superseded while /tts was in flight
      if (b64) _preparedAudio = { b64, mime: tts?.data?.mime || "audio/mp3" };
    } catch (e) {
      if (gen !== _gen) return;                       // a STALE prepare's failure must not wipe a good one
      _preparedAudio = null;
      try { logEvent(`greet-prep-fail err=${String((e as any)?.message ?? e).slice(0, 80)}`); } catch {}
    } finally {
      if (gen === _gen) _preparing = null;
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
    else { try { logEvent("greet-none why=no-audio"); } catch {} cancelGreeting(); }
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
  _gen += 1;   // orphan any prepare still in flight: it must not land after a clear
}
