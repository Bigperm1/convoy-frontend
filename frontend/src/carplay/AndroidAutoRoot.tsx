// src/carplay/AndroidAutoRoot.tsx
//
// The headless React root that react-native-carplay runs INSIDE the Android Auto
// car session. This is the piece that makes Android Auto actually work.
//
// Why this exists / how Android Auto bootstraps:
//   When a head unit connects, react-native-carplay's CarPlaySession (Kotlin)
//   does `AppRegistry.runApplication("AndroidAuto", ...)` and then sets the car
//   context (see node_modules/react-native-carplay/android/.../CarPlaySession.kt
//   and CarPlayModule.setCarContext). So the car UI must be built by an
//   AppRegistry component registered under the EXACT key "AndroidAuto"
//   (registered at app launch in registerAndroidAuto.ts). If that root doesn't
//   exist, the car connects but renders nothing — which is exactly why Android
//   Auto wasn't working: Convoy only ever built its car UI inside
//   useConvoyCarPlay (mounted by map.tsx), which doesn't run in the car session
//   and isn't even mounted unless the phone is on the map screen.
//
// iOS/CarPlay does NOT use this path — there, templates are built in the running
// app's JS context (useConvoyCarPlay). This root is Android-Auto-only.
//
// It renders no phone UI (returns null). The visible car surface is the
// CarSurface component handed to the NavigationTemplate (react-native-carplay
// registers it under the template id and renders it onto the car's map surface).
// Live drive data flows in through carStore, which map.tsx mirrors via
// useConvoyCarPlay while a route is active.

import { useEffect, useRef } from 'react';
import { CarSurface } from './ConvoyCarPlay';
import { useCarStore } from './carStore';

// androidx.car.app Distance unit constant: meters = 1 (Distance.UNIT_METERS).
const AA_UNIT_METERS = 1;

// One persistent action in the strip (Android Auto requires a non-empty action
// strip on a NavigationTemplate). Kept stable across updates.
const AA_ACTIONS = [{ id: 'convoy-aa-brand', title: 'Convoy' }];

export default function AndroidAutoRoot() {
  const s = useCarStore();
  const templateRef = useRef<any>(null);

  // Build the single navigation template once and make it the car's root.
  useEffect(() => {
    try {
      // Lazy require: react-native-carplay runs native side effects at import,
      // so we never pull it into the web/iOS evaluation path. registerAndroidAuto
      // only mounts this root on Android with the native module present.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CarPlay, NavigationTemplate } = require('react-native-carplay');
      const template = new NavigationTemplate({
        id: 'convoy-aa-nav',
        component: CarSurface,
        actions: AA_ACTIONS,
      });
      templateRef.current = template;
      CarPlay.setRootTemplate(template);
    } catch (e) {
      console.warn('[AndroidAuto] root template setup failed', e);
    }
    return () => {
      templateRef.current = null;
    };
  }, []);

  // Push live maneuver + travel estimates whenever the shared drive state moves.
  useEffect(() => {
    const template = templateRef.current;
    if (!template) return;
    try {
      if (s.navigating) {
        template.updateTemplate({
          component: CarSurface,
          actions: AA_ACTIONS,
          navigationInfo: {
            type: 'routingInfo',
            nextStep: { cue: s.instruction || 'Continue' },
            distance: Math.max(0, Math.round(s.distanceToTurnM || 0)),
            distanceUnits: AA_UNIT_METERS,
          },
          travelEstimate: {
            distanceRemaining: (s.distanceRemainingM || 0) / 1000,
            timeRemaining: s.etaSeconds || 0,
          },
        });
      } else {
        // Idle (no active route): clear nav info, keep the branded surface up.
        template.updateTemplate({ component: CarSurface, actions: AA_ACTIONS });
      }
    } catch (e) {
      console.warn('[AndroidAuto] updateTemplate failed', e);
    }
  }, [s.navigating, s.instruction, s.distanceToTurnM, s.distanceRemainingM, s.etaSeconds]);

  return null;
}
