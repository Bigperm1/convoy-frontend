// Tiny shared flag so the app-root CarPlay bootstrap (carPlayBootstrap.ts) and
// the phone map screen's useConvoyCarPlay hook don't fight over the CarPlay root
// template — and so the bootstrap's idle GPS feed stands down the moment the
// phone hook takes over (the hook feeds richer state: route + live nav).
export let carPlayHookOwnsRoot = false;

// Master kill-switch for the LIVE @rnmapbox MapView on the CarPlay window.
// FALSE: render the PROVEN static Mapbox Static-Images map on CarPlay (heading-up
// street map + car marker + route + the overlays). The live @rnmapbox GL MapView
// does NOT render on this head unit even on MapboxMaps 11.25.0 — it crashes the
// CarPlay surface (React tree throws → blank → the iOS splash logo shows through),
// and because the throw happens during render the frame watchdog can't catch it.
// Forcing static gives a reliable, working dashboard. Re-enabling live needs an
// error boundary around CarMapView + a head unit where GL actually paints.
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
