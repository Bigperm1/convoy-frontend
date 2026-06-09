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

// ===== Destination prediction =====
// Lightweight time-of-day heuristic over the Home/Work anchors:
//   weekday morning (4a-11a)        -> Work
//   weekday afternoon/evening (2p-10p) -> Home
//   everything else / weekends      -> Home (fallback Work)
// Returns the predicted place plus a short reason phrase the greeting can fold
// in, or null when we can't make a confident guess (no anchors saved, or the
// user is already sitting at the only candidate).
export type Prediction = { place: SavedPlace; reason: string } | null;

export function predictDestination(
  now: Date = new Date(),
  nearLat?: number,
  nearLng?: number
): Prediction {
  const home = getHome();
  const work = getWork();
  if (!home && !work) return null;

  const day = now.getDay(); // 0 = Sun ... 6 = Sat
  const hour = now.getHours();
  const isWeekday = day >= 1 && day <= 5;

  let target: SavedPlace | undefined;
  if (isWeekday && hour >= 4 && hour < 11) target = work || home;
  else if (isWeekday && hour >= 14 && hour < 22) target = home || work;
  else target = home || work;
  if (!target) return null;

  // Don't predict the place you're already parked at — if we're within 250 m of
  // the candidate, switch to the other anchor (or give up).
  if (typeof nearLat === "number" && typeof nearLng === "number") {
    if (haversineM(nearLat, nearLng, target.lat, target.lng) < 250) {
      const other = target.kind === "work" ? home : work;
      if (other && haversineM(nearLat, nearLng, other.lat, other.lng) >= 250) target = other;
      else return null;
    }
  }

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
