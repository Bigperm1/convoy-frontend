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
  // CarPlay-screen frame pump (build 70). Returns false when no CarPlay scene is
  // connected yet, so the caller can retry on connect. See the Swift comment for why
  // this cannot be done in JS: RN's timer pump is bound to the phone's built-in
  // display and stops when the screen powers off.
  startCarFrames(): boolean;
  stopCarFrames(): void;
  // CPWindow.mapButtonSafeAreaLayoutGuide as insets — the region NOT covered by
  // CarPlay's own map buttons, per head unit. null when there is no car window, in
  // which case callers keep their measured fallbacks.
  carMapButtonInsets(): { left: number; top: number; right: number; bottom: number; width: number; height: number } | null;
  addListener(eventName: 'onVisit', listener: (v: HairpinVisit) => void): { remove: () => void };
  addListener(eventName: 'onCarFrame', listener: () => void): { remove: () => void };
};

let mod: HairpinSystemModule | null = null;
try {
  mod = requireOptionalNativeModule<HairpinSystemModule>('HairpinSystem');
} catch {
  mod = null;
}

export const HairpinSystem = mod;
