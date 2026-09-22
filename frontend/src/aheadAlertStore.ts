// aheadAlertStore.ts — the cache of things worth a heads-up (railway crossings, school zones,
// playground zones), filled straight from the Overpass reply that src/speedLimit.ts already
// fetches. Deliberately TINY in its dependencies — aheadAlertRules (pure) and crashBreadcrumb,
// which speedLimit already imports — so the speed-limit pipeline does not acquire nav.ts, expo-av
// and the whole speech stack as transitive imports just to learn about a level crossing.
//
// The announcing half is src/aheadAlerts.ts; the deciding half is src/aheadAlertRules.ts.

import { type AheadFeature, type AheadKind, parseMaxspeedConditional } from "./aheadAlertRules";
import { logEvent } from "./crashBreadcrumb";

// The cache is keyed by OSM id and ACCUMULATES across fetches, unlike speedLimit.ts's `_ways`
// (replaced wholesale, because it only ever cares about the road under the car). A drive that
// doubles back therefore still knows about the crossing it passed on the way out. Bounded because
// nothing clears it while the app lives: at the densities measured in Burnaby on 2026-09-21
// (277 level crossings inside 8 km) 4000 entries is a long day's driving, and eviction is
// oldest-first.
const CACHE_MAX = 4000;
const INGEST_RECEIPTS_MAX = 12;

const _cache = new Map<string, AheadFeature>();
let _ingestRows = 0;

function put(f: AheadFeature): void {
  if (_cache.has(f.id)) return;
  if (_cache.size >= CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(f.id, f);
}

/**
 * Take the raw Overpass elements from the speed-limit pull and keep the ones this feature cares
 * about. Anything unrecognised is ignored, so a query change upstream can only ever give us less,
 * never break us. NEVER THROWS: the caller is inside the speed-limit fetch, and an alert feature
 * must not be able to take the posted-limit sign down with it.
 */
export function ingestAheadElements(els: any[]): void {
  if (!Array.isArray(els)) return;
  let rail = 0, school = 0, play = 0;
  // RAW counts straight off the response, before any of our filtering. Without these the receipt
  // cannot tell "there were no crossings near you" from "crossings came back and we dropped them"
  // — which is exactly the question the first sim run left open on 2026-09-21, when a fetch
  // returned 25 school zones and 7 playgrounds but rail=0 while parked 700 m from a real crossing.
  // (The query and the node parse both check out against a live mirror; two of the three Overpass
  // mirrors were failing that evening — 406 and 504 — so the run was never conclusive. These two
  // numbers make the next real drive settle it.)
  let seenNodes = 0, seenXing = 0;
  try {
    for (const e of els) {
      const tags = e?.tags;
      if (!tags) continue;
      if (e.type === "node") {
        seenNodes++;
        if (tags.railway !== "level_crossing") continue;
        seenXing++;
        if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
        if (!_cache.has("n" + e.id)) rail++;
        put({ id: "n" + e.id, kind: "railway", lat: e.lat, lng: e.lon });
        continue;
      }
      if (e.type !== "way") continue;
      const cond = parseMaxspeedConditional(tags["maxspeed:conditional"]);
      const flagged = tags.hazard === "school_zone";
      if (!flagged && (!cond || cond.kind === "other")) continue;
      const geom = Array.isArray(e.geometry)
        ? e.geometry
            .filter((p: any) => typeof p?.lat === "number" && typeof p?.lon === "number")
            .map((p: any) => ({ lat: p.lat, lng: p.lon }))
        : [];
      if (!geom.length) continue;
      // `hazard=school_zone` wins over a daylight-shaped conditional: the tag is the mapper's
      // explicit statement, and a school often has a playground zone tagged on the very next way.
      const kind: AheadKind = flagged || cond?.kind !== "playground" ? "school" : "playground";
      // THE INVERTED PLAYGROUND TAG. '50 @ (dusk-dawn)' on a way whose base maxspeed is 30 states
      // the NIGHT limit, so the zone's own limit is the base maxspeed, not the conditional's
      // number. 21 of the 363 conditionals in Jeff's corridor are tagged that way (measured
      // 2026-09-21) — reading the number straight off the tag would announce "fifty" in a 30 zone.
      const base = parseInt(String(tags.maxspeed ?? ""), 10);
      const inverted = cond?.window.type === "daylight" && cond.window.night;
      const limitKmh = inverted
        ? (Number.isFinite(base) ? base : null)
        : cond?.limitKmh ?? (Number.isFinite(base) ? base : null);
      const id = "w" + e.id;
      if (!_cache.has(id)) { if (kind === "school") school++; else play++; }
      put({
        id, kind, lat: geom[0].lat, lng: geom[0].lng, geom, limitKmh,
        when: { kind, window: cond?.window ?? { type: "always" } },
      });
    }
  } catch { /* a malformed element must never break the speed-limit fetch that called us */ }
  // Bounded receipt, only when something NEW landed. This is the one row that can tell
  // "it never said anything" (a bug) apart from "there was nothing there" (the data).
  if ((rail || school || play) && _ingestRows < INGEST_RECEIPTS_MAX) {
    _ingestRows += 1;
    try { logEvent(`ahead-ingest rail=${rail} school=${school} play=${play} cache=${_cache.size} els=${els.length} nodes=${seenNodes} xing=${seenXing}`); } catch {}
  }
}

export function aheadFeatures(): AheadFeature[] { return Array.from(_cache.values()); }
export function aheadCacheSize(): number { return _cache.size; }
