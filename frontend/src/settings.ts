// User-toggleable preferences persisted with AsyncStorage.
// Used by the Settings screen and consumed by the map / feed hook.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

const KEY = "convoy.settings.v1";

export type Settings = {
  feedNA: boolean;          // North America Waze feed
  feedROW: boolean;         // International (Rest-of-World) Waze feed
  highlightConvoy: boolean; // Gold border around Convoy community reports
  alertSound: boolean;      // Chime when a new Convoy hazard appears
  // Route preferences (passed to Google Directions API as `avoid=...`)
  avoidTolls: boolean;
  avoidHighways: boolean;
  avoidFerries: boolean;
  // Per-community presence — when set, peer presence channel becomes `convoy:community:<id>`
  activeCommunityId?: string | null;
};

export const DEFAULT_SETTINGS: Settings = {
  feedNA: true,
  feedROW: false,
  highlightConvoy: true,
  alertSound: false,
  avoidTolls: false,
  avoidHighways: false,
  avoidFerries: false,
  activeCommunityId: null,
};

let cached: Settings = { ...DEFAULT_SETTINGS };
let loaded = false;
const listeners = new Set<(s: Settings) => void>();

const loadPromise: Promise<Settings> = (async () => {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) cached = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* keep defaults */ }
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

export function useSettings(): [Settings, (p: Partial<Settings>) => Promise<Settings>] {
  const [s, setS] = useState<Settings>(cached);
  useEffect(() => {
    let active = true;
    if (!loaded) {
      loadPromise.then((v) => { if (active) setS(v); });
    }
    listeners.add(setS);
    return () => { active = false; listeners.delete(setS); };
  }, []);
  return [s, updateSettings];
}

// Helper: build the feeds query param for /api/feed/external from current settings.
export function feedsQuery(s: Settings): string {
  const keys: string[] = [];
  if (s.feedNA) keys.push("na");
  if (s.feedROW) keys.push("row");
  return keys.join(",");
}
