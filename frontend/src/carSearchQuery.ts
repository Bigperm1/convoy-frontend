// carSearchQuery.ts — the head-unit search box's QUERY rules. Pure: no React, no native, no
// store, so the sim-qc gate (tools/sim-qc/car_search_test.mts) runs it under plain Node, and
// carActions.ts — a nav-locked file where new module-scope constants are forbidden — only
// calls it. Both car surfaces (CarPlay CPSearchTemplate, Android Auto's native SearchTemplate)
// go through these three functions.
//
// WHY (Say Phin, Android Auto, 2026-09-24 — "Voice search failed. Even saying my full address"):
// the AA host's voice input TYPES the spoken phrase into our search box verbatim. His photo showed
// the box holding "navigate home" and the rows "Navigate Homes, Coralville IA", "Navigate Home
// NWA, Bentonville AR", "Navigate Home Health Care…" — Google Places (New) matched the literal
// phrase, and the 50 km `locationBias` around the car is a BIAS, not a filter, so with no local
// match the far ones won. Saved places (Home/Work) were listed only for an EMPTY query.
// Memory: field-2026-09-24-tester-chat-compass-poll-and-three-issues.
//
// Three fixes, one module:
//   1. normalizeCarQuery — strip the leading command words a voice assistant adds
//      ("navigate to", "take me to", "go to", "drive to", "directions to", "get me to", …).
//   2. matchSavedPlace — the normalised text against the driver's saved-place labels, with the
//      spoken aliases ("my house" → Home, "the office" → Work). The caller puts that row FIRST.
//   3. carSearchRestriction + pickCarSearchScope — a `locationRestriction` rectangle for Places,
//      used as a TAIL FILTER, never as the only request. Google caps a circle at 50 000 m for
//      BOTH bias and restriction ("The radius must be between 0.0 and 50000.0, inclusive",
//      Places (New) Autocomplete docs, read 2026-09-24) and allows only one of the two per
//      request, so the 150 km restriction Jeff asked for is a rectangle, and the caller sends it
//      IN PARALLEL with the old 50 km-biased request. MEASURED live 2026-09-24 (production key,
//      car at 49.28,-123.12): restricted "navigate home" → 0 rows (the Iowa/Arkansas rows gone);
//      restricted "home" → 5 BC rows; but restricted "Kamloops" → 5 local STREETS named Kamloops
//      while the biased request put "Kamloops, BC, Canada" (250 km) first. A restriction alone,
//      or a fall-back-when-empty, would hide the city behind its namesake streets — so the
//      restricted rows win only when Google's own first biased row is local too.

/** Leading command phrases a voice assistant types ahead of the place. Whole words, case-
 *  insensitive, ONE stripped per query, longest first so "navigate me to" wins over "navigate".
 *  Bare "drive"/"go"/"directions" are NOT here on purpose: "Drive Thru Cafe", "Golden Ears"
 *  and "Directions Ave" are places. */
export const CAR_SEARCH_COMMANDS: readonly string[] = [
  "navigate me to", "navigate to", "navigate",
  "take me to", "take me",
  "bring me to", "get me to",
  "drive me to", "drive to",
  "directions to", "directions for",
  "route me to", "route to",
  "let's go to", "lets go to", "go to", "head to",
];
/** Leading fillers stripped before the command ("please navigate to work", "ok take me home"). */
export const CAR_SEARCH_FILLERS: readonly string[] = ["please", "ok", "okay", "hey"];
/** Spoken names for the two fixed saved places. Exact match after normalising. */
export const CAR_SEARCH_HOME_ALIASES: readonly string[] = ["home", "my home", "my house", "the house", "house", "my place", "back home"];
export const CAR_SEARCH_WORK_ALIASES: readonly string[] = ["work", "my work", "the office", "office", "my office", "my job", "job"];
/** Half-side of the Places `locationRestriction` rectangle around the car, km. Jeff's number
 *  (2026-09-24: "a 150 km circle around the car"); from Vancouver it holds Whistler (~100 km)
 *  and Hope (~120 km) and drops Kamloops (~250 km) and Seattle (~190 km) — those come back
 *  through the caller's biased fallback request. */
export const CAR_SEARCH_RESTRICT_KM = 150;
/** Places `includedRegionCodes` — the club drives in BC and across the border, nowhere else. */
export const CAR_SEARCH_REGIONS: readonly string[] = ["ca", "us"];
/** The `car-search` crumb waits this long after the last keystroke before it writes, so a typed
 *  query costs one row, not one per letter (Places is called per keystroke regardless). */
export const CAR_SEARCH_CRUMB_QUIET_MS = 900;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Longest phrase first so the alternation cannot stop at a shorter prefix ("navigate" before "navigate to").
const COMMAND_RE = new RegExp(
  "^(?:" + CAR_SEARCH_COMMANDS.slice().sort((a, b) => b.length - a.length).map(escapeRe).join("|") + ")(?=[\\s,;:]|$)",
  "i",
);
const FILLER_RE = new RegExp("^(?:" + CAR_SEARCH_FILLERS.map(escapeRe).join("|") + ")(?=\\s|$)", "i");

/** The text Places should see: whitespace collapsed, trailing punctuation gone, one leading
 *  filler and one leading command phrase removed, a trailing "please" removed. Case is kept.
 *  A query that was ONLY a command ("navigate") comes back EMPTY — the caller then shows the
 *  saved-places list, which is the right screen for a driver who said the verb and stopped. */
export function normalizeCarQuery(raw: string): string {
  let s = (raw || "").replace(/\s+/g, " ").trim();
  s = s.replace(/[\s.!?,;:]+$/g, "").trim();
  s = s.replace(FILLER_RE, "").trim();
  s = s.replace(COMMAND_RE, "").replace(/^[\s,;:]+/, "").trim();
  s = s.replace(/[,;:]+$/g, "").replace(/\s+please$/i, "").trim();
  return s;
}

/** The shape of a saved place this module needs — structurally compatible with
 *  src/savedPlaces.ts `SavedPlace`, without importing its AsyncStorage dependency. */
export type SavedPlaceLike = { kind: "home" | "work" | "custom"; label: string; createdAt: number };

const rankKind = (k: SavedPlaceLike["kind"]) => (k === "home" ? 0 : k === "work" ? 1 : 2);
/** Home, then Work, then custom newest-first — the same order both car lists draw. */
export function orderSavedPlaces<T extends SavedPlaceLike>(saved: readonly T[]): T[] {
  return saved.slice().filter((p) => !!p.label).sort((a, b) => rankKind(a.kind) - rankKind(b.kind) || b.createdAt - a.createdAt);
}

/** The saved place the normalised query names, or null. In order: a Home/Work alias; an exact
 *  label (case-insensitive); the same after dropping a leading "my "/"the " ("the gym" → Gym);
 *  then a label that STARTS with the query (2+ characters — "gy" → Gym while the driver is still
 *  typing). Ties resolve in list order, so a duplicate label picks the newest custom place. */
export function matchSavedPlace<T extends SavedPlaceLike>(norm: string, saved: readonly T[]): T | null {
  const q = (norm || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (q.length < 2) return null;
  const ordered = orderSavedPlaces(saved);
  if (CAR_SEARCH_HOME_ALIASES.includes(q)) return ordered.find((p) => p.kind === "home") ?? null;
  if (CAR_SEARCH_WORK_ALIASES.includes(q)) return ordered.find((p) => p.kind === "work") ?? null;
  const labelOf = (p: T) => p.label.replace(/\s+/g, " ").trim().toLowerCase();
  const exact = ordered.find((p) => labelOf(p) === q);
  if (exact) return exact;
  const bare = q.replace(/^(?:my|the)\s+/, "");
  if (bare !== q) {
    const bareHit = ordered.find((p) => labelOf(p) === bare);
    if (bareHit) return bareHit;
  }
  return ordered.find((p) => labelOf(p).startsWith(q)) ?? null;
}

export type LatLng = { latitude: number; longitude: number };
/** A Places (New) `locationRestriction` rectangle: ±km around the car. Latitude is clamped at the
 *  poles; a box that crosses the antimeridian comes back with low.longitude > high.longitude,
 *  which is how Google's Viewport spells a wrap. 1° of latitude = 111.32 km; longitude shrinks
 *  by cos(lat), floored so a car near a pole still gets a finite box. */
export function carSearchRestriction(lat: number, lng: number, km = CAR_SEARCH_RESTRICT_KM): { rectangle: { low: LatLng; high: LatLng } } {
  const dLat = km / 111.32;
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const dLng = Math.min(180, km / (111.32 * cosLat));
  const wrap = (x: number) => (x > 180 ? x - 360 : x < -180 ? x + 360 : x);
  return {
    rectangle: {
      low: { latitude: Math.max(-90, lat - dLat), longitude: dLng >= 180 ? -180 : wrap(lng - dLng) },
      high: { latitude: Math.min(90, lat + dLat), longitude: dLng >= 180 ? 180 : wrap(lng + dLng) },
    },
  };
}

/** A query or label as it goes into a crumb: one line, no double quotes, capped. */
export function crumbText(s: string, max = 48): string {
  const t = (s || "").replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Which of the two parallel Places answers the car shows. `near` = the restricted request,
 *  `wide` = the 50 km-biased one (both Canada/US). The restriction is a tail filter: it wins
 *  only when Google's own FIRST biased row is inside it — then the far tail is junk and goes.
 *  When Google's top pick is far, it is a real destination (Kamloops, Seattle) or a query the
 *  normaliser could not save; either way the biased list is the honest answer. One request
 *  failing leaves the other. */
export type CarSearchScope = "near" | "wide" | "none";
export function pickCarSearchScope<T extends { placeId: string }>(near: readonly T[], wide: readonly T[]): { rows: T[]; scope: CarSearchScope } {
  if (near.length && wide.length) {
    const nearIds = new Set(near.map((r) => r.placeId));
    return nearIds.has(wide[0].placeId) ? { rows: near.slice(), scope: "near" } : { rows: wide.slice(), scope: "wide" };
  }
  if (wide.length) return { rows: wide.slice(), scope: "wide" };
  if (near.length) return { rows: near.slice(), scope: "near" };
  return { rows: [], scope: "none" };
}
