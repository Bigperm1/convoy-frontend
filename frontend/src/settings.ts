// User-toggleable preferences persisted with AsyncStorage.
// Used by the Settings screen and consumed by the map / feed hook.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

// Storage key. We intentionally bump the version suffix when the schema or
// defaults change in a way that requires the device to start fresh — e.g.
// after the v1 mapView/orientation persistence was implicated in a Google
// Maps init crash, bumping to v2 dropped the stale "heading_up" preference
// and let the new Ready-State architecture warm up cleanly on first paint.
const KEY = "convoy.settings.v2";

export type Settings = {
  highlightConvoy: boolean; // Gold border around Convoy community reports
  alertSound: boolean;      // Chime when a new Convoy hazard appears
  // Route preferences (passed to Google Directions API as `avoid=...`)
  avoidTolls: boolean;
  avoidHighways: boolean;
  avoidFerries: boolean;
  // Per-community presence — when set, peer presence channel becomes `convoy:community:<id>`
  activeCommunityId?: string | null;
  // Privacy toggles
  //   commsLive  — when false, push-to-talk is suspended (no transmit, no playback)
  //   avatarLive — when false, the user's car disappears from the map for both
  //                themselves and every peer (we untrack from the presence channel)
  commsLive: boolean;
  avatarLive: boolean;
  // Map camera mode — exclusive radio choice.
  //   "heading_up": chase-cam (pitch 45°, map.bearing locked to user.heading,
  //                 car icon always points up). Default during navigation.
  //   "north_up":   classic flat top-down (pitch 0°, bearing 0°). Map stays
  //                 fixed north; the car silhouette rotates with heading.
  mapView: "heading_up" | "north_up";
  // Speed display units.
  //   'kmh' — metric (default)
  //   'mph' — imperial
  // The stored value is ALWAYS the resolved unit — the auto-detect logic
  // (reverse geocode at the user's current GPS location) writes 'mph' when
  // the driver is inside the USA and 'kmh' everywhere else. The user can
  // permanently override this via the Settings → SPEED UNITS toggle, which
  // sets `speedUnitManual: true` to suppress further auto-detect writes.
  speedUnit: 'kmh' | 'mph';
  speedUnitManual: boolean;
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
  // Default to "heading_up" — most drivers expect a Waze/Google-style chase
  // cam the moment they start driving. Users who prefer classic top-down can
  // switch in Settings → MAP VIEW; the choice persists across launches.
  mapView: "heading_up",
  // Default to KM/H. The map screen's reverse-geocode-on-first-fix flips this
  // to MPH automatically if the driver is inside the USA. Once a user toggles
  // manually, `speedUnitManual` flips to true and the auto path is suppressed.
  speedUnit: 'kmh',
  speedUnitManual: false,
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

// Helper kept as a no-op stub for legacy call sites. The external Waze-style
// feed was removed June 2025 — callers should just stop using this.
export function feedsQuery(_s: Settings): string {
  return "";
}

// Speed formatting — converts the device-reported speed (m/s) to the user's
// preferred display unit. Used by the Map speedometer HUD AND the Garage
// "Top Cruise Speed" card so both screens stay in sync with the toggle.
//   formatSpeed(13.4, 'kmh') → { value: 48, label: 'KM/H' }
//   formatSpeed(13.4, 'mph') → { value: 30, label: 'MPH' }
export function formatSpeed(speedMs: number, unit: 'kmh' | 'mph'): { value: number; label: string } {
  if (unit === 'mph') return { value: Math.round(speedMs * 2.23694), label: 'MPH' };
  return { value: Math.round(speedMs * 3.6), label: 'KM/H' };
}

// Convert a stored KM/H value (e.g. top_speed_record from the backend, which
// always lives in KM/H) into the user's current display unit. Returns an
// integer suitable for direct rendering.
export function kmhToDisplay(kmh: number, unit: 'kmh' | 'mph'): number {
  if (unit === 'mph') return Math.round(kmh * 0.621371);
  return Math.round(kmh);
}
