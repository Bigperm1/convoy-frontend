// src/carplay/CarMapView.tsx
//
// Trimmed, standalone Mapbox map for the CarPlay window (Path A). Renders ONLY
// the car dashboard's map: a live @rnmapbox <MapView>, an always-follow heading-up
// chase camera (mirrors the phone's chaseZoom/chasePitch), the 3D GR Corolla
// (ModelLayer), and the active route. Everything else the phone map carries —
// peers, places, weather, hazards, congestion fetches, gesture-pan — is absent so
// this stays small and robust on the late-sizing CarPlay secondary window.
//
// Fed ENTIRELY from carStore (no props from the phone tree, no context providers):
// position/heading/route/paint/mapMode/speed all come from useCarStore(). The
// Mapbox token is set globally by src/initMapbox (already in the bundle).
//
// Styling + camera stay in LOCKSTEP with the phone map: the style constants, the
// chase-cam math, and the polyline decoder are IMPORTED from ConvoyMapbox (named
// exports), never copied — so a phone tweak updates the car too.
//
// GL safety: onDidFailLoadingMap -> onGLError(), which the CarPlay surface uses to
// drop back to the static-image fallback (ConvoyCarPlay's showLive/glFailed).

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { reportDraw } from "../drawTelemetry";
import { Platform, StyleSheet, Image as RNImage } from 'react-native';
import Mapbox, {
  MapView,
  Camera,
  ShapeSource,
  LineLayer,
  SymbolLayer,
  VectorSource,
  Models,
} from '@rnmapbox/maps';
import { useCarStore, getCarState, setCarState, subscribeCarGesture, type CarGesture } from './carStore';
import { canonicalClass } from '../settings';
import { useMapView2D } from '../mapViewMode';
import { buildCongestionGradient } from '../mapboxDirections';
import { usePowerMode } from '../powerMode';
import { getVehicleModelUrl, getVehicleModelKey, vehicleHasLitBake, getVehiclePngOrDefault, isLitPreset, vehiclePngScale, CLASS_TOPDOWN } from '../vehicleAssets';
import {
  CAR_EMISSIVE_BY_MODE,
  ROUTE_GREEN_CORE,
  routeRgba,
  chaseZoom,
  CHASE_ZOOM_CLAMP_MIN,
  CHASE_ZOOM_CLAMP_MAX,
  chasePitch,
  kmhFromMs,
  decodePolyline,
  SelfCarModel,
  projectOntoRoute,
  carModelScale,
  easedFrac,
  TRIM_TICK_MS_PREMIUM,
  TRIM_TICK_MS_ECO,
  applyCarGapGradient,
  GREEN_ARROW_MODEL,
  ARROW_MODEL_ID,
  ARROW_MODEL_PITCH,
  ARROW_MODEL_HEADING_OFFSET,
  HazardMarker,
  CameraMarker,
  IncidentMarker,
  PlaceMarker,
  routeColorsFor,
  ROAD_SRC_ID,
  ROAD_SNAP_LOCK_M,
  ROAD_SNAP_RELEASE_M,
  ROAD_SNAP_QUERY_MS,
  ROAD_SNAP_MOVING_MS,
  ROAD_SNAP_CROSS_DEG,
} from '../ConvoyMapbox';
import { nearestRoadLine, roadHeadingOff, roadProjUsable, type LatLng as RoadLatLng } from '../roadSnap';
import { routeTrimLeadM, routeTrimFadeM } from '../routeTrim';
import { logEvent, logEventReliable } from '../crashBreadcrumb';

// Single active route only → it lives at index 0; the alts layer filters it out
// (index != 0) and the casing/core draw it (index == 0), exactly like the phone.
const SELECTED_INDEX = 0;
// Cruising tilt when NOT navigating — the phone uses pitch 0 off-nav, but on the
// car we want the Standard 3D buildings to read, so we hold a gentle tilt. During
// nav we use the phone's speed-aware chasePitch instead.
const CRUISE_PITCH = 45;
// Extra head-unit tilt toward the horizon (a few degrees) on top of the cruise /
// nav pitch — the driver asked for a more horizon-forward view that shows more road
// ahead and taller 3D buildings. Clamped to Mapbox Standard's 60° pitch cap in
// getCam so nav-at-speed (already 60°) never exceeds it. OTA-tunable.
// Was +3° toward the horizon; zeroed so the CarPlay nav pitch equals the phone's
// speed-aware chasePitch exactly (tester: "phone is correct for zoom and angle").
const CAR_PITCH_BONUS = 0;
// Mapbox Standard hard-caps camera pitch at 60°.
const CAR_PITCH_MAX = 60;
// Pull the car camera back a touch vs the phone so more of the road ahead reads on the
// wide head-unit screen. Subtracted from the phone's zoom (Mapbox zoom is log2, so 0.7
// ≈ 1.6x more area) for both nav and cruise.
// Offset from the phone's chase zoom. ZERO since 2026-07-14 — the standing rule is
// the CarPlay camera MATCHES the phone (same chaseZoom/chasePitch speed curves), and
// even the old 0.3 "hair" read as a mismatch on the head unit. NOTE: most of the
// perceived zoom mismatch was actually the FROZEN GPS feed (speed stuck at 0 pins
// the car camera at slow-city framing while the phone frames for real speed) — with
// the locked-phone GPS fix the two cameras track the same curve. OTA-tunable.
const CAR_ZOOM_OUT = 0;
// EXTRA pull-back while previewing 2+ route options (not navigating), so the Best/Scenic/AI
// fan-out reads on the head unit. Added to CAR_ZOOM_OUT only in multi-route preview; the
// car stays pinned (the proven lockstep chase is untouched — this is purely a zoom value).
const PREVIEW_ZOOM_OUT = 2.2;
// iOS-26 pinch/zoom: how far (in Mapbox zoom levels, log2) the driver's pinch may
// bias the auto follow-zoom, and the absolute clamp on the resulting camera zoom.
// The bias is ADDED to followZoom inside getCam, so the speed-aware chase still
// modulates around wherever the driver pinched to. Holds until 'recenter'.
const CAR_USER_ZOOM_BIAS_LIMIT = 4;
// PARITY (2026-07-29): the clamp now comes from the phone (ConvoyMapbox exports it),
// so the two surfaces cannot drift apart again. These were 3 / 20 against the
// phone's 10.5 / 20, which meant a pinch-out on a head unit could reach a framing
// the phone can't — a silent breach of the "CarPlay matches the phone" rule at the
// extremes. Preview keeps its own floor below, because fitting three whole routes
// legitimately needs to go wider than a chase camera ever does.
const CAR_ZOOM_MIN = CHASE_ZOOM_CLAMP_MIN;
const CAR_ZOOM_MAX = CHASE_ZOOM_CLAMP_MAX;
// The multi-route PREVIEW deliberately zooms out past the chase floor to frame the
// whole fan-out; crewFit likewise computes its own bounds zoom. Both bypass the
// chase clamp on purpose.
const CAR_PREVIEW_ZOOM_MIN = 3;

// How long a manual zoom outranks the speed-aware chase zoom before it lapses. Deliberately
// the SAME 15 s crewFit holds the overview for, so the two map buttons feel like one idea
// rather than two — that was the ask. Long enough to look ahead down the route and read it,
// short enough that a driver who forgets they zoomed is not stuck at the wrong framing.
// ⚠ It is a DEADLINE compared per frame, never a setTimeout. iOS suspends JS timers while
// the phone is locked, which is how a phone sits in a mount, so a timer-based release can
// strand the camera for an entire drive — the trap called out above getCam and the one that
// once stranded the CarPlay alert modals over the map.
const CAR_ZOOM_HOLD_MS = 15000;

// Top padding as a fraction of map height — pins the car near the BOTTOM-MIDDLE of the
// head unit (larger = lower on screen). Applied every frame via getCam, nav AND cruise.
// Bumped 0.42 → 0.52 (CarPlay only, tilt unchanged): drops the car a bit lower on the wide
// head-unit so more road/horizon reads ahead of it, matching the phone's forward view.
// Briefly dropped to 0.42 on 2026-07-20 over a computed car/banner overlap, then put
// BACK to 0.52 — Jeff prefers the lower car and the overlap does not actually bite:
//   Mapbox centres the camera in the INSET rect, so the car sits at y = H*(1+frac)/2
//   -> 240*(1.52)/2 = 182.5pt on a 240pt canvas.
//   The maneuver banner used to start at y184 (height 48) leaving ~1.5pt; it now starts
//   at y190 because TURN_ROW_H shrank to 42 for the mic alignment, so the SAME 0.52 has
//   ~4x the clearance it had before, and head-unit captures show the car reading clearly
//   above the banner rather than behind it.
// If it ever does look buried, prefer narrowing the nav stack over raising the car —
// raising it costs road-ahead, which is the whole point of the low framing.
const CAR_LOWER_PAD_FRAC = 0.52;
// Distance from the CarPlay canvas bottom to the centre of the gap between the turn
// banner and the ETA banner — the line Jeff wants the car sitting on. Mirrors the
// banner stack in ConvoyCarPlay.tsx: NAV_STACK_BOTTOM(8) + TURN_ROW_H(42) + NAV_GAP/2(4).
// KEEP IN SYNC with those three constants (both are listed in CARPLAY.md).
// Split in two because the stack it mirrors is only PARTLY scaled on Android Auto:
// NAV_STACK_BOTTOM is a real position (unscaled), while TURN_ROW_H(42) and NAV_GAP/2(4)
// are inside the transform and shrink with hudScale. Summed at scale 1 these are still
// the CarPlay 8 + 42 + 4 = 54 this was tuned to.
// KEEP IN SYNC with NAV_STACK_BOTTOM / TURN_ROW_H / NAV_GAP in ConvoyCarPlay.tsx
// (they cannot be imported — that module imports this one). Both listed in CARPLAY.md.
const CAR_BANNER_STACK_BOTTOM = Platform.OS === 'android' ? 4 : 8;
const CAR_BANNER_GAP_SCALABLE = 42 + 4;
// Shift the pinned car LEFT of center (fraction of map width, applied as camera
// paddingRight → the car moves left by ~half this). 0.22 sat it near the left
// speed-limit chip; 0.08 centres it in the open gap BETWEEN the bottom-left HUD
// (speed/limit) and the bottom-right nav banner — still biased just enough left
// that it never collides with the banner. OTA-tunable.
// BACK to 0.08 (2026-07-24). I moved this to 0.14 on my own initiative to dodge
// banners I had misplaced; Jeff never asked for it and told me not to touch the car.
// 0.08 is the long-standing value his layout was designed around. The banners avoid
// the car (CAR_LEFT_INSET), never the reverse.
// 0.08 -> 0.13 (2026-07-24) — Jeff asked for it this round ("maybe move the car
// marker over to the left slightly"). Mapbox centres the camera in the inset rect,
// so the car sits at x = (W - W*frac)/2; +0.05 shifts it ~10pt left on a ~420pt
// canvas. Together with the now content-sized ETA/lane pills (whose left edge moved
// right), that clears the car from the banner stack.
export const CAR_LEFT_PAD_FRAC = 0.13;

// ── CANVAS SCALE (shared by the map and the HUD) ────────────────────────────────
// The canvas every constant in this HUD was measured against: a real 800x480 CarPlay
// head-unit capture = 400x240pt.
//
// ── THE ANDROID AUTO CANVAS IS NOW MEASURED, NOT ESTIMATED (2026-07-30) ──────────
// logAaCanvas finally reported from Say Phin's Toyota, 18 minutes before the photos
// that prompted this work:
//   surface=213x107dp  px=800x400  pixelRatio=3.75  window=384x832dp
// So the head unit hands us a QUARTER of the CarPlay area (213x107 vs 400x240), not
// the ~250x143 previously guessed off a photograph. Note pixelRatio 3.75 on an 800px
// panel: that screen is physically ~7in wide for 213dp, i.e. ~34 dp/inch against a
// phone's ~160 — one dp there is nearly 5x the physical size. That is why a HUD that
// is correct on a phone is enormous on a head unit, and why scaling it down does not
// cost readability.
//
// Lives HERE, not in ConvoyCarPlay, purely to break an import cycle: ConvoyCarPlay
// already imports this module, so exporting from the other direction would be one.
export const CAR_REF_W = 400;
export const CAR_REF_H = 240;
// Floor, 0.5 -> 0.4. The measured canvas needs 107/240 = 0.446, so the old 0.5 was
// CLAMPING — the HUD stayed 12% larger than the screen it was on, which is a good
// part of Say Phin's "might have to scale back the sizes". At 0.446 the speed numerals
// are still ~0.6in tall on that head unit (see the dp/inch note above), so the floor
// was protecting against nothing here; it is kept only to catch an absurd report.
export const HUD_SCALE_FLOOR = 0.4;
// ANDROID AUTO ONLY — CarPlay is the reference surface and always returns 1.
export function hudScaleFor(w: number, h: number): number {
  if (Platform.OS !== 'android' || !(w > 0) || !(h > 0)) return 1;
  return Math.min(1, Math.max(HUD_SCALE_FLOOR, Math.min(w / CAR_REF_W, h / CAR_REF_H)));
}

// ── THE MAP ITSELF NEEDS THE SAME CORRECTION AS THE HUD (2026-07-31) ────────────
// Say Phin's 07:22 drive, photographed: the map is so tight that a single road label
// ("E 45TH AVE") spans the whole panel and the car is nowhere on screen. Jeff, three
// times now: the AA zoom does not match the phone.
//
// hudScaleFor already shrank every CHIP and the car model for this canvas — but the
// BASEMAP was never touched, and it is drawn in dp like everything else. That is the
// whole bug. Mapbox zoom is defined against dp (one tile = 512dp), so at an identical
// zoom level a canvas shows ground in proportion to its dp width:
//   CarPlay 400dp vs Android Auto 213dp -> AA shows 53% of the ground CarPlay does.
// Both panels are the SAME 800 physical px; the head unit just reports pixelRatio
// 3.75 where CarPlay reports 2.0, so every dp — road, label, line — is drawn 1.88x
// physically larger. It is not a taste mismatch, it is a unit mismatch.
//
// The correction is therefore exactly that ratio, in log2 because zoom is log2:
//   log2(400 / 213) = 0.91 zoom levels
// Cross-checked against his PHONE from the same probe row (window=384x832dp):
// log2(384/213) = 0.85. Two independent references, 0.06 apart — so this is measured,
// not tuned, and it self-adjusts on a head unit that reports a different canvas.
//
// Width, deliberately, NOT min(w,h) the way hudScaleFor does. Zoom corrects the SIZE
// of a dp; the AA panel's 2:1 letterbox against CarPlay's 1.67:1 is a framing
// difference no zoom value can fix, and folding it in here would over-zoom by a
// further 0.26 levels. The clamp is a sanity rail on a bad layout report.
//
// STILL NOT THE COMPLETE FIX ON ITS OWN — see aaMapScaleFor directly below, which is.
// This corrects the GROUND SCALE (how much road is on the panel). It cannot touch the
// SIZE Mapbox draws things at: labels, shields and line widths are specified in dp and
// rasterised at the view's pixelRatio, for which rnmapbox exposes no prop. That was
// going to need a native MapOptions.Builder.pixelRatio(2f) and a paid build (it was
// queued for 71). aaMapScaleFor gets the same result over the air — and when it is
// active THIS function returns 0 on its own, so the two can never double-correct. That
// is by construction (the `w >= CAR_REF_W` guard below), not a flag anyone has to
// remember to flip. (2026-08-15)
export const AA_ZOOM_OUT_MAX = 1.5;
export function aaZoomOutFor(w: number): number {
  if (Platform.OS !== 'android' || !(w > 0) || w >= CAR_REF_W) return 0;
  return Math.min(AA_ZOOM_OUT_MAX, Math.log2(CAR_REF_W / w));
}

// ── THE MAP GETS CARPLAY'S CANVAS, NOT THE HEAD UNIT'S (2026-08-15) ────────────
// ⚠ FIRST, TWO THINGS THAT WERE WRITTEN DOWN WRONG AND ARE NOW VERIFIED IN SOURCE:
//   1. pixelRatio 3.75 is SAY PHIN'S PHONE, not the head unit. RN sizes a surface from
//      the Context it was created on, and react-native-carplay's bridgeless port builds
//      the car surface on the APPLICATION context — VirtualRenderer.kt does
//      `ContextThemeWrapper(appContext, …)` then reactHost.createSurface(themed, …).
//      So AA dp = headUnitPx / PHONE density: 800/3.75 = 213, 400/3.75 = 107, which is
//      exactly the measured row. The magnitude of this bug is PER-TESTER; on a
//      2.0-density phone there is no error at all. Never bake 1.875 into anything.
//   2. The virtual display's own density — createVirtualDisplay's `container.dpi` —
//      reaches NOTHING. It is the only occurrence of that value in the whole library
//      and nothing ever reads it back. Changing it would have been a paid no-op.
//
// THE ACTUAL DEFECT: Mapbox gets a 213-POINT canvas where CarPlay gets a 400-point one,
// at the same physical 800px. Everything Mapbox rasterises at a dp size is therefore
// 400/213 = 1.88x too large on the panel — one street name spanning the whole screen.
//
// THE FIX, WITH NO NATIVE CHANGE: lay the GL view out at 400 x ~201 POINTS and scale it
// back onto the 213x107 panel with an RN transform. Mapbox's logical viewport becomes
// CarPlay's exactly, and it renders 1500x754 px which composites down to 800x400. A
// 12-point label rasterises at 12 x 3.75 = 45px and lands at 45 x 0.5325 = 24px — the
// same 24px CarPlay draws it at (12 x 2.0). Ground scale, labels, line widths and
// sprites all corrected in ONE move, over the air.
//
// WHAT THIS DOES *NOT* REQUIRE — the interlock, settled by arithmetic, not by unwinding:
//   • aaZoomOutFor retires ITSELF. Its input is the map's own onLayout width, which is
//     now 400, and its guard returns 0 at `w >= CAR_REF_W`. No double correction.
//   • uiScale = hudScaleFor(mapW, mapH) re-derives 0.446 -> 0.837 and lands on the
//     IDENTICAL physical size: a peer icon is 44 x 0.446 x 3.75 = 73.6px today and
//     44 x 0.837 x 3.75 x 0.5325 = 73.6px after. Nothing to change.
//   • The 3D car is actually FIXED here. It is sized in METRES, so it was shrunk TWICE —
//     once by uiScale (0.446) and again by the 0.91-level zoom-out (1.881) — leaving the
//     driver's own car at 0.445 of CarPlay's proportion while every chip beside it sat
//     at 0.836. With aaZoomOut at 0 it comes out 0.7 x 0.837 x 3.75 x 0.5325 = 0.836 of
//     CarPlay: the same number as the chips, which is the entire point of one shared
//     scale. That defect is live on build 70 and needed no build to fix.
//   • Every hardcoded AA dp inset in ConvoyCarPlay (CAR_RIGHT_INSET, CAR_BAR_*,
//     CAR_DOCK_LEFT, SPEED_DOCK_BOTTOM, the IS_AA fontSize) is untouched. They live in
//     the RN dp frame, which does not move, and several of them clear androidx chrome
//     drawn at a fixed PHYSICAL size — rescaling them would actively break the layout.
//
// THE COST, stated honestly: the GL map renders 1.13 Mpx instead of 0.32 — 3.5x the
// fragment work, on the surface with the known heat history. Context: the Android PHONE
// map already renders 4.5 Mpx on the same GPU, so this is a quarter of that.
// MAP_SCALE_FLOOR bounds the blow-up, and CAR_REF_W is an OTA dial if it proves too
// expensive (320 would halve the extra pixels for labels 1.25x CarPlay's instead of 1.0).
// fps is NOT a lever here — 60 stays 60.
//
// RISK, flagged as HYPOTHESIS: the AA map is a SurfaceView (rnmapbox defaults
// surfaceView:true — src/components/MapView.tsx:501 — and we never override it), so the
// downscale is done by SurfaceFlinger from the view→window matrix rather than by our own
// draw. Android maps that matrix for translate+scale, which is all we use here. If a
// head unit shows only the TOP-LEFT QUADRANT of an over-zoomed map, that is this and
// nothing else, and the fix is the one-prop OTA `surfaceView={false}` (TextureView) —
// deliberately NOT shipped up front, because it buys insurance we may not need at the
// price of an extra GPU copy every frame on a surface that runs hot.
export const MAP_SCALE_FLOOR = 0.5;
export function aaMapScaleFor(surfaceWidthDp: number): number {
  if (Platform.OS !== 'android' || !(surfaceWidthDp > 0)) return 1;
  // Never ABOVE 1: a head unit already at/above the reference would otherwise be asked
  // to render FEWER pixels than its panel and go soft. Floored so an absurd layout
  // report cannot demand a 10x framebuffer — and below the floor aaZoomOutFor picks up
  // the residual by itself, which is the right partial answer instead of a cliff.
  return Math.min(1, Math.max(MAP_SCALE_FLOOR, surfaceWidthDp / CAR_REF_W));
}
// Cache miss on a cold bg JS context can leave mapMode undefined, so the car needs SOME
// fallback rather than a bare default style.
//
// ⚠ DO NOT "FIX" THIS TO autoMapMode(). I tried that on 2026-08-13 and it was a
// regression. The reasoning was that 'dusk' is stale — DEFAULT_SETTINGS.mapMode is
// 'auto', and load() migrates a stored 'dusk' to 'auto' — which is all true, and still
// the wrong conclusion. That migration is ONE-TIME (guarded by baselineMigrated), so a
// deliberate pick is preserved, and drivers do deliberately pick dusk: Jeff runs dusk
// permanently ("I always have it on dusk"). For them a time-based fallback would hand
// back a bright DAY map, while the constant happens to be exactly right.
//
// Any hardcoded fallback is a guess. The only non-guess is the driver's own last-known
// choice, persisted — worth building IF this fallback is ever shown to actually fire.
// It has never been observed to: the purple-map-in-daylight that prompted the change
// turned out to be mapMode arriving correctly and the car faithfully matching a phone
// set to dusk. Nothing was broken. Leave it alone until there is evidence.
const DEFAULT_MODE = 'dusk';
// Positive-frame watchdog: if the GL map hasn't painted a real frame within this
// window after mount, report failure via onGLError — the parent then REMOUNTS this
// component with a fresh GL context (the 3D-100% retry; there is no 2D fallback).
// The secondary CarPlay window can leave the Metal map silently blank, and
// rnmapbox's onDidFailLoadingMap is a DEAD event on iOS — so we trust a POSITIVE
// paint signal and treat its absence as failure, rather than waiting for an error
// that never comes. Retries (attempt > 0) get a wider window — a slow head-unit boot
// shouldn't churn contexts back to back.
//
// ⚠ WHICH paint signal, and why it matters (2026-08-13, measured):
// This used to trust ONLY onDidFinishRenderingFrameFully. On iOS that event fires only
// when `renderMode == .full` (RNMBXMapView.swift ~1175) — i.e. a frame where EVERY tile
// has arrived. On weak cellular in a moving car the map paints .partial frames
// indefinitely and never reaches .full inside the window, so the watchdog fired,
// remounted, and THREW AWAY the partial progress the map had made — then did it again.
// The retry was the thing preventing the map from ever finishing.
//
// Telemetry over 7 days: of 53 sessions, 12 emitted a retry, 8 recovered within a few
// attempts, and 4 NEVER recovered — one logging 223 retries across 80 minutes, another
// spanning 8 hours. All four were iOS, and all four emitted no other telemetry at all.
// iOS-only is the tell: the Android binding raises DID_FINISH_RENDERING_FRAME_FULLY
// unconditionally without inspecting renderMode, so Android Auto could never hit this.
//
// The question the watchdog is meant to answer is "did this GL context ever draw
// ANYTHING?", not "did every tile arrive in 9 seconds?" — so a partial frame and a
// loaded style now both count as alive.
// ⚠ iOS ONLY. The Android binding emits { error } with no tileId/sourceId
// (RNMBXMapView.kt), so on Android/Android Auto the tile-error branch below never
// matches and behaviour is exactly as before. That is acceptable: the retry storm this
// change fixes is structurally impossible on Android, whose binding raises
// DID_FINISH_RENDERING_FRAME_FULLY without inspecting renderMode. Measured telemetry
// agrees — all four never-recovering sessions were iOS.
const TILE_ERR_LOG_MAX = 3;
const PAINT_WATCHDOG_MS = 6000;
const RETRY_WATCHDOG_MS = 9000;
// Route-snap heading gate (Phase 1 road-snap) — mirrors the phone (ConvoyMapbox). In
// addition to the ≤60 m distance test, the route bearing must be within tolerance of the
// travel heading, so a turn onto a parallel/cross street un-snaps the car to raw GPS.
// Hysteresis (lock 45° / release 60°) avoids flicker; skipped below ~walking speed.
// Crew overview: peers farther than this from the car are left out of the FIT (not the
// map). 100 km covers any real convoy spread on a highway run; beyond it the overview
// stops being about driving together. See the runaway guard at the crewFit case.
const CREW_FIT_MAX_KM = 100;
const CAR_SNAP_HDG_LOCK = 45;
const CAR_SNAP_HDG_UNLOCK = 60;
const CAR_SNAP_MOVING_MS = 1.5;

type Props = {
  // Called when the GL map fails or never paints on the CarPlay window, so the
  // parent (CarSurface) can schedule a REMOUNT retry. Driven by onMapLoadingError
  // AND the positive-frame watchdog below (NOT onDidFailLoadingMap — dead on iOS).
  // `why` names the trigger so a retry row is diagnosable without another drive —
  // 'gl-load' alone could not tell a watchdog timeout from a tile error.
  onGLError?: (why: string) => void;
  // Which retry this mount is (0 = first). Retries widen the paint watchdog.
  attempt?: number;
  // ── THE SURFACE SIZE, PASSED DOWN (2026-08-15) ─────────────────────────────
  // The RN dp frame the head unit actually gave us — 213x107 on Say Phin's Toyota —
  // measured by ConvoyCarPlay's root onLayout. It CANNOT be measured in here, because
  // this component's own layout is the thing aaMapScaleFor changes: the map is laid out
  // oversized and scaled back down, so its onLayout reports the size WE chose, not the
  // size the panel is. Chicken-and-egg, hence a prop.
  // 0 until the parent's first onLayout, and every consumer below falls back to exactly
  // today's behaviour at 0. On CarPlay these are simply never used (mapScale is 1).
  surfaceW?: number;
  surfaceH?: number;
};

export default function CarMapView({ onGLError, attempt = 0, surfaceW = 0, surfaceH = 0 }: Props) {
  const s = useCarStore();
  const powerMode = usePowerMode(); // premium (plugged) → 60fps; eco (unplugged) → 30fps

  const [mapH, setMapH] = useState(0);
  const [mapW, setMapW] = useState(0);

  // ── THE MAP RENDERS IN CARPLAY'S POINT SPACE (2026-08-15) ───────────────────
  // The reasoning is on aaMapScaleFor; this is the wiring. Lay the GL view out at
  // surface/mapScale (400 x ~201 points on the measured canvas) and scale it back onto
  // the panel. transformOrigin 'top left' with top/left 0 means the scaled box lands
  // exactly on 0,0..surfaceW,surfaceH — nothing spills, so this needs no clipping
  // wrapper and the surrounding tree is unchanged. (transformOrigin is already in use on
  // this surface: ConvoyCarPlay's hudFit, :473.)
  //
  // MEMOISED for the same reason selfScale is: handing MapView a fresh style object
  // every render re-uploads layout to the GL view, and this one runs at store-tick rate.
  // mapScale is 1 on CarPlay and on any head unit already at/above the reference, and
  // the object is then the identical StyleSheet.absoluteFill it has always been.
  //
  // ORDERING, deliberate: on the first render surfaceW is 0, so the map is absoluteFill
  // at 213x107 and aaZoomOutFor still applies its 0.91 — i.e. exactly build 70. One
  // render later surfaceW lands, the map relayouts to 400 points and aaZoomOutFor goes
  // to 0 on its own. That transition is why the applyZoomNow effect keyed on mapW is NOT
  // dead weight and must stay: a head unit that connects while the car is PARKED arms no
  // ease, so without it the corrected framing would wait for the driver to pull away.
  const mapScale = aaMapScaleFor(surfaceW);
  const mapStyle: any = useMemo(
    () => (mapScale >= 1 || !(surfaceW > 0) || !(surfaceH > 0)
      ? StyleSheet.absoluteFill
      : {
          position: 'absolute',
          top: 0,
          left: 0,
          width: surfaceW / mapScale,
          height: surfaceH / mapScale,
          transform: [{ scale: mapScale }],
          transformOrigin: 'top left',
        }),
    [mapScale, surfaceW, surfaceH],
  );

  // Frame watchdog state. paintedRef flips on the first real rendered frame;
  // firedRef ensures onGLError fires at most once. The map can never get stuck
  // blank: either it paints (watchdog cleared) or the timeout demotes to static.
  const paintedRef = useRef(false);
  // Bounded budget for tile-error breadcrumbs. logEvent() is a Supabase INSERT, not a
  // console line, so an unthrottled call on a per-failed-TILE event would put an HTTPS
  // POST on the very link whose tiles are already failing — and bury the next real
  // incident in noise. Every other breadcrumb in this file is bounded the same way
  // (congProbeKey once per route, hadFixRef on transitions only, the retry log by its
  // own backoff); this one has no business being the exception.
  const tileErrLogs = useRef(0);
  const firedRef = useRef(false);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `painted` (state, not just the ref) so the FIRST rendered frame forces a
  // re-render — the cold-start snap effect below + lockReadyRef both re-derive.
  const [painted, setPainted] = useState(false);

  const fail = (why: string) => {
    if (firedRef.current || paintedRef.current) return;
    firedRef.current = true;
    onGLError?.(why);
  };
  const markPainted = () => {
    if (paintedRef.current) return; // first frame only
    paintedRef.current = true;
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    setPainted(true);
    // Receipt for the recovery. Without it "the retries stopped" is unreadable — you
    // cannot tell whether the next attempt painted or the drive simply ended.
    //
    // ── LOG ATTEMPT 0 TOO (2026-08-25) ────────────────────────────────────────
    // This used to be `if (attempt > 0)`, so a HEALTHY first paint left no row at
    // all. That made the two states we most need to tell apart look identical in
    // the data: "the surface never painted" and "it painted, then went away".
    // Say Phin's 08-24 blank car screens are exactly that ambiguity — no GL error,
    // no retry, no give-up, and no way to know whether a frame ever landed.
    // logEventReliable, NOT logEvent. crashBreadcrumb's own rule: "Use for
    // receipts/bails whose absence will be interpreted." That is precisely this row —
    // its whole job is that a MISSING one means no frame landed. Plain logEvent returns
    // early when the Supabase client is not constructed yet, which is the normal state
    // during an Android-Auto-first cold start, i.e. exactly the session we are chasing.
    // It would recreate the ambiguity this edit exists to remove.
    //
    // BOUNDING, stated accurately: paintedRef makes this at most ONE row per mount, and
    // mounts within a CarSurface are capped at 7 by MAX_LIVE_ATTEMPTS (key={liveAttempt}).
    // It is NOT capped per drive — CarSurface is an AppRegistry root the head unit
    // starts, and nothing here limits how often it connects. That is fine and deliberate:
    // one row per connect is the signal. A module-level once-guard (aaCanvasSeen-style)
    // would defeat the instrument, because the bug we are hunting is per-connect.
    try { logEventReliable(`carplay-live-paint attempt=${attempt}`); } catch {}
    void measureViewportOnce();
  };

  // ── DOES THE MAP ACTUALLY SEE WHAT WE THINK IT SEES? (2026-08-15) ────────────────
  // Jeff, today: he cannot rely on a tester driving on cue — Say Phin has a family and
  // this is not his job — and Android Auto cannot be checked on this Mac. So the AA
  // basemap-scale fix (aaMapScaleFor) has to verify ITSELF from an ordinary drive,
  // with nobody asked to look at anything.
  //
  // ⚠ THIS RECORDS OBSERVATIONS, NOT CONCLUSIONS — deliberately, because the FIRST
  // instrument written for this failed review for exactly that: mapScaleWant/mapPtWant
  // are derived from the same `w` on the same line, so they report what we INTENDED to
  // hand the map, never what the map did. That is the update_id trap this project
  // already paid for once. getVisibleBounds() comes back from the NATIVE map, so it is
  // the one number here that can contradict us.
  //
  // No formula is applied on-device on purpose: meters-per-point depends on zoom,
  // latitude and Mapbox's tile-size convention, and baking a slightly-wrong constant in
  // would produce a confident wrong reading that survives in the data. Log the raw
  // bounds, the zoom and the latitude; derive off-device where the arithmetic can be
  // checked and corrected without shipping anything.
  //
  // HOW TO READ IT: ground span at a given zoom is proportional to the map's LOGICAL
  // viewport width. CarPlay rows are the reference (mapScale=1, ~400pt). If the AA fix
  // works, an AA row at a comparable zoom/latitude shows a span in the same ballpark as
  // CarPlay's; if the fix never applied, AA's span is roughly half of it.
  // One row per session — this is a Supabase INSERT, not a console line.
  const viewportLoggedRef = useRef(false);
  const measureViewportOnce = async () => {
    // ── THE FLAG IS BURNED ON SUCCESS, NOT ON ENTRY (2026-08-25) ──────────────
    // It used to be set here, before the 2.5s await. So if carMapRef was gone when
    // the timer fired, the function returned silently AND the instrument was
    // disarmed for the rest of the session — a missing car-viewport row could mean
    // "the map never drew" or "the read simply failed", with no way to tell. That
    // ambiguity is what made Say Phin's 08-24 blanks unresolvable from telemetry.
    // Now every exit path says WHY, and the once-flag is only set on a real read.
    if (viewportLoggedRef.current) return;
    try {
      // Let the first camera command settle: at paint the camera may still be on the
      // cold seed rather than the follow pose, which would log a zoom we never show.
      await new Promise((r) => setTimeout(r, 2500));
      const m = carMapRef.current;
      if (!m?.getVisibleBounds) {
        // Not silence any more. "ref gone" means the surface was torn down between
        // the first frame and 2.5s later — the eviction signature. "no method" means
        // getVisibleBounds is unavailable on this surface, which is a different bug.
        viewportLoggedRef.current = true;
        try { logEventReliable(`car-viewport-miss why=${m ? 'no-method' : 'ref-gone'} painted=${paintedRef.current ? 1 : 0} attempt=${attempt}`); } catch {}
        return;
      }
      const [ne, sw] = await m.getVisibleBounds();     // [[lon,lat],[lon,lat]] from NATIVE
      const zoom = typeof m.getZoom === 'function' ? await m.getZoom() : -1;
      const f = (n: number) => (typeof n === 'number' ? n.toFixed(5) : 'na');
      viewportLoggedRef.current = true;
      logEventReliable(
        `car-viewport surf=${Math.round(surfaceW)}x${Math.round(surfaceH)} ` +
        `scale=${mapScale.toFixed(3)} zoom=${typeof zoom === 'number' ? zoom.toFixed(2) : 'na'} ` +
        `ne=${f(ne?.[0])},${f(ne?.[1])} sw=${f(sw?.[0])},${f(sw?.[1])}`,
      );
    } catch (e: any) {
      // A failed read must never touch the drive — but it must not be SILENT either.
      viewportLoggedRef.current = true;
      try { logEventReliable(`car-viewport-miss why=threw msg=${String(e?.message ?? e).slice(0, 60)} attempt=${attempt}`); } catch {}
    }
  };

  useEffect(() => {
    // Start the watchdog from MOUNT (after the CarPlay handshake), not connect.
    const ms = attempt > 0 ? RETRY_WATCHDOG_MS : PAINT_WATCHDOG_MS;
    watchdogRef.current = setTimeout(() => {
      if (!paintedRef.current) fail(`watchdog${ms}`);
    }, ms);
    return () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      // ── TEARDOWN RECEIPT (2026-08-25) ──────────────────────────────────────
      // There was NO crumb for the car surface going away, so an Android Auto
      // eviction (the driver dropped onto the session placeholder — Say Phin's
      // 0e43bbe bug, whose native half still needs Screen.setMarker) looked
      // identical in telemetry to a map that simply never came up. `painted` says
      // which: unmount with painted=1 means we HAD a frame and lost the surface.
      // One row per mount, same as the paint receipt — see the bounding note there.
      try { logEventReliable(`car-surface-gone painted=${paintedRef.current ? 1 : 0} attempt=${attempt}`); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Style-load re-assert (the "live map paints but looks FLAT" race): the
  // <StyleImport existing config> below patches the Standard basemap import, but on
  // a fresh GL context the config write can land BEFORE the basemap import exists —
  // Standard then loads with default lighting and NO 3D objects (a 2D-looking live
  // map). onDidFinishLoadingStyle fires once the style (incl. imports) is actually
  // in, so bump styleGen → remounts <StyleImport> → config re-applies on the loaded
  // style. Also re-assert the pitched camera if the first frame hasn't painted yet,
  // so the very first visible frame is guaranteed pitched at the driver.
  const [styleGen, setStyleGen] = useState(0);

  const hasFix = typeof s.selfLat === 'number' && typeof s.selfLng === 'number';
  // ── FIX-STATE PROBE (2026-07-30) ────────────────────────────────────────────
  // Say Phin: "when I turned off my phone screen the avatar disappeared on the car
  // screen... I wondered if the avatar is there but off the screen." Jeff also sees
  // the car marker missing and the zoom not matching the phone.
  //
  // Those two symptoms have ONE likely common cause rather than two: lockReadyRef
  // requires hasFix, so with no fix the lockstep never pushes the camera — the map
  // sits at the style's default framing (which is exactly "zoom doesn't match the
  // phone") AND SelfCarModel has nothing to draw ("marker off screen"). If instead
  // the fix is fine and only the framing is wrong, that is a camera-maths bug and a
  // completely different fix. Guessing between them has already cost a round trip,
  // so log each TRANSITION (never per-frame) and let the next drive decide.
  const hadFixRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (hadFixRef.current === hasFix) return;
    const first = hadFixRef.current === null;
    hadFixRef.current = hasFix;
    if (first && hasFix) return;             // normal cold start, not worth a row
    try {
      logEvent(`car-fix ${hasFix ? 'GAINED' : 'LOST'} nav=${s.navigating ? 1 : 0} src=${s.carDbg ?? '-'}`);
    } catch {}
  }, [hasFix, s.navigating, s.carDbg]);
  const lat = s.selfLat ?? 0;
  const lng = s.selfLng ?? 0;
  const hdg = s.heading ?? 0;

  // Multi-route PREVIEW mode: the phone mirrors 2+ display routes (Best/Scenic/AI) only
  // while NOT navigating. In nav (or a single route) s.routes is empty → we fall back to
  // the single selected ribbon below (with its trim), exactly as before.
  const previewMulti = !s.navigating && Array.isArray(s.routes) && s.routes.length >= 2;
  const selIdx = s.selectedRouteIndex ?? SELECTED_INDEX;

  // Base-map style — mirror the phone's useStandard logic so the car matches the
  // driver's chosen look. satellite → SatelliteStreet imagery; everything else →
  // Standard with the matching light preset (set via <StyleImport> below).
  const mode = s.mapMode ?? DEFAULT_MODE;
  const useStandard = mode !== 'satellite';
  const styleURL = useStandard ? 'mapbox://styles/mapbox/standard' : Mapbox.StyleURL.SatelliteStreet;
  // Self-marker style mirrors the phone (settings.selfMarkerType). Arrow → the green
  // arrow GLB (always fully self-lit, emissive 1, like the phone); else the 3D car with
  // the per-mode emissive. Uses the SAME exported ARROW_MODEL_* consts the phone uses,
  // so phone + CarPlay stay in lockstep.
  const isArrow = s.selfMarkerType === 'arrow';
  const emissive = isArrow ? 1 : (CAR_EMISSIVE_BY_MODE[mode] ?? 0);
  // Model id: the arrow's fixed id, or a color-specific car id so a car-color change
  // swaps the 3D model live (Mapbox caches a model by id; a fixed id won't reload a new
  // .glb until remount). The key={carModelId} on <Models>+<SelfCarModel> forces the
  // remount that re-registers the GLB when the id flips car↔arrow.
  // Lights-on after dark, same rule as the phone (isLitPreset ⇒ the _lit bake; the
  // id must carry the suffix so Mapbox's by-id model cache reloads on day↔night).
  const carLit = !isArrow && isLitPreset(mode);
  // convoyCar3_: generation bump, in step with the phone (ConvoyMapbox.tsx). CarPlay
  // sat a generation behind at 'convoyCar_', so it cached its own stale copies.
  const carModelId = isArrow ? ARROW_MODEL_ID : ('convoyCar4_' + getVehicleModelKey(s.selfCarColor) + (carLit && vehicleHasLitBake(s.selfCarColor) ? '_lit' : ''));

  // Speed-aware zoom for BOTH nav AND cruise — chaseZoom with no turn distance is a pure
  // speed→zoom curve (city tighter, highway wider), so cruise now dynamically zooms in/out
  // with speed too. Pulled back by CAR_ZOOM_OUT so more road reads on the wide screen.
  const kmh = kmhFromMs(s.speedMs);
  // aaZoomOut is 0 on CarPlay by construction (see aaZoomOutFor) — this line is
  // byte-identical there. On Android Auto it converts the canvas's inflated dp back
  // to CarPlay's ground scale, so both car surfaces frame the same road ahead.
  const aaZoomOut = aaZoomOutFor(mapW);
  const followZoom = chaseZoom(kmh, s.navigating ? s.distanceToTurnM : undefined) - CAR_ZOOM_OUT - aaZoomOut - (previewMulti ? PREVIEW_ZOOM_OUT : 0);
  // ── FLAT WHEN NOT ROUTING (2026-07-29, Jeff's call) ─────────────────────────
  // "I want to make the CarPlay flat when not routing, because it uses the high-res
  // PNG images instead of the 3D — the 3D should be for routing."
  // This is the phone's rule, and the two halves are one decision: ConvoyMapbox
  // draws the top-down PNG sprite when `!navActive` (selfIsFlatCar, :2224) AND sets
  // followPitchDeg to 0 then. A flat sprite lies ON the map, so it only reads right
  // under a top-down camera; the 3D GLB only reads right under a pitched one. The car
  // surface previously took neither half — pitched at CRUISE_PITCH (45) with the 3D
  // model always on — so free-driving looked nothing like the phone.
  // Arrow keeps its 3D model in both modes, same as the phone (it has no flat twin).
  // 2D CONVOY VIEW (Jeff, 2026-08-14). A second, DELIBERATE reason to go flat, on top of
  // the July "flat when not routing" rule. Routing is untouched — the route line still
  // draws and guidance keeps running; only the camera pitch and the marker art change.
  // Arrow keeps its 3D model in both views (it has no flat twin), same as the phone.
  const view2D = useMapView2D();
  // ⚠ THE JULY AUTO-FLAT IS RETIRED (Jeff, 2026-08-14). This used to be
  // `!s.navigating && !isArrow` — CarPlay flattened itself whenever a route was not
  // running (his 2026-07-29 call, quoted above). With a manual button that rule becomes a
  // second opinion: sit idle in auto-2D, press for 3D, and the auto rule argues back.
  // The button is now the ONE source of truth on all four surfaces, which is what "default
  // is unchanged, you press the button" means. Idle now looks the same as driving: 3D
  // until the driver says otherwise.
  // ── ULTRA PREMIUM HAS NO SPRITE (Jeff, 2026-08-24) ──────────────────────────
  // "the sprite is only for the classes section the ultra premium will not have a sprite"
  // Was `view2D && !isArrow`, which flattened the 3D/Ultra car too — and that sprite is
  // the AUTHORED GR Corolla, so a driver whose 3D model is a scan of their own car saw
  // somebody else's car whenever the view was 2D. CLASS keeps the flat sprite; the Ultra
  // car now draws its GLB in both views, matching the phone (ConvoyMapbox.tsx).
  const carFlat = view2D && s.selfMarkerType === 'class';
  // 2D forces top-down even while routing — that is the whole point of the view. The
  // speed-driven ZOOM curve above is deliberately left alone: Jeff asked for "speed zoom
  // features (like 3d zoom) but just zoom in and out not tilt".
  const followPitch = view2D
    ? 0
    : (s.navigating
        ? Math.min(CAR_PITCH_MAX, chasePitch(kmh) + CAR_PITCH_BONUS)
        : (carFlat ? 0 : CRUISE_PITCH));
  // Sprite id for the flat car. Registered as a Mapbox image below — the car map had
  // no <Images> at all before this, so the sprite path could not have worked.
  const carFlatImg = 'self_car_flat_' + getVehicleModelKey(s.selfCarColor);

  // ── PEERS AS REAL CARS, NOT GREEN DOTS (Jeff, 2026-08-12) ───────────────────
  // "on CarPlay when I hit the crew, it doesn't show the high resolution car. It shows
  //  green dots instead for my peers."
  //
  // They were a CircleLayer, and the comment there defended it as "cheap, view-sync-safe
  // and glanceable". Cheap and view-sync-safe are real constraints — a MarkerView is an
  // RN view and does NOT sync reliably on the CarPlay window, which is why the phone's
  // peer component cannot simply be reused here. But "glanceable" was doing a lot of
  // work: a green dot cannot tell you WHICH crew member it is, and this surface already
  // draws a full 3D model for the driver's own car, so it was never a capability limit.
  //
  // Both appearance sources are ORDINARY STATIC ASSETS — CLASS_TOPDOWN[class] and the
  // per-colour GRC photos are require()d PNGs — so they register through the same plain
  // `Mapbox.Images` map the self flat car already uses on this surface, and a SymbolLayer
  // draws them in GL. That keeps every property the circle had (GL, no view sync, one
  // layer for all peers) while showing an actual car.
  //
  // Registering only DISTINCT images matters: a convoy of eight cars in three colours
  // registers three, not eight.
  // Target on-map size for a peer car, in POINTS. 44 matches the self flat car exactly
  // (a 44pt asset drawn at vehiclePngScale ~1), so the crew and the driver read at the
  // same scale instead of one dominating the other.
  const PEER_ICON_PT = 44;

  // ⚠ WHY iconSize IS DERIVED FROM THE ASSET AND NEVER HARDCODED TO 1.
  // A pre-ship review caught this and it would have been ugly: the classes-v2 PNGs are
  // single-resolution 512x512 with NO @2x/@3x siblings, so RN's resolveAssetSource reports
  // scale 1, Mapbox registers the style image at pixelRatio 1, and iconSize 1 renders
  // 512 LAYOUT POINTS. The CarPlay canvas is 400x240pt and the measured Android Auto canvas
  // is 213x107dp — a single class peer would have covered the whole map, drawn OVER the
  // route and the driver's own car because of iconIgnorePlacement below. The GRC photos are
  // the opposite case (44pt base WITH @2x/@3x, so pixelRatio 3), which is exactly why one
  // constant cannot serve both.
  // This repo already knew: ConvoyMapbox notes "iconSize is per-asset: hazard/police PNGs
  // are 512px (-> 0.078)", and the phone deliberately routes class photos through a 66pt
  // device-scale snapshot "so per-class asset resolution never leaks into the map's iconSize
  // math". Deriving it means a future asset at any resolution is right without a magic
  // number to remember.
  const iconSizeForAsset = (asset: any, targetPt: number) => {
    try {
      const r = RNImage.resolveAssetSource(asset);
      // ⚠ `width` IS ALREADY POINTS — do NOT divide it by `scale`.
      // Round 2 of the review caught exactly that. Metro stores the registry width as
      // pixels/scales[0] (metro/src/Assets.js), so JS already receives points; `scale` is
      // separately the DEVICE variant picked by pickScale(asset.scales, PixelRatio.get())
      // and has no relationship to `width`. Dividing gave iconSize 3.0 on a 3x phone — a
      // 132pt car, which on the 213x107dp Android Auto canvas is taller than the canvas
      // itself. The class asset only looked correct because classes-v2 is single-scale,
      // the one family where width/scale happens to equal width.
      // Two proofs live in this repo, and I had walked past both:
      //  - ConvoyMapbox: "hazard/police PNGs are 512px (->0.078 for ~40pt), the
      //    speed_camera PNG is 44px (->0.64 for ~28pt)" — and speed_camera IS multi-scale
      //    (44/88/132). 28/44 = 0.64. Shipped, working code: the divisor is raw width.
      //  - One line from here, the SAME GRC photo is drawn as the driver's own flat car at
      //    spriteSize = vehiclePngScale (~1.0). Self 1.0 vs peer 3.0, same asset, same
      //    registration, same layer.
      const pt = r?.width || 0;
      if (pt > 0) return Math.round((targetPt / pt) * 1000) / 1000;
    } catch {}
    // Unresolvable → 0 so the icon is INVISIBLE rather than 512pt. A missing car is a
    // cosmetic gap; a car covering the head unit hides the route.
    return 0;
  };

  // Resolve a peer to { name, asset, kind }. ONE place, so peerImages and peerImageFor can
  // never disagree about a name — a feature naming an unregistered image draws nothing.
  // canonicalClass mirrors the phone: a legacy/unknown class name still maps to a real
  // class asset instead of silently falling back to the paint photo.
  // `kind` reports what ACTUALLY resolved, not what was asked for: a class peer whose asset
  // is missing falls through to the photo, and the ink correction below must follow the
  // asset that resolved rather than the marker that was requested.
  const peerAppearance = (p: { marker?: string | null; cls?: string; color?: string }) => {
    if (p.marker === 'class') {
      const key = canonicalClass(p.cls);
      const asset = (CLASS_TOPDOWN as any)[key];
      if (asset) return { name: 'peer_cls_' + key, asset, kind: 'class' as const };
    }
    return {
      name: 'peer_car_' + getVehicleModelKey(p.color),
      asset: getVehiclePngOrDefault(p.color),
      kind: 'photo' as const,
    };
  };

  // Register only DISTINCT images: eight cars in three colours registers three, not eight.
  //
  // HEAT (2026-08-14): this memo was keyed on `[s.peers]` — ARRAY IDENTITY — and the crew
  // feeds push a fresh array every ~2 s even when nobody changed appearance. Every push
  // minted a new peerImages object → new allMapImages → a prop change on <Mapbox.Images>
  // → native re-registration of every car image, all drive long. Key the memo on the
  // sorted IMAGE-NAME signature instead: same names → same object reference → no native
  // churn. A peer changing paint/class changes their image name, so updates still land.
  const peerImgSigRef = useRef<{ sig: string; images: Record<string, any> }>({ sig: '', images: {} });
  const peerImages = React.useMemo(() => {
    const out: Record<string, any> = {};
    for (const p of s.peers || []) {
      if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
      const { name, asset } = peerAppearance(p);
      if (asset) out[name] = asset;
    }
    const sig = Object.keys(out).sort().join('|');
    if (sig === peerImgSigRef.current.sig) return peerImgSigRef.current.images;
    peerImgSigRef.current = { sig, images: out };
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.peers]);

  const allMapImages = React.useMemo(
    () => ({ [carFlatImg]: getVehiclePngOrDefault(s.selfCarColor), ...peerImages }),
    [carFlatImg, s.selfCarColor, peerImages],
  );

  // canvasScale is uiScale: the Android Auto canvas correction. Passed in rather than closed
  // over because uiScale is declared below this point, and a TDZ bug here would be invisible
  // until a peer appeared.
  const peerImageFor = (
    p: { marker?: string | null; cls?: string; color?: string },
    canvasScale: number,
  ) => {
    const { name, asset, kind } = peerAppearance(p);
    // vehiclePngScale normalises the five photo crops to a common ink width (the phone does
    // the same). It is an INK correction and multiplies the point-size correction above —
    // and it applies ONLY to the photos it was measured against.
    const ink = kind === 'photo' ? vehiclePngScale(p.color) : 1;
    // ⚠ THE ANDROID AUTO CORRECTION, and round 2 settled a round-1 contradiction to get
    // here. uiScale = hudScaleFor(mapW, mapH) is 1 on CarPlay and ~0.446 on the measured
    // 213x107dp AA canvas, and in this file it was applied ONLY to the self car's model
    // scale and the camera padding — never to an icon. Without it a peer keeps a fixed 44pt
    // while the driver's own car shrinks with the canvas, so on AA the crew would tower over
    // the driver on a canvas a quarter the area of CarPlay's.
    const target = PEER_ICON_PT * (canvasScale > 0 ? canvasScale : 1);
    return { img: name, size: Math.round(iconSizeForAsset(asset, target) * ink * 1000) / 1000 };
  };

  // ── CAR SIZED TO THE CANVAS (2026-07-30) ────────────────────────────────────
  // Say Phin, on the build-69 head unit: "the bones are there on the car screen,
  // might have to scale back the sizes / avatar takes up half the screen."
  //
  // This is geometry, not taste. The GLB is a fixed size in METRES and metres-per-dp
  // at a given zoom is fixed too, so the fraction of the canvas the car covers is
  // carMetres / (canvasDp x metresPerDp) — it grows in inverse proportion to the
  // canvas. Going from CarPlay's 400dp to Android Auto's ~250dp makes the same car
  // 1.6x bigger ON SCREEN at the identical zoom. hudScale already shrinks every chip
  // by that ratio; the model was the one thing left at CarPlay's absolute size, which
  // is exactly why it started to dominate once the chips got smaller.
  //
  // Multiplying by the SAME hudScale (not a hand-picked number) is what makes the two
  // surfaces the same design: car-to-HUD proportion becomes identical on both.
  // CarPlay is untouched — hudScaleFor returns 1 off Android.
  const uiScale = hudScaleFor(mapW, mapH);
  // Memoised: carModelScale builds a fresh zoom-expression ARRAY, and handing Mapbox a
  // new array every render re-uploads the layer's paint properties each frame.
  const selfScale = useMemo(
    () => carModelScale((isArrow ? 1.0 : 0.7) * uiScale),
    [isArrow, uiScale],
  );

  // MANDATORY heading-up — mirror the phone: plain Follow + a HELD heading, NOT
  // FollowWithCourse (which wobbles on raw GPS course and spins when stopped). Holding
  // the last good heading keeps the map heading-up even at a standstill.
  const camHdgRef = useRef(hdg);
  if (typeof s.heading === 'number') camHdgRef.current = s.heading;
  const followHeadingDeg = camHdgRef.current;
  // Hysteresis latch for the route-snap heading gate (see carSnapped below).
  const carSnapHdgOkRef = useRef(true);

  // Seed the FIRST rendered frame at the driver's location so the GL map never
  // paints the world/default view before the lockstep snap lands — that's the
  // "opens on the world map, then jumps to me" cold-start flash. This is now safe
  // (the old code deliberately omitted defaultSettings to dodge a fly-in): CarMapView
  // mounts ONLY when showLive is true, which REQUIRES hasFix, so lat/lng are already
  // valid at first render and this seed is set once — it never toggles undefined→set,
  // so there's nothing for @rnmapbox to animate. The lockstep + cold-start snap own
  // every frame after this initial seed.
  const initialCamRef = useRef<{ centerCoordinate: [number, number]; zoomLevel: number; pitch: number; heading: number } | null>(null);
  if (initialCamRef.current == null && hasFix) {
    initialCamRef.current = { centerCoordinate: [lng, lat], zoomLevel: followZoom, pitch: followPitch, heading: hdg };
  }

  // LOCKSTEP camera (see SelfCarModel): a cameraRef on THIS car-window map + a per-frame
  // getCam closure. The car is pinned to a fixed screen spot (near bottom-middle) and the
  // map rotates/translates around it. paintedRef (first rendered frame) + hasFix gate it
  // so we never queue 60fps setCamera calls before the surface is live.
  const cameraRef = useRef<React.ElementRef<typeof Camera> | null>(null);
  const lockReadyRef = useRef(false);
  // Crew-overview hold: while set (epoch ms), the lockstep camera stands down so a
  // fitBounds over the whole crew isn't overwritten on the next rAF tick. Expires
  // on its own — no cleanup path can strand the chase cam off.
  const camHoldUntilRef = useRef(0);
  // ── ZOOM SNAP-BACK (Jeff, 2026-08-11) ───────────────────────────────────────
  // "when the zoom buttons first showed up I used them and they worked, but they did not
  //  snap back to the correct zoom/chase cam/tilt that it should have been based on my
  //  speed. Let's use the same mechanism as the crew snap back."
  //
  // He is right, and the two controls were built inside out from each other. crewFit parks
  // a DEADLINE in camHoldUntilRef; lockReadyRef re-derives from it and the chase cam
  // re-grabs position, heading, pitch and zoom the moment it lapses. The zoom controls did
  // the opposite: they wrote a bias into userZoomRef, which getCam ADDS to the speed-aware
  // followZoom on every frame, and NOTHING ever cleared it. So one tap of +/- retired the
  // speed-aware framing for the rest of the drive — the camera could not come back to the
  // zoom your speed asks for, because the offset was still being added on top of it.
  //
  // Same deadline shape as crew, but its OWN ref on purpose: camHoldUntilRef also freezes
  // heading and hands position to the overview, and a zoom must not do either — the chase
  // cam should keep following the road the whole time, and only the ZOOM offset expires.
  const zoomHoldUntilRef = useRef(0);
  // Compass north-up hold (mirrors the phone compass): camera heading pinned to 0
  // while the chase keeps following position; the car MODEL keeps its real heading.
  // Toggled by the compass button; auto-released when navigation starts (the phone
  // does the same — guidance is heading-up chase, not the compass hold).
  const [carNorthUp, setCarNorthUp] = useState(false);
  const camHdgOverrideRef = useRef<number | undefined>(undefined);
  // Last heading actually drawn, kept live for the compass's direct camera push below.
  const drawHdgRef = useRef(0);
  useEffect(() => { if (s.navigating) setCarNorthUp(false); }, [s.navigating]);
  // getCam() re-derives the override every FRAME (see the comment there); this ref is
  // how the frozen getCam closure reads the live compass-toggle state.
  const carNorthUpRef = useRef(false);
  carNorthUpRef.current = carNorthUp;
  camHdgOverrideRef.current = carNorthUp ? 0 : undefined;
  lockReadyRef.current = paintedRef.current && hasFix && Date.now() >= camHoldUntilRef.current;
  // ── Phase-2 road-snap (mirror of the phone) ── query the invisible mapbox-streets-v8 road
  // source near the car when NOT route-snapped, snap the DRAWN pose to the nearest road.
  const carMapRef = useRef<any>(null);
  const [carRoadSnap, setCarRoadSnap] = useState<{ line: RoadLatLng[] } | null>(null);
  const carRoadSnapRef = useRef<{ line: RoadLatLng[] } | null>(null);
  const carRoadStickyRef = useRef(false);
  const carRoadInputsRef = useRef<{ lat: number; lng: number; hdg: number | null; speed: number; active: boolean }>(
    { lat: 0, lng: 0, hdg: null, speed: 0, active: false },
  );
  useEffect(() => {
    let mounted = true;
    const id = setInterval(async () => {
      const inp = carRoadInputsRef.current;
      if (!inp.active || !paintedRef.current || !carMapRef.current?.querySourceFeatures) {
        if (carRoadStickyRef.current) { carRoadStickyRef.current = false; carRoadSnapRef.current = null; setCarRoadSnap(null); }
        return;
      }
      // Road continuity: stay locked to the current road while still on it (see phone comment).
      const cur = carRoadSnapRef.current;
      if (cur && carRoadStickyRef.current) {
        const p = projectOntoRoute(inp.lat, inp.lng, cur.line);
        // roadProjUsable: don't keep a lock we've driven off the END of (see roadSnap.ts).
        if (p && roadProjUsable(p) && p.distM <= ROAD_SNAP_RELEASE_M) return;
      }
      try {
        const fc = await carMapRef.current.querySourceFeatures(ROAD_SRC_ID, [], ['road']);
        if (!mounted || !carRoadInputsRef.current.active) return;
        const tol = carRoadStickyRef.current ? ROAD_SNAP_RELEASE_M : ROAD_SNAP_LOCK_M;
        const nl = nearestRoadLine(inp.lat, inp.lng, fc?.features, tol);
        const p = nl ? projectOntoRoute(inp.lat, inp.lng, nl.line) : null;
        const moving = inp.speed >= ROAD_SNAP_MOVING_MS;
        const crossOk = !p || !moving || inp.hdg == null || roadHeadingOff(inp.hdg, p.bearing) <= ROAD_SNAP_CROSS_DEG;
        if (nl && crossOk) { carRoadStickyRef.current = true; carRoadSnapRef.current = { line: nl.line }; setCarRoadSnap({ line: nl.line }); }
        else if (carRoadStickyRef.current) { carRoadStickyRef.current = false; carRoadSnapRef.current = null; setCarRoadSnap(null); }
      } catch { /* querySourceFeatures can throw mid-style-reload; retry next tick */ }
    }, ROAD_SNAP_QUERY_MS);
    return () => { mounted = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Driver pinch-zoom bias (in Mapbox zoom levels), applied ON TOP of the auto
  // follow-zoom. A ref (not state) so the ~60fps lockstep reads the live value
  // each frame with no re-render; zoomBaseRef snapshots it at gesture start
  // because CarPlay's pinch `scale` is cumulative from the gesture's begin.
  const userZoomRef = useRef(0);
  const zoomBaseRef = useRef(0);
  // ── APPLE HAS THREE ZOOM GESTURES, NOT ONE (2026-08-05) ────────────────────
  // Jeff has asked for CarPlay zoom ~15 times and it has never worked. Disassembly of
  // the iOS 26.5 CarPlaySupport host settles why. CPSMapTemplateViewController has THREE
  // handlers that all funnel into the same didUpdateZoomGesture delegate call:
  //   _handlePinchGesture:            began -> update(real scale, real velocity) -> ended
  //   _handleTwoFingerTapGesture:     ONE update, scale = 1.0, velocity = -1.0, no begin
  //   _handleOneFingerDoubleTapGesture: ONE update, scale = 1.0, velocity = +1.0, no begin
  // (the two tap handlers literally `fmov` the constants 1.0 and -1.0/+1.0 into place)
  //
  // Two-finger tap is Apple's zoom OUT; one-finger double tap is zoom IN. Our telemetry —
  // two rows, both scale=1.000, ZERO zoomBegin ever — is those tap handlers exactly. So
  // the gestures DID reach us, and we discarded them: log2(1.0) is 0, and `velocity`,
  // which carries the entire direction, was destructured and never read.
  //
  // A real pinch has never been recognised on this car (no begin has ever arrived), and
  // nothing on our side can change that — the host's begin and update entry points are
  // instruction-identical, so any condition that suppressed begin would suppress update
  // too. Pinch stays a host limitation. TAP-ZOOM is ours to fix, and it is OTA.
  //
  // ⚠ THE DISCRIMINATOR IS THE BEGIN FLAG, NOT THE SCALE VALUE. A genuine pinch's FIRST
  // update also arrives at scale ~1.0 (UIPinchGestureRecognizer starts at 1.0 and the
  // host filters only on a 0.03 s throttle), so testing |scale-1| would fire a full
  // discrete step on the opening frame of a real pinch. Taps never send begin; pinches
  // always do. That is the only safe test.
  const pinchActiveRef = useRef(false);
  // One tap = one zoom level. Mapbox zoom is log2, so 1.0 is exactly 2x — the same step
  // Apple Maps and Google Maps take per double-tap.
  const ZOOM_TAP_STEP = 1.0;
  // Clamp the BIAS so that followZoom + bias stays inside the visible range. Clamping the
  // bias alone lets it saturate past CAR_ZOOM_MAX, and then the first tap back the other
  // way does nothing visible — which is exactly how a zoom control earns a reputation for
  // being dead. (Build 65 shipped zoom buttons and they were pulled as "dead on the head
  // unit"; at that commit the zoom case had no direct setCamera at all.)
  const clampBias = (want: number) => {
    const { followZoom: fz, previewMulti: pv } = camInputsRef.current;
    const lo = pv ? CAR_PREVIEW_ZOOM_MIN : CAR_ZOOM_MIN;
    return Math.max(
      Math.max(-CAR_USER_ZOOM_BIAS_LIMIT, lo - fz),
      Math.min(Math.min(CAR_USER_ZOOM_BIAS_LIMIT, CAR_ZOOM_MAX - fz), want),
    );
  };
  // The camera's ACTUAL low-passed zoom, written every frame by SelfCarModel's
  // pushCam. A ref → no renders. The route trim reads it; see trimZoom.
  const camZoomRef = useRef<number | null>(null);
  // Along-route ease state for the route trim (see routeTrimEndFrac below).
  const fixEaseRef = useRef<{ key: string | null; prev: number; cur: number; at: number; gap: number } | null>(null);
  const [, setTrimTick] = useState(0);
  // Drive the route-trim ease (see routeTrimEndFrac). Navigating only, and it
  // self-suppresses once the ease has landed, so a parked or free-driving car
  // surface never ticks. NOTE: iOS suspends JS timers while the phone is locked in
  // a mount — that is fine here BY CONSTRUCTION, because easedFrac clamps at t<=1,
  // so a starved ticker degrades to the old hold-until-next-fix behaviour and can
  // never run the line past the car.
  useEffect(() => {
    if (!s.navigating) return;
    const period = TRIM_TICK_MS_PREMIUM;   // always premium (2026-08-14)
    const id = setInterval(() => {
      const f = fixEaseRef.current;
      if (!f) return;
      const now = Date.now();
      if (now - f.at >= f.gap) return;
      if (Math.abs(f.cur - f.prev) < 1e-9) return;
      setTrimTick((n) => (n + 1) & 0xffff);
    }, period);
    return () => clearInterval(id);
  }, [s.navigating, powerMode]);
  // FROZEN-CLOSURE FIX (2026-07-20) — the CarPlay half of the phone's chase-cam bug
  // (see ConvoyMapbox.tsx:1844). SelfCarModel's rAF step() loop captures ONE closure
  // at mount, so it kept calling render-#1's getCam forever. userZoomRef/camHdgRef
  // are refs and stayed live, but followZoom, followPitch, mapH and mapW were baked
  // in at first render — and at first render onLayout has NOT fired, so mapH/mapW are
  // 0 and the padding that pins the car low-and-left evaluated to all-zeros for the
  // whole session. Head-unit evidence (trip photo, build 67): the car sits near dead
  // centre instead of dropped down/left, and the speed-aware chase zoom never adapts.
  // Fix = keep the FUNCTION IDENTITY stable (so the frozen closure is harmless) and
  // read every input through a ref that is refreshed on each render.
  // mapScale rides in here for the same reason everything else does — getCam's closure
  // is frozen at mount (see the block above), and mapScale changes one render AFTER the
  // first when surfaceW arrives. Reading it off the ref is what keeps the camera anchor
  // correct on that transition instead of stuck on the pre-layout value. (2026-08-15)
  const camInputsRef = useRef({ followZoom, followPitch, mapH, mapW, previewMulti, uiScale, mapScale });
  camInputsRef.current = { followZoom, followPitch, mapH, mapW, previewMulti, uiScale, mapScale };
  const getCam = useRef(() => {
    const { followZoom: fz, followPitch: fp, mapH: h, mapW: w, previewMulti: pv, uiScale: us, mapScale: ms } = camInputsRef.current;
    // ── CREW OVERVIEW RELEASE (2026-07-29) ────────────────────────────────────
    // Jeff: "hitting the crew button on CarPlay doesn't revert back to the chase
    // cam depending on the speed — it goes to a weird 3-D view."
    // crewFit used to pin north by calling setCarNorthUp(true). That is a LATCH
    // whose only release is `useEffect(… [s.navigating])`, which CANNOT fire if you
    // were already navigating when you tapped Crew. So the 15s hold expired, the
    // lockstep took position, pitch and zoom back — and the heading stayed frozen
    // at north. A pitched chase camera facing north instead of down the road is
    // exactly the "weird 3D view", and nothing short of ending the drive cleared it.
    //
    // Derive it here instead. This assignment looks out of place in a getter, but
    // it is the only place that runs at FRAME rate: pushCam (ConvoyMapbox.tsx:822)
    // reads camHeadingOverrideRef one line after calling getCam(), and prefers it
    // over the eased heading — so the override, not getCam's own `heading`, is the
    // lever. Assigning it at render time (as before) would leave it stale between
    // store ticks.
    //
    // The hold is a TIMESTAMP COMPARISON, deliberately not a setTimeout: iOS
    // suspends JS timers while the phone is locked, which is how a phone sits in a
    // mount, so a timer-based release could strand the camera for the whole drive —
    // the same trap that once stranded the CarPlay alert modals over the map.
    // ── OVERVIEW-EXIT SNAP (2026-08-14) ─────────────────────────────────────────
    // When the crew-overview hold lapses, the chase cam takes the framing back through
    // pushCam's zoom low-pass — which is now deliberately SLOW (CAM_SMOOTH_TAU_MS 1400,
    // the GPS-noise fix), so the return from a wide overview would visibly crawl for
    // seconds and read as "stuck", which is exactly what Say Phin's video shows the old
    // recovery doing. Fire the one-shot deliberate-zoom flag on the expiry EDGE so the
    // chase zoom LANDS, same as a button press. This runs at frame rate (getCam), so the
    // edge is caught within one frame of expiring.
    const holdActive = Date.now() < camHoldUntilRef.current;
    if (camHoldWasActiveRef.current && !holdActive) zoomSnapRef.current = true;
    camHoldWasActiveRef.current = holdActive;
    camHdgOverrideRef.current = (carNorthUpRef.current || Date.now() < camHoldUntilRef.current)
      ? 0
      : undefined;
    // Retire a lapsed manual zoom, here, for the same reason the heading override is
    // derived here: this is the one place that runs at FRAME rate, so the chase cam takes
    // the framing back on the very next drawn frame. Not while a pinch is still in
    // progress. Zeroing the bias does not jump the camera — the ease in pushCam animates
    // it, exactly as it does when a crew overview lapses.
    if (
      zoomHoldUntilRef.current !== 0 &&
      !pinchActiveRef.current &&
      Date.now() >= zoomHoldUntilRef.current
    ) {
      zoomHoldUntilRef.current = 0;
      userZoomRef.current = 0;
      zoomBaseRef.current = 0;
    }
    return {
      // followZoom + driver pinch bias, clamped. userZoomRef is read live (a ref,
      // deliberately not a dep) so a pinch takes effect on the very next frame.
      // Chase framing shares the phone's floor; the multi-route preview keeps its own,
      // lower one because fitting the whole fan-out legitimately goes wider.
      zoomLevel: Math.max(pv ? CAR_PREVIEW_ZOOM_MIN : CAR_ZOOM_MIN,
                          Math.min(CAR_ZOOM_MAX, fz + userZoomRef.current)),
      pitch: fp,
      heading: camHdgRef.current,
      // paddingTop drops the car DOWN the wide head-unit; paddingRight shifts it LEFT of
      // center so the bottom-RIGHT nav stack (banner/ETA) never collides with the car.
      // HARDENED 2026-07-24 (Jeff: "why is the car in the middle of the screen").
      // The CarPlay window sizes LATE; if onLayout delivered h=0 (or a post-OTA
      // remount missed the event), this padding collapsed to zero — camera centre
      // = screen centre = car mid-screen. Fall back to nominal CarPlay dimensions
      // instead of zero so the car is ALWAYS pinned low.
      padding: {
        // VERTICAL ANCHOR (2026-07-24) — Jeff: "get the car down a little more so it
        // is in line with the space between the turn banner and eta banner".
        // DERIVED, not a tuned fraction: Mapbox centres the camera in the inset rect,
        // so the car sits at y = (h + paddingTop)/2. Setting
        //   paddingTop = h - 2*(banner gap from the bottom)
        // puts the car exactly on that gap's centre line at ANY canvas height —
        // 240pt, 480pt, whatever the head unit reports — instead of drifting the way
        // a fixed fraction does. Clamped so a tiny/zero measurement can never push
        // the car off-screen; the old fraction is the floor.
        paddingTop: (() => {
          const H = h > 0 ? h : 240;
          // The banner stack is SCALED on Android Auto (hudScale) but this anchor was
          // a flat 54 — so the camera pinned the car to a gap line 54dp up while the
          // real banner top sat ~31dp up, leaving the car floating high on the head
          // unit (build-69 photo). Only the stack's own bottom inset is unscaled; the
          // row height and the half-gap above it shrink with the HUD, so re-derive.
          // ── THE ONE COUPLING THE MAP TRANSFORM INTRODUCES (2026-08-15) ────────
          // This gap is the ONLY quantity on this surface that mixes the two frames:
          // it positions the CAMERA (map points) against the RN-drawn banner stack
          // (dp), and since aaMapScaleFor those are no longer the same unit — one map
          // point is now `ms` dp. So the two terms convert differently:
          //   • CAR_BANNER_STACK_BOTTOM is a real dp POSITION -> divide by ms.
          //   • CAR_BANNER_GAP_SCALABLE * us is already in the map's frame, because us
          //     re-derived against the new layout (0.446 -> 0.837) and us * ms is
          //     exactly the HUD's hudScale (both are height-bound on a 2:1 panel).
          // Measured canvas: 4/0.5325 + 46*0.837 = 46.0 points, which puts the car at
          // (201+109)/2 = 155 points = 82.4dp down the panel — the same 82.5dp it sits
          // at on build 70. Leave it unconverted and the car drifts ~2dp up into the
          // banner. ms is 1 on CarPlay, so this stays the 8 + 46 = 54 it was tuned to.
          const gap = CAR_BANNER_STACK_BOTTOM / ms + CAR_BANNER_GAP_SCALABLE * us;
          const anchored = H - 2 * gap;
          return Math.round(Math.max(H * CAR_LOWER_PAD_FRAC, Math.min(H * 0.72, anchored)));
        })(),
        paddingBottom: 0,
        paddingLeft: 0,
        paddingRight: Math.round((w > 0 ? w : 400) * CAR_LEFT_PAD_FRAC),
      },
    };
  }).current;

  // COLD-START SNAP (fixes the "map opens on Europe" case). SelfCarModel's own
  // first-fix hard-snap is gated on paint AND fix; if those land in either order
  // the one-shot snap can be dropped, and a STATIONARY car emits no second fix to
  // retry it — so the camera stays at the map style's default world view. Fire an
  // instant snap here the moment BOTH paint and fix are ready (whichever lands
  // second re-runs this). animationMode 'none' = no fly-in; idempotent with
  // SelfCarModel's snap (same pose). Does NOT touch the native commit path.
  useEffect(() => {
    if (!painted || !hasFix || !cameraRef.current) return;
    try {
      cameraRef.current.setCamera({
        centerCoordinate: [lng, lat],
        heading: camHdgRef.current,
        zoomLevel: followZoom,
        pitch: followPitch,
        padding: getCam().padding,
        animationDuration: 0,
        animationMode: 'none',
      });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [painted, hasFix]);

  // Driver pinch-zoom from the CarPlay map (iOS 26). ConvoyCarPlay forwards the
  // CPMapTemplate zoom gesture onto the gesture bus; we translate the pinch scale
  // into a follow-zoom bias. SelfCarModel's per-frame getCam() reads userZoomRef
  // live, so mutating the ref is all that's needed — no imperative setCamera that
  // would fight the lockstep. `scale` is cumulative from the gesture start, so we
  // rebase on 'zoomBegin' and set bias = base + log2(scale) (Mapbox zoom is log2).
  // ── WHY PINCH DID NOTHING WHILE PARKED (fixed 2026-07-30) ──────────────────
  // Mutating userZoomRef is only half a gesture. The lockstep is what turns it into a
  // camera, and EVERY pushCam call in ConvoyMapbox sits behind an active ease —
  // step() bails at `if (!a) { raf.current = null; return; }` and bgTick at
  // `if (!a) return`. A stationary car arms no ease (no fix clears the dead-band), so
  // nothing pushes the camera at all and getCam() — which is only ever CALLED from
  // pushCam — is never consulted. Net effect: pinch was silently dead whenever the car
  // was stopped, and worked while moving because each fix armed an ease. That is
  // exactly the "pinch doesn't work on the head unit" report, and it is why crew view
  // DID work: crewFit is the one gesture that calls setCamera directly.
  //
  // So apply the gesture immediately. Only zoomLevel is set: centre, heading and pitch
  // are deliberately omitted so Mapbox keeps whatever the lockstep last set, and the
  // next eased frame pushes the same value anyway (getCam adds the same bias), so the
  // two can never disagree.
  // Set on every DRIVER-initiated zoom so pushCam lands it immediately rather than
  // low-passing it with the slow automatic-framing filter. See zoomSnapRef in SelfCarModel.
  const zoomSnapRef = useRef(false);
  // Was the crew-overview hold active on the previous frame? (expiry-edge detector)
  const camHoldWasActiveRef = useRef(false);
  const applyZoomNow = () => {
    zoomSnapRef.current = true;
    try {
      const { followZoom: fz, previewMulti: pv } = camInputsRef.current;
      cameraRef.current?.setCamera({
        zoomLevel: Math.max(
          pv ? CAR_PREVIEW_ZOOM_MIN : CAR_ZOOM_MIN,
          Math.min(CAR_ZOOM_MAX, fz + userZoomRef.current),
        ),
        animationDuration: 0,
        animationMode: 'none',
      });
    } catch {}
  };

  // ── APPLY THE CANVAS CORRECTION THE MOMENT IT IS KNOWN (2026-07-31) ─────────
  // mapW arrives from onLayout, i.e. one render AFTER the first — so aaZoomOutFor
  // changes followZoom late. On THIS surface a changed followZoom does not reach the
  // camera by itself: every pushCam sits behind an active ease and a stopped car arms
  // none (the note on applyZoomNow above — the exact trap that made pinch dead while
  // parked). Without this, a head unit that connects while the car is stationary would
  // keep the uncorrected framing until the driver pulled away. Reuses the same direct
  // setCamera the pinch uses; zoomLevel only, so centre/heading/pitch are untouched
  // and the next eased frame pushes the identical value.
  useEffect(() => {
    if (!painted || mapW <= 0) return;
    applyZoomNow();
  }, [painted, mapW]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return subscribeCarGesture((g: CarGesture) => {
      switch (g.kind) {
        case 'zoomBegin':
          pinchActiveRef.current = true;
          zoomBaseRef.current = userZoomRef.current;
          break;
        case 'zoomEnd':
          pinchActiveRef.current = false;
          break;
        case 'zoom': {
          if (!pinchActiveRef.current) {
            // TAP-ZOOM (see the note on pinchActiveRef). Direction lives in the sign of
            // velocity: +1 = one-finger double tap = in, -1 = two-finger tap = out.
            // scale is the constant 1.0 and carries nothing, so it is ignored entirely.
            const dir = (g.velocity ?? 0) >= 0 ? 1 : -1;
            userZoomRef.current = clampBias(userZoomRef.current + dir * ZOOM_TAP_STEP);
            zoomBaseRef.current = userZoomRef.current;   // a later pinch rebases from here
            camHoldUntilRef.current = 0;                 // a deliberate zoom ends crew overview
            zoomHoldUntilRef.current = Date.now() + CAR_ZOOM_HOLD_MS;
            applyZoomNow();
            break;
          }
          // Real pinch: scale is cumulative from gesture start (the host never calls
          // setScale:), so bias = base + log2(scale). Never yet observed on a head unit.
          const delta = Math.log2(Math.max(0.01, g.scale));
          userZoomRef.current = clampBias(zoomBaseRef.current + delta);
          // Pushed out on every update, so the 15 s runs from the END of the pinch.
          zoomHoldUntilRef.current = Date.now() + CAR_ZOOM_HOLD_MS;
          applyZoomNow();   // don't wait for an ease that a parked car will never arm
          break;
        }
        case 'zoomStep': {
          // The +/- map buttons on CarPlay and Android Auto. Same destination as the
          // tap-zoom path: bias the follow-zoom and push it immediately. applyZoomNow is
          // MANDATORY here, not an optimisation — every pushCam sits behind an active
          // camera ease and a stationary car arms none, which is exactly why build 65's
          // zoom buttons were pulled as "dead on the head unit" (abad793): at that commit
          // the handler only mutated the ref and waited for an ease that never came.
          userZoomRef.current = clampBias(userZoomRef.current + (g.delta || 0));
          zoomBaseRef.current = userZoomRef.current;   // a later pinch rebases from here
          camHoldUntilRef.current = 0;                 // a deliberate zoom ends crew overview
          zoomHoldUntilRef.current = Date.now() + CAR_ZOOM_HOLD_MS;
          applyZoomNow();
          break;
        }
        case 'recenter':
          userZoomRef.current = 0;
          zoomBaseRef.current = 0;
          zoomHoldUntilRef.current = 0;
          applyZoomNow();   // same reason as 'zoom' — parked, nothing else will push it
          // A recenter also cancels any crew-overview hold — the driver asked to
          // come home, so the chase cam takes back over immediately.
          camHoldUntilRef.current = 0;
          break;
        case 'compass': {
          // Mirror the PHONE compass (Jeff's ask): recenter on the car AND face
          // north, holding north-up until tapped again (or nav starts). Also
          // cancels a crew overview and resets any pinch bias, exactly like the
          // phone's recenterNow.
          //
          // ⚠ THE COMPASS DID NOTHING WHILE PARKED (Jeff via Say Phin, 2026-08-14:
          // "the compass on AA does not work, but it does work on his android phone").
          // Telemetry settles which half was broken: Android logged 29
          // `carplay-tap:car-compass` receipts, so the PRESS always arrived — the ACTION
          // was the problem. This case only mutated refs and called applyZoomNow(), and
          // applyZoomNow pushes zoomLevel ONLY. The heading override therefore had to
          // wait for the next EASED frame — and a stationary car arms no ease, so nothing
          // moved. Exactly the trap that got build 65's zoom buttons pulled as "dead on
          // the head unit" (abad793), noted a few lines above in this same file.
          //
          // Fix: compute the next state synchronously and push the heading DIRECTLY, the
          // same way applyZoomNow pushes zoom. Both directions need it — engaging north-up
          // and releasing back to heading-up are equally dead while parked.
          const nextNorthUp = !carNorthUpRef.current;
          carNorthUpRef.current = nextNorthUp;
          camHdgOverrideRef.current = nextNorthUp ? 0 : undefined;
          userZoomRef.current = 0;
          zoomBaseRef.current = 0;
          zoomHoldUntilRef.current = 0;
          camHoldUntilRef.current = 0;
          applyZoomNow();
          try {
            cameraRef.current?.setCamera({
              heading: nextNorthUp ? 0 : drawHdgRef.current,
              animationDuration: 0,
              animationMode: 'none',
            });
          } catch {}
          setCarNorthUp(nextNorthUp);
          break;
        }
        case 'crewFit': {
          // Frame self + every peer, north-up, and hold the chase cam off for 8s
          // (the lockstep re-grabs automatically when the hold expires — same
          // spirit as the phone's 20s pan timeout, shorter because a head unit
          // has no other way to dismiss the overview than waiting).
          try {
            const cs = getCarState();
            // ── RUNAWAY GUARD (2026-08-14, Say Phin's video + receipts) ─────────────
            // Three crew taps + a zoom-out mash preceded the map zooming out to a
            // ~500 km frame (Portland visible from Vancouver) and then sitting on
            // solid land-cover green for over a minute. This fit had two open doors:
            //   1. It framed EVERY peer, any distance away. A peer parked hundreds of
            //      km out — or carrying a stale/bogus position — dragged the whole
            //      overview out with it. A convoy overview is for cars driving
            //      TOGETHER; someone 500 km away is not framing information.
            //   2. The zoom floor was 3, which is CONTINENT scale.
            // Peers farther than CREW_FIT_MAX_KM from the car are excluded from the
            // fit (they still exist — the Comms list and the map still show them),
            // and without a self fix there is nothing sane to frame, so bail rather
            // than fly the camera to an arbitrary peer.
            if (!(typeof cs.selfLat === 'number' && typeof cs.selfLng === 'number')) break;
            const pts: [number, number][] = [[cs.selfLng, cs.selfLat]];
            let dropped = 0;
            for (const pr of cs.peers || []) {
              if (!(typeof pr?.lat === 'number' && typeof pr?.lng === 'number')) continue;
              const dLat = (pr.lat - cs.selfLat) * 111.32;
              const dLng = (pr.lng - cs.selfLng) * 111.32 * Math.cos((cs.selfLat * Math.PI) / 180);
              if (Math.hypot(dLat, dLng) > CREW_FIT_MAX_KM) { dropped += 1; continue; }
              pts.push([pr.lng, pr.lat]);
            }
            if (dropped > 0) { try { logEvent(`crew-fit dropped=${dropped} far peers`); } catch {} }
            // Engage the hold IMMEDIATELY — the render-time gate above only
            // recomputes on the next store tick (~1s); without this the chase cam
            // kept pushing frames over the overview and it never landed.
            camHoldUntilRef.current = Date.now() + 15000;
            lockReadyRef.current = false;
            // FACE NORTH for the duration of the overview. This deliberately does NOT
            // set the carNorthUp STATE any more: that is the compass toggle's latch,
            // and its only release is the s.navigating effect, which cannot fire if you
            // were already navigating when you tapped Crew — so the camera stayed
            // north-locked for the rest of the drive. getCam() now derives north-up
            // from camHoldUntilRef per frame, so it releases itself when the hold
            // expires and the chase cam comes back whole (heading, pitch and
            // speed-dependent zoom together).
            // Visible confirmation (also a field diagnostic: pill without zoom =
            // camera problem; no pill = the tap never arrived).
            setCarState({ crewViewUntil: Date.now() + 3000, crewViewCount: Math.max(0, pts.length - 1) });
            // EXPLICIT camera computation instead of Camera.fitBounds: fitBounds on
            // the secondary CarPlay window silently did nothing on the head unit
            // (2026-07-23 drive), while setCamera is the exact call the chase cam
            // proves every frame. Zoom from the bounds span vs the measured
            // viewport (512px Mapbox world tiles), clamped 3..15.
            let minLng = pts[0][0], maxLng = pts[0][0], minLat = pts[0][1], maxLat = pts[0][1];
            for (const [ln2, la2] of pts) {
              if (ln2 < minLng) minLng = ln2; if (ln2 > maxLng) maxLng = ln2;
              if (la2 < minLat) minLat = la2; if (la2 > maxLat) maxLat = la2;
            }
            const cLng = (minLng + maxLng) / 2, cLat = (minLat + maxLat) / 2;
            const lngSpan = Math.max(0.002, maxLng - minLng);
            const latSpan = Math.max(0.002, maxLat - minLat);
            const w = mapW > 0 ? mapW : 400, h = mapH > 0 ? mapH : 240;
            const zx = Math.log2((w * 0.75 * 360) / (512 * lngSpan));
            const zy = Math.log2((h * 0.65 * 180) / (512 * latSpan));
            // Floor 3 -> 8. Zoom 8 is a ~city-region frame — the widest a convoy
            // overview can be and still mean anything on a 213dp canvas. 3 was the
            // continent frame in the video.
            const zoom = Math.max(8, Math.min(15, Math.min(zx, zy)));
            cameraRef.current?.setCamera({
              centerCoordinate: [cLng, cLat], zoomLevel: zoom,
              pitch: 0, heading: 0, animationDuration: 600, animationMode: 'easeTo',
            });
          } catch {}
          break;
        }
        // 'zoomEnd': no fling/momentum for now — the pinched zoom simply holds.
      }
    });
  }, []);

  // Active route → GeoJSON. Only drawn when the polyline decodes to a real line.
  //
  // ⚠ MEMOISED — THIS WAS A REAL REGRESSION (2026-07-30). Jeff: "earlier today
  // CarPlay was working great but my drive home the car marker was glitching like
  // crazy." These two lines ran on EVERY render, decoding the entire polyline and
  // rebuilding the coord array from scratch. That was tolerable while CarMapView
  // only re-rendered on carStore ticks (~1-2 Hz) — and then the route-trim ticker I
  // added earlier today started re-rendering it at 12 Hz while navigating, so on a
  // 28 km route this decoded thousands of points TWELVE TIMES A SECOND. The JS
  // thread saturates and the 60 fps marker lockstep starves: the marker stutters and
  // the HUD janks, which is exactly what was reported. The trim fix was right; doing
  // it on top of an unmemoised decode was not.
  const routeLL = useMemo(() => decodePolyline(s.routePolyline), [s.routePolyline]);
  const routeCoords = useMemo(() => routeLL.map((p) => [p.longitude, p.latitude]), [routeLL]);
  const hasRoute = routeCoords.length >= 2;

  // BUFFER the green line off the car (mirror the phone): project the car onto the
  // route and TRIM the line so it starts a speed-aware lead AHEAD of the nose, with a
  // soft transparent→solid fade just past the trim so it doesn't hard-start into the
  // car. Navigating only; preview/cruise keeps the solid line.
  // Also memoised: projectOntoRoute WALKS the whole decoded line, so at 12 Hz it was
  // the second half of the same stall. It only changes when the car moves or the
  // route does — never on a trim tick.
  const routeProj = useMemo(
    () => ((s.navigating && hasFix && hasRoute) ? projectOntoRoute(lat, lng, routeLL) : null),
    [s.navigating, hasFix, hasRoute, lat, lng, routeLL],
  );
  // ONE trim for all three surfaces (2026-07-29, src/routeTrim.ts). This used to be
  // its OWN formula — clamp(10 + speed*1.1, 10, 55) — against the phone's
  // clamp(12 + speed*1.6, 30, 100): 10 m vs 30 m of clearance at a standstill. The
  // phone's floor had already been raised 12 → 30 m precisely because a short lead
  // let the line touch the marker, and the car surface never received that fix. Now
  // both call routeTrimLeadM with their own live camera zoom, so the gap is the same
  // on screen everywhere and cannot drift apart again.
  // Zoom must include the driver's pinch bias, exactly as getCam applies it — the
  // line is trimmed for the camera the driver is actually looking through.
  // ── WHICH ZOOM (2026-07-30) ───────────────────────────────────────────────
  // Same defect the phone had, same fix: followZoom is the speed-derived TARGET,
  // but pushCam low-passes the camera toward it over CAM_SMOOTH_TAU_MS. Computing
  // the gap from the target made every noisy GPS speed sample move the line start
  // at full amplitude while the camera — which filters that noise — barely moved,
  // so the line jittered against a still map. Ride the camera's ACTUAL zoom.
  // The pinch bias still has to be added: camZoom already contains it (it tracks
  // getCam, which applies userZoomRef), so do NOT add it twice here.
  const trimZoom = camZoomRef.current != null
    ? Math.max(CAR_ZOOM_MIN, Math.min(CAR_ZOOM_MAX, camZoomRef.current))
    : Math.max(CAR_ZOOM_MIN, Math.min(CAR_ZOOM_MAX, followZoom + userZoomRef.current));
  // × mapScale (2026-08-18, Say Phin's head-unit photo): routeTrimLeadM computes the
  // lead in LOGICAL screen points, but on AA the whole map is laid out at
  // surfaceW/mapScale and transformed down — so the ~76-logical-dp gap that reads
  // proportionate against the phone's 62pt car rendered as roughly TWICE the (also
  // scaled) car's length on the head unit: the ribbon visibly ended a car-length
  // behind the marker. Scaling the lead by the same factor keeps the on-screen gap
  // the same fraction of the car everywhere. mapScale is 1 on CarPlay — no change.
  const trimLeadM = routeTrimLeadM(trimZoom, lat) * mapScale;
  // TRIM RIDES THE MARKER'S EASE — see the matching block in ConvoyMapbox.tsx for the
  // full reasoning. The trim was anchored to the NEWEST fix while the marker eases
  // toward it, so the gap sawtoothed by one whole step per fix (~15dp of 76.6 at
  // 60 km/h). An anchor offset cannot fix that — only interpolating between fixes can
  // — so the line start now runs the same linear ease, over the same measured gap, on
  // the same clock as the car.
  const routeKey = s.routePolyline ?? null;
  const fm = fixEaseRef.current;
  if (routeProj && (!fm || fm.key !== routeKey || fm.cur !== routeProj.frac)) {
    const nowMs = Date.now();
    const gapMs = (fm && fm.key === routeKey) ? Math.max(300, Math.min(1600, nowMs - fm.at)) : 600;
    fixEaseRef.current = {
      key: routeKey,
      prev: (fm && fm.key === routeKey) ? easedFrac(fm, nowMs) : routeProj.frac,
      cur: routeProj.frac,
      at: nowMs,
      gap: gapMs,
    };
  } else if (!routeProj && fixEaseRef.current) {
    fixEaseRef.current = null;
  }
  const fracDrawn = (routeProj && fixEaseRef.current)
    ? easedFrac(fixEaseRef.current, Date.now())
    : (routeProj ? routeProj.frac : 0);
  const routeTrimEndFrac = routeProj
    ? Math.max(0, Math.min(0.999, fracDrawn + trimLeadM / routeProj.totalM))
    : null;
  const fadeSpanFrac = routeProj
    ? Math.max(0.0008, Math.min(0.06, (routeTrimFadeM(trimZoom, lat) * mapScale) / routeProj.totalM))
    : 0;
  // Snap the car to the line + lock its heading to the route bearing when on-route (≤60 m),
  // matching the phone — stops the low-speed position drift + heading spin. Steer the
  // camera by the SAME bearing (getCam reads camHdgRef live) so the map doesn't rotate
  // around a locked car. Off-route (> 60 m) → real GPS so you can see you've left the route.
  // Distance snap + heading gate (mirror the phone). Uses RAW s.heading for the gate (NOT
  // camHdgRef, which is set to the route bearing when snapped → would be circular). Reroute
  // detection lives on the phone off raw GPS, so this display-only un-snap can't affect it.
  const _carDistSnap = routeProj != null && routeProj.distM <= 60;
  const _carTravelHdg = typeof s.heading === 'number' ? s.heading : null;
  let _carHdgOk = true;
  if (_carDistSnap && _carTravelHdg != null && (s.speedMs || 0) >= CAR_SNAP_MOVING_MS) {
    const _hd = Math.abs(((((_carTravelHdg - routeProj!.bearing) % 360) + 540) % 360) - 180);
    _carHdgOk = carSnapHdgOkRef.current ? _hd <= CAR_SNAP_HDG_UNLOCK : _hd <= CAR_SNAP_HDG_LOCK;
  }
  carSnapHdgOkRef.current = _carDistSnap ? _carHdgOk : true;
  const carSnapped = _carDistSnap && _carHdgOk;
  // Feed the road-snap query (only when NOT route-snapped) + use a FRESH snap for the draw.
  // NAV-ONLY, mirroring the phone exactly — in free drive the car marker draws RAW GPS.
  // See the long note at ConvoyMapbox's _roadActive: off-route snapping froze and jumped
  // the marker at every tile-clipped road-fragment boundary, on BOTH surfaces.
  const _carRoadActive = !!s.navigating && !carSnapped && hasFix;
  carRoadInputsRef.current = { lat, lng, hdg: _carTravelHdg, speed: s.speedMs || 0, active: _carRoadActive };
  let carRoadDraw: { lat: number; lng: number } | null = null;
  if (_carRoadActive && carRoadSnap) {
    const _p = projectOntoRoute(lat, lng, carRoadSnap.line);
    if (_p && roadProjUsable(_p) && _p.distM <= ROAD_SNAP_RELEASE_M) carRoadDraw = { lat: _p.lat, lng: _p.lng };
  }
  // DISPLAY-ONLY: route line → nearest road (idle/off-route) → raw GPS. (Raw stays authoritative
  // for everything else — this only moves the drawn car.)
  const drawLat = carSnapped ? routeProj!.lat : (carRoadDraw ? carRoadDraw.lat : lat);
  const drawLng = carSnapped ? routeProj!.lng : (carRoadDraw ? carRoadDraw.lng : lng);
  // Drawn-vs-raw breadcrumb (8/20) — CarPlay/AA surface. Taps only.
  reportDraw(
    'car',
    hasFix ? { lat, lng } : null,
    { lat: drawLat, lng: drawLng },
    carSnapped ? 'route' : carRoadDraw ? 'road' : 'raw',
    (s0 => (typeof s0 === 'number' ? s0 : 0))((s as any).speedMs ?? (s as any).speed),
    !!s.navigating,
  );
  const drawHdg = carSnapped ? routeProj!.bearing : hdg;
  // Live copy for the compass's IMMEDIATE camera push (the gesture closure is frozen).
  drawHdgRef.current = drawHdg;
  if (carSnapped) camHdgRef.current = routeProj!.bearing;
  const buildLineFade = (solid: string, clear: string): any => {
    if (routeTrimEndFrac == null) return null;
    const s0 = Math.min(0.997, Math.max(0.0001, routeTrimEndFrac));
    const s1 = Math.min(0.999, Math.max(s0 + 0.0006, s0 + fadeSpanFrac));
    return ['interpolate', ['linear'], ['line-progress'], 0, clear, s0, clear, s1, solid, 1, solid];
  };
  // User-chosen route color (mirrored from the phone via carStore) — resolved
  // through the SAME per-kind transform the phone paints with (scenic =
  // contrast color, AI = black core), so the head unit's line matches the
  // phone exactly (tester: "CarPlay route colour differs, phone is correct").
  // s.routeKind mirrors the SELECTED route's kind; absent (old bundle) → base.
  const carBaseColor = s.routeColor || ROUTE_GREEN_CORE;
  const carRouteColor = routeColorsFor((s.routeKind as any) || 'best', carBaseColor).color;
  const coreGrad = buildLineFade(routeRgba(carRouteColor, 1), routeRgba(carRouteColor, 0));
  const glowGrad = buildLineFade(routeRgba(carRouteColor, 1), routeRgba(carRouteColor, 0));
  // MEMOISED (2026-08-16). This was a bare object literal, so every render minted a new
  // FeatureCollection; ShapeSource is a PureComponent, so it missed its shallow-compare
  // every time and re-ran toJSONString — a full JSON.stringify of the route. The 12 Hz
  // trim ticker re-renders this whole component during nav, so an UNCHANGED polyline was
  // being re-serialised 12x/sec on the car surface alone. Measured from telemetry:
  // 200-700 coordinates typical, 4,132 max — 10-116 KB per stringify.
  // routeCoords is the identity that actually matters; hasRoute is derived from it.
  const routeFC: any = useMemo(() => ({
    type: 'FeatureCollection',
    features: hasRoute
      ? [{ type: 'Feature', properties: { index: SELECTED_INDEX }, geometry: { type: 'LineString', coordinates: routeCoords } }]
      : [],
  }), [hasRoute, routeCoords]);

  // ===== Live congestion gradient (mirror of the phone) =====
  // The selected route's per-segment congestion + geometry are mirrored from the phone
  // via carStore. Build the SAME green->yellow->orange->red line-progress gradient and
  // paint it on a DEDICATED, NON-TRIMMED layer (a clone of the phone's route-sel-cong) —
  // built from the SAME coordinates the gradient indexes, so line-progress stays aligned.
  // NOTE: like the phone, the gradient must NOT share a layer with lineTrimOffset (a
  // multi-colour gradient flattens to solid when trimmed); the trimmed glow casing below
  // keeps the behind-car vanish, this untrimmed core supplies the colours.
  // ── CAR CONGESTION PROBE (2026-07-30) ──────────────────────────────────────
  // Jeff, comparing a phone shot and a CarPlay shot of the SAME moment: "see the
  // difference in the colour gradient on CarPlay — there is no red/orange."
  //
  // The rendering is NOT the suspect: both surfaces call the same
  // buildCongestionGradient, both keep the multi-colour gradient off the trimmed
  // layer (the @rnmapbox flattening trap), and the car is mirrored from
  // routes[selectedRouteIndex], which the traffic refresh replaces in place. So on
  // paper they should agree — and a photograph of a sunlit LCD is not evidence
  // enough to start changing colour code, especially with visible moiré across the
  // whole frame. Log the car's ACTUAL input mix, in the same shape as the phone's
  // congestion-probe, so one drive gives a like-for-like comparison from data.
  const congProbeKey = useRef('');
  useEffect(() => {
    const cong = (s.routeCongestion as string[] | undefined) || [];
    if (!s.navigating || cong.length === 0) return;
    const key = `${cong.length}:${s.routePolyline.slice(0, 24)}`;
    if (congProbeKey.current === key) return;      // once per route, not per tick
    congProbeKey.current = key;
    const n = (lvl: string) => cong.filter((c) => c === lvl).length;
    try {
      logEvent(
        `car-congestion n=${cong.length} coords=${(s.routeCoordinates?.length ?? 0)} ` +
        `severe=${n('severe')} heavy=${n('heavy')} moderate=${n('moderate')} ` +
        `low=${n('low')} unknown=${n('unknown')}`,
      );
    } catch {}
  }, [s.navigating, s.routeCongestion, s.routeCoordinates, s.routePolyline]);

  const carCongGradient = useMemo(() => {
    const coords = s.routeCoordinates;
    const cong = s.routeCongestion as any;
    if (!coords || coords.length < 2 || !cong || cong.length === 0) return null;
    const g = buildCongestionGradient(coords, cong, carRouteColor);
    return Array.isArray(g) ? g : (['interpolate', ['linear'], ['line-progress'], 0, g, 1, g] as any);
  }, [s.routeCoordinates, s.routeCongestion, carRouteColor]);
  // Memoised for the same reason routeLL/routeCoords/routeProj are: CarMapView
  // re-renders at ~12 Hz while navigating, and handing native a brand-new shape object
  // identity every tick re-uploads the whole route geometry. Missed by the first
  // memoisation pass; it also made the z-order symptom look flaky, because any path
  // that re-adds this source pushes its layer back to the top of the slot.
  const carCongFC: any = useMemo(() => ({
    type: 'FeatureCollection',
    features: (carCongGradient && s.routeCoordinates && s.routeCoordinates.length >= 2)
      ? [{ type: 'Feature', properties: { index: SELECTED_INDEX }, geometry: { type: 'LineString', coordinates: s.routeCoordinates } }]
      : [],
  }), [carCongGradient, s.routeCoordinates]);
  // While navigating, gap the (non-trimmed) congestion core off the car too — bake
  // the behind-car vanish + soft front fade into the gradient alpha (same s0/s1 as
  // the plain core) so the coloured line clears the nose instead of running through it.
  // Memoised — a fresh gradient ARRAY every render re-uploads the layer's paint at 12 Hz.
  const carCongGapped = useMemo(
    () => ((carCongGradient && s.navigating && routeTrimEndFrac != null)
      ? applyCarGapGradient(
          carCongGradient,
          Math.min(0.997, Math.max(0.0001, routeTrimEndFrac)),
          Math.min(0.999, Math.max(routeTrimEndFrac + 0.0006, routeTrimEndFrac + fadeSpanFrac)),
        )
      : carCongGradient),
    [carCongGradient, s.navigating, routeTrimEndFrac, fadeSpanFrac],
  );

  // Multi-route PREVIEW geometry → one feature per display route, carrying its precomputed
  // per-kind core `color` + casing `edge` (AI = black core, user-color edge) so a single
  // data-driven layer pair paints all three. lineSortKey floats the SELECTED route on top.
  const previewFC: any = {
    type: 'FeatureCollection',
    features: previewMulti
      ? (s.routes || [])
          .map((r) => {
            const coords = decodePolyline(r.polyline).map((p) => [p.longitude, p.latitude]);
            return coords.length >= 2
              ? { type: 'Feature', properties: { index: r.index, color: r.color, edge: r.edge }, geometry: { type: 'LineString', coordinates: coords } }
              : null;
          })
          .filter(Boolean)
      : [],
  };

  return (
    <MapView
      ref={carMapRef}
      // Oversized-and-scaled-back on Android Auto so Mapbox lays out in CarPlay's point
      // space; the identical StyleSheet.absoluteFill object everywhere else. This one
      // line is the whole basemap fix — see aaMapScaleFor. (2026-08-15)
      style={mapStyle}
      styleURL={styleURL}
      projection="mercator"
      // Let the GL map present at the head unit's full refresh (clamped by the panel,
      // ~60Hz max — a car display can't do 120). Only meaningful WITH the SelfCarModel
      // interpolation above; on a raw 1Hz feed it just re-renders a stale pose.
      // ALWAYS 60 (Jeff, 2026-08-14): no eco/premium split anywhere in the render path.
      preferredFramesPerSecond={60}
      scaleBarEnabled={false}
      compassEnabled={false}
      rotateEnabled={false}
      pitchEnabled={false}
      logoEnabled={false}
      attributionEnabled={false}
      onLayout={(e: any) => {
        const h = e?.nativeEvent?.layout?.height;
        if (typeof h === 'number' && h > 0 && Math.abs(h - mapH) > 1) setMapH(h);
        const w = e?.nativeEvent?.layout?.width;
        if (typeof w === 'number' && w > 0 && Math.abs(w - mapW) > 1) setMapW(w);
      }}
      // Real native iOS events (onDidFailLoadingMap is a no-op on iOS — do NOT use).
      // THREE independent signals now count as "this GL context is alive", because the
      // watchdog's question is whether it ever drew anything — not whether the whole
      // world arrived. See the header for the 8-hour retry loop that trusting only
      // `...Fully` produced.
      //   ...FrameFully  — a fully-resolved frame (renderMode == .full). Best signal.
      //   ...Frame       — ALSO fires for .partial, i.e. the map is drawing tiles as
      //                    they land. That is a working context by any definition.
      //   ...LoadingStyle— the style resolved; a context that can load a style is alive.
      onDidFinishRenderingFrameFully={markPainted}
      onDidFinishRenderingFrame={markPainted}
      // ONE TILE IS NOT A DEAD MAP. This payload carries tileId/sourceId and fires for a
      // single failed tile — a routine transient on cellular — and we were treating it as
      // total GL death and destroying the map. Only an error naming neither a tile nor a
      // source is a genuine style/load failure worth a remount.
      // ⚠ The library TYPES this as `() => void`, but it is wrong: MapView's
      // _handleOnChange does `func(payload)` (node_modules/@rnmapbox/maps/src/components/
      // MapView.tsx ~1167), so the handler really does receive the error payload with
      // tileId/sourceId. Hence the cast — the runtime contract is richer than the .d.ts.
      onMapLoadingError={(((e: any) => {
        const pl = e?.payload ?? e;
        if (pl?.tileId || pl?.sourceId) {
          // Log at most TILE_ERR_LOG_MAX rows, and only BEFORE the first paint — which is
          // the only window where a tile error tells us anything about the question this
          // telemetry exists to answer ("why did this context never come up?"). After the
          // map is alive they are routine cellular noise. Swallowing them is the point of
          // this branch; the budget only bounds how loudly we narrate it.
          if (!paintedRef.current && tileErrLogs.current < TILE_ERR_LOG_MAX) {
            tileErrLogs.current += 1;
            try { logEvent(`carplay-map-tile-err src=${pl?.sourceId ?? '-'}`); } catch {}
          }
          return;
        }
        fail('maploaderr');
      }) as unknown as () => void)}
      onDidFinishLoadingStyle={() => {
        markPainted();
        // Re-apply the StyleImport config now that the style (and its basemap
        // import) actually exists — kills the flat/unlit first paint (see the
        // styleGen comment above) — and guarantee the first visible frame is
        // pitched at the driver if nothing has painted yet.
        setStyleGen((g) => g + 1);
        if (!paintedRef.current && hasFix) {
          try {
            cameraRef.current?.setCamera({
              centerCoordinate: [lng, lat],
              zoomLevel: followZoom,
              pitch: followPitch,
              heading: followHeadingDeg,
              animationMode: 'none',
              animationDuration: 0,
            } as any);
          } catch {}
        }
      }}
    >
      {/* Standard basemap with the phone's light preset (3D buildings on). Only
          mounted for Standard; harmless to omit on satellite. `config` is cast to
          any to pass the boolean show3dObjects to native — same as the phone. */}
      {useStandard && (
        // key={styleGen}: remounted on every style load so the config re-applies
        // AFTER the basemap import exists (the flat-first-paint race fix above).
        // 3D buildings ALWAYS ON (Jeff, 2026-08-14). I briefly keyed this to powerMode as a
        // heat measure; an audit finding then pointed out it could never help CarPlay
        // (always plugged => always 'premium'), and Jeff has since removed the eco/premium
        // split outright. Reverted to unconditional so the car keeps the premium look.
        <>
          {/* showRoadLabels mirrors the phone (2026-08-18): names + shields off while
              navigating — the ribbon and the card carry the wayfinding. */}
          <Mapbox.StyleImport key={'basemap' + styleGen} id="basemap" existing config={{ lightPreset: mode, show3dObjects: !view2D, showRoadLabels: !s.navigating } as any} />
        </>
      )}

      {/* Road-snap source (Phase 2) — invisible mapbox-streets-v8 roads, queried by the
          road-snap interval above. Zero visual footprint (opacity 0), same as the phone. */}
      <VectorSource id={ROAD_SRC_ID} url="mapbox://mapbox.mapbox-streets-v8">
        <LineLayer id="car-road-query" sourceLayerID="road" style={{ lineOpacity: 0, lineWidth: 1 } as any} />
      </VectorSource>

      {/* LOCKSTEP camera — NO followUserLocation. SelfCarModel drives this camera
          imperatively (cameraRef.setCamera) on the SAME rAF tick that moves the 3D car,
          with animationMode="none" so each frame is an instant state-set (no second
          native interpolator fighting the JS tween). That pins the car to a fixed screen
          spot (bottom-middle via getCam's padding) and rotates/translates the map AROUND
          it — killing the camera stutter. defaultSettings only seeds the first frame. */}
      {/* defaultSettings SEEDS the first frame at the driver (initialCamRef, captured
          once at mount). This kills the "opens on the world map, then snaps to me" flash:
          the GL map's very first paint is already centred on the car instead of the style
          default (Atlantic/zoom-0). Safe because CarMapView only mounts with hasFix, so the
          seed is a valid location from frame 1 and never toggles undefined→set — @rnmapbox
          has nothing to fly in. followUserLocation stays off; the lockstep + cold-start snap
          own every frame after this seed (animationMode 'none' = instant, no interpolation). */}
      <Camera
        ref={cameraRef}
        defaultSettings={initialCamRef.current ?? undefined}
        followUserLocation={false}
        animationMode="none"
        animationDuration={0}
      />

      {/* Register the self 3D model for the chosen marker: the arrow GLB, or the
          per-color car. key={carModelId} remounts <Models> when the id flips. */}
      <Models key={carModelId} models={{ [carModelId]: isArrow ? GREEN_ARROW_MODEL : getVehicleModelUrl(s.selfCarColor, carLit) }} />

      {/* Top-down car PNG for the flat (not-routing) marker — the same asset and the
          same registration pattern the phone uses (ConvoyMapbox :2676). */}
      {/* Memoised: this object is handed to the native image store, and a fresh identity on
          every render (12 Hz while navigating) invites needless re-registration of every
          car photo. Two review lenses flagged it independently. */}
      <Mapbox.Images images={allMapImages} />

      {/* 3D self car + the native location feed, BOTH driven off ONE rAF-eased pose
          (SelfCarModel, reused verbatim from the phone). This is THE smoothness fix:
          it tweens selfLat/selfLng/heading between ~1Hz GPS ticks at ~60fps and feeds
          the eased point to its own <CustomLocationProvider> AND the car ModelLayer,
          so the follow camera and the 3D car glide in lockstep instead of teleporting
          per tick. Requires <Models/> above (model registration) — keep it. */}
      {hasFix && (
        <SelfCarModel
          lat={drawLat}
          lng={drawLng}
          heading={drawHdg}
          emissive={emissive}
          modelId={carModelId}
          // THE CAR SURFACE OWNS THE NATIVE FRAME PUMP. Opt-in as of 2026-08-14: the
          // phone instance also passes cameraRef, so an un-gated pump animated the
          // invisible phone map at 30fps on every screen-off CarPlay drive.
          carFramePump
          zoomSnapRef={zoomSnapRef}
          cameraRef={cameraRef}
          getCam={getCam}
          readyRef={lockReadyRef}
          camHeadingOverrideRef={camHdgOverrideRef}
          camZoomOutRef={camZoomRef}
          // PHONE PARITY (2026-07-30). Without this the dead-band expression in
          // SelfCarModel reads `(speedMs ?? 99) < SELF_CREEP_MS` = false FOREVER, so the
          // car surface was permanently on the tight 2.5 m moving band and never got the
          // 9 m parked band the phone has had since 818cc49. Standing still, every metre
          // of GPS scatter above 2.5 m eased the marker AND the camera toward the noise —
          // and screen-off makes it worse, because the 2 m-filtered mirror feed dies and
          // the coarser 5 m feeds take over. A one-word omission, not a design choice;
          // `s.speedMs` was already in scope and used for the zoom curve above.
          speedMs={s.speedMs}
          scale={selfScale}
          headingOffset={isArrow ? ARROW_MODEL_HEADING_OFFSET : undefined}
          pitchTilt={isArrow ? ARROW_MODEL_PITCH : 0}
          // Flat top-down PNG while not routing, the 3D GLB while routing — the
          // phone's rule (see carFlat above). undefined → 3D model.
          sprite={carFlat ? carFlatImg : undefined}
          // Same grey-referenced normalisation the phone uses (vehiclePngScale).
          spriteSize={carFlat ? vehiclePngScale(s.selfCarColor) : 1}
        />
      )}

      {/* Routes. PREVIEW (not navigating, 2+ options): all display routes (Best/Scenic/AI)
          drawn together per-kind via ONE data-driven casing+core pair — the SELECTED route
          full + wide, the others dimmed + thin (lineSortKey floats the selected on top).
          NAV / single route: the existing single selected ribbon below, with the speed-aware
          trim + near-car fade, exactly as before (the proven path is untouched). */}
      {previewMulti ? (
        // key=: see the note on the nav branch below. The two branches must NEVER be
        // reconciled into one another — a distinct key forces a clean unmount/mount.
        <ShapeSource key="car-routes-preview" id="car-routes-preview" shape={previewFC}>
          <LineLayer
            id="car-preview-casing"
            slot="middle"
            style={{
              lineColor: ['get', 'edge'] as any,
              lineWidth: ['case', ['==', ['get', 'index'], selIdx], 22, 16] as any,
              lineOpacity: ['case', ['==', ['get', 'index'], selIdx], 0.55, 0.4] as any,
              lineSortKey: ['case', ['==', ['get', 'index'], selIdx], 1, 0] as any,
              lineBlur: 6, lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1,
            }}
          />
          <LineLayer
            id="car-preview-core"
            slot="middle"
            style={{
              lineColor: ['get', 'color'] as any,
              lineWidth: ['case', ['==', ['get', 'index'], selIdx], 11, 7] as any,
              lineOpacity: ['case', ['==', ['get', 'index'], selIdx], 1, 0.7] as any,
              lineSortKey: ['case', ['==', ['get', 'index'], selIdx], 1, 0] as any,
              lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1,
            }}
          />
        </ShapeSource>
      ) : hasRoute ? (
        // ── key= IS LOAD-BEARING — IT IS WHAT KEEPS THE CONGESTION CORE ON TOP ────
        // d888154 made car-cong-core the LAST child of this source (phone parity) so
        // the green casing can never be re-inserted above it. That closes the order
        // WITHIN the source, but not the flip OF the source: without a key, React sees
        // one <ShapeSource> in one child position and RECONCILES the preview branch
        // INTO this one — mutating live native objects rather than replacing them.
        // The source's `id` prop changes car-routes-preview -> car-route (RNMBXSource
        // re-registers), and child 1 is mutated in place from car-preview-core (slot
        // "middle") into car-route-sel-casing (slot "top") — RNMBXLayer's id setter
        // does removeFromMap on willSet + addToMap on didSet, and with no
        // aboveLayerID/belowLayerID/layerIndex that re-add lands at LayerPosition
        // .default = the TOP of its slot. Children 2 and 3 (sel-core, cong-core) are
        // brand-new mounts in the same commit. So at 'Go' the casing is re-added to
        // slot "top" by an id mutation while the congestion core arrives by a fresh
        // mount, and their relative order is decided by native prop-application order,
        // not by JSX order. Whenever the casing wins, a 24pt lineBlur:8 lineOpacity:.55
        // brand-green wash composites over the 12pt coloured core: #FF3B30 -> olive
        // rgb(140,156,95), #FF9500 -> rgb(140,197,74), #FFD60A -> rgb(140,226,78),
        // green unchanged. Red and orange disappear, yellow survives as yellow — Jeff's
        // report word for word, three times.
        //
        // A distinct key makes the ternary a real unmount -> mount: every layer in this
        // branch is CREATED, in declaration order, with car-cong-core last. That is the
        // phone's guarantee (convoy-routes is mounted once for BOTH preview and nav —
        // showRoutes never flips at 'Go' — so its five layers are only ever added
        // together, in order). The phone needs no key because it has no branch; the car
        // needs one because it does.
        <ShapeSource key="car-route" id="car-route" shape={routeFC} lineMetrics>
          <LineLayer
            id="car-route-alts"
            slot="middle"
            filter={['!=', ['get', 'index'], SELECTED_INDEX] as any}
            style={{ lineColor: '#9AA0A6', lineWidth: 5, lineCap: 'round', lineJoin: 'round', lineOpacity: 0.85, lineEmissiveStrength: 1 }}
          />
          <LineLayer
            id="car-route-sel-casing"
            slot="top"
            filter={['==', ['get', 'index'], SELECTED_INDEX] as any}
            style={{ lineWidth: 24, lineBlur: 8, lineOpacity: 0.55, lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1, ...(glowGrad ? { lineGradient: glowGrad, lineTrimOffset: [0, routeTrimEndFrac ?? 1] } : { lineColor: carRouteColor }) }}
          />
          <LineLayer
            id="car-route-sel-core"
            slot="top"
            // Hidden when the congestion core (below) is active, so it can't paint over
            // the colours; the casing above keeps the trim/vanish.
            filter={(carCongGradient ? ['==', ['get', 'index'], -1] : ['==', ['get', 'index'], SELECTED_INDEX]) as any}
            style={{ lineWidth: 12, lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1, ...(coreGrad ? { lineGradient: coreGrad, lineTrimOffset: [0, routeTrimEndFrac ?? 1] } : { lineColor: carRouteColor }) }}
          />
          {/* ── CONGESTION CORE — MUST BE THE LAST LAYER IN *THIS* SOURCE ────────
              Jeff, three times: "the colour gradient on CarPlay does not match the
              phone — there is no red whatsoever."

              The gradient was never the problem. Running the real
              buildCongestionGradient + applyCarGapGradient over the actual logged
              drive (congestion-probe: n=256 severe=31 heavy=49) produces
              #FF3B30 in the output at EVERY trim value either surface uses — red
              was always in the expression. The bug was DRAW ORDER.

              This layer used to live in its own separate <ShapeSource> mounted after
              the route source. Mapbox orders layers within a slot by INSERTION, and
              the route source sits inside a `previewMulti ? … : hasRoute ? … : null`
              ternary — so every time that branch flips (preview→nav, a reroute, a
              route clear) the route source UNMOUNTS AND REMOUNTS, and its layers get
              re-inserted ABOVE the congestion layer, which never remounted. From that
              moment the 24pt lineBlur:8 green casing sits on top of the 12pt coloured
              core and washes it out permanently — no red, and the soft blended look in
              the head-unit photo rather than the phone's crisp bands. It also explains
              "it was fine earlier today and wrong on the drive home": order is correct
              until the first branch flip.

              The phone never had this because route-sel-cong lives INSIDE the same
              ShapeSource as the glow and is mounted last, so the two can only ever be
              re-added together, in order. Matching that structure here removes the
              whole class of bug rather than patching the symptom. */}
          <LineLayer
            id="car-cong-core"
            slot="top"
            // FILTERED off rather than unmounted when there is no congestion — a
            // conditional child would unmount the layer and re-insert it on the next
            // route with congestion, reintroducing exactly the ordering bug above.
            // Same technique the core layer uses.
            filter={(carCongGradient ? ['==', ['get', 'index'], SELECTED_INDEX] : ['==', ['get', 'index'], -1]) as any}
            style={{ lineWidth: 12, lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1, ...(carCongGapped ? { lineGradient: carCongGapped } : { lineColor: carRouteColor }) }}
          />
        </ShapeSource>
      ) : null}

      {/* PREVIEW-only congestion source. The NAV congestion core now lives inside the
          car-route ShapeSource above (see the draw-order note there); this standalone
          source remains solely for the multi-route PREVIEW branch, which has no
          per-route congestion layer of its own. Gated off during nav so the two can
          never both paint. */}
      {carCongGradient && previewMulti && (
        <ShapeSource id="car-congestion" shape={carCongFC} lineMetrics>
          <LineLayer
            id="car-cong-preview"
            slot="top"
            style={{ lineGradient: carCongGapped, lineWidth: 12, lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1 }}
          />
        </ShapeSource>
      )}

      {/* Mirrored map markers — the SAME hazards / DriveBC incidents / speed cameras /
          place pins the driver sees on the phone, reusing the phone's marker components
          verbatim (no style duplication). The phone applies the 'when active' gates before
          writing carStore, so these arrays are already the right set to draw. No press
          handlers are needed on the head unit (glanceable, and CarPlay doesn't deliver
          touches to this surface anyway). Keys are id-stable so the lockstep camera
          re-renders don't remount them. */}
      {/* Convoy peers — the crew's live positions on the head-unit map, fed warm by the
          phone mirror or cold by carDataService. Each peer draws as their ACTUAL car
          (class photo, or the GRC photo in their paint) via a GL SymbolLayer over
          registered static images — see peerImages / peerImageFor above for why this is
          a symbol and not the MarkerView the phone uses. Kept in the 'top' slot so a
          car never hides under the route ribbon. */}
      {(s.peers || []).some((p) => typeof p.lat === 'number' && typeof p.lng === 'number') && (
        <ShapeSource
          id="car-peers"
          shape={{
            type: 'FeatureCollection',
            features: (s.peers || [])
              .filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number')
              .map((p, i) => ({
                type: 'Feature' as const,
                // NUMERIC id (2026-07-24). This was `id: p.id` — a peer UUID STRING.
                // The layer had never rendered (car peers were always empty, see the
                // map.tsx crew feed), so nobody hit it; the moment real peers arrived
                // the native shape conversion threw an ObjC exception inside
                // performVoidMethodInvocation and the app SIGABRTed on launch.
                // Mapbox feature ids must be numeric; nothing here uses feature-state,
                // so the index is fine.
                id: i,
                properties: {
                  parked: p.status === 'parked' ? 1 : 0,
                  ...peerImageFor(p, uiScale),
                  // ⚠ An ABSENT heading falls back to 0 = due north. The comment here used
                  // to claim it kept the last known value; it does not, and the store has no
                  // per-peer history to keep. Accepted because the feed sends a heading
                  // whenever it sends a position, so this only bites a peer whose very first
                  // fix lacks one — pointing north for a tick is better than not drawing a
                  // car. Do NOT restate this as "last known" without adding that history.
                  hdg: typeof p.heading === 'number' && Number.isFinite(p.heading) ? p.heading : 0,
                },
                geometry: { type: 'Point' as const, coordinates: [p.lng as number, p.lat as number] },
              })),
          } as any}
        >
          <SymbolLayer
            id="car-peer-cars"
            slot="top"
            style={{
              iconImage: ['get', 'img'] as any,
              iconSize: ['get', 'size'] as any,
              // MAP alignment for both, so a peer's car points down the road it is
              // actually driving and stays glued to the tarmac as the chase camera
              // rotates — screen alignment would leave them facing a fixed screen
              // direction, which is what makes a marker read as a sticker.
              iconRotate: ['get', 'hdg'] as any,
              iconRotationAlignment: 'map',
              iconPitchAlignment: 'map',
              // Cars must never be dropped for crowding: two peers stopped at the same
              // light is normal and losing one of them looks like the crew feed broke.
              iconAllowOverlap: true,
              iconIgnorePlacement: true,
              // Same 0.45 parked dim the circle had, and the same rule the phone uses.
              iconOpacity: ['case', ['==', ['get', 'parked'], 1], 0.45, 1] as any,
              // REQUIRED, same as every other GL layer on this surface: Standard's
              // night/dusk light preset renders unlit layers near-black — the original
              // "hazards are black" bug. A car photo silently turning into a dark blob
              // at dusk would be worse than the dot it replaced.
              iconEmissiveStrength: 1,
            } as any}
          />
        </ShapeSource>
      )}

      {(s.roadEvents || []).map((e) => (
        <IncidentMarker key={'inc_' + e.id} event={e} scale={0.72} />
      ))}
      {(s.hazards || []).map((h) => (
        <HazardMarker key={'hz_' + h.id} hazard={h as any} />
      ))}
      {(s.speedCameras || []).map((c) => (
        <CameraMarker key={'cam_' + c.id} lat={c.lat} lng={c.lng} />
      ))}
      {(s.places || []).map((p, i) => (
        <PlaceMarker key={'pl_' + p.id} place={p as any} index={i} scale={0.72} />
      ))}
    </MapView>
  );
}
