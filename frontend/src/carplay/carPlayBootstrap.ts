// src/carplay/carPlayBootstrap.ts
//
// App-root CarPlay bootstrap (iOS only). Run at startup from index.js.
//
// COLD CARPLAY CONNECT — the rich template/nav logic in useConvoyCarPlay() only
// runs while the phone map screen (app/(app)/map.tsx) is mounted. On a cold
// connect (head unit opens Convoy with the phone not on the map screen) that
// hook never mounts, so (1) no CPTemplate is set and (2) nothing feeds
// carStore.selfLat/selfLng — so CarSurface has no GPS fix and shows the static
// dashboard instead of a live map. This bootstrap fixes BOTH: it sets a minimal
// idle root MapTemplate AND runs its own lightweight GPS watcher that pushes the
// driver's live position into carStore, so the car shows a real map centered on
// the car the instant CarPlay connects — no phone screen required. The moment
// the phone screen mounts, useConvoyCarPlay takes ownership (richer root + live
// nav + route) and this idle feed stands down (carPlayHookOwnsRoot), so only one
// GPS watcher ever runs. iOS background-location is already configured in
// app.json, so the idle feed delivers with the phone locked — pure OTA.

import { NativeModules, Platform } from 'react-native';
import * as Location from 'expo-location';
import { carPlayHookOwnsRoot, onCarPlayRootOwnerChange } from './carPlayShared';
import { setCarState } from './carStore';

let booted = false;
let connected = false;
let locSub: Location.LocationSubscription | null = null;

async function startIdleLocationFeed(): Promise<void> {
  // Don't run while the phone hook owns the root — it already feeds richer state.
  if (locSub || carPlayHookOwnsRoot) return;
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return; // phone screen requests it in normal use
    if (locSub || carPlayHookOwnsRoot) return; // re-check after await
    locSub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
      (pos) => {
        if (carPlayHookOwnsRoot) return; // hand off the moment the hook is live
        const h = pos.coords.heading;
        const heading = typeof h === 'number' && h >= 0 ? h : null;
        const sRaw = pos.coords.speed;
        const speed = typeof sRaw === 'number' && sRaw >= 0 ? sRaw : 0;
        setCarState({
          selfLat: pos.coords.latitude,
          selfLng: pos.coords.longitude,
          heading,
          speedMs: speed,
        });
      },
    );
  } catch {
    // expo-location not ready / denied — leave the dashboard fallback in place.
  }
}

function stopIdleLocationFeed(): void {
  try { locSub?.remove(); } catch {}
  locSub = null;
}

export function initCarPlayBootstrap(): void {
  if (Platform.OS !== 'ios' || booted) return;
  if (!(NativeModules as any).RNCarPlay) return;
  booted = true;

  let lib: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    lib = require('react-native-carplay');
  } catch {
    return;
  }
  const { CarPlay, MapTemplate } = lib;
  if (!CarPlay || !MapTemplate) return;

  const setIdleRoot = () => {
    if (carPlayHookOwnsRoot) return;
    try {
      const t = new MapTemplate({
        id: 'convoy-carplay-idle',
        tabTitle: 'Map',
        tabSystemImageName: 'map',
        guidanceBackgroundColor: '#0B0B0C',
        tripEstimateStyle: 'dark',
      });
      CarPlay.setRootTemplate(t);
    } catch {
      // The phone hook will set a proper root once it mounts; safe to ignore.
    }
  };

  const onConnect = () => {
    connected = true;
    setIdleRoot();
    void startIdleLocationFeed();
  };

  const onDisconnect = () => {
    connected = false;
    stopIdleLocationFeed();
    setCarState({ selfLat: null, selfLng: null, heading: null, speedMs: 0 });
  };

  try {
    CarPlay.registerOnConnect(onConnect);
    CarPlay.registerOnDisconnect(onDisconnect);
    if (CarPlay.connected) onConnect();
  } catch {
    // react-native-carplay not ready yet — ignore; the hook covers the warm path.
  }

  // Hook takes over -> stop idle feed; hook releases while still connected -> resume.
  onCarPlayRootOwnerChange((owns) => {
    if (owns) stopIdleLocationFeed();
    else if (connected) void startIdleLocationFeed();
  });
}
