// User-toggleable preferences persisted with AsyncStorage.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

const KEY = "convoy.settings.v3";

export type Settings = {
  highlightConvoy: boolean;
  alertSound: boolean;
  avoidTolls: boolean;
  avoidHighways: boolean;
  avoidFerries: boolean;
  activeCommunityId?: string | null;
  commsLive: boolean;
  avatarLive: boolean;
  mapView: "heading_up" | "north_up";
  speedUnit: 'kmh' | 'mph';
  speedUnitManual: boolean;
  // ---- Map Layer Toggles ----
  // Weather layer — shows current conditions (precip, temp, wind) from
  // the Google Weather API as an overlay on the map.
  showWeatherLayer: boolean;
  // 3D Map layer — switches react-native-maps to mapType="hybridFlyover"
  // on iOS (or "hybrid" on Android) to show 3D building extrusions.
  show3DMap: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  highlightConvoy: true,
  alertSound: false,
  avoidTolls: false,
  avoidHighways: false,
  avoidFerries: false,
  activeCommunityId: null,
  commsLive: true,
  avatarLive: true,
  mapView: "heading_up",
  speedUnit: 'kmh',
  speedUnitManual: false,
  showWeatherLayer: false,
  show3DMap: false,
};

let cached: Settings = { ...DEFAULT_SETTINGS };
let loaded = false;
const listeners = new Set<(s: Settings) => void>();

const loadPromise: Promise<Settings> = (async () => {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) cached = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  loaded = true;
  listeners.forEach((l) => l(cached));
  return cached;
})();

export async function ensureSettingsLoaded(): Promise<Settings> {
  return loaded ? cached : loadPromise;
}

export function getSettings(): Settings { return cached; }

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  cached = { ...cached, ...patch };
  try { await AsyncStorage.setItem(KEY, JSON.stringify(cached)); } catch {}
  listeners.forEach((l) => l(cached));
  return cached;
}

// Alias kept for backward-compat — callers that used updateGlobalSettings still compile.
export const updateGlobalSettings = updateSettings;

export function useSettings(): [Settings, (p: Partial<Settings>) => Promise<Settings>] {
  const [s, setS] = useState<Settings>(cached);
  useEffect(() => {
    let active = true;
    if (!loaded) { loadPromise.then((v) => { if (active) setS(v); }); }
    listeners.add(setS);
    return () => { active = false; listeners.delete(setS); };
  }, []);
  return [s, updateSettings];
}

export function feedsQuery(_s: Settings): string { return ""; }

export function formatSpeed(speedMs: number, unit: 'kmh' | 'mph'): { value: number; label: string } {
  if (unit === 'mph') return { value: Math.round(speedMs * 2.23694), label: 'MPH' };
  return { value: Math.round(speedMs * 3.6), label: 'KM/H' };
}

export function kmhToDisplay(kmh: number, unit: 'kmh' | 'mph'): number {
  if (unit === 'mph') return Math.round(kmh * 0.621371);
  return Math.round(kmh);
}
