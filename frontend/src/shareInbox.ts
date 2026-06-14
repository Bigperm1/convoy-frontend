// shareInbox.ts — hand-off for a share the user chose to ACT on by tapping
// "View"/"Open" on the global ShareToast. The toast drops the payload here and
// pings; the destination screen (map for routes, music for songs) consumes it
// ONCE — via the ping when it's already mounted (e.g. you're already on the
// map), or on its next focus for a cold start where the screen wasn't mounted
// when the share arrived. take* nulls the slot so the ping handler and the
// focus effect can never both apply the same payload.
//
// We deliberately do NOT auto-apply a share the instant it arrives over the
// wire — that would yank a driver into a route preview unprompted. The apply
// is always gated on the user tapping the toast.
type Listener = () => void;

export type PendingRoute = { lat: number; lng: number; label: string; fromHandle?: string; sharedAt?: number };
export type PendingMusic = { title?: string; artist?: string; url?: string };
export type PendingComm = { id: string; channel?: string };

let _route: PendingRoute | null = null;
let _music: PendingMusic | null = null;
let _comm: PendingComm | null = null;
const listeners = new Set<Listener>();

export const shareInbox = {
  setRoute(r: PendingRoute) { _route = r; },
  takeRoute(): PendingRoute | null { const r = _route; _route = null; return r; },
  setMusic(m: PendingMusic) { _music = m; },
  takeMusic(): PendingMusic | null { const m = _music; _music = null; return m; },
  setComm(c: PendingComm) { _comm = c; },
  takeComm(): PendingComm | null { const c = _comm; _comm = null; return c; },
  // Notify any mounted consumers that something new is waiting.
  ping() { listeners.forEach((l) => { try { l(); } catch {} }); },
  subscribe(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l); }; },
};
