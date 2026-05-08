import axios from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";

export const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL as string;
export const API_BASE = `${BACKEND_URL}/api`;

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
