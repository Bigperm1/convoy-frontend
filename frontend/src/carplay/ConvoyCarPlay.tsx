// src/carplay/ConvoyCarPlay.tsx
//
// CarPlay (iOS) + Android Auto layer for Convoy.
//
// A PRESENTATION SURFACE over the existing app — it runs no nav engine and no
// voice of its own. It consumes the live tbt/route/peers already produced in
// map.tsx, mirrors them onto the car display, and pushes a snapshot into
// carStore so the on-surface component (CarSurface) can render live data.
//
// Platform reality:
//   • iOS / CarPlay: a TabBarTemplate with Map (nav) / Comms (member list) /
//     Music (system now-playing). Mirrors the phone's tabs.
//   • Android Auto: navigation-only by platform design — a single
//     NavigationTemplate. No comms/music tabs (Android Auto doesn't allow them
//     for a nav-category app; music there flows through the system media UI).
//
// Voice already plays through the phone (Nova TTS) and routes to the car
// speakers automatically when connected, so there's nothing voice-specific here.
//
// SAFETY: react-native-carplay runs native-module side effects at import, so we
// load it LAZILY and only when its native module (RNCarPlay) is present. No-op
// on web (a ConvoyCarPlay.web.tsx stub keeps it out of the web bundle entirely)
// and on any build without the native module — it can never crash at import.
//
// The car's map AREA (CarSurface) is currently a live DASHBOARD (speed, nearby
// convoy, maneuver). A real street <MapView> on the surface is the next upgrade
// once the DHU confirms what the car surface can host — that's pure JS / OTA.

import React, { useEffect, useRef, useState } from 'react';
import { NativeModules, Platform, View, Text, StyleSheet } from 'react-native';
import { type NavRoute, type LatLng, maneuverVerb, fmtDistanceM, fmtEtaSec } from '../nav';
import { setCarState, getCarState, useCarStore, type CarPeer } from './carStore';

const isIOS = Platform.OS === 'ios';
const isAndroid = Platform.OS === 'android';

// Android `Distance` unit enum (androidx.car.app): meters = 1, kilometers = 2.
// TODO(DHU): confirm this constant renders correctly on the head unit.
const AA_UNIT_METERS = 1;

// react-native-carplay's Android checkForConnection() emits a spurious
// `didConnect` at startup even with NO head unit attached (it calls
// eventEmitter.didConnect() unconditionally). Building any template before a
// real Android Auto session exists crashes natively: createScreen() reads a
// lateinit `carContext` that is only set once the car session connects. So on
// Android we ignore connect events that arrive in the brief window right after
// the library loads (the spurious one); genuine head-unit connections happen
// well after launch and are honored normally.
// TODO(native, next build): the upstream fix is guarding checkForConnection on
// `carContext.isInitialized`; fold that into the next native build and remove
// this JS window-guard at the same time.
const ANDROID_SPURIOUS_CONNECT_GUARD_MS = 5000;
let libLoadedAt = 0;

// ---- lazy, guarded access to react-native-carplay ----
// `undefined` = not yet attempted, `null` = unavailable. Typed loosely on
// purpose (the library is a beta; we only call a handful of runtime methods).
let _lib: any;
function getLib(): any {
  if (_lib !== undefined) return _lib;
  try {
    if (Platform.OS !== 'web' && (NativeModules as any).RNCarPlay) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _lib = require('react-native-carplay');
      libLoadedAt = Date.now();
    } else {
      _lib = null;
    }
  } catch {
    _lib = null;
  }
  return _lib;
}

function stripTags(s: string): string {
  return (s || '').replace(/<[^>]*>/g, '').trim();
}

// ---- The component rendered onto the car screen ----
// Shown the whole time a car is connected — idle (no route) AND during nav.
// Reads the shared store so it shows live data despite being a separate root.
export function CarSurface() {
  const s = useCarStore();
  const kmh = Math.max(0, Math.round((s.speedMs || 0) * 3.6));
  const nearby = s.peers.length;
  return (
    <View style={styles.surface}>
      <View style={styles.center}>
        {s.navigating ? (
          <>
            <Text style={styles.dist}>{s.distanceToTurn || '—'}</Text>
            <Text style={styles.inst} numberOfLines={2}>{s.instruction || 'Continue'}</Text>
            <Text style={styles.meta}>{[s.eta, s.distanceRemaining].filter(Boolean).join('   ·   ')}</Text>
          </>
        ) : (
          <>
            <Text style={styles.brand}>CONVOY</Text>
            <Text style={styles.sub}>{nearby ? `${nearby} ${nearby === 1 ? 'car' : 'cars'} nearby` : 'Drive together'}</Text>
          </>
        )}
      </View>
      <View style={styles.speedPill}>
        <Text style={styles.speedNum}>{kmh}</Text>
        <Text style={styles.speedUnit}>km/h</Text>
      </View>
    </View>
  );
}

// The maneuver we're approaching is the END of the *next* step (verb + road),
// matching the phone banner. Reuses the same maneuverVerb() map.
function upcomingInstruction(route: NavRoute | null, stepIndex: number): string {
  const steps = route?.steps ?? [];
  if (!steps.length) return 'Continue';
  const idx = Math.min(stepIndex + 1, steps.length - 1);
  const step = steps[idx] ?? steps[steps.length - 1];
  return stripTags(step.html) || maneuverVerb(step.maneuver);
}

function toCarPeers(peers?: Record<string, any> | null): CarPeer[] {
  if (!peers) return [];
  return Object.values(peers)
    .map((p: any) => ({ id: p?.user_id, handle: p?.handle }))
    .filter((p) => p.id && p.handle);
}

function buildCommsSections(peers: CarPeer[]) {
  if (!peers.length) return [{ header: 'Convoy', items: [{ text: 'No one nearby' }] }];
  return [{ header: 'Convoy', items: peers.map((p) => ({ text: p.handle, detailText: 'Online' })) }];
}

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

/**
 * Mount ONCE from map.tsx. Mirrors live route + turn-by-turn + nearby-convoy
 * state onto CarPlay (iOS, tabbed) / Android Auto (nav only). No-op on web.
 */
export function useConvoyCarPlay({ route, tbt, user, destination, peers, onEnd }: CarPlayArgs) {
  const [connected, setConnected] = useState(false);

  const mapTemplateRef = useRef<any>(null);
  const commsTemplateRef = useRef<any>(null);
  const navTemplateRef = useRef<any>(null);
  const tripRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const lastStepRef = useRef<number>(-1);

  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  // ---- mirror live state into the shared store (read by CarSurface) ----
  useEffect(() => {
    setCarState({
      navigating: tbt.active,
      speedMs: typeof user?.speed === 'number' ? user.speed : 0,
      instruction: tbt.active ? upcomingInstruction(route, tbt.stepIndex) : '',
      distanceToTurn: tbt.active ? fmtDistanceM(tbt.distanceToManeuverM) : '',
      eta: tbt.active ? fmtEtaSec(tbt.etaSeconds) : '',
      distanceRemaining: tbt.active ? fmtDistanceM(tbt.distanceRemainingM) : '',
      destinationLabel: destination?.label || '',
      peers: toCarPeers(peers),
    });
  }, [
    tbt.active,
    tbt.stepIndex,
    tbt.distanceToManeuverM,
    tbt.etaSeconds,
    tbt.distanceRemainingM,
    route,
    destination?.label,
    peers,
    user?.speed,
  ]);

  // ---- connect / disconnect lifecycle ----
  useEffect(() => {
    const lib = getLib();
    if (!lib) return;
    const { CarPlay, MapTemplate, NavigationTemplate, ListTemplate, NowPlayingTemplate, TabBarTemplate } = lib;

    const setRoot = () => {
      try {
        if (isIOS) {
          const mapTemplate = new MapTemplate({
            id: 'convoy-carplay-map',
            component: CarSurface,
            tabTitle: 'Map',
            tabSystemImageName: 'map',
            guidanceBackgroundColor: '#0B0B0C',
            tripEstimateStyle: 'dark',
            onDidCancelNavigation: () => onEndRef.current?.(),
          });
          mapTemplateRef.current = mapTemplate;

          const commsTemplate = new ListTemplate({
            id: 'convoy-carplay-comms',
            tabTitle: 'Comms',
            tabSystemImageName: 'mic',
            sections: buildCommsSections(getCarState().peers),
            // TODO(PTT): wire tap-to-talk here; true hands-free PTT will use
            // Apple's PushToTalk framework (separate entitlement) later.
            onItemSelect: async () => {},
          });
          commsTemplateRef.current = commsTemplate;

          try { CarPlay.enableNowPlaying(true); } catch {}
          const musicTemplate = new NowPlayingTemplate({
            id: 'convoy-carplay-music',
            tabTitle: 'Music',
            tabSystemImageName: 'music.note',
          });

          const tabBar = new TabBarTemplate({
            id: 'convoy-carplay-tabs',
            templates: [mapTemplate, commsTemplate, musicTemplate],
          });
          CarPlay.setRootTemplate(tabBar);
        } else if (isAndroid) {
          const t = new NavigationTemplate({
            id: 'convoy-aa-nav',
            component: CarSurface,
            actions: [{ id: 'end', title: 'End' }],
          });
          navTemplateRef.current = t;
          CarPlay.setRootTemplate(t);
        }
      } catch (e) {
        console.warn('[CarPlay] setRoot failed', e);
      }
    };

    const onConnect = () => {
      // Ignore react-native-carplay's spurious Android startup connect (see the
      // note by ANDROID_SPURIOUS_CONNECT_GUARD_MS). Without this the library
      // reports "connected" at launch with no car and setRoot() builds a
      // template against an uninitialized carContext -> native crash.
      if (isAndroid && Date.now() - libLoadedAt < ANDROID_SPURIOUS_CONNECT_GUARD_MS) {
        return;
      }
      setConnected(true);
      setRoot();
    };
    const onDisconnect = () => {
      setConnected(false);
      mapTemplateRef.current = null;
      commsTemplateRef.current = null;
      navTemplateRef.current = null;
      tripRef.current = null;
      sessionRef.current = null;
      lastStepRef.current = -1;
    };

    CarPlay.registerOnConnect(onConnect);
    CarPlay.registerOnDisconnect(onDisconnect);
    if (CarPlay.connected) onConnect();

    return () => {
      CarPlay.unregisterOnConnect(onConnect);
      CarPlay.unregisterOnDisconnect(onDisconnect);
    };
  }, []);

  // ---- iOS: keep the Comms tab list in sync with nearby convoy ----
  useEffect(() => {
    if (!isIOS || !connected) return;
    const comms = commsTemplateRef.current;
    if (!comms) return;
    try {
      comms.updateSections(buildCommsSections(toCarPeers(peers)));
    } catch (e) {
      // updateSections method name to confirm on device; safe to ignore.
    }
  }, [connected, peers]);

  // ---- iOS: open / close a navigation session as a route goes active ----
  useEffect(() => {
    const lib = getLib();
    if (!lib || !isIOS || !connected) return;
    const mapTemplate = mapTemplateRef.current;
    if (!mapTemplate) return;

    if (tbt.active && route && user && destination && !sessionRef.current) {
      const trip = new lib.Trip({
        origin: { latitude: user.lat, longitude: user.lng, name: 'Start' },
        destination: {
          latitude: destination.lat,
          longitude: destination.lng,
          name: destination.label || 'Destination',
        },
        routeChoices: [],
      });
      tripRef.current = trip;
      mapTemplate
        .startNavigationSession(trip)
        .then((session: any) => { sessionRef.current = session; lastStepRef.current = -1; })
        .catch((e: any) => console.warn('[CarPlay] startNavigationSession failed', e));
    }

    if (!tbt.active && sessionRef.current) {
      try { sessionRef.current.finish(); } catch {}
      sessionRef.current = null;
      tripRef.current = null;
    }
  }, [connected, tbt.active, route, user?.lat, user?.lng, destination?.lat, destination?.lng]);

  // ---- push live maneuver + ETA on each tick ----
  useEffect(() => {
    if (!getLib() || !connected || !tbt.active || !route) return;
    const label = upcomingInstruction(route, tbt.stepIndex);
    const stepChanged = lastStepRef.current !== tbt.stepIndex;

    if (isIOS) {
      const session = sessionRef.current;
      const mapTemplate = mapTemplateRef.current;
      const trip = tripRef.current;

      if (session) {
        try {
          if (stepChanged) {
            session.updateManeuvers([
              {
                instructionVariants: [label],
                initialTravelEstimates: {
                  distanceRemaining: tbt.distanceToManeuverM,
                  timeRemaining: 0,
                  distanceUnits: 'meters',
                },
              },
            ]);
            lastStepRef.current = tbt.stepIndex;
          }
          session.updateTravelEstimates(0, {
            distanceRemaining: tbt.distanceToManeuverM,
            timeRemaining: tbt.etaSeconds,
            distanceUnits: 'meters',
          });
        } catch (e) { console.warn('[CarPlay] iOS maneuver update', e); }
      }

      if (mapTemplate && trip) {
        try {
          mapTemplate.updateTravelEstimates(trip, {
            distanceRemaining: tbt.distanceRemainingM / 1000,
            timeRemaining: tbt.etaSeconds,
            distanceUnits: 'kilometers',
          });
        } catch (e) { console.warn('[CarPlay] iOS trip ETA', e); }
      }
    } else if (isAndroid) {
      const navTemplate = navTemplateRef.current;
      if (navTemplate) {
        try {
          navTemplate.updateTemplate({
            component: CarSurface,
            actions: [{ id: 'end', title: 'End' }],
            navigationInfo: {
              type: 'routingInfo',
              nextStep: { cue: label },
              distance: tbt.distanceToManeuverM,
              distanceUnits: AA_UNIT_METERS,
            },
            travelEstimate: {
              distanceRemaining: tbt.distanceRemainingM / 1000,
              timeRemaining: tbt.etaSeconds,
            },
          });
          lastStepRef.current = tbt.stepIndex;
        } catch (e) { console.warn('[CarPlay] Android Auto update', e); }
      }
    }
  }, [
    connected,
    tbt.active,
    tbt.stepIndex,
    tbt.distanceToManeuverM,
    tbt.distanceRemainingM,
    tbt.etaSeconds,
    route,
  ]);
}

const styles = StyleSheet.create({
  surface: { flex: 1, backgroundColor: '#0B0B0C', alignItems: 'center', justifyContent: 'center', padding: 24 },
  center: { alignItems: 'center' },
  brand: { color: '#FFD60A', fontSize: 44, fontWeight: '900', letterSpacing: 4 },
  sub: { color: '#9AA0A6', fontSize: 18, marginTop: 8 },
  dist: { color: '#F4F4F4', fontSize: 48, fontWeight: '800', letterSpacing: -1 },
  inst: { color: '#F4F4F4', fontSize: 22, fontWeight: '600', marginTop: 4, textAlign: 'center' },
  meta: { color: '#9AA0A6', fontSize: 18, marginTop: 10 },
  speedPill: { position: 'absolute', left: 20, bottom: 20, alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 16, paddingHorizontal: 16, paddingVertical: 8 },
  speedNum: { color: '#F4F4F4', fontSize: 30, fontWeight: '800' },
  speedUnit: { color: '#9AA0A6', fontSize: 12, fontWeight: '600' },
});
