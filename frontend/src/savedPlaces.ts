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
// oLat/oLng = WHERE YOU LEFT FROM. Optional because samples logged before 2026-08-12 do
// not have it; those are treated as matching any origin so the feature never goes silent
// on existing data (see originMatches).
type DepartSample = { k: string; m: number; d: number; ts: number; oLat?: number; oLng?: number };
const DEPART_KEY = "convoy.departLog.v1";
const DEPART_CAP = 240;      // rolling cap across all places
const DEPART_WINDOW_MIN = 75; // suggest within ±75 min of the learned median
const LEARN_MIN_SAMPLES = 3;  // fewer than this → fall back to static windows
// ── WHY A TIME OF DAY WAS NEVER ENOUGH (Jeff, 2026-08-12) ────────────────────
// "the predictive route is really annoying — every time I open the app or every time I
//  finish a route Scout tells me 'heading to the lake, about 3:40'. Personally I go to the
//  lake on Saturday after work. Every other day from work I head home, and every morning at
//  9am I head to work."
//
// Read that as a spec and it names three things this model did not have:
//   DAY      the lake is SATURDAY. Sat and Sun shared one "weekend" bucket, so a Saturday
//            habit predicted itself on Sunday too, and all five weekdays were pooled.
//   ORIGIN   "from work I head home" and "at 9am I head to work" are the same clock in
//            different places. Samples recorded only a TIME, so nothing could tell them
//            apart — which is how standing at home in the morning suggested the lake.
//   INTENT   it fired while he was arriving, not departing (see the arrive-hush in map.tsx).
//
// How far from a remembered departure point still counts as "leaving from there". 300 m
// covers a work car park or a long driveway without merging two genuinely different origins.
const ORIGIN_MATCH_M = 300;
let departLog: DepartSample[] = [];
const departLoad: Promise<void> = (async () => {
  try {
    const raw = await AsyncStorage.getItem(DEPART_KEY);
    if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) departLog = p.filter((s: any) => s && typeof s.k === "string" && typeof s.m === "number"); }
  } catch {}
})();

function departKey(p: SavedPlace): string { return p.kind === "custom" ? p.id : p.kind; }

// Log a real departure toward a saved place (call at nav start). Fire-and-forget.
export function recordDeparture(
  place: SavedPlace,
  when: Date = new Date(),
  origin?: { lat: number; lng: number },
): void {
  void departLoad.then(() => {
    departLog.push({
      k: departKey(place), m: when.getHours() * 60 + when.getMinutes(),
      d: when.getDay(), ts: when.getTime(),
      ...(origin && typeof origin.lat === "number" && typeof origin.lng === "number"
        ? { oLat: origin.lat, oLng: origin.lng } : {}),
    });
    if (departLog.length > DEPART_CAP) departLog = departLog.slice(-DEPART_CAP);
    AsyncStorage.setItem(DEPART_KEY, JSON.stringify(departLog)).catch(() => {});
  });
}

// true = now is inside the learned window; false = learned data says NOT now;
// null = not enough samples to judge (caller falls back to static windows).
// Samples for this destination on a comparable DAY.
// Exact day-of-week first, because a Saturday habit is not a Sunday habit. Only if that is
// too thin do we pool — and only Mon-Fri with Mon-Fri. Saturday and Sunday are never pooled
// with each other or with the working week, which is the whole reason a Saturday lake trip
// used to suggest itself on a Sunday morning.
function daySamples(key: string, now: Date): { rows: DepartSample[]; exactDay: boolean } {
  const day = now.getDay();
  const exact = departLog.filter((s) => s.k === key && s.d === day);
  if (exact.length >= LEARN_MIN_SAMPLES) return { rows: exact, exactDay: true };
  const isWeekday = day >= 1 && day <= 5;
  if (!isWeekday) return { rows: exact, exactDay: true };   // Sat/Sun stand alone
  return { rows: departLog.filter((s) => s.k === key && s.d >= 1 && s.d <= 5), exactDay: false };
}

// Does the driver's CURRENT position look like a place they have actually left from for
// this destination? Legacy samples carry no origin — if none of them do, we cannot judge it
// and must not start refusing, so it passes. Once origins exist, they decide.
function originMatches(rows: DepartSample[], lat?: number, lng?: number): boolean {
  const withOrigin = rows.filter((s) => typeof s.oLat === "number" && typeof s.oLng === "number");
  if (withOrigin.length === 0) return true;                       // nothing learned yet
  if (typeof lat !== "number" || typeof lng !== "number") return true;
  return withOrigin.some((s) => haversineM(lat, lng, s.oLat as number, s.oLng as number) <= ORIGIN_MATCH_M);
}

// true  = now (and here) is inside the learned habit
// false = the learned data says NOT now / NOT from here
// null  = not enough samples to judge (caller falls back to static windows)
// `offBy` is how far the learned median is from now, so a caller can prefer the tighter fit
// when two habits both match.
function inLearnedWindow(
  key: string, now: Date, lat?: number, lng?: number,
): { hit: boolean; offBy: number; exactDay: boolean } | null {
  const { rows, exactDay } = daySamples(key, now);
  if (rows.length < LEARN_MIN_SAMPLES) return null;
  const mins = rows.map((s) => s.m).sort((a, b) => a - b);
  const med = mins[Math.floor(mins.length / 2)];
  const nowM = now.getHours() * 60 + now.getMinutes();
  const diff = Math.min(Math.abs(nowM - med), 1440 - Math.abs(nowM - med)); // circular day
  if (diff > DEPART_WINDOW_MIN) return { hit: false, offBy: diff, exactDay };
  // Right time — but is it the right place to be leaving from?
  if (!originMatches(rows, lat, lng)) return { hit: false, offBy: diff, exactDay };
  return { hit: true, offBy: diff, exactDay };
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

  const candidates: { place: SavedPlace; learned: boolean; offBy: number; exactDay: boolean }[] = [];
  for (const p of [work, home, ...customs]) {
    if (!p || parkedAt(p)) continue;
    const L = inLearnedWindow(departKey(p), now, nearLat, nearLng);
    if (L && L.hit) candidates.push({ place: p, learned: true, offBy: L.offBy, exactDay: L.exactDay });
    else if (L === null && staticWindow(p)) candidates.push({ place: p, learned: false, offBy: 9999, exactDay: false });
    // L.hit === false → the data says you don't leave for this place now, or not from
    // here → excluded. Staying quiet is the correct answer far more often than guessing.
  }
  if (candidates.length === 0) return null;
  // A learned habit beats a static guess. Between two learned habits, prefer the one
  // learned for THIS day of the week, then the one whose usual time is closest to now —
  // that is what lets "Saturday after work -> the lake" outrank the everyday "-> home"
  // without either being hardcoded. Ties still keep the [work, home, customs] order.
  candidates.sort((a, b) =>
    Number(b.learned) - Number(a.learned)
    || Number(b.exactDay) - Number(a.exactDay)
    || a.offBy - b.offBy);
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
