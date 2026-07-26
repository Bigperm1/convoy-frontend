// pitstop.ts — the Pitstop timer.
//
// Jeff, 2026-07-26: "a fun feature called pitstop — when you notice the car is at a gas
// station/food and is stationary, a timer pops up on the screen counting the pitstop
// time."
//
// Racing framing for the thing every road trip actually does: you pull in for fuel or
// food, and the clock is running. The car stops, we work out WHERE it stopped, and a
// live counter appears. Pull away and the stop is banked into a running total for the
// drive.
//
// ── Why the ETA does NOT add this time ───────────────────────────────────────
// The arrival clock is `now + etaSeconds`. While you sit still, `now` keeps advancing
// and `etaSeconds` (distance-based) does not — so the arrival time ALREADY slides out
// by exactly the length of the stop, on its own. Folding the pitstop seconds in on top
// would count the same 15 minutes twice and make the ETA worse, which is the opposite
// of the accuracy work this shipped alongside. So the timer reports, it doesn't
// re-price. See the note at the ETA block in nav.ts.
//
// ── Cost discipline ──────────────────────────────────────────────────────────
// Exactly ONE Places lookup per stop, fired once when a stop is confirmed — never on a
// GPS tick. A stop that isn't near a gas/food place is silently dropped (no timer for
// a traffic jam or a red light), and we never look up the same spot twice in a row.
import { useEffect, useRef, useState } from "react";
import { GOOGLE_MAPS_KEY } from "./api";

export type PitstopKind = "gas" | "food" | "coffee" | "rest";

export type PitstopState = {
  /** A confirmed stop is in progress and the timer should be on screen. */
  active: boolean;
  /** Seconds elapsed in the CURRENT stop (0 when not active). */
  elapsedS: number;
  /** Seconds banked across every completed stop on this drive. */
  totalS: number;
  /** What we're parked at, for the label + icon. */
  kind: PitstopKind;
  /** Place name, e.g. "Petro-Canada". Empty until the lookup resolves. */
  label: string;
};

export const PITSTOP_IDLE: PitstopState = {
  active: false, elapsedS: 0, totalS: 0, kind: "rest", label: "",
};

// ── Thresholds ───────────────────────────────────────────────────────────────
// STOPPED: 5 km/h. GPS speed rarely reads a clean 0 even when parked (it wanders a
// metre or two), so a hard 0 would never trigger.
const STOPPED_MS = 1.4;          // ≈5 km/h
// MOVING again: a clearly-driving speed, well above the parked wander, so a jittery
// fix can't end the stop early.
const MOVING_MS = 3.0;           // ≈11 km/h
// How long stationary before it counts as a pitstop rather than a light or a queue.
// 90 s comfortably outlasts a long red and a slow drive-through crawl.
const CONFIRM_MS = 90_000;
// How long moving before the stop is closed out — stops a shuffle forward at the pump
// from ending the timer.
const RESUME_MS = 12_000;
// Only treat a Places hit as "where we parked" if it's this close.
const NEAR_M = 140;
// How far the car may wander from where it first went slow and still count as PARKED.
//
// This is the guard against stop-and-go city traffic. A speed threshold alone is not
// enough: crawling at 1.2 m/s for five minutes reads as "stopped" on speed, and in a
// city you are almost always within 140 m of a restaurant — so a jam would pop a
// "Food stop · Joe's Pizza" timer. A genuinely parked car stays inside GPS noise
// (~15 m); a crawl covers hundreds of metres. Drift past this and the stop restarts.
const STOP_RADIUS_M = 30;

function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Google Places types → our four buckets. Ordered: the first match wins, so a place
// tagged both cafe and restaurant reads as coffee.
const TYPE_KIND: [string, PitstopKind][] = [
  ["gas_station", "gas"],
  ["electric_vehicle_charging_station", "gas"],
  ["cafe", "coffee"],
  ["coffee_shop", "coffee"],
  ["fast_food_restaurant", "food"],
  ["restaurant", "food"],
  ["meal_takeaway", "food"],
  ["rest_stop", "rest"],
];

/**
 * One Places lookup at the parked position. Returns null when the car stopped
 * somewhere that isn't a pitstop (a jam, a driveway, a lay-by) so no timer appears.
 */
export async function identifyPitstop(
  lat: number, lng: number,
  signal?: AbortSignal,
): Promise<{ kind: PitstopKind; label: string } | null> {
  try {
    if (!GOOGLE_MAPS_KEY) return null;
    const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_KEY,
        "X-Goog-FieldMask": "places.id,places.location,places.displayName,places.types",
      },
      body: JSON.stringify({
        includedTypes: [
          "gas_station", "electric_vehicle_charging_station",
          "restaurant", "fast_food_restaurant", "meal_takeaway", "cafe", "rest_stop",
        ],
        maxResultCount: 10,
        locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: NEAR_M } },
      }),
      signal,
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const places: any[] = Array.isArray(data?.places) ? data.places : [];
    if (!places.length) return null;

    // Nearest first — at a highway services the pumps and the burger place are metres
    // apart, and whichever we're actually sitting at is the closer one.
    let best: any = null, bestD = Infinity;
    for (const p of places) {
      const la = p?.location?.latitude, ln = p?.location?.longitude;
      if (typeof la !== "number" || typeof ln !== "number") continue;
      const d = metres(lat, lng, la, ln);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best || bestD > NEAR_M) return null;

    const types: string[] = Array.isArray(best?.types) ? best.types : [];
    let kind: PitstopKind = "rest";
    for (const [t, k] of TYPE_KIND) { if (types.includes(t)) { kind = k; break; } }
    const label: string = best?.displayName?.text || "";
    return { kind, label };
  } catch {
    return null;   // includes AbortError
  }
}

/**
 * Watches the live position and produces the Pitstop state.
 *
 * `enabled` is the Settings toggle. When it goes false everything resets, so turning
 * the feature off mid-stop removes the timer immediately rather than freezing it.
 */
export function usePitstop(
  user: { lat: number; lng: number; speed?: number } | null,
  enabled: boolean,
): PitstopState {
  const [state, setState] = useState<PitstopState>(PITSTOP_IDLE);

  // Refs, not state: these move on every GPS tick and must never cause a re-render.
  const stillSinceRef = useRef<number | null>(null);   // when we first went slow
  const movingSinceRef = useRef<number | null>(null);  // when we first moved again
  const startedAtRef = useRef<number>(0);              // confirmed stop start
  const totalRef = useRef<number>(0);                  // banked seconds this drive
  const lookupRef = useRef<AbortController | null>(null);
  const identifiedRef = useRef<boolean>(false);
  const stopPosRef = useRef<{ lat: number; lng: number } | null>(null);

  const reset = () => {
    stillSinceRef.current = null;
    movingSinceRef.current = null;
    startedAtRef.current = 0;
    identifiedRef.current = false;
    stopPosRef.current = null;
    try { lookupRef.current?.abort(); } catch {}
    lookupRef.current = null;
  };

  // Toggle off → wipe everything, including the banked total.
  useEffect(() => {
    if (!enabled) {
      reset();
      totalRef.current = 0;
      setState(PITSTOP_IDLE);
    }
  }, [enabled]);

  const speed = user?.speed;
  const lat = user?.lat;
  const lng = user?.lng;

  // Latest fix, kept in a ref so the state machine below can read it without being
  // driven BY it.
  //
  // ⚠ WHY THE MACHINE IS ON A TIMER AND NOT ON POSITION UPDATES. The obvious shape —
  // run the logic in an effect keyed on [lat, lng, speed] — cannot work for this
  // feature. A PARKED phone is exactly the case where position updates dry up: with a
  // distance filter set, or once the OS decides nothing is moving, ticks stop arriving.
  // The effect would then never re-run, `stillFor` would never be re-evaluated, and the
  // 90-second confirmation would never fire — the timer would simply never appear,
  // which is the one situation the whole feature exists for. So: position updates only
  // refresh the ref, and a 2 s interval drives the decisions.
  const lastFixRef = useRef<{ lat: number; lng: number; speed: number } | null>(null);
  useEffect(() => {
    if (typeof lat !== "number" || typeof lng !== "number") return;
    lastFixRef.current = {
      lat, lng,
      speed: typeof speed === "number" && Number.isFinite(speed) ? speed : 0,
    };
  }, [lat, lng, speed]);

  useEffect(() => {
    if (!enabled) return;
    const evaluate = () => {
    const fix = lastFixRef.current;
    if (!fix) return;
    const { lat, lng } = fix;
    const now = Date.now();
    const v = fix.speed;

    if (v <= STOPPED_MS) {
      movingSinceRef.current = null;
      if (stillSinceRef.current == null) {
        stillSinceRef.current = now;
        stopPosRef.current = { lat, lng };
      }
      // Crawling, not parked? Re-anchor and restart the clock. Only applies BEFORE the
      // stop is confirmed — once the timer is up we keep it, because a confirmed stop
      // that shuffles across a forecourt is still the same stop.
      const anchor = stopPosRef.current;
      if (!identifiedRef.current && anchor &&
          metres(anchor.lat, anchor.lng, lat, lng) > STOP_RADIUS_M) {
        stillSinceRef.current = now;
        stopPosRef.current = { lat, lng };
        return;
      }
      const stillFor = now - stillSinceRef.current;

      // Confirmed stop → one Places lookup, once.
      if (stillFor >= CONFIRM_MS && !identifiedRef.current) {
        identifiedRef.current = true;
        startedAtRef.current = stillSinceRef.current;   // count from when we ACTUALLY stopped
        const at = stopPosRef.current || { lat, lng };
        const ctrl = new AbortController();
        lookupRef.current = ctrl;
        identifyPitstop(at.lat, at.lng, ctrl.signal).then((hit) => {
          if (ctrl.signal.aborted) return;
          if (!hit) return;                            // not a pitstop — stay silent
          setState((s) => ({
            ...s,
            active: true,
            kind: hit.kind,
            label: hit.label,
            elapsedS: Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000)),
            totalS: totalRef.current,
          }));
        }).catch(() => {});
      }
      return;
    }

    // Moving. Require a sustained run before closing the stop out, so creeping
    // forward at the pump doesn't stop the clock.
    if (v >= MOVING_MS) {
      if (movingSinceRef.current == null) movingSinceRef.current = now;
      if (now - movingSinceRef.current >= RESUME_MS) {
        if (startedAtRef.current > 0) {
          totalRef.current += Math.max(0, Math.round((now - startedAtRef.current) / 1000));
        }
        const banked = totalRef.current;
        reset();
        setState({ ...PITSTOP_IDLE, totalS: banked });
      }
    }
    };
    // 2 s cadence: fine enough that the timer appears promptly at the 90 s mark and
    // clears promptly when you pull away, coarse enough to be free on battery.
    evaluate();
    const id = setInterval(evaluate, 2000);
    return () => clearInterval(id);
  }, [enabled]);

  // Tick the visible counter once a second while a stop is on screen. Separate from the
  // GPS effect because a parked phone can go a long time between position updates —
  // the clock has to keep moving regardless.
  useEffect(() => {
    if (!state.active) return;
    const id = setInterval(() => {
      setState((s) => (s.active
        ? { ...s, elapsedS: Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000)) }
        : s));
    }, 1000);
    return () => clearInterval(id);
  }, [state.active]);

  return state;
}

/** mm:ss, or h:mm:ss once a stop passes an hour. */
export function fmtPitstop(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const two = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return h > 0 ? `${h}:${two(m)}:${two(ss)}` : `${m}:${two(ss)}`;
}
