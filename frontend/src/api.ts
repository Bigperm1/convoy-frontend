import axios from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Hardcoded fallback for the production backend host. Used when
// `EXPO_PUBLIC_BACKEND_URL` is missing at Metro bundle time — this is the
// failure mode behind the "404 on signup" we saw in the first iOS TestFlight
// build (EAS Build didn't have the env var so axios was hitting a relative
// `undefined/api/...` URL on the device).
//
// Two-layer defense: (1) this string is baked into the JS bundle so the app
// ALWAYS has a working backend even with zero env-var injection, and (2)
// `eas.json` now also passes EXPO_PUBLIC_BACKEND_URL to every build profile
// for cleanliness. Either fix alone is sufficient.
const PROD_BACKEND_URL = "https://convoy-backend-j9q1.onrender.com";
export const BACKEND_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL as string) || PROD_BACKEND_URL;
export const API_BASE = `${BACKEND_URL}/api`;

// Same two-layer defense for the Google Maps web-services key (Places, Routes,
// Weather, Geocoding, Roads). EAS Build has intermittently failed to inject
// EXPO_PUBLIC_* vars (see the BACKEND_URL note above). Unlike the native Maps
// SDK key (set in app.json, used for tiles), this key is ONLY read from the
// env at bundle time — so a missing/stale injection silently kills
// search/route/weather while tiles keep working. Hardcoding the prod key as a
// fallback guarantees it's always present regardless of EAS env injection.
const PROD_MAPS_KEY = "AIzaSyDj69IfW8Dy7aeX-gaHIdHGsSL1WO7sD_M";
export const GOOGLE_MAPS_KEY = PROD_MAPS_KEY;

// OpenWeather API key (current conditions + 5-day/3-hour forecast). Replaces the
// Google Weather API. Read ONLY from the environment (.env, which is gitignored)
// — deliberately NOT hardcoded, because this repo is PUBLIC and a committed key
// would be scraped within minutes. Set EXPO_PUBLIC_OPENWEATHER_KEY in .env. The
// empty fallback means weather degrades gracefully (returns null) if the env var
// is ever missing, rather than shipping a literal key in the bundle source.
const PROD_OPENWEATHER_KEY = "";
export const OPENWEATHER_KEY =
  (process.env.EXPO_PUBLIC_OPENWEATHER_KEY as string) || PROD_OPENWEATHER_KEY;

const TOKEN_KEY = "convoy_token";

export async function saveToken(token: string) {
  try { await AsyncStorage.setItem(TOKEN_KEY, token); } catch {}
}
export async function getToken() {
  try { return await AsyncStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export async function clearToken() {
  try { await AsyncStorage.removeItem(TOKEN_KEY); } catch {}
}

export const api = axios.create({ baseURL: API_BASE, timeout: 60000 });

api.interceptors.request.use(async (config) => {
  const t = await getToken();
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

export function wsUrl(token: string) {
  const base = BACKEND_URL.replace(/^http/, "ws");
  return `${base}/api/ws?token=${encodeURIComponent(token)}`;
}

export function formatErr(e: any): string {
    if (e?.code === "ECONNABORTED" || e?.message?.includes("timeout")) return "Server is starting up — please try again in a few seconds.";
  const d = e?.response?.data?.detail;
  if (!d) return e?.message || "Something went wrong";
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x: any) => x.msg || JSON.stringify(x)).join(", ");
  return JSON.stringify(d);
}
