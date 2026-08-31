// Arrival zones — "have I reached the PROPERTY", not "have I reached the pin".
//
// Jeff, 2026-08-31, after a drive that never recorded: "in a situation where, say,
// Canadian Tire has a huge parking lot, and you put me to the front door, but I don't
// park at the front door, I park in the parking lot… can't you make the boundary the
// property itself?"
//
// He is right, and the numbers are lopsided. MEASURED on his own drive:
//   • he parked at 49.053873,-122.317384 — Mapbox returns building:retail AND
//     landuse:commercial_area for that exact point, i.e. inside the store's own footprint
//   • the Real Canadian Superstore parcel is 256 m x 159 m — 3.38 hectares
//   • walking north from where he parked: still retail at 100 m, still parking at 125 m,
//     outside by 150 m
//   • ARRIVE_M is 20
// The property is five times wider than the radius meant to notice you are at it. He
// stopped 23 m out and the drive ran forever.
//
// WHY THIS BEATS THE THING IT REPLACES. The previous attempt inferred parking from SPEED
// and from SILENCE, and both go stale the instant the OS stops delivering fixes — which
// is precisely when a car parks. Two adversarial review rounds killed two versions of it.
// A property test uses POSITION, which never went stale: his frozen fix was a perfectly
// good coordinate sitting in the right car park. It sidesteps the whole class of bug.
//
// WHY A RADIUS AND NOT A POLYGON. Tilequery answers "what contains this point" but does
// not hand back the shape, and decoding vector tiles on a phone to get one is a lot of
// machinery for a yes/no. So the property is MEASURED ONCE, at route-plot time, by
// walking outward until the land stops matching — and reduced to a distance the drive
// loop can test with the haversine it already uses. No network on the hot path, works
// with the radio off once resolved, and nothing to decode.
import { MAPBOX_PUBLIC_TOKEN } from "./initMapbox";
import { logEvent } from "./crashBreadcrumb";

export type ArrivalZone = {
  /** Crow-fly metres from the destination that still count as "on the property". */
  radiusM: number;
  /** What the land is, for the telemetry line — e.g. "commercial_area". */
  kind: string;
  /** Bearings that agreed, out of BEARINGS.length. Low = a thin or ragged parcel. */
  agree: number;
};

// Land a driver parks ON. Deliberately a whitelist rather than "whatever contains the
// destination": a house in a landuse:residential block would otherwise inherit the whole
// subdivision, and `park`/`grass` would swallow a street address backing onto green space.
const PARKABLE = new Set([
  "commercial_area", "retail", "industrial", "parking", "aboveground_parking",
  "school", "hospital", "college", "university", "airport", "cemetery", "stadium",
]);

// The ladder we walk outward. Stops at the first miss per bearing, so a small storefront
// costs one probe per bearing and only a genuine big-box lot pays for the long end.
// TUNED AGAINST THE REAL API, not chosen by feel. Four cardinal bearings on a coarse
// [40,80,130,190] ladder measured the Superstore parcel at 40 m — below the useful floor,
// i.e. it would have thrown away the very case this was built for. Eight bearings on this
// finer ladder measure it at 75 m with all eight agreeing.
const LADDER_M = [30, 60, 90, 120, 160, 200];
const BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];
// Never let a probe hand back something larger than a big-box lot.
// ⚠ THIS NUMBER MUST STAY BELOW LADDER_M's LAST RUNG OR IT IS DEAD CODE. It was 200 —
// identical to the top of the ladder — so `reach` could never exceed it and the cap never
// once bound. Review MEASURED what that let through by running this algorithm against the
// live API: YVR and SEA-TAC terminals both returned r=200 m, all eight bearings saturated;
// UBC 200 m, BC Place 160 m, Surrey Memorial 140 m. A 200 m arrival radius on an airport
// ramp ends guidance before the arrivals/departures split.
// 120 m binds on every one of those and leaves the motivating case untouched: the
// Superstore parcel measured 75 m.
const MAX_RADIUS_M = 120;
// Below this there is nothing to gain over the plain ARRIVE_M test, so report nothing and
// let the caller keep today's behaviour rather than pretend we learned something.
const MIN_USEFUL_M = 45;

const R = 6371000;
function offset(lat: number, lng: number, bearingDeg: number, m: number) {
  const br = (bearingDeg * Math.PI) / 180;
  const la = (lat * Math.PI) / 180;
  const lo = (lng * Math.PI) / 180;
  const dr = m / R;
  const la2 = Math.asin(Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(br));
  const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(la), Math.cos(dr) - Math.sin(la) * Math.sin(la2));
  return { lat: (la2 * 180) / Math.PI, lng: (lo2 * 180) / Math.PI };
}

/** Classes of parkable land containing this exact point. radius=0 is true containment —
 *  anything else returns neighbours and would inflate every parcel. */
async function landAt(lat: number, lng: number, signal: AbortSignal): Promise<Set<string>> {
  const url =
    `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${lng},${lat}.json` +
    `?radius=0&limit=12&dedupe&layers=landuse,building&access_token=${MAPBOX_PUBLIC_TOKEN}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`tilequery ${res.status}`);
  const json: any = await res.json();
  const out = new Set<string>();
  for (const f of json?.features ?? []) {
    const p = f?.properties ?? {};
    for (const v of [p.class, p.type]) if (typeof v === "string" && PARKABLE.has(v)) out.add(v);
  }
  return out;
}

// One entry per destination, keyed to ~11 m. Routes get re-plotted constantly (five
// swaps on the drive that prompted this) and every one of them would otherwise re-probe
// the same shop. `null` is cached too — a destination with no parcel must not be retried
// on every reroute.
const cache = new Map<string, ArrivalZone | null>();
const inflight = new Map<string, Promise<ArrivalZone | null>>();
const key = (lat: number, lng: number) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

/**
 * Measure the property around `dest`. Resolves to null when the destination is not on
 * parkable land, when the parcel is too small to beat ARRIVE_M, or on any network
 * trouble — in every one of those cases the caller keeps today's behaviour.
 *
 * Safe to call on every plot: results (including nulls) are cached, and concurrent calls
 * for the same destination share one probe.
 */
export function resolveArrivalZone(
  dest: { lat: number; lng: number },
  timeoutMs = 12000,
): Promise<ArrivalZone | null> {
  const k = key(dest.lat, dest.lng);
  if (cache.has(k)) return Promise.resolve(cache.get(k)!);
  const running = inflight.get(k);
  if (running) return running;

  const job = (async (): Promise<ArrivalZone | null> => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // What is the destination standing on? A pin snapped to the kerb can land just
      // outside its own parcel, so fall back to a tight ring before giving up.
      let base = await landAt(dest.lat, dest.lng, ctl.signal);
      if (base.size === 0) {
        for (const b of BEARINGS) {
          const p = offset(dest.lat, dest.lng, b, 25);
          base = await landAt(p.lat, p.lng, ctl.signal);
          if (base.size > 0) break;
        }
      }
      if (base.size === 0) { cache.set(k, null); return null; }

      // Walk each bearing outward, stopping at the first ring that is not parkable land
      // AT ALL. Deliberately NOT "still the same class as the destination": MEASURED, a
      // real property is a mosaic — the Superstore point reads building:retail +
      // landuse:commercial_area, and its own car park 80 m away reads landuse:parking.
      // Requiring the same class made every big-box lot terminate at its own kerb and
      // measure 40 m, throwing away exactly the case this exists for. Any parkable land
      // continues the property; MAX_RADIUS_M and the median are what stop it running off
      // across a whole retail district.
      const extents: number[] = [];
      for (const b of BEARINGS) {
        let reach = 0;
        for (const m of LADDER_M) {
          const p = offset(dest.lat, dest.lng, b, m);
          let here: Set<string>;
          try { here = await landAt(p.lat, p.lng, ctl.signal); } catch { break; }
          if (here.size === 0) break;
          reach = m;
        }
        extents.push(reach);
      }

      // MEDIAN, not max and not min. Max would reach across a shared strip-mall lot into
      // the neighbour's; min collapses to zero the moment one bearing points at the road
      // the destination fronts onto — which is true of essentially every shop.
      const sorted = [...extents].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      const median = (sorted[mid - 1] + sorted[mid]) / 2;
      const agree = extents.filter((e) => e > 0).length;
      const radiusM = Math.min(MAX_RADIUS_M, Math.round(median));
      const kind = [...base].sort().join("+");

      // agree < 3 of 8 means the destination sits on a sliver or right at an edge — a
      // radius measured off that would be mostly guess. MEASURED: a point at the lip of
      // a strip-mall lot read [120,0,0,0,0,0,200,200], which is a shape no circle
      // describes. Report nothing and let the plain radius handle it.
      if (radiusM < MIN_USEFUL_M || agree < 3) {
        try { logEvent(`arrival-zone none kind=${kind} extents=${extents.join("/")} agree=${agree}`); } catch {}
        cache.set(k, null);
        return null;
      }
      const zone: ArrivalZone = { radiusM, kind, agree };
      try { logEvent(`arrival-zone ok r=${radiusM}m kind=${kind} extents=${extents.join("/")} agree=${agree}`); } catch {}
      cache.set(k, zone);
      return zone;
    } catch (e: any) {
      // Never cache a failure: a probe that died on a dead cell should be retried on the
      // next plot, unlike a destination that genuinely has no parcel.
      try { logEvent(`arrival-zone fail ${String(e?.message ?? e).slice(0, 60)}`); } catch {}
      return null;
    } finally {
      clearTimeout(t);
      inflight.delete(k);
    }
  })();

  inflight.set(k, job);
  return job;
}

/** Test-only / debug: what has been measured so far this session. */
export function arrivalZoneCache(): Record<string, ArrivalZone | null> {
  return Object.fromEntries(cache);
}
