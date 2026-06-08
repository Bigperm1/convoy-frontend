// shareBus.ts — in-process event bus for incoming "share" notifications.
//
// When a member shares a song / route / clip with this device, the inbound
// WebSocket frame (livePtt.ts) and/or the push notification (_layout.tsx) is
// forwarded here. A global <ShareToast> mounted in the (app) layout subscribes
// to render the toast on whatever tab the user is on.
//
// Mirrors hailBus: a tiny module-scope pub/sub so listeners registered OUTSIDE
// the React tree (the WS handler, the notification handler) can wake the
// in-tree toast.

export type ShareKind = "music" | "route" | "comm";

export type ShareEvent = {
  kind: ShareKind;
  fromHandle: string;
  fromId: string;
  payload: any;
};

type Listener = (e: ShareEvent) => void;
const listeners = new Set<Listener>();

export const shareBus = {
  emit: (e: ShareEvent) => {
    Array.from(listeners).forEach((l) => {
      try { l(e); } catch { /* a bad listener shouldn't stop others */ }
    });
  },
  on: (l: Listener) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};
