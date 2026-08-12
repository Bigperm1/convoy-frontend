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
// ── HOW THE PREDICTION IS DECIDED (rewritten 2026-08-12, Jeff) ───────────────
// He pushed back on the day/origin version, and he was right:
//   "not everyone's days are the same. Usually I come home from the lake on Mondays and
//    I'm at the lake Sundays. So this rule can't be true for everyone. It should take an
//    average of what happens on specific days and times to predict the route."
//
// The thing that made it "a rule" was the leftover STATIC WINDOWS — work = weekday
// 04:00-11:00, home = any day 14:00-23:00. Those encode one particular life. His Monday is
// the lake -> home, so a hardcoded weekday morning would have offered him WORK while he was
// standing at the lake — and the static path did not even consult the origin. Anyone on
// shifts, nights, or a four-day week had the same problem.
//
// So there are no windows any more, and nothing is assumed about what a day means. Every
// past departure simply VOTES for its destination, weighted by how much it resembles right
// now:
//
//   day     ONLY this weekday votes. Your Mondays predict your Monday and nothing else
//           does, because no other day can be assumed to resemble it.
//   time    a linear kernel around now — an 8:55 departure counts almost fully at 9:00 and
//           not at all two hours out. This is the "average of what happens at this time".
//   origin  a HARD gate. Leaving from here or not is the difference between "head to work"
//           and "head to the lake", and it is the signal the old model never had.
//
// A destination wins only if it clears MIN_SCORE and is clearly ahead of the runner-up;
// otherwise nothing is said. Silence is the right answer far more often than a guess, and
// guessing was the complaint.
//
// COST, accepted: a brand-new install predicts NOTHING until it has watched a few drives.
// That is deliberate. The feature now earns its confidence instead of asserting it.
// ⚠ ONLY TODAY COUNTS. Two earlier versions let other weekdays contribute, and simulation
// killed both:
//   - Blended, a frequent habit won on VOLUME: four Saturday departures for the lake scored
//     4.0 while sixteen Tue-Fri departures for home reached 3.3 just by being numerous, which
//     read as "ambiguous" and went silent on the exact case Jeff described.
//   - Kept separate as a fallback for a day with no history, it invented habits: a night-shift
//     tester who works Wed-Sat was told "heading to work" at 21:45 on a MONDAY, purely
//     because Wed-Sat look like that. That is the same wrongness in a new place.
// So a day with nothing to say says nothing. The cost is real and accepted: each weekday
// learns on its own, so a new day of the week is silent until it has been seen a couple of
// times. Silence is what was asked for — being wrong was the complaint.
// Two clean same-day matches from the right place, or a handful of weaker ones.
const MIN_SCORE = 1.4;
// The winner must be this much better than the runner-up, else the moment is ambiguous
// (e.g. you leave for two different places at the same hour) and we stay quiet.
const WIN_RATIO = 1.6;

function circMinDiff(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 1440 - d);
}

/** One destination's vote total for (now, here), plus how many departures backed it. */
type Vote = { key: string; score: number; sameDay: number; total: number };

function tallyVotes(now: Date, lat?: number, lng?: number): Map<string, Vote> {
  const nowM = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();
  const out = new Map<string, Vote>();
  for (const sm of departLog) {
    const dt = circMinDiff(nowM, sm.m);
    if (dt > DEPART_WINDOW_MIN) continue;                       // outside the kernel
    // ORIGIN GATE. Samples recorded before this existed have no origin; they cannot be
    // judged, so they still count — otherwise every existing user would go silent.
    const hasOrigin = typeof sm.oLat === "number" && typeof sm.oLng === "number";
    if (hasOrigin && typeof lat === "number" && typeof lng === "number") {
      if (haversineM(lat, lng, sm.oLat as number, sm.oLng as number) > ORIGIN_MATCH_M) continue;
    }
    const timeW = 1 - dt / DEPART_WINDOW_MIN;                   // linear falloff to 0
    if (sm.d !== day) continue;                                 // only this weekday votes
    const v = out.get(sm.k) || { key: sm.k, score: 0, sameDay: 0, total: 0 };
    v.score += timeW;
    v.sameDay += 1;
    v.total += 1;
    out.set(sm.k, v);
  }
  return out;
}

// ===== Destination prediction =====
// Purely learned: candidates are whatever your own departures vote for, right now, from
// here. Being parked AT a candidate excludes it (never flip to the other anchor — the
// 2026-07 bug this file's history is about).
export type Prediction = { place: SavedPlace; reason: string } | null;

export function predictDestination(
  now: Date = new Date(),
  nearLat?: number,
  nearLng?: number
): Prediction {
  const home = getHome();
  const work = getWork();
  const customs = cached.filter((p) => p.kind === "custom");
  const places = [work, home, ...customs].filter(Boolean) as SavedPlace[];
  if (places.length === 0) return null;

  const parkedAt = (p: SavedPlace) =>
    typeof nearLat === "number" && typeof nearLng === "number" &&
    haversineM(nearLat, nearLng, p.lat, p.lng) < 250;

  const votes = tallyVotes(now, nearLat, nearLng);
  const live = places.filter((p) => !parkedAt(p))
    .map((p) => ({ place: p, v: votes.get(departKey(p)) }))
    .filter((r) => !!r.v) as { place: SavedPlace; v: Vote }[];
  if (live.length === 0) return null;

  const ranked = live.sort((a, b) => b.v.score - a.v.score || b.v.sameDay - a.v.sameDay);
  const best = ranked[0].v.score;
  if (best < MIN_SCORE) return null;                            // not confident enough
  const runnerUp = ranked[1] ? ranked[1].v.score : 0;
  if (runnerUp > 0 && best < runnerUp * WIN_RATIO) return null;  // ambiguous → quiet

  const target = ranked[0].place;
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
