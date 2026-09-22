// aheadAlerts.ts — railway crossings, school zones and playground zones called out ahead of the
// car, plus the speed cameras that already existed. Three files, one feature:
//   • src/aheadAlertRules.ts  — pure: what a tag means, when a zone is live, how far ahead, what to say
//   • src/aheadAlertStore.ts  — the cache, filled from the speed-limit pipeline's Overpass reply
//   • this file               — once-per-thing bookkeeping, the voice and the chime
//
// Jeff, 2026-09-21: "Yes build them and stage 2 for 80. Make the chime the same as the speed ding
// but 1 ding. Give the speed cameras and playground/school zones a good heads up for distance and
// time."
//
// ── NO SECOND OVERPASS ROUND TRIP ────────────────────────────────────────────────────────────
// src/speedCameras.ts, src/driveBcEvents.ts and src/speedLimit.ts already each run a feed every
// drive, and Overpass is the free, rate-limited, shared one. So this feature adds ZERO network
// calls: speedLimit.ts's existing per-drive query became a union and hands the extra elements to
// ingestAheadElements(). MEASURED 2026-09-21 at Jeff's 09-20 departure point (49.242496,
// -123.003784): the old query returned 190 ways, the union returns 192 elements — only two more,
// because 25 of the school-zone ways there already carried a plain `maxspeed`. The alternative I
// costed and rejected was this feature's own 8 km fetch: HTTP 200 in 6.73 s for 227,756 bytes,
// i.e. a quarter-megabyte JSON.parse on the JS thread every few kilometres — the exact shape of
// the main-thread stall that speedCameras.ts's `parse=` receipt exists to measure.
//
// The price of riding along is the speed-limit pipeline's tighter radius (FETCH_RADIUS_M 1500,
// REFETCH_MOVE_M 1000 → 500 m of GUARANTEED forward coverage). AHEAD_LEAD_MAX_M is 450 m for
// exactly that reason; the arithmetic is in aheadAlertRules.ts.

import { useEffect, useRef } from "react";
import {
  type AheadFeature, type AheadKind,
  aheadLeadM, aheadLine, featureDistM, pickAheadHit, rearmM,
} from "./aheadAlertRules";
import { aheadFeatures } from "./aheadAlertStore";
import { announce, formatDistance } from "./nav";
import { playSpeedDing } from "./speedDing";
import { getSettings } from "./settings";
import { logEvent } from "./crashBreadcrumb";

// ---- Tunables ----
// No fix for this long and the next one starts a NEW TRIP: the spoken-once-per-kind set and the
// announced set both reset, so tomorrow's drive gets the full spoken line again instead of a bare
// chime. Ten minutes is longer than a fuel stop and shorter than an errand. Deriving the trip
// boundary from the fix gap keeps this module out of map.tsx's nav-session lifecycle entirely.
const TRIP_GAP_MS = 10 * 60 * 1000;
// A hard floor between any two ahead-alerts of any kind. The forward corridor already makes them
// rare, but two crossings 60 m apart are ONE piece of news to a driver.
const MIN_GAP_MS = 8000;
// ONE PHYSICAL THING, SEVERAL OSM NODES. Measured 2026-09-21 in New Westminster: nodes 974279915,
// 974279920 and 974279930 are the same double-track crossing, four metres apart, one node per
// rail. After an alert, every other feature of the same kind inside this radius is marked spoken
// too — otherwise a car stopped at that crossing waiting for a train collects a chime per track.
const CLUSTER_M = 60;
// Re-scan only after this much travel, the same rule and the same reasoning as speedLimit.ts's
// RESOLVE DISTANCE GATE: the cache holds thousands of features, four feeds report the same fix,
// and the answer cannot change until the car has actually moved. 10 m is 0.36 s at 100 km/h —
// against a 450 m lead, invisible.
const RESCAN_MOVE_M = 10;
const RECEIPTS_MAX = 60;     // logEvent is a Supabase INSERT; a drive must not write hundreds

const _announced = new Set<string>();      // features already called out this trip
const _spokenKinds = new Set<AheadKind>(); // kinds that have had their full spoken line this trip
let _lastFixMs = 0;
let _lastAlertMs = 0;
let _scannedAt: { lat: number; lng: number } | null = null;
let _receipts = 0;

/** Trip/session reset — also reached automatically after TRIP_GAP_MS without a fix. */
export function resetAheadAlerts(): void {
  _announced.clear();
  _spokenKinds.clear();
  _lastAlertMs = 0;
  _scannedAt = null;
}

/** Equirectangular metres — street-scale accurate and cheap; used only for the move/cluster gates. */
function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = Math.PI / 180;
  return Math.hypot((bLng - aLng) * r * Math.cos(aLat * r) * 6371000, (bLat - aLat) * r * 6371000);
}

function isOnFor(kind: AheadKind): boolean {
  const s: any = getSettings();
  switch (kind) {
    case "camera": return s.speedCameras !== false;
    case "railway": return s.alertRailway !== false;
    case "school": return s.alertSchoolZones !== false;
    case "playground": return s.alertPlaygroundZones !== false;
  }
}

/**
 * Feed a fix; speak or ding at most one thing.
 *
 * ── THE ANTI-NAGGING RULE ────────────────────────────────────────────────────────────────────
 * Level crossings fire roughly four times on Jeff's commute and eight times on one of his days, so
 * a spoken sentence every time would be intolerable inside a week. A kind is SPOKEN the first time
 * it is met in a trip and is a single chime every time after — the driver learns what the sound
 * means once, then just gets the cue.
 *
 * THE CHIME IS THE SPEED DING, ONE DING (Jeff, same message: "Make the chime the same as the speed
 * ding but 1 ding"). Not a new tone, not a new asset: playSpeedDing() from src/speedDing.ts, which
 * already plays exactly one chime and takes no argument — the double was removed on 2026-09-12 and
 * scripts/trap-check.py rule 32 keeps it removed. Reusing it also inherits the parts that are easy
 * to get wrong: the `volDings` per-source level, Mute During Calls, the iOS loudspeaker /
 * silent-switch audio mode, and the yield that stops it landing on top of Nova.
 */
export function feedAheadAlerts(
  lat: number, lng: number,
  courseDeg: number | null | undefined,
  speedMs: number | null | undefined,
  extra: AheadFeature[],
  muted: boolean,
): void {
  const nowMs = Date.now();
  if (_lastFixMs && nowMs - _lastFixMs > TRIP_GAP_MS) resetAheadAlerts();
  _lastFixMs = nowMs;
  if (_scannedAt && metresBetween(_scannedAt.lat, _scannedAt.lng, lat, lng) < RESCAN_MOVE_M) return;
  _scannedAt = { lat, lng };

  const features = extra.length ? aheadFeatures().concat(extra) : aheadFeatures();
  const leadM = aheadLeadM(speedMs);
  // Re-arm anything we have driven well past, so the trip home calls it out again.
  if (_announced.size) {
    for (const id of Array.from(_announced)) {
      const f = features.find((x) => x.id === id);
      if (!f || featureDistM(f, lat, lng) > rearmM(leadM)) _announced.delete(id);
    }
  }

  const hit = pickAheadHit(features, lat, lng, courseDeg, speedMs, new Date(nowMs), nowMs, isOnFor);
  if (!hit || _announced.has(hit.feature.id)) return;
  if (nowMs - _lastAlertMs < MIN_GAP_MS) return;
  _announced.add(hit.feature.id);
  _lastAlertMs = nowMs;

  const kind = hit.feature.kind;
  // Everything of the same kind within CLUSTER_M of what we just called out is the SAME thing as
  // far as the driver is concerned — see the New Westminster three-node crossing above.
  for (const f of features) {
    if (f.kind !== kind || _announced.has(f.id)) continue;
    if (featureDistM(f, hit.lat, hit.lng) <= CLUSTER_M) _announced.add(f.id);
  }
  // ⛔ MUTE SILENCES THE VOICE, NOT THE DING (review, 2026-09-21). This read `if (muted) return`
  // above both branches, which killed the chime too — and that contradicts the rule the speed
  // alert has carried since it shipped (app/(app)/map.tsx, the navMuted note on the speed-alert
  // effect): "navMuted silences the SPOKEN mode only — the ding is a non-voice alert the driver
  // explicitly opted into, so it keeps playing even when Nova's voice is muted." The per-feature
  // toggles in Settings are how you turn these off; muting Nova is how you stop her TALKING.
  // So a muted driver gets the ding on the FIRST encounter too — the alert still lands, wordlessly.
  const wantVoice = !_spokenKinds.has(kind) && !muted;
  if (_receipts < RECEIPTS_MAX) {
    _receipts += 1;
    try {
      logEvent(`ahead-alert kind=${kind} d=${Math.round(hit.alongM)} off=${Math.round(hit.crossM)} lead=${Math.round(leadM)} spd=${Math.round((speedMs ?? 0) * 3.6)} say=${wantVoice ? "voice" : muted ? "ding-muted" : "ding"}`);
    } catch {}
  }
  if (wantVoice) {
    const mph = getSettings().speedUnit === "mph";
    // ⛔ ONLY LATCH "already spoken" ONCE THE LINE IS ACTUALLY OUT (review, 2026-09-21). This used
    // to mark the kind spoken BEFORE calling announce(), and announce() → speak() can silently drop
    // an utterance on the 1.5 s rate gate (src/maneuverSpeech.ts speakRateSkips). Lose that race on
    // a kind's FIRST encounter and the driver never hears what the ding means, and is demoted to
    // ding-only for the rest of the trip with no way back. Now a dropped line leaves the kind
    // unspoken, so the next one of its kind introduces itself properly.
    let spoke = false;
    try { spoke = announce(aheadLine(kind, formatDistance(hit.alongM), hit.feature.limitKmh ?? null, mph)); } catch { spoke = false; }
    if (spoke) _spokenKinds.add(kind); else void playSpeedDing();
  } else {
    void playSpeedDing();
  }
}

/**
 * React view of the above. MUST be mounted above app/(app)/map.tsx's `if (!coords)` early return,
 * like every other hook in that file — one added below it changes the hook count the moment the
 * first fix lands and takes the app down with "Rendered more hooks than during the previous
 * render".
 */
export function useAheadAlerts(
  lat: number | null | undefined,
  lng: number | null | undefined,
  courseDeg: number | null | undefined,
  speedMs: number | null | undefined,
  cameras: { id: string; lat: number; lng: number }[],
  muted: boolean,
): void {
  // The camera list is a fresh array identity on every Overpass pull; holding it in a ref means
  // this effect fires on FIXES, not on that feed's churn.
  const camsRef = useRef(cameras);
  camsRef.current = cameras;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  useEffect(() => {
    if (typeof lat !== "number" || typeof lng !== "number") return;
    const cams: AheadFeature[] = camsRef.current.map((c) => ({ id: "cam" + c.id, kind: "camera", lat: c.lat, lng: c.lng }));
    feedAheadAlerts(lat, lng, courseDeg, speedMs, cams, mutedRef.current);
  }, [lat, lng, courseDeg, speedMs]);
}
