// hailBus.ts — in-process event bus for "Hail" peer notifications.
//
// When a remote driver hails this device, the inbound push notification (or
// WebSocket fallback) is intercepted in `app/(app)/_layout.tsx` and forwarded
// here. The map screen subscribes to render the existing on-map toast UI.
//
// Using a tiny EventTarget-style bus (rather than React context / Zustand) so
// the listener can live OUTSIDE the React tree (e.g., a notification handler
// registered at module scope) and still wake up the in-tree subscriber.
//
// Created June 2025 as part of the APNs/FCM Hail rollout via Emergent Push.

export type HailEvent = {
  fromHandle: string;
  fromId: string;
};

type Listener = (e: HailEvent) => void;
const listeners = new Set<Listener>();

export const hailBus = {
  emit: (e: HailEvent) => {
    // Snapshot the set so a listener removing itself during emit doesn't
    // mutate the iterator we're walking.
    Array.from(listeners).forEach((l) => {
      try { l(e); } catch { /* swallow — a bad listener shouldn't stop others */ }
    });
  },
  on: (l: Listener) => {
    listeners.add(l);
    // Caller uses the returned fn as the useEffect cleanup.
    return () => { listeners.delete(l); };
  },
};
