// Tiny shared flag so the app-root CarPlay bootstrap (carPlayBootstrap.ts) and
// the phone map screen's useConvoyCarPlay hook don't fight over the CarPlay root
// template.
//
// When the phone map screen is mounted, its useConvoyCarPlay hook OWNS the
// CarPlay root (richer template + live nav session). The bootstrap then stands
// down. The bootstrap only sets its minimal idle root when the hook is NOT
// mounted — i.e. a COLD CarPlay connect where the phone UI hasn't started, which
// is exactly the case the hook can't cover (it lives inside the phone screen).
export let carPlayHookOwnsRoot = false;

export function setCarPlayHookOwnsRoot(v: boolean): void {
  carPlayHookOwnsRoot = v;
}
