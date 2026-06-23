// User-toggleable preferences persisted with AsyncStorage.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

const KEY = "convoy.settings.v3";
// Separate key for the last-known GPS location (see getLastLocation). Kept out of
// the Settings object so writing it never broadcasts to settings listeners.
const LAST_LOC_KEY = "convoy.lastlocation.v1";

// Single source of truth for the base-map look (Mapbox light presets + satellite).
// Legacy mapType/mapDark are kept only for migration + the dormant Google engine,
// derived from mapMode via the helpers below.
export type MapMode = "satellite" | "dawn" | "day" | "dusk" | "night";

// Avatar Live privacy mode — replaces the old avatarLive boolean. Optional for
// users stored before it existed; getAvatarMode() migrates them (avatarLive
// true → "full", false → "ghost"). NOT added to DEFAULT_SETTINGS on purpose, so
// an existing user who had Avatar Live OFF isn't silently flipped to visible by
// the settings-spread — their intent is read from the legacy boolean instead.
//   full    = always on the convoy map: live while car-connected, parked at your
//             last car location when not (never your real non-driving spot).
//   partial = visible only while connected to the car; disconnect drops you off
//             peers' maps until you reconnect.
//   ghost   = never visible to the convoy, driving or parked.
export type AvatarMode = "full" | "partial" | "ghost";

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
// Avatar Live privacy mode (source of truth). avatarLive is kept in sync as a
// legacy-compat mirror: full/partial → true, ghost → false. See AvatarMode.
avatarMode?: AvatarMode;
mapView: "heading_up" | "north_up";
mapType: "hybrid" | "roadmap";
mapDark: boolean;
// Base-map mode — the single source of truth. Optional/undefined for users
// stored before it existed; getMapMode() migrates them from mapType/mapDark.
mapMode?: MapMode;
// Mapbox migration (Phase 2): when true, the map screen renders the new
// @rnmapbox/maps engine (ConvoyMapbox) instead of react-native-maps (ConvoyMap).
mapboxEngine: boolean;
// 3D buildings on the Standard (non-satellite) Mapbox modes. User toggle; when
// false the self-car can never be hidden behind a building. Maps to the Mapbox
// Standard style's show3dObjects config.
show3dBuildings: boolean;
novaGreeting: boolean;
novaSpeeding: boolean;
novaMidDrive: boolean;
// Master mute for all Nova nav/alert speech — toggled by the speaker button on
// the turn-by-turn banner. Persisted so a muted drive stays muted next time.
novaMuted: boolean;
// Master on/off for ALL Nova voice (settings-screen switch, above the granular
// toggles). When false nothing speaks — greeting, callouts, quips, alerts.
novaVoice: boolean;
// Spoken reroute reaction (the "split decision" quip on recompute). Off →
// reroutes are silent; turn-by-turn guidance is unaffected.
novaReroute: boolean;
// One-time migration flag: when absent from stored settings, flip the three
// chatty Nova toggles (speeding / mid-drive / reroute) OFF once so the new
// quieter defaults reach existing installs too, then never repeat.
novaQuietMigrated: boolean;
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
// Developer: show on-screen diagnostic overlays (map HDG/SL + CarPlay DBG strip).
// Off by default so the screen is clean; toggled in Settings.
debugOverlays: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
highlightConvoy: true,
alertSound: true,
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
// Default base-map look is Dusk (mapMode is the source of truth for the Mapbox
// engine; users who never picked a mode inherit this).
mapMode: "dusk",
mapboxEngine: true,
show3dBuildings: true,
novaGreeting: true,
novaSpeeding: false,
novaMidDrive: false,
novaMuted: false,
novaVoice: true,
novaReroute: false,
novaQuietMigrated: true,
speedUnit: 'kmh',
speedUnitManual: false,
showWeatherLayer: true,
weatherOnMigrated: true,
speedCameras: true,
showPlacePins: true,
showNearby: true,
// Default Gas Jockey: only the four major BC chains shown; the rest (and
// unbranded "Other") hidden until the driver re-enables them. Octane defaults
// to premium (94 / "High Octane Premium").
gasBrands: { shell: true, chevron: true, petrocan: true, esso: true, husky: false, mobil: false, coop: false, costco: false, canadiantire: false, ultramar: false, pioneer: false, circlek: false },
gasOther: false,
gasOctane: '94',
feedNA: true,
feedROW: false,
carYear: undefined,
carMake: undefined,
carModel: undefined,
carColor: undefined,
topSpeed: undefined,
callSign: undefined,
musicSource: null,
debugOverlays: false,
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

// ---- Avatar Live mode helpers (source of truth = settings.avatarMode) ----
// Migrate users stored before avatarMode existed: avatarLive true → "full",
// false → "ghost" (old installs only had the on/off boolean).
export function getAvatarMode(s: Settings): AvatarMode {
  return s.avatarMode ?? (s.avatarLive ? "full" : "ghost");
}
// Persist a new Avatar Live mode and keep the legacy avatarLive boolean in sync
// (full/partial → true, ghost → false) so any older reader still behaves.
export async function setAvatarMode(mode: AvatarMode): Promise<Settings> {
  return updateSettings({ avatarMode: mode, avatarLive: mode !== "ghost" });
}

let cached: Settings = { ...DEFAULT_SETTINGS };
let loaded = false;
// Last-known GPS location (cold-start map framing). Declared HERE — above the
// loadPromise IIFE that hydrates it — so it isn't used before declaration.
// Getter/setter + docs live further below.
let lastLocation: { lat: number; lng: number } | null = null;
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
// One-time: adopt the quieter Nova defaults (speed alerts / mid-drive / reroute
// quip OFF) for installs stored before novaQuietMigrated existed.
if (parsed.novaQuietMigrated === undefined) {
cached.novaSpeeding = false;
cached.novaMidDrive = false;
cached.novaReroute = false;
cached.novaQuietMigrated = true;
try { await AsyncStorage.setItem(KEY, JSON.stringify(cached)); } catch {}
}
}
} catch {}
// Hydrate the last-known location too (separate key) as part of this early load,
// so the first map paint can frame the driver without waiting on a GPS fix.
try { const lraw = await AsyncStorage.getItem(LAST_LOC_KEY); if (lraw) lastLocation = JSON.parse(lraw); } catch {}
loaded = true;
listeners.forEach((l) => l(cached));
return cached;
})();

export async function ensureSettingsLoaded(): Promise<Settings> {
return loaded ? cached : loadPromise;
}

export function getSettings(): Settings { return cached; }

// ---- Last-known GPS location (cold-start map framing) ----
// Persisted SEPARATELY from Settings and WITHOUT notifying listeners, so the
// frequent position writes from the map never trigger a settings re-render. Read
// synchronously at the first map paint so the map opens framed on the driver's
// last spot instead of flying in from the world view. Hydrated in loadPromise.
// (The `lastLocation` variable is declared up by `cached`/`loaded` so the
// loadPromise hydration above doesn't reference it before declaration.)
export function getLastLocation(): { lat: number; lng: number } | null { return lastLocation; }
export function setLastLocation(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  lastLocation = { lat, lng };
  AsyncStorage.setItem(LAST_LOC_KEY, JSON.stringify(lastLocation)).catch(() => {});
}

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

// Road-speed unit by ISO-3166-1 alpha-2 country code. The world is metric (km/h)
// except a short list that posts mph — the US, the UK, and a handful of mostly
// Caribbean / British-legacy / US territories. Anything not in the set is km/h.
const MPH_COUNTRIES = new Set([
  "US", "GB", "LR",
  "AG", "BS", "BZ", "DM", "GD", "KN", "LC", "VC",
  "AI", "FK", "GG", "IM", "JE", "KY", "MS", "SH", "TC", "VG",
  "AS", "GU", "MP", "PR", "VI",
]);
export function unitForCountry(cc?: string | null): 'kmh' | 'mph' {
  if (!cc) return 'kmh';
  return MPH_COUNTRIES.has(cc.toUpperCase()) ? 'mph' : 'kmh';
}