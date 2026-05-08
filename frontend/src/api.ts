import axios from "axios";
import { Platform } from "react-native";

export const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL as string;
export const API_BASE = `${BACKEND_URL}/api`;

const TOKEN_KEY = "rev_radar_token";
const isWeb = Platform.OS === "web" || typeof window !== "undefined";

// Lazy-load SecureStore only on native to avoid web bundling issues
let _SecureStore: any = null;
function getSecureStore() {
  if (isWeb) return null;
  if (!_SecureStore) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _SecureStore = require("expo-secure-store");
  }
  return _SecureStore;
}

export async function saveToken(token: string) {
  if (isWeb) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch {}
    return;
  }
  const SS = getSecureStore();
  if (SS?.setItemAsync) await SS.setItemAsync(TOKEN_KEY, token);
}
export async function getToken() {
  if (isWeb) {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  const SS = getSecureStore();
  if (SS?.getItemAsync) return await SS.getItemAsync(TOKEN_KEY);
  return null;
}
export async function clearToken() {
  if (isWeb) {
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
    return;
  }
  const SS = getSecureStore();
  if (SS?.deleteItemAsync) await SS.deleteItemAsync(TOKEN_KEY);
}

export const api = axios.create({ baseURL: API_BASE, timeout: 20000 });

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
  const d = e?.response?.data?.detail;
  if (!d) return e?.message || "Something went wrong";
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x: any) => x.msg || JSON.stringify(x)).join(", ");
  return JSON.stringify(d);
}
