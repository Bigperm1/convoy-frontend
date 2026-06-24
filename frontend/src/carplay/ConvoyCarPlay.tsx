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
// The car's map AREA (CarSurface) renders a REAL street map: a Mapbox Static
// Images frame centered on the driver (route line overlaid), refreshed as the
// car moves, with the maneuver / nearby / speed read-outs floated on top. It is
// a static <Image> (no GL <MapView>) on purpose — see the note above CarSurface
// — so it always draws on the CarPlay window, can't trip the CarPlay watchdog,
// and ships as a free OTA. Falls back to the original dashboard until a GPS fix
// arrives or if a frame ever fails to load, so the car screen is never blank.

import React, { useEffect, useRef, useState } from 'react';
import { NativeModules, Platform, View, Text, Image, StyleSheet } from 'react-native';
import { type NavRoute, type LatLng, maneuverVerb, fmtDistanceM, fmtEtaSec, haversineMeters } from '../nav';
import { setCarState, getCarState, useCarStore, type CarPeer } from './carStore';
import { setCarPlayHookOwnsRoot } from './carPlayShared';
import { MAPBOX_PUBLIC_TOKEN } from '../initMapbox';
import { formatSpeed, getSettings } from '../settings';

const isIOS = Platform.OS === 'ios';
const isAndroid = Platform.OS === 'android';

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

// Local clock formatter so the car dashboard's arrival matches the phone's nav
// strip exactly (e.g. "9:05pm"). Mirrors map.tsx's fmtClock — kept local to avoid
// coupling the CarPlay surface to the phone screen's module.
function fmtClock(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m < 10 ? '0' : ''}${m}${ap}`;
}

// ---- Mapbox Static Images: live street map for the car surface ----
// Renders a REAL dark street map centered on the driver as a plain <Image>
// (Mapbox Static Images API) — deliberately NOT a live GL <MapView>. On the
// secondary CarPlay window a GL/Metal map risks failing to get a render context
// and, worse, tripping the CarPlay watchdog (the same watchdog that caused the
// original connect crash when nothing drew in time). A static <Image> has no GL
// context, can't trip the watchdog, always draws, and is 100% OTA-able. The map
// is fetched HEADING-UP — the heading is baked into the Static Images URL as the
// bearing, so Mapbox renders it rotated with upright labels and correct framing;
// the car marker sits at centre pointing straight up. New frames are fetched on
// movement, on route change, or when the car turns >= CAR_MAP_HEADING_DEG, so
// small heading jitter costs nothing. If we ever confirm a live MapView is safe
// on a head unit, it slots in here behind the same fallback.
const CAR_MAP_STYLE = 'mapbox/dark-v11'; // standard, always-valid dark style
const CAR_MAP_ZOOM = 15;
const CAR_MAP_W = 800;
const CAR_MAP_H = 480;
const CAR_ROUTE_COLOR = '2dec86'; // brand green, no '#'
// Refresh the street map when the car moves this far OR this long passes —
// whichever first. Keeps Static Images API request volume modest while staying
// current enough for a glanceable dashboard.
const CAR_MAP_MOVE_M = 70;
const CAR_MAP_MAX_AGE_MS = 5000;
// Heading-up: re-fetch the frame when the car's heading turns at least this many
// degrees (the bearing is baked into the static image, so a turn needs a new
// frame). Jitter below this costs no request.
const CAR_MAP_HEADING_DEG = 12;
// Hard ceiling on the whole URL; if a long route polyline would blow past it the
// route overlay is dropped (the map still renders, centered on the car).
const CAR_MAP_URL_MAX = 7500;

function buildStaticMapUrl(lat: number, lng: number, polyline: string, bearing = 0): string {
  const b = (((Math.round(bearing) % 360) + 360) % 360); // heading-up bearing, 0-359
  const tail =
    `${lng},${lat},${CAR_MAP_ZOOM},${b}/${CAR_MAP_W}x${CAR_MAP_H}@2x` +
    `?access_token=${MAPBOX_PUBLIC_TOKEN}`;
  let overlay = '';
  if (polyline) {
    // Google's overview polyline is precision-5 — a drop-in for Mapbox's `path`
    // overlay. URL-encode it (it can contain \\, ?, @, etc.).
    const withPath = `path-5+${CAR_ROUTE_COLOR}-1(${encodeURIComponent(polyline)})/`;
    const probe = `https://api.mapbox.com/styles/v1/${CAR_MAP_STYLE}/static/${withPath}${tail}`;
    if (probe.length <= CAR_MAP_URL_MAX) overlay = withPath;
  }
  return `https://api.mapbox.com/styles/v1/${CAR_MAP_STYLE}/static/${overlay}${tail}`;
}

// ---- The component rendered onto the car screen ----
// Shown the whole time a car is connected — idle (no route) AND during nav.
// Reads the shared store so it shows live data despite being a separate root.
//
// With a GPS fix it shows a real street map (centered on the driver, route line
// overlaid) with the maneuver / nearby / speed read-outs floated on top. Until a
// fix arrives (or if the map image ever fails to load) it falls back to the
// original dashboard, so the car screen is never worse than before.
export function CarSurface() {
  const s = useCarStore();
  const spd = formatSpeed(s.speedMs || 0, getSettings().speedUnit);
  const nearby = s.peers.length;
  // Arrival CLOCK, computed the SAME way the phone banner does (now + remaining
  // ETA). This is the number the driver compares to their phone — driving it from
  // carStore here means the car dashboard matches the phone instead of relying on
  // CarPlay's native estimate panel.
  const arrival = (s.navigating && (s.etaSeconds || 0) > 0)
    ? fmtClock(new Date(Date.now() + (s.etaSeconds || 0) * 1000))
    : '';
  const metaLine = [arrival, s.eta, s.distanceRemaining].filter(Boolean).join('   ·   ');

  const hasFix = typeof s.selfLat === 'number' && typeof s.selfLng === 'number';

  // Static-map URL loaded straight into the visible full-size <Image>. The old
  // off-screen 1x1/opacity-0 preloader never decoded on the CarPlay surface, so
  // its onLoad never fired and the map never showed.
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [dbgErr, setDbgErr] = useState<string>('');
  const lastRef = useRef<{ lat: number; lng: number; at: number; poly: string; hdg: number }>({ lat: 0, lng: 0, at: 0, poly: '', hdg: 0 });

  useEffect(() => {
    if (!hasFix) return;
    const lat = s.selfLat as number;
    const lng = s.selfLng as number;
    const hdg = (((Math.round(s.heading ?? 0) % 360) + 360) % 360);
    const now = Date.now();
    const last = lastRef.current;
    const movedM = (last.lat || last.lng)
      ? haversineMeters({ lat: last.lat, lng: last.lng }, { lat, lng })
      : Infinity;
    const polyChanged = last.poly !== s.routePolyline;
    const stale = now - last.at > CAR_MAP_MAX_AGE_MS;
    const everFetched = last.at !== 0;
    // Heading-up: also re-fetch when the car has turned enough that the frame's
    // baked-in bearing is visibly stale (shortest angular gap >= threshold).
    let dHdg = Math.abs(hdg - last.hdg) % 360;
    if (dHdg > 180) dHdg = 360 - dHdg;
    const turned = dHdg >= CAR_MAP_HEADING_DEG;
    if (everFetched && !polyChanged && movedM < CAR_MAP_MOVE_M && !stale && !turned) return;

    lastRef.current = { lat, lng, at: now, poly: s.routePolyline, hdg };
    // Set the visible map URL directly — the full-size <Image> loads it the same
    // way the logo PNG does (which the hidden preloader did not on CarPlay).
    setMapUrl(buildStaticMapUrl(lat, lng, s.routePolyline, hdg));
  }, [hasFix, s.selfLat, s.selfLng, s.routePolyline, s.heading]);

  const showMap = hasFix && !!mapUrl;

  return (
    <View style={styles.surface}>
      {showMap ? (
        <>
          <Image
            source={{ uri: mapUrl as string }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            onError={(e: any) => { setMapUrl(null); lastRef.current = { lat: 0, lng: 0, at: 0, poly: '', hdg: 0 }; setDbgErr(String(e?.nativeEvent?.error || 'map-img-err')); }}
          />

          {/* Car marker pinned to the map centre. The map is now heading-up, so the
              car always points straight up (its travel direction). */}
          <View style={styles.markerCenter} pointerEvents="none">
            <View style={styles.markerHalo} />
            <View style={styles.markerChevron} />
          </View>

          {/* Top: maneuver while navigating, else a small CONVOY / nearby chip. */}
          {s.navigating ? (
            <View style={styles.topStrip} pointerEvents="none">
              <Text style={styles.topDist}>{s.distanceToTurn || '—'}</Text>
              <Text style={styles.topInst} numberOfLines={1}>{s.instruction || 'Continue'}</Text>
            </View>
          ) : (
            <View style={styles.topChip} pointerEvents="none">
              <Text style={styles.topChipText}>
                {nearby ? `CONVOY   ·   ${nearby} ${nearby === 1 ? 'car' : 'cars'} nearby` : 'CONVOY'}
              </Text>
            </View>
          )}

          {/* Bottom-right: arrival / eta / remaining while navigating. */}
          {s.navigating && metaLine ? (
            <View style={styles.bottomMeta} pointerEvents="none">
              <Text style={styles.bottomText} numberOfLines={1}>{metaLine}</Text>
            </View>
          ) : null}
        </>
      ) : (
        /* ---- Fallback: no GPS fix yet (or image failed) → original dashboard ---- */
        <View style={styles.center}>
          {s.navigating ? (
            <>
              <Text style={styles.dist}>{s.distanceToTurn || '—'}</Text>
              <Text style={styles.inst} numberOfLines={2}>{s.instruction || 'Continue'}</Text>
              <Text style={styles.meta}>{metaLine}</Text>
            </>
          ) : (
            <>
              <Image source={require('../../assets/final_icon.png')} style={styles.carLogo} resizeMode="contain" />
              <Text style={styles.brand}>CONVOY</Text>
              <Text style={styles.sub}>{nearby ? `${nearby} ${nearby === 1 ? 'car' : 'cars'} nearby` : 'Drive together'}</Text>
            </>
          )}
        </View>
      )}

      {/* Speed pill — always shown, both map and fallback. */}
      <View style={styles.speedPill} pointerEvents="none">
        <Text style={styles.speedNum}>{spd.value}</Text>
        <Text style={styles.speedUnit}>{spd.label.toLowerCase()}</Text>
      </View>

      {/* TEMP un-gateable readout, RE-CENTERED so the CarPlay dock + maneuver
          banner can't cover it. If this appears AT ALL, the React CarSurface is
          painting. Remove once CarPlay is confirmed. */}
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center', zIndex: 99999 }}>
        <View style={{ backgroundColor: 'rgba(0,0,0,0.95)', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, borderWidth: 2, borderColor: '#00FF88' }}>
          <Text style={{ color: '#00FF88', fontSize: 20, fontWeight: '900', textAlign: 'center' }}>
            {`RN-OK\nfix:${hasFix ? 'Y' : 'N'}  map:${mapUrl ? 'Y' : 'N'}\nerr:${dbgErr || '-'}\n@${typeof s.selfLat === 'number' ? s.selfLat.toFixed(3) : '-'},${typeof s.selfLng === 'number' ? s.selfLng.toFixed(3) : '-'}`}
          </Text>
        </View>
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

  // ---- claim CarPlay-root ownership while this (phone map) screen is mounted ----
  // Tells the app-root bootstrap (carPlayBootstrap.ts) to stand down so it won't
  // also set a root template — this hook owns the richer root + nav session here.
  // On unmount (phone screen gone) the bootstrap takes back over for cold use.
  useEffect(() => {
    setCarPlayHookOwnsRoot(true);
    return () => setCarPlayHookOwnsRoot(false);
  }, []);

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
      // Raw numerics for the Android Auto NavigationTemplate (AndroidAutoRoot).
      distanceToTurnM: tbt.active ? tbt.distanceToManeuverM : 0,
      distanceRemainingM: tbt.active ? tbt.distanceRemainingM : 0,
      etaSeconds: tbt.active ? tbt.etaSeconds : 0,
      // Live map background (CarPlay static map). Mirrored every GPS tick so the
      // car surface can center the map on the driver and draw the route. Route
      // polyline is shown whenever a route is active (preview or nav).
      selfLat: typeof user?.lat === 'number' ? user.lat : null,
      selfLng: typeof user?.lng === 'number' ? user.lng : null,
      heading: typeof user?.heading === 'number' ? user.heading : null,
      routePolyline: route?.polyline || '',
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
    user?.lat,
    user?.lng,
    user?.heading,
  ]);

  // ---- connect / disconnect lifecycle ----
  useEffect(() => {
    // iOS CarPlay is ACTIVE (un-parked for the first iOS Mapbox build). The connect
    // path below builds the TabBar (Map/Comms/Music) and mirrors live nav. The
    // native scene setup is provided by plugins/withConvoyCarPlay.js (both scene
    // roles + the carplay-maps entitlement). Android Auto remains on its own root.
    const lib = getLib();
    if (!lib) return;
    const { CarPlay, MapTemplate, ListTemplate, NowPlayingTemplate, TabBarTemplate } = lib;

    const setRoot = () => {
      try {
        if (isIOS) {
          const mapTemplate = new MapTemplate({
            id: 'convoy-carplay-map',
            // NOTE: no `component` here. The car-window dashboard (CarSurface) is
            // mounted natively by CarSceneDelegate via Expo's bridgeless root-view
            // factory, registered under 'ConvoyCarSurface' (see registerCarSurface.ts).
            // react-native-carplay's own `component` path uses RCTRootView(initWithBridge:)
            // which renders nothing under the New Architecture, so we bypass it.
            tabTitle: 'Map',
            tabSystemImageName: 'map',
            guidanceBackgroundColor: '#0B0B0C',
            tripEstimateStyle: 'dark',
            onDidCancelNavigation: () => onEndRef.current?.(),
          });
          mapTemplateRef.current = mapTemplate;

          // ── CARPLAY CRASH ISOLATION (OTA, free) ───────────────────────
          // Connecting to CarPlay was crashing the whole app — the phone
          // scene died too (same process, killed by the CarPlay watchdog
          // when nothing drew on the car screen in time). Stripped the root
          // to ONLY the MapTemplate to (a) stop the crash taking the phone
          // down and (b) isolate the cause. The Comms (ListTemplate), Music
          // (NowPlayingTemplate + enableNowPlaying) and the TabBarTemplate
          // wrapper are the most common CarPlay crashers, so they're out for
          // now. If a single MapTemplate renders without crashing, one of
          // those was the offender and we re-add them one at a time. If it
          // STILL crashes, the fault is the native car-window RN bridge /
          // scene setup, which needs a native rebuild (not an OTA).
          CarPlay.setRootTemplate(mapTemplate);
        }
        // Android Auto is NOT built here. The head unit can launch the car app
        // even when this phone screen isn't mounted, so its UI is owned by the
        // dedicated "AndroidAuto" AppRegistry root (src/carplay/AndroidAutoRoot
        // + registerAndroidAuto), which react-native-carplay's CarPlaySession
        // runs on connect. This hook still feeds that root live data via
        // carStore (the mirror effect above).
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

      // Sanitize the live numbers ONCE. tbt.* are the SAME values the phone
      // banner renders correctly, but CarPlay's estimate panels are picky:
      // feed them rounded, non-negative integers (seconds) and a clean km/m
      // distance so a stray float / NaN can't blank the bar to "0 min / -- km".
      const etaSec = Math.max(0, Math.round(Number(tbt.etaSeconds) || 0));
      const remM = Math.max(0, Math.round(Number(tbt.distanceRemainingM) || 0));
      const turnM = Math.max(0, Math.round(Number(tbt.distanceToManeuverM) || 0));
      // Time to the NEXT maneuver (not the whole trip): a proportional slice of
      // the remaining ETA by distance. Previously the whole-trip ETA was sent as
      // the maneuver's time, which was wrong.
      const turnSec = Math.max(0, Math.round(etaSec * (turnM / Math.max(remM, 1))));
      // Diagnostic confirmed (build 5): the data reaching CarPlay is correct
      // (this banner showed the real remaining s/km), but CarPlay's native trip
      // estimate panel refuses to display it. Banner is back to the clean
      // instruction; the destination estimate path is a separate native issue.

      if (session) {
        try {
          if (stepChanged) {
            session.updateManeuvers([
              {
                instructionVariants: [label],
                initialTravelEstimates: {
                  distanceRemaining: turnM,
                  timeRemaining: turnSec,
                  distanceUnits: 'meters',
                },
              },
            ]);
            lastStepRef.current = tbt.stepIndex;
          }
          session.updateTravelEstimates(0, {
            distanceRemaining: turnM,
            timeRemaining: turnSec,
            distanceUnits: 'meters',
          });
        } catch (e) { console.warn('[CarPlay] iOS maneuver update', e); }
      }

      if (mapTemplate && trip) {
        try {
          mapTemplate.updateTravelEstimates(trip, {
            distanceRemaining: remM / 1000,
            timeRemaining: etaSec,
            distanceUnits: 'kilometers',
          }, 0);
        } catch (e) { console.warn('[CarPlay] iOS trip ETA', e); }
      }
    }
    // Android Auto live updates are driven by AndroidAutoRoot off carStore.
  }, [
    connected,
    tbt.active,
    tbt.stepIndex,
    tbt.distanceToManeuverM,
    tbt.distanceRemainingM,
    tbt.etaSeconds,
    route,
  ]);

  // Expose the live CarPlay / Android-Auto connection state so the phone screen
  // can gate Avatar Live presence (Partial/Full) on whether the car is connected.
  return { connected };
}

const styles = StyleSheet.create({
  surface: { flex: 1, backgroundColor: '#0B0B0C', alignItems: 'center', justifyContent: 'center', padding: 24 },
  center: { alignItems: 'center' },
  carLogo: { width: 104, height: 104, borderRadius: 22, marginBottom: 18 },
  brand: { color: '#2DEC86', fontSize: 44, fontWeight: '900', letterSpacing: 4 },
  sub: { color: '#9AA0A6', fontSize: 18, marginTop: 8 },
  dist: { color: '#F4F4F4', fontSize: 48, fontWeight: '800', letterSpacing: -1 },
  inst: { color: '#F4F4F4', fontSize: 22, fontWeight: '600', marginTop: 4, textAlign: 'center' },
  meta: { color: '#9AA0A6', fontSize: 18, marginTop: 10 },
  speedPill: { position: 'absolute', left: 20, bottom: 20, alignItems: 'center', backgroundColor: 'rgba(11,11,12,0.66)', borderRadius: 16, paddingHorizontal: 16, paddingVertical: 8 },
  speedNum: { color: '#F4F4F4', fontSize: 30, fontWeight: '800' },
  speedUnit: { color: '#9AA0A6', fontSize: 12, fontWeight: '600' },
  // --- live static-map mode ---
  preload: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  markerCenter: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  markerHalo: { position: 'absolute', width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(11,11,12,0.55)', borderWidth: 2, borderColor: 'rgba(45,236,134,0.55)' },
  markerChevron: {
    width: 0, height: 0, backgroundColor: 'transparent',
    borderLeftWidth: 10, borderRightWidth: 10, borderBottomWidth: 18,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: '#2DEC86',
  },
  topStrip: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 18, backgroundColor: 'rgba(11,11,12,0.74)' },
  topDist: { color: '#2DEC86', fontSize: 26, fontWeight: '800', marginRight: 14 },
  topInst: { color: '#F4F4F4', fontSize: 20, fontWeight: '600', flexShrink: 1 },
  topChip: { position: 'absolute', top: 12, alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 6, backgroundColor: 'rgba(11,11,12,0.66)', borderRadius: 14 },
  topChipText: { color: '#2DEC86', fontSize: 15, fontWeight: '800', letterSpacing: 1 },
  bottomMeta: { position: 'absolute', right: 16, bottom: 18, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: 'rgba(11,11,12,0.66)', borderRadius: 12 },
  bottomText: { color: '#C7CCD1', fontSize: 16, fontWeight: '600' },
});
