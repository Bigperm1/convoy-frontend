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
// wrapped in CarMapBoundary, and a GL failure (watchdog / style error / render
// throw) schedules a REMOUNT with backoff (liveAttempt) — the 3D map is the ONLY
// map surface (standing rule: never the flat 2D static-image map), with the boot
// dashboard shown only until a GPS fix arrives. The live surface only paints once
// the bridgeless Fabric surface actually commits a frame (forced natively in
// withConvoyCarPlay.js).

import React, { useEffect, useRef, useState } from 'react';
import { NativeModules, Platform, View, Text, Image, StyleSheet, Animated, TouchableOpacity, processColor, Dimensions, PixelRatio } from 'react-native';
import { type NavRoute, type LatLng, maneuverVerb, fmtDistanceM, fmtEtaSec } from '../nav';
import { ManeuverArrow, maneuverDir, type ManeuverDir } from '../components/ManeuverArrow';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { fmtPitstop } from '../pitstop';
import { laneIcon } from '../components/TurnByTurnNav';
import { MarqueeText } from '../components/MarqueeText';
import { ListeningEdgeGlow } from '../components/ListeningEdgeGlow';
import { setCarState, setCarSelfPosition, setCarPeers, setCarHazards, getCarState, useCarStore, emitCarGesture, type CarPeer } from './carStore';
import CarMapView, { CAR_LEFT_PAD_FRAC } from './CarMapView';
import { GlassFill, hudTint } from '../Glass';
import { setCarPlayHookOwnsRoot, CAR_LIVE_MAP_ENABLED, CAR_DIAG_MODE } from './carPlayShared';
import { CAR_BAR_BUTTON_CONFIG, CAR_MAP_BUTTON_CONFIG, handleCarBarButton, handleCarMapButton, carTap } from './carActions';
import { formatSpeed, getSettings, getMapMode, getRouteColor, getSelfMarkerType } from '../settings';
import type { RoadEvent } from '../driveBcEvents';
import { logEvent } from '../crashBreadcrumb';

// CarPlay HUD floor — a solid dark tint ONLY on light basemaps (dawn / day / satellite),
// where clear glass over the bright map would wash out. On DARK basemaps (dusk / night)
// it's transparent, so the chips render as pure clear Liquid Glass — glassy, matching the
// phone HUD exactly (the phone chips use hudTint(), which is likewise clear on dark maps).
// Keeps dawn/day readable AND dusk/night glassy. Re-evaluated each render as the auto map
// mode advances with the clock.
function carHudFloor(): string {
  const mode = getMapMode(getSettings());
  const darkMap = mode === 'dusk' || mode === 'night';
  return darkMap ? 'transparent' : 'rgba(18,18,22,0.5)';
}
import { routeKindFor, routeColorsFor } from '../ConvoyMapbox';
import { weatherKind, type WeatherCondition, type WeatherKind } from '../weatherLayer';
import Constants from 'expo-constants';
import { livePttBus } from '../livePtt';
import { WeatherGlyph } from '../components/WeatherHUD';

const isIOS = Platform.OS === 'ios';
const isAndroid = Platform.OS === 'android';

// ── ANDROID AUTO vs CARPLAY, inside CarSurface ───────────────────────────────
// Same value as isAndroid, deliberately named for the thing it actually decides.
// CarSurface only ever renders INSIDE a car session: on iOS it is the CarPlay
// window root ('ConvoyCarSurface', registerCarSurface.ts — itself gated to
// Platform.OS === 'ios'), on Android it is the component handed to the androidx
// NavigationTemplate (AndroidAutoRoot.tsx). There is no phone path into that
// component, so within it `android` IS "this is an Android Auto head unit" —
// which is NOT true of isAndroid elsewhere in this file (useConvoyCarPlay runs
// on the phone).
const IS_AA = isAndroid;

// ── ONE-SHOT ANDROID AUTO CANVAS PROBE (2026-07-28) ──────────────────────────
// Every inset in this file was measured against a CARPLAY canvas (a real 800x480
// head-unit capture = 400x240pt). The Android Auto canvas is a VirtualDisplay
// created from the SurfaceContainer androidx hands us (VirtualRenderer.kt:44) at
// the head unit's own px size and dpi — so its dp size is not knowable from here
// and has never been measured. Jeff's first head-unit photo (Toyota, build 69)
// showed the speedo and the maneuver distance colliding into "0124 m", which only
// happens on a canvas far narrower than CarPlay's.
//
// So report it once per process, through the same crash_reports path the Android
// Auto black box uses. One drive with AA connected answers "how big is this thing
// actually", and every layout decision after that is arithmetic instead of
// another photo round-trip.
let aaCanvasLogged = false;
function logAaCanvas(w: number, h: number): void {
  if (!IS_AA || aaCanvasLogged) return;
  if (!(w > 0) || !(h > 0)) return;
  aaCanvasLogged = true;
  try {
    const win = Dimensions.get('window');
    const ratio = PixelRatio.get();
    logEvent(
      `android-auto-canvas surface=${Math.round(w)}x${Math.round(h)}dp `
      + `px=${Math.round(w * ratio)}x${Math.round(h * ratio)} `
      + `pixelRatio=${ratio} fontScale=${PixelRatio.getFontScale()} `
      + `window=${Math.round(win.width)}x${Math.round(win.height)}dp`,
    );
  } catch {}
}

// FALSE: do NOT drive CarPlay's NATIVE navigation session (no native maneuver banner,
// no native trip-estimate bar). The live CarMapView + our own overlays (topStrip TBT,
// bottomMeta ETA, speed-limit, compass) provide guidance, matching the phone — the
// native CarPlay UI duplicated and covered them. Flip TRUE to restore native guidance.
const CAR_NATIVE_GUIDANCE = false;

// (maneuverArrow now lives in ../nav — shared with the phone banner so the arrow
// glyph is identical on phone + CarPlay.)

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

// ---- The component rendered onto the car screen ----
// Shown the whole time a car is connected — idle (no route) AND during nav.
// Reads the shared store so it shows live data despite being a separate root.
//
// With a GPS fix it shows the LIVE 3D map (CarMapView — Mapbox Standard, pitched
// chase camera) with the maneuver / nearby / speed read-outs floated on top; until
// a fix arrives it shows the boot dashboard. There is deliberately NO 2D/static
// map surface anymore (standing rule: never show the flat street-image map) — a
// GL failure RETRIES the live map instead of demoting (see liveAttempt below).
// Catches a RENDER throw from the live <CarMapView> on the CarPlay window (distinct
// from a GL *load* failure, which CarMapView already reports via onGLError). Without
// this, a throw would unwind the whole CarSurface tree → nothing commits → blank. The
// boundary renders null and fires onFail → a scheduled live-map REMOUNT, so the
// surface still commits (black backstop) and heals to 3D instead of staying empty.
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
  // Tight separators (was three spaces each side): the same three fields in ~15%
  // less width, so 'eta · time · distance' fits the bottom-band banner un-cut.
  const metaLine = [arrival, s.eta, s.distanceRemaining].filter(Boolean).join(' · ');

  const hasFix = typeof s.selfLat === 'number' && typeof s.selfLng === 'number';

  // Live-map RETRY (the "3D 100% of the time" fix). The old `glFailed` was a
  // ONE-WAY latch: a single slow first paint (the 6s watchdog on the secondary
  // CarPlay GL window) or one transient style/tile error demoted the car to the
  // flat 2D static-image map for the ENTIRE connected session — the "basic 2D
  // Hairpin map on connect" bug, and a violation of the no-2D standing rule.
  // Now a GL failure schedules a REMOUNT of CarMapView (key={liveAttempt} →
  // fresh GL context + fresh watchdog) with exponential backoff (1s→8s cap),
  // forever: the car surface only ever shows the live 3D map, or the boot
  // dashboard while there is no GPS fix. While a retry is pending the failed
  // CarMapView stays mounted (dark) — never a flat street raster.
  const [liveAttempt, setLiveAttempt] = useState(0);
  const liveAttemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleLiveRetry = () => {
    if (retryTimerRef.current) return; // one pending retry at a time
    const next = liveAttemptRef.current + 1;
    const delay = Math.min(1000 * 2 ** (next - 1), 8000);
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      liveAttemptRef.current = next;
      setLiveAttempt(next);
    }, delay);
  };
  useEffect(() => () => { if (retryTimerRef.current) clearTimeout(retryTimerRef.current); }, []);

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
  // Match the PHONE speedo EXACTLY: flash red when over the posted limit by >2 km/h
  // (the phone's SpeedPill uses OVER_BUFFER_KMH = 2 on its smoothed speed). Compare in
  // km/h off the raw carStore values so the display unit can't shift the threshold. Was
  // +21 km/h (13 mph) — far more lenient than the phone, so the two flashed red at
  // completely different times ("not synced"). Speed-limit sign shares s.speedLimitKmh.
  const speedoOver = typeof s.speedLimitKmh === 'number' && s.speedLimitKmh > 0
    && (s.speedMs || 0) * 3.6 > s.speedLimitKmh + 2;
  // Dark HUD panels a little transparent (0.8) so the map reads through them; the
  // over-limit RED stays solid as an alert. OTA-tunable.
  // Transparent — the pill's look comes from the GlassFill (real UIGlassEffect,
  // which DOES render on the CarPlay Fabric surface). Over-limit red is carried by
  // the GlassFill's red tintColor, not a floor, so it's red-tinted glass; the
  // normal state is dark hudTint glass. A floor here would mute the glass flat.
  // Solid dark tint floor matching the maneuver banner (rgba(18,18,22,0.5)) so every
  // CarPlay HUD chip reads the SAME on the pale map; red floor when over the limit. The
  // GlassFill on top stays CLEAR (real Liquid Glass sheen) — floor gives the tint.
  const speedoBg = speedoOver ? '#E4002B' : carHudFloor();

  // ── Incoming crew transmission ("X is talking…") ────────────────────────────
  // Mirrors CommsTalkingToast on the phone, off the SAME module-level livePttBus, so
  // no refactor was needed: incoming clips already AUTO-PLAY through
  // useLiveWalkieListener (app/(app)/_layout.tsx:166 -> livePtt.ts:155
  // Audio.Sound.createAsync), and with CarPlay connected that audio routes to the car
  // speakers. This is purely the visual telling you WHO you are hearing.
  //
  // Deliberately DROPS two of the phone toast's guards:
  //  • AppState 'active' — on a head unit the phone is usually backgrounded or locked,
  //    which is exactly when the driver needs the indicator most.
  //  • isCommsScreenFocused() — that exists to stop the phone double-banner; the car
  //    screen is a different surface and never double-shows.
  const [talker, setTalker] = useState<string | null>(null);
  const talkerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const off = livePttBus.on((m) => {
      const st = getSettings();
      if (st.commsLive === false) return;               // respect the Live mute toggle
      if (s.selfUserId && m.user_id === s.selfUserId) return;          // not our own voice
      const activeCh = st.activeThreadId || st.activeCommunityId;
      if (!activeCh || m.channel !== activeCh) return;  // active channel only
      // The listener replays a backlog on cold start / channel switch — only a genuinely
      // recent clip means someone is talking RIGHT NOW.
      const created = new Date(m.created_at).getTime();
      if (Number.isFinite(created) && Date.now() - created > 15000) return;
      setTalker(m.handle || 'Driver');
      if (talkerTimer.current) clearTimeout(talkerTimer.current);
      talkerTimer.current = setTimeout(() => setTalker(null), 3000);
    });
    return () => {
      off();
      if (talkerTimer.current) clearTimeout(talkerTimer.current);
    };
  }, []);

  // Crew / alerts / build pill — the phone's map pill (map.tsx:3204), mirrored. Crew is
  // OTHER crew only, matching the phone rule. Build number comes from the binary so it
  // tracks every build without a manual edit.
  const crewCount = (s.peers || []).length;
  let carRtv = '';
  try { carRtv = require('expo-updates').runtimeVersion || ''; } catch {}
  if (!carRtv) carRtv = (Constants.expoConfig as any)?.runtimeVersion || '';
  // Same publish-time tag as the phone pill (see map.tsx): comparable across iOS and
  // Android, unlike the per-platform update id it replaced.
  let carOtaTag = '';
  try {
    const U = require('expo-updates');
    const ts = U.createdAt ? new Date(U.createdAt) : null;
    const p2 = (n: number) => String(n).padStart(2, '0');
    carOtaTag = U.isEmbeddedLaunch
      ? 'emb'
      : (ts ? `${p2(ts.getDate())}·${p2(ts.getHours())}${p2(ts.getMinutes())}` : '');
  } catch {}
  const carBuildNo = Constants.nativeBuildVersion
    || Constants.expoConfig?.ios?.buildNumber
    || String((Constants.expoConfig as any)?.android?.versionCode ?? '');

  // Measured CPWindow width -> bottom nav-stack width. See CAR_LEFT_INSET: the
  // stack has to fit BETWEEN the speed cluster and the system map buttons, and the
  // CarPlay canvas is far narrower than a phone (~431pt on the iOS 18.6 sim), so a
  // fixed width silently collides on the small end.
  const [surfaceW, setSurfaceW] = useState(0);
  // Clamp DOWNWARD only. A hard MIN floor that exceeds the space available would
  // push the stack's left edge back over the speed cluster — the very collision
  // CAR_LEFT_INSET exists to prevent — so on a canvas too narrow to satisfy the
  // floor the stack gets narrow rather than overlapping.
  // DERIVED car clearance (2026-07-24) — Jeff: "the car marker is still covered by
  // the banners". The old fixed CAR_LEFT_INSET (184) only cleared the SPEED cluster;
  // it knew nothing about where the car actually sits, so on a wider head unit the
  // banner's left edge landed exactly on the car. Mapbox centres the camera in the
  // inset rect, so the car sits at x = W*(1 - CAR_LEFT_PAD_FRAC)/2 — compute that
  // here (importing the same constant the camera uses, so the two can never drift)
  // and keep the stack right of car + half-width + a gap. The stack still also
  // clears the speed cluster, whichever bound is larger.
  const carX = surfaceW > 0 ? (surfaceW * (1 - CAR_LEFT_PAD_FRAC)) / 2 : 0;
  const carClearLeft = carX + CAR_MODEL_HALF_W + NAV_GAP;
  // ── HUD SCALE (2026-07-29) ──────────────────────────────────────────────────
  // MEASURED off Say Phin's head-unit photo (Toyota, build 69) rather than assumed:
  // the crew pill is CREW_PILL_H = 22dp tall with 11pt text, and on that screen it
  // fills ~15% of the canvas height and ~85% of its width. That puts the Android
  // Auto surface at roughly 250 x 143 dp — a THIRD of the area this HUD was tuned
  // for (a 400x240pt CarPlay canvas). Reproducing the shipped numbers at 250dp
  // yields navAvail = 250 - 184 - 48 = 18, forced up to the 120 floor, banner left
  // edge at x=82 over a speedo spanning 56..114: Jeff's "0124 m", exactly.
  //
  // A head unit reports few dp for a physically large screen, so one dp there is
  // ~4-5x the physical size of a phone dp — which is why every chip in that photo
  // looks enormous. Widening/reflowing alone cannot fix it: three stacked rows at
  // full size (42 + 8 + 24 + gaps) are ~74dp of a 143dp canvas and would swallow
  // the map. So scale the HUD to the canvas it actually got, measured from the
  // 400x240 reference, and let every chip, font and gap shrink together.
  //
  // ANDROID AUTO ONLY. The CarPlay surface is verified good today and its own
  // height has never been measured here — scaling it on a guess would risk a known
  // -good surface to fix an unrelated one.
  const [surfaceH, setSurfaceH] = useState(0);
  const hudScale = (IS_AA && surfaceW > 0 && surfaceH > 0)
    ? Math.min(1, Math.max(HUD_SCALE_FLOOR, Math.min(surfaceW / CAR_REF_W, surfaceH / CAR_REF_H)))
    : 1;
  // Each cluster is scaled about its own anchored corner (transformOrigin), so the
  // edge it is pinned to does not move — only its footprint shrinks. The insets
  // themselves are real positions and stay unscaled; what scales is the box that
  // grows away from them, which is why the collision maths below mixes the two.
  const hudFit = (origin: string) => (hudScale < 1
    ? { transform: [{ scale: hudScale }], transformOrigin: origin }
    : null) as any;
  // The transient-status row sits UNDER the crew pill, so its top offset has to
  // follow the pill's SCALED height — otherwise it detaches and floats down the
  // canvas as the scale drops.
  const statusRowFit = (hudScale < 1
    ? [{ top: CAR_PILL_TOP + (CREW_PILL_H + NAV_GAP) * hudScale }, hudFit('center top')]
    : null) as any;
  // Same trap, twice more. Both of these are POSITIONS derived from the speed
  // cluster's full-size height, so at scale they drift away from the thing they are
  // supposed to sit against — the weather chip floats up off the speedo, and the
  // tight-canvas stack leaves a dead band. Re-derive them from the scaled height.
  const weatherBottomFit = SPEED_DOCK_BOTTOM + (SPEED_PILL_H + 4) * hudScale;
  const speedRowTopFit = SPEED_DOCK_BOTTOM + (SPEED_PILL_H + NAV_GAP) * hudScale;
  // Width genuinely free for the stack once the speed cluster and the car itself
  // are cleared. The speed cluster's own left inset is a position (unscaled); the
  // pill + limit badge that extend rightward from it are scaled.
  const effLeftInset = CAR_DOCK_LEFT + (CAR_LEFT_INSET - CAR_DOCK_LEFT) * hudScale;
  // Physical space free, then converted back to DESIGN units (the stack's width is
  // written in design units and shrunk by the transform).
  const navAvail = surfaceW > 0
    ? (surfaceW - Math.max(effLeftInset, carClearLeft) - CAR_RIGHT_INSET) / hudScale
    : 0;
  // ── TIGHT CANVAS REFLOW (2026-07-28, the Android Auto overlap) ──────────────
  // The comment above says "clamp downward only", but the code did the opposite:
  // Math.max(NAV_STACK_ABS_MIN_W, …) FORCED the stack to 120pt even when only, say,
  // 88pt were free — and since the stack is anchored right, the extra width grew
  // LEFTWARD, straight over the speedo. On a head unit that is exactly Jeff's
  // "0124 m": the speedo's "0" and the maneuver banner's "124 m" printed on top of
  // each other, with "km/h" tucked underneath. CarPlay never showed it because a
  // ~431pt CarPlay canvas always had the room; the AA canvas does not.
  //
  // A narrower banner is not the answer below the floor either — under ~120pt the
  // instruction is unreadable anyway. So when the two cannot share the bottom band,
  // they stop sharing it: the stack takes the FULL width and moves up one row, and
  // the weather chip slides across to sit beside the speedo instead of above it.
  // Three fixed rows, no overlap possible at any canvas size, and the arithmetic —
  // not a tuned constant — decides which layout applies.
  // With hudScale applied this is now a genuine BACKSTOP rather than the everyday
  // path: at the measured 250x143 the scaled cluster leaves ~169 design units, so
  // the normal side-by-side layout fits. It still fires on a canvas narrower than
  // anything measured, and it can no longer swallow the screen because the rows it
  // stacks are scaled too.
  const tightCanvas = surfaceW > 0 && navAvail < NAV_STACK_ABS_MIN_W;
  const navStackW = surfaceW > 0
    ? (tightCanvas
        ? Math.max(0, (surfaceW - 2 * CAR_DOCK_LEFT) / hudScale)
        : Math.min(NAV_STACK_MAX_W, navAvail))
    : NAV_STACK_FALLBACK_W;
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
  // Slide the posted-limit SIGN just clear of the 68pt-wide speedo pill plus a SMALL
  // gap so the two tiles sit close together (68 pill + 8 gap = 76). Tightened from 100
  // — the sign was drifting too far to the right of the speedo.
  // Slide-out distance = pill width (58) + 4px — the SAME 4px gap the weather
  // chip keeps above the speedo, so the bottom-left cluster reads as one unit.
  const limitSlideX = limitSlide.interpolate({ inputRange: [0, 1], outputRange: [0, 62] });

  // Live @rnmapbox MapView gate. Two conditions:
  //   - CAR_LIVE_MAP_ENABLED: master kill-switch (carPlayShared). Flip FALSE via
  //     OTA to force the boot dashboard (emergency lever — there is no 2D map).
  //   - hasFix: we have a GPS position.
  // A GL failure no longer gates this — it schedules a live-map REMOUNT instead
  // (liveAttempt above), so the car always converges on the 3D map.
  const showLive = CAR_LIVE_MAP_ENABLED && hasFix;

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

  // Boot dashboard — shown ONLY until a GPS fix arrives (no fix = nothing to map).
  // There is deliberately no map-image branch here anymore: with a fix, the live 3D
  // CarMapView is the ONLY map surface (see liveAttempt retry above).
  const bootSurface = (
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
          <Text style={styles.brand}>HAIRPIN</Text>
          <Text style={styles.sub}>{nearby ? `${nearby} ${nearby === 1 ? 'car' : 'cars'} nearby` : 'Drive together'}</Text>
          {/* Self-diagnosing readout (no Mac/logs needed): shows whether the car surface
              has a GPS fix, the actual lat/lng it reads, and which feed last wrote
              (fgfeed / navtask#N / seed:ok / seed:err / seed:no-fg-perm / bgstart:err). */}
          {getSettings().carplayDebug === true ? (
            <Text style={styles.carDbgLine} numberOfLines={2}>
              {`fix=${hasFix} lat=${typeof s.selfLat === 'number' ? s.selfLat.toFixed(4) : 'null'} `
                + `lng=${typeof s.selfLng === 'number' ? s.selfLng.toFixed(4) : 'null'}\nfeed=${s.carDbg ?? '-'}`}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );

  // Maneuver + meta overlays that float on top of the live CarMapView. No center
  // chevron here — the live map draws the real 3D car (ModelLayer) itself.
  const mapOverlays = (
    <>
      {/* BOTTOM-RIGHT nav stack (out of the route line's way): the ETA pill sits just
          ABOVE the turn-by-turn maneuver banner, and both share the same width.
          ── WHO OWNS WHAT ON ANDROID AUTO (verified 2026-07-28) ─────────────────
          The obvious theory for the overlapping head-unit HUD was that androidx is
          ALREADY drawing a maneuver card and a travel estimate from what
          AndroidAutoRoot pushes in updateTemplate, i.e. that we double-draw. That
          theory is WRONG, and the code says so:
            CarPlayModule.kt:123  `val screen = carScreens[name]`
          `name` there is getName() — the NATIVE MODULE's name, "RNCarPlay".
          carScreens is only ever keyed by "root" and by templateId, so the lookup
          always returns null and the whole body is skipped. updateTemplate is a
          SILENT NO-OP on Android. androidx has never received our navigationInfo
          or travelEstimate; every pixel of nav chrome on that head unit is ours.
          (Two further shape bugs sit behind it — parseTravelEstimate does
          getMap("destinationTime")!! and parseRoutingInfo getMap("step")!!, while
          AndroidAutoRoot sends neither key — so simply fixing the lookup would
          NPE on the car's main thread. All three are patch-package work, i.e. a
          native build; see the build-70 notes.)
          So on AA this stack is the ONLY maneuver and ETA the driver has. It stays.
          What actually collides is width — see navStackW / tightCanvas. */}
      {s.navigating ? (
        <View
          style={[
            styles.navStack,
            { width: navStackW },
            // Scaled about the bottom-right corner it is pinned to.
            hudFit('right bottom'),
            // Tight canvas: full width, lifted one row so it clears the speed cluster
            // entirely instead of growing over it.
            tightCanvas ? { right: CAR_DOCK_LEFT, bottom: speedRowTopFit } : null,
          ]}
          pointerEvents="none"
        >
          {/* LANE GUIDANCE ("3D-lanes lite") — the phone's glowing-lane diagram on
              the head unit: active lanes brand green, the rest dim. Appears only
              when Mapbox lane data confidently matches the upcoming turn (the
              fail-closed pickLaneCue), warm via the phone mirror or cold via
              navNotification — so it works with the phone in a pocket too. */}
          {!!s.lanes && s.lanes.length > 0 ? (
            <View style={[styles.laneRow, { backgroundColor: carHudFloor() }]}>
              <GlassFill tintColor={undefined} style={{ borderRadius: 12, overflow: 'hidden' }} />
              {s.lanes.map((lane, i) => (
                <MaterialCommunityIcons
                  key={i}
                  name={laneIcon((lane.active && lane.activeDir) ? lane.activeDir : (lane.dirs[0] || 'straight'))}
                  size={laneIconSize(s.lanes!.length, navStackW)}
                  color={lane.active ? '#2DEC86' : '#5A5A5E'}
                />
              ))}
            </View>
          ) : null}
          {/* ETA — just above the maneuver banner. */}
          {metaLine ? (
            <View style={[styles.navEta, { backgroundColor: carHudFloor() }]}>
              <GlassFill tintColor={undefined} style={{ borderRadius: 10, overflow: 'hidden' }} />
              {/* Jeff's spec: eta/time/distance must FIT, not truncate to "27…".
                  adjustsFontSizeToFit shrinks the last few points on a narrow head
                  unit rather than cutting; a marquee here made a fixed 3-field
                  readout crawl, which is worse for a glanceable number. */}
              <Text
                style={styles.bottomText}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              >{metaLine}</Text>
            </View>
          ) : null}
          {/* Maneuver banner — bottom of the stack. */}
          <View style={[styles.navBannerRow, { backgroundColor: carHudFloor() }]}>
            <GlassFill tintColor={undefined} style={{ borderRadius: 12, overflow: 'hidden' }} />
            <View style={styles.maneuverBox}>
              <ManeuverArrow dir={(s.maneuverIcon as ManeuverDir) || 'straight'} size={24} color="#0B0B0C" />
            </View>
            <View style={styles.topTextCol}>
              <Text style={styles.topDist}>{s.distanceToTurn || '—'}</Text>
              <MarqueeText text={s.instruction || 'Continue'} style={styles.topInst} />
            </View>
          </View>
        </View>
      ) : null}

      {/* TEMP diagnostic for the CarPlay connection / background-location work:
          which feed last wrote a fix, and its tick. `navtask#N` = the background
          task is delivering (N keeps climbing even with the phone screen off);
          `fgfeed` = only the foreground watch is running (freezes on screen-lock).
          Shown on the LIVE map so a mid-drive freeze is diagnosable on the head
          unit itself. Remove once the background-location fix is verified. */}
      {/* Re-gated 2026-07-19 after the CarPlay template root cause was fixed and
          CONFIRMED on the head unit (chrome renders: Search/End/Police + the four
          map buttons). While forced-visible this line sat under the nav bar and
          collided with the End button. `cp=` (carStore.cpDbg) reports the template
          state and stays available behind the flag — carDbg alone is useless for
          that, since every position tick overwrites it. */}
      {getSettings().carplayDebug === true ? (
        <View style={styles.mapFeedDiag} pointerEvents="none">
          <Text style={styles.mapFeedDiagText} numberOfLines={1}>{`feed=${s.carDbg ?? '-'}`}</Text>
          <Text style={styles.mapFeedDiagText} numberOfLines={1}>{`cp=${s.cpDbg ?? '-'}`}</Text>
        </View>
      ) : null}
    </>
  );

  return (
    <View
      style={styles.surface}
      onLayout={(e) => {
        const w = e?.nativeEvent?.layout?.width;
        const h = e?.nativeEvent?.layout?.height;
        if (typeof w === 'number' && w > 0 && Math.abs(w - surfaceW) > 1) setSurfaceW(w);
        if (typeof h === 'number' && h > 0 && Math.abs(h - surfaceH) > 1) setSurfaceH(h);
        // Android Auto only, once per process — see logAaCanvas.
        if (typeof w === 'number' && typeof h === 'number') logAaCanvas(w, h);
      }}
    >
      {showLive ? (
        // Live 3D map on the CarPlay window — the ONLY map surface. A GL/load
        // failure (watchdog, style error, render throw) schedules a remount with
        // backoff via scheduleLiveRetry; key={liveAttempt} gives the retry a fresh
        // GL context + boundary + watchdog. attempt>0 widens the paint watchdog.
        <>
          <CarMapBoundary key={liveAttempt} onFail={scheduleLiveRetry}>
            <CarMapView attempt={liveAttempt} onGLError={scheduleLiveRetry} />
          </CarMapBoundary>
          {mapOverlays}
        </>
      ) : (
        bootSurface
      )}

      {/* ---- Shared overlays: render on top of EITHER surface (live or static) ---- */}

      {/* Speed pill — bottom-LEFT, offset right of the CarPlay side bar. Pulses RED
          when well over the posted limit. The posted-limit sign is rendered FIRST so
          it sits BEHIND the pill, then springs out to the right when moving (phone-style). */}
      <View style={[styles.speedDock, hudFit('left bottom')]} pointerEvents="none">
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
          <GlassFill tintColor={undefined} style={{ borderRadius: 16, overflow: 'hidden' }} />
          <Text style={styles.speedNum} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{spd.value}</Text>
          <Text style={styles.speedUnit}>{spd.label.toLowerCase()}</Text>
        </Animated.View>
      </View>

      {/* Live weather chip — BOTTOM-LEFT, just above the speedo with a small gap, to
          mirror the phone HUD's weather-over-speed column (same vector glyph + temp).
          Shows whenever the phone's weather layer is feeding carStore, incl. nav. */}
      {s.weatherTemp ? (
        <View
          style={[
            styles.weatherChip,
            { backgroundColor: carHudFloor() },
            hudFit('left bottom'),
            // Keep the chip sitting ON the speedo at any scale (its `bottom: 62` is
            // 10 + the pill's FULL 48 + 4, so it floats away as the pill shrinks).
            hudScale < 1 ? { bottom: weatherBottomFit } : null,
            // Tight canvas: the raised nav stack now occupies the row above the
            // speedo, so the chip moves BESIDE it — right of the fully-extended
            // posted-limit badge, which is exactly what CAR_LEFT_INSET measures.
            tightCanvas ? { left: effLeftInset, bottom: SPEED_DOCK_BOTTOM } : null,
          ]}
          pointerEvents="none"
        >
          <GlassFill tintColor={undefined} style={{ borderRadius: 12, overflow: 'hidden' }} />
          {s.weatherKind ? <WeatherGlyph kind={s.weatherKind as WeatherKind} size={20} /> : null}
          <Text style={styles.weatherText}>{s.weatherTemp}</Text>
        </View>
      ) : null}

      {/* Siri-style edge glow on the CAR screen — green while Scout listens,
          amber while the agent turn is in flight. Same component as the phone,
          driven by the carStore mirror flags. */}
      <ListeningEdgeGlow
        active={!!s.scoutListening || !!s.scoutThinking}
        color={s.scoutListening ? '#2DEC86' : '#FF9F0A'}
      />

      {/* Scout mic — RN-SURFACE button (EXPERIMENT). The native map buttons are
          covered by this surface, so this tests whether the surface receives
          CarPlay taps. Renders for sure (like the HUD chips). Tap emits a
          carStore action that map.tsx (same JS context) turns into tap-to-talk.
          Green while listening, amber while thinking, white idle. */}
      {/* The drawn Scout mic was REMOVED 2026-07-20 (Jeff's call). It had been demoted
          to a status indicator because CarPlay never delivers touches to the app's own
          window — so it was a pixel-identical twin of the real `car-mic` CPMapButton
          that could never respond to a tap, sitting in the most reachable corner of the
          screen. With the Listening…/Thinking… pill now visible (it used to be hidden
          behind the nav bar at top:10) Scout state is already reported, so the twin was
          pure downside: a dead target a driver would jab at mid-drive. The one true mic
          is the native CPMapButton in the trailing column. */}

      {/* CREW / ALERTS / BUILD — top-centre, mirroring the phone's map pill
          (map.tsx:3204). Small and non-tappable by necessity: CarPlay routes touches
          through the template, so nothing we draw can ever be a control. Crew counts
          OTHER crew only, same rule as the phone. */}
      <View style={[styles.topCenterRow, hudFit('center top')]} pointerEvents="none">
        <View style={[styles.crewPill, { backgroundColor: carHudFloor() }]}>
          <GlassFill tintColor={undefined} style={{ borderRadius: 9, overflow: 'hidden' }} />
          <Text style={styles.crewPillText} numberOfLines={1}>
            {crewCount} Crew · v{carBuildNo}{carRtv ? ` · ${carRtv}` : ''}{carOtaTag ? ` · ${carOtaTag}` : ''}
          </Text>
        </View>
      </View>

      {/* TRANSIENT STATUS — one slot, directly under the crew pill, shared by the two
          mutually-exclusive states so they can never stack on a ~240pt-tall canvas.
          A live crew transmission WINS over Scout: someone talking to you is more
          urgent than your own assistant's progress.
          Incoming audio already AUTO-PLAYS through the car speakers (the app-level
          useLiveWalkieListener), so this is the "who am I hearing" caption, not a
          prompt to tap — and it could not be tappable anyway. */}
      {/* PITSTOP — highest priority in this slot. A parked car has no live transmission
          and no Scout progress to compete with, and the driver has walked away from the
          screen: when they glance back, the running clock is the ONE thing they want.
          Candy red matches the phone card (src/components/PitstopCard.tsx). */}
      {s.pitstopActive ? (
        <View style={[styles.statusRow, statusRowFit]} pointerEvents="none">
          <View style={[styles.scoutPill, { backgroundColor: carHudFloor() }]}>
            <GlassFill tintColor={undefined} style={{ borderRadius: 16, overflow: 'hidden' }} />
            <MaterialCommunityIcons
              name={s.pitstopKind === 'gas' ? 'gas-station'
                : s.pitstopKind === 'food' ? 'silverware-fork-knife'
                : s.pitstopKind === 'coffee' ? 'coffee' : 'parking'}
              size={16}
              color="#E4002B"
            />
            <Text style={styles.scoutPillText} numberOfLines={1}>
              {s.pitstopLabel ? `${s.pitstopLabel} · ` : 'Pitstop · '}
              {fmtPitstop(s.pitstopElapsedS || 0)}
            </Text>
          </View>
        </View>
      ) : Date.now() < (s.carToastUntil || 0) && s.carToast ? (
        /* ACTION RECEIPT. This slot replaced the CPAlertTemplate modals that every
           button used to raise for its confirmation. A presented template covers the
           map and makes EVERY map button unreachable by design, and carAlert's
           auto-dismiss is a setTimeout — which iOS pauses while the phone is locked,
           i.e. exactly how a phone sits in a mount. One tap that produced a message
           could therefore strand a modal that never timed out and kill every CarPlay
           button for the rest of the drive. Expiry here is a TIMESTAMP COMPARISON at
           render, so a paused timer cannot strand it, and the worst failure is a
           caption lingering — never a dead screen. */
        <View style={[styles.statusRow, statusRowFit]} pointerEvents="none">
          <View style={[styles.scoutPill, { backgroundColor: carHudFloor() }]}>
            <GlassFill tintColor={undefined} style={{ borderRadius: 16, overflow: 'hidden' }} />
            <MaterialCommunityIcons name="information-outline" size={16} color="#2DEC86" />
            <Text style={styles.scoutPillText} numberOfLines={1}>{s.carToast}</Text>
          </View>
        </View>
      ) : (Date.now() < (s.crewViewUntil || 0) && s.commsTx !== 'recording') ? (
        <View style={[styles.statusRow, statusRowFit]} pointerEvents="none">
          <View style={[styles.scoutPill, { backgroundColor: carHudFloor() }]}>
            <GlassFill tintColor={undefined} style={{ borderRadius: 16, overflow: 'hidden' }} />
            <MaterialCommunityIcons name="account-group" size={16} color="#2DEC86" />
            <Text style={styles.scoutPillText}>Crew view · {s.crewViewCount ?? 0}</Text>
          </View>
        </View>
      ) : (s.commsTx === 'recording' || s.commsTx === 'sending') ? (
        <View style={[styles.statusRow, statusRowFit]} pointerEvents="none">
          <View style={[styles.scoutPill, { backgroundColor: carHudFloor() }]}>
            <GlassFill tintColor={undefined} style={{ borderRadius: 16, overflow: 'hidden' }} />
            <View style={[styles.scoutDot, { backgroundColor: s.commsTx === 'recording' ? '#FF453A' : '#8E8E93' }]} />
            <Text style={styles.scoutPillText}>{s.commsTx === 'recording' ? 'Transmitting…' : 'Sending…'}</Text>
          </View>
        </View>
      ) : talker ? (
        <View style={[styles.statusRow, statusRowFit]} pointerEvents="none">
          <View style={[styles.scoutPill, { backgroundColor: carHudFloor() }]}>
            <GlassFill tintColor={undefined} style={{ borderRadius: 16, overflow: 'hidden' }} />
            <MaterialCommunityIcons name="account-voice" size={16} color="#FF6A00" />
            <Text style={styles.scoutPillText} numberOfLines={1}>{talker} is talking…</Text>
          </View>
        </View>
      ) : (s.scoutListening || s.scoutThinking) ? (
        <View style={[styles.statusRow, statusRowFit]} pointerEvents="none">
          <View style={[styles.scoutPill, { backgroundColor: carHudFloor() }]}>
            <GlassFill tintColor={undefined} style={{ borderRadius: 16, overflow: 'hidden' }} />
            <View style={[styles.scoutDot, { backgroundColor: s.scoutListening ? '#2DEC86' : '#8E8E93' }]} />
            <Text style={styles.scoutPillText}>{s.scoutListening ? 'Listening…' : 'Thinking…'}</Text>
          </View>
        </View>
      ) : null}

      {/* The compass was REMOVED from CarPlay entirely (2026-07-20, Jeff's call). The car
          map is heading-up and the maneuver banner already states the turn, so a north
          needle earns little on a ~400x240pt canvas — and it was the item forcing the
          left rail over its height budget. The phone HUD keeps its compass. */}
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

// The Mapbox "type|modifier" key for the SAME upcoming step — carries the roundabout
// exit direction so the arrow can leave the circle at the real angle.
function upcomingManeuverKey(route: NavRoute | null, stepIndex: number): string | undefined {
  const steps = route?.steps ?? [];
  if (!steps.length) return undefined;
  const idx = Math.min(stepIndex + 1, steps.length - 1);
  return (steps[idx] ?? steps[steps.length - 1])?.maneuver;
}

function toCarPeers(peers?: Record<string, any> | null): CarPeer[] {
  if (!peers) return [];
  return Object.values(peers)
    .map((p: any) => ({
      id: p?.user_id,
      handle: p?.handle,
      // Optional position fields → CarMapView draws the convoy on the head-unit
      // map (CarPlay-standalone Wave 1). Peers without coords just skip the dot.
      lat: typeof p?.lat === 'number' ? p.lat : undefined,
      lng: typeof p?.lng === 'number' ? p.lng : undefined,
      heading: typeof p?.heading === 'number' ? p.heading : undefined,
      status: (p?.status === 'parked' ? 'parked' : 'live') as 'live' | 'parked',
    }))
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
  // Tapped from the CarPlay native mic map button — toggles the agentic Scout
  // listener (tap to start, tap again to stop + send). Wired to map.tsx's
  // useVoice instance; listening/thinking feedback renders via carStore flags.
  onScoutMic?: () => void;
  // Map markers to mirror onto the CarPlay live map. The caller (map.tsx) applies the
  // 'when active' gates before passing these (cameras/roadEvents are already [] when
  // their layer is off; places only when the pins setting is on; hazards pre-filtered).
  hazards?: { id: string; kind: string; lat: number; lng: number; confirms?: number; disputes?: number }[];
  speedCameras?: { id: string; lat: number; lng: number }[];
  roadEvents?: RoadEvent[];
  places?: { id: string; lat: number; lng: number; label?: string }[];
  // ACCOUNT id — note that `user` in these args is the driver's POSITION, not the
  // account. Mirrored into carStore so the car surface can drop our own voice out of
  // the "X is talking…" indicator (the car surface is a SEPARATE React root, so it
  // cannot read AuthProvider context itself).
  selfUserId?: string;
};

/**
 * Mount ONCE from map.tsx. Mirrors live route + turn-by-turn + nearby-convoy
 * state onto CarPlay (iOS, tabbed) / Android Auto (nav only). No-op on web.
 */
export function useConvoyCarPlay({ route, routes, selectedRouteIndex = 0, tbt, user, destination, peers, onEnd, weather, onReportPolice, onScoutMic, hazards, speedCameras, roadEvents, places, selfUserId }: CarPlayArgs) {
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
  const onScoutMicRef = useRef(onScoutMic);
  onScoutMicRef.current = onScoutMic;

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
    // When the phone's OWN tbt is idle, OMIT the nav fields entirely instead of
    // writing '' — a route started FROM CARPLAY SEARCH is driven by the COLD
    // banner engine (navNotification), and this mirror ticking '' over its
    // eta/distanceRemaining every second was why the ETA row showed nothing on
    // car-initiated routes (Jeff's 7/23 drive). navigating flips true from the
    // cold engine's own write; the mirror only overwrites once tbt goes active
    // (the adopted phone route), whose richer numbers then win legitimately.
    setCarState({
      // speedMs is NOT written here any more — it rides the source-priority gate with
      // position (setCarSelfPosition below). Writing it here as well would reintroduce
      // exactly the ungated path that let a rejected feed drive the zoom.

      destinationLabel: destination?.label || '',
      ...(tbt.active ? {
        navigating: true,
        instruction: upcomingInstruction(route, tbt.stepIndex),
        distanceToTurn: fmtDistanceM(tbt.distanceToManeuverM),
        eta: fmtEtaSec(tbt.etaSeconds),
        distanceRemaining: fmtDistanceM(tbt.distanceRemainingM),
      } : {}),
      // NOTE: peers + hazards are NOT written here anymore — they go through the
      // gated setCarPeers/setCarHazards writes in the effect below, so the cold
      // carDataService and this warm mirror can share ownership without clobbering.
      // Raw numerics for the Android Auto NavigationTemplate (AndroidAutoRoot).
      ...(tbt.active ? {
        distanceToTurnM: tbt.distanceToManeuverM,
        distanceRemainingM: tbt.distanceRemainingM,
        etaSeconds: tbt.etaSeconds,
      } : {}),
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
      // Self-marker style → car live map renders the arrow when the phone does.
      selfMarkerType: getSelfMarkerType(getSettings()),
      // Mirrored map markers (gates already applied by the caller). undefined→[] so a
      // cleared layer wipes the car too. (hazards moved to the gated write below.)
      speedCameras: speedCameras || [],
      roadEvents: roadEvents || [],
      places: places || [],
      selfUserId,
      // Route-line color → car route matches the phone's chosen color.
      routeColor: getRouteColor(getSettings()),
      // Selected route's KIND → the car resolves the same per-kind transform the
      // phone paints with (scenic = contrast color, AI = black core). Without it
      // CarPlay drew the raw base color and diverged from the phone on AI/scenic.
      routeKind: routes && routes.length ? routeKindFor(selectedRouteIndex, routes[selectedRouteIndex]) : 'best',
      // Live weather (only while the phone's weather layer feeds it). Temp pre-formatted
      // in the driver's unit; CarSurface maps weatherKind to a glyph.
      weatherTemp: weather
        ? `${Math.round(getSettings().speedUnit === 'mph' ? weather.tempF : weather.tempC)}°${getSettings().speedUnit === 'mph' ? 'F' : 'C'}`
        : undefined,
      weatherKind: weather ? weatherKind(weather) : undefined,
      // Arrow glyph for the car banner's maneuver box.
      maneuverIcon: tbt.active ? maneuverDir(upcomingInstruction(route, tbt.stepIndex), upcomingManeuverKey(route, tbt.stepIndex)) : undefined,
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
    user?.speed,
    weather,
    speedCameras,
    roadEvents,
    places,
  ]);

  // ---- peers + hazards: GATED writes (dual ownership with the cold service) ----
  // Split out of the metadata effect so they route through the carStore freshness
  // gates: this warm phone mirror ('phone') always wins while it's writing; when the
  // phone screen unmounts/backgrounds and its writes stop, the module-scope
  // carDataService ('service', started on CarPlay connect) takes over within
  // FEED_STALE_MS — so the head unit keeps showing the convoy + hazards cold.
  // Legacy REST/WS peers — FALLBACK ONLY. map.tsx pushes the presence-merged crew
  // (the real live feed); this must never clobber it with the empty legacy map.
  useEffect(() => {
    const incoming = toCarPeers(peers);
    if (!incoming.length) return;                        // never write empty
    if ((getCarState().peers || []).length > 0) return;  // presence feed owns it
    setCarPeers(incoming, 'phone');
  }, [peers]);
  useEffect(() => { setCarHazards(hazards || [], 'phone'); }, [hazards]);

  // ---- position mirror: ADDITIVE ONLY ----
  // Writes selfLat/selfLng/heading ONLY when the phone has a real fix. carStore is a
  // shallow merge, so this can never null out a fix that the cold/foreground location
  // feed (navNotification) already landed — which is what was bouncing the warm car
  // surface back to the CONVOY logo. speedMs stays in the metadata effect above.
  useEffect(() => {
    if (typeof user?.lat !== 'number' || typeof user?.lng !== 'number') return;
    // Gated by source priority — the phone mirror (BestForNavigation/0m) is the most
    // accurate feed, so it wins over the fg/bg car feeds while the phone is foreground.
    setCarSelfPosition(
      user.lat, user.lng,
      typeof user?.heading === 'number' ? user.heading : null,
      'mirror',
      // Speed rides the position gate as of 2026-07-30 (see carStore). It used to be
      // written ungated in the metadata effect above, which meant a feed whose position
      // the gate REJECTED could still move the chase-zoom target — framing from one
      // track, position from another.
      typeof user?.speed === 'number' ? user.speed : undefined,
    );
  }, [user?.lat, user?.lng, user?.heading, user?.speed]);

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
            // processColor(), NOT a hex string — see the same fix in
            // carPlayBootstrap.ts: an NSString converts to NIL and the present-key
            // check then skips the lib's own fallback, setting nil on a nonnull
            // CPMapTemplate property.
            guidanceBackgroundColor: processColor('#0B0B0C'),
            tripEstimateStyle: 'dark',
            // KEEP the map buttons (police + Scout mic) on screen. CPMapTemplate's
            // defaults auto-hide the navigation bar after a few idle seconds and
            // hide the map buttons WITH it — which is why the police button was
            // "never seen" on the head unit: it only existed for the first moments
            // after the template appeared. Pin both so the buttons are always there.
            automaticallyHidesNavigationBar: false,
            hidesButtonsWithNavigationBar: false,
            // Wave 3: Search / Police / End on the map template's NAV BAR — the
            // chrome layer that renders + taps on the head unit (the round
            // mapButtons below still don't; kept pending the native fix). Same
            // module-scope handlers as the cold root, so behavior is identical
            // whether or not the phone app is open.
            leadingNavigationBarButtons: CAR_BAR_BUTTON_CONFIG.leadingNavigationBarButtons,
            trailingNavigationBarButtons: CAR_BAR_BUTTON_CONFIG.trailingNavigationBarButtons,
            onBarButtonPressed: (e: { id: string }) => {
              // WARM End must end the PHONE's navigation too (Jeff's head-unit
              // report: ending on CarPlay left the phone navigating, and the
              // mirror immediately re-populated the car route — End looked dead).
              // onEndRef reaches map.tsx's endNav; everything else falls through
              // to the shared handler so cold behaviour is identical.
              if (e?.id === 'car-end') { carTap('car-end'); onEndRef.current?.(); return; }
              handleCarBarButton(e?.id);
            },
            onDidCancelNavigation: () => onEndRef.current?.(),
            // Round CPMapButtons — POLICE + SCOUT MIC in OUR OWN artwork, from the
            // SHARED config so the warm and cold roots can never drift apart again
            // (they previously declared different sets with different ids, which is
            // exactly how "one button works and the others don't" kept happening).
            // Zoom ± was removed here: it ate two of CarPlay's four map-button slots
            // and crowded our nav stack. Pinch-to-zoom is untouched — see the zoom
            // gesture handlers below.
            mapButtons: CAR_MAP_BUTTON_CONFIG.mapButtons,
            onMapButtonPressed: (e: { id: string }) => {
              // Warm root: prefer the live ref (reaches the mounted surface); anything
              // else falls through so cold-root behaviour stays identical. (Police was
              // removed from CarPlay at Jeff's request, 2026-07-20.)
              if (e?.id === 'car-mic') { carTap('car-mic'); onScoutMicRef.current?.(); return; }
              handleCarMapButton(e?.id);
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
          // ── FULL-CHAIN TEMPLATE DIAGNOSTIC (2026-07-19) ──────────────────
          // Head-unit evidence (build 67, both idle AND routing): our RN surface
          // renders perfectly but ZERO CPMapTemplate chrome appears — no nav bar,
          // no map buttons. So the break is at/after setRootTemplate. Native
          // setRootTemplate (RNCarPlay.m:545-558) NSLogs and returns NOTHING on
          // both branches — a store miss (template id absent) is SILENT end to end,
          // and this JS call site historically swallowed throws. Capture each link
          // onto the car surface so one photo says exactly where it dies.
          let dbg = 'conn=' + (CarPlay.connected ? '1' : '0')
            + ' tpl=' + (mapTemplate ? ('ok:' + String((mapTemplate as any)?.id ?? '?').slice(0, 10)) : 'NULL');
          try {
            CarPlay.setRootTemplate(mapTemplate);
            dbg += ' root=CALLED';
          } catch (e) {
            dbg += ' root=THREW:' + String(e).slice(0, 28);
          }
          setCarState({ carDbg: dbg });
          // Template-layer probe REMOVED 2026-07-19 — it did its job (chrome is
          // confirmed rendering on the head unit) and it had become a liability:
          // carAlert() builds a CPAlertTemplate, which goes through Template.ts's
          // non-map createTemplate path. That path passed an undefined callback on
          // iOS (Platform.select had no `ios` key), which the bridgeless TurboModule
          // interop rejects with an ObjC exception -> SIGABRT. So this passive probe
          // was crashing the app on a 6s timer after every CarPlay connect. The
          // underlying callback bug is fixed in the patch; the probe stays gone.
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

// ── CarPlay chrome insets (2026-07-20, measured in the iOS 18.6 CarPlay sim) ────
// Our RN surface is mounted on the FULL CPWindow, but CPMapTemplate draws its own
// chrome ON TOP of it: a navigation bar across the top and a vertical stack of
// round CPMapButtons down the RIGHT edge. None of that is movable — CPMapButton
// exposes only image/focusedImage/enabled/hidden, with no position API — so the
// avoidance has to happen on OUR side.
//
// Verified in the simulator: with these at 0 the Scout mic was CLIPPED by the nav
// bar and the bottom-right nav stack (lane guidance / ETA / maneuver banner) ran
// straight under the police + mic buttons.
//
// Apple's real answer is CPWindow.mapButtonSafeAreaLayoutGuide (CPWindow.h:18),
// which reports the true chrome-free rect per head unit. Reading it needs native
// plumbing into carStore, so it is queued for build 68; until then these constants
// match the measured chrome and are deliberately generous. Erring large costs a
// little map, erring small hides a turn instruction.
const CAR_TOP_INSET = 58; // clears the CPMapTemplate navigation bar
// The nav stack is back at the RIGHT EDGE. It only had to be inset by the whole
// button column while police/mic sat in the bottom two slots; two invisible spacer
// buttons now hold those slots (see CAR_MAP_BUTTON_CONFIG), lifting the real pair
// clear of the ETA and maneuver banner. CPMapTemplate.h:71-75 caps mapButtons at 4,
// so 2 real + 2 spacers is the highest they can possibly go.
// Jeff's OPTION 2 (2026-07-24, his exact spec): banners in the BOTTOM band, to the
// LEFT of the crew/compass buttons — not above them. 64 clears the iOS-26 glass
// button column (~56pt) + air. Both banners may grow TOWARD the car so the
// eta/time/distance line fits un-cut — but the car itself is untouched.
// 64 -> 48 (2026-07-24). Measured off Jeff's head-unit photo: at 64 the banner's
// right edge sat ~23pt clear of the glass button circles — a visible dead channel.
// The circles start ~41pt in from the trailing edge, so 48 leaves ~7pt of air:
// tight, still non-touching.
// ...and 48 is likewise a CARPLAY number: it exists to clear iOS's trailing glass
// map-button circles. Android Auto draws no button column over our surface (its
// action strip is androidx chrome outside the stable area), so on AA the same 48
// is just wasted width on a canvas that has none to spare.
const CAR_RIGHT_INSET = IS_AA ? 12 : 48;
const NAV_STACK_BOTTOM = 8;

// ── ONE SPACING RHYTHM (2026-07-20) ──────────────────────────────────────────
// Measured off a real 800x480 CarPlay capture (= 400x240pt @2x) by decoding the
// PNG and finding the glyph rows/columns, NOT by eyeballing:
//   police glyph rows 179-231  -> 26pt tall, centre 102.5pt from the top
//   mic    glyph rows 247-301  -> 27pt tall, centre 137pt   from the top
//   police <-> mic gap ......... 8pt
//   leftmost glyph edge ........ x=366pt, i.e. 34pt in from the trailing edge
// So 8pt is the system's own rhythm, and everything we draw matches it.
const NAV_GAP = 8;
// Lane row's right edge lands NAV_GAP clear of the leftmost glyph (400-366-8=26 ->
// 42 from the edge once CAR_RIGHT_INSET is added back by the margin below).
const CAR_MAP_BUTTON_COL_W = 42;

// EXPLICIT row heights. These were paddingVertical-derived, which made the stack's
// total height depend on RN's font line-height and therefore impossible to align
// against a fixed system button. Fixed heights make the arithmetic exact:
//   lane centre from bottom = 8 + TURN + 8 + ETA + 8 + LANE/2
//                           = 8 + 42  + 8 + 22  + 8 + 15   = 103pt
//   mic centre from bottom  = 240 - 137                    = 103pt   <- aligned
// LANE_ROW_H ~= the mic's own 27pt so the two read as one row, per Jeff's
// "the arrow banner needs to be the same height/alignment of the mic".
// TURN_ROW_H is the value that FALLS OUT of that alignment — it is why the
// maneuver banner got shorter ("if the mic is too close to the eta banner then
// narrow the height of the turn banner"). Content still fits: the maneuver box is
// 30 and the two text lines ~34, both under 42.
// Crew/alerts/build pill height — deliberately small; it is ambient info, not a control.
const CREW_PILL_H = 22;
// True top-centre for the pill (iOS 26 has no full-width nav bar to clear).
const CAR_PILL_TOP = 4;
// Jeff (2026-07-24, second pass): all three rows share ONE WIDTH — he may add a
// third button on the right, and a ragged stack would then need re-tuning. So the
// rows STRETCH to the stack width (navStack alignItems:'stretch') and the width
// itself is what shrinks (see the derived carClearLeft) — that is what removes the
// dead padding, not per-row sizing. Reverses the brief content-sizing experiment.
// Jeff (2026-07-24): "make sure the arrow banner is the same exact dimensions as
// the eta banner". The lane (arrow) row and the ETA row now share ONE height and
// one style recipe, so they read as siblings; both are CONTENT-sized (alignSelf
// flex-end) rather than stretched to the stack width, which kills the empty padding
// he saw beside "1:11pm · 3 min · 777 m" and pulls their left edge away from the car.
const NAV_PILL_H = 24;
const LANE_ROW_H = NAV_PILL_H;
const ETA_ROW_H = NAV_PILL_H;
// The turn banner keeps its own height — it carries the maneuver box plus two text
// lines, so it cannot shrink to the pill height without clipping.
const TURN_ROW_H = 42;
// Bottom-left speed cluster's own inset. 56 on CarPlay clears the leading map-button
// rail iOS draws over our window. Android Auto puts nothing there — androidx's chrome
// is the routing card, the travel estimate and the action strip, none of which is a
// leading rail — so on AA the cluster hugs the edge and gives the (much narrower,
// see logAaCanvas) canvas its 44pt back.
const CAR_DOCK_LEFT = IS_AA ? 12 : 56;
// Left edge the bottom nav stack must not cross: the speed cluster is speedDock
// (CAR_DOCK_LEFT) + the posted-limit badge, which SLIDES OUT 62pt and is itself 58
// wide -> 56 + 62 + 58 = 176 at full extension, +8pt of air. Derived, not literal,
// so the AA dock inset above can never drift out of sync with it.
const CAR_LEFT_INSET = CAR_DOCK_LEFT + 62 + 58 + 8;
// The speed cluster's own box, named so the tight-canvas reflow can stack a row
// directly on top of it (speedRowTopFit) and the weather chip can sit on it
// (weatherBottomFit) instead of re-deriving 10 + 48 by hand in three places. Both
// of those derive from the SCALED pill height — see hudScale.
const SPEED_DOCK_BOTTOM = 10;
const SPEED_PILL_H = 48;
// The canvas every constant in this file was measured against: a real 800x480
// CarPlay head-unit capture = 400x240pt. hudScale measures an Android Auto canvas
// against it. See the hudScale comment for why 250x143 is the number to beat.
const CAR_REF_W = 400;
const CAR_REF_H = 240;
// Floor. Below this the read-outs stop being glanceable at driving distance, and a
// chip that is too small to read is no better than one that overlaps. If a real head
// unit ever lands here the `android-auto-canvas` row will say so.
const HUD_SCALE_FLOOR = 0.5;
// The nav stack is anchored RIGHT (at CAR_RIGHT_INSET) and its width is measured,
// not fixed. A fixed 210 could not co-exist with the speed cluster on a narrow
// head unit: 184 + 210 + 76 overflows a ~431pt CarPlay canvas, which is exactly
// how the maneuver banner ended up underneath the speedo in the sim. Clamped so it
// stays readable on small screens and does not sprawl on ultra-wide ones.
// Wide enough that "11:42pm · 31 min · 3.4 km" fits UN-CUT (Jeff's spec: the ETA
// line must fit; grow toward the car rather than truncate). Long street names
// still marquee rather than widening further.
const NAV_STACK_MAX_W = 260;
// Absolute floor — readability past this point is already lost, and going lower
// would be worse than a narrow banner. Deliberately NOT a "preferred" width: see
// the clamp-downward comment at the navStackW computation.
// Half the on-screen width of the 3D car model at chase zoom (measured off head-unit
// captures). Used to keep the banner stack clear of the car — see carClearLeft.
const CAR_MODEL_HALF_W = 20;
const NAV_STACK_ABS_MIN_W = 120;
// Pre-measurement, first frame only. Was 210, which overlapped the speed cluster
// on a 400pt canvas for one frame; the floor is the safe guess.
const NAV_STACK_FALLBACK_W = NAV_STACK_ABS_MIN_W;

// Lane guidance has to fit the (now measured) stack width. A 5-lane cue at the old
// fixed size 26 overflowed a narrow head unit and the leftmost arrow was clipped —
// which on a real junction is the one you need. Shrink to fit, floor 16 so it stays
// legible at a glance; laneRow is paddingHorizontal 10 + gap 10 (see styles.laneRow).
function laneIconSize(count: number, stackW: number): number {
  if (count <= 0) return LANE_ROW_H - 6;
  const avail = stackW - 20 /* padding */ - (count - 1) * 10 /* gaps */;
  // Also capped by the row's own fixed height so a wide head unit can't grow the
  // icons past the band the row occupies.
  return Math.max(14, Math.min(LANE_ROW_H - 6, Math.floor(avail / count)));
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
  speedDock: { position: 'absolute', left: CAR_DOCK_LEFT, bottom: SPEED_DOCK_BOTTOM, alignItems: 'flex-start' },
  // 58×48 — narrower (just fits "299") + the SAME height as the banner/weather/limit chips.
  speedPill: { width: 58, height: SPEED_PILL_H, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  speedNum: { color: '#F4F4F4', fontSize: 21, fontWeight: '800', letterSpacing: -0.5, lineHeight: 23 },
  speedUnit: { color: '#808080', fontSize: 9, fontWeight: '600', letterSpacing: 0.3, marginTop: 1 },
  // Posted speed-limit sign — white plate, black border. Tucked BEHIND the speedo (same
  // bottom baseline, left:0 within speedDock) and slid out to the right when moving.
  speedLimitBadge: { position: 'absolute', left: 0, bottom: 0, width: 58, height: SPEED_PILL_H, borderRadius: 14, backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  speedLimitNum: { color: '#000', fontSize: 21, fontWeight: '800', letterSpacing: -0.5, lineHeight: 23 },
  speedLimitUnit: { color: '#333', fontSize: 9, fontWeight: '700', letterSpacing: 0.3, marginTop: 1 },
  // Compass — TOP-LEFT, docked directly UNDER the Scout mic button (moved off the
  // right edge 2026-07-20). CarPlay stacks its own round CPMapButtons down the
  // RIGHT side of the map and we cannot move them (CPMapButton has no position
  // API — its only properties are image/focusedImage/enabled/hidden), so the right
  // edge belongs to the system. Keeping our two round controls in one left-hand
  // column also reads as a deliberate pair instead of two orphans.
  // scoutMicBtn is top:10 h:52 -> its bottom edge is 62; +8pt gap = 70.
  // BACK above the speedo (2026-07-20) — its original home, and the phone's
  // weather-over-speed column. It only ever moved to the top-left to dodge the compass;
  // with the compass gone from CarPlay entirely there is nothing to dodge, and the
  // top-left is better left as MAP: nothing we draw there can ever be tapped (CarPlay
  // routes touches through the template only), so a readout parked in the most reachable
  // corner is wasted space. Rail is now just weather 130-178 + speed 182-230.
  weatherChip: { position: 'absolute', left: CAR_DOCK_LEFT, bottom: 62, width: 58, height: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(18,18,22,0.5)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  // top was 10 -> INSIDE the CPMapTemplate nav bar, i.e. the one signal that says
  // Scout is listening was hidden behind system chrome. Left-anchored at
  // CAR_LEFT_INSET rather than centred so it also clears the weather chip.
  // Two CENTRED rows in the top band. Full-width absolute rows with centred content
  // keep both pills optically centred at any head-unit width, instead of pinning them
  // to a hand-measured left offset that only holds on one canvas.
  // TRUE top-centre (2026-07-23, Jeff's head-unit photos): on iOS 26 the nav "bar"
  // is floating corner buttons (mic top-left, Search/End top-right) — the top
  // CENTRE of the canvas is open map, so the pill no longer needs to clear a
  // full-width bar. The status pill (Transmitting…/X is talking…/Scout) docks
  // directly beneath it. (On the iOS 18.6 sim the old full-width bar overlaps
  // this spot — the head unit is the target, the sim just looks off there.)
  topCenterRow: { position: 'absolute', top: CAR_PILL_TOP, left: 0, right: 0, alignItems: 'center' },
  statusRow: { position: 'absolute', top: CAR_PILL_TOP + CREW_PILL_H + NAV_GAP, left: 0, right: 0, alignItems: 'center' },
  crewPill: { flexDirection: 'row', alignItems: 'center', height: CREW_PILL_H, paddingHorizontal: 10, borderRadius: 9, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', overflow: 'hidden' },
  crewPillText: { color: '#C7CCD1', fontSize: 11, fontWeight: '700' },
  scoutPill: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, height: 34, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', overflow: 'hidden' },
  scoutDot: { width: 10, height: 10, borderRadius: 5 },
  scoutPillText: { color: '#F4F4F4', fontSize: 14, fontWeight: '700' },
  weatherText: { color: '#F4F4F4', fontSize: 13, fontWeight: '800', marginTop: 1 },
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
  // Single solid dark tint floor (GlassFill above is clear/untinted) at 0.5 — matches
  // the phone banner EXACTLY and is backdrop-independent, so no washout on the pale day
  // map. NO border (like the phone banner + other chips); shadow lifts it.
  topStrip: { position: 'absolute', top: 8, right: 8, maxWidth: 300, flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 8, backgroundColor: 'rgba(18,18,22,0.5)', borderRadius: 12, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
  maneuverBox: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#2DEC86', alignItems: 'center', justifyContent: 'center', marginRight: NAV_GAP },
  maneuverArrow: { color: '#0B0B0C', fontSize: 24, fontWeight: '900', lineHeight: 28, marginTop: -1 },
  topTextCol: { flex: 1, minWidth: 0 },
  topDist: { color: '#F4F4F4', fontSize: 17, fontWeight: '800' },
  topInst: { color: '#F4F4F4', fontSize: 12, fontWeight: '600', flexShrink: 1 },
  topChip: { position: 'absolute', top: 12, alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 6, backgroundColor: 'transparent', borderRadius: 14, overflow: 'hidden' },
  topChipText: { color: '#2DEC86', fontSize: 15, fontWeight: '800', letterSpacing: 1 },
  // ETA / arrival — tucked into the BOTTOM-RIGHT corner, small.
  bottomMeta: { position: 'absolute', right: CAR_RIGHT_INSET, bottom: 8, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: 'rgba(18,18,22,0.5)', borderRadius: 10, overflow: 'hidden' },
  bottomText: { color: '#C7CCD1', fontSize: 12, fontWeight: '600' },
  // --- BOTTOM-RIGHT nav stack (live map): ETA pill above the maneuver banner, same width ---
  // width is the shared "length" of both banners — OTA-tunable. alignItems:'stretch' makes
  // the ETA + maneuver banner fill it equally so they line up.
  // width is applied INLINE (navStackW) — it has to be measured, see CAR_LEFT_INSET.
  navStack: { position: 'absolute', right: CAR_RIGHT_INSET, bottom: NAV_STACK_BOTTOM, alignItems: 'stretch', gap: NAV_GAP },
  navBannerRow: { flexDirection: 'row', alignItems: 'center', height: TURN_ROW_H, paddingHorizontal: 8, borderRadius: 12, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
  navEta: { paddingHorizontal: 10, height: ETA_ROW_H, borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  // marginRight: the lane row is the ONLY stack element level with the map buttons
  // (the ETA and maneuver banner clear them vertically), so it carries the offset
  // instead of insetting the whole stack. Jeff's explicit requirement: the lane
  // guidance banner must never touch the buttons.
  laneRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: LANE_ROW_H, paddingHorizontal: 10, borderRadius: 10, overflow: 'hidden' },
});
