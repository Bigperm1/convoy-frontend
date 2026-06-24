// Weather Layer — OpenWeather API integration for Convoy map overlay.
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

const OW_BASE = "https://api.openweathermap.org/data/2.5";

// OpenWeather condition id -> a canonical phrase the existing weatherKind() /
// weatherIconName() classifiers already understand (they substring-match the
// description text). Keeps the two-tone HUD glyphs accurate without touching the
// classifier. id ranges: 2xx thunder, 3xx drizzle, 5xx rain, 6xx snow, 7xx
// atmosphere (mist/haze/fog), 800 clear, 801/802 partly, 803 broken, 804 overcast.
function owDesc(id: number): string {
  if (id >= 200 && id < 300) return "Thunderstorm";
  if (id >= 300 && id < 400) return "Drizzle";
  if (id >= 500 && id < 600) return "Rain";
  if (id >= 600 && id < 700) return "Snow";
  if (id >= 700 && id < 800) return "Fog";
  if (id === 800) return "Clear";
  if (id === 801 || id === 802) return "Partly cloudy";
  if (id === 803) return "Cloudy";
  if (id === 804) return "Overcast";
  return "Clear";
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
};

const REFRESH_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes (stationary refresh cadence)
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
    };
  } catch {
    return null;
  }
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
      return dlat > 0.003 || dlng > 0.003; // ~300 m in degrees
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
      out.push({
        startMs,
        endMs,
        condition: {
          tempC,
          tempF: (tempC * 9) / 5 + 32,
          feelsLikeC: feelsC,
          feelsLikeF: (feelsC * 9) / 5 + 32,
          description: owDesc(w0?.id ?? 800),
          icon: owIconUrl(w0?.icon),
          humidity: h?.main?.humidity ?? 0,
          windSpeedKph: windKph,
          windSpeedMph: windKph * 0.621371,
          windDirectionDeg: h?.wind?.deg ?? 0,
          precipProbability: Math.round(((h?.pop ?? 0) as number) * 100),
          visibility: (h?.visibility ?? 0) / 1000,
          uvIndex: 0,
          isDaytime: owIsDay(w0?.icon),
          fetchedAt: Date.now(),
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

// Hook: fetch the hourly forecast for a destination once (re-fetch only when the
// destination moves > ~100 m or the data is > 30 min stale). Returns the hours;
// the caller picks the arrival hour with pickForecastAt().
export function useDestinationWeather(
  lat: number | null,
  lng: number | null,
  enabled: boolean
): ForecastHour[] | null {
  const [forecast, setForecast] = useState<ForecastHour[] | null>(null);
  const keyRef = useRef<string | null>(null);
  const lastFetchRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled || lat == null || lng == null) {
      setForecast(null);
      keyRef.current = null;
      return;
    }
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;   // ~100 m granularity
    const stale = Date.now() - lastFetchRef.current > 30 * 60 * 1000;
    if (key === keyRef.current && !stale) return;
    keyRef.current = key;
    lastFetchRef.current = Date.now();
    let cancelled = false;
    (async () => {
      const f = await fetchHourlyForecast(lat, lng, 24);
      if (!cancelled && f) setForecast(f);
    })();
    return () => { cancelled = true; };
  }, [enabled, lat, lng]);

  return forecast;
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
