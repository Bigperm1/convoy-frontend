// Tiny shared flag so the app-root CarPlay bootstrap (carPlayBootstrap.ts) and
// the phone map screen's useConvoyCarPlay hook don't fight over the CarPlay root
// template — and so the bootstrap's idle GPS feed stands down the moment the
// phone hook takes over (the hook feeds richer state: route + live nav).
export let carPlayHookOwnsRoot = false;

// Master kill-switch for the LIVE @rnmapbox MapView (the Mapbox SDK 3D map) on the
// CarPlay window — the SAME engine the phone uses. TRUE = render the live SDK map.
// (It was briefly flipped FALSE on a wrong theory that the live map was crashing the
// surface; the magenta probe disproved that — the real blocker was that the bridgeless
// Fabric surface never committed a frame, fixed natively in withConvoyCarPlay.js.)
// CarMapView is now wrapped in an error boundary in ConvoyCarPlay.tsx, so a render
// throw demotes to the static map instead of blanking; the frame watchdog still
// demotes on a GL load failure. Flip FALSE via OTA only as an instant rollback.
export const CAR_LIVE_MAP_ENABLED = true;

// DIAGNOSTIC: when TRUE, CarSurface short-circuits to a dependency-free full-screen
// magenta panel with a live ticking counter — NO map, NO GPS, NO store-derived
// content. It is the ground-truth test for "does the CarPlay React surface paint at
// all on this head unit?" If the head unit turns MAGENTA with a counting number, the
// React tree renders and the bug is in CarSurface's content; if it stays the bare
// CONVOY logo (the iOS splash), the bridgeless Fabric surface is not committing a
// tree and the fix is native. Flip back to FALSE once the question is settled.
export const CAR_DIAG_MODE = false;

const ownerListeners = new Set<(v: boolean) => void>();

export function setCarPlayHookOwnsRoot(v: boolean): void {
  if (carPlayHookOwnsRoot === v) return;
  carPlayHookOwnsRoot = v;
  ownerListeners.forEach((l) => { try { l(v); } catch {} });
}

// Subscribe to ownership changes. Returns an unsubscribe fn. The bootstrap uses
// this to run its idle GPS feed only while the hook is NOT in charge.
export function onCarPlayRootOwnerChange(l: (v: boolean) => void): () => void {
  ownerListeners.add(l);
  return () => { ownerListeners.delete(l); };
}
