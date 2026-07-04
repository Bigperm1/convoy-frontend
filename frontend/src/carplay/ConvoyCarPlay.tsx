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
// The car's map AREA (CarSurface) renders the LIVE Mapbox SDK 3D map (the same
// @rnmapbox engine as the phone) via <CarMapView>, with the maneuver / nearby /
// speed read-outs floated on top. CAR_LIVE_MAP_ENABLED gates it; CarMapView is
// wrapped in CarMapBoundary and self-demotes (glFailed) to a Mapbox Static Images
// frame if the GL map throws or never paints, which in turn falls back to the
// dashboard until a GPS fix arrives — so the car screen is never blank. The live
// surface only paints once the bridgeless Fabric surface actually commits a frame
// (forced natively in withConvoyCarPlay.js).

import React, { useEffect, useRef, useState } from 'react';
import { NativeModules, Platform, View, Text, Image, StyleSheet, Animated } from 'react-native';
import { type NavRoute, type LatLng, maneuverVerb, fmtDistanceM, fmtEtaSec, haversineMeters } from '../nav';
import { setCarState, getCarState, useCarStore, emitCarGesture, type CarPeer } from './carStore';
import CarMapView from './CarMapView';
import CompassNeedle from '../components/CompassNeedle';
import { GlassFill } from '../Glass';
import { setCarPlayHookOwnsRoot, CAR_LIVE_MAP_ENABLED, CAR_DIAG_MODE } from './carPlayShared';
import { MAPBOX_PUBLIC_TOKEN } from '../initMapbox';
import { formatSpeed, getSettings, getMapMode, getRouteColor } from '../settings';
import { routeKindFor, routeColorsFor } from '../ConvoyMapbox';
import { weatherKind, type WeatherCondition, type WeatherKind } from '../weatherLayer';
import { WeatherGlyph } from '../components/WeatherHUD';

const isIOS = Platform.OS === 'ios';
const isAndroid = Platform.OS === 'android';

// FALSE: do NOT drive CarPlay's NATIVE navigation session (no native maneuver banner,
// no native trip-estimate bar). The live CarMapView + our own overlays (topStrip TBT,
// bottomMeta ETA, speed-limit, compass) provide guidance, matching the phone — the
// native CarPlay UI duplicated and covered them. Flip TRUE to restore native guidance.
const CAR_NATIVE_GUIDANCE = false;

// Upcoming-maneuver glyph for the car banner's green arrow box (mirrors the phone's
// maneuver icon). Derived from the instruction text — Routes API verbs land in it.
function maneuverArrow(instruction: string): string {
  const t = (instruction || '').toLowerCase();
  if (/\bu[- ]?turn\b/.test(t)) return '⟲';
  if (/\bslight left\b/.test(t)) return '↖';
  if (/\bslight right\b/.test(t)) return '↗';
  if (/\bleft\b/.test(t)) return '↰';
  if (/\bright\b/.test(t)) return '↱';
  if (/\bmerge\b/.test(t)) return '⤵';
  if (/\b(ramp|exit|take)\b/.test(t)) return '↗';
  return '↑';
}

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
    const withPath = `path-9+${CAR_ROUTE_COLOR}-1(${encodeURIComponent(polyline)})/`;
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
// Catches a RENDER throw from the live <CarMapView> on the CarPlay window (distinct
// from a GL *load* failure, which CarMapView already reports via onGLError). Without
// this, a throw would unwind the whole CarSurface tree → nothing commits → blank. The
// boundary renders null and fires onFail → glFailed → the static map takes over, so
// the surface still commits and the car screen is never empty.
class CarMapBoundary extends React.Component<
  { onFail: () => void; children: React.ReactNode },
  { dead: boolean }
> {
  state = { dead: false };
  static getDerivedStateFromError() { return { dead: true }; }
  componentDidCatch() { this.props.onFail(); }
  render() { return this.state.dead ? null : this.props.children; }
}

export function CarSurface() {
  const s = useCarStore();
  const spd = formatSpeed(s.speedMs || 0, getSettings().speedUnit);
  const nearby = s.peers.length;
  // Posted speed limit (PART 5), shown in the driver's unit. carStore.speedLimitKmh
  // is km/h; convert to mph if that's their setting. null → no badge.
  const limitVal = s.speedLimitKmh
    ? (getSettings().speedUnit === 'mph' ? Math.round(s.speedLimitKmh / 1.609344) : Math.round(s.speedLimitKmh))
    : null;
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
  // Live-vs-static gate (Path A scaffold). When the live @rnmapbox MapView lands
  // next pass it mounts under `showLive`; a GL/load failure flips `glFailed` true
  // and the surface drops back to the static <Image> branch below. This commit
  // ships NO live map yet — the placeholder branch renders the static surface, so
  // behavior is unchanged.
  const [glFailed, setGlFailed] = useState(false);
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

  // DIAGNOSTIC tick (CAR_DIAG_MODE). Independent of the store/GPS so it proves the
  // React tree is not just mounted but actively re-rendering on the CarPlay window.
  const [diagTick, setDiagTick] = useState(0);
  useEffect(() => {
    if (!CAR_DIAG_MODE) return;
    const id = setInterval(() => setDiagTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);

  // Speedo over-limit state — dark normally, RED only when WELL over the posted limit.
  // speedNum + limitVal are already in the driver's unit. While over, the pill PULSES
  // (opacity loop) so it grabs the eye — the "premium" version of the phone's color flip.
  const speedNum = Number(spd.value) || 0;
  // RED pulse ONLY when 21+ km/h (13+ mph) over the posted limit — no orange tier.
  const overBy = getSettings().speedUnit === 'mph' ? 13 : 21;
  const speedoOver = limitVal != null && speedNum >= (limitVal as number) + overBy;
  // Dark HUD panels a little transparent (0.8) so the map reads through them; the
  // over-limit RED stays solid as an alert. OTA-tunable.
  // Dimmed floor under the GlassFill (glass shows through); kept non-zero so the
  // safety-critical speedo never vanishes if glass doesn't render on the CarPlay scene.
  const speedoBg = speedoOver ? 'rgba(228,0,43,0.5)' : 'rgba(22,22,24,0.45)';
  const speedPulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!speedoOver) { speedPulse.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(speedPulse, { toValue: 0.45, duration: 450, useNativeDriver: true }),
      Animated.timing(speedPulse, { toValue: 1, duration: 450, useNativeDriver: true }),
    ]));
    loop.start();
    return () => { loop.stop(); speedPulse.setValue(1); };
  }, [speedoOver]);

  // Posted speed-limit sign slides out to the RIGHT from behind the speedo once moving
  // with a known limit — exactly like the phone. Tucked back behind the pill at a stop.
  const showLimit = limitVal != null && speedNum > 0;
  const limitSlide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(limitSlide, { toValue: showLimit ? 1 : 0, useNativeDriver: true, tension: 80, friction: 12 }).start();
  }, [showLimit]);
  // Slide the posted-limit sign clear of the 84pt-wide speedo pill PLUS a comfortable
  // gap, so the red over-limit pulse never crowds/overlaps the white sign (84 pill +
  // 20 gap = 104). Keeps the two HUD tiles visually separated and premium.
  const limitSlideX = limitSlide.interpolate({ inputRange: [0, 1], outputRange: [0, 104] });

  const showMap = hasFix && !!mapUrl;
  // Live @rnmapbox MapView gate. Three conditions, all required:
  //   - CAR_LIVE_MAP_ENABLED: master kill-switch (carPlayShared). Currently TRUE for
  //     the MapboxMaps 11.25.0 build; flip FALSE via OTA to force the static surface.
  //   - hasFix: we have a GPS position.
  //   - !glFailed: CarMapView's frame watchdog hasn't demoted us to static.
  // When the live arm IS active, <CarMapView/> mounts; its watchdog flips glFailed
  // (-> showLive false -> static) if it never paints, so the car can't stay blank.
  const showLive = CAR_LIVE_MAP_ENABLED && hasFix && !glFailed;

  // GROUND-TRUTH RENDER TEST. If this paints, the CarPlay React surface is alive and
  // the bug is downstream (content/layout); if the head unit stays the bare logo, the
  // Fabric surface never commits a tree (native). Zero deps on map/GPS/store content.
  if (CAR_DIAG_MODE) {
    return (
      <View style={{ flex: 1, backgroundColor: '#FF00AA', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#000000', fontSize: 56, fontWeight: '900', letterSpacing: 3 }}>CS LIVE</Text>
        <Text style={{ color: '#000000', fontSize: 30, fontWeight: '800', marginTop: 10 }}>{`tick ${diagTick}`}</Text>
        <Text style={{ color: '#000000', fontSize: 20, fontWeight: '700', marginTop: 10 }}>{`fix=${hasFix}`}</Text>
      </View>
    );
  }

  // The static-map surface: the live map background as a plain <Image> with the
  // maneuver/chip/meta overlays, falling back to the dashboard/logo when there's
  // no GPS fix (or the image failed). Extracted to a const so the `showLive`
  // placeholder arm can render it without duplicating the markup.
  const staticSurface = showMap ? (
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
          {/* Self-diagnosing readout (no Mac/logs needed): shows whether the car surface
              has a GPS fix, the actual lat/lng it reads, and which feed last wrote
              (fgfeed / navtask#N / seed:ok / seed:err / seed:no-fg-perm / bgstart:err). */}
          <Text style={styles.carDbgLine} numberOfLines={2}>
            {`fix=${hasFix} lat=${typeof s.selfLat === 'number' ? s.selfLat.toFixed(4) : 'null'} `
              + `lng=${typeof s.selfLng === 'number' ? s.selfLng.toFixed(4) : 'null'}\nfeed=${s.carDbg ?? '-'}`}
          </Text>
        </>
      )}
    </View>
  );

  // Maneuver/chip + meta overlays that float on top of the MAP (live or static).
  // Mirrors the overlays inside staticSurface's map branch so they read the same
  // over the live CarMapView. The center chevron is NOT here — the live map draws
  // the real 3D car (ModelLayer), so only the static image needs the chevron.
  const mapOverlays = (
    <>
      {/* Top: the turn-by-turn maneuver strip while navigating. No CONVOY/idle chip —
          off-nav the map speaks for itself. */}
      {s.navigating ? (
        <View style={styles.topStrip} pointerEvents="none">
          <View style={styles.maneuverBox}>
            <Text style={styles.maneuverArrow}>{s.maneuverIcon || '↑'}</Text>
          </View>
          <View style={styles.topTextCol}>
            <Text style={styles.topDist}>{s.distanceToTurn || '—'}</Text>
            <Text style={styles.topInst} numberOfLines={1}>{s.instruction || 'Continue'}</Text>
          </View>
        </View>
      ) : null}

      {/* Bottom-right: arrival / eta / remaining while navigating. */}
      {s.navigating && metaLine ? (
        <View style={styles.bottomMeta} pointerEvents="none">
          <Text style={styles.bottomText} numberOfLines={1}>{metaLine}</Text>
        </View>
      ) : null}

      {/* TEMP diagnostic for the CarPlay connection / background-location work:
          which feed last wrote a fix, and its tick. `navtask#N` = the background
          task is delivering (N keeps climbing even with the phone screen off);
          `fgfeed` = only the foreground watch is running (freezes on screen-lock).
          Shown on the LIVE map so a mid-drive freeze is diagnosable on the head
          unit itself. Remove once the background-location fix is verified. */}
      <View style={styles.mapFeedDiag} pointerEvents="none">
        <Text style={styles.mapFeedDiagText} numberOfLines={1}>{`feed=${s.carDbg ?? '-'}`}</Text>
      </View>
    </>
  );

  return (
    <View style={styles.surface}>
      {showLive ? (
        // Live @rnmapbox map on the CarPlay window. A GL/load failure flips
        // glFailed -> showLive false -> the static surface below takes over.
        <>
          <CarMapBoundary onFail={() => setGlFailed(true)}>
            <CarMapView onGLError={() => setGlFailed(true)} />
          </CarMapBoundary>
          {mapOverlays}
        </>
      ) : (
        staticSurface
      )}

      {/* ---- Shared overlays: render on top of EITHER surface (live or static) ---- */}

      {/* Speed pill — bottom-LEFT, offset right of the CarPlay side bar. Pulses RED
          when well over the posted limit. The posted-limit sign is rendered FIRST so
          it sits BEHIND the pill, then springs out to the right when moving (phone-style). */}
      <View style={styles.speedDock} pointerEvents="none">
        {limitVal != null ? (
          <Animated.View
            style={[styles.speedLimitBadge, { opacity: limitSlide, transform: [{ translateX: limitSlideX }] }]}
            pointerEvents="none"
          >
            <Text style={styles.speedLimitNum} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{limitVal}</Text>
            <Text style={styles.speedLimitUnit} numberOfLines={1}>{spd.label.toLowerCase()}</Text>
          </Animated.View>
        ) : null}
        <Animated.View style={[styles.speedPill, { backgroundColor: speedoBg, opacity: speedPulse }]}>
          <GlassFill tintColor={speedoOver ? '#E4002B' : undefined} style={{ borderRadius: 16, overflow: 'hidden' }} />
          <Text style={styles.speedNum}>{spd.value}</Text>
          <Text style={styles.speedUnit}>{spd.label.toLowerCase()}</Text>
        </Animated.View>
      </View>

      {/* Live weather chip — BOTTOM-LEFT, just above the speedo with a small gap, to
          mirror the phone HUD's weather-over-speed column (same vector glyph + temp).
          Shows whenever the phone's weather layer is feeding carStore, incl. nav. */}
      {s.weatherTemp ? (
        <View style={styles.weatherChip} pointerEvents="none">
          <GlassFill style={{ borderRadius: 12, overflow: 'hidden' }} />
          {s.weatherKind ? <WeatherGlyph kind={s.weatherKind as WeatherKind} size={24} /> : null}
          <Text style={styles.weatherText}>{s.weatherTemp}</Text>
        </View>
      ) : null}

      {/* Compass — north-needle, RIGHT edge. The car map is heading-up, so rotate
          the needle by -heading to keep North pointing at true north. (Flip the
          sign here if it reads mirrored on the head unit.) */}
      {typeof s.heading === 'number' ? (
        <View style={styles.compassDock} pointerEvents="none">
          <GlassFill style={{ borderRadius: 22, overflow: 'hidden' }} />
          <View style={{ transform: [{ rotate: `${-(s.heading || 0)}deg` }] }}>
            <CompassNeedle size={40} />
          </View>
        </View>
      ) : null}
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
  // All current route options (Best / Scenic / AI alternates) + which is selected, so the
  // CarPlay preview can mirror the phone's 3-route display. `route` stays the SELECTED one
  // (used for nav). Selection is phone-driven; CarPlay route lines are display-only.
  routes?: NavRoute[];
  selectedRouteIndex?: number;
  tbt: Tbt;
  user: (LatLng & { speed?: number; heading?: number }) | null;
  destination: (LatLng & { label?: string }) | null;
  peers?: Record<string, any> | null;
  onEnd?: () => void;
  // Live weather at the driver (only while the phone's weather layer is on). Mirrored
  // into carStore so CarSurface can show the same temp + glyph as the phone HUD.
  weather?: WeatherCondition | null;
  // Tapped from the CarPlay native map button — one-tap "report police" at the
  // driver's current spot. Wired to the phone's reportAlert('police').
  onReportPolice?: () => void;
};

/**
 * Mount ONCE from map.tsx. Mirrors live route + turn-by-turn + nearby-convoy
 * state onto CarPlay (iOS, tabbed) / Android Auto (nav only). No-op on web.
 */
export function useConvoyCarPlay({ route, routes, selectedRouteIndex = 0, tbt, user, destination, peers, onEnd, weather, onReportPolice }: CarPlayArgs) {
  const [connected, setConnected] = useState(false);

  const mapTemplateRef = useRef<any>(null);
  const commsTemplateRef = useRef<any>(null);
  const navTemplateRef = useRef<any>(null);
  const tripRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const lastStepRef = useRef<number>(-1);

  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const onReportPoliceRef = useRef(onReportPolice);
  onReportPoliceRef.current = onReportPolice;

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
      // Route polyline (preview or nav) for the car map ribbon. NOTE: position
      // (selfLat/selfLng/heading) is mirrored in a SEPARATE additive effect below —
      // it must NEVER be written here, because this metadata effect re-runs on ticks
      // where `user` is null (peers/route changes), and a null position would clobber
      // a good fix landed by the cold/foreground feed -> hasFix false -> CONVOY logo.
      routePolyline: route?.polyline || '',
      // Selected route's geometry + per-segment congestion → lets the CarPlay map paint
      // the live traffic gradient (same as the phone). Mirrored in preview AND nav.
      routeCoordinates: (route as any)?.coordinates || undefined,
      routeCongestion: (route as any)?.congestion || undefined,
      // All display routes (Best / Scenic / AI) with per-kind colors precomputed, so the
      // CarPlay preview mirrors the phone's 3-route fan-out. Drop "alt" routes (index >= 2,
      // unless explicitly tagged) — we only ever show the three. Empty during nav OR when
      // there's a single route, so the car draws just the selected ribbon then.
      routes: (tbt.active || !routes || routes.length < 2)
        ? []
        : routes
            .map((r, i) => {
              const kind = routeKindFor(i, r);
              if (kind === 'alt') return null;
              const { color, edge } = routeColorsFor(kind, getRouteColor(getSettings()));
              return r?.polyline ? { index: i, polyline: r.polyline, kind, color, edge } : null;
            })
            .filter(Boolean) as { index: number; polyline: string; kind: string; color: string; edge: string }[],
      selectedRouteIndex,
      // Self car paint → lets the car root pick the matching 3D model. Read from
      // local settings (the Garage persists carColor there, same source the phone
      // self-marker uses).
      selfCarColor: getSettings().carColor,
      // Base-map mode → car map matches the phone's style choice.
      mapMode: getMapMode(getSettings()),
      // Route-line color → car route matches the phone's chosen color.
      routeColor: getRouteColor(getSettings()),
      // Live weather (only while the phone's weather layer feeds it). Temp pre-formatted
      // in the driver's unit; CarSurface maps weatherKind to a glyph.
      weatherTemp: weather
        ? `${Math.round(getSettings().speedUnit === 'mph' ? weather.tempF : weather.tempC)}°${getSettings().speedUnit === 'mph' ? 'F' : 'C'}`
        : undefined,
      weatherKind: weather ? weatherKind(weather) : undefined,
      // Arrow glyph for the car banner's maneuver box.
      maneuverIcon: tbt.active ? maneuverArrow(upcomingInstruction(route, tbt.stepIndex)) : undefined,
    });
  }, [
    tbt.active,
    tbt.stepIndex,
    tbt.distanceToManeuverM,
    tbt.etaSeconds,
    tbt.distanceRemainingM,
    route,
    routes,
    selectedRouteIndex,
    destination?.label,
    peers,
    user?.speed,
    weather,
  ]);

  // ---- position mirror: ADDITIVE ONLY ----
  // Writes selfLat/selfLng/heading ONLY when the phone has a real fix. carStore is a
  // shallow merge, so this can never null out a fix that the cold/foreground location
  // feed (navNotification) already landed — which is what was bouncing the warm car
  // surface back to the CONVOY logo. speedMs stays in the metadata effect above.
  useEffect(() => {
    if (typeof user?.lat !== 'number' || typeof user?.lng !== 'number') return;
    setCarState({
      selfLat: user.lat,
      selfLng: user.lng,
      heading: typeof user?.heading === 'number' ? user.heading : null,
    });
  }, [user?.lat, user?.lng, user?.heading]);

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
            // Native CarPlay map button (the ONLY reliably-touchable element on the
            // head unit — custom RN overlays don't receive CarPlay touches). One tap
            // reports police at the driver's current spot via the phone's reportAlert.
            mapButtons: [
              { id: 'police', image: require('../../assets/images/police.png') },
              // Recenter: the only reliably-touchable "compass/recenter" affordance on
              // CarPlay (overlays can't receive taps). Resets the driver's pinch-zoom
              // bias back to the speed-aware auto follow-zoom via the gesture bus →
              // CarMapView's 'recenter' handler. (The chase camera already keeps the
              // car centered every frame, so recenter == drop the manual zoom.)
              { id: 'recenter', image: require('../../assets/images/recenter.png') },
            ],
            onMapButtonPressed: (e: { id: string }) => {
              if (e?.id === 'police') onReportPoliceRef.current?.();
              else if (e?.id === 'recenter') emitCarGesture({ kind: 'recenter' });
            },
            // iOS-26 raw pinch/zoom on the CarPlay map (react-native-carplay patch +
            // CPMapTemplate.h gesture delegate). Forwarded to CarMapView via the
            // gesture bus, which biases the lockstep follow-zoom. Apple gates raw
            // touch on some head units, so these may not fire on every car — the
            // native map buttons remain the guaranteed-touchable fallback.
            onDidBeginZoomGesture: () => emitCarGesture({ kind: 'zoomBegin' }),
            onDidUpdateZoomGesture: (e: { scale: number; velocity: number }) =>
              emitCarGesture({ kind: 'zoom', scale: e.scale, velocity: e.velocity }),
            onDidEndZoomGesture: (e: { velocity: number }) =>
              emitCarGesture({ kind: 'zoomEnd', velocity: e.velocity }),
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

    if (CAR_NATIVE_GUIDANCE && tbt.active && route && user && destination && !sessionRef.current) {
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
  // padding 0 → overlays sit at the true screen edges (the CarPlay side bar still
  // covers the far left, so left-side elements keep a ~68pt offset).
  surface: { flex: 1, backgroundColor: '#0B0B0C', alignItems: 'center', justifyContent: 'center', padding: 0 },
  center: { alignItems: 'center', paddingHorizontal: 20 },
  carLogo: { width: 104, height: 104, borderRadius: 22, marginBottom: 18 },
  brand: { color: '#2DEC86', fontSize: 44, fontWeight: '900', letterSpacing: 4 },
  sub: { color: '#9AA0A6', fontSize: 18, marginTop: 8 },
  carDbgLine: { color: '#77FF88', fontSize: 11, fontWeight: '700', marginTop: 14, textAlign: 'center' },
  // TEMP: live-map feed indicator for the CarPlay background-location work (remove after verify).
  mapFeedDiag: { position: 'absolute', top: 6, right: 12, backgroundColor: 'rgba(0,0,0,0.4)', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 },
  mapFeedDiagText: { color: '#77FF88', fontSize: 11, fontWeight: '700' },
  dist: { color: '#F4F4F4', fontSize: 48, fontWeight: '800', letterSpacing: -1 },
  inst: { color: '#F4F4F4', fontSize: 22, fontWeight: '600', marginTop: 4, textAlign: 'center' },
  meta: { color: '#9AA0A6', fontSize: 18, marginTop: 10 },
  // Bottom-LEFT, tucked just right of the CarPlay side bar (~64pt). Smaller pill.
  speedDock: { position: 'absolute', left: 68, bottom: 10, alignItems: 'flex-start' },
  speedPill: { width: 84, height: 60, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  speedNum: { color: '#F4F4F4', fontSize: 24, fontWeight: '800', letterSpacing: -0.5, lineHeight: 26 },
  speedUnit: { color: '#808080', fontSize: 10, fontWeight: '600', letterSpacing: 0.3, marginTop: 1 },
  // Posted speed-limit sign — white plate, black border. Tucked BEHIND the speedo (same
  // bottom baseline, left:0 within speedDock) and slid out to the right when moving.
  speedLimitBadge: { position: 'absolute', left: 0, bottom: 0, width: 84, height: 60, borderRadius: 16, backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  speedLimitNum: { color: '#000', fontSize: 24, fontWeight: '800', letterSpacing: -0.5, lineHeight: 26 },
  speedLimitUnit: { color: '#333', fontSize: 10, fontWeight: '700', letterSpacing: 0.3, marginTop: 1 },
  // Compass — top-right, below the maneuver banner. Smaller, closer to the edge.
  compassDock: { position: 'absolute', right: 8, top: 58, width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(11,11,12,0.4)', borderRadius: 22, overflow: 'hidden' },
  // Weather chip — BOTTOM-left, just above the speedo (left edge aligned, small gap),
  // mirroring the phone's weather-over-speed HUD column. Vector glyph + temp, stacked.
  weatherChip: { position: 'absolute', left: 68, bottom: 78, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 4, backgroundColor: 'rgba(22,22,24,0.45)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  weatherText: { color: '#F4F4F4', fontSize: 14, fontWeight: '800', marginTop: 1 },
  // --- live static-map mode ---
  preload: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  markerCenter: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  markerHalo: { position: 'absolute', width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(11,11,12,0.55)', borderWidth: 2, borderColor: 'rgba(45,236,134,0.55)' },
  markerChevron: {
    width: 0, height: 0, backgroundColor: 'transparent',
    borderLeftWidth: 10, borderRightWidth: 10, borderBottomWidth: 18,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: '#2DEC86',
  },
  // Compact maneuver CARD (mirrors the phone banner), tucked TOP-RIGHT: a green arrow
  // box + a [meters / instruction] column. Smaller than the old full-bleed strip.
  topStrip: { position: 'absolute', top: 8, right: 8, maxWidth: 300, flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 8, backgroundColor: 'rgba(11,11,12,0.8)', borderRadius: 12 },
  maneuverBox: { width: 36, height: 36, borderRadius: 9, backgroundColor: '#2DEC86', alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  maneuverArrow: { color: '#0B0B0C', fontSize: 24, fontWeight: '900', lineHeight: 28, marginTop: -1 },
  topTextCol: { flexShrink: 1 },
  topDist: { color: '#2DEC86', fontSize: 17, fontWeight: '800' },
  topInst: { color: '#F4F4F4', fontSize: 12, fontWeight: '600', flexShrink: 1 },
  topChip: { position: 'absolute', top: 12, alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 6, backgroundColor: 'rgba(11,11,12,0.66)', borderRadius: 14 },
  topChipText: { color: '#2DEC86', fontSize: 15, fontWeight: '800', letterSpacing: 1 },
  // ETA / arrival — tucked into the BOTTOM-RIGHT corner, small.
  bottomMeta: { position: 'absolute', right: 8, bottom: 8, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: 'rgba(11,11,12,0.72)', borderRadius: 10 },
  bottomText: { color: '#C7CCD1', fontSize: 12, fontWeight: '600' },
});
