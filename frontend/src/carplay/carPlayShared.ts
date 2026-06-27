// Tiny shared flag so the app-root CarPlay bootstrap (carPlayBootstrap.ts) and
// the phone map screen's useConvoyCarPlay hook don't fight over the CarPlay root
// template — and so the bootstrap's idle GPS feed stands down the moment the
// phone hook takes over (the hook feeds richer state: route + live nav).
export let carPlayHookOwnsRoot = false;

// Master kill-switch for the LIVE @rnmapbox MapView on the CarPlay window.
// FALSE (current): the car always renders the proven static Mapbox Static-Images
// surface — instant, reliable, no blank. The live GL map is gated OFF until a
// native build (MapboxMaps SDK bump) confirms it actually paints on the secondary
// CarPlay window. The frame watchdog in CarMapView is wired and ready, so flipping
// this to TRUE (via OTA, after that build) is safe: a non-painting GL surface
// auto-demotes to static within ~6s. This is also the instant OTA rollback lever.
export const CAR_LIVE_MAP_ENABLED = false;

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
