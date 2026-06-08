// Weather Layer — Google Weather API integration for Convoy map overlay.
// Fetches current conditions (temperature, precipitation, wind, description)
// for the user's current GPS location and exposes them via a React hook.
// The data is displayed as a compact HUD chip on the map when the
// "showWeatherLayer" setting is enabled.

import { useEffect, useRef, useState } from "react";
import { GOOGLE_MAPS_KEY } from "./api";

export type WeatherCondition = {
  tempC: number;
  tempF: number;
  feelsLikeC: number;
  feelsLikeF: number;
  description: string;          // e.g. "Partly cloudy"
  icon: string;                 // icon code from Google weather API
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

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

// ---- Fetch from Google Weather API ----
// The Weather API endpoint returns current conditions at a lat/lng.
// Note: requires the "Weather API" to be enabled in your Google Cloud project.
export async function fetchWeatherConditions(
  lat: number,
  lng: number
): Promise<WeatherCondition | null> {
  const KEY = GOOGLE_MAPS_KEY;
  if (!KEY) return null;

  try {
    // Google Weather API — Current Conditions endpoint
    const url = new URL("https://weather.googleapis.com/v1/currentConditions:lookup");
    url.searchParams.set("key", KEY);
    url.searchParams.set("location.latitude", lat.toFixed(6));
    url.searchParams.set("location.longitude", lng.toFixed(6));

    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();

    // The Weather API returns all fields at the TOP LEVEL of the response
    // (NOT nested under a `currentConditions` key — that was the bug). Guard on
    // a core field so a bad/empty payload returns null cleanly.
    if (!data || !data.weatherCondition) return null;

    const tempC = data.temperature?.degrees ?? 0;
    const feelsLikeC = data.feelsLikeTemperature?.degrees ?? tempC;
    const wind = data.wind;
    const windKph = wind?.speed?.value ?? 0;
    const precipProb = data.precipitation?.probability?.percent ?? 0;

    return {
      tempC,
      tempF: (tempC * 9) / 5 + 32,
      feelsLikeC,
      feelsLikeF: (feelsLikeC * 9) / 5 + 32,
      description: data.weatherCondition?.description?.text ?? data.weatherCondition?.type ?? "Unknown",
      icon: data.weatherCondition?.iconBaseUri ?? "",
      humidity: data.relativeHumidity ?? 0,
      windSpeedKph: windKph,
      windSpeedMph: windKph * 0.621371,
      windDirectionDeg: wind?.direction?.degrees ?? 0,
      precipProbability: precipProb,
      visibility: data.visibility?.distance ?? 0,
      uvIndex: data.uvIndex ?? 0,
      isDaytime: data.isDaytime ?? true,
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
      // Re-fetch if the user has moved more than ~1 km
      const dlat = Math.abs((lat ?? 0) - (lastLatRef.current ?? 0));
      const dlng = Math.abs((lng ?? 0) - (lastLngRef.current ?? 0));
      return dlat > 0.009 || dlng > 0.009; // ~1 km in degrees
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
// Returns a Ionicons name that best matches the Google Weather icon code
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
// Collapses Google's free-text description (+ day/night) into a small set of
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
// route's destination pin. Same Google Weather API as currentConditions, but
// the forecast/hours endpoint. Each hour reuses the WeatherCondition shape so
// weatherKind()/the glyph code works unchanged.
export type ForecastHour = { startMs: number; endMs: number; condition: WeatherCondition };

export async function fetchHourlyForecast(
  lat: number,
  lng: number,
  hours = 24
): Promise<ForecastHour[] | null> {
  const KEY = GOOGLE_MAPS_KEY;
  if (!KEY) return null;
  try {
    const url = new URL("https://weather.googleapis.com/v1/forecast/hours:lookup");
    url.searchParams.set("key", KEY);
    url.searchParams.set("location.latitude", lat.toFixed(6));
    url.searchParams.set("location.longitude", lng.toFixed(6));
    url.searchParams.set("hours", String(hours));
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    const arr: any[] = Array.isArray(data?.forecastHours) ? data.forecastHours : [];
    const out: ForecastHour[] = [];
    for (const h of arr) {
      const startMs = h?.interval?.startTime ? Date.parse(h.interval.startTime) : NaN;
      if (!Number.isFinite(startMs)) continue;
      const endMs = h?.interval?.endTime ? Date.parse(h.interval.endTime) : startMs + 3600000;
      const tempC = h?.temperature?.degrees ?? 0;
      const feelsC = h?.feelsLikeTemperature?.degrees ?? tempC;
      const wind = h?.wind;
      const windKph = wind?.speed?.value ?? 0;
      // Some hours omit isDaytime; fall back to the local clock hour from
      // displayDateTime so the day/night icon is still right.
      const localHour = h?.displayDateTime?.hours;
      const isDay =
        typeof h?.isDaytime === "boolean"
          ? h.isDaytime
          : (typeof localHour === "number" ? localHour >= 6 && localHour < 20 : true);
      out.push({
        startMs,
        endMs,
        condition: {
          tempC,
          tempF: (tempC * 9) / 5 + 32,
          feelsLikeC: feelsC,
          feelsLikeF: (feelsC * 9) / 5 + 32,
          description: h?.weatherCondition?.description?.text ?? h?.weatherCondition?.type ?? "Unknown",
          icon: h?.weatherCondition?.iconBaseUri ?? "",
          humidity: h?.relativeHumidity ?? 0,
          windSpeedKph: windKph,
          windSpeedMph: windKph * 0.621371,
          windDirectionDeg: wind?.direction?.degrees ?? 0,
          precipProbability: h?.precipitation?.probability?.percent ?? 0,
          visibility: h?.visibility?.distance ?? 0,
          uvIndex: h?.uvIndex ?? 0,
          isDaytime: isDay,
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

// ---- 7-day daily forecast (Google Weather API forecast/days) ----
// Used by the tappable weather chip on the map to pop a 7-day outlook for the
// driver's current location. Each day carries a glyph `kind` (reusing the same
// WeatherGlyph the HUD draws) plus hi/lo temps and a precip chance.
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
  const KEY = GOOGLE_MAPS_KEY;
  if (!KEY) return null;
  try {
    const url = new URL("https://weather.googleapis.com/v1/forecast/days:lookup");
    url.searchParams.set("key", KEY);
    url.searchParams.set("location.latitude", lat.toFixed(6));
    url.searchParams.set("location.longitude", lng.toFixed(6));
    url.searchParams.set("days", String(days));
    // Without pageSize the API returns a 5-day page (+ nextPageToken). Setting
    // pageSize = days returns the full window in one response, so the 7-day
    // card isn't silently truncated to 5.
    url.searchParams.set("pageSize", String(days));
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    const arr: any[] = Array.isArray(data?.forecastDays) ? data.forecastDays : [];
    const now = new Date();
    const out: ForecastDay[] = [];
    arr.forEach((d, i) => {
      const startMs = d?.interval?.startTime ? Date.parse(d.interval.startTime) : NaN;
      // Prefer the API's local calendar date for the weekday label so a UTC
      // interval boundary near midnight doesn't shift the day name.
      const dd = d?.displayDate;
      let label: string;
      if (dd?.year && dd?.month && dd?.day) {
        const dt = new Date(dd.year, dd.month - 1, dd.day);
        const isToday =
          dt.getFullYear() === now.getFullYear() &&
          dt.getMonth() === now.getMonth() &&
          dt.getDate() === now.getDate();
        label = isToday ? "Today" : DOW_SHORT[dt.getDay()];
      } else if (Number.isFinite(startMs)) {
        label = i === 0 ? "Today" : DOW_SHORT[new Date(startMs).getDay()];
      } else {
        label = i === 0 ? "Today" : `Day ${i + 1}`;
      }
      // Daytime part drives the icon; fall back to nighttime if absent.
      const part = d?.daytimeForecast || d?.nighttimeForecast || {};
      const desc =
        part?.weatherCondition?.description?.text ??
        part?.weatherCondition?.type ??
        "Unknown";
      const hiC = d?.maxTemperature?.degrees ?? 0;
      const loC = d?.minTemperature?.degrees ?? 0;
      const precip = part?.precipitation?.probability?.percent ?? 0;
      // Minimal daytime condition just so weatherKind() resolves the glyph.
      const cond = { description: desc, isDaytime: true } as WeatherCondition;
      out.push({
        startMs: Number.isFinite(startMs) ? startMs : Date.now() + i * 86400000,
        label,
        kind: weatherKind(cond),
        hiC,
        loC,
        hiF: (hiC * 9) / 5 + 32,
        loF: (loC * 9) / 5 + 32,
        precipProbability: precip,
      });
    });
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
