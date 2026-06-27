// src/carplay/carPlayBootstrap.ts
//
// App-root CarPlay bootstrap (iOS only). Run at startup from index.js.
// Sets a minimal idle root MapTemplate AND acquires the SHARED background-
// location task (navNotification.acquireBgLocation) so carStore.selfLat/selfLng
// is fed on a cold connect and CarSurface can draw the map. Uses the BACKGROUND
// task, not foreground watchPositionAsync, because iOS starves foreground
// location once the app is backgrounded behind the head unit. The task is
// refcounted/shared with the nav banner so they never fight over iOS's single
// background-location slot.

import { NativeModules, Platform } from 'react-native';
import * as Location from 'expo-location';
import { carPlayHookOwnsRoot } from './carPlayShared';
import { setCarState } from './carStore';
import { acquireBgLocation, releaseBgLocation, hydrateCarRouteFromDisk } from '../navNotification';

let booted = false;

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
    setIdleRoot();
    void acquireBgLocation('carplay');
    // Cold connect: pull the persisted active-route polyline into carStore so the
    // car map draws the real ribbon even though the phone map isn't mounted.
    void hydrateCarRouteFromDisk();
    // One-shot position seed so hasFix flips true IMMEDIATELY on a cold connect,
    // instead of waiting for the first watch tick (which can be ~2s, or never if the
    // app is backgrounded behind the head unit without "Always" permission). setCarState
    // only ADDS — a later streaming tick overwrites this. Last-known is instant; a
    // live one-shot is the fallback. NOTE: this does NOT fix a fully-backgrounded
    // "When In Use" device (iOS won't stream then) — that needs "Always" granted.
    void (async () => {
      try {
        const fg = await Location.getForegroundPermissionsAsync();
        if (!fg.granted) return;
        const p = (await Location.getLastKnownPositionAsync())
          ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
        if (p?.coords) {
          const h = p.coords.heading;
          const sp = p.coords.speed;
          setCarState({
            selfLat: p.coords.latitude,
            selfLng: p.coords.longitude,
            heading: typeof h === 'number' && h >= 0 ? h : null,
            speedMs: typeof sp === 'number' && sp >= 0 ? sp : 0,
          });
        }
      } catch {}
    })();
  };

  const onDisconnect = () => {
    void releaseBgLocation('carplay');
  };

  try {
    CarPlay.registerOnConnect(onConnect);
    CarPlay.registerOnDisconnect(onDisconnect);
    if (CarPlay.connected) onConnect();
  } catch {
    // react-native-carplay not ready yet — ignore; the hook covers the warm path.
  }
}
