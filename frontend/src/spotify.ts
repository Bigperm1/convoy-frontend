// Spotify Authorization Code + PKCE flow (client-side, no secret needed)
// Works on web preview. Stores tokens in localStorage.

const CLIENT_ID = process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID as string;
const REDIRECT_URI =
  typeof window !== "undefined"
    ? `${window.location.origin}/spotify-callback`
    : "";
const SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-top-read",
  "playlist-read-private",
  "user-read-currently-playing",
  "user-read-playback-state",
].join(" ");

const TOKEN_KEY = "spotify_access_token";
const REFRESH_KEY = "spotify_refresh_token";
const EXPIRY_KEY = "spotify_token_expiry";
const VERIFIER_KEY = "spotify_pkce_verifier";

function randomString(len = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const arr = new Uint8Array(len);
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

export function getStoredToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    const exp = parseInt(localStorage.getItem(EXPIRY_KEY) || "0", 10);
    if (!t) return null;
    if (Date.now() > exp - 30_000) return null; // expired or near expiry
    return t;
  } catch { return null; }
}

export async function startLogin() {
  if (!CLIENT_ID) throw new Error("Spotify Client ID not configured");
  const verifier = randomString(96);
  localStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = await sha256base64url(verifier);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export async function handleCallbackCode(code: string): Promise<boolean> {
  const verifier = localStorage.getItem(VERIFIER_KEY);
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
  localStorage.setItem(TOKEN_KEY, data.access_token);
  if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
  localStorage.setItem(EXPIRY_KEY, String(Date.now() + (data.expires_in || 3600) * 1000));
  localStorage.removeItem(VERIFIER_KEY);
  return true;
}

export async function refreshAccessToken(): Promise<string | null> {
  const refresh = localStorage.getItem(REFRESH_KEY);
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
  localStorage.setItem(TOKEN_KEY, data.access_token);
  if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
  localStorage.setItem(EXPIRY_KEY, String(Date.now() + (data.expires_in || 3600) * 1000));
  return data.access_token;
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRY_KEY);
}

async function call<T>(path: string): Promise<T> {
  let token = getStoredToken();
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

export const spotify = {
  me: () => call<any>("/me"),
  topTracks: () => call<any>("/me/top/tracks?limit=20&time_range=short_term"),
  myPlaylists: () => call<any>("/me/playlists?limit=20"),
  currentlyPlaying: () => call<any>("/me/player/currently-playing"),
};
