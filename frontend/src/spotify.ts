// Spotify Authorization Code + PKCE flow (client-side, no secret needed).
//
// Storage strategy: previously this module called `localStorage.*` directly
// which CRASHES on iOS/Android (no `localStorage` global exists in the React
// Native runtime). That crash manifested as a black screen on the Music tab.
// The new `store` wrapper below uses localStorage on web and AsyncStorage on
// native so every consumer of this module is safe across all three runtimes.
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Hardcoded fallback mirrors the PROD_* pattern in api.ts / supabase.ts — EAS
// has historically failed to inject EXPO_PUBLIC_* at bundle time, which would
// silently disable Spotify. This is the PUBLIC PKCE client id (no secret).
const CLIENT_ID = (process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID || "3be57d90d8bb4fd0b773b303eba47dbf") as string;
// Redirect target:
//   - Web: same-origin /spotify-callback (handled by an Expo route)
//   - Native: custom URL scheme (configured in app.json → expo.scheme).
//     The scheme MUST also be added to the Spotify dev-console redirect-URIs.
const REDIRECT_URI =
  Platform.OS === "web"
    ? (typeof window !== "undefined" ? `${window.location.origin}/spotify-callback` : "")
    : "convoy://spotify-callback";
const SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-top-read",
  "playlist-read-private",
  "user-read-currently-playing",
  "user-read-playback-state",
  // Required to CONTROL playback (play/pause/skip/transfer) via the Web API.
  "user-modify-playback-state",
].join(" ");

const TOKEN_KEY = "spotify_access_token";
const REFRESH_KEY = "spotify_refresh_token";
const EXPIRY_KEY = "spotify_token_expiry";
const VERIFIER_KEY = "spotify_pkce_verifier";

// Platform-safe key/value storage. All methods are async so the surface is
// identical on web and native (where AsyncStorage IS async). On web we keep
// the localStorage path so existing sessions established in the browser
// continue to work without a re-login.
const store = {
  get: async (key: string): Promise<string | null> => {
    if (Platform.OS === "web") {
      try { return localStorage.getItem(key); } catch { return null; }
    }
    try { return await AsyncStorage.getItem(key); } catch { return null; }
  },
  set: async (key: string, value: string): Promise<void> => {
    if (Platform.OS === "web") {
      try { localStorage.setItem(key, value); } catch {}
      return;
    }
    try { await AsyncStorage.setItem(key, value); } catch {}
  },
  remove: async (key: string): Promise<void> => {
    if (Platform.OS === "web") {
      try { localStorage.removeItem(key); } catch {}
      return;
    }
    try { await AsyncStorage.removeItem(key); } catch {}
  },
};

function randomString(len = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const arr = new Uint8Array(len);
  // expo-crypto / React Native exposes a global `crypto.getRandomValues` shim,
  // so this works on web AND native without extra deps.
  crypto.getRandomValues(arr);
  return Array.from(arr).map((n) => chars[n % chars.length]).join("");
}

async function sha256base64url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function isConfigured() {
  return !!CLIENT_ID;
}

// Now async — callers awaited the synchronous version anyway (it returned a
// string, never a Promise), so this is a safe drop-in upgrade.
export async function getStoredToken(): Promise<string | null> {
  try {
    const t = await store.get(TOKEN_KEY);
    const expStr = await store.get(EXPIRY_KEY);
    const exp = parseInt(expStr || "0", 10);
    if (!t) return null;
    if (Date.now() > exp - 30_000) return null; // expired or near expiry
    return t;
  } catch { return null; }
}

export async function startLogin() {
  if (!CLIENT_ID) throw new Error("Spotify Client ID not configured");
  const verifier = randomString(96);
  await store.set(VERIFIER_KEY, verifier);
  const challenge = await sha256base64url(verifier);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  const authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;
  if (Platform.OS === "web") {
    window.location.href = authUrl;
  } else {
    // Native: open in the system browser. The user will be redirected back to
    // the convoy:// scheme; handleCallbackCode() is invoked by an expo-linking
    // listener registered in app/_layout.tsx (or the spotify-callback route).
    const { Linking } = await import("react-native");
    await Linking.openURL(authUrl);
  }
}

export async function handleCallbackCode(code: string): Promise<boolean> {
  const verifier = await store.get(VERIFIER_KEY);
  if (!verifier) return false;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) return false;
  const data = await res.json();
  await store.set(TOKEN_KEY, data.access_token);
  if (data.refresh_token) await store.set(REFRESH_KEY, data.refresh_token);
  await store.set(EXPIRY_KEY, String(Date.now() + (data.expires_in || 3600) * 1000));
  await store.remove(VERIFIER_KEY);
  return true;
}

export async function refreshAccessToken(): Promise<string | null> {
  const refresh = await store.get(REFRESH_KEY);
  if (!refresh) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: CLIENT_ID,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  await store.set(TOKEN_KEY, data.access_token);
  if (data.refresh_token) await store.set(REFRESH_KEY, data.refresh_token);
  await store.set(EXPIRY_KEY, String(Date.now() + (data.expires_in || 3600) * 1000));
  return data.access_token;
}

export async function logout(): Promise<void> {
  await store.remove(TOKEN_KEY);
  await store.remove(REFRESH_KEY);
  await store.remove(EXPIRY_KEY);
}

async function call<T>(path: string): Promise<T> {
  let token = await getStoredToken();
  if (!token) token = await refreshAccessToken();
  if (!token) throw new Error("Not signed in");
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw new Error("Session expired");
    const res2 = await fetch(`https://api.spotify.com/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res2.ok) throw new Error(`Spotify ${res2.status}`);
    return res2.json();
  }
  if (!res.ok) throw new Error(`Spotify ${res.status}`);
  return res.json();
}

// GET that tolerates 204 No Content (Spotify returns it when nothing is playing
// / no active device) — returns null instead of throwing on an empty body.
async function callSafe<T>(path: string): Promise<T | null> {
  try {
    let token = await getStoredToken();
    if (!token) token = await refreshAccessToken();
    if (!token) return null;
    const res = await fetch(`https://api.spotify.com/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) return null;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch { return null; }
}

// PUT/POST control call. Returns { ok, status } — status 404 = no active device
// (open Spotify once), 403 = Premium required. 204 is the success code here.
async function mutate(method: "PUT" | "POST", path: string, body?: any): Promise<{ ok: boolean; status: number }> {
  let token = await getStoredToken();
  if (!token) token = await refreshAccessToken();
  if (!token) return { ok: false, status: 401 };
  const doFetch = (tok: string) => fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = await doFetch(token);
  if (res.status === 401) {
    const t = await refreshAccessToken();
    if (t) res = await doFetch(t);
  }
  return { ok: res.ok || res.status === 204, status: res.status };
}

export const spotify = {
  me: () => call<any>("/me"),
  topTracks: () => call<any>("/me/top/tracks?limit=30&time_range=short_term"),
  myPlaylists: () => call<any>("/me/playlists?limit=30"),
  currentlyPlaying: () => callSafe<any>("/me/player/currently-playing"),
  playbackState: () => callSafe<any>("/me/player"),
  devices: () => callSafe<any>("/me/player/devices"),
  playlistTracks: (id: string) => call<any>(`/playlists/${id}/tracks?limit=50`),
  // ----- Playback controls (Web API; needs Premium + an active device) -----
  resume: () => mutate("PUT", "/me/player/play"),
  playContext: (contextUri: string) => mutate("PUT", "/me/player/play", { context_uri: contextUri }),
  playUris: (uris: string[]) => mutate("PUT", "/me/player/play", { uris }),
  pause: () => mutate("PUT", "/me/player/pause"),
  next: () => mutate("POST", "/me/player/next"),
  previous: () => mutate("POST", "/me/player/previous"),
  transfer: (deviceId: string, play = true) => mutate("PUT", "/me/player", { device_ids: [deviceId], play }),
};

// ============================================================
// Web Playback SDK quality config
// ============================================================
//
// The Spotify Web API has NO endpoint to set playback quality — it is
// controlled either by the user's account tier (Free 96-160kbps / Premium up
// to 320kbps OGG_VORBIS) OR by the Web Playback SDK at instantiation time.
//
// We don't currently instantiate the Web Playback SDK (Convoy delegates
// playback to the user's native Spotify app via deep-links). But when/if a
// future browser-mode listener mode is added, this helper maps our proximity
// `MusicBroadcastQuality` enum to the SDK's `streamingFormat` option:
//
//   const sdk = new Spotify.Player({
//     name: "Convoy",
//     getOAuthToken: cb => cb(token),
//     ...spotifyPlayerQualityConfig(quality),
//   });
//
// SDK reference: https://developer.spotify.com/documentation/web-playback-sdk
export type SpotifyStreamingQuality = "lossless" | "high" | "normal";

export function spotifyPlayerQualityConfig(quality: SpotifyStreamingQuality) {
  // `streamingFormat` is the only public knob the SDK exposes. There's no
  // per-track override — re-instantiate the SDK if the user crosses tier
  // boundaries mid-session.
  switch (quality) {
    case "lossless":
      // "VERY_HIGH" = OGG_VORBIS 320kbps (Premium only). Fall back to HIGH
      // automatically if the listener's account doesn't support it.
      return { streamingFormat: "OGG_VORBIS_320" as const };
    case "high":
      return { streamingFormat: "OGG_VORBIS_160" as const };
    case "normal":
    default:
      return { streamingFormat: "OGG_VORBIS_96" as const };
  }
}

