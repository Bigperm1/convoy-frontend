// Tiny shared flag so the app-root CarPlay bootstrap (carPlayBootstrap.ts) and
// the phone map screen's useConvoyCarPlay hook don't fight over the CarPlay root
// template — and so the bootstrap's idle GPS feed stands down the moment the
// phone hook takes over (the hook feeds richer state: route + live nav).
export let carPlayHookOwnsRoot = false;

// Master kill-switch for the LIVE @rnmapbox MapView on the CarPlay window.
// TRUE: render the live 3D Mapbox map (3D car + route + overlays) on CarPlay. This
// is ON for the MapboxMaps 11.25.0 build (runtime 1.11.0+), which carries Mapbox's
// fix for the "MapView blank on an already-active CarPlay scene" bug (11.24.0+).
// The frame watchdog in CarMapView is the safety net: if the GL surface still fails
// to paint within ~6s it auto-demotes to the static map (never blank). Flip this
// FALSE via OTA as an instant rollback if the live map regresses on any head unit.
// NOTE: do NOT OTA this =true to the OLD runtime (1.10.0 / build <=55) — those
// binaries lack the SDK fix, so live would blank-then-demote there.
export const CAR_LIVE_MAP_ENABLED = true;

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
