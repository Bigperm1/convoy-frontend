// mapViewMode.ts — the 2D / 3D view toggle, shared by all four surfaces.
//
// ── WHAT THIS IS (Jeff, 2026-08-14) ─────────────────────────────────────────────
// "i think to have the option of 2D for convoy mode and 3D for user mode with the 2D
//  sprites on a 2D map."
//
// The reason is VISUAL, not performance: the 3D self-car took weeks to get right, and
// twenty of them on a pitched map with buildings reads as clutter. Flat + top-down is how
// a driver actually reads a convoy — who is ahead, who is behind, how far.
//
// ⚠ IT IS A VIEW TOGGLE, NOT A NAV MODE. Jeff: "i would still want the route to be
// visible with the route line in the 2D mode and 3D mode... but with the route line and
// routing still active." Nothing here touches guidance, the route, TTS or arrival. It
// changes camera pitch and which marker art is drawn. That is all.
//
// ── LIFETIME: SESSION, NOT A SETTING ────────────────────────────────────────────
// "default is unchanged, you press the 2d/3d button to go to 2d... it sticks till route
//  ends or manually pushed button again."
// So this is deliberately NOT persisted in settings.ts. It is in-memory state that
// resets to 3D when a route ends (resetMapView2D, called from the nav teardown), and
// otherwise survives until the driver presses the button again. Persisting it would
// contradict "default is unchanged" on the next launch.
//
// ── WHY A MODULE-LEVEL BUS ──────────────────────────────────────────────────────
// The phone map (app/(app)/map.tsx) and the car surface (src/carplay/*) are separate
// React roots with no shared provider, and carActions must be able to toggle it from a
// CarPlay bar button with no React context at all. Same pattern as voiceBus / hailBus /
// livePtt in this codebase: a module-level Set of listeners, emit + subscribe.

import { useEffect, useState } from 'react';
import { getSettings, subscribeSettings } from './settings';
import { getGarage, subscribeGarage } from './garageStore';

type Listener = (twoD: boolean) => void;

// ── LIFECYCLE INVERTED (Jeff, 2026-08-18) ───────────────────────────────────────
// "the non routing view is the 2d mode with the high res png files not the 3d with
// the GLB marker. 3D should only be when routing with the option to 2D by pushing
// the button."
// So: IDLE (no route) = 2D flat + the 512px sprites, everywhere including the car
// surfaces (their carFlat path already draws the same sprite art). Starting a route
// forces 3D (startNavBanner — the universal start). The button remains a session
// override DURING a drive; route end resets back to the 2D idle default
// (resetMapView2D — the universal teardown already calls it).
// true = 2D (the idle default per the 8/18 rule). This is what the drive ASKED for (route start, the button, the
// teardown); the view actually shown is `_twoD || isMapView2DLocked()` — see below.
let _twoD = true;
const listeners = new Set<Listener>();

// ── THE GARAGE'S 2D CARS KEEP THE MAP FLAT (Jeff, driving, 2026-09-23) ──────────
// "when I go to the garage and I click on the free tier arrow top down and go back to the map, it's showing on
//  CarPlay that it's in 3D, but it needs to be stuck on 2D. Also, with the silver tier, it needs to be 2D as well and
//  no 3D because that's the gate for the tiers."
// The 3D map is Gold's (entitlements.ts: gold = "the 3D map and a 3D class car"). Free's car is the 2D arrow and
// Silver's the 2D class car, so while either is on the road every surface stays flat — route start, the phone's 2D/3D
// button and the CarPlay / AA view button all ask for 3D and are simply not granted. The 3D arrow, the 3D class car and
// a scan (Gold / Ultra) are untouched: they follow the drive exactly as before. Keyed to the CAR, not the paid tier,
// so it holds with entitlements off (ENTITLEMENTS_ENFORCED) — the Garage is where the tier is chosen today.
// Telemetry from that drive: `garage-drive car=arrow` at 00:39:47Z, then cam-probe surf=car p=48 (pitched) until
// his own `carplay-tap:car-view` at 00:40:07Z.
/** The car on the road is a 2D car (Free's arrow, Silver's class car): the map may not go 3D. */
export function isMapView2DLocked(): boolean {
  try {
    const marker = getSettings().selfMarkerType ?? 'car';
    if (marker === 'class') return true;
    // The 2D and the 3D arrow are one marker; the Garage remembers which one was picked.
    if (marker === 'arrow') return getGarage().arrowPick !== 'arrow3d';
    return false;
  } catch {
    return false;
  }
}

/** Current view. true = flat 2D "convoy" view, false = 3D. */
export function isMapView2D(): boolean {
  return _twoD || isMapView2DLocked();
}

let _shown = isMapView2D();
function emit() {
  const v = isMapView2D();
  if (v === _shown) return;
  _shown = v;
  listeners.forEach((l) => {
    // One bad listener must never stop the others from re-rendering — a half-applied
    // view (flat camera, 3D car) is the one state that looks broken rather than plain.
    try { l(v); } catch {}
  });
}
// A Garage pick changes the car mid-drive: re-evaluate. The 3D a route asked for comes back when a 3D car does.
subscribeSettings(() => emit());
subscribeGarage(() => emit());

/** Set explicitly. No-ops when unchanged, so this can be called freely. */
export function setMapView2D(twoD: boolean): void {
  if (_twoD === twoD) return;
  _twoD = twoD;
  emit();
}

/** The button. Returns the NEW view so a caller can echo it to the driver. With a 2D car on the road it changes
 *  nothing and answers 2D (the car surfaces' toast then reads "2D view" — the truth). */
export function toggleMapView2D(): boolean {
  if (isMapView2DLocked()) return true;
  _twoD = !_twoD;
  emit();
  return isMapView2D();
}

/**
 * Back to 3D. Called from the nav teardown so the driver's 2D choice lasts exactly as
 * long as the drive did — "it sticks till route ends". Safe to call when already 3D.
 */
/** Back to the IDLE default — 2D since the 8/18 rule (was 3D). Called by the
 * universal nav teardown, so 3D lasts exactly as long as a drive. */
export function resetMapView2D(): void {
  setMapView2D(true);
}

export function subscribeMapView2D(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** React binding for the phone map and the car surface. */
export function useMapView2D(): boolean {
  const [v, setV] = useState(isMapView2D());
  useEffect(() => {
    // Re-read on mount: the value may have changed between module load and this mount
    // (a cold CarPlay connect toggling before the phone map exists, for instance).
    setV(isMapView2D());
    return subscribeMapView2D(setV);
  }, []);
  return v;
}

/** React binding: the car on the road keeps the map 2D. The 2D/3D buttons then become the Gold tease ("Upgrade to Gold
 *  for 3D") on the phone FAB and the car's view button, and the Android Auto strip rebuilds when this changes. */
export function useMapView2DLocked(): boolean {
  const [v, setV] = useState(isMapView2DLocked());
  useEffect(() => {
    const read = () => setV(isMapView2DLocked());
    read();
    const offS = subscribeSettings(read);
    const offG = subscribeGarage(read);
    return () => { offS(); offG(); };
  }, []);
  return v;
}
