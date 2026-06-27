// src/carplay/carStore.ts
//
// Tiny shared store that bridges the phone's React tree and the CarPlay /
// Android Auto surface. The car surface (CarSurface) renders as a SEPARATE
// AppRegistry root, so it can't read map.tsx's props/state directly. map.tsx
// (via useConvoyCarPlay) pushes live state in here; the car surface subscribes
// with useCarStore(). Plain pub/sub, platform-agnostic, safe on web.

import { useEffect, useState } from 'react';
import type { MapMode } from '../settings';

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
  // --- Live map (CarPlay static-map background) ---
  // Self position + heading for centering the car map and rotating the car
  // marker, plus the encoded route geometry. routePolyline is Google's
  // precision-5 overview polyline, which is a drop-in for the Mapbox Static
  // Images API `path` overlay (same encoding). selfLat/selfLng are null until
  // GPS is acquired; heading is null when unknown/stationary; routePolyline is
  // '' when there is no active route.
  selfLat: number | null;
  selfLng: number | null;
  heading: number | null; // degrees, 0 = north
  routePolyline: string;
  // Self car paint (mirror of the phone's settings.carColor). Lets the car root
  // pick the right 3D vehicle model (getVehicleModelUrl). undefined → car root
  // falls back to the default GRC model. Set from the phone mirror feed and the
  // background/foreground location feeds (best-effort on the cold-connect path).
  selfCarColor?: string;
  // Base-map mode (mirror of the phone's getMapMode(settings)). Lets the car map
  // match the phone's style: 'satellite' → SatelliteStreet, else Standard with the
  // matching light preset. undefined → car falls back to the phone default 'dusk'.
  mapMode?: MapMode;
  // Posted speed limit (km/h) for the road the driver is on (OSM/Overpass, fed by
  // the navNotification location feed). undefined/0 → no badge shown.
  speedLimitKmh?: number;
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
  selfLat: null,
  selfLng: null,
  heading: null,
  routePolyline: '',
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
