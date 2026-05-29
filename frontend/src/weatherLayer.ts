// Weather Layer — Google Weather API integration for Convoy map overlay.
// Fetches current conditions (temperature, precipitation, wind, description)
// for the user's current GPS location and exposes them via a React hook.
// The data is displayed as a compact HUD chip on the map when the
// "showWeatherLayer" setting is enabled.

import { useEffect, useRef, useState } from "react";

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
  const KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY as string;
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

    // Map the Google Weather API response to our internal type
    const current = data?.currentConditions;
    if (!current) return null;

    const tempC = current.temperature?.degrees ?? 0;
    const feelsLikeC = current.feelsLike?.degrees ?? tempC;
    const wind = current.wind;
    const windKph = wind?.speed?.value ?? 0;
    const precipProb = current.precipitation?.probability?.percent ?? 0;

    return {
      tempC,
      tempF: (tempC * 9) / 5 + 32,
      feelsLikeC,
      feelsLikeF: (feelsLikeC * 9) / 5 + 32,
      description: current.weatherCondition?.description?.text ?? current.weatherCondition?.type ?? "Unknown",
      icon: current.weatherCondition?.iconBaseUri ?? "",
      humidity: current.relativeHumidity ?? 0,
      windSpeedKph: windKph,
      windSpeedMph: windKph * 0.621371,
      windDirectionDeg: wind?.direction?.degrees ?? 0,
      precipProbability: precipProb,
      visibility: current.visibility?.distance ?? 0,
      uvIndex: current.uvIndex ?? 0,
      isDaytime: current.isDaytime ?? true,
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
