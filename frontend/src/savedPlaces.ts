// Saved places (Home / Work / custom), persisted with AsyncStorage. This is the
// foundation for two features: destination PREDICTION (when you open Convoy /
// connect the car, guess where you're going) and the personable Nova route-
// start greeting (so she can say "heading to work" instead of a raw address).
//
// Mirrors the storage/hook shape of settings.ts: a module-level cache + a
// listener set + a load promise, exposed through a useSavedPlaces() hook and
// imperative get/save/remove helpers. Local-only for now (no backend sync);
// a fresh install starts empty, same as the old car fields did before profile
// hydration was added.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

const KEY = "convoy.savedPlaces.v1";

export type SavedPlaceKind = "home" | "work" | "custom";

export type SavedPlace = {
  id: string;
  kind: SavedPlaceKind;
  label: string; // "Home", "Work", or a custom name e.g. "Gym"
  lat: number;
  lng: number;
  address?: string;
  createdAt: number;
};

let cached: SavedPlace[] = [];
let loaded = false;
const listeners = new Set<(p: SavedPlace[]) => void>();

function isValidPlace(p: any): p is SavedPlace {
  return (
    p &&
    typeof p.id === "string" &&
    (p.kind === "home" || p.kind === "work" || p.kind === "custom") &&
    typeof p.lat === "number" &&
    typeof p.lng === "number" &&
    typeof p.label === "string"
  );
}

const loadPromise: Promise<SavedPlace[]> = (async () => {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) cached = parsed.filter(isValidPlace);
    }
  } catch {}
  loaded = true;
  listeners.forEach((l) => l(cached));
  return cached;
})();

async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(cached));
  } catch {}
  listeners.forEach((l) => l(cached));
}

export async function ensureSavedPlacesLoaded(): Promise<SavedPlace[]> {
  return loaded ? cached : loadPromise;
}

export function getSavedPlaces(): SavedPlace[] {
  return cached;
}

function genId(): string {
  return "sp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Add or replace a saved place. Home and Work are SINGLETONS — saving a new one
// replaces the existing entry of that kind (you only have one home / one work).
// Custom places stack. Returns the updated list.
export async function saveSavedPlace(input: {
  kind: SavedPlaceKind;
  label?: string;
  lat: number;
  lng: number;
  address?: string;
}): Promise<SavedPlace[]> {
  await ensureSavedPlacesLoaded();
  const place: SavedPlace = {
    id: genId(),
    kind: input.kind,
    label:
      (input.label && input.label.trim()) ||
      (input.kind === "home" ? "Home" : input.kind === "work" ? "Work" : "Saved place"),
    lat: input.lat,
    lng: input.lng,
    address: input.address,
    createdAt: Date.now(),
  };
  if (input.kind === "home" || input.kind === "work") {
    cached = [place, ...cached.filter((p) => p.kind !== input.kind)];
  } else {
    cached = [place, ...cached];
  }
  await persist();
  return cached;
}

export async function removeSavedPlace(id: string): Promise<SavedPlace[]> {
  await ensureSavedPlacesLoaded();
  cached = cached.filter((p) => p.id !== id);
  await persist();
  return cached;
}

export function getHome(): SavedPlace | undefined {
  return cached.find((p) => p.kind === "home");
}

export function getWork(): SavedPlace | undefined {
  return cached.find((p) => p.kind === "work");
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Recognize a destination coordinate as a saved place (within ~160 m) so the
// greeting can name it ("heading to Work") rather than read a raw address.
// Returns the closest match, or undefined.
const MATCH_RADIUS_M = 160;
export function matchSavedPlace(lat: number, lng: number): SavedPlace | undefined {
  let best: SavedPlace | undefined;
  let bestD = Infinity;
  for (const p of cached) {
    const d = haversineM(lat, lng, p.lat, p.lng);
    if (d < MATCH_RADIUS_M && d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

// Resolve a deep-link / shortcut target string ("work", "home", or a custom
// label) to a saved place. Case-insensitive. Used by the convoy://go?to= link.
export function resolveTarget(target: string): SavedPlace | undefined {
  const t = (target || "").trim().toLowerCase();
  if (!t) return undefined;
  if (t === "home") return getHome();
  if (t === "work") return getWork();
  return cached.find((p) => p.label.toLowerCase() === t) || cached.find((p) => p.id === target);
}

// ===== Departure-time learning (Departure IQ v2) =====
// Jeff (2026-07-17): "this should be time-sensitive to when you usually leave
// for work and go home" — after arriving HOME in the evening, the app offered
// WORK. Root cause was the old anti-"predict where you already are" guard: the
// evening pick was Home, he was AT home, and the guard FLIPPED to the other
// anchor instead of staying quiet. v2: every nav start toward a saved place
// logs the departure time; predictions only surface within ±75 min of the
// MEDIAN learned departure for that place (weekday and weekend learned
// separately). No learned data yet → conservative static windows (work =
// weekday morning, home = weekday afternoon/evening), and being parked at a
// candidate now EXCLUDES it — never flips to the other. Custom places learn
// too (keyed by id), so "gym Tuesdays" starts predicting after a few drives.
type DepartSample = { k: string; m: number; d: number; ts: number }; // key, minutes-of-day, weekday, when
const DEPART_KEY = "convoy.departLog.v1";
const DEPART_CAP = 240;      // rolling cap across all places
const DEPART_WINDOW_MIN = 75; // suggest within ±75 min of the learned median
const LEARN_MIN_SAMPLES = 3;  // fewer than this → fall back to static windows
let departLog: DepartSample[] = [];
const departLoad: Promise<void> = (async () => {
  try {
    const raw = await AsyncStorage.getItem(DEPART_KEY);
    if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) departLog = p.filter((s: any) => s && typeof s.k === "string" && typeof s.m === "number"); }
  } catch {}
})();

function departKey(p: SavedPlace): string { return p.kind === "custom" ? p.id : p.kind; }

// Log a real departure toward a saved place (call at nav start). Fire-and-forget.
export function recordDeparture(place: SavedPlace, when: Date = new Date()): void {
  void departLoad.then(() => {
    departLog.push({ k: departKey(place), m: when.getHours() * 60 + when.getMinutes(), d: when.getDay(), ts: when.getTime() });
    if (departLog.length > DEPART_CAP) departLog = departLog.slice(-DEPART_CAP);
    AsyncStorage.setItem(DEPART_KEY, JSON.stringify(departLog)).catch(() => {});
  });
}

// true = now is inside the learned window; false = learned data says NOT now;
// null = not enough samples to judge (caller falls back to static windows).
function inLearnedWindow(key: string, now: Date): boolean | null {
  const wk = now.getDay() >= 1 && now.getDay() <= 5;
  const samples = departLog.filter((s) => s.k === key && (s.d >= 1 && s.d <= 5) === wk);
  if (samples.length < LEARN_MIN_SAMPLES) return null;
  const mins = samples.map((s) => s.m).sort((a, b) => a - b);
  const med = mins[Math.floor(mins.length / 2)];
  const nowM = now.getHours() * 60 + now.getMinutes();
  const diff = Math.min(Math.abs(nowM - med), 1440 - Math.abs(nowM - med)); // circular day
  return diff <= DEPART_WINDOW_MIN;
}

// ===== Destination prediction =====
// Candidates: Home + Work always; custom places once they have learned data.
// A candidate survives only if (a) its learned window says NOW (or, with no
// data yet, its static window does), and (b) you're not parked at it. If
// nothing survives, we stay quiet — no more flip-to-the-other-anchor.
export type Prediction = { place: SavedPlace; reason: string } | null;

export function predictDestination(
  now: Date = new Date(),
  nearLat?: number,
  nearLng?: number
): Prediction {
  const home = getHome();
  const work = getWork();
  const customs = cached.filter((p) => p.kind === "custom");
  if (!home && !work && customs.length === 0) return null;

  const day = now.getDay();
  const hour = now.getHours();
  const isWeekday = day >= 1 && day <= 5;
  const parkedAt = (p: SavedPlace) =>
    typeof nearLat === "number" && typeof nearLng === "number" &&
    haversineM(nearLat, nearLng, p.lat, p.lng) < 250;

  const staticWindow = (p: SavedPlace): boolean => {
    if (p.kind === "work") return isWeekday && hour >= 4 && hour < 11;
    if (p.kind === "home") return hour >= 14 && hour < 23; // any day: afternoons/evenings point home
    return false; // custom places only predict once LEARNED
  };

  const candidates: { place: SavedPlace; learned: boolean }[] = [];
  for (const p of [work, home, ...customs]) {
    if (!p || parkedAt(p)) continue;
    const learned = inLearnedWindow(departKey(p), now);
    if (learned === true) candidates.push({ place: p, learned: true });
    else if (learned === null && staticWindow(p)) candidates.push({ place: p, learned: false });
    // learned === false → the data says you don't leave for this place now → excluded
  }
  if (candidates.length === 0) return null;
  // Learned matches beat static guesses; ties keep the [work, home, customs] priority.
  candidates.sort((a, b) => Number(b.learned) - Number(a.learned));
  const target = candidates[0].place;

  const reason =
    target.kind === "work" ? "heading to work" : target.kind === "home" ? "heading home" : `heading to ${target.label}`;
  return { place: target, reason };
}

export function useSavedPlaces(): [
  SavedPlace[],
  typeof saveSavedPlace,
  typeof removeSavedPlace
] {
  const [list, setList] = useState<SavedPlace[]>(cached);
  useEffect(() => {
    let active = true;
    if (!loaded) {
      loadPromise.then((v) => {
        if (active) setList(v);
      });
    }
    listeners.add(setList);
    return () => {
      active = false;
      listeners.delete(setList);
    };
  }, []);
  return [list, saveSavedPlace, removeSavedPlace];
}
