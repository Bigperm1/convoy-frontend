// src/carplay/carPlayBootstrap.ts
//
// App-root CarPlay bootstrap (iOS only).
//
// THE PROBLEM IT SOLVES — COLD CARPLAY CONNECT.
// All the rich CarPlay template/nav logic lives in useConvoyCarPlay(), which
// only runs while the phone's map screen (app/(app)/map.tsx) is mounted. On a
// COLD connect — the head unit opens Convoy while the phone app isn't running —
// that hook never mounts, so nothing would set a CarPlay root template and the
// car screen would sit blank (the native CarSceneDelegate boots the RN host and
// mounts the dashboard view, but CarPlay still needs a root CPTemplate to show
// anything).
//
// This module runs at app startup (called from index.js), listens for the
// CarPlay connection, and sets a MINIMAL idle root MapTemplate so the Convoy
// dashboard (ConvoyCarSurface, mounted natively) shows. The instant the phone
// map screen mounts, useConvoyCarPlay takes ownership (sets its own root with a
// live nav session) and this bootstrap stands down — coordinated through the
// carPlayHookOwnsRoot flag so the two never fight over the root.
//
// Fully guarded: no-op on web/Android and on any build without the native
// RNCarPlay module, and every CarPlay call is wrapped so it can never crash at
// startup. Behaviour for the WARM path (phone app already open) is unchanged —
// the hook owns the root, so this never sets one.

import { NativeModules, Platform } from 'react-native';
import { carPlayHookOwnsRoot } from './carPlayShared';

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
    // The phone map screen owns the root whenever it's mounted — don't fight it.
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

  try {
    CarPlay.registerOnConnect(setIdleRoot);
    // Cold launch: the native scene may have already connected before this JS
    // ran, so honour an existing connection right away.
    if (CarPlay.connected) setIdleRoot();
  } catch {
    // react-native-carplay not ready yet — ignore; the hook covers the warm path.
  }
}
