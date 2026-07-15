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
import { StyleSheet } from 'react-native';
import Mapbox, {
  MapView,
  Camera,
  ShapeSource,
  LineLayer,
  CircleLayer,
  VectorSource,
  Models,
} from '@rnmapbox/maps';
import { useCarStore, subscribeCarGesture, type CarGesture } from './carStore';
import { buildCongestionGradient } from '../mapboxDirections';
import { usePowerMode } from '../powerMode';
import { getVehicleModelUrl, getVehicleModelKey } from '../vehicleAssets';
import {
  CAR_EMISSIVE_BY_MODE,
  ROUTE_GREEN_CORE,
  routeRgba,
  chaseZoom,
  chasePitch,
  kmhFromMs,
  decodePolyline,
  SelfCarModel,
  projectOntoRoute,
  carModelScale,
  applyCarGapGradient,
  GREEN_ARROW_MODEL,
  ARROW_MODEL_ID,
  ARROW_MODEL_PITCH,
  CARPLAY_ARROW_SCALE,
  ARROW_MODEL_HEADING_OFFSET,
  HazardMarker,
  CameraMarker,
  IncidentMarker,
  PlaceMarker,
  ROAD_SRC_ID,
  ROAD_SNAP_LOCK_M,
  ROAD_SNAP_RELEASE_M,
  ROAD_SNAP_QUERY_MS,
  ROAD_SNAP_MOVING_MS,
  ROAD_SNAP_CROSS_DEG,
} from '../ConvoyMapbox';
import { nearestRoadLine, roadHeadingOff, type LatLng as RoadLatLng } from '../roadSnap';

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
const CAR_ZOOM_MIN = 3;
const CAR_ZOOM_MAX = 20;

// Top padding as a fraction of map height — pins the car near the BOTTOM-MIDDLE of the
// head unit (larger = lower on screen). Applied every frame via getCam, nav AND cruise.
// Bumped 0.42 → 0.52 (CarPlay only, tilt unchanged): drops the car a bit lower on the wide
// head-unit so more road/horizon reads ahead of it, matching the phone's forward view.
const CAR_LOWER_PAD_FRAC = 0.52;
// Shift the pinned car LEFT of center (fraction of map width, applied as camera
// paddingRight → the car moves left by ~half this). 0.22 sat it near the left
// speed-limit chip; 0.08 centres it in the open gap BETWEEN the bottom-left HUD
// (speed/limit) and the bottom-right nav banner — still biased just enough left
// that it never collides with the banner. OTA-tunable.
const CAR_LEFT_PAD_FRAC = 0.08;
// Cache miss on a cold bg JS context can leave mapMode undefined → fall back to the
// phone's default look ('dusk'), so the car never shows a bare default style.
const DEFAULT_MODE = 'dusk';
// Positive-frame watchdog: if the GL map hasn't painted a real frame within this
// window after mount, report failure via onGLError — the parent then REMOUNTS this
// component with a fresh GL context (the 3D-100% retry; there is no 2D fallback).
// The secondary CarPlay window can leave the Metal map silently blank, and
// rnmapbox's onDidFailLoadingMap is a DEAD event on iOS — so we trust a POSITIVE
// paint signal (onDidFinishRenderingFrameFully) and treat its absence as failure,
// rather than waiting for an error that never comes. Retries (attempt > 0) get a
// wider window — a slow head-unit boot shouldn't churn contexts back to back.
const PAINT_WATCHDOG_MS = 6000;
const RETRY_WATCHDOG_MS = 9000;
// Route-snap heading gate (Phase 1 road-snap) — mirrors the phone (ConvoyMapbox). In
// addition to the ≤60 m distance test, the route bearing must be within tolerance of the
// travel heading, so a turn onto a parallel/cross street un-snaps the car to raw GPS.
// Hysteresis (lock 45° / release 60°) avoids flicker; skipped below ~walking speed.
const CAR_SNAP_HDG_LOCK = 45;
const CAR_SNAP_HDG_UNLOCK = 60;
const CAR_SNAP_MOVING_MS = 1.5;

type Props = {
  // Called when the GL map fails or never paints on the CarPlay window, so the
  // parent (CarSurface) can schedule a REMOUNT retry. Driven by onMapLoadingError
  // AND the positive-frame watchdog below (NOT onDidFailLoadingMap — dead on iOS).
  onGLError?: () => void;
  // Which retry this mount is (0 = first). Retries widen the paint watchdog.
  attempt?: number;
};

export default function CarMapView({ onGLError, attempt = 0 }: Props) {
  const s = useCarStore();
  const powerMode = usePowerMode(); // premium (plugged) → 60fps; eco (unplugged) → 30fps
  const [mapH, setMapH] = useState(0);
  const [mapW, setMapW] = useState(0);

  // Frame watchdog state. paintedRef flips on the first real rendered frame;
  // firedRef ensures onGLError fires at most once. The map can never get stuck
  // blank: either it paints (watchdog cleared) or the timeout demotes to static.
  const paintedRef = useRef(false);
  const firedRef = useRef(false);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `painted` (state, not just the ref) so the FIRST rendered frame forces a
  // re-render — the cold-start snap effect below + lockReadyRef both re-derive.
  const [painted, setPainted] = useState(false);

  const fail = () => {
    if (firedRef.current || paintedRef.current) return;
    firedRef.current = true;
    onGLError?.();
  };
  const markPainted = () => {
    if (paintedRef.current) return; // first frame only
    paintedRef.current = true;
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    setPainted(true);
  };

  useEffect(() => {
    // Start the watchdog from MOUNT (after the CarPlay handshake), not connect.
    watchdogRef.current = setTimeout(() => {
      if (!paintedRef.current) fail();
    }, attempt > 0 ? RETRY_WATCHDOG_MS : PAINT_WATCHDOG_MS);
    return () => { if (watchdogRef.current) clearTimeout(watchdogRef.current); };
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
  const carModelId = isArrow ? ARROW_MODEL_ID : ('convoyCar_' + getVehicleModelKey(s.selfCarColor));

  // Speed-aware zoom for BOTH nav AND cruise — chaseZoom with no turn distance is a pure
  // speed→zoom curve (city tighter, highway wider), so cruise now dynamically zooms in/out
  // with speed too. Pulled back by CAR_ZOOM_OUT so more road reads on the wide screen.
  const kmh = kmhFromMs(s.speedMs);
  const followZoom = chaseZoom(kmh, s.navigating ? s.distanceToTurnM : undefined) - CAR_ZOOM_OUT - (previewMulti ? PREVIEW_ZOOM_OUT : 0);
  const followPitch = Math.min(CAR_PITCH_MAX, (s.navigating ? chasePitch(kmh) : CRUISE_PITCH) + CAR_PITCH_BONUS);

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
  lockReadyRef.current = paintedRef.current && hasFix;
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
        if (p && p.distM <= ROAD_SNAP_RELEASE_M) return;
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
  const getCam = useCallback(() => ({
    // followZoom + driver pinch bias, clamped. userZoomRef is read live (a ref,
    // deliberately not a dep) so a pinch takes effect on the very next frame.
    zoomLevel: Math.max(CAR_ZOOM_MIN, Math.min(CAR_ZOOM_MAX, followZoom + userZoomRef.current)),
    pitch: followPitch,
    heading: camHdgRef.current,
    // paddingTop drops the car DOWN the wide head-unit; paddingRight shifts it LEFT of
    // center so the bottom-RIGHT nav stack (banner/ETA) never collides with the car.
    padding: {
      paddingTop: mapH > 0 ? Math.round(mapH * CAR_LOWER_PAD_FRAC) : 0,
      paddingBottom: 0,
      paddingLeft: 0,
      paddingRight: mapW > 0 ? Math.round(mapW * CAR_LEFT_PAD_FRAC) : 0,
    },
  }), [followZoom, followPitch, mapH, mapW]);

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
  useEffect(() => {
    return subscribeCarGesture((g: CarGesture) => {
      switch (g.kind) {
        case 'zoomBegin':
          zoomBaseRef.current = userZoomRef.current;
          break;
        case 'zoom': {
          const delta = Math.log2(Math.max(0.01, g.scale));
          userZoomRef.current = Math.max(
            -CAR_USER_ZOOM_BIAS_LIMIT,
            Math.min(CAR_USER_ZOOM_BIAS_LIMIT, zoomBaseRef.current + delta),
          );
          break;
        }
        case 'recenter':
          userZoomRef.current = 0;
          zoomBaseRef.current = 0;
          break;
        // 'zoomEnd': no fling/momentum for now — the pinched zoom simply holds.
      }
    });
  }, []);

  // Active route → GeoJSON. Only drawn when the polyline decodes to a real line.
  const routeLL = decodePolyline(s.routePolyline);
  const routeCoords = routeLL.map((p) => [p.longitude, p.latitude]);
  const hasRoute = routeCoords.length >= 2;

  // BUFFER the green line off the car (mirror the phone): project the car onto the
  // route and TRIM the line so it starts a speed-aware lead AHEAD of the nose, with a
  // soft transparent→solid fade just past the trim so it doesn't hard-start into the
  // car. Navigating only; preview/cruise keeps the solid line.
  const routeProj = (s.navigating && hasFix && hasRoute) ? projectOntoRoute(lat, lng, routeLL) : null;
  const trimLeadM = Math.max(10, Math.min(55, 10 + (s.speedMs > 0 ? s.speedMs : 0) * 1.1));
  const routeTrimEndFrac = routeProj
    ? Math.max(0, Math.min(0.999, routeProj.frac + trimLeadM / routeProj.totalM))
    : null;
  const fadeSpanFrac = routeProj ? Math.max(0.0008, Math.min(0.06, 20 / routeProj.totalM)) : 0;
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
  const _carRoadActive = !carSnapped && hasFix;
  carRoadInputsRef.current = { lat, lng, hdg: _carTravelHdg, speed: s.speedMs || 0, active: _carRoadActive };
  let carRoadDraw: { lat: number; lng: number } | null = null;
  if (_carRoadActive && carRoadSnap) {
    const _p = projectOntoRoute(lat, lng, carRoadSnap.line);
    if (_p && _p.distM <= ROAD_SNAP_RELEASE_M) carRoadDraw = { lat: _p.lat, lng: _p.lng };
  }
  // DISPLAY-ONLY: route line → nearest road (idle/off-route) → raw GPS. (Raw stays authoritative
  // for everything else — this only moves the drawn car.)
  const drawLat = carSnapped ? routeProj!.lat : (carRoadDraw ? carRoadDraw.lat : lat);
  const drawLng = carSnapped ? routeProj!.lng : (carRoadDraw ? carRoadDraw.lng : lng);
  const drawHdg = carSnapped ? routeProj!.bearing : hdg;
  if (carSnapped) camHdgRef.current = routeProj!.bearing;
  const buildLineFade = (solid: string, clear: string): any => {
    if (routeTrimEndFrac == null) return null;
    const s0 = Math.min(0.997, Math.max(0.0001, routeTrimEndFrac));
    const s1 = Math.min(0.999, Math.max(s0 + 0.0006, s0 + fadeSpanFrac));
    return ['interpolate', ['linear'], ['line-progress'], 0, clear, s0, clear, s1, solid, 1, solid];
  };
  // User-chosen route color (mirrored from the phone via carStore). Core + glow + the
  // near-car fade all derive from it; falls back to brand green.
  const carRouteColor = s.routeColor || ROUTE_GREEN_CORE;
  const coreGrad = buildLineFade(routeRgba(carRouteColor, 1), routeRgba(carRouteColor, 0));
  const glowGrad = buildLineFade(routeRgba(carRouteColor, 1), routeRgba(carRouteColor, 0));
  const routeFC: any = {
    type: 'FeatureCollection',
    features: hasRoute
      ? [{ type: 'Feature', properties: { index: SELECTED_INDEX }, geometry: { type: 'LineString', coordinates: routeCoords } }]
      : [],
  };

  // ===== Live congestion gradient (mirror of the phone) =====
  // The selected route's per-segment congestion + geometry are mirrored from the phone
  // via carStore. Build the SAME green->yellow->orange->red line-progress gradient and
  // paint it on a DEDICATED, NON-TRIMMED layer (a clone of the phone's route-sel-cong) —
  // built from the SAME coordinates the gradient indexes, so line-progress stays aligned.
  // NOTE: like the phone, the gradient must NOT share a layer with lineTrimOffset (a
  // multi-colour gradient flattens to solid when trimmed); the trimmed glow casing below
  // keeps the behind-car vanish, this untrimmed core supplies the colours.
  const carCongGradient = useMemo(() => {
    const coords = s.routeCoordinates;
    const cong = s.routeCongestion as any;
    if (!coords || coords.length < 2 || !cong || cong.length === 0) return null;
    const g = buildCongestionGradient(coords, cong, carRouteColor);
    return Array.isArray(g) ? g : (['interpolate', ['linear'], ['line-progress'], 0, g, 1, g] as any);
  }, [s.routeCoordinates, s.routeCongestion, carRouteColor]);
  const carCongFC: any = {
    type: 'FeatureCollection',
    features: (carCongGradient && s.routeCoordinates && s.routeCoordinates.length >= 2)
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: s.routeCoordinates } }]
      : [],
  };
  // While navigating, gap the (non-trimmed) congestion core off the car too — bake
  // the behind-car vanish + soft front fade into the gradient alpha (same s0/s1 as
  // the plain core) so the coloured line clears the nose instead of running through it.
  const carCongGapped = (carCongGradient && s.navigating && routeTrimEndFrac != null)
    ? applyCarGapGradient(
        carCongGradient,
        Math.min(0.997, Math.max(0.0001, routeTrimEndFrac)),
        Math.min(0.999, Math.max(routeTrimEndFrac + 0.0006, routeTrimEndFrac + fadeSpanFrac)),
      )
    : carCongGradient;

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
      style={StyleSheet.absoluteFill}
      styleURL={styleURL}
      projection="mercator"
      // Let the GL map present at the head unit's full refresh (clamped by the panel,
      // ~60Hz max — a car display can't do 120). Only meaningful WITH the SelfCarModel
      // interpolation above; on a raw 1Hz feed it just re-renders a stale pose.
      preferredFramesPerSecond={powerMode === 'premium' ? 60 : 30}
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
      // Real native iOS events (onDidFailLoadingMap is a no-op on iOS — do NOT use):
      // a rendered frame clears the watchdog; a style/tile load error triggers the
      // parent's remount-retry (fail → onGLError → fresh CarMapView).
      onDidFinishRenderingFrameFully={markPainted}
      onMapLoadingError={() => fail()}
      onDidFinishLoadingStyle={() => {
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
        <Mapbox.StyleImport key={'basemap' + styleGen} id="basemap" existing config={{ lightPreset: mode, show3dObjects: true } as any} />
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
      <Models key={carModelId} models={{ [carModelId]: isArrow ? GREEN_ARROW_MODEL : getVehicleModelUrl(s.selfCarColor) }} />

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
          cameraRef={cameraRef}
          getCam={getCam}
          readyRef={lockReadyRef}
          scale={isArrow ? CARPLAY_ARROW_SCALE : carModelScale(0.7)}
          headingOffset={isArrow ? ARROW_MODEL_HEADING_OFFSET : undefined}
          pitchTilt={isArrow ? ARROW_MODEL_PITCH : 0}
        />
      )}

      {/* Routes. PREVIEW (not navigating, 2+ options): all display routes (Best/Scenic/AI)
          drawn together per-kind via ONE data-driven casing+core pair — the SELECTED route
          full + wide, the others dimmed + thin (lineSortKey floats the selected on top).
          NAV / single route: the existing single selected ribbon below, with the speed-aware
          trim + near-car fade, exactly as before (the proven path is untouched). */}
      {previewMulti ? (
        <ShapeSource id="car-routes-preview" shape={previewFC}>
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
        <ShapeSource id="car-route" shape={routeFC} lineMetrics>
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
        </ShapeSource>
      ) : null}

      {/* CONGESTION core — the selected route's live traffic gradient, NON-TRIMMED, drawn
          ON TOP of whichever route branch is active (preview or nav). Mirrors the phone's
          route-sel-cong; the glow casing in the branches above keeps the behind-car vanish.
          Built from the SAME mirrored coordinates the gradient indexes, so it stays aligned. */}
      {carCongGradient && (
        <ShapeSource id="car-congestion" shape={carCongFC} lineMetrics>
          <LineLayer
            id="car-cong-core"
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
      {/* Convoy peers (CarPlay-standalone Wave 1) — the crew's live positions on the
          head-unit map, fed warm by the phone mirror or cold by carDataService. GL
          circles (not MarkerViews): cheap, view-sync-safe on the car window, and
          glanceable. circleEmissiveStrength is REQUIRED — Standard's night/dusk
          light preset renders unlit GL layers near-black (the "hazards are black"
          bug). Parked peers dim to a fainter pin. Drawn in the 'top' slot so dots
          never hide under the route ribbon. */}
      {(s.peers || []).some((p) => typeof p.lat === 'number' && typeof p.lng === 'number') && (
        <ShapeSource
          id="car-peers"
          shape={{
            type: 'FeatureCollection',
            features: (s.peers || [])
              .filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number')
              .map((p) => ({
                type: 'Feature' as const,
                id: p.id,
                properties: { parked: p.status === 'parked' ? 1 : 0 },
                geometry: { type: 'Point' as const, coordinates: [p.lng as number, p.lat as number] },
              })),
          } as any}
        >
          <CircleLayer
            id="car-peer-dots"
            slot="top"
            style={{
              circleRadius: 8,
              circleColor: '#2DEC86',
              circleOpacity: ['case', ['==', ['get', 'parked'], 1], 0.45, 1] as any,
              circleStrokeWidth: 2.5,
              circleStrokeColor: '#FFFFFF',
              circleStrokeOpacity: ['case', ['==', ['get', 'parked'], 1], 0.45, 1] as any,
              circlePitchAlignment: 'map',
              circleEmissiveStrength: 1,
            } as any}
          />
        </ShapeSource>
      )}

      {(s.roadEvents || []).map((e) => (
        <IncidentMarker key={'inc_' + e.id} event={e} />
      ))}
      {(s.hazards || []).map((h) => (
        <HazardMarker key={'hz_' + h.id} hazard={h as any} />
      ))}
      {(s.speedCameras || []).map((c) => (
        <CameraMarker key={'cam_' + c.id} lat={c.lat} lng={c.lng} />
      ))}
      {(s.places || []).map((p, i) => (
        <PlaceMarker key={'pl_' + p.id} place={p as any} index={i} />
      ))}
    </MapView>
  );
}
