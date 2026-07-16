// hairpin-system — typed accessor for the local native module (iOS only).
// Mirrors the convoy-call-detector pattern: requireOptionalNativeModule so JS
// is a clean no-op on Android/web and on builds cut before this module existed.
import { requireOptionalNativeModule } from 'expo-modules-core';

export type HairpinVisit = {
  lat: number;
  lng: number;
  // ms epoch; 0 when CLVisit reports the bound as unknown (distantPast/Future).
  arrivalTs: number;
  departureTs: number;
  horizontalAccuracy: number;
};

type HairpinSystemModule = {
  startVisitMonitoring(): void;
  stopVisitMonitoring(): void;
  setSharedDefaults(suite: string, key: string, json: string): void;
  addListener(eventName: 'onVisit', listener: (v: HairpinVisit) => void): { remove: () => void };
};

let mod: HairpinSystemModule | null = null;
try {
  mod = requireOptionalNativeModule<HairpinSystemModule>('HairpinSystem');
} catch {
  mod = null;
}

export const HairpinSystem = mod;
