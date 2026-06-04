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

// ---- Wind direction helper ----
export function windDirectionLabel(deg: number): string {
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  return dirs[Math.round(deg / 45) % 8];
}
