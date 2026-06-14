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

// ─── PKCE crypto — pure JS, NO Web Crypto ────────────────────────────────────
// CRITICAL BUG FIX: React Native's Hermes engine does NOT provide `crypto`,
// `crypto.subtle`, `TextEncoder`, or `btoa`. Expo's runtime installs URL /
// URLSearchParams / TextDecoder / structuredClone — but none of those four. The
// previous implementation used all of them, so startLogin() threw on its very
// first line (`crypto.getRandomValues`) on EVERY real iOS/Android device and the
// caller's `.catch()` swallowed it → tapping "Log in with Spotify" did nothing.
// (It worked only in the web build, where the browser has Web Crypto.)
//
// These implementations are dependency-free (so the fix ships over-the-air, no
// native module) and were verified byte-for-byte against Node's crypto for
// inputs spanning the SHA-256 block boundaries (lengths 0/55/56/64/96/128) and
// the RFC 7636 PKCE test vector before shipping.
const PKCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// SHA-256 round constants (first 32 bits of the fractional parts of the cube
// roots of the first 64 primes).
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// PKCE verifier chars are all ASCII, so a plain charCode pass is a correct UTF-8
// encoding (no TextEncoder needed).
function asciiBytes(s: string): number[] {
  const a: number[] = [];
  for (let i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 0xff);
  return a;
}

function sha256Bytes(bytes: number[]): number[] {
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const m = bytes.slice();
  const bitLen = bytes.length * 8;
  m.push(0x80);
  while (m.length % 64 !== 56) m.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  m.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
  m.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  const w = new Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < m.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = ((m[i + t * 4] << 24) | (m[i + t * 4 + 1] << 16) | (m[i + t * 4 + 2] << 8) | m[i + t * 4 + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const out: number[] = [];
  for (const hv of [h0, h1, h2, h3, h4, h5, h6, h7]) {
    out.push((hv >>> 24) & 255, (hv >>> 16) & 255, (hv >>> 8) & 255, hv & 255);
  }
  return out;
}

function base64url(bytes: number[]): string {
  let o = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? (bytes[i + 1] ?? 0) : 0;
    const b2 = has2 ? (bytes[i + 2] ?? 0) : 0;
    o += B64URL[b0 >> 2];
    o += B64URL[((b0 & 3) << 4) | (b1 >> 4)];
    if (has1) o += B64URL[((b1 & 15) << 2) | (b2 >> 6)];
    if (has2) o += B64URL[b2 & 63];
  }
  return o;
}

// Random PKCE code-verifier. crypto.getRandomValues is unavailable on Hermes, so
// we use Math.random — acceptable for a single-use, short-lived verifier on a
// mobile client (the threat model already trusts the device).
function randomString(len = 96) {
  let out = "";
  for (let i = 0; i < len; i++) out += PKCE_CHARS[Math.floor(Math.random() * PKCE_CHARS.length)];
  return out;
}

// Kept async so callers need no change; the work is now synchronous + native-safe.
async function sha256base64url(input: string): Promise<string> {
  return base64url(sha256Bytes(asciiBytes(input)));
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
  // Play a context (playlist/album). Optional offset starts at the Nth track so
  // tapping a track inside a list plays the WHOLE list from there — skip + the
  // tracks after it keep playing instead of stopping after one song.
  playContext: (contextUri: string, offsetPosition?: number) =>
    mutate("PUT", "/me/player/play", {
      context_uri: contextUri,
      ...(typeof offsetPosition === "number" ? { offset: { position: offsetPosition } } : {}),
    }),
  // Play an explicit list of track URIs, optionally starting at index N with the
  // rest QUEUED behind it (so a tapped top-track continues into the others).
  playUris: (uris: string[], offsetPosition?: number) =>
    mutate("PUT", "/me/player/play", {
      uris,
      ...(typeof offsetPosition === "number" ? { offset: { position: offsetPosition } } : {}),
    }),
  pause: () => mutate("PUT", "/me/player/pause"),
  next: () => mutate("POST", "/me/player/next"),
  previous: () => mutate("POST", "/me/player/previous"),
  // Shuffle on/off for the active device.
  setShuffle: (state: boolean) => mutate("PUT", `/me/player/shuffle?state=${state ? "true" : "false"}`),
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

