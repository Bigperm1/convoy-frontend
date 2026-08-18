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
// true = 2D (the idle default per the 8/18 rule).
let _twoD = true;
const listeners = new Set<Listener>();

/** Current view. true = flat 2D "convoy" view, false = 3D. */
export function isMapView2D(): boolean {
  return _twoD;
}

function emit() {
  listeners.forEach((l) => {
    // One bad listener must never stop the others from re-rendering — a half-applied
    // view (flat camera, 3D car) is the one state that looks broken rather than plain.
    try { l(_twoD); } catch {}
  });
}

/** Set explicitly. No-ops when unchanged, so this can be called freely. */
export function setMapView2D(twoD: boolean): void {
  if (_twoD === twoD) return;
  _twoD = twoD;
  emit();
}

/** The button. Returns the NEW value so a caller can echo it to the driver. */
export function toggleMapView2D(): boolean {
  _twoD = !_twoD;
  emit();
  return _twoD;
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
  const [v, setV] = useState(_twoD);
  useEffect(() => {
    // Re-read on mount: the value may have changed between module load and this mount
    // (a cold CarPlay connect toggling before the phone map exists, for instance).
    setV(_twoD);
    return subscribeMapView2D(setV);
  }, []);
  return v;
}
