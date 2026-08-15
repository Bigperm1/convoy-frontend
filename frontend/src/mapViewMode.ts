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

// false = 3D (the default, unchanged from before this existed).
let _twoD = false;
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
export function resetMapView2D(): void {
  setMapView2D(false);
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
