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
import { ManeuverArrow, maneuverDir, type ManeuverDir, ManeuverBox } from '../components/ManeuverArrow';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import { fmtPitstop } from '../pitstop';
import { MarqueeText } from '../components/MarqueeText';
import { ListeningEdgeGlow } from '../components/ListeningEdgeGlow';
import { LinearGradient } from 'expo-linear-gradient';
import { setCarState, setCarSelfPosition, setCarPeers, setCarHazards, claimCarNavStrip, getCarState, useCarStore, emitCarGesture, type CarPeer } from './carStore';
import CarMapView, { CAR_LEFT_PAD_FRAC, hudScaleFor, aaMapScaleFor } from './CarMapView';
import { GlassFill, hudTint } from '../Glass';
import { setCarPlayHookOwnsRoot, CAR_LIVE_MAP_ENABLED, CAR_DIAG_MODE } from './carPlayShared';
import { CAR_BAR_BUTTON_CONFIG, carMapButtonConfig, AA_ACTION_STRIP, aaMapButtons, handleCarBarButton, handleCarMapButton, handleAaButton, carTap, isDupCarPress } from './carActions';
import { formatSpeed, getSettings, getMapMode, getRouteColor, getSelfMarkerType } from '../settings';
import { speedLimitVisible } from '../speedLimit';
import type { RoadEvent } from '../driveBcEvents';
import { logEvent, logEventReliable } from '../crashBreadcrumb';
import { useAccent } from '../appSkin';

// CarPlay HUD floor — a solid dark tint ONLY on light basemaps (dawn / day / satellite),
// where clear glass over the bright map would wash out. On DARK basemaps (dusk / night)
// it's transparent, so the chips render as pure clear Liquid Glass — glassy, matching the
// phone HUD exactly (the phone chips use hudTint(), which is likewise clear on dark maps).
// Keeps dawn/day readable AND dusk/night glassy. Re-evaluated each render as the auto map
// mode advances with the clock.
function carHudFloor(): string {
  const mode = getMapMode(getSettings());
  const darkMap = mode === 'dusk' || mode === 'night';
  // 0.5 -> 0.32 (Jeff, 2026-07-30: "the banners are too dark, they need to be
  // lighter and a little more transparent"). This floor sits UNDER a GlassFill, so
  // the two opacities compound — on the day/light basemap in Say Phin's head-unit
  // photo the pair read as near-solid black slabs over the map. Dark basemaps keep
  // `transparent` and lean on the glass alone, as before.
  return darkMap ? 'transparent' : 'rgba(18,18,22,0.32)';
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
// ── CARPLAY GESTURE PROBE (2026-07-30) ───────────────────────────────────────
// Jeff, after a drive on build 70: "pinch to zoom did not work. and car play touch
// did not work either." The JS wiring is complete and correct end-to-end (verified:
// the native delegate posts didUpdateZoomGestureWithCenter, and MapTemplate.ts maps
// it to onDidUpdateZoomGesture, which is what we register). And CPMapTemplate.h says
// of these callbacks: "May not be called when connected to some CarPlay systems."
//
// So the open question is not our code, it is whether the CAR delivers the gesture at
// all — which no amount of code-reading settles. Log the first of each kind per
// process, exactly like logAaCanvas, and one drive answers it:
//   zoom* rows                          -> the car delivers pinch; a remaining bug is ours
//   no zoom* but carplay-tap rows exist -> the car talks to us and simply has no
//                                          multitouch (iOS 26 pinch is a HEAD-UNIT
//                                          capability) — a limit, not a defect
//   neither -> nothing is reaching JS at all; the native template layer is the suspect
// carplay-tap (carActions.carTap) is the CONTROL — it already logs every button press,
// and a drive with tap rows but no gesture rows isolates this to multitouch alone.
// (Deliberately NOT probing pan: MapTemplate's eventMap carries only the old
// panWithDirection button API, which needs the panning interface shown, so its silence
// would prove nothing.)
// Once per kind, so a 60Hz pinch cannot flood the table.
const carGestureLogged = new Set<string>();
function logCarGestureOnce(kind: string, detail?: number): void {
  if (carGestureLogged.has(kind)) return;
  carGestureLogged.add(kind);
  try {
    logEvent(`carplay-gesture:${kind}${typeof detail === 'number' ? ` scale=${detail.toFixed(3)}` : ''}`);
  } catch {}
}

// Distinct canvas sizes already reported this process. A Set, not a boolean, so a
// dual-screen switch gets its own row — see logAaCanvas.
const aaCanvasSeen = new Set<string>();
function logAaCanvas(w: number, h: number): void {
  // ── RE-LOG ON EVERY DISTINCT SIZE (2026-08-14) ────────────────────────────────
  // This was once-per-process, which is why we have canvas numbers for the normal AA
  // layout and NONE for dual-screen. Say Phin's video shows the car pushed right when he
  // switches to the split layout, and every remaining AA layout complaint — banners over
  // the crew/compass buttons, the version pill under Search — is unanswerable without
  // the real width in that mode.
  //
  // Now keyed on the SIZE, not a boolean: each distinct WxH logs exactly once, so a
  // layout switch produces one new row and a resize storm cannot flood the table (the
  // rule every breadcrumb in this codebase follows). A normal drive still emits exactly
  // one row, so nothing gets noisier for the sessions we already understand.
  if (!IS_AA) return;
  if (!(w > 0) || !(h > 0)) return;
  const sizeKey = `${Math.round(w)}x${Math.round(h)}`;
  if (aaCanvasSeen.has(sizeKey)) return;
  aaCanvasSeen.add(sizeKey);
  try {
    const win = Dimensions.get('window');
    const ratio = PixelRatio.get();
    // ⚠ READ px= AND pixelRatio= CORRECTLY (2026-08-15). Neither is a head-unit
    // measurement. pixelRatio is PixelRatio.get(), a process-global seeded from the app
    // context — i.e. THE PHONE's density — and px= is just dp x that. The 3.75 in the
    // 2026-07-30 row is Say Phin's Galaxy, not his Toyota; window=384x832dp @3.75 =
    // 1440x3120, which is a phone. The scale error is therefore per-tester, and 1.875
    // must never be baked into anything.
    //
    // ⚠⚠ mapScaleWant/mapPtWant are DERIVED FROM `w` ON THIS LINE. They are the value we
    // INTEND to hand the map, not an observation of what the map did — the same class of
    // instrument as update_id, and it must be read that way. This row is only reached
    // when w > 0 (the guard above), so mapScaleWant can read 1 ONLY on a head unit
    // already >= CAR_REF_W wide; it can NEVER report 'the prop failed to reach
    // CarMapView'. And mapPtWant is w/(w/CAR_REF_W) = CAR_REF_W identically unless
    // MAP_SCALE_FLOOR binds, so its one real signal is 'the floor bound'.
    // DO NOT use either field to decide whether the correction engaged. The only thing
    // that can answer that is CarMapView's own measured onLayout width — 213 =
    // uncorrected, ~400 = corrected — which is not visible from here. Until that is
    // logged from CarMapView, the verification is the photograph, not this row.
    const mapScale = aaMapScaleFor(w);
    logEvent(
      `android-auto-canvas surface=${Math.round(w)}x${Math.round(h)}dp `
      + `px=${Math.round(w * ratio)}x${Math.round(h * ratio)} `
      + `pixelRatio=${ratio} fontScale=${PixelRatio.getFontScale()} `
      + `window=${Math.round(win.width)}x${Math.round(win.height)}dp `
      + `mapScaleWant=${Math.round(mapScale * 1000) / 1000} `
      + `mapPtWant=${Math.round(w / mapScale)}x${Math.round(h / mapScale)}`,
    );
  } catch {}
}

// FALSE: do NOT drive CarPlay's NATIVE navigation session (no native maneuver banner,
// no native trip-estimate bar). The live CarMapView + our own overlays (topStrip TBT,
// bottomMeta ETA, speed-limit, compass) provide guidance, matching the phone — the
// native CarPlay UI duplicated and covered them. Flip TRUE to restore native guidance.
const CAR_NATIVE_GUIDANCE = false;

// Ceiling for the live-map remount retry (see scheduleLiveRetry). 6 attempts with the
// 1/2/4/8/8/8s backoff spans ~75s — longer than any legitimate head-unit boot, short
// enough that a genuinely broken context stops burning GPU and battery for the rest of
// the drive. Deliberately mirrors the native side's own bounded loop (0.4s tick, budget
// 120, 40s ceiling in withConvoyCarPlay.js) — the JS side just never had one.
const MAX_LIVE_ATTEMPTS = 6;

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

let _aaSurfaceCrumbed = false;
export function CarSurface() {
  // Cold-connect tracer stage 4 (see AndroidAutoRoot.aaCrumb): the car surface's
  // own React tree started rendering. AA only — CarPlay has the iOS receipt chain.
  if (IS_AA && !_aaSurfaceCrumbed) {
    _aaSurfaceCrumbed = true;
    try { logEventReliable('aa-crumb surface-render'); } catch {}
  }
  const s = useCarStore();
  const accent = useAccent();
  const spd = formatSpeed(s.speedMs || 0, s.speedUnit ?? getSettings().speedUnit);
  const nearby = s.peers.length;
  // Posted speed limit (PART 5), shown in the driver's unit. carStore.speedLimitKmh
  // is km/h; convert to mph if that's their setting. null → no badge.
  const limitVal = s.speedLimitKmh
    ? ((s.speedUnit ?? getSettings().speedUnit) === 'mph' ? Math.round(s.speedLimitKmh / 1.609344) : Math.round(s.speedLimitKmh))
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
  const gaveUpRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleLiveRetry = (why?: string) => {
    if (retryTimerRef.current) return; // one pending retry at a time
    // ── CEILING (2026-08-13) ────────────────────────────────────────────────────
    // This loop had no ceiling of any kind: no attempt cap, no elapsed-time cap, no
    // give-up. Telemetry caught one session at 223 retries over 80 minutes and another
    // spanning 8 hours. Each retry is a full map bootstrap — a destroyed and rebuilt
    // Metal view, the whole Standard style, sprites, glyphs, a fresh TileJSON, the GLB
    // models and every peer image — roughly 3.5 per minute, at 60fps because a CarPlay
    // phone is plugged in and therefore 'premium', in a hot car, for the whole drive,
    // with zero pixels to show for it. (Plus one Supabase insert per attempt.)
    //
    // The native side of this feature has always been bounded — withConvoyCarPlay.js
    // runs a 0.4s commit tick with a budget of 120 and a 40s ceiling. The JS side
    // simply never matched that discipline. 6 attempts ≈ 75s, which covers any
    // legitimate slow head-unit boot; past that we are not booting, we are thrashing.
    //
    // On give-up the LAST CarMapView stays mounted — we never fall back to a 2D map
    // (standing rule), and a live map still trying is strictly better than a dead one.
    if (liveAttemptRef.current >= MAX_LIVE_ATTEMPTS) {
      if (!gaveUpRef.current) {
        gaveUpRef.current = true;
        try { logEvent(`carplay-live-giveup after=${liveAttemptRef.current} why=${why || 'gl'}`); } catch {}
      }
      return;
    }
    const next = liveAttemptRef.current + 1;
    const delay = Math.min(1000 * 2 ** (next - 1), 8000);
    // LOG IT. This remount was completely silent, which cost a session: the car probe
    // logged the SAME congestion row several times over, and a remount resetting that
    // probe's dedupe ref was indistinguishable from a second CarMapView being mounted.
    // Those want different fixes. Now the retries say so themselves — and the absence of
    // these rows next to duplicate probe rows is itself the answer (it means a second
    // mount, not a remount). Cheap: at most one row per failure, backoff-limited.
    // `surf=` is here because a degenerate CarPlay window (the documented 70x264 sliver)
    // and a healthy window that never resolved a frame produce byte-identical rows
    // otherwise — and that ambiguity cost a whole session of guessing.
    try {
      logEvent(
        `carplay-live-retry attempt=${next} in=${delay}ms why=${why || 'gl'}` +
        ` surf=${Math.round(surfaceW)}x${Math.round(surfaceH)}`
      );
    } catch {}
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

  // Crew pill — CREW COUNT ONLY on the car surfaces (Jeff, 2026-08-15: "just say crew
  // with the amount of crew live... we can still have it on phones"). The build/runtime/
  // OTA-tag segments moved OFF the car pill; the PHONE pill (map.tsx:3204) remains the
  // place to read which binary and bundle a device runs — that identification job did
  // not go away, it just has exactly one home now. Crew is OTHER crew only, matching
  // the phone rule.
  const crewCount = (s.peers || []).length;

  // Measured CPWindow width -> bottom nav-stack width. See CAR_LEFT_INSET: the
  // stack has to fit BETWEEN the speed cluster and the system map buttons, and the
  // CarPlay canvas is far narrower than a phone (~431pt on the iOS 18.6 sim), so a
  // fixed width silently collides on the small end.
  const [surfaceW, setSurfaceW] = useState(0);
  // Has onLayout ever reported a real box? This is the ONLY thing stored — the
  // zero-width VERDICT is derived below, never held in state.
  //
  // ── WHY DERIVED, NOT STORED (2026-08-25 review, blocker) ───────────────────
  // The first cut kept `const [zeroWidth, setZeroWidth]` and recomputed it in
  // onLayout. That can strand a HEALTHY head unit on the boot dashboard, two ways:
  //   1. Two layout events in one React batch both read the same stale render-scope
  //      value, so the recovering one is dropped and `zeroWidth=true` commits
  //      alongside `surfaceW=470` — a contradiction nothing reconciles.
  //   2. Worse and needing no batching at all: if the LAST layout before things go
  //      quiet reports w<=0, the verdict sticks. `styles.surface` is `flex: 1`, so
  //      unmounting CarMapView cannot change THIS View's frame and cannot
  //      self-trigger a corrective onLayout. Nothing ever clears it.
  // Deriving from surfaceW closes both by construction: surfaceW is MONOTONIC
  // UPWARD (the `w > 0` guard below lets it go 0->470 but never 470->0), so once a
  // real width lands the surface can never be suppressed again.
  const zeroLoggedRef = useRef(0);
  const [measured, setMeasured] = useState(false);
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
  // ── HUD SCALE (2026-07-29) ──────────────────────────────────────────────────
  // NO LONGER AN ESTIMATE (2026-07-30). This started as arithmetic off a photograph
  // (~250x143dp); logAaCanvas has since reported the real thing from Say Phin's
  // Toyota — 213 x 107 dp — so every number below is now measured. See the block on
  // CAR_REF_W in CarMapView.tsx for the full row and what pixelRatio 3.75 implies.
  //
  // A head unit reports few dp for a physically large screen, so one dp there is
  // ~5x the physical size of a phone dp — which is why every chip in that photo
  // looks enormous. Widening/reflowing alone cannot fix it: three stacked rows at
  // full size (42 + 8 + 24 + gaps) are ~74dp of a 107dp canvas and would swallow
  // the map whole. So scale the HUD to the canvas it actually got, measured from the
  // 400x240 reference, and let every chip, font and gap shrink together.
  //
  // ANDROID AUTO ONLY. The CarPlay surface is verified good today and its own
  // height has never been measured here — scaling it on a guess would risk a known
  // -good surface to fix an unrelated one.
  const [surfaceH, setSurfaceH] = useState(0);
  // Shared with the MAP (CarMapView scales the 3D car by this exact value), so the
  // car and the chips can never drift out of proportion with each other.
  const hudScale = hudScaleFor(surfaceW, surfaceH);
  // The car model is now scaled by hudScale too, so its on-screen half-width shrinks
  // with it. Left at the flat CarPlay constant this reserved ~1.7x the room the car
  // actually occupies on a head unit, and every dp of that came straight off navAvail
  // — a narrower nav stack on the canvas that can least afford one.
  const carClearLeft = carX + CAR_MODEL_HALF_W * hudScale + NAV_GAP;
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
    ? (surfaceW - Math.max(effLeftInset, carClearLeft) - carRightInsetFor(surfaceW)) / hudScale
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
        : Math.min(
            NAV_STACK_MAX_W,
            navAvail,
            // AA WIDTH CAP (Jeff: "the banners are too wide on the right side").
            // navAvail is everything left over after the car and the speed cluster,
            // which on a wide head unit is most of the screen — so the stack grew to
            // fill it and swallowed the map. Cap it to a share of the canvas instead;
            // expressed in DESIGN units (÷ hudScale) because the width is applied
            // inside the scale transform. CarPlay is unaffected: its canvas is narrow
            // enough that navAvail is always the binding limit there.
            IS_AA && surfaceW > 0 ? (surfaceW * AA_NAV_STACK_MAX_FRAC) / hudScale : Infinity,
          ))
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
  // Same shared rule as the phone — see speedLimitVisible. Deliberately fed the
  // km/h speed and the km/h limit, NOT the display values: speedNum/limitVal are
  // already converted+rounded into the driver's unit, which is what made the two
  // surfaces disagree at low speed.
  const showLimit = speedLimitVisible((s.speedMs ?? 0) * 3.6, s.speedLimitKmh);
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
  // One row per surface that turns out to be degenerate. Bounded by the ref, and
  // logEventReliable because its ABSENCE is what tells us the suppression never fired.
  // Derived, so it cannot latch: any layout with a real width raises surfaceW, and
  // surfaceW never falls. A 470-wide surface therefore can NEVER be suppressed.
  // EXTENDED 2026-08-26: zero width was not the only ghost shape. Post-OTA telemetry
  // (Rodrigo, 08-27 02:21 UTC) shows a SECOND live GL instance passing this gate at
  // 244x852 — a PHONE-SHAPED portrait window that is not a head-unit canvas.
  // ⚠ NOT bare h>w (review, 2026-08-26): portrait car displays exist (some AA head
  // units), at car-like aspects ~1.2-1.7:1. The ghost is 3.49:1 — a phone shape no
  // car canvas has — so the gate keys on that: h > 2w kills the ghost with margin
  // and spares any plausible real portrait unit. Still fully derived: surfaceH
  // re-measures in both directions, so nothing latches.
  const zeroWidth = measured && (!(surfaceW > 0) || surfaceH > surfaceW * 2);

  useEffect(() => {
    // Per TRANSITION into the suppressed state, not once per process: a surface that
    // degenerates, recovers and degenerates again is a different (worse) story than one
    // that does it once, and a once-per-process bound cannot tell them apart. Hard cap
    // at 3 keeps the Supabase INSERT bounded either way.
    if (!zeroWidth || zeroLoggedRef.current >= 3) return;
    zeroLoggedRef.current += 1;
    try { logEventReliable(`car-surface-zerow w=${Math.round(surfaceW)} h=${Math.round(surfaceH)} n=${zeroLoggedRef.current} suppressed=1`); } catch {}
  }, [zeroWidth, surfaceW, surfaceH]);

  // `&& !zeroWidth`: a surface that has been MEASURED at zero width has no pixels to
  // draw into, so a live map there is pure cost — a second Metal view, the whole
  // Standard style, sprites, glyphs, TileJSON, the GLBs and every peer image, at 60fps
  // because the phone is plugged in and therefore 'premium'. This does NOT delay the
  // real surface: zeroWidth starts false and only flips once a layout pass has actually
  // reported a zero-width box, so a cold first render is untouched.
  const showLive = CAR_LIVE_MAP_ENABLED && hasFix && !zeroWidth;

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
            { width: navStackW, right: carRightInsetFor(surfaceW) },
            // Scaled about the bottom-right corner it is pinned to.
            hudFit('right bottom'),
            // Tight canvas: full width, lifted one row so it clears the speed cluster
            // entirely instead of growing over it.
            tightCanvas ? { right: CAR_DOCK_LEFT, bottom: speedRowTopFit } : null,
          ]}
          pointerEvents="none"
        >
          {/* The LANE ("arrow") ROW used to sit here, above the ETA. REMOVED 2026-08-13
              on Jeff's call: "lets completely remove the turn arrow banner from phone
              and carplay/aa. this banner is usually above the eta banner". It was the
              only element above the ETA pill and the only nav visual gated on distance
              (pickLaneCue returned null beyond 600 m), which is why it was absent from
              the 1.8 km photo he was pointing at. The maneuver box BELOW the ETA — the
              "1.8 km / Turn right onto…" box — is a different element and STAYS; he
              asked for its font to shrink in the same breath. */}
          {/* ── ONE NAV CARD (Jeff, 2026-08-18: "finally fix this" — off Say Phin's
              head-unit photo). The old layout was TWO separate elements: a tiny
              content-sized ETA pill (24pt × hudScale ≈ 13pt effective on the AA
              canvas — ~8pt text, unreadable at arm's length) floating above the turn
              banner with no shared width or edge. Now the turn row and the ETA line
              live INSIDE one card, split by a hairline: one width, one edge, and the
              ETA text at bottomText+1 reads at ~13pt effective on the head unit.
              Supersedes the 7/24 content-sized-pill decision — Jeff's call today.
              Total height ≈ 42 + ~21 = ~63 vs the old 24+8+42 = 74, so every
              clearance constant derived from the old stack still clears. */}
          <View style={[styles.navBannerRow, styles.navCard, { backgroundColor: carHudFloor() }]}>
            <GlassFill glassStyle="regular" tintColor={undefined} style={{ borderRadius: 12, overflow: 'hidden' }} />
            <View style={styles.navCardTurn}>
              <ManeuverBox size={30} radius={8} style={{ marginRight: NAV_GAP }}>
                <ManeuverArrow dir={(s.maneuverIcon as ManeuverDir) || 'straight'} size={24} color="#0B0B0C" />
              </ManeuverBox>
              <View style={styles.topTextCol}>
                <Text style={styles.topDist}>{s.distanceToTurn || '—'}</Text>
                <MarqueeText text={s.instruction || 'Continue'} style={styles.topInst} />
              </View>
            </View>
            {metaLine ? (
              <View style={styles.navCardEta}>
                {/* The divider IS the drive's progress (Jeff 8/18): the phone route
                    drawer's green line + caret tip, riding routeProgress from
                    whichever strip engine owns the numbers above it. */}
                <View style={styles.cardProgressTrack}>
                  <View style={[styles.cardProgressFill, { width: `${Math.round(Math.max(0, Math.min(1, s.routeProgress || 0)) * 100)}%`, backgroundColor: accent }]} />
                  <View style={[styles.cardProgressTip, { left: `${Math.round(Math.max(0, Math.min(1, s.routeProgress || 0)) * 100)}%` }]}>
                    <Ionicons name="caret-forward" size={11} color={accent} />
                  </View>
                </View>
                {/* Jeff's spec: eta/time/distance must FIT, not truncate to "27…". */}
                <Text
                  style={styles.etaLineText}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.7}
                >{metaLine}</Text>
              </View>
            ) : null}
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
        // ── A MEASURED ZERO IS NOT THE SAME AS "NOT MEASURED YET" (2026-08-25) ──
        // The `w > 0` guards below reject a zero, so surfaceW keeps its useState(0)
        // initial value — which makes a surface that has NEVER been laid out and one
        // that HAS been laid out at zero width byte-identical downstream. That is why
        // a degenerate surface still bootstrapped a whole live GL map: nothing could
        // tell it apart from a cold first render.
        // Field evidence (crash_reports, 2026-08-25): Jeff and Enablewhore each logged
        // TWO `car-viewport` rows in the same second from the SAME instance_id —
        // `surf=470x265` (the real head unit) and `surf=0x932` at zoom 1.50 spanning
        // latitude -86..+36, i.e. a world view on a zero-width canvas. Two full map
        // bootstraps, on a plugged-in phone, in a hot car, for zero visible pixels.
        if (typeof w === 'number' && typeof h === 'number' && (w > 0 || h > 0) && !measured) {
          setMeasured(true);
        }
        if (typeof w === 'number' && w > 0 && Math.abs(w - surfaceW) > 1) {
          setSurfaceW(w);
          // Chrome-inset receipt (2026-09-03): what right inset this canvas got, so a head-unit
          // photo can be checked against a number instead of a guess.
          // Once per distinct w×h per process — a head unit that oscillates between two measured
          // widths must not enqueue a durable row on every flip.
          try {
            const key = `${Math.round(w)}x${Math.round(e?.nativeEvent?.layout?.height ?? 0)}`;
            if (!_chromeLogged.has(key)) { _chromeLogged.add(key); logEventReliable(`car-chrome surf=${key} rightInset=${carRightInsetFor(w)}`); }
          } catch {}
        }
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
          {/* Distinct reasons on purpose: the boundary catches a RENDER THROW while
              onGLError is a GL LOAD failure, and the comment on CarMapBoundary says that
              difference is the whole point of having both. Passing the same bare callback
              threw it away. (Identity churn is a non-issue — scheduleLiveRetry is already
              redefined every render and has always been passed straight through.) */}
          <CarMapBoundary key={liveAttempt} onFail={() => scheduleLiveRetry('render-throw')}>
            {/* surfaceW/H are the head unit's REAL dp frame (this component's own
                onLayout, :713-718). The map cannot measure it for itself any more —
                since 2026-08-15 it lays itself out oversized and scales back, so its
                onLayout reports what we chose. See aaMapScaleFor in CarMapView. */}
            <CarMapView
              attempt={liveAttempt}
              surfaceW={surfaceW}
              surfaceH={surfaceH}
              onGLError={(w) => scheduleLiveRetry(w)}
            />
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
          {/* CANDY-APPLE over-limit (Jeff, 2026-08-16: "carplay/aa speeding is the same
              candy red gradient too") — the StepDrawer End recipe: bright→deep gradient
              with a red-tinted glass sheen refracting it. The flat #E4002B floor stays
              UNDERNEATH as the fallback: if LinearGradient ever fails to paint on a
              head unit (car-surface native views have form here — fitBounds silently
              no-oped), the pill degrades to today's solid red, never to transparent.
              One component serves CarPlay AND AA, so both get it. */}
          {/* ⚠ MITIGATION (2026-08-18): iOS-only for now — the other of the two Sunday
              changes touching the AA surface (see the bisect note above). AA keeps the
              flat #E4002B floor (visually near-identical). Restore after the crash
              bisect clears it. */}
          {Platform.OS === 'ios' && speedoOver && (
            <LinearGradient
              colors={["#FF3B5C", "#E4002B", "#B00020"]}
              locations={[0, 0.5, 1]}
              style={[StyleSheet.absoluteFill, { borderRadius: 12 }]}
            />
          )}
          {/* 16 -> 14 to match speedPill's radius. Harmless behind the old 1pt hairline;
              against the new 2pt black rule a 2pt-proud glass corner would show. */}
          <GlassFill glassStyle="regular" tintColor={speedoOver ? '#E4002B' : undefined} style={{ borderRadius: 14, overflow: 'hidden' }} />
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
          {/* radius 14 = the chip's own — a mismatched glass shape gets clipped and
              shows the diagonal edge-crease artifact (see GlassFill's radius note). */}
          <GlassFill glassStyle="regular" tintColor={undefined} style={{ borderRadius: 14, overflow: 'hidden' }} />
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
      {/* ⚠ MITIGATION (2026-08-18): the AA left-anchor + 'left top' transformOrigin is
          SUSPENDED. Say Phin's phone crash-loops at AA connect on every bundle since the
          Sunday design OTAs, dying before any instrument fires; the emulator cannot repro
          (stub AA, stale build), so this is a deliberate bisect: this line and the
          alignItems below are one of only two Sunday changes that execute on the AA
          surface at connect. AA pill temporarily back to CENTRED. If his connect works on
          this bundle, the crash lives here; re-land the left-anchor behind a verified-safe
          form afterwards. Do NOT restore without a passing head-unit test. */}
      <View style={[styles.topCenterRow, hudFit(IS_AA ? 'left top' : 'center top')]} pointerEvents="none">
        <View style={[styles.crewPill, { backgroundColor: carHudFloor() }]}>
          <GlassFill glassStyle="regular" tintColor={undefined} style={{ borderRadius: 9, overflow: 'hidden' }} />
          {/* RED until location is set to Always (Jeff, 2026-07-30). This is the one
              setting that decides whether the car marker keeps tracking with the
              phone locked in a mount, and when it is wrong the symptom looks like
              our bug — so it gets a permanent, glanceable tell right where the
              driver already reads the build number. Back to white the moment the
              permission is granted (re-read on every foreground). */}
          <Text style={[styles.crewPillText, !s.alwaysLocation && styles.crewPillTextWarn]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
            {crewCount} Crew
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
            {/* Candy-apple red (#E4002B) — the one red across phone/CarPlay/AA (Jeff, 2026-08-16). */}
            <View style={[styles.scoutDot, { backgroundColor: s.commsTx === 'recording' ? '#E4002B' : '#8E8E93' }]} />
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
      // Appearance, so a COLD connect draws each peer's real car too. Without this the
      // head unit would show everyone in the default paint the moment the phone screen
      // backgrounds and this fallback feed takes over — a visible, confusing flip.
      marker: (p?.marker === 'class' || p?.marker === 'arrow') ? p.marker as 'class' | 'arrow' : undefined,
      cls: typeof p?.cls === 'string' ? p.cls : undefined,
      color: p?.activeColor || p?.carColor || undefined,
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
    // Claim the TBT strip as the top-rank 'phone' source, but only while the phone
    // engine is actually guiding. When tbt is idle we neither claim nor write it: a
    // route started from CarPlay search is driven by the COLD engine, and ticking ''
    // over its numbers is what blanked the ETA row on Jeff's 7/23 drive. Not claiming
    // also leaves ownership untouched, so a car-started drive keeps the strip exactly
    // as it does today.
    const ownStrip = tbt.active && claimCarNavStrip('phone');
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
      // The TBT strip — gated on `ownStrip` (was: plain `tbt.active`) so the cold
      // engine can't leave a step-derived ETA sitting on the head unit while the phone
      // shows a segment-derived one. See the gate header in carStore.ts (Olaf, 8/13:
      // phone "11 min" vs CarPlay "43 min · 27 km" at the same instant).
      ...(ownStrip ? {
        navigating: true,
        instruction: upcomingInstruction(route, tbt.stepIndex),
        distanceToTurn: fmtDistanceM(tbt.distanceToManeuverM),
        eta: fmtEtaSec(tbt.etaSeconds),
        distanceRemaining: fmtDistanceM(tbt.distanceRemainingM),
        // MANEUVER GLYPH — MOVED INSIDE THE OWNERSHIP GATE (2026-08-15).
        // It used to be written ungated at the bottom of this same object as
        // `tbt.active ? maneuverDir(…) : undefined`. On a CAR-STARTED route the phone's
        // tbt is idle, so this mirror wrote `undefined` over the COLD engine's arrow
        // (navNotification.ts:441) on every one of its ticks — while the cold engine's
        // WORDS stayed on screen, because those were already gated. ManeuverArrow
        // coerces undefined to 'straight' (this file, ~line 678), so the driver got a
        // straight-ahead arrow flickering beside "Turn left onto…" at roughly 1 Hz.
        // Words, numbers and glyph now come from ONE owner — the whole point of
        // claimCarNavStrip (carStore.ts, Olaf 8/13).
        // ⚠ Inside the gate nothing writes `undefined` when the phone engine goes idle,
        // so CLEARING is now stopNavBanner's job — see the PAIRED edit in
        // src/navNotification.ts. Without it a dead arrow survives the whole drive.
        maneuverIcon: maneuverDir(upcomingInstruction(route, tbt.stepIndex), upcomingManeuverKey(route, tbt.stepIndex)),
      } : {}),
      // NOTE: peers + hazards are NOT written here anymore — they go through the
      // gated setCarPeers/setCarHazards writes in the effect below, so the cold
      // carDataService and this warm mirror can share ownership without clobbering.
      // Raw numerics for the Android Auto NavigationTemplate (AndroidAutoRoot) —
      // same owner as the strings above, so the two can never come from different engines.
      ...(ownStrip ? {
        distanceToTurnM: tbt.distanceToManeuverM,
        stepLengthM: route?.steps?.[tbt.stepIndex]?.distance_m,
        distanceRemainingM: tbt.distanceRemainingM,
        etaSeconds: tbt.etaSeconds,
        routeProgress: route && route.distance_m > 0
          ? Math.max(0, Math.min(1, 1 - tbt.distanceRemainingM / route.distance_m)) : 0,
      } : {}),
      // Route polyline (preview or nav) for the car map ribbon. NOTE: position
      // (selfLat/selfLng/heading) is mirrored in a SEPARATE additive effect below —
      // it must NEVER be written here, because this metadata effect re-runs on ticks
      // where `user` is null (peers/route changes), and a null position would clobber
      // a good fix landed by the cold/foreground feed -> hasFix false -> CONVOY logo.
      // ROUTE RIBBON — GATED ON ACTUALLY HAVING A ROUTE (2026-08-15).
      // These three were written unconditionally, so on a CAR-STARTED route
      // (CarPlay/AA search → carActions.startCarNav, which writes the ribbon itself at
      // carActions.ts:270-277) this mirror ticked '' / undefined straight over it for the
      // ENTIRE window before the phone adopts the route and `activeRoute` becomes
      // non-null — the head unit lost its green ribbon for that whole stretch. Android
      // Auto is where this bites hardest: car-started routes are the dominant case there.
      //
      // ⚠ THE CLEAR STILL HAS TO HAPPEN. `route` also goes null on a PREVIEW-ONLY Clear
      // (map.tsx clearRoute → setRoute(null), and the onClear at map.tsx:3945) where nav
      // never started — so stopNavBanner and carActions.endCarNav, the two owners of the
      // clear, never run and nothing else would wipe the preview ribbon off the car.
      // Hence the second spread: no route AND nothing navigating ⇒ clear explicitly; no
      // route WHILE navigating ⇒ leave the cold engine's ribbon alone. The two spreads
      // are mutually exclusive by construction.
      ...(route ? {
        routePolyline: route.polyline || '',
        // Selected route's geometry + per-segment congestion → lets the CarPlay map paint
        // the live traffic gradient (same as the phone). Mirrored in preview AND nav.
        routeCoordinates: (route as any).coordinates || undefined,
        routeCongestion: (route as any).congestion || undefined,
      } : {}),
      ...((!route && !getCarState().navigating)
        ? { routePolyline: '', routeCoordinates: undefined, routeCongestion: undefined }
        : {}),
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
      // cleared layer wipes the car too. hazards / speedCameras / roadEvents / places
      // are ALL written by the signature-gated effects below now, never from here.
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
      // (maneuverIcon MOVED 2026-08-15 — it is now written inside the `ownStrip` spread
      //  above, with the instruction text it belongs to. Written here it landed on every
      //  tick regardless of ownership and erased the cold engine's arrow.)
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
  // HEAT (2026-08-14): map.tsx passes `hazards.filter(isHazardVisible)` — a NEW array
  // identity on every phone render — so this effect fired, and setCarHazards notified
  // every car-surface listener, at the phone's render rate. Signature-gate it (same
  // pattern as the crew push in map.tsx): write only when the CONTENT changes.
  const hazardsSigRef = useRef('');
  useEffect(() => {
    const sig = (hazards || [])
      .map((h: any) => `${h.id}:${h.confirms ?? 0}:${h.disputes ?? 0}`)
      .join('|');
    if (sig === hazardsSigRef.current) return;
    hazardsSigRef.current = sig;
    setCarHazards(hazards || [], 'phone');
  }, [hazards]);
  // SAME DEFECT, THREE MORE ARRAYS (2026-08-15). speedCameras / roadEvents / places
  // used to ride the big metadata effect above, so a new array identity on a phone
  // render re-ran a 25-field setCarState and re-rendered BOTH car trees. Verified
  // per-render identities, not hypothetical:
  //   • roadEvents — map.tsx:779 builds it in an IIFE that runs on EVERY render, so its
  //     identity ALWAYS churns (this is the live one);
  //   • places — map.tsx:2115 passes a fresh `[]` literal whenever showPlacePins is off;
  //   • speedCameras — map.tsx:763 is useState-backed and identity-stable TODAY, but it
  //     is one `.filter()` away from behaving like roadEvents, so it is gated with them
  //     rather than left as the one unguarded path back to phone render rate.
  // carStore's equality gate compares arrays by IDENTITY (see its header), so it cannot
  // absorb these on its own — the content signature is what stops the churn. ONE shared
  // ref and ONE write on purpose: a change in any of the three costs a single store
  // notification instead of three.
  const markersSigRef = useRef('');
  useEffect(() => {
    const sig =
      (speedCameras || []).map((c) => `${c.id}:${c.lat}:${c.lng}`).join('|')
      + '#' + (roadEvents || []).map((e) => `${e.id}:${e.kind}:${e.severity}:${e.lat}:${e.lng}`).join('|')
      + '#' + (places || []).map((p) => `${p.id}:${p.lat}:${p.lng}:${p.label ?? ''}`).join('|');
    if (sig === markersSigRef.current) return;
    markersSigRef.current = sig;
    setCarState({
      speedCameras: speedCameras || [],
      roadEvents: roadEvents || [],
      places: places || [],
    });
  }, [speedCameras, roadEvents, places]);

  // ---- position mirror: ADDITIVE ONLY ----
  // Writes selfLat/selfLng/heading ONLY when the phone has a real fix. carStore is a
  // shallow merge, so this can never null out a fix that the cold/foreground location
  // feed (navNotification) already landed — which is what was bouncing the warm car
  // surface back to the CONVOY logo. speedMs stays in the metadata effect above.
  // REMOVED 8/20: the React-state mirror. map.tsx now writes 'mirror' DIRECTLY from
  // its GPS callback (same tick as the phone marker, stamped with the fix's own
  // timestamp). This effect was the measured 2-6 s middleman — user.lat propagated
  // through React state and re-render before reaching the store, and its writes
  // carried no fix time, so at every feed handoff the car surface could jump
  // seconds backwards down the road. fgwatch/bgtask remain the background feeds.

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
            // ── PLATFORM-SHAPED BUTTONS (2026-07-30) ─────────────────────
            // These keys are NOT interchangeable. iOS reads the two
            // NavigationBarButtons arrays and `mapButtons` (with an `image`);
            // androidx reads `actions` and `mapButtons` (with an `icon`). Sending
            // the iOS shape to Android gave AA no buttons at all — and an Action
            // with neither title nor icon is fatal to an androidx screen, so the
            // wrong shape is worse than none. See carActions.AA_ACTION_STRIP.
            ...(IS_AA
              ? { actions: AA_ACTION_STRIP, mapButtons: aaMapButtons() }
              : {
                  leadingNavigationBarButtons: CAR_BAR_BUTTON_CONFIG.leadingNavigationBarButtons,
                  trailingNavigationBarButtons: CAR_BAR_BUTTON_CONFIG.trailingNavigationBarButtons,
                }),
            // Android Auto press. parseAction emits EventEmitter.buttonPressed(id);
            // the JS eventMap entry that receives it is part of the carplay patch.
            onButtonPressed: (e: { buttonId: string }) => {
              const id = e?.buttonId;
              carTap(id || 'aa-unknown');
              if (id === 'car-end') { onEndRef.current?.(); return; }
              if (id === 'car-mic' || id === 'car-comms') { onScoutMicRef.current?.(); return; }
              handleAaButton(id);
            },
            onBarButtonPressed: (e: { id: string }) => {
              // WARM End must end the PHONE's navigation too (Jeff's head-unit
              // report: ending on CarPlay left the phone navigating, and the
              // mirror immediately re-populated the car route — End looked dead).
              // onEndRef reaches map.tsx's endNav; everything else falls through
              // to the shared handler so cold behaviour is identical.
              // isDupCarPress: these intercepts return BEFORE the deduped funnels, and END was
              // one of the field-doubled ids — share the same stamp (review, 2026-08-26).
              if (e?.id === 'car-end') { if (isDupCarPress('car-end', 'warm')) return; carTap('car-end'); onEndRef.current?.(); return; }
              handleCarBarButton(e?.id, 'warm');
            },
            onDidCancelNavigation: () => onEndRef.current?.(),
            // Round CPMapButtons — POLICE + SCOUT MIC in OUR OWN artwork, from the
            // SHARED config so the warm and cold roots can never drift apart again
            // (they previously declared different sets with different ids, which is
            // exactly how "one button works and the others don't" kept happening).
            // ⚠ LAYOUT MOVED AGAIN 2026-08-15 (Jeff): zoom ± now lives in the TOP-LEFT
            // nav bar; the map-button column is comms mic, 2D/3D, crew, compass. Read
            // CAR_MAP_BUTTON_CONFIG / CAR_BAR_BUTTON_CONFIG in carActions.ts, not any
            // comment here — a stale comment on this exact line once sent a debugging
            // session hunting a removal that had already been reverted.
            ...(IS_AA ? {} : { mapButtons: carMapButtonConfig().mapButtons }),
            onMapButtonPressed: (e: { id: string }) => {
              // Warm root: prefer the live ref (reaches the mounted surface); anything
              // else falls through so cold-root behaviour stays identical. (Police was
              // removed from CarPlay at Jeff's request, 2026-07-20.)
              if (e?.id === 'car-mic') { if (isDupCarPress('car-mic', 'warm')) return; carTap('car-mic'); onScoutMicRef.current?.(); return; }
              handleCarMapButton(e?.id, 'warm');
            },
            // iOS-26 raw pinch/zoom on the CarPlay map (react-native-carplay patch +
            // CPMapTemplate.h gesture delegate). Forwarded to CarMapView via the
            // gesture bus, which biases the lockstep follow-zoom. Apple gates raw
            // touch on some head units, so these may not fire on every car — the
            // native map buttons remain the guaranteed-touchable fallback.
            onDidBeginZoomGesture: () => { logCarGestureOnce('zoomBegin'); emitCarGesture({ kind: 'zoomBegin' }); },
            onDidUpdateZoomGesture: (e: { scale: number; velocity: number }) => {
              // Log velocity too, and log the two tap gestures under their OWN keys. The
              // old probe recorded only `scale`, which is the constant 1.0 for both tap
              // handlers — so two very different gestures were indistinguishable in
              // telemetry and read as "pinch sort of fired". Apple's host sends
              // velocity -1 for a two-finger tap (zoom out) and +1 for a one-finger
              // double tap (zoom in), with no begin; a real pinch always sends begin.
              const v = e?.velocity ?? 0;
              const tap = Math.abs((e?.scale ?? 1) - 1) < 1e-4 && Math.abs(Math.abs(v) - 1) < 1e-4;
              logCarGestureOnce(tap ? (v >= 0 ? 'tapZoomIn' : 'tapZoomOut') : 'zoomUpdate', e?.scale);
              emitCarGesture({ kind: 'zoom', scale: e.scale, velocity: e.velocity });
            },
            onDidEndZoomGesture: (e: { velocity: number }) => {
              logCarGestureOnce('zoomEnd');
              emitCarGesture({ kind: 'zoomEnd', velocity: e.velocity });
            },
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
// 12 -> 6 (2026-07-30, Jeff: "push everything over to the edges"). androidx keeps its
// own chrome outside the stable area it hands us, so every dp we hold back here is
// dead margin on the tightest canvas we ship to.
// AA 6 -> 50 (2026-08-14, Say Phin's video): androidx draws its OWN vertical
// MapActionStrip (zoom/crew/compass) down the RIGHT edge of the canvas, ON TOP of our
// surface — and our nav stack, hugging right at 6, rendered underneath its lower
// buttons (Jeff's "banners are overlapping the crew and compass"). 50 clears the
// measured strip (~18-22dp of visual chrome) under either scaling interpretation of
// hudFit. Video-measured with perspective error; the android-auto-canvas telemetry now
// re-logs per size, so the next drive verifies the number.
// AA 50 -> 40 (same 8/18 ask): closes the dead air between the card and the
// androidx button rail. CarPlay stays 48 — its rail is iOS's own map buttons and 48
// is the measured clearance ([CARPLAY.md]).
// AA 40 -> 28 (Jeff 8/19, off Say Phin's video: the banner/ETA "shrunk from the
// right side" — the destination line was truncating with an ellipsis and the ETA
// row was squeezed, while a wide dead band sat between the card and the host's
// right-hand zoom rail). This inset is BOTH the card's right anchor and part of
// the available-width sum, so pulling it in moves the card right AND widens it.
// 28 keeps roughly the rail's own width in clearance. OTA-tunable: if a head-unit
// photo ever shows the card touching the +/- buttons, put it back toward 40.
const CAR_RIGHT_INSET = IS_AA ? 28 : 48;
// ── WIDE HEAD UNITS (Alfred's Toyota Sienna, photo 2026-09-02 17:20, canvas 775×291) ──
// The 48 above was measured on a 470-wide CarPlay canvas. On the Sienna's 775-wide screen
// iOS draws a larger glass map-button column, and the maneuver banner's right end ran
// UNDER the crew and compass buttons (Jeff: "the turn-by-turn banner is stuck under the
// crew/compass"). The real answer is CPWindow.mapButtonSafeAreaLayoutGuide (native, build
// 77); until then the inset grows with the canvas width relative to the 470 reference —
// unchanged for every unit we have measured (400/427/470 → 48), 79 pt on the Sienna.
// Receipt: `car-chrome surf= rightInset=` when the surface lands.
export const CAR_REF_CARPLAY_W = 470;
// Capped at 2× (96 pt): a width-only model is a stopgap from ONE photo (Codex's review point,
// 2026-09-03), so an absurd canvas width must not eat the map; the receipt + the next head-unit
// photo are what validate the number, and the native layout guide replaces it in build 77.
const CAR_RIGHT_INSET_MAX = CAR_RIGHT_INSET * 2;
export function carRightInsetFor(surfaceW: number): number {
  if (IS_AA) return CAR_RIGHT_INSET;
  const scaled = CAR_RIGHT_INSET * Math.max(1, (surfaceW > 0 ? surfaceW : CAR_REF_CARPLAY_W) / CAR_REF_CARPLAY_W);
  return Math.round(Math.min(CAR_RIGHT_INSET_MAX, scaled));
}
const _chromeLogged = new Set<string>();
const NAV_STACK_BOTTOM = IS_AA ? 4 : 8;

// ── ONE SPACING RHYTHM (2026-07-20) ──────────────────────────────────────────
// Measured off a real 800x480 CarPlay capture (= 400x240pt @2x) by decoding the
// PNG and finding the glyph rows/columns, NOT by eyeballing:
//   police glyph rows 179-231  -> 26pt tall, centre 102.5pt from the top
//   mic    glyph rows 247-301  -> 27pt tall, centre 137pt   from the top
//   police <-> mic gap ......... 8pt
//   leftmost glyph edge ........ x=366pt, i.e. 34pt in from the trailing edge
// So 8pt is the system's own rhythm, and everything we draw matches it.
const NAV_GAP = 8;

// EXPLICIT row heights. These were paddingVertical-derived, which made the stack's
// total height depend on RN's font line-height and therefore impossible to align
// against a fixed system button. Fixed heights make the arithmetic exact:
// ⚠ HISTORICAL — the alignment this was derived from no longer renders. The lane
// ("arrow") row was removed 2026-08-13 (Jeff), so the stack is now TURN + ETA only and
// nothing is aligned to the mic any more. Kept because TURN_ROW_H's VALUE still comes
// from that arithmetic and changing it blind would move the maneuver banner:
//   lane centre from bottom = 8 + TURN + 8 + ETA + 8 + LANE/2
//                           = 8 + 42  + 8 + 22  + 8 + 15   = 103pt   (as-built)
//   mic centre from bottom  = 240 - 137                    = 103pt
// per Jeff's "the arrow banner needs to be the same height/alignment of the mic" and
// "if the mic is too close to the eta banner then narrow the height of the turn banner".
// Content still fits: the maneuver box is 30 and the two text lines ~34, both under 42.
// ⚠ TURN_ROW_H is DUPLICATED as CAR_BANNER_GAP_SCALABLE in CarMapView.tsx — keep in sync.
// Crew/alerts/build pill height — deliberately small; it is ambient info, not a control.
const CREW_PILL_H = 22;
// True top-centre for the pill (iOS 26 has no full-width nav bar to clear).
const CAR_PILL_TOP = 4;
// ── NAV-BAR SIDE WIDTHS — MEASURED off a head unit (2026-07-30) ──────────────
// What each side of the CarPlay navigation bar occupies, so the crew pill centres in
// the gap between the buttons rather than on the screen.
//
// First pass DERIVED these from standard bar metrics (60 / 130) and Jeff's photo
// showed the pill still left of the gap. So they are now measured off that photo
// instead, against a 431pt canvas:
//
//   mic button      spans  51 ..  97pt   -> leading side occupied to 97
//   crew pill       spans 102 .. 280pt   (centre 191 — the reported error)
//   "Search" starts at    312pt          -> trailing side occupied from 312
//   "End" ends at         428pt          (~431 canvas: the check that the frame is right)
//   ideal gap centre = (97 + 312) / 2   =  205pt
//
// ⚠ THE FRAME THAT MAKES THIS WORK. Our RN surface spans the FULL CarPlay window,
// including the strip under Apple's app dock — it is not inset to the right of it.
// Confirmed against a constant we already trust: the weather chip renders at
// CAR_DOCK_LEFT (56pt) from the surface's left edge, and it only lands where the
// photo shows it if x=0 is the window edge, not the dock edge. Measure from the wrong
// origin and every number above is ~45pt out. (This is also why CAR_DOCK_LEFT is 56
// on CarPlay and 6 on Android Auto — it is clearing that dock.)
//
// Perspective in a dashboard photo costs a few points of accuracy, so these carry a
// small margin rather than being pinned to the raw reading. Both are OTA-tunable.
// Android Auto draws no bar over our surface and keeps the full width.
// AA 0/0 -> 8/92 (2026-08-14, Say Phin's video): the zeros assumed Android Auto has no
// top chrome — it does, it just draws it ON TOP of our surface: mic + Search + End float
// top-RIGHT (measured starting ~128dp of 213). With no trailing inset our centred pill
// ran underneath them (Jeff's "the v72 pill on top is under the search"). 92 keeps the
// pill's box clear of that cluster whether or not the row's hudFit scale applies to the
// text; the leading 8 stops it kissing the left bezel. CarPlay values untouched.
// 104 → 158 (2026-08-15): 104 was measured off the photo era with ONE leading bar
// button (mic spans 51..97 → 97 + 7pt margin). The leading side has held TWO image
// buttons since 08-14 (then mic+view, now zoom −/+), so the pill has been centring
// against a stale single-button inset — visibly left of the true gap. Derived, not
// photo-measured: second button assumed same 46pt footprint after an ~8pt gap
// (51..97, 105..151 → 151 + 7 margin ≈ 158). Jeff's ask: "center the new pill between
// the search and zoom button exactly centered." OTA-tunable — if his next photo shows
// it off, adjust HERE, one number.
const CAR_BAR_LEADING_W = IS_AA ? 8 : 158;
const CAR_BAR_TRAILING_W = IS_AA ? 92 : 126;
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
const ETA_ROW_H = NAV_PILL_H;
// The turn banner keeps its own height — it carries the maneuver box plus two text
// lines, so it cannot shrink to the pill height without clipping.
const TURN_ROW_H = 42;
// Bottom-left speed cluster's own inset. 56 on CarPlay clears the leading map-button
// rail iOS draws over our window. Android Auto puts nothing there — androidx's chrome
// is the routing card, the travel estimate and the action strip, none of which is a
// leading rail — so on AA the cluster hugs the edge and gives the (much narrower,
// see logAaCanvas) canvas its 44pt back.
const CAR_DOCK_LEFT = IS_AA ? 6 : 56;
// Left edge the bottom nav stack must not cross: the speed cluster is speedDock
// (CAR_DOCK_LEFT) + the posted-limit badge, which SLIDES OUT 62pt and is itself 58
// wide -> 56 + 62 + 58 = 176 at full extension, +8pt of air. Derived, not literal,
// so the AA dock inset above can never drift out of sync with it.
const CAR_LEFT_INSET = CAR_DOCK_LEFT + 62 + 58 + 8;
// The speed cluster's own box, named so the tight-canvas reflow can stack a row
// directly on top of it (speedRowTopFit) and the weather chip can sit on it
// (weatherBottomFit) instead of re-deriving 10 + 48 by hand in three places. Both
// of those derive from the SCALED pill height — see hudScale.
const SPEED_DOCK_BOTTOM = IS_AA ? 6 : 10;
const SPEED_PILL_H = 48;
// The reference canvas (400x240pt), the scale floor and hudScaleFor itself now live
// in CarMapView.tsx — the MAP needs the same number to size the 3D car, and this file
// already imports that module, so exporting from there is the only cycle-free home.
// The nav stack is anchored RIGHT (at CAR_RIGHT_INSET) and its width is measured,
// not fixed. A fixed 210 could not co-exist with the speed cluster on a narrow
// head unit: 184 + 210 + 76 overflows a ~431pt CarPlay canvas, which is exactly
// how the maneuver banner ended up underneath the speedo in the sim. Clamped so it
// stays readable on small screens and does not sprawl on ultra-wide ones.
// Wide enough that "11:42pm · 31 min · 3.4 km" fits UN-CUT (Jeff's spec: the ETA
// line must fit; grow toward the car rather than truncate). Long street names
// still marquee rather than widening further.
const NAV_STACK_MAX_W = 260;
// Largest share of the Android Auto canvas the right-hand nav stack may occupy.
// OTA-tunable; lower it if the stack still crowds the map on a wide head unit.
// 0.42 -> 0.60 (Jeff 8/18, off Say Phin's photo: "it needs to be wider towards the
// compass and crew") — the card now reaches toward the right rail; the inset below
// still keeps it clear of the buttons themselves.
// 0.60 -> 0.70 (8/19). With the inset pulled in, the width sum (navAvail) is what
// binds on a 213dp canvas, not this cap — raising it just stops the cap becoming
// the new limiter and re-truncating the destination line.
const AA_NAV_STACK_MAX_FRAC = 0.70;
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
  // Border matches speedLimitBadge below EXACTLY (borderWidth 2 / '#000000' / radius 14)
  // — Jeff, 8/13: "make the speed button on carplay the same border as the speed limit".
  // It was a 1pt 14%-white hairline, effectively invisible next to the limit sign's heavy
  // black rule. Width/height/radius already matched; only the two border tokens moved.
  // Borderless 8/20 (glass-edge rule, see navCard). The SIGN below keeps its ring.
  speedPill: { width: 58, height: SPEED_PILL_H, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  speedNum: { color: '#F4F4F4', fontSize: 21, fontWeight: '800', letterSpacing: -0.5, lineHeight: 23 },
  // WHITE, not gray (Jeff, 2026-08-15: "the speedo km/h needs to be white").
  speedUnit: { color: '#FFFFFF', fontSize: 9, fontWeight: '600', letterSpacing: 0.3, marginTop: 1 },
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
  // Borderless + NO baked-in fill (8/20): the hardcoded rgba(...,0.5) wash kept
  // this chip slab-dark on night maps where every other chip goes fully clear —
  // it now takes carHudFloor() inline like the rest, so the regular glass shows.
  weatherChip: { position: 'absolute', left: CAR_DOCK_LEFT, bottom: 62, width: 58, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 14, overflow: 'hidden' },
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
  // Centred in the GAP BETWEEN THE BAR BUTTONS, not on the screen (Jeff, 2026-07-30:
  // "center the crew pill between the comms mic (left) and the search button
  // (right)"). The nav bar is lopsided — one image button leading, TWO text buttons
  // trailing — so screen-centre sits well right of the visual gap's centre. Insetting
  // both sides by what each actually occupies centres the pill in the space that is
  // free, and as a bonus makes it structurally impossible for the pill to slide under
  // either button however long the text gets.
  // AA: LEFT-anchored, not centred (Jeff, 2026-08-15: "for aa move the crew to the top
  // left side"). AA's system chrome floats top-RIGHT (from ~128dp of 213), so top-left
  // is the free corner there; CarPlay keeps gap-centred between the zoom pair and Search.
  // RE-LANDED 8/18 evening (Jeff's ask, and the suspects are EXONERATED: the 6:29
  // cold-connect crash reproduced with BOTH suspended — the crash exists without
  // them). The aa-crumb tracer is live; if this is ever implicated the crumbs will
  // name it instead of a bisect.
  // AA anchors the crew pill to the SAME left rail as the weather/speedo dock
  // (Jeff 8/19, off Say Phin's video: "move the crew pill more left so its inline
  // with the weather and speedo"). It used to start at CAR_BAR_LEADING_W (8) plus
  // the pill's own 12pt margin = 20, i.e. 14 units right of the dock's
  // CAR_DOCK_LEFT (6), which read as a stagger against the left column. CarPlay is
  // untouched — it centres this row between the bar buttons.
  topCenterRow: { position: 'absolute', top: CAR_PILL_TOP, left: IS_AA ? CAR_DOCK_LEFT : CAR_BAR_LEADING_W, right: CAR_BAR_TRAILING_W, alignItems: IS_AA ? 'flex-start' : 'center' },
  statusRow: { position: 'absolute', top: CAR_PILL_TOP + CREW_PILL_H + NAV_GAP, left: 0, right: 0, alignItems: 'center' },
  // marginHorizontal is the STRUCTURAL half of the fix: the parent topCenterRow is
  // alignItems:'center', so Yoga subtracts these margins from the pill's available width.
  // That both caps the pill and guarantees 12pt of clear air to the mic on the left and
  // Search/End on the right ON TOP of the measured nav-bar insets — so a mis-measured
  // inset can no longer produce contact, rather than merely being unlikely to.
  // marginHorizontal 0 on AA so the pill's left edge lands exactly on the row's
  // left (= CAR_DOCK_LEFT); the 12pt margin is what centres it on CarPlay.
  crewPill: { flexDirection: 'row', alignItems: 'center', height: CREW_PILL_H, paddingHorizontal: 10, marginHorizontal: IS_AA ? 0 : 12, borderRadius: 9, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', overflow: 'hidden' },
  // 11 -> 9 on CarPlay (AA keeps 11 — its canvas is only 213dp wide and everything there
  // is already scaled down by hudScale, so shrinking twice would make it unreadable).
  // 2026-08-15: the string is now just "N Crew" — Jeff dropped the build/runtime/tag
  // segments from the CAR surfaces ("remove the v73 1.25.0 15.2219"). The 8/13 note
  // that called every segment load-bearing is superseded: bundle identification lives
  // on the PHONE pill only now (map.tsx:3204). Do not re-add fields here.
  crewPillText: { color: '#C7CCD1', fontSize: IS_AA ? 11 : 9, fontWeight: '600' },
  crewPillTextWarn: { color: '#E4002B' },  // candy-apple red — the one red everywhere
  scoutPill: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, height: 34, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', overflow: 'hidden' },
  scoutDot: { width: 10, height: 10, borderRadius: 5 },
  scoutPillText: { color: '#F4F4F4', fontSize: 14, fontWeight: '700' },
  weatherText: { color: '#F4F4F4', fontSize: 13, fontWeight: '800', marginTop: 1 },
  // Compact maneuver CARD (mirrors the phone banner), tucked TOP-RIGHT: a green arrow
  // box + a [meters / instruction] column. Smaller than the old full-bleed strip.
  // Single solid dark tint floor (GlassFill above is clear/untinted) at 0.5 — matches
  // the phone banner EXACTLY and is backdrop-independent, so no washout on the pale day
  // map. NO border (like the phone banner + other chips); shadow lifts it.
  topTextCol: { flex: 1, minWidth: 0 },
  // 17 -> 15 alongside topInst. "1.8 km" still measures ~49pt and stays the largest
  // glyph in the box, and the shorter line box is what buys the vertical room for a
  // future 2-line instruction inside TURN_ROW_H (42) without touching TURN_ROW_H —
  // which is duplicated in CarMapView.tsx's CAR_BANNER_GAP_SCALABLE and must stay in sync.
  topDist: { color: '#F4F4F4', fontSize: 15, fontWeight: '800' },
  // 12 -> 10, Jeff 8/13: "the turnbyturn banner font size for the turn right onto....
  // needs to be smaller". 10 is the floor, not a starting point — it is the same size
  // already shipping as a legible car glyph (the speed/limit unit labels). Measured
  // against the real system font, this takes "Turn right onto Bruce Street" from 165pt
  // to 141pt; the text column is ~113pt on a 431pt canvas, so a long street name can
  // still truncate. Fixing THAT needs two lines, not a smaller font — see topDist.
  topInst: { color: '#F4F4F4', fontSize: 10, fontWeight: '600', flexShrink: 1 },
  // ETA / arrival — tucked into the BOTTOM-RIGHT corner, small.
  bottomText: { color: '#C7CCD1', fontSize: 12, fontWeight: '600' },
  // --- BOTTOM-RIGHT nav stack (live map): ETA pill above the maneuver banner, same width ---
  // width is the shared "length" of both banners — OTA-tunable. alignItems:'stretch' makes
  // the ETA + maneuver banner fill it equally so they line up.
  // width is applied INLINE (navStackW) — it has to be measured, see CAR_LEFT_INSET.
  navStack: { position: 'absolute', right: CAR_RIGHT_INSET, bottom: NAV_STACK_BOTTOM, alignItems: 'stretch', gap: NAV_GAP },
  navBannerRow: { flexDirection: 'row', alignItems: 'center', height: TURN_ROW_H, paddingHorizontal: 8, borderRadius: 12, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
  navEta: { paddingHorizontal: 10, height: ETA_ROW_H, borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  // ── The one-card layout (2026-08-18) ──────────────────────────────────────
  // navCard overrides navBannerRow's row direction/fixed height; the turn row keeps
  // TURN_ROW_H inside, the ETA line adds ~21pt under a hairline. Same glass, same
  // floor, same radius — a consolidation, not a restyle.
  // BORDERLESS (Jeff 8/20: "the black border may take away the effect of the
  // glass" — agreed): Liquid Glass's signature is the edge lensing at the rim,
  // and a 2pt opaque ring paints over exactly that rim, so the chip read as a
  // slab whatever material was inside. Supersedes the 8/19 black outline.
  navCard: { flexDirection: 'column', alignItems: 'stretch', height: undefined, paddingHorizontal: 0, paddingBottom: 0 },
  navCardTurn: { flexDirection: 'row', alignItems: 'center', height: TURN_ROW_H, paddingHorizontal: 8 },
  navCardEta: { paddingBottom: 3, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  // The phone StepDrawer's progress bar, card-sized (track 3pt, green fill, caret tip).
  cardProgressTrack: { alignSelf: 'stretch', height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.12)', marginBottom: 3, position: 'relative', overflow: 'visible' },
  cardProgressFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: '#2DEC86', borderRadius: 2 },
  cardProgressTip: { position: 'absolute', top: -4.5, marginLeft: -5, width: 11, height: 12, alignItems: 'center', justifyContent: 'center' },
  // +1 over bottomText and brighter: the whole point is arm's-length legibility on
  // the scaled AA canvas (12 × 0.533 was ~6.4pt; 13 lands ~7 → with the card's
  // extra width the fit-shrink rarely engages, unlike the old 60%-width pill).
  etaLineText: { color: '#F4F4F4', fontSize: 13, fontWeight: '700' },
});
