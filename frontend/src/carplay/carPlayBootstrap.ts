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
import { setCarState, getCarState } from './carStore';
import { acquireBgLocation, releaseBgLocation, hydrateCarRouteFromDisk, startForegroundCarFeed } from '../navNotification';

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
    // ALSO start the continuous foreground feed directly on connect — independent of
    // map.tsx (which may be unmounted behind CarPlay) and of acquireBgLocation's
    // permission branch. It self-guards (idempotent) and is released with the shared
    // lock on disconnect. This is the main-context writer that keeps the car's GPS
    // fix alive while the phone is in the mount / foreground.
    void startForegroundCarFeed();
    // Cold connect: pull the persisted active-route polyline into carStore so the
    // car map draws the real ribbon even though the phone map isn't mounted.
    void hydrateCarRouteFromDisk();
    // Seed an immediate fix so hasFix flips true at once (instead of waiting for the
    // first watch tick). BOUNDED RETRY: race past a single cold-GPS miss; stop as soon
    // as any feed has landed a fix. Errors are surfaced to carDbg (shown on the car
    // overlay) instead of being silently swallowed — so a failure self-reports on screen.
    void (async () => {
      const fg = await Location.getForegroundPermissionsAsync().catch(() => ({ granted: false }));
      if (!fg.granted) { setCarState({ carDbg: 'seed:no-fg-perm' }); return; }
      const acc = Location.Accuracy.Balanced; // read enum ONCE, outside the catch
      for (let i = 0; i < 8 && CarPlay.connected && getCarState().selfLat == null; i++) {
        try {
          const p = (await Location.getLastKnownPositionAsync())
            ?? (await Location.getCurrentPositionAsync({ accuracy: acc }));
          if (p?.coords) {
            const h = p.coords.heading;
            const sp = p.coords.speed;
            setCarState({
              selfLat: p.coords.latitude,
              selfLng: p.coords.longitude,
              heading: typeof h === 'number' && h >= 0 ? h : null,
              speedMs: typeof sp === 'number' && sp >= 0 ? sp : 0,
              carDbg: 'seed:ok#' + i,
            });
            break;
          }
        } catch (e) { setCarState({ carDbg: 'seed:err#' + i + ':' + String(e).slice(0, 40) }); }
        await new Promise((r) => setTimeout(r, 1500));
      }
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
