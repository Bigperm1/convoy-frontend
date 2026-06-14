// src/carplay/carStore.ts
//
// Tiny shared store that bridges the phone's React tree and the CarPlay /
// Android Auto surface. The car surface (CarSurface) renders as a SEPARATE
// AppRegistry root, so it can't read map.tsx's props/state directly. map.tsx
// (via useConvoyCarPlay) pushes live state in here; the car surface subscribes
// with useCarStore(). Plain pub/sub, platform-agnostic, safe on web.

import { useEffect, useState } from 'react';

export type CarPeer = { id: string; handle: string };

export type CarState = {
  navigating: boolean;
  speedMs: number; // current speed in m/s (0 when stopped/unknown)
  instruction: string; // upcoming maneuver text (while navigating)
  distanceToTurn: string; // e.g. "102 m"
  eta: string; // e.g. "24 min"
  distanceRemaining: string; // e.g. "33 km"
  destinationLabel: string;
  peers: CarPeer[];
  // Raw numeric mirrors of the formatted strings above. Android Auto's
  // NavigationTemplate needs real meters/seconds (it formats them itself), not
  // the pre-formatted phone-banner strings. Populated alongside the strings.
  distanceToTurnM: number; // meters to the next maneuver
  distanceRemainingM: number; // meters to the destination
  etaSeconds: number; // seconds remaining to the destination
};

const initial: CarState = {
  navigating: false,
  speedMs: 0,
  instruction: '',
  distanceToTurn: '',
  eta: '',
  distanceRemaining: '',
  destinationLabel: '',
  peers: [],
  distanceToTurnM: 0,
  distanceRemainingM: 0,
  etaSeconds: 0,
};

let state: CarState = initial;
const listeners = new Set<(s: CarState) => void>();

export function setCarState(patch: Partial<CarState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

export function getCarState(): CarState {
  return state;
}

export function useCarStore(): CarState {
  const [s, setS] = useState<CarState>(state);
  useEffect(() => {
    const l = (next: CarState) => setS(next);
    listeners.add(l);
    setS(state); // sync any state set before this subscribed
    return () => { listeners.delete(l); };
  }, []);
  return s;
}
