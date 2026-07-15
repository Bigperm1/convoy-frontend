// cruisePlot.ts — one-shot hand-off for plotting a PRE-DESIGNED cruise route
// (Hub P3): meeting point → stops → end, as one multi-stop route on the map.
//
// Same pattern as shareInbox (set → ping → the map consumes ONCE via ping or
// its next focus): a cruise plot is user-initiated (tap the arrival push, or
// "Plot the cruise route" in the detail sheet) — never auto-applied mid-drive.
// map.tsx consumes by setting the destination to the cruise END (falling back
// to the venue for cruises without one) and stashing the via points; its
// route-fetch effect then builds the via-waypoint route through the same
// fetchAiRoute path the learned-routes feature uses, so preview/selection/
// CarPlay mirroring all behave like any other route.

type CruisePoint = { lat: number; lng: number; label?: string };

export type PendingCruise = {
  title: string;
  venue: CruisePoint;
  stops: CruisePoint[];
  end: CruisePoint | null;
};

type Listener = () => void;

let _pending: PendingCruise | null = null;
const listeners = new Set<Listener>();

export const cruisePlot = {
  set(c: PendingCruise) { _pending = c; },
  take(): PendingCruise | null { const c = _pending; _pending = null; return c; },
  ping() { listeners.forEach((l) => { try { l(); } catch {} }); },
  subscribe(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l); }; },
};
