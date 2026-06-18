// avatarHoldBus — tiny pub/sub so the Map TAB button (in the tab bar, app/(app)/
// _layout.tsx) can ask the Map SCREEN (app/(app)/map.tsx) to open the hold-to-
// activate "Avatar" panel. Mirrors the other module-level Set<Listener> buses
// (voiceBus, hailBus, …). A long-press on the Map tab emits here; map.tsx
// subscribes and toggles its panel. A normal tap still just navigates to Map.

type Listener = () => void;

const listeners = new Set<Listener>();

export function emitAvatarHold(): void {
  listeners.forEach((l) => {
    try { l(); } catch {}
  });
}

export function subscribeAvatarHold(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
