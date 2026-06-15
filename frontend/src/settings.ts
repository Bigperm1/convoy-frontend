// User-toggleable preferences persisted with AsyncStorage.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

const KEY = "convoy.settings.v3";

// Single source of truth for the base-map look (Mapbox light presets + satellite).
// Legacy mapType/mapDark are kept only for migration + the dormant Google engine,
// derived from mapMode via the helpers below.
export type MapMode = "satellite" | "dawn" | "day" | "dusk" | "night";

export type Settings = {
highlightConvoy: boolean;
alertSound: boolean;
avoidTolls: boolean;
avoidHighways: boolean;
avoidFerries: boolean;
activeCommunityId?: string | null;
activeThreadId?: string | null;
commsLive: boolean;
avatarLive: boolean;
mapView: "heading_up" | "north_up";
mapType: "hybrid" | "roadmap";
mapDark: boolean;
// Base-map mode — the single source of truth. Optional/undefined for users
// stored before it existed; getMapMode() migrates them from mapType/mapDark.
mapMode?: MapMode;
// Mapbox migration (Phase 2): when true, the map screen renders the new
// @rnmapbox/maps engine (ConvoyMapbox) instead of react-native-maps (ConvoyMap).
mapboxEngine: boolean;
novaGreeting: boolean;
novaSpeeding: boolean;
novaMidDrive: boolean;
// Master mute for all Nova nav/alert speech — toggled by the speaker button on
// the turn-by-turn banner. Persisted so a muted drive stays muted next time.
novaMuted: boolean;
speedUnit: 'kmh' | 'mph';
speedUnitManual: boolean;
showWeatherLayer: boolean;
weatherOnMigrated: boolean;
speedCameras: boolean;
showPlacePins: boolean;
showNearby: boolean;
// Gas Jockey — declutter the map's Gas pins by favorite brand + octane.
gasBrands?: Record<string, boolean>;          // brandKey -> shown; undefined = all shown
gasOther: boolean;                            // show unbranded / unrecognized stations
gasOctane?: '94' | '91' | '89' | '87' | null; // selected octane; null = show all
feedNA: boolean;
feedROW: boolean;
carYear?: string;
carMake?: string;
carModel?: string;
carColor?: string;
topSpeed?: number;
callSign?: string;
// Which music source the user picked in the Music tab ('apple' | 'spotify').
// null = not chosen yet → show the source-picker connect screen.
musicSource?: 'apple' | 'spotify' | null;
};

export const DEFAULT_SETTINGS: Settings = {
highlightConvoy: true,
alertSound: false,
avoidTolls: false,
avoidHighways: false,
avoidFerries: false,
activeCommunityId: null,
activeThreadId: null,
commsLive: true,
avatarLive: true,
mapView: "heading_up",
mapType: "hybrid",
mapDark: false,
mapboxEngine: true,
novaGreeting: true,
novaSpeeding: true,
novaMidDrive: true,
novaMuted: false,
speedUnit: 'kmh',
speedUnitManual: false,
showWeatherLayer: true,
weatherOnMigrated: true,
speedCameras: true,
showPlacePins: true,
showNearby: true,
gasBrands: undefined,
gasOther: true,
gasOctane: null,
feedNA: true,
feedROW: false,
carYear: undefined,
carMake: undefined,
carModel: undefined,
carColor: undefined,
topSpeed: undefined,
callSign: undefined,
musicSource: null,
};

// ---- Map mode helpers (single source of truth = settings.mapMode) ----
// Migrate users stored before mapMode existed: hybrid → satellite, roadmap+dark
// → night, roadmap+light → day.
export function legacyToMapMode(mapType?: string, mapDark?: boolean): MapMode {
  if (mapType === "hybrid") return "satellite";
  return mapDark ? "night" : "day";
}
// The effective mode: explicit mapMode if set, else derived from legacy fields.
// New default look (satellite) falls out of the legacy default (mapType "hybrid").
export function getMapMode(s: Settings): MapMode {
  return s.mapMode ?? legacyToMapMode(s.mapType, s.mapDark);
}
// Derive the legacy mapType/mapDark the Google/web engines still consume.
// dawn/day render light, dusk/night render dark on the (non-preset) Google map.
export function mapModeToLegacy(mode: MapMode): { mapType: "hybrid" | "roadmap"; mapDark: boolean } {
  if (mode === "satellite") return { mapType: "hybrid", mapDark: false };
  return { mapType: "roadmap", mapDark: mode === "dusk" || mode === "night" };
}

let cached: Settings = { ...DEFAULT_SETTINGS };
let loaded = false;
const listeners = new Set<(s: Settings) => void>();

const loadPromise: Promise<Settings> = (async () => {
try {
const raw = await AsyncStorage.getItem(KEY);
if (raw) {
const parsed = JSON.parse(raw);
cached = { ...DEFAULT_SETTINGS, ...parsed };
// One-time migration: the weather HUD now defaults ON. Existing installs have
// showWeatherLayer:false persisted from the old default (not from the user
// deliberately turning it off), so flip it on ONCE here. The weatherOnMigrated
// flag is then stored, so anyone who later turns weather OFF stays off —
// "on by default, off only if explicitly turned off."
if (parsed.weatherOnMigrated === undefined) {
cached.showWeatherLayer = true;
cached.weatherOnMigrated = true;
try { await AsyncStorage.setItem(KEY, JSON.stringify(cached)); } catch {}
}
}
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

// Backfill EMPTY local car fields from the backend profile. Local stays the
// source of truth for edits; this only fills blanks, so it restores the car
// after a fresh install / new build (which wipes AsyncStorage) without ever
// clobbering a selection the user just made. Keeps the car "attached to the
// account" instead of living only on the device.
export async function hydrateCarFromProfile(p: {
  car_make?: string | null;
  car_model?: string | null;
  car_color?: string | null;
  car_year?: number | null;
}): Promise<void> {
  await ensureSettingsLoaded();
  const patch: Partial<Settings> = {};
  if (!cached.carMake && p.car_make) patch.carMake = p.car_make;
  if (!cached.carModel && p.car_model) patch.carModel = p.car_model;
  if (!cached.carColor && p.car_color) patch.carColor = p.car_color;
  if (!cached.carYear && p.car_year != null) patch.carYear = String(p.car_year);
  if (Object.keys(patch).length) await updateSettings(patch);
}

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