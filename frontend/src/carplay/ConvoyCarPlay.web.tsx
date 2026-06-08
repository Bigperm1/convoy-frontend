// src/carplay/ConvoyCarPlay.web.tsx
//
// Web has no CarPlay / Android Auto. This stub keeps react-native-carplay out
// of the web bundle entirely (Metro resolves .web.tsx first), so importing the
// CarPlay layer from shared screens like map.tsx is a harmless no-op on web.

import React from 'react';
import { View } from 'react-native';
import type { NavRoute, LatLng } from '../nav';

type Tbt = {
  active: boolean;
  stepIndex: number;
  distanceToManeuverM: number;
  distanceRemainingM: number;
  etaSeconds: number;
};

type CarPlayArgs = {
  route: NavRoute | null;
  tbt: Tbt;
  user: (LatLng & { speed?: number; heading?: number }) | null;
  destination: (LatLng & { label?: string }) | null;
  peers?: Record<string, any> | null;
  onEnd?: () => void;
};

export function CarSurface() {
  return <View />;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useConvoyCarPlay(_args: CarPlayArgs) {
  // no-op on web
}
