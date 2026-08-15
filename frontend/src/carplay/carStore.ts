// src/carplay/carStore.ts
//
// Tiny shared store that bridges the phone's React tree and the CarPlay /
// Android Auto surface. The car surface (CarSurface) renders as a SEPARATE
// AppRegistry root, so it can't read map.tsx's props/state directly. map.tsx
// (via useConvoyCarPlay) pushes live state in here; the car surface subscribes
// with useCarStore(). Plain pub/sub, platform-agnostic, safe on web.

import { useEffect, useState } from 'react';
import type { MapMode, Settings } from '../settings';
// VALUE import (this used to be type-only): the settings→car mirror at the bottom of
// this file needs the live accessors. No import cycle — settings.ts imports only
// AsyncStorage and react (settings.ts:2-3).
import { getSettings, getMapMode, getRouteColor, getSelfMarkerType, subscribeSettings } from '../settings';
import type { RoadEvent } from '../driveBcEvents';

// Peer entry for the car surface. `id`+`handle` feed the Comms list (the original
// shape); the optional position/status fields (added for CarPlay-standalone Wave 1)
// let CarMapView draw the convoy on the head-unit map. Peers without a numeric
// lat/lng simply don't render a map dot — the Comms list is unaffected.
export type CarPeer = {
  id: string;
  handle: string;
  lat?: number;
  lng?: number;
  heading?: number;
  status?: 'live' | 'parked';
  // ── PEER APPEARANCE ON THE CAR SURFACE (Jeff, 2026-08-12) ─────────────────
  // "on CarPlay when I hit the crew, it doesn't show the high resolution car. It
  //  shows green dots instead for my peers."
  //
  // Correct, and the root cause was here rather than in the renderer: CarPeer carried
  // only a position, so the car map had nothing to draw a CAR with and fell back to a
  // GL circle. The phone builds each peer's look from their broadcast marker choice
  // (ConvoyMapbox: marker === 'class' | 'arrow', else the paint colour), so the same
  // three fields are mirrored here and the car surface resolves them to the SAME
  // static assets the phone uses. No new asset pipeline, no snapshot machinery.
  //
  // Deliberately NOT mirrored: clsPri/clsSec/arrPri/arrSec. The phone tints those live
  // because a MarkerView is a real RN view; reproducing them on the car needs the
  // MBXImage snapshot dance (see the self class sprite in ConvoyMapbox — onReady,
  // refresh(), and an iOS remount counter), which is the fiddliest code on that path.
  // A correctly-shaped car in the right colour beats a green dot today; paint tinting
  // is a follow-up, tracked in the CarMapView comment.
  marker?: 'class' | 'arrow' | null;
  cls?: string;
  color?: string;
};

export type CarState = {
  navigating: boolean;
  // Is location permission set to ALWAYS? The car surface turns the crew pill RED
  // when it is not, because that single setting is what keeps the marker tracking
  // with the phone locked in a mount — the failure it causes looks like a bug in us.
  // Defaults TRUE so the pill can never flash red before the first read completes.
  alwaysLocation: boolean;
  speedMs: number; // current speed in m/s (0 when stopped/unknown)
  instruction: string; // upcoming maneuver text (while navigating)
  distanceToTurn: string; // e.g. "102 m"
  eta: string; // e.g. "24 min"
  distanceRemaining: string; // e.g. "33 km"
  destinationLabel: string;
  peers: CarPeer[];
  // Self user id, mirrored from the warm phone hook. Lets the CarPlay surface drop our
  // OWN voice out of the "X is talking…" indicator. undefined on a cold connect (no auth
  // object headlessly) — the filter then just no-ops, which is harmless because you
  // cannot transmit from the car yet.
  selfUserId?: string;
  // Own outbound crew-comms transmission from the CAR (carComms.ts): drives the
  // red "Transmitting…" indicator on the car surface.
  commsTx?: "idle" | "recording" | "sending";
  // Crew-overview confirmation: shown as a transient pill so a dead CREW tap is
  // distinguishable from a dead camera (set by CarMapView when the fit runs).
  // Non-blocking car toast (replaces the CPAlertTemplate modals). Rendered by the
  // car surface's status row; expiry is a TIMESTAMP COMPARISON at render, never a
  // setTimeout — iOS pauses JS timers while the phone is locked, which is precisely
  // when a driver is using CarPlay.
  carToast?: string;
  carToastUntil?: number;
  // PITSTOP mirror — the phone owns detection (src/pitstop.ts); the car just draws it.
  // Standing rule: the CarPlay HUD matches the phone, so a stop that shows a timer on
  // the phone must show one on the head unit too.
  pitstopActive?: boolean;
  pitstopLabel?: string;
  pitstopKind?: string;
  pitstopElapsedS?: number;
  crewViewUntil?: number;
  crewViewCount?: number;
  // Raw numeric mirrors of the formatted strings above. Android Auto's
  // NavigationTemplate needs real meters/seconds (it formats them itself), not
  // the pre-formatted phone-banner strings. Populated alongside the strings.
  distanceToTurnM: number; // meters to the next maneuver
  distanceRemainingM: number; // meters to the destination
  etaSeconds: number; // seconds remaining to the destination
  // --- Live map (CarPlay static-map background) ---
  // Self position + heading for centering the car map and rotating the car
  // marker, plus the encoded route geometry. routePolyline is Google's
  // precision-5 overview polyline, which is a drop-in for the Mapbox Static
  // Images API `path` overlay (same encoding). selfLat/selfLng are null until
  // GPS is acquired; heading is null when unknown/stationary; routePolyline is
  // '' when there is no active route.
  selfLat: number | null;
  selfLng: number | null;
  heading: number | null; // degrees, 0 = north
  routePolyline: string;
  // Self car paint (mirror of the phone's settings.carColor). Lets the car root
  // pick the right 3D vehicle model (getVehicleModelUrl). undefined → car root
  // falls back to the default GRC model. Set from the phone mirror feed and the
  // background/foreground location feeds (best-effort on the cold-connect path).
  selfCarColor?: string;
  // Base-map mode (mirror of the phone's getMapMode(settings)). Lets the car map
  // match the phone's style: 'satellite' → SatelliteStreet, else Standard with the
  // matching light preset. undefined → car falls back to the phone default 'dusk'.
  mapMode?: MapMode;
  // Self-marker style (mirror of settings.selfMarkerType). Lets the CarPlay live map
  // render the green ARROW model when the phone is set to 'arrow', else the 3D car —
  // so the head unit matches the phone. undefined → car.
  // 'class' falls back to the 3D car on the head unit for now (the top-down
  // class sprite is phone-only until the CarPlay parity pass).
  selfMarkerType?: 'car' | 'arrow' | 'photo' | 'class';
  // Driver's speed unit (mirror of settings.speedUnit). CarSurface reads
  // getSettings().speedUnit directly at render — correct (one JS context, shared
  // module cache) but NOT reactive: nothing re-renders the car tree when the unit
  // changes, so the head unit kept the old unit until some unrelated carStore write
  // happened to land. Mirrored here so the switch repaints immediately.
  // undefined → CarSurface falls back to getSettings().speedUnit, so a state object
  // written before this field existed still formats correctly.
  speedUnit?: 'kmh' | 'mph';
  // Map markers mirrored from the phone so the CarPlay live map shows the SAME
  // hazards / DriveBC incidents / speed cameras / place pins the driver sees on the
  // phone. All optional; undefined → none. The 'when active' gating is applied on the
  // phone BEFORE writing (speed cameras + road events self-gate to [] when their layer
  // is off; places only when the pins setting is on; hazards filtered to disputes<2).
  // CarMapView renders them with the phone's own marker components (no duplication).
  hazards?: { id: string; kind: string; lat: number; lng: number; confirms?: number; disputes?: number }[];
  speedCameras?: { id: string; lat: number; lng: number }[];
  roadEvents?: RoadEvent[];
  places?: { id: string; lat: number; lng: number; label?: string }[];
  // Posted speed limit (km/h) for the road the driver is on (OSM/Overpass, fed by
  // the navNotification location feed). undefined/0 → no badge shown.
  speedLimitKmh?: number;
  // Live weather at the driver (mirror of the phone's WeatherHUD), fed from
  // useConvoyCarPlay only while the phone's weather layer is on. weatherTemp is the
  // pre-formatted reading in the driver's unit (e.g. '18°'); weatherKind is a
  // WeatherKind string the car maps to a glyph. undefined → no weather chip.
  weatherTemp?: string;
  weatherKind?: string;
  // Agentic Scout mic state (mirror of the phone's useVoice instance, fed by
  // map.tsx). Drives the "Listening… / Thinking…" pill on the car surface so a
  // native map-button tap gets visible feedback — the head unit has no haptics.
  scoutListening?: boolean;
  scoutThinking?: boolean;
  // User-chosen route-line color (base hex, mirror of settings.routeColor). Lets the
  // CarPlay live route match the phone. undefined → CarMapView falls back to green.
  routeColor?: string;
  // Selected route's kind ('best' | 'scenic' | 'ai' | …) — CarMapView resolves the
  // phone's per-kind color transform from it so both screens paint identically.
  routeKind?: string;
  // Up to three DISPLAY routes (Best / Scenic / AI) for the CarPlay preview, mirrored
  // from the phone. Each carries its precomputed core `color` + casing `edge` (AI = black
  // core, user-color edge) so CarMapView paints them per-kind without re-deriving, plus
  // the route's original `index` so it can match `selectedRouteIndex`. Empty/undefined when
  // there's no route or only one option. `routePolyline` (above) stays the SELECTED route
  // used for nav trim + the static-map fallback. Route SELECTION is phone-driven (CarPlay
  // route lines are display-only) — CarPlay just mirrors whichever the phone picked.
  routes?: { index: number; polyline: string; kind: string; color: string; edge: string }[];
  selectedRouteIndex?: number;
  // Selected route's decoded [lng,lat] geometry + per-segment congestion (mirror of
  // routes[selectedRouteIndex].coordinates/.congestion). Lets the CarPlay map paint the
  // SAME live traffic gradient as the phone — clear in the route color, warming to
  // yellow/orange/red where it slows. undefined → CarMapView falls back to the flat color.
  routeCoordinates?: [number, number][];
  routeCongestion?: string[];
  // Glyph (unicode arrow) for the upcoming maneuver, shown in the car banner's green
  // arrow box (mirrors the phone's maneuver icon). undefined when not navigating.
  maneuverIcon?: string;
  // (The `lanes` field was removed 2026-08-13 with the lane row on every surface.)
  // On-screen diagnostic breadcrumb for the CarPlay surface (which feed last wrote a
  // position, or which call failed). Shown in the logo fallback so the head-unit screen
  // self-reports why hasFix is false — no Mac/device log needed. e.g. 'fgfeed',
  // 'navtask#3', 'seed:ok#0', 'seed:err#1:…', 'seed:no-fg-perm', 'bgstart:err:…'.
  carDbg?: string;
  // DEDICATED CarPlay template-layer breadcrumb. Separate from carDbg on purpose:
  // carDbg is rewritten by every position tick (navtask#N), which clobbered the
  // template state before it could ever be read on the head unit. Written ONLY by
  // the CarPlay connect / setRootTemplate paths.
  cpDbg?: string;
};

const initial: CarState = {
  navigating: false,
  alwaysLocation: true,
  speedMs: 0,
  instruction: '',
  distanceToTurn: '',
  eta: '',
  distanceRemaining: '',
  destinationLabel: '',
  peers: [],
  distanceToTurnM: 0,
  distanceRemainingM: 0,
  etaSeconds: 0,
  selfLat: null,
  selfLng: null,
  heading: null,
  routePolyline: '',
};

let state: CarState = initial;
const listeners = new Set<(s: CarState) => void>();

// ── THE EQUALITY GATE (2026-08-14) ─────────────────────────────────────────────
// Jeff: "why is the phone really heating up." This is the multiplier under a whole
// family of heat findings, and it is four lines.
//
// Every one of the 45 setCarState call sites fanned out to EVERY listener on EVERY
// call, whether or not a single value actually changed. Both car React trees
// (CarSurface and, on Android, AndroidAutoRoot) re-render on that fanout. Measured
// consequences, all from the same root:
//   • the cold path writes 4-5 times per GPS fix — position, carDbg, an UNCHANGED
//     mapMode/selfCarColor pair, the strip — so ~1 Hz of GPS became ~5 Hz of full
//     car re-renders;
//   • `setCarState({ carDbg: "fgfeed" })` re-rendered both trees ~2 Hz to restate a
//     string that is hidden unless a debug flag is on;
//   • updateNavBanner does a literal `setCarState({})` on every fix when the phone
//     owns the strip — a guaranteed no-op that still redrew the head unit.
//
// A no-op write cannot be information: nothing can legitimately depend on being
// notified that nothing changed. So skip the fanout when every key in the patch is
// already `Object.is`-equal to what is stored.
//
// ⚠ Reference types (peers/hazards/routes/lanes arrays, routeCoordinates) compare by
// IDENTITY, so a fresh array with identical contents still notifies — this gate does
// NOT replace the content-signature gates upstream, it composes with them. And
// `state` is still reassigned on a real change, so useCarStore's snapshot semantics
// are untouched.
export function setCarState(patch: Partial<CarState>) {
  let changed = false;
  for (const k in patch) {
    if (!Object.is((state as any)[k], (patch as any)[k])) { changed = true; break; }
  }
  if (!changed) return;                 // nothing moved -> nobody needs telling
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

// ── Self-position write GATE (fixes the "marker roams after CarPlay connects") ──
// Once CarPlay connects, selfLat/selfLng is fed by THREE concurrent GPS streams: the
// phone-coords mirror (BestForNavigation / 0 m — most accurate), a foreground car watch
// (High / 15 m), and the background nav task (High / 20 m). A plain last-writer-wins
// merge let the two LAGGING feeds overwrite the precise one, so the stored position
// hopped between three disagreeing fixes and the eased marker wandered. This gate keeps
// ALL THREE feeds running (the CarPlay-logo robustness is untouched) but only lets the
// highest-priority ACTIVE feed move the marker: a lower-priority feed is ignored while a
// higher one is still fresh, and takes over only once the higher goes stale
// (SELF_STALE_MS) — e.g. when the phone screen backgrounds and its mirror stops, the
// fg/bg feeds resume within ~2 s. Because the first write and any post-staleness write are
// always accepted, selfLat/selfLng are never left null, so the logo-fallback can't return.
export type SelfPosSource = 'mirror' | 'fgwatch' | 'bgtask';
const SELF_SOURCE_RANK: Record<SelfPosSource, number> = { mirror: 3, fgwatch: 2, bgtask: 1 };
// Kept well above the 500 ms mirror interval so interleaved fg/bg fixes are rejected
// while the mirror is alive, but short enough that if a higher-priority feed dies
// (phone screen sleeps → mirror stops) the surviving lower feed takes over quickly.
// 1200 → 2600 (2026-07-16 drive test): the same-day bg-cadence bump (fg/bg feeds now
// tick at 1 s/5 m) let RAW-GPS fixes slip between the phone's ROUTE-SNAPPED mirror
// fixes whenever the mirror paused >1.2 s (render hitch, GPS gap) — the marker
// zigzagged between the two tracks ("very jittery even when plugged in"). 2.6 s
// rejects those interleaves; screen-off handoff now takes ≤2.6 s once, then the
// lower feed owns the marker (and the SelfCarModel watchdog keeps it easing).
const SELF_STALE_MS = 2600;
let lastSelfPos: { ts: number; rank: number } | null = null;

export function setCarSelfPosition(
  lat: number,
  lng: number,
  heading: number | null,
  source: SelfPosSource,
  // SPEED THROUGH THE SAME GATE (2026-07-30). speedMs used to be written by all three
  // feeds with plain setCarState, OUTSIDE this gate — the comments at those call sites
  // even said so deliberately. But speedMs drives the chase ZOOM curve
  // (CarMapView: chaseZoom(kmh, …)), so a feed whose POSITION was rejected as
  // lower-priority was still free to move the camera's zoom target. Position came from
  // one track and framing from another. Passing it here keeps the two in agreement: if
  // the fix is not good enough to move the car, it is not good enough to move the zoom.
  speedMs?: number | null,
) {
  const now = Date.now();
  const rank = SELF_SOURCE_RANK[source];
  const cur = lastSelfPos;
  // dt < 0 = the wall clock stepped backward (NTP / manual set); treat as stale so a clock
  // jump can never leave a dead higher feed looking permanently fresh and freeze the marker.
  const dt = cur ? now - cur.ts : Infinity;
  const stale = dt > SELF_STALE_MS || dt < 0;
  // Ignore ONLY a lower-priority feed overwriting a still-fresh higher-priority fix.
  // Same/higher priority always writes; after staleness the next feed takes over. The first
  // write (cur null → stale) and every post-staleness write are accepted, so selfLat/selfLng
  // are never left null → the CONVOY-logo fallback cannot return.
  if (cur && !stale && rank < cur.rank) return;
  lastSelfPos = { ts: now, rank };
  // STICKY HEADING (2026-07-30). iOS reports course = -1 whenever it cannot determine
  // one — at low speed, at a standstill, and on the first fixes after a restart — and
  // both the fg and bg feeds translate that to `null` (navNotification.ts:306, :389).
  // The car surface then coerced null to 0 (`s.heading ?? 0`), which is DUE NORTH, so
  // the 3D car yawed to north and back while the camera held its last good bearing
  // (CarMapView keeps `camHdgRef` only for real numbers). That is a visible spin against
  // a stationary map, and it is worst exactly where course is unavailable: crawling and
  // stopped. The phone's own mirror has always been sticky (`heading ?? cur?.heading`,
  // map.tsx) — this brings the store in line, so every consumer inherits it.
  const prevHeading = getCarState().heading;
  const nextHeading = (typeof heading === 'number' && Number.isFinite(heading))
    ? heading
    : (typeof prevHeading === 'number' ? prevHeading : null);
  setCarState({
    selfLat: lat, selfLng: lng, heading: nextHeading,
    ...(typeof speedMs === 'number' && Number.isFinite(speedMs) && speedMs >= 0 ? { speedMs } : {}),
  });
}

// ── Peers/hazards write GATE (CarPlay-standalone Wave 1) ────────────────────
// Two writers now produce peers + hazards: the WARM phone mirror (useConvoyCarPlay,
// runs only while map.tsx is mounted) and the COLD module-scope carDataService
// (started on CarPlay connect, keeps the head unit fed when the phone app was never
// opened). Plain setCarState is last-writer-wins, so without a gate they'd clobber
// each other on every tick. Same mental model as setCarSelfPosition above: the
// richer 'phone' feed always writes and suppresses 'service' while fresh; when the
// phone screen unmounts/backgrounds (its writes stop), the service takes over after
// FEED_STALE_MS. The first write and any post-staleness write are always accepted.
export type ConvoyFeedSource = 'phone' | 'service';
const FEED_RANK: Record<ConvoyFeedSource, number> = { phone: 2, service: 1 };
// The phone mirror re-writes only when its React deps CHANGE (not on a fixed
// cadence), so this is deliberately generous — long enough that a quiet-but-alive
// phone feed isn't usurped mid-drive, short enough that the cold service takes
// over within one of its own refresh ticks after the phone goes away.
const FEED_STALE_MS = 12_000;
let lastPeersWrite: { ts: number; rank: number } | null = null;
let lastHazardsWrite: { ts: number; rank: number } | null = null;

function feedGateAllows(cur: { ts: number; rank: number } | null, rank: number): boolean {
  if (!cur) return true;
  const dt = Date.now() - cur.ts;
  const stale = dt > FEED_STALE_MS || dt < 0; // dt<0 = wall clock stepped back → treat stale
  return stale || rank >= cur.rank;
}

export function setCarPeers(peers: CarPeer[], source: ConvoyFeedSource) {
  const rank = FEED_RANK[source];
  if (!feedGateAllows(lastPeersWrite, rank)) return;
  lastPeersWrite = { ts: Date.now(), rank };
  setCarState({ peers });
}

export function setCarHazards(hazards: NonNullable<CarState['hazards']>, source: ConvoyFeedSource) {
  const rank = FEED_RANK[source];
  if (!feedGateAllows(lastHazardsWrite, rank)) return;
  lastHazardsWrite = { ts: Date.now(), rank };
  setCarState({ hazards });
}

/**
 * READ-ONLY: would a peers/hazards write from `source` be ACCEPTED right now?
 *
 * Ownership is unchanged — this is literally the predicate setCarPeers/setCarHazards
 * already run, exposed so a writer that is about to be REJECTED can skip building the
 * payload it would have thrown away. It stamps nothing (no ts, no rank), so asking can
 * never claim the feed, and the real gate still runs on the real write.
 *
 * Why it exists: carDataService's emitPeers/emitHazards run on every WS frame, every
 * presence sync and every REST refresh while a head unit is connected, and each one
 * merges + maps the whole peer/hazard set before handing it to a gate that drops it
 * outright while the phone mirror is fresh.
 */
export function carFeedWouldAccept(kind: 'peers' | 'hazards', source: ConvoyFeedSource): boolean {
  return feedGateAllows(kind === 'peers' ? lastPeersWrite : lastHazardsWrite, FEED_RANK[source]);
}

// ── NAV-STRIP write GATE (2026-08-13) ───────────────────────────────────────
// WHY: Olaf's drive on build 72 — the phone banner read "11 min" while CarPlay read
// "43 min · 27 km" AT THE SAME MOMENT (photo of the head unit). Both surfaces are
// supposed to show one number; the car's came from a different engine than the phone's.
//
// The two writers of these fields:
//   WARM (ConvoyCarPlay's mirror, while tbt.active) — mirrors tbt.etaSeconds, which is
//        the phone's TIER-1 SEGMENT-accurate ETA (nav.ts: findRouteSegment + suffix
//        table). It does not use the step index at all.
//   COLD (navNotification.updateNavBanner, every fix) — remainM = distance to the
//        current step's end + the lengths of every LATER step, times a flat average
//        pace. Both of its numbers hang off its own step index.
//
// So a cold value on screen while the phone is guiding shows a step-derived estimate
// next to a segment-derived one. On Olaf's drive the cold step index was frozen (its
// walk only advances within 25 m of a maneuver point — the same proximity-walk defect
// already measured on the phone engine), which inflates remainM AND the ETA by the
// same factor. That is why "43 min · 27 km" looked self-consistent: both numbers share
// one wrong input. The phone's 11 min was the correct number.
//
// isPhoneTbtSpeaking() was already supposed to prevent this, but it is a module-level
// boolean, so it only arbitrates INSIDE one JS context and it says nothing about
// whether the value currently on screen is fresh. Neither writer clears the other's
// fields, so a cold value written once (before the phone engine went active, or from
// the bg task's own context — see the "separate bg JS context" note at its call site)
// can simply SIT there while the phone counts down past it. The arrival clock is
// recomputed as `now + etaSeconds` on every render, so a frozen ETA still looks live.
//
// This gate is the same mental model as setCarSelfPosition / setCarPeers above, and it
// closes both paths: the phone's numbers always write and suppress the cold engine
// while they keep arriving; the cold engine takes the strip only once the phone's have
// gone quiet for STRIP_STALE_MS. A stale value can no longer outlive its writer.
export type NavStripSource = 'phone' | 'cold';
const STRIP_RANK: Record<NavStripSource, number> = { phone: 2, cold: 1 };
// The warm mirror re-writes when its React deps change — i.e. on every GPS tick while
// guiding (~1 Hz), but not on a fixed cadence. 6 s is long enough that a render hitch
// or a brief GPS gap doesn't hand the strip to the cold engine mid-drive, and short
// enough that a genuinely dead phone mirror (screen unmounted, app torn down) is taken
// over within a few of the cold feed's own 1 Hz ticks.
const STRIP_STALE_MS = 6000;
let lastStripWrite: { ts: number; rank: number } | null = null;

/**
 * Ask for the strip on behalf of `source`, taking ownership when granted.
 *
 * Deliberately a CLAIM rather than a write: both callers already build one big
 * setCarState per tick, and every setCarState notifies every listener, so a separate
 * strip write would re-render the car surface twice per GPS tick. That extra redraw is
 * the exact "banner redrawing" half of the 7/31 glitch report — fixing an ETA bug by
 * reintroducing the flicker beside it is not a fix. Callers spread the strip fields into
 * their existing single write when this returns true.
 */
export function claimCarNavStrip(source: NavStripSource): boolean {
  const rank = STRIP_RANK[source];
  const cur = lastStripWrite;
  if (cur) {
    const dt = Date.now() - cur.ts;
    // dt < 0 = the wall clock stepped backward (NTP / manual set); treat as stale so a
    // clock jump cannot leave a dead writer looking permanently fresh and freeze the strip.
    const stale = dt > STRIP_STALE_MS || dt < 0;
    if (!stale && rank < cur.rank) return false;
  }
  lastStripWrite = { ts: Date.now(), rank };
  return true;
}

/**
 * Drop strip ownership so the next writer of ANY rank is accepted immediately. Called on
 * nav teardown: without it, the phone's last write would keep the cold engine locked out
 * of the FOLLOWING drive for STRIP_STALE_MS.
 */
export function releaseCarNavStrip() { lastStripWrite = null; }

export function getCarState(): CarState {
  return state;
}

// Imperative subscription for module-scope services (no React). The cold
// carDataService drives its refresh throttles off these ticks — the background
// location task keeps writing positions while the phone is locked, so position
// ticks are the reliable event source (JS timers can stall when locked).
export function subscribeCarState(fn: (s: CarState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useCarStore(): CarState {
  const [s, setS] = useState<CarState>(state);
  useEffect(() => {
    const l = (next: CarState) => setS(next);
    listeners.add(l);
    setS(state); // sync any state set before this subscribed
    return () => { listeners.delete(l); };
  }, []);
  return s;
}

// ── CarPlay map gestures ───────────────────────────────────────────────────
// Transient touch commands (NOT persistent state), so they ride a tiny pub/sub
// bus rather than CarState — same pattern as voiceBus/hailBus. ConvoyCarPlay's
// CPMapTemplate gesture callbacks (wired via the react-native-carplay patch)
// emit here; CarMapView subscribes and folds them into its camera. Only zoom is
// consumed today (it adds a bias to the lockstep's follow-zoom without touching
// SelfCarModel); pan/rotate/pitch are carried for future use. `scale` is the
// CarPlay pinch scale factor relative to the gesture start (1.0 at begin).
export type CarGesture =
  | { kind: 'zoomBegin' }
  | { kind: 'zoom'; scale: number; velocity: number }
  | { kind: 'zoomEnd'; velocity: number }
  // Discrete one-level step from the +/- map buttons (CarPlay and Android Auto).
  | { kind: 'zoomStep'; delta: number }
  | { kind: 'recenter' }
  | { kind: 'crewFit' }
  | { kind: 'compass' }
  // RN-surface Scout mic tap → map.tsx (same JS context) toggles the voice agent.
  // EXPERIMENT: native map buttons are covered by our RN car surface, so this
  // tests whether the surface ITSELF receives CarPlay taps.
  | { kind: 'scoutMic' };

const gestureListeners = new Set<(g: CarGesture) => void>();

export function emitCarGesture(g: CarGesture) {
  gestureListeners.forEach((l) => l(g));
}

export function subscribeCarGesture(fn: (g: CarGesture) => void): () => void {
  gestureListeners.add(fn);
  return () => { gestureListeners.delete(fn); };
}

// ── SETTINGS → CAR MIRROR (module scope, registered exactly once) ─────────────
// WHY THIS EXISTS. Five car-surface values are settings-derived, and until now the
// only thing that pushed them was useConvoyCarPlay's big metadata effect in
// ConvoyCarPlay.tsx — i.e. they reached the head unit as a SIDE EFFECT of that effect
// re-running, and only while the phone's map screen was mounted. Two consequences,
// both read out of the code rather than guessed:
//   1. COLD CAR SESSION (head unit connected without map.tsx ever mounting): nothing
//      writes them. selfMarkerType stays undefined, so CarMapView.tsx:418
//      (`s.selfMarkerType === 'arrow'`) is false and a driver set to ARROW gets the 3D
//      car; routeColor stays undefined, so CarMapView.tsx:1282 falls back to
//      ROUTE_GREEN_CORE and a custom route colour reverts to green.
//      (navNotification.ts:576 and :666 do cover selfCarColor + mapMode on the cold
//      feeds — those TWO only, and only from the first GPS fix onward.)
//   2. Memoising that metadata effect removes the accidental refresh that was masking
//      (1) on the warm path — so this mirror is its mandatory companion, not a nicety.
//
// Writes ONLY these five keys. Every other settings change (activeThreadId, the audio
// sliders, gas brands…) lands on setCarState's equality short-circuit above and
// notifies nobody.
//
// ⚠ THE try/catch IS LOAD-BEARING. settings.ts notifies with a bare
// `listeners.forEach((l) => l(cached))` (settings.ts:458 and :496 — no per-listener
// guard), so a throw in here would abort that loop and every listener added after us,
// including live useSettings() subscribers, would stop updating. Never let it throw.
//
// ⚠ REGISTERED EXACTLY ONCE per JS context: this is module scope and Metro evaluates a
// module once per context. settings' `listeners` is a Set, so even a repeat add of this
// same reference is a no-op. (A dev Fast-Refresh re-evaluation would create a second,
// distinct closure — harmless: it writes identical values and the equality gate above
// drops the duplicate.)
function mirrorSettingsToCar(s: Settings): void {
  try {
    setCarState({
      selfCarColor: s.carColor,
      mapMode: getMapMode(s),
      selfMarkerType: getSelfMarkerType(s),
      routeColor: getRouteColor(s),
      speedUnit: s.speedUnit,
    });
  } catch {}
}
subscribeSettings(mirrorSettingsToCar);
// Fire once for the CURRENT value. Required on BOTH orderings: evaluated before the
// AsyncStorage hydration completes, this writes the defaults now and the hydration
// notify (settings.ts:458) corrects them a moment later; evaluated after hydration,
// that notify has already gone out and this call is the only thing that seeds the store.
mirrorSettingsToCar(getSettings());
