// Weather Layer — OpenWeather current-conditions data for the map HUD CHIP.
// ⚠ THE NAME IS A MISNOMER AND HAS ALWAYS BEEN ONE. There is no map layer here:
// no RasterSource, no tiles, nothing rendered onto the map. It is a data fetch that
// feeds a chip. The Settings copy promised "precipitation overlay on the map" until
// 2026-08-30 — see the parked-overlay research in app/(app)/settings/map-layers.tsx
// before anyone tries to build the thing this filename implies.
// Fetches current conditions (temperature, precipitation, wind, description)
// for the user's current GPS location and exposes them via a React hook.
// The data is displayed as a compact HUD chip on the map when the
// "showWeatherLayer" setting is enabled. (Migrated off the Google Weather API:
// current = /data/2.5/weather, hourly + daily = /data/2.5/forecast, both on the
// free OpenWeather tier. Daily is aggregated from the 3-hour forecast blocks, so
// it spans up to 5 days. The WeatherCondition shape is unchanged, so
// weatherKind() and every consumer keep working untouched.)

import { useEffect, useRef, useState } from "react";
import { OPENWEATHER_KEY } from "./api";
import { logEvent } from "./crashBreadcrumb";

const OW_BASE = "https://api.openweathermap.org/data/2.5";

// ── WHAT THE SKY LOOKS LIKE, NOT WHAT THE MODEL COUNTS (Jeff, 2026-09-22) ─────────────────────
// "i find it always shows cloudy even when its sunny and no clouds." MEASURED the same afternoon,
// 16:00 PDT: OpenWeather said id 803 "broken clouds", clouds 77 % at his location and 62 % over
// Vancouver — and the real sky (METAR CYXX 222300Z: FEW043TCU SCT046 BKN250; CYVR: FEW048 FEW190
// BKN240, RMK CI4) was a few low cumulus under a broken deck of CIRRUS at 24–25 thousand feet.
// OpenWeather's percentage is honest — five to seven oktas of thin high cloud IS 60–80 % cover —
// but nobody standing under it calls that "cloudy"; the sun is out. OpenWeather's own id bands
// (801 11–25 %, 802 25–50 %, 803 51–84 %, 804 85–100 %) put everything from 51 % up under a grey
// cloud on our chip. So the sun stays in the glyph until the deck is OVERCAST (804, ≥ 85 %):
// 801–803 all read "Partly cloudy" (sun + cloud), 804 reads "Overcast" (grey cloud). Rain, snow,
// fog and thunder are unchanged — those are the sky doing something, not a cover percentage.
function owDesc(id: number): string {
  if (id >= 200 && id < 300) return "Thunderstorm";
  if (id >= 300 && id < 400) return "Drizzle";
  if (id >= 500 && id < 600) return "Rain";
  if (id >= 600 && id < 700) return "Snow";
  if (id >= 700 && id < 800) return "Fog";
  if (id === 800) return "Clear";
  if (id >= 801 && id <= 803) return "Partly cloudy";
  if (id === 804) return "Overcast";
  return "Clear";
}
// A cloud-cover description from the percentage alone, for a demoted rain block (below).
function cloudsDesc(pct: number): string {
  if (pct >= 85) return "Overcast";
  if (pct >= 11) return "Partly cloudy";
  return "Clear";
}
// ── A FORECAST BLOCK'S "RAIN" IS A PROBABILITY, NOT A DOWNPOUR (Jeff, 2026-09-22) ─────────────
// "scout mentioned twice it was raining at the end destination but it had not rained all day and
// sunny." His 13:42 PDT greeting ("you'll find it raining at 18 degrees when you get there") read
// the /forecast 3-hour block that CONTAINED his 3-minute-away arrival. Those blocks carry id 500
// "light rain" whenever the model puts ANY rain in the window — the same afternoon's feed showed
// `id=500 light rain pop=0.23 rain3h=0.16 mm` for a block: a 23 % chance of 0.16 mm is not
// "raining", it is a cloudy sky. So a drizzle/rain block is only rain when the model itself is
// fairly sure (pop ≥ RAIN_POP_MIN) AND it is worth an umbrella (rain3h ≥ RAIN_MM_MIN); otherwise
// it is described by its cloud cover. Thunder and snow are left alone. Applied to FORECAST
// blocks only — /weather current conditions report what is falling now, not a probability.
export const RAIN_POP_MIN = 0.5;
export const RAIN_MM_MIN = 0.5;
export function demoteTraceRain(id: number, pop: number, rainMm: number, cloudsPct: number): string {
  const wet = (id >= 300 && id < 400) || (id >= 500 && id < 600);
  if (wet && (pop < RAIN_POP_MIN || rainMm < RAIN_MM_MIN)) return cloudsDesc(cloudsPct);
  return owDesc(id);
}

// OpenWeather marks day/night with a trailing d/n on the icon code (e.g. "04d").
function owIsDay(icon: any): boolean {
  return typeof icon === "string" ? icon.endsWith("d") : true;
}
function owIconUrl(icon: any): string {
  return typeof icon === "string" && icon ? `https://openweathermap.org/img/wn/${icon}@2x.png` : "";
}

export type WeatherCondition = {
  tempC: number;
  tempF: number;
  feelsLikeC: number;
  feelsLikeF: number;
  description: string;          // e.g. "Partly cloudy"
  icon: string;                 // OpenWeather icon URL (HUD draws its own glyph; kept for any consumer)
  humidity: number;             // 0–100 %
  windSpeedKph: number;
  windSpeedMph: number;
  windDirectionDeg: number;
  precipProbability: number;    // 0–100 % chance of precipitation
  visibility: number;           // km
  uvIndex: number;
  isDaytime: boolean;
  fetchedAt: number;            // Date.now()
  // The numbers behind the word, for the `wx-*` receipts (2026-09-22): OpenWeather id, cloud
  // cover %, and for a forecast block its probability + 3-hour millimetres.
  owId?: number;
  cloudsPct?: number;
  pop?: number;
  rainMm?: number;
};

const REFRESH_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes (stationary refresh cadence)
// HEAT (2026-08-14): floor between MOVEMENT-triggered fetches. The effect below re-runs on
// every GPS-driven lat/lng change and doFetch() fires immediately, so the ~300 m movement
// gate alone meant one HTTPS fetch every ~11 s at highway speed (~330/hr) — and the 3-min
// interval was torn down and re-armed on every tick, so it never fired while moving. One
// weather update per minute is indistinguishable on the chip; the request load is ~5x lower.
const MOVE_FETCH_FLOOR_MS = 60 * 1000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ---- Fetch current conditions from OpenWeather (/data/2.5/weather) ----
export async function fetchWeatherConditions(
  lat: number,
  lng: number
): Promise<WeatherCondition | null> {
  const KEY = OPENWEATHER_KEY;
  if (!KEY || KEY === "PASTE_YOUR_OPENWEATHER_KEY_HERE") return null;

  try {
    const url = new URL(`${OW_BASE}/weather`);
    url.searchParams.set("lat", lat.toFixed(6));
    url.searchParams.set("lon", lng.toFixed(6));
    url.searchParams.set("units", "metric"); // temp °C, wind m/s
    url.searchParams.set("appid", KEY);

    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();

    const w0 = Array.isArray(data?.weather) ? data.weather[0] : null;
    if (!w0) return null;

    const tempC = data?.main?.temp ?? 0;
    const feelsLikeC = data?.main?.feels_like ?? tempC;
    const windKph = (data?.wind?.speed ?? 0) * 3.6; // m/s -> km/h

    return {
      tempC,
      tempF: (tempC * 9) / 5 + 32,
      feelsLikeC,
      feelsLikeF: (feelsLikeC * 9) / 5 + 32,
      description: owDesc(w0?.id ?? 800),
      icon: owIconUrl(w0?.icon),
      humidity: data?.main?.humidity ?? 0,
      windSpeedKph: windKph,
      windSpeedMph: windKph * 0.621371,
      windDirectionDeg: data?.wind?.deg ?? 0,
      // /weather has no precip probability (that lives in /forecast); leave 0 so
      // the HUD simply omits the precip line for current conditions.
      precipProbability: 0,
      visibility: (data?.visibility ?? 0) / 1000, // m -> km
      uvIndex: 0, // UV needs One Call 3.0; not surfaced in the HUD anyway
      isDaytime: owIsDay(w0?.icon),
      fetchedAt: Date.now(),
      owId: w0?.id ?? 800,
      cloudsPct: data?.clouds?.all ?? 0,
      rainMm: data?.rain?.["1h"] ?? 0,
    };
  } catch {
    return null;
  }
}

// One bounded receipt per resolved weather word, so the next "it said cloudy / raining" report is
// decidable from the row instead of from memory: what the model said (id, clouds %, pop, mm) and
// what we made of it. Two budgets, one for the chip (`wx-here`) and one for arrivals (`wx-dest`).
const WX_RECEIPTS_MAX = 12;
let _wxHereRows = 0;
let _wxDestRows = 0;
function wxFields(c: WeatherCondition): string {
  return `id=${c.owId ?? "?"} clouds=${c.cloudsPct ?? "?"} pop=${c.pop == null ? "-" : Math.round(c.pop * 100)} mm=${c.rainMm == null ? "-" : c.rainMm} desc=${c.description} kind=${weatherKind(c)} t=${Math.round(c.tempC)}`;
}

// ---- React hook: auto-refreshes weather on a timer ----
export function useWeatherLayer(
  lat: number | null,
  lng: number | null,
  enabled: boolean
): { weather: WeatherCondition | null; loading: boolean; error: boolean } {
  const [weather, setWeather] = useState<WeatherCondition | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastLatRef = useRef<number | null>(null);
  const lastLngRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || lat == null || lng == null) {
      setWeather(null);
      return;
    }

    const shouldRefetch = () => {
      if (!weather) return true;
      if (Date.now() - weather.fetchedAt > STALE_THRESHOLD_MS) return true;
      // Re-fetch once the driver has moved ~300 m so the on-map conditions track
      // the drive live, instead of only updating every ~1 km (the old gate, which
      // read as "weather never changes while driving"). OpenWeather's free tier
      // (60 calls/min) easily absorbs this even at highway speed.
      const dlat = Math.abs((lat ?? 0) - (lastLatRef.current ?? 0));
      const dlng = Math.abs((lng ?? 0) - (lastLngRef.current ?? 0));
      const moved = dlat > 0.003 || dlng > 0.003; // ~300 m in degrees
      // Movement refetch rides the time floor; staleness (above) is unaffected, so a
      // parked car still refreshes on the 3-min interval exactly as before.
      return moved && Date.now() - (weather?.fetchedAt ?? 0) > MOVE_FETCH_FLOOR_MS;
    };

    const doFetch = async () => {
      if (!shouldRefetch()) return;
      setLoading(true);
      setError(false);
      lastLatRef.current = lat;
      lastLngRef.current = lng;
      const result = await fetchWeatherConditions(lat, lng);
      setLoading(false);
      if (result) {
        setWeather(result);
        if (_wxHereRows < WX_RECEIPTS_MAX) { _wxHereRows += 1; try { logEvent(`wx-here ${wxFields(result)}`); } catch {} }
      } else {
        setError(true);
      }
    };

    doFetch();

    timerRef.current = setInterval(doFetch, REFRESH_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [enabled, lat, lng]);

  return { weather, loading, error };
}

// ---- Weather icon helpers ----
// Returns a Ionicons name that best matches the current condition
export function weatherIconName(condition: WeatherCondition | null): string {
  if (!condition) return "partly-sunny";
  const desc = condition.description.toLowerCase();
  if (desc.includes("thunder")) return "thunderstorm";
  if (desc.includes("snow") || desc.includes("blizzard")) return "snow";
  if (desc.includes("rain") || desc.includes("drizzle") || desc.includes("shower")) return "rainy";
  if (desc.includes("fog") || desc.includes("mist") || desc.includes("haze")) return "cloudy";
  if (desc.includes("cloud")) return condition.isDaytime ? "partly-sunny" : "cloudy-night";
  if (condition.isDaytime) return "sunny";
  return "moon";
}

// ---- Dynamic weather glyph kind ----
// Collapses the free-text description (+ day/night) into a small set of
// glyph kinds the WeatherHUD renders as two-tone icons: sun yellow + cloud
// grey, grey cloud + blue rain, grey cloud + yellow lightning, etc.
export type WeatherKind =
  | "clear-day" | "clear-night" | "partly-day" | "partly-night"
  | "cloudy" | "fog" | "rain" | "snow" | "thunder";

export function weatherKind(condition: WeatherCondition | null): WeatherKind {
  if (!condition) return "partly-day";
  const d = condition.description.toLowerCase();
  const day = condition.isDaytime;
  if (d.includes("thunder") || d.includes("lightning")) return "thunder";
  if (d.includes("snow") || d.includes("blizzard") || d.includes("sleet") || d.includes("flurr") || d.includes("ice")) return "snow";
  if (d.includes("rain") || d.includes("drizzle") || d.includes("shower")) return "rain";
  if (d.includes("fog") || d.includes("mist") || d.includes("haze") || d.includes("smoke")) return "fog";
  if (d.includes("cloud") || d.includes("overcast")) {
    if (d.includes("partly") || d.includes("intermittent") || d.includes("mostly sunny")) return day ? "partly-day" : "partly-night";
    return "cloudy";
  }
  if (d.includes("clear") || d.includes("sunny") || d.includes("fair")) return day ? "clear-day" : "clear-night";
  return day ? "clear-day" : "clear-night";
}

// ---- Wind direction helper ----
export function windDirectionLabel(deg: number): string {
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  return dirs[Math.round(deg / 45) % 8];
}

// ---- Destination arrival forecast (hourly) ----
// Hourly forecast at a point, used to show "weather when you arrive" on the
// route's destination pin. Same OpenWeather /forecast feed as the daily outlook,
// exposed as 3-hour blocks. Each block reuses the WeatherCondition shape so
// weatherKind()/the glyph code works unchanged.
export type ForecastHour = { startMs: number; endMs: number; condition: WeatherCondition };

export async function fetchHourlyForecast(
  lat: number,
  lng: number,
  hours = 24
): Promise<ForecastHour[] | null> {
  const KEY = OPENWEATHER_KEY;
  if (!KEY || KEY === "PASTE_YOUR_OPENWEATHER_KEY_HERE") return null;
  try {
    // OpenWeather's free forecast is 3-hour blocks over 5 days. Each block maps
    // to one ForecastHour spanning its 3-hour interval; pickForecastAt() finds
    // the block containing the arrival time.
    const url = new URL(`${OW_BASE}/forecast`);
    url.searchParams.set("lat", lat.toFixed(6));
    url.searchParams.set("lon", lng.toFixed(6));
    url.searchParams.set("units", "metric");
    url.searchParams.set("appid", KEY);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    const list: any[] = Array.isArray(data?.list) ? data.list : [];
    // Cover at least the requested window (3-hour blocks -> ceil(hours/3)).
    const maxBlocks = Math.max(1, Math.ceil(hours / 3));
    const out: ForecastHour[] = [];
    for (const h of list.slice(0, maxBlocks)) {
      const startMs = (h?.dt ?? 0) * 1000;
      if (!startMs) continue;
      const endMs = startMs + 3 * 3600 * 1000;
      const tempC = h?.main?.temp ?? 0;
      const feelsC = h?.main?.feels_like ?? tempC;
      const windKph = (h?.wind?.speed ?? 0) * 3.6;
      const w0 = Array.isArray(h?.weather) ? h.weather[0] : null;
      const id = w0?.id ?? 800;
      const pop = (h?.pop ?? 0) as number;
      const rainMm = (h?.rain?.["3h"] ?? 0) as number;
      const cloudsPct = (h?.clouds?.all ?? 0) as number;
      out.push({
        startMs,
        endMs,
        condition: {
          tempC,
          tempF: (tempC * 9) / 5 + 32,
          feelsLikeC: feelsC,
          feelsLikeF: (feelsC * 9) / 5 + 32,
          description: demoteTraceRain(id, pop, rainMm, cloudsPct),
          icon: owIconUrl(w0?.icon),
          humidity: h?.main?.humidity ?? 0,
          windSpeedKph: windKph,
          windSpeedMph: windKph * 0.621371,
          windDirectionDeg: h?.wind?.deg ?? 0,
          precipProbability: Math.round(pop * 100),
          visibility: (h?.visibility ?? 0) / 1000,
          uvIndex: 0,
          isDaytime: owIsDay(w0?.icon),
          fetchedAt: Date.now(),
          owId: id,
          cloudsPct,
          pop,
          rainMm,
        },
      });
    }
    return out;
  } catch {
    return null;
  }
}

// Pick the forecast hour whose interval contains `epochMs` (your arrival time),
// falling back to the nearest hour if it's outside the fetched window.
export function pickForecastAt(
  forecast: ForecastHour[] | null,
  epochMs: number
): WeatherCondition | null {
  if (!forecast || forecast.length === 0) return null;
  let best = forecast[0];
  let bestD = Infinity;
  for (const h of forecast) {
    if (epochMs >= h.startMs && epochMs < h.endMs) return h.condition;
    const d = Math.abs(h.startMs - epochMs);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best.condition;
}

// ── ARRIVAL WEATHER = WHAT IS THERE NOW when you are nearly there (2026-09-22) ─────────────────
// The 3-hour forecast block is the right answer for a drive that ends in two hours; for a
// 3-minute drive it is a model's guess standing in for a fact that is one request away. Below
// NEAR_ARRIVAL_MS the destination's CURRENT conditions (/weather) answer, if they are fresher
// than CURRENT_FRESH_MS; beyond it, the block containing the arrival time as before.
export const NEAR_ARRIVAL_MS = 90 * 60 * 1000;
export const CURRENT_FRESH_MS = 30 * 60 * 1000;
export type DestinationWeather = { hours: ForecastHour[] | null; current: WeatherCondition | null };

export function pickArrivalWeather(
  dest: DestinationWeather | null,
  arrivalMs: number,
  nowMs = Date.now(),
): { cond: WeatherCondition; src: "cur" | "fc" } | null {
  if (!dest) return null;
  const near = arrivalMs - nowMs <= NEAR_ARRIVAL_MS;
  if (near && dest.current && nowMs - dest.current.fetchedAt <= CURRENT_FRESH_MS) return { cond: dest.current, src: "cur" };
  const fc = pickForecastAt(dest.hours, arrivalMs);
  if (fc) return { cond: fc, src: "fc" };
  if (dest.current) return { cond: dest.current, src: "cur" };
  return null;
}

/** The `wx-dest` receipt, bounded; `eta=` minutes to arrival, `src=` which feed answered. */
export function noteArrivalWeather(pick: { cond: WeatherCondition; src: "cur" | "fc" } | null, arrivalMs: number, why: string): void {
  if (!pick || _wxDestRows >= WX_RECEIPTS_MAX) return;
  _wxDestRows += 1;
  try { logEvent(`wx-dest why=${why} src=${pick.src} eta=${Math.round((arrivalMs - Date.now()) / 60000)} ${wxFields(pick.cond)}`); } catch {}
}

// Hook: fetch the destination's hourly forecast AND its current conditions once (re-fetch only
// when the destination moves > ~100 m or the data is > 30 min stale). The caller picks the
// arrival answer with pickArrivalWeather().
export function useDestinationWeather(
  lat: number | null,
  lng: number | null,
  enabled: boolean
): DestinationWeather | null {
  const [dest, setDest] = useState<DestinationWeather | null>(null);
  const keyRef = useRef<string | null>(null);
  const lastFetchRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled || lat == null || lng == null) {
      setDest(null);
      keyRef.current = null;
      return;
    }
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;   // ~100 m granularity
    const stale = Date.now() - lastFetchRef.current > CURRENT_FRESH_MS;
    if (key === keyRef.current && !stale) return;
    keyRef.current = key;
    lastFetchRef.current = Date.now();
    let cancelled = false;
    (async () => {
      const [hours, current] = await Promise.all([fetchHourlyForecast(lat, lng, 24), fetchWeatherConditions(lat, lng)]);
      if (!cancelled && (hours || current)) setDest({ hours, current });
    })();
    return () => { cancelled = true; };
  }, [enabled, lat, lng]);

  return dest;
}

// ---- Daily forecast (aggregated from OpenWeather /forecast 3-hour blocks) ----
// Used by the tappable weather chip on the map to pop a multi-day outlook (up to
// 5 days on the free tier) for the driver's current location. Each day carries a
// glyph `kind` (reusing the same WeatherGlyph the HUD draws) plus hi/lo temps and
// a precip chance.
export type ForecastDay = {
  startMs: number;
  label: string;            // "Today", "Mon", "Tue", ...
  kind: WeatherKind;
  hiC: number; loC: number;
  hiF: number; loF: number;
  precipProbability: number; // 0-100 %
};

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export async function fetchDailyForecast(
  lat: number,
  lng: number,
  days = 7
): Promise<ForecastDay[] | null> {
  const KEY = OPENWEATHER_KEY;
  if (!KEY || KEY === "PASTE_YOUR_OPENWEATHER_KEY_HERE") return null;
  try {
    // No daily endpoint on the free tier — aggregate the 3-hour /forecast blocks
    // into per-day hi/lo + a midday-representative glyph. Spans up to 5 days.
    const url = new URL(`${OW_BASE}/forecast`);
    url.searchParams.set("lat", lat.toFixed(6));
    url.searchParams.set("lon", lng.toFixed(6));
    url.searchParams.set("units", "metric");
    url.searchParams.set("appid", KEY);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    const list: any[] = Array.isArray(data?.list) ? data.list : [];
    if (list.length === 0) return [];

    // Group blocks by local calendar day, preserving order.
    const order: string[] = [];
    const byDay = new Map<string, any[]>();
    for (const e of list) {
      const ms = (e?.dt ?? 0) * 1000;
      if (!ms) continue;
      const dt = new Date(ms);
      const key = `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`;
      if (!byDay.has(key)) { byDay.set(key, []); order.push(key); }
      byDay.get(key)!.push(e);
    }

    const now = new Date();
    const out: ForecastDay[] = [];
    for (const key of order.slice(0, days)) {
      const entries = byDay.get(key)!;
      let hiC = -Infinity, loC = Infinity, precip = 0;
      let rep = entries[0]; let bestNoon = Infinity;
      for (const e of entries) {
        const t = e?.main?.temp ?? 0;
        const tmax = e?.main?.temp_max ?? t;
        const tmin = e?.main?.temp_min ?? t;
        if (tmax > hiC) hiC = tmax;
        if (tmin < loC) loC = tmin;
        const pop = Math.round(((e?.pop ?? 0) as number) * 100);
        if (pop > precip) precip = pop;
        // Representative block = closest to local noon (drives the day glyph).
        const hr = new Date((e?.dt ?? 0) * 1000).getHours();
        const dist = Math.abs(hr - 12);
        if (dist < bestNoon) { bestNoon = dist; rep = e; }
      }
      if (!Number.isFinite(hiC)) hiC = 0;
      if (!Number.isFinite(loC)) loC = 0;
      const startMs = (entries[0]?.dt ?? 0) * 1000;
      const d0 = new Date(startMs);
      const isToday =
        d0.getFullYear() === now.getFullYear() &&
        d0.getMonth() === now.getMonth() &&
        d0.getDate() === now.getDate();
      const repId = Array.isArray(rep?.weather) ? (rep.weather[0]?.id ?? 800) : 800;
      // Daytime glyph for the day card (matches the old daily behavior).
      const cond = { description: owDesc(repId), isDaytime: true } as WeatherCondition;
      out.push({
        startMs,
        label: isToday ? "Today" : DOW_SHORT[d0.getDay()],
        kind: weatherKind(cond),
        hiC,
        loC,
        hiF: (hiC * 9) / 5 + 32,
        loF: (loC * 9) / 5 + 32,
        precipProbability: precip,
      });
    }
    return out;
  } catch {
    return null;
  }
}

// Hook: fetch the 7-day forecast for the driver's location. Coarser refetch
// gate than the destination hour hook (the daily outlook barely changes over a
// short drive) - re-fetch only when moved > ~5 km or data is > 30 min stale.
export function useDailyForecast(
  lat: number | null,
  lng: number | null,
  enabled: boolean
): ForecastDay[] | null {
  const [forecast, setForecast] = useState<ForecastDay[] | null>(null);

  // Coarse location bucket (~5-11 km). The effect depends on THIS, not raw
  // lat/lng. That's the fix for the "stuck on Loading" bug: raw GPS coords
  // tick ~1/sec, so an effect keyed on them re-ran every tick and its cleanup
  // set cancelled=true on the in-flight fetch before it could resolve (while
  // the re-run early-returned and started no new fetch) — so on a moving GPS
  // the daily fetch was perpetually cancelled and `forecast` never set. A
  // bucketed key only changes when the driver actually moves ~5-11 km, so a
  // single fetch runs to completion.
  const bucket =
    enabled && lat != null && lng != null
      ? `${lat.toFixed(1)},${lng.toFixed(1)}`
      : null;

  useEffect(() => {
    if (bucket == null || lat == null || lng == null) {
      setForecast(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const f = await fetchDailyForecast(lat, lng, 7);
      if (!cancelled && f) setForecast(f);
    })();
    return () => { cancelled = true; };
    // lat/lng intentionally excluded — `bucket` is the coarse refetch trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket]);

  return forecast;
}
