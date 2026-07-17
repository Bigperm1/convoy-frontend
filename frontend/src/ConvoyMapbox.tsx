// ConvoyMapbox.tsx — NATIVE map (iOS/Android) built on @rnmapbox/maps (Mapbox).
//
// PARALLEL to ConvoyMap.tsx (react-native-maps / Google). This is the Mapbox
// re-implementation, built up incrementally behind a settings toggle so the
// proven Google map keeps working untouched while we port it feature-by-feature.
// map.tsx spreads the SAME props into whichever engine the toggle selects, so
// this is a literal drop-in for ConvoyMap.
//
// PORTED SO FAR:
//   • base Mapbox map — dark Standard/night (3D buildings) or satellite (hybrid)
//   • follow / chase camera — Mapbox NATIVE course-follow (smooth glide; speed/corner zoom + 45° tilt), powered by a visible LocationPuck
//   • self car puck + every peer car (rotated GR Corolla PNGs)
//   • routes — gray alternates + the SELECTED glowing GREEN ribbon, tap-to-select,
//     ETA pills, dest pin, route-preview fit-to-bounds, plus a LIVE traffic-
//     congestion gradient on the previewed route (Mapbox Directions)
//   • map overlays — community hazard / police pins, ON-ROUTE speed cameras,
//     category place pins (gas price chips / fuel badges / named places), and
//     the destination arrival-weather chip
//
// MarkerView note: unlike react-native-maps (which captured each marker's child
// view into a native bitmap — needing the Android "snapshot-settle" delay and
// hard-coded text widths to avoid clipping "$2.07" → "$2."), Mapbox MarkerView
// renders the real RN view. So all of that ceremony is gone here.
//
// NOT YET PORTED (each ships later as a FREE OTA increment; props still accepted
// and ignored for now): the maneuver turn-arrow, avatar route-snapping, and
// carrying the congestion gradient THROUGH active navigation (today it's preview-
// only — promoting it is part of the later, drive-tested Mapbox routing swap).
//
// COORDINATE ORDER: Mapbox uses [longitude, latitude] arrays (GeoJSON order) —
// the OPPOSITE of react-native-maps' { latitude, longitude }. Every coordinate
// handed to Mapbox below is [lng, lat].

import React, { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { View, Text, Image, StyleSheet, Pressable, TouchableOpacity, Platform, AppState, Alert } from "react-native";
import Mapbox, { MapView, Camera, MarkerView, ShapeSource, LineLayer, SymbolLayer, CircleLayer, Images, Image as MBXImage, UserTrackingMode, LocationPuck, Models, ModelLayer, CustomLocationProvider } from "@rnmapbox/maps";
import { nearestRoadLine, roadHeadingOff, type LatLng as RoadLatLng } from "./roadSnap";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import type { RoadEvent, RoadEventKind, RoadEventSeverity } from "./driveBcEvents";
import { getPowerMode } from "./powerMode";
import { getVehiclePngOrDefault, getVehicleModelUrl, getVehicleModelKey, CLASS_TOPDOWN } from "./vehicleAssets";
import { ClassSprite } from "./classLayers";
import { getPaintedArrowUri } from "./arrowModel";
import type { WeatherKind } from "./weatherLayer";
import { fetchMapboxCongestion, buildCongestionGradient, type CongestionLevel } from "./mapboxDirections";
import { getCarState } from "./carplay/carStore";
import { getLastLocation, setLastLocation, getSettings } from "./settings";

// 1×1 fully transparent PNG — a REAL bundled asset, not a data-URI (@rnmapbox's
// Images may not load a data-URI at runtime, which would let the default dot fall
// back). Registered as a Mapbox image and used as the LocationPuck's artwork so
// the native location layer stays MOUNTED + VISIBLE (which powers
// Camera.followUserLocation) while drawing NOTHING — the blue location dot under
// the car is gone but the chase-cam still tracks.
const EMPTY_PUCK_IMG = require("../assets/images/empty-puck.png");

type LatLng = { lat: number; lng: number };

// Peer / Hazard / UserLocation — the canonical shared map types. Relocated here from
// the retired react-native-maps engine (ConvoyMap.tsx) so this Mapbox engine is the
// single source of truth. Imported type-only by PeerModal + map.tsx.
export interface Peer {
  user_id: string;
  handle?: string;
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  carType?: string;
  carBody?: string;
  carColor?: string;
  activeColor?: string;
  topSpeed?: number;
  online_at?: string;
  // "parked" peers (full-mode, head unit disconnected) render dimmed.
  status?: "live" | "parked";
  onRoute?: React.Dispatch<any>;
}

export interface Hazard {
  id: string;
  kind: string;
  lat: number;
  lng: number;
  subtype?: string;
  confirms?: number;
  disputes?: number;
  reporter_handle?: string;
  reportedAt?: string;
}

export interface UserLocation {
  heading?: number;
  carBody?: string;
  carColor?: string;
  lat?: number;
  lng?: number;
  speed?: number;
}

// Mapbox is now the only engine. This is the single source of truth for the map
// props (the old react-native-maps ConvoyMap.tsx has been retired).
interface ConvoyMapboxProps {
  center?: { lat: number; lng: number; heading?: number } | null;
  user?: UserLocation | null;
  hideSelfMarker?: boolean;
  // How the driver draws THEMSELVES on the map: 'car' (3D GRC model, default) or
  // 'arrow' (3D green arrow), 'class' (flat top-down class sprite in a chosen
  // color). ('photo' is parked.) Mirrors settings.selfMarkerType.
  selfMarkerType?: "car" | "arrow" | "photo" | "class";
  // Paint for the 'class' sprite: PRIMARY (accent band) + SECONDARY (second
  // band) — Garage per-class colors. Both unset → the photo as-shot.
  selfClassPaint?: { primary?: string; secondary?: string };
  // Which class is active — picks the real top-down photo when one exists
  // (CLASS_TOPDOWN); otherwise the tinted silhouette placeholder renders.
  selfVehicleClass?: string;
  // Arrow appearance paint: primary = green body materials, secondary = the
  // white rim (runtime GLB recolor). Unset → the stock Hairpin arrow.
  selfArrowPaint?: { primary?: string; secondary?: string };
  mapView?: "heading_up" | "north_up";
  // Base-map mode — drives the Mapbox style + light preset directly. mapType/
  // mapDark are still accepted (shared MapEngine props) but unused by this engine.
  mapMode?: "satellite" | "dawn" | "day" | "dusk" | "night";
  mapType?: "hybrid" | "roadmap";
  mapDark?: boolean;
  peers?: Record<string, Peer> | Peer[] | null;
  leaderUserId?: string | null;
  hazards?: Hazard[] | null;
  speedCameras?: { id: string; lat: number; lng: number }[];
  // Official BC road events (DriveBC Open511) — rendered as distinct incident pins.
  roadEvents?: RoadEvent[];
  places?: { id: string; lat: number; lng: number; label: string; price?: string; isGas?: boolean; cheapest?: boolean }[];
  showPlacePins?: boolean;
  externalAlerts?: any[];
  highlightConvoy?: boolean;
  destination?: LatLng | null;
  destWeather?: { kind: WeatherKind; temp: string } | null;
  // Mid-drive reroute OFFER pill (Google-style inline alternate): anchored at the
  // point where the offer route peels off the active one. Tap the pill (or the
  // blue offer line itself) → accept; ✕ → dismiss. null → nothing renders.
  offerPill?: { lat: number; lng: number; savedMin: number; arrival?: string } | null;
  onOfferAccept?: () => void;
  onOfferDismiss?: () => void;
  encodedPolyline?: string | null;
  routes?: { polyline: string; color?: string; congestion?: CongestionLevel[]; coordinates?: [number, number][] }[];
  selectedRouteIndex?: number;
  onSelectRoute?: (index: number) => void;
  followUser?: boolean;
  onUserPan?: () => void;
  navigationActive?: boolean;
  // User-chosen route-line color (base hex). Defaults to brand green.
  routeColor?: string;
  userSpeedMs?: number;
  distanceToManeuverM?: number;
  maneuverCoord?: { lat: number; lng: number } | null;
  showTraffic?: boolean;
  // Delivers the tapped coordinate AND the on-screen tap point (sx/sy, px) so the
  // caller can implement gestures like double-tap-to-drop-a-pin in SCREEN space
  // (zoom-independent). undefined if unavailable. "Just tapped" callers ignore it.
  onMapPress?: (coord?: { lat: number; lng: number; sx?: number; sy?: number }) => void;
  onMapLongPress?: (c: { lat: number; lng: number }) => void;
  onHazardPress?: (h: Hazard) => void;
  onHazardLongPress?: (h: Hazard) => void;
  onPeerPress?: (p: Peer) => void;
  onPlacePress?: (p: any) => void;
  onExternalAlertPress?: (a: any) => void;
  onRoute?: (info: any) => void;
  onMapReady?: () => void;
  // Live map bearing readout (deg) — fired when the camera heading changes, for
  // the on-map compass needle. resetNorthSignal is a monotonic counter; each
  // increment animates the camera back to north-up (heading 0).
  onHeading?: (deg: number) => void;
  resetNorthSignal?: number;
  // User zoom-button offset (in map-zoom steps) added on top of the follow zoom.
  zoomOffset?: number;
  [key: string]: any;
}

const SELF_ID = "self";

// Self-car 3D model. GLB is ~1.9 units long in its own space; common-3d treats
// units as meters, so a real GR Corolla (~4.37m) ≈ 2.3x. Bumped to 3 for map
// presence. Both of these are OTA-tunable — adjust freely after first render.
// Car size as a function of camera zoom. The model is sized in meters, so without
// this it shrinks when the route zooms out. Smooth geometric ramp (~2× per zoom
// level out) with dense 1-level stops so there are no abrupt jumps, anchored ~10 at
// the nav/follow zoom (~17), and deliberately a bit LARGER than constant size at the
// far-out end so the car reads big on the route overview. modelScale supports
// ['zoom'] expressions. All stops OTA-tunable: scale the whole column for overall
// size, raise the low-zoom (9–13) rows for "bigger when zoomed out", or the z17 row
// for the close-up size.
// DENSE half-step stops (was whole-zoom only, with a gap at 19): the model size
// jumped/popped as the camera crossed each integer zoom because linear interp
// over geometrically-spaced values kinks at every stop. Half-step stops follow
// the same ~2x-per-zoom curve closely enough that scaling reads smooth through a
// pinch. All OTA-tunable.
const CAR_MODEL_SCALE_BY_ZOOM: any = [
  "interpolate", ["linear"], ["zoom"],
  9,    [3400, 3400, 3400],
  9.5,  [2400, 2400, 2400],
  10,   [1700, 1700, 1700],
  10.5, [1180, 1180, 1180],
  11,   [820, 820, 820],
  11.5, [575, 575, 575],
  12,   [400, 400, 400],
  12.5, [280, 280, 280],
  13,   [195, 195, 195],
  13.5, [153, 153, 153],
  14,   [120, 120, 120],
  14.5, [85, 85, 85],
  15,   [60, 60, 60],
  15.5, [42, 42, 42],
  16,   [29, 29, 29],
  16.5, [19.5, 19.5, 19.5],
  17,   [13, 13, 13],
  17.5, [9.2, 9.2, 9.2],
  18,   [6.5, 6.5, 6.5],
  18.5, [4.6, 4.6, 4.6],
  19,   [3.2, 3.2, 3.2],
  19.5, [2.3, 2.3, 2.3],
  20,   [1.6, 1.6, 1.6],
];
// SELF-CAR SIZE KNOB (OTA). The switch to modelType "common-3d" renders the car
// visibly larger on-screen than the old "location-indicator" did, so the table
// above now reads too big. Rather than re-tune every stop, scale the whole curve
// by one factor: lower = smaller. 1.0 == the (too-big) table above. The map uses
// CAR_MODEL_SCALE_SIZED below — adjust CAR_SIZE and OTA to resize.
const CAR_SIZE = 1.00;
// Build the model-scale zoom curve at a given size multiplier (lower = smaller). The
// phone uses CAR_SIZE; CarPlay passes a smaller value (carModelScale(0.8)) so the car
// reads a touch smaller on the head unit. Only the [x,y,z] numeric tuples are scaled —
// the expression's own sub-arrays (["linear"], ["zoom"]) and bare zoom-stop numbers
// (9, 9.5, …) pass through untouched.
export function carModelScale(size: number): any {
  return CAR_MODEL_SCALE_BY_ZOOM.map((v: any) =>
    Array.isArray(v) && v.every((n: any) => typeof n === "number")
      ? v.map((n: number) => Math.round(n * size * 100) / 100)
      : v,
  );
}
export const CAR_MODEL_SCALE_SIZED: any = carModelScale(CAR_SIZE);
// Continuous car scale driven from the LIVE camera zoom (see onCameraChanged),
// instead of handing Mapbox the zoom-expression above — that snapped the model
// size at integer zooms (not smooth). Geometric (log-space) interpolation
// through the SAME stops: passes through every tuned value but ramps smoothly.
const CAR_SCALE_STOPS: [number, number][] = [
  [9, 3400], [10, 1700], [11, 820], [12, 400], [13, 195],
  [14, 120], [15, 60], [16, 29], [17, 13], [18, 6.5], [20, 1.6],
];
function carScaleForZoom(z: number): number {
  const s = CAR_SCALE_STOPS;
  if (!Number.isFinite(z)) return 10;
  if (z <= s[0][0]) return s[0][1];
  if (z >= s[s.length - 1][0]) return s[s.length - 1][1];
  for (let i = 0; i < s.length - 1; i++) {
    const [z1, v1] = s[i]; const [z2, v2] = s[i + 1];
    if (z >= z1 && z <= z2) {
      const t = (z - z1) / (z2 - z1);
      return v1 * Math.pow(v2 / v1, t); // geometric → smooth slope, no kinks
    }
  }
  return s[s.length - 1][1];
}
export const CAR_MODEL_HEADING_OFFSET = 90; // deg. The GLB exports facing 90° off (sideways across the road),
// so we rotate it +90 to point along the direction of travel. If after this the car points exactly
// BACKWARDS, flip to 270; if it's still sideways the other way, that means -90 didn't apply — but 90/270
// are the two real candidates (the model is a constant 90° off, not a sign error).

// ── Green arrow avatar (selfMarkerType === 'arrow') ──────────────────────────
// The user can choose a 3D green arrow instead of their car (Garage → Map Appearance).
// BUNDLED with the JS (require → ships inside every OTA/build) — NOT fetched from
// a CDN. The remote-URL approach left one unverifiable link: whether the device's
// Mapbox engine actually fetched the new GLB at runtime (the 07-11 "arrow never
// changes" incident). A 1.9 KB asset has no business being remote; Metro bundles
// .glb (assetExts) and <Models> resolves require() natively, so the model now
// updates in lockstep with the JS, atomically. v3 is a 3D BEVELED chevron (raised
// green pyramid + white base rim) verified in a GLB viewer: proper Waze-style
// chevron, vivid brand green. KEY FIX vs v1/v2: #2DEC86 baked as sRGB→LINEAR
// ([0.026,0.839,0.238]) — raw sRGB rendered washed-out pale (the "wrong green").
// v9 — the tilt is FINALLY correct because it was VERIFIED IN THE iOS SIMULATOR
// against the real @rnmapbox renderer (not a desktop GLB viewer that mispredicts
// orientation, and not baked into the mesh which composed unpredictably with
// Mapbox's own transform). The model is now FLAT (green-arrow-v9.glb = the v6
// flush-white-body + green-inset construction, no baked tilt), and the standing
// lean is applied at render time via Mapbox's modelRotation X = ARROW_MODEL_PITCH.
// Ground truth from the sim: POSITIVE modelRotation-X stands the arrow UP to face
// the chase camera (tip forward) — the Waze stance. +52° faces the camera cleanly
// across the whole nav pitch band (city 48° → highway 60°); verified at both.
export const GREEN_ARROW_MODEL = require("../assets/models/green-arrow-v10.glb");
export const ARROW_MODEL_ID = "convoyArrow11"; // bundled-asset registration — fresh id per geometry change.
export const ARROW_MODEL_HEADING_OFFSET = 0; // arrow modelled pointing +Y (forward). The car needs +90 (it exports sideways); a +Y arrow needs 0.
// Lean applied via modelRotation X (NOT baked into the mesh). DIRECTION (sim ground
// truth): HIGHER = nose tips forward-DOWN toward the road; LOWER = nose rears UP
// toward the sky. (52° read as nose-up ~45°; 30° nearly vertical; 75° Waze
// diving-forward.) 90° lays the arrow FLAT — parallel with the ground, a chevron
// lying on the road pointing forward, 3D bevel still readable. Sim-verified sweep
// 30/52/75/85/90 in the iOS sim against the real @rnmapbox render. OTA-tunable.
export const ARROW_MODEL_PITCH = 90;
// v9 max extent ≈1.34 — 1.6 reads present-but-not-oversized on the phone (was 1.9, a
// touch too big per drive feedback 2026-07-11). CarPlay uses its OWN smaller scale
// (CARPLAY_ARROW_SCALE) since its tighter camera renders the same value much larger. OTA-tunable.
export const ARROW_MODEL_SCALE: any = carModelScale(1.6);
// CarPlay self-arrow scale — the head-unit camera sits tighter than the phone, so the shared
// phone scale rendered the arrow enormous (drive feedback 2026-07-11). 1.0 brings it in line with
// the CarPlay car (carModelScale(0.7)) at a sane arrow/car ratio. OTA-tunable.
export const CARPLAY_ARROW_SCALE: any = carModelScale(1.0);
// Self-marker jitter dead-band: when a new GPS fix is within SELF_DEADBAND_M meters AND
// SELF_DEADBAND_HDG degrees of the current drawn pose, the marker HOLDS instead of easing
// toward it — absorbs stationary GPS noise so the puck stops wandering when idle/slow.
// Sustained movement accumulates past the band (compared to the held pose, not the last
// fix) so it always catches up; genuine turns (heading delta) and jumps (already hard-
// snapped) animate normally. OTA-tunable.
const SELF_DEADBAND_M = 2.5;
const SELF_DEADBAND_HDG = 8;
// Phase-2 road-snap tuning. The invisible mapbox-streets-v8 road source id (shared by both
// surfaces); how close a road must be to snap (lock)/stay snapped (release, hysteresis); how
// often to re-query the road tiles when NOT route-snapped; and the max cross-street angle
// allowed while moving (so we don't snap onto a road we're only driving over). OTA-tunable.
export const ROAD_SRC_ID = "convoy-roads";
export const ROAD_SNAP_LOCK_M = 22;
export const ROAD_SNAP_RELEASE_M = 34;
export const ROAD_SNAP_QUERY_MS = 1400;
export const ROAD_SNAP_MOVING_MS = 1.5; // ~5.4 km/h — above this, apply the cross-street heading filter
export const ROAD_SNAP_CROSS_DEG = 55;  // reject a nearest road whose bearing is more perpendicular than this to travel
// Self-illumination for the 3D car per light preset. ALL modes now render the
// car fully self-lit (1.0) — the same dusk/dark-tint bypass the arrow uses — so
// the paint color stays vivid instead of being washed dark by the scene light
// (user request 2026-07-11). Unlike the flat-shaded arrow, the car GLBs carry
// baked texture shading, so they keep their 3D depth even without scene light.
// CarMapView reads this same map, so CarPlay stays in lockstep with the phone.
// 0 = fully scene-lit, 1 = fully self-lit. Per-mode entries kept for OTA tuning.
export const CAR_EMISSIVE_BY_MODE: Record<string, number> = {
  satellite: 1.0,
  day: 1.0,
  dusk: 1.0,
  dawn: 1.0,
  night: 1.0,
};

// ----- Marker icon assets (shared with the Google engine) -----
const HAZARD_ICONS: Record<string, any> = {
  police: require("../assets/images/police.png"),
};
const HAZARD_ICON_DEFAULT = require("../assets/images/hazard.png");
const CAMERA_ICON = require("../assets/images/speed_camera.png");

// Destination arrival-weather chip icon: map a WeatherKind to an icon + tint.
// `mci` selects MaterialCommunityIcons (fog) vs Ionicons (everything else).
function destWxIcon(kind: WeatherKind): { name: string; color: string; mci: boolean } {
  switch (kind) {
    case "clear-day": return { name: "sunny", color: "#FFD60A", mci: false };
    case "clear-night": return { name: "moon", color: "#DCE3F0", mci: false };
    case "partly-day": return { name: "partly-sunny", color: "#FFD60A", mci: false };
    case "partly-night": return { name: "cloudy-night", color: "#DCE3F0", mci: false };
    case "cloudy": return { name: "cloud", color: "#AEB4BD", mci: false };
    case "fog": return { name: "weather-fog", color: "#AEB4BD", mci: true };
    case "rain": return { name: "rainy", color: "#5AC8FA", mci: false };
    case "snow": return { name: "snow", color: "#EAF6FF", mci: false };
    case "thunder": return { name: "thunderstorm", color: "#FFD60A", mci: false };
    default: return { name: "partly-sunny", color: "#FFD60A", mci: false };
  }
}

// ===== Chase-cam tuning — mirrors ConvoyMap.tsx =====
// Chase-cam tilt is speed-aware: a touch flatter in the city, tilting further
// down toward the horizon at highway speed so fast driving feels more dynamic
// and shows more road ahead. OTA-tunable. (Mapbox Standard caps pitch at 60.)
// Speed→camera curve (testers at 80-100 km/h couldn't see far enough ahead for
// upcoming turns). Slow = higher angle (more top-down) + closer; faster = lower
// angle (toward the horizon, capped at Mapbox's 60) + progressively zoomed OUT so
// there's plenty of road ahead. Extended past 100 km/h up to ~180 for a THIRD tier
// (100-200 km/h keeps widening). chaseZoom/chasePitch are exported → CarPlay's
// CarMapView imports them, so phone + CarPlay stay in sync automatically.
const CHASE_PITCH_CITY = 48;      // higher angle / more top-down when slow
const CHASE_PITCH_HIGHWAY = 60;   // lower angle (horizon) at speed = more road ahead
const CHASE_ZOOM_CITY = 17;       // closest, slow
const CHASE_ZOOM_HIGHWAY = 14;    // ~100 km/h — wider than before (was 15)
const CHASE_ZOOM_FAST = 12.8;     // ~180 km/h — widest, for 100-200 cruising
const CHASE_KMH_CITY = 45;        // ≤45 km/h = closest/highest angle
const CHASE_KMH_HIGHWAY = 95;
const CHASE_KMH_FAST = 180;
const FREE_ZOOM = 15;
export const FOLLOW_ZOOM = 17;
const CORNER_ZOOM = 18.5;
const CORNER_FAR_M = 280;
const CORNER_NEAR_M = 70;
// The user zoom-button offset is added to the computed follow zoom; clamp the
// result so the minus button can widen the view well out (~10.5) without going
// uselessly far, and the plus button can't over-zoom past ~20.
const ZOOM_MIN = 10.5;
const ZOOM_MAX = 20;

// Heading-up camera bearing — we drive it ourselves instead of Mapbox's native
// FollowWithCourse, which tracks raw GPS course and updates every frame, so its
// noise makes the map WOBBLE while driving and SPIN while stopped. Instead we
// feed the map the SAME heading the car uses (user.heading), low-pass smoothed
// at the GPS rate, and FREEZE it below a creep speed. HEADING_SMOOTH_ALPHA: 1 =
// instant/no smoothing, lower = smoother but laggier in turns (OTA-tunable).
const COURSE_OFF_KMH = 3;
// Raised 0.6 → 0.72 so the heading-up bearing catches up faster through corners
// (less rotational lag) while the speed-freeze below still kills stopped-car
// spin. OTA-tunable: lower = smoother/laggier, higher = snappier/wobblier.
const HEADING_SMOOTH_ALPHA = 0.72;
// Lower-third chase framing: top padding as a fraction of map height shifts the
// followed car DOWN the screen so the driver sees more road ahead. OTA-tunable.
export const FOLLOW_LOWER_PAD_FRAC = 0.4;

// ===== Route line styling (brand green, sampled from new_logo_icons.png) =====
// The selected route is a glowing neon-green ribbon matching the app icon's route
// line: a saturated green GLOW underlay (wide + blurred) beneath a thick bright
// green CORE. Replaces the old blue/navy line.
//
// IMPORTANT — emissive: every route layer sets `lineEmissiveStrength: 1`. The
// Mapbox Standard style applies its 3D SCENE LIGHTING to custom layers, so at the
// "night" preset it DIMS them — which is why the line looked dark ("forest green",
// and the old blue looked near-black). Emissive strength 1 makes the line self-lit
// so it renders at full brightness regardless of the night lighting.
export const ROUTE_GREEN_CORE = "#2DEC86"; // bright neon-green core (the visible line)
export const ROUTE_GREEN_GLOW = "#00E070"; // saturated green halo (blurred underlay)
export const DEFAULT_ROUTE_COLOR = ROUTE_GREEN_CORE; // settings.routeColor default

// The route line color is ONE user-chosen base hex (settings.routeColor). The core,
// the blurred glow halo, and the near-car fade gradient are all derived from it —
// glow uses the same hue (the casing is blurred + 55% opacity, so it reads as a halo
// of the core in any color). Shared by the phone map AND the CarPlay map.
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = (hex || "").replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return { r: 45, g: 236, b: 134 }; // fallback to brand green
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
// "rgba(r,g,b,a)" from a hex — used to feed the near-car fade gradient (solid + clear).
export function routeRgba(hex: string, a: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

// Fully-transparent version of a colour string (hex / rgb / rgba) — used as the
// "clear" end of a fade so the line vanishes to nothing rather than to a grey or
// black tint.
function transparentColor(c: string): string {
  if (typeof c !== "string") return "rgba(0,0,0,0)";
  const s = c.trim();
  if (s[0] === "#") { const { r, g, b } = hexToRgb(s); return `rgba(${r},${g},${b},0)`; }
  const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},0)`;
  return "rgba(0,0,0,0)";
}

// Bake a speed-aware "car gap" into a line-progress COLOUR gradient: fully
// transparent from the line start to s0, a soft transparent→colour ramp to s1,
// then the gradient's ORIGINAL colours from s1 onward. This vanishes the line
// behind/at the car and fades it in just ahead of the nose — WITHOUT
// lineTrimOffset, because a multi-colour gradient flattens to solid when trimmed
// in @rnmapbox 10.3.1 (the congestion core can't be trimmed, so we gap it here
// in the gradient instead). s0/s1 are line-progress fractions (0..1). Pass-through
// for a non-gradient (constant colour) input. See [[rnmapbox-gradient-trim-conflict]].
export function applyCarGapGradient(grad: any, s0: number, s1: number): any {
  if (!Array.isArray(grad) || grad.length < 5) return grad;
  const head = grad.slice(0, 3); // ['interpolate', ['linear'], ['line-progress']]
  const body = grad.slice(3);    // [pos0, color0, pos1, color1, ...]
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < body.length; i += 2) pairs.push([Number(body[i]), body[i + 1]]);
  if (pairs.length === 0) return grad;
  const a0 = Math.max(0.0001, Math.min(0.997, s0));
  const a1 = Math.max(a0 + 1e-3, Math.min(0.999, s1));
  // Colour the source gradient shows at the fade-in edge (last stop at/below a1).
  let colorAtS1 = pairs[0][1];
  for (const [p, c] of pairs) { if (p <= a1) colorAtS1 = c; else break; }
  const clear = transparentColor(colorAtS1);
  const out: any[] = [...head, 0, clear, a0, clear, a1, colorAtS1];
  let last = a1;
  for (const [p, c] of pairs) {
    if (p > a1) { const v = p > last ? p : last + 1e-6; out.push(v, c); last = v; }
  }
  if (last < 1) out.push(1, pairs[pairs.length - 1][1]);
  return out;
}

// ===== 3-route palette (Best / Scenic / AI) =====
// AI route core is black; its EDGES (casing) are the user color.
export const ROUTE_AI_CORE = "#000000";
// Mid-drive reroute OFFER line (Google-style inline alternate): calm blue with a
// white casing — clearly not the active ribbon, clearly not a hazard.
export const ROUTE_OFFER_CORE = "#5B8DEF";
function _rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0; const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, l];
}
function _hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}
// The "Scenic" route color — auto-derived to CONTRAST the user's route color (rotate the
// hue ~160°, force a vivid S/L) so it never clashes no matter what color the user picks.
export function contrastingRouteColor(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const [h] = _rgbToHsl(r, g, b);
  return _hslToHex((h + 160) % 360, 0.82, 0.56);
}

export type RouteKind = "best" | "scenic" | "ai" | "alt" | "offer";
// Which slot a route occupies. An explicit `kind` (set by the AI-memory subsystem, P3)
// wins; otherwise positional — fastest=Best(0), first alternate=Scenic(1), the rest=alt.
export function routeKindFor(i: number, r: any): RouteKind {
  return (r?.kind as RouteKind) || (i === 0 ? "best" : i === 1 ? "scenic" : "alt");
}
// Core + edge (casing) colors for a kind, given the user's route color. Best = solid user
// color; Scenic = the contrasting hue; AI = BLACK core with user-color edges. ONE source of
// truth for both the phone map (routeFC) and the CarPlay mirror — keep them identical.
export function routeColorsFor(kind: RouteKind, routeColor: string): { color: string; edge: string } {
  if (kind === "offer") return { color: ROUTE_OFFER_CORE, edge: "#FFFFFF" }; // inline reroute offer
  const color = kind === "scenic" ? contrastingRouteColor(routeColor) : kind === "ai" ? ROUTE_AI_CORE : routeColor;
  const edge = kind === "ai" ? routeColor : color;
  return { color, edge };
}

function lerp(a: number, b: number, t: number) { const k = Math.max(0, Math.min(1, t)); return a + (b - a) * k; }
export function kmhFromMs(s: number | undefined | null) { return typeof s === "number" && Number.isFinite(s) && s >= 0 ? s * 3.6 : 0; }
function chaseZoomForSpeed(kmh: number) {
  if (kmh <= CHASE_KMH_CITY) return CHASE_ZOOM_CITY;
  if (kmh <= CHASE_KMH_HIGHWAY) return lerp(CHASE_ZOOM_CITY, CHASE_ZOOM_HIGHWAY, (kmh - CHASE_KMH_CITY) / (CHASE_KMH_HIGHWAY - CHASE_KMH_CITY));
  // Third tier: 95-180 km/h keeps widening so 100-200 cruising shows more road ahead.
  if (kmh >= CHASE_KMH_FAST) return CHASE_ZOOM_FAST;
  return lerp(CHASE_ZOOM_HIGHWAY, CHASE_ZOOM_FAST, (kmh - CHASE_KMH_HIGHWAY) / (CHASE_KMH_FAST - CHASE_KMH_HIGHWAY));
}
export function chaseZoom(kmh: number, distToManeuverM?: number) {
  const base = chaseZoomForSpeed(kmh);
  if (typeof distToManeuverM !== "number" || !Number.isFinite(distToManeuverM) || distToManeuverM <= 0) return base;
  const t = (CORNER_FAR_M - distToManeuverM) / (CORNER_FAR_M - CORNER_NEAR_M);
  return Math.max(base, lerp(base, CORNER_ZOOM, t));
}
// Speed-aware chase tilt: CITY pitch when slow, ramping to HIGHWAY pitch at speed
// (same band as the zoom ramp). Mirrors chaseZoomForSpeed.
export function chasePitch(kmh: number) {
  if (kmh <= CHASE_KMH_CITY) return CHASE_PITCH_CITY;
  if (kmh >= CHASE_KMH_HIGHWAY) return CHASE_PITCH_HIGHWAY;
  return lerp(CHASE_PITCH_CITY, CHASE_PITCH_HIGHWAY, (kmh - CHASE_KMH_CITY) / (CHASE_KMH_HIGHWAY - CHASE_KMH_CITY));
}

// Decode a Google encoded polyline → [{latitude, longitude}]. Engine-agnostic;
// copied from ConvoyMap so this file stays self-contained during the migration.
// Returns [] on bad input so a malformed polyline never crashes the map.
export function decodePolyline(encoded?: string | null): { latitude: number; longitude: number }[] {
  if (!encoded) return [];
  const points: { latitude: number; longitude: number }[] = [];
  let index = 0, lat = 0, lng = 0;
  try {
    while (index < encoded.length) {
      let b: number, shift = 0, result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
      lat += dlat;
      shift = 0; result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
      lng += dlng;
      points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
    }
  } catch { return points; }
  return points;
}

// Speed cameras are drawn ONLY within this corridor (metres) of the active route
// so they don't clutter the rest of the map — keeps the ones on the road you're
// routed along, drops ones on unrelated nearby streets.
const ROUTE_CAMERA_CORRIDOR_M = 150;

// Min distance (metres) from a point to a segment A→B, via a local
// equirectangular projection centred on the point (accurate at street scale).
function distPointToSegM(pLat: number, pLng: number, aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const cosLat = Math.cos(toRad(pLat));
  const x = (lng: number) => toRad(lng - pLng) * cosLat * R;
  const y = (lat: number) => toRad(lat - pLat) * R;
  const ax = x(aLng), ay = y(aLat), bx = x(bLng), by = y(bLat);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((0 - ax) * dx + (0 - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

// Projects (pLat,pLng) onto `coords` (origin→destination order): returns the
// nearest point ON the route, the fraction along it (0..1), the perpendicular
// distance in metres, and the total route length. Drives (a) trimming the route
// line BEHIND the car so the 3D car reads on top, and (b) SNAPPING the drawn car
// onto the line so it stays glued to the road instead of drifting on raw GPS.
// Local equirectangular metres centred on the car (accurate at street scale).
export function projectOntoRoute(pLat: number, pLng: number, coords: { latitude: number; longitude: number }[]): { frac: number; lat: number; lng: number; distM: number; totalM: number; bearing: number } | null {
  if (!coords || coords.length < 2) return null;
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const cosLat = Math.cos(toRad(pLat));
  const X = (lng: number) => toRad(lng - pLng) * cosLat * R;
  const Y = (lat: number) => toRad(lat - pLat) * R;
  const invLng = (x: number) => pLng + (x / (cosLat * R)) * (180 / Math.PI); // local metres → lng
  const invLat = (y: number) => pLat + (y / R) * (180 / Math.PI);            // local metres → lat
  let acc = 0;            // cumulative length from origin up to prev vertex
  let bestD2 = Infinity;  // nearest squared distance car→route
  let bestArc = 0;        // arc length from origin to that nearest point
  let bestX = 0, bestY = 0; // nearest point on the route, in local metres
  let bestDx = 0, bestDy = 0; // direction of the segment the projection landed on (east, north)
  let prevX = X(coords[0].longitude), prevY = Y(coords[0].latitude);
  for (let i = 1; i < coords.length; i++) {
    const cx = X(coords[i].longitude), cy = Y(coords[i].latitude);
    const dx = cx - prevX, dy = cy - prevY;
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      let t = ((0 - prevX) * dx + (0 - prevY) * dy) / (len * len); // project car (origin) onto seg
      t = Math.max(0, Math.min(1, t));
      const projX = prevX + t * dx, projY = prevY + t * dy;
      const d2 = projX * projX + projY * projY;
      if (d2 < bestD2) { bestD2 = d2; bestArc = acc + t * len; bestX = projX; bestY = projY; bestDx = dx; bestDy = dy; }
      acc += len;
    }
    prevX = cx; prevY = cy;
  }
  if (acc <= 0) return null;
  // bearing of the route AT the projected point (compass degrees, 0..360). Lets the car
  // point ALONG the line instead of spinning with jittery low-speed GPS heading.
  const bearing = (Math.atan2(bestDx, bestDy) * 180 / Math.PI + 360) % 360;
  return { frac: bestArc / acc, lat: invLat(bestY), lng: invLng(bestX), distM: Math.sqrt(bestD2), totalM: acc, bearing };
}

// Initial compass bearing (0..360) of a decoded route polyline — from its start toward the
// first point ~ROUTE_START_BEARING_M ahead, so a tiny/noisy first segment doesn't skew it.
// Used to orient the heading-up camera "route-ahead" when guidance starts from a standstill
// (no GPS course at 0 mph). Equirectangular meters are plenty accurate over this short span.
const ROUTE_START_BEARING_M = 30;
export function routeInitialBearing(line: { latitude: number; longitude: number }[]): number | null {
  if (!line || line.length < 2) return null;
  const a = line[0];
  const cosLat = Math.cos((a.latitude * Math.PI) / 180);
  const mPerDeg = 111320;
  let b = line[1];
  for (let i = 1; i < line.length; i++) {
    b = line[i];
    const dx = (b.longitude - a.longitude) * cosLat * mPerDeg;
    const dy = (b.latitude - a.latitude) * mPerDeg;
    if (Math.sqrt(dx * dx + dy * dy) >= ROUTE_START_BEARING_M) break;
  }
  const east = (b.longitude - a.longitude) * cosLat;
  const north = b.latitude - a.latitude;
  if (east === 0 && north === 0) return null;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

type CarPoint = { id: string; lat: number; lng: number; color?: string; heading?: number; leader?: boolean; peer?: Peer; status?: "live" | "parked" };
type PlacePoint = { id: string; lat: number; lng: number; label: string; price?: string; isGas?: boolean; cheapest?: boolean };

// ===== SelfCarModel =====
// The self car as a 3D GLB model (ModelLayer), but with its drawn position +
// heading INTERPOLATED between GPS fixes. Raw fixes land ~1–2×/sec, so binding the
// model straight to them makes the car teleport a car-length at a time. Here we
// ease the drawn point + rotation from where it currently is toward each new fix
// over ~the inter-fix interval (shortest-arc on heading so it never swings the
// long way), giving 60fps motion that matches the smooth native follow-camera.
// Snaps instead of animating on the very first fix and on big jumps (initial
// fix / recenter / GPS glitch) so the car never "drives" across the map.
export function SelfCarModel({ lat, lng, heading, emissive, cameraRef, getCam, readyRef, scale, modelId = "convoyCar", headingOffset = CAR_MODEL_HEADING_OFFSET, pitchTilt = 0, sprite, spriteSize = 1 }: {
  lat: number; lng: number; heading: number; emissive: number;
  // modelRotation X (deg): stand a flat marker UP toward the chase camera. 0 for the
  // car (sits flat on its wheels); the green arrow passes ARROW_MODEL_PITCH (~52).
  pitchTilt?: number;
  // Mapbox model id this layer renders. Color-specific (e.g. "convoyCar_grc_heavy_metal")
  // so a car-color change swaps the 3D model live. Default keeps the legacy fixed id.
  modelId?: string;
  // Degrees added to world heading for THIS model's forward axis. Cars default to
  // CAR_MODEL_HEADING_OFFSET (90 — the car GLB faces sideways); the green arrow passes 0.
  headingOffset?: number;
  // LOCKSTEP camera (optional): when all three are passed, SelfCarModel drives the
  // camera from the SAME 60fps tween that eases the car, so camera-center == car-pose
  // every frame and the car is pinned to a fixed screen spot (map rotates around it).
  // Omitted (e.g. the phone today) → no-op, camera unchanged. scale overrides the 3D
  // car's modelScale (CarPlay passes a smaller curve).
  cameraRef?: React.RefObject<any>;
  getCam?: () => { zoomLevel: number; pitch: number; heading: number; padding: any };
  readyRef?: React.RefObject<boolean>;
  scale?: any;
  // "Class" appearance: the name of a REGISTERED map image (the tinted top-down
  // class sprite). When set, the marker renders as a flat map-aligned SymbolLayer
  // riding the SAME eased pose instead of the 3D ModelLayer.
  sprite?: string;
  // iconSize for the sprite (real 44px photos need ~1.35 to match the 62pt
  // silhouette's on-map footprint). Default 1.
  spriteSize?: number;
}) {
  const render = useRef({ lat, lng, heading });
  const anim = useRef<{ fromLat: number; fromLng: number; fromHdg: number; toLat: number; toLng: number; toHdg: number; start: number; dur: number; armedAt: number; stepped: boolean } | null>(null);
  const raf = useRef<number | null>(null);
  const seeded = useRef(false);
  const lastFixAt = useRef(0);
  const fixGap = useRef(1000);
  const rafDead = useRef(false); // latched true while the rAF loop is paused (phone display asleep)
  const bgTimer = useRef<any>(null); // background-safe ease timer that keeps the car moving smoothly while rAF is paused (phone display off + CarPlay active)
  const lastStepAtRef = useRef(0); // wall-clock of the last REAL rAF tick — the watchdog's liveness heartbeat
  const resumeSnapUntil = useRef(0); // snap-track (don't ease) until this wall-clock after foreground
  const wasBackgrounded = useRef(false); // true once the app actually hit 'background' since last 'active'
  const [, setTick] = useState(0);
  const lastFrameRef = useRef(0); // wall-clock of the last RENDERED ease frame (eco fps cap)

  // Shortest signed angular delta a→b in degrees (−180…180].
  const angDelta = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

  // Pin the camera to the eased pose with ZERO native easing. animationMode:'none' →
  // mapboxMap.setCamera(to:) (instant state-set, no second interpolator), so camera-
  // center == car-pose on EVERY frame → the car never deviates, the world rotates/
  // translates around it. Gated on readyRef so 60fps calls never queue into a not-yet-
  // ready surface (the CarPlay blank-with-bounds hazard). No-op unless wired.
  const pushCam = (la: number, ln: number, hdg?: number) => {
    if (!cameraRef?.current || !getCam || !(readyRef?.current)) return;
    const c = getCam();
    try {
      cameraRef.current.setCamera({
        centerCoordinate: [ln, la],
        // Ride the EASED heading (render.current.heading) so the map rotates as smoothly
        // as the car turns; getCam's heading is only a fallback when none is passed.
        heading: typeof hdg === 'number' ? hdg : c.heading,
        zoomLevel: c.zoomLevel,
        pitch: c.pitch,
        padding: c.padding,
        animationDuration: 0,
        animationMode: 'none',
      });
    } catch {}
  };

  // Advance the current ease by ONE frame from a background TIMER (setInterval),
  // used only while rafDead — the phone display is asleep so requestAnimationFrame
  // is paused, but the app stays alive (background location + audio) so setInterval
  // keeps firing and the head-unit car can still move smoothly instead of snapping
  // to each ~1 Hz GPS fix. Deliberately does NOT set `a.stepped` or clear rafDead —
  // those are how the fix handler / step() detect the display waking (only a real
  // rAF tick flips them), so the timer path stays latched until the screen returns.
  const bgTick = () => {
    // HEARTBEAT GUARD (build-65 drive test, 2026-07-16): a real rAF tick within the
    // last ~150 ms means the display is awake and step() is driving — do nothing, so
    // the two drivers can never double-advance. When the phone display sleeps, rAF
    // stops stamping the heartbeat and this timer takes over WITHIN 150 ms — no
    // detector to latch, no state machine to trip. (The old design only STARTED this
    // timer after a pending-ease detector latched rafDead; on the head unit it never
    // reliably latched and the car marker froze with the screen off even though GPS
    // kept flowing — the route line kept trimming while the car sat still.)
    if (Date.now() - lastStepAtRef.current < 150) return;
    const a = anim.current;
    if (!a) return;
    const now = Date.now();
    const t = Math.min(1, (now - a.start) / a.dur);
    render.current = {
      lat: a.fromLat + (a.toLat - a.fromLat) * t,
      lng: a.fromLng + (a.toLng - a.fromLng) * t,
      heading: a.fromHdg + (a.toHdg - a.fromHdg) * t,
    };
    pushCam(render.current.lat, render.current.lng, render.current.heading);
    setTick((n) => (n + 1) & 0xffff);
    if (t >= 1) anim.current = null;
  };
  const startBgTimer = () => {
    if (bgTimer.current == null) bgTimer.current = setInterval(bgTick, 33); // ~30 fps (matches the eco frame cap)
  };
  const stopBgTimer = () => {
    if (bgTimer.current != null) { clearInterval(bgTimer.current); bgTimer.current = null; }
  };

  // ALWAYS-ON watchdog for the LOCKSTEP (CarPlay) instance: the ticker runs for the
  // whole life of the surface and no-ops behind the heartbeat while rAF is alive.
  // Phone instances (no cameraRef) keep the pure-rAF path — their display and their
  // marker sleep together, so there's nothing to hand off to.
  useEffect(() => {
    if (!cameraRef) return;
    startBgTimer();
    return stopBgTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = () => {
    rafDead.current = false; // the loop ticked → the display is awake; smooth easing is live
    lastStepAtRef.current = Date.now(); // heartbeat for the always-on car watchdog below
    const a = anim.current;
    if (!a) { raf.current = null; return; }
    a.stepped = true; // this ease has rendered ≥1 frame → the loop is alive for it
    const now = Date.now();
    const t = Math.min(1, (now - a.start) / a.dur);
    // ECO (unplugged, build 63+): cap the smooth ease to ~30fps — halves the per-frame
    // setCamera + full-component re-render (the app's single biggest thermal load) while
    // on battery. PREMIUM (plugged, and every build without expo-battery) renders every
    // frame exactly as before. The FINAL frame (t>=1) is never skipped, so the camera
    // always lands precisely and the ease completes.
    if (t < 1 && getPowerMode() === "eco" && now - lastFrameRef.current < 32) {
      raf.current = requestAnimationFrame(step);
      return;
    }
    lastFrameRef.current = now;
    render.current = {
      lat: a.fromLat + (a.toLat - a.fromLat) * t,
      lng: a.fromLng + (a.toLng - a.fromLng) * t,
      heading: a.fromHdg + (a.toHdg - a.fromHdg) * t,
    };
    pushCam(render.current.lat, render.current.lng, render.current.heading); // LOCKSTEP: camera rides the eased pose
    setTick((n) => (n + 1) & 0xffff);
    if (t < 1) {
      raf.current = requestAnimationFrame(step);
    } else {
      anim.current = null;
      raf.current = null;
    }
  };

  useEffect(() => {
    const now = Date.now();
    if (lastFixAt.current) {
      const gap = now - lastFixAt.current;
      if (gap > 80) fixGap.current = Math.max(300, Math.min(1600, gap));
    }
    lastFixAt.current = now;

    const prev = render.current;
    // First fix, or a > ~1km jump (initial fix / recenter / GPS glitch) → snap.
    const jumpDeg = Math.abs(lat - prev.lat) + Math.abs(lng - prev.lng);
    // rAF-STALL fallback (the "CarPlay map stops tracking with the phone screen
    // off" regression): the lockstep camera + 3D car ride requestAnimationFrame,
    // which iOS PAUSES when the phone display sleeps even while CarPlay is active —
    // freezing both. This effect still fires on every GPS fix regardless of rAF.
    // Detector: a PENDING ease that step() has NOT advanced a single frame
    // (`!stepped`) for longer than a few frames (`armedAt` guard) means the loop is
    // paused — step() sets stepped=true on its first tick, so on an awake screen
    // this never trips, even for a stationary car (zero-length ease still gets a
    // tick) or a same-frame GPS burst (excluded by the time guard, since step() may
    // not have ticked yet within ~16 ms). Latch it so EVERY following fix keeps
    // snapping; the probed rAF below clears the latch (via step()) the instant the
    // display wakes, resuming smooth easing.
    const pend = anim.current;
    if (pend && !pend.stepped && now - pend.armedAt > 120) {
      rafDead.current = true;
    }
    const rafStale = rafDead.current;
    // Post-foreground snap window: after returning from another app, iOS often
    // delivers a STALE cached fix first, then the fresh one. Easing between them is
    // the visible "camera plays catch-up to find the car." So for a short window
    // after foreground, SNAP every fix (camera jumps straight to the latest) instead
    // of easing through the stale→fresh pair; smooth easing resumes after.
    const inResumeSnap = now < resumeSnapUntil.current;
    // Hard-snap ONLY for genuine jumps: first fix, a teleport/GPS glitch, or the
    // post-foreground resume window. A display-asleep stall (rafStale) is NO LONGER a
    // snap — it now eases via the background timer (below) so the head unit stays
    // smooth with the phone screen off, instead of stepping to each ~1 Hz GPS fix.
    if (!seeded.current || jumpDeg > 0.01 || inResumeSnap) {
      seeded.current = true;
      render.current = { lat, lng, heading };
      anim.current = null;
      if (raf.current != null) { cancelAnimationFrame(raf.current); raf.current = null; }
      // NOTE: do NOT stop the bg watchdog here — for the lockstep (CarPlay)
      // instance it's the always-on freeze net, and killing it on a snap/recenter
      // would disarm it for the rest of the drive. anim=null + the heartbeat
      // guard make a running-but-idle timer free.
      pushCam(lat, lng, heading); // hard-snap the camera with the car (first fix / recenter / resume)
      setTick((n) => (n + 1) & 0xffff);
      // Probe: a live display ticks step() → rafDead clears → the next fix eases
      // smoothly again. While asleep the probe never fires, so the latch holds.
      if (rafStale) raf.current = requestAnimationFrame(step);
      return;
    }
    // Jitter dead-band — hold the current pose for a sub-threshold move so stationary GPS
    // noise doesn't ease the marker toward each jittery fix (the idle "roam"). Compared to
    // the HELD pose (prev = render.current), so real movement accumulates past the band and
    // still animates; a pending ease keeps running to its target. Meters via equirectangular.
    const dLatM = (lat - prev.lat) * 111320;
    const dLngM = (lng - prev.lng) * 111320 * Math.cos(prev.lat * Math.PI / 180);
    if (Math.hypot(dLatM, dLngM) < SELF_DEADBAND_M && Math.abs(angDelta(prev.heading, heading)) < SELF_DEADBAND_HDG) {
      return;
    }
    // Ease from the current drawn pose to the new fix over ~the fix interval
    // (compressed a touch so the car keeps pace instead of trailing the camera).
    anim.current = {
      fromLat: prev.lat, fromLng: prev.lng, fromHdg: prev.heading,
      toLat: lat, toLng: lng, toHdg: prev.heading + angDelta(prev.heading, heading),
      // Ease over ~the FULL inter-fix interval so the car moves CONTINUOUSLY instead
      // of reaching each fix early and pausing (the move-pause-move stutter that read
      // as "jittery"). Camera + car both ride render.current (the CustomLocationProvider
      // below), so a longer ease keeps them in lockstep — it does NOT make the car
      // trail the camera. OTA-tunable: lower = snappier but stutters, higher = smoother.
      start: now, dur: Math.max(220, fixGap.current * 1.1),
      armedAt: now, stepped: false,
    };
    if (rafStale) {
      // Phone display asleep (requestAnimationFrame paused) but CarPlay active + the app
      // alive via background location/audio → drive the ease from a background timer so
      // the head-unit car keeps moving smoothly instead of snapping to each ~1 Hz fix.
      // The probe rAF wakes step() the instant the display returns → drops the timer and
      // resumes normal 60 fps easing.
      startBgTimer();
      if (raf.current == null) raf.current = requestAnimationFrame(step);
    } else if (raf.current == null) {
      raf.current = requestAnimationFrame(step);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng, heading]);

  // Stop the loop if the car unmounts mid-animation.
  useEffect(() => () => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
    if (bgTimer.current != null) { clearInterval(bgTimer.current); bgTimer.current = null; }
  }, []);

  // Snap (not ease) to the live position after the app returns to the foreground.
  // Backgrounding (switching to another app) suspends the JS thread, so render.current
  // goes stale. Clearing `seeded` hard-snaps the FIRST fix; the ~2 s `resumeSnapUntil`
  // window then keeps snapping the next few fixes too, so a stale cached fix followed
  // by the fresh one doesn't ease (the "camera plays catch-up" the user saw). After
  // the window, smooth easing resumes.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "background") wasBackgrounded.current = true;
      if (st === "active") {
        seeded.current = false;
        // Arm the snap window ONLY after a REAL background (switching apps), not a
        // brief inactive→active (Control Center / notification shade), so normal
        // mid-drive use never snaps choppily. iOS resumes via background→inactive→
        // active, so the immediate prior state is 'inactive' — track a "was actually
        // backgrounded" flag rather than the previous state.
        if (wasBackgrounded.current) resumeSnapUntil.current = Date.now() + 2000;
        wasBackgrounded.current = false;
      }
    });
    return () => sub.remove();
  }, []);

  const r = render.current;
  return (
    <>
    {/* Feed the SMOOTH interpolated position to Mapbox's native user-location so
        followUserLocation tracks the SAME eased track the car uses. Without this
        the chase camera follows raw device GPS (~2 Hz steps) while the car
        interpolates at 60fps, so the camera stutters and the car drifts off
        centre. Now both ride the same smooth point: camera glides, car stays put. */}
    <CustomLocationProvider coordinate={[r.lng, r.lat]} heading={r.heading ?? 0} />
    <ShapeSource
      id="convoy-self-car"
      shape={{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [r.lng, r.lat] } }}
    >
      {sprite ? (
        // "Class" appearance: flat top-down sprite lying ON the map (rotation +
        // pitch aligned to the map plane) so it turns with the road exactly like
        // a car seen from above. Rides the same eased pose as the 3D model.
        <SymbolLayer
          key={sprite}
          id="convoy-self-car-model"
          slot="top"
          style={{
            iconImage: sprite,
            iconSize: spriteSize,
            iconRotate: r.heading ?? 0,
            iconRotationAlignment: "map",
            iconPitchAlignment: "map",
            iconAllowOverlap: true,
            iconIgnorePlacement: true,
            iconEmissiveStrength: 1,
          }}
        />
      ) : (
      <ModelLayer
        // key on modelId → remount when the car color changes. @rnmapbox's <Models>
        // only registers the GLB at MOUNT (RNMBXModels.addToMap; setModels is a no-op),
        // so a live color change needs BOTH <Models> and this layer to remount to swap.
        key={modelId}
        id="convoy-self-car-model"
        slot="top"
        style={{
          modelId: modelId,
          // common-3d: integrate the car into the 3D scene with depth testing so it sits
          // ON the road ABOVE the flat route line. (Tried "location-indicator" to fix the
          // car being occluded by 3D buildings — on @rnmapbox 10.3.1 it did NOT render the
          // car over the buildings AND it drew the route line over the car, so it was
          // strictly worse. Reverted; the building-occlusion fix is tracked separately.)
          modelType: "common-3d",
          // Lift the car ~10m so it clears typical (residential) building heights and
          // isn't eaten by the 3D extrusions' depth test. Mapbox shares one depth buffer
          // between models + Standard buildings, and `slot`/location-indicator can't
          // override it (rnmapbox #13049/#13428) — this vertical lift is the only OTA
          // lever. [lng_m, lat_m, altitude_m]. Tradeoff: mild float at high camera tilt;
          // OTA-tunable (raise if taller buildings still occlude, lower if it floats).
          // The flat arrow loses the shared model/line depth buffer to the slot="top"
          // route ribbon (the tall car wins at +10m; the low arrow doesn't), so the ribbon
          // drew OVER it. Lift the arrow higher than the car so it clears the ground-level
          // route line. OTA-tunable (raise if the ribbon still covers it, lower if it floats).
          modelTranslation: [0, 0, modelId === ARROW_MODEL_ID ? 16 : 10],
          modelEmissiveStrength: emissive,
          modelScale: scale ?? CAR_MODEL_SCALE_SIZED,
          modelRotation: [pitchTilt, 0, (r.heading ?? 0) + headingOffset],
          modelCastShadows: false,
          modelReceiveShadows: false,
        }}
      />
      )}
    </ShapeSource>
    </>
  );
}

// ===== Top-down "Class" sprite (placeholder art) =====
// A generic top-down vehicle silhouette tinted the user's class color —
// snapshotted into a native map image (MBXImage) for the SymbolLayer above.
// PLACEHOLDER until Jeff's per-class top-down photos land; the shape is a
// simple body + windshield/rear-glass strips so the tint reads as "paint".
// Nose points UP (icon-up = heading 0 = north under map rotation alignment).
export function TopDownClassSnap({ color }: { color: string }) {
  return (
    <View style={{ width: 34, height: 62, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: 25, height: 54, borderRadius: 10, backgroundColor: color, borderWidth: 1.5, borderColor: "rgba(0,0,0,0.6)" }}>
        {/* windshield */}
        <View style={{ position: "absolute", top: 11, left: 3, right: 3, height: 9, borderRadius: 4, backgroundColor: "rgba(10,12,14,0.6)" }} />
        {/* roof highlight */}
        <View style={{ position: "absolute", top: 23, left: 4, right: 4, height: 12, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.18)" }} />
        {/* rear glass */}
        <View style={{ position: "absolute", bottom: 7, left: 4, right: 4, height: 6, borderRadius: 3, backgroundColor: "rgba(10,12,14,0.5)" }} />
      </View>
    </View>
  );
}

// ===== CarMarker =====
// One car (self or peer) as a Mapbox MarkerView — a real RN view pinned to a
// coordinate. MarkerView draws in SCREEN space (it does not rotate with the
// map), so to make the car point up the road in heading-up we rotate the PNG by
// (carHeading − mapHeading), exactly like ConvoyMap. One code path on both
// platforms (MarkerView is screen-space on each), which also sidesteps
// react-native-maps' Android bitmap-capture sliver bug entirely.
function CarMarker({ car, mapHeading = 0, onPress }: { car: CarPoint; mapHeading?: number; onPress?: () => void }) {
  const src = getVehiclePngOrDefault(car.color);
  const heading = typeof car.heading === "number" && Number.isFinite(car.heading) ? car.heading : 0;
  const rotation = (((heading - mapHeading) % 360) + 360) % 360;
  return (
    <MarkerView coordinate={[car.lng, car.lat]} anchor={{ x: 0.5, y: 0.5 }} allowOverlap allowOverlapWithPuck>
      <Pressable onPress={() => { if (car.peer) onPress?.(); }} hitSlop={8}>
        <Image
          source={src}
          style={[styles.car, car.status === "parked" ? { opacity: 0.5 } : null, { transform: [{ rotate: `${rotation}deg` }] }]}
          resizeMode="contain"
          fadeDuration={0}
        />
      </Pressable>
    </MarkerView>
  );
}

// ===== HazardMarker =====
// Community hazard / police pin — a flat icon image (police.png for police,
// hazard.png otherwise). Tap → details; long-press → the standard hazard menu.
export function HazardMarker({ hazard, onPress, onLongPress }: { hazard: Hazard; onPress?: () => void; onLongPress?: () => void }) {
  const src = HAZARD_ICONS[hazard.kind] || HAZARD_ICON_DEFAULT;
  return (
    <MarkerView coordinate={[hazard.lng, hazard.lat]} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
      <Pressable onPress={onPress} onLongPress={onLongPress} hitSlop={6}>
        <Image source={src} style={styles.hazardIcon} resizeMode="contain" fadeDuration={0} />
      </Pressable>
    </MarkerView>
  );
}

// ===== CameraMarker =====
// Fixed speed-camera pin (OpenStreetMap). Pins only — the proximity voice alert
// is handled in map.tsx. No press handler.
export function CameraMarker({ lat, lng }: { lat: number; lng: number }) {
  // The Image is wrapped in a sized View: MarkerView positions a child view at
  // the coordinate and reads its measured size — a BARE <Image> child can
  // measure 0×0 (before the bitmap loads) and render invisibly, which is why
  // cameras alone didn't show. The explicit-size wrapper gives MarkerView a
  // stable box to place immediately. (Every other marker already wraps its
  // image in a View/Pressable, so only cameras were affected.)
  return (
    <MarkerView coordinate={[lng, lat]} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
      <View style={styles.cameraIconWrap}>
        <Image source={CAMERA_ICON} style={styles.cameraIcon} resizeMode="contain" fadeDuration={0} />
      </View>
    </MarkerView>
  );
}

// ===== IncidentMarker =====
// Official DriveBC road event (Open511) — a severity-tinted badge with a kind
// glyph, visually distinct from crew hazard PNGs so drivers can tell an official
// incident from a member report. Proximity voice alert lives in map.tsx.
const INCIDENT_ICON: Record<RoadEventKind, string> = {
  incident: "warning",
  construction: "construct",
  road: "close-circle",
  weather: "rainy",
  event: "flag",
};
const INCIDENT_KINDS: RoadEventKind[] = ["incident", "construction", "road", "weather", "event"];
function incidentColor(sev: RoadEventSeverity): string {
  if (sev === "MAJOR") return "#FF453A";     // red
  if (sev === "MODERATE") return "#FF9F0A";   // amber
  return "#8E8E93";                           // minor / unknown — grey
}
const INCIDENT_TITLE: Record<RoadEventKind, string> = {
  incident: "Incident", construction: "Roadwork", road: "Road closure",
  weather: "Weather hazard", event: "Road event",
};
export function IncidentMarker({ event, scale = 1 }: { event: RoadEvent; scale?: number }) {
  // Severity-tinted Hairpin teardrop (red = major/moderate in the SPEEDO red,
  // grey = minor) with the black wrench/hammer in the head — matches the
  // phone's GL pins (this MarkerView version renders on the CarPlay map;
  // parity rule). `scale` shrinks the pin (CarPlay passes ~0.72).
  const red = event.severity === "MAJOR" || event.severity === "MODERATE";
  const W = 34 * scale, H = 44 * scale;
  // Official event — tap shows the headline. Deliberately NOT the crew-hazard sheet
  // (no report/delete actions on a government feed item).
  const showDetail = () => {
    const title = `${INCIDENT_TITLE[event.kind] || "Road event"}${event.road ? ` · ${event.road}` : ""}`;
    Alert.alert(title, event.headline, [{ text: "OK" }]);
  };
  return (
    <MarkerView coordinate={[event.lng, event.lat]} anchor={{ x: 0.5, y: 1 }} allowOverlap>
      <Pressable onPress={showDetail} hitSlop={8}>
        <View style={{ width: W, height: H, alignItems: "center" }}>
          <Image
            source={red ? require("../assets/images/brand-pin-red.png") : require("../assets/images/brand-pin-grey.png")}
            style={{ width: W, height: H }}
            resizeMode="contain"
          />
          {/* Glyph sits INSIDE the pin's head circle — no badge circle behind it.
              Box centre = the hole's alpha-centroid (x 0.5w, y 0.38h); the small
              margins counter the MCI glyph's font bearing (draws ~1.8pt left /
              2.35pt high of its box — measured from the tester screenshot). */}
          <View style={[styles.brandPinBadgeDyn, { backgroundColor: "transparent", top: H * 0.38 - 10 * scale, left: W / 2 - 10 * scale, width: 20 * scale, height: 20 * scale }]}>
            <MaterialCommunityIcons name="hammer-wrench" size={12 * scale} color="#0B0B0C" style={{ marginLeft: 3.6 * scale, marginTop: 4.7 * scale }} />
          </View>
        </View>
      </Pressable>
    </MarkerView>
  );
}

// ===== PlaceMarker =====
// Category quick-search result pin: gas price chip / fuel badge / named place.
// The "Place pins" setting (showPins) hides the pure pin GLYPHS (teardrop under
// a name, gas-pump badge) while ALWAYS keeping price chips and name labels. A
// no-price gas station with pins off has nothing to draw → no marker at all.
export function PlaceMarker({ place, index, onPress, scale = 1 }: { place: PlacePoint; index: number; onPress?: (p: PlacePoint) => void; scale?: number }) {
  // Unified numbered result pin — green background, thin grey border, Convoy
  // font. The number matches the row order in the Results dropdown so the list
  // and the map line up (1, 2, 3 …). Gas premium price + ratings live in the
  // dropdown now, keeping the map itself clean. `scale` shrinks the whole pin
  // proportionally (CarPlay passes ~0.72 — full-size pins crowd the head unit).
  const W = 34 * scale, H = 44 * scale;
  return (
    <MarkerView coordinate={[place.lng, place.lat]} anchor={{ x: 0.5, y: 1 }} allowOverlap>
      <Pressable onPress={() => onPress?.(place)} hitSlop={6}>
        {/* Hairpin brand pin + the result number badged on its head, so the map
            pins, the results list, and the logo all speak the same language. */}
        <View style={{ width: W, height: H, alignItems: "center" }}>
          <Image source={require("../assets/images/brand-pin.png")} style={{ width: W, height: H }} resizeMode="contain" />
          {/* Badge centre = the pin-head hole centre (alpha-centroid: x 0.5w, y 0.38h). */}
          <View style={[styles.brandPinBadgeDyn, { top: H * 0.38 - 10 * scale, left: W / 2 - 10 * scale, width: 20 * scale, height: 20 * scale, borderRadius: 10 * scale }]}>
            <Text style={[styles.placeNumText, { fontSize: 14 * scale }]}>{index + 1}</Text>
          </View>
        </View>
      </Pressable>
    </MarkerView>
  );
}

// ===== DestWeatherMarker =====
// Arrival-weather chip floating just above the destination pin.
function DestWeatherMarker({ lat, lng, weather }: { lat: number; lng: number; weather: { kind: WeatherKind; temp: string } }) {
  const ic = destWxIcon(weather.kind);
  return (
    <MarkerView coordinate={[lng, lat]} anchor={{ x: 0.5, y: 1 }} allowOverlap>
      <View style={styles.destWxChip}>
        {ic.mci
          ? <MaterialCommunityIcons name={ic.name as any} size={18} color={ic.color} />
          : <Ionicons name={ic.name as any} size={18} color={ic.color} />}
        <Text style={styles.destWxText}>{weather.temp}</Text>
      </View>
    </MarkerView>
  );
}

// ===== GLPinLayers — hazards / cameras / incidents / places as GL layers =====
// The self-position marker is a 3D GL ModelLayer (slot="top"). MarkerView pins are RN
// view annotations that Mapbox ALWAYS composites ABOVE every GL layer, so a MarkerView
// pin sitting on the puck would cover the 3D arrow/car. To keep the self marker on top
// of EVERYTHING (user request — applies to both the arrow and the car), we render these
// pins as GL layers in slot="middle" (below the model) instead of MarkerViews.
//   • hazards / cameras → their existing PNGs (registered as symbol images)
//   • incidents → a severity-colored CircleLayer (always visible) + the exact ionicon
//                 glyph snapshotted into a symbol image, so it matches the phone badge
//   • places → a green CircleLayer + a number text label
// Taps route through ShapeSource.onPress to the SAME handlers the MarkerViews used. The
// hazard "dispute / it's gone" action lives INSIDE the tap sheet (HazardDrawer), so
// routing tap→sheet loses no capability (long-press was only a shortcut to it).
// NOTE: the MarkerView marker components above stay exported — the CarPlay surface
// (CarMapView) still renders them as MarkerViews on its glanceable map.
type PinFC = { type: "FeatureCollection"; features: any[] };
const fcPoint = (id: string, lng: number, lat: number, props: any): any => ({
  type: "Feature", id, geometry: { type: "Point", coordinates: [lng, lat] }, properties: { id, ...props },
});
const hazardImgName = (kind: string) => (HAZARD_ICONS[kind] ? `hz_${kind}` : "hz_default");
// PNG symbol images shared by every hazard/camera feature (registered once).
const PIN_IMAGE_MAP: Record<string, any> = {
  hz_police: HAZARD_ICONS.police,
  hz_default: HAZARD_ICON_DEFAULT,
  cam: CAMERA_ICON,
  // Hairpin teardrop (73×95 px) — the system-wide brand pin, now ALSO the GL
  // category-place pin (gas/food/coffee…) so phone results match the dropped
  // pin + destination pin + CarPlay's PlaceMarker.
  brand_pin: require("../assets/images/brand-pin.png"),
  // Severity-tinted teardrops for DriveBC incidents (pngjs luminance re-tints of
  // the green pin, shading preserved): red = major/moderate, grey = minor/info.
  brand_pin_red: require("../assets/images/brand-pin-red.png"),
  brand_pin_grey: require("../assets/images/brand-pin-grey.png"),
};
// DriveBC severity → the red (major/moderate, system red #FF453A) or grey
// (minor/unknown) pin. The wrench glyph draws straight into the pin's head
// circle — no badge circle behind it (the old circleTranslate badge was
// map-anchored, so it drifted off the head whenever the map rotated).
function incidentPin(sev: RoadEventSeverity): { icon: string } {
  return sev === "MAJOR" || sev === "MODERATE"
    ? { icon: "brand_pin_red" }
    : { icon: "brand_pin_grey" };
}
// True for the severities that draw the RED pin (also used by map.tsx's
// near-duplicate collapse so red always outranks grey).
export function isRedIncident(sev: RoadEventSeverity): boolean {
  return sev === "MAJOR" || sev === "MODERATE";
}

function GLPinLayers({
  hazards, cameras, incidents, places, onHazardPress, onPlacePress,
}: {
  hazards: Hazard[];
  cameras: { id: string; lat: number; lng: number }[];
  incidents: RoadEvent[];
  places: PlacePoint[];
  onHazardPress?: (h: Hazard) => void;
  onPlacePress?: (p: PlacePoint) => void;
}) {
  const hazardFC = useMemo<PinFC>(() => ({ type: "FeatureCollection", features: hazards.map((h) => fcPoint(h.id, h.lng, h.lat, { icon: hazardImgName(h.kind) })) }), [hazards]);
  const cameraFC = useMemo<PinFC>(() => ({ type: "FeatureCollection", features: cameras.map((c) => fcPoint(c.id, c.lng, c.lat, {})) }), [cameras]);
  const incidentFC = useMemo<PinFC>(() => ({ type: "FeatureCollection", features: incidents.map((e) => fcPoint(e.id, e.lng, e.lat, { icon: incidentPin(e.severity).icon, kind: e.kind, road: e.road || "", headline: e.headline })) }), [incidents]);
  const placeFC = useMemo<PinFC>(() => ({ type: "FeatureCollection", features: places.map((p, i) => fcPoint(p.id, p.lng, p.lat, { num: String(i + 1) })) }), [places]);

  const tapHazard = useCallback((e: any) => { const id = e?.features?.[0]?.properties?.id; const h = hazards.find((x) => x.id === id); if (h) onHazardPress?.(h); }, [hazards, onHazardPress]);
  const tapPlace = useCallback((e: any) => { const id = e?.features?.[0]?.properties?.id; const p = places.find((x) => x.id === id); if (p) onPlacePress?.(p); }, [places, onPlacePress]);
  const tapIncident = useCallback((e: any) => {
    const pr = e?.features?.[0]?.properties; if (!pr) return;
    const title = `${INCIDENT_TITLE[pr.kind as RoadEventKind] || "Road event"}${pr.road ? ` · ${pr.road}` : ""}`;
    Alert.alert(title, pr.headline || "", [{ text: "OK" }]);
  }, []);

  return (
    <>
      {/* Symbol-image registry: hazard/camera PNGs + one snapshotted ionicon glyph per
          incident kind (the RN badge glyph, rendered once into a native image). */}
      <Images images={PIN_IMAGE_MAP}>
        {/* DriveBC glyph: ONE black wrench/hammer on every incident pin (the
            red/grey pin colour carries the severity; the tap sheet carries the
            kind). Snapshotted once into a native symbol image. */}
        <MBXImage name="incg_wrench">
          <View style={styles.incidentGlyphSnap}>
            <MaterialCommunityIcons name="hammer-wrench" size={13} color="#0B0B0C" />
          </View>
        </MBXImage>
        {/* Speed camera: glassy rounded-square badge (dark translucent floor,
            brand-green hairline + camera glyph, top highlight strip for the
            glass read) — the squared/rounded design family, not a teardrop. */}
        <MBXImage name="cam_glass">
          <View style={styles.camGlassSnap}>
            <View style={styles.camGlassHighlight} />
            <Ionicons name="camera" size={15} color="#2DEC86" />
          </View>
        </MBXImage>
      </Images>

      {/* All pins are slot="top" so they draw ABOVE the selected-route ribbon (also
          slot="top", but mounted BEFORE this block) — the old MarkerViews composited
          over the route, so this preserves that. The self 3D model (SelfCarModel) is
          slot="top" too but mounted AFTER this block, so it still draws over the pins
          (later-in-slot = on top; 2D symbol/circle pins don't share the model's depth
          quirk). Mount order within this block = pin-vs-pin stacking (last = on top):
          hazards → cameras → incidents → places (numbered pins on top), matching the old
          MarkerView order. iconSize is per-asset: hazard/police PNGs are 512px (→0.078 for
          ~40pt), the speed_camera PNG is 44px (→0.64 for ~28pt). */}

      {/* Community hazard / police pins — tap → detail sheet (which carries the dispute action).
          emissiveStrength 1 keeps the icons full-brightness under the Standard style's 3D scene
          lighting — WITHOUT it, dusk/night light presets dim these pins to muddy/near-black (the
          route line + self model already self-light for exactly this reason; see line ~386). */}
      {hazards.length > 0 && (
        <ShapeSource id="gl-hazards" shape={hazardFC} onPress={tapHazard}>
          <SymbolLayer id="gl-hazards-sym" slot="top" style={{ iconImage: ["get", "icon"] as any, iconSize: 0.078, iconEmissiveStrength: 1, iconAllowOverlap: true, iconIgnorePlacement: true }} />
        </ShapeSource>
      )}

      {/* Speed cameras — the glassy rounded-square badge (snapshotted above). */}
      {cameras.length > 0 && (
        <ShapeSource id="gl-cameras" shape={cameraFC}>
          <SymbolLayer id="gl-cameras-sym" slot="top" style={{ iconImage: "cam_glass", iconSize: 1, iconEmissiveStrength: 1, iconAllowOverlap: true, iconIgnorePlacement: true }} />
        </ShapeSource>
      )}

      {/* DriveBC incidents — severity-tinted Hairpin teardrops (red = major/
          moderate in the system red, grey = minor) with the black wrench/hammer
          drawn INSIDE the pin's head circle. No badge circle (its map-anchored
          circleTranslate drifted off the head as the map rotated — the tester
          screenshot). Pin + glyph are BOTH viewport-locked symbols with
          screen-space offsets, so they stay glued at any rotation/pitch.
          Head-circle centre sits ~28 pt above the tip at iconSize 0.466. */}
      {incidents.length > 0 && (
        <ShapeSource id="gl-incidents" shape={incidentFC} onPress={tapIncident}>
          <SymbolLayer id="gl-incidents-pin" slot="top" style={{ iconImage: ["get", "icon"] as any, iconSize: 0.466, iconAnchor: "bottom", iconRotationAlignment: "viewport", iconPitchAlignment: "viewport", iconEmissiveStrength: 1, iconAllowOverlap: true, iconIgnorePlacement: true }} />
          {/* Offset MEASURED, not eyeballed (tester screenshot 2026-07-16): the
              hole centre sits [-0.15, -27.4] pt from the pin anchor (alpha-
              centroid of the asset), and the MCI hammer-wrench glyph draws
              1.8 pt left / 2.35 pt high of its layout box (font bearing) —
              so the corrected offset is [+1.7, -25.6]. */}
          <SymbolLayer id="gl-incidents-glyph" slot="top" style={{ iconImage: "incg_wrench", iconSize: 1, iconOffset: [1.7, -25.6] as any, iconRotationAlignment: "viewport", iconPitchAlignment: "viewport", iconEmissiveStrength: 1, iconAllowOverlap: true, iconIgnorePlacement: true }} />
        </ShapeSource>
      )}

      {/* Category place pins — the Hairpin brand teardrop with the result number
          badged on its head (same design as the dropped pin / destination pin /
          CarPlay PlaceMarker, so every pin on the map speaks the brand language).
          Geometry mirrors the RN PlaceMarker: 73×95 asset → iconSize 0.466 ≈
          34×44 pt, tip on the coordinate (iconAnchor bottom); the badge circle +
          number sit at the pin head, ~29 pt above the tip (circleTranslate is pt;
          textOffset is em of textSize 13 → −29/13 ≈ −2.23). All self-lit so the
          pin stays bright under the dusk/night light presets. */}
      {places.length > 0 && (
        <ShapeSource id="gl-places" shape={placeFC} onPress={tapPlace}>
          <SymbolLayer id="gl-places-pin" slot="top" style={{ iconImage: "brand_pin", iconSize: 0.466, iconAnchor: "bottom", iconRotationAlignment: "viewport", iconPitchAlignment: "viewport", iconEmissiveStrength: 1, iconAllowOverlap: true, iconIgnorePlacement: true }} />
          {/* Badge circle behind the number: translate anchored to the VIEWPORT
              (default is "map", which drifted the circle off the pin head as the
              map rotated — the same bug that hit the DriveBC badge). */}
          <CircleLayer id="gl-places-bg" slot="top" style={{ circleColor: "#0A1A10", circleRadius: 10, circleTranslate: [0, -28] as any, circleTranslateAnchor: "viewport", circlePitchAlignment: "viewport", circleEmissiveStrength: 1 }} />
          <SymbolLayer id="gl-places-num" slot="top" style={{ textField: ["get", "num"] as any, textSize: 13, textColor: "#2DEC86", textOffset: [0, -28 / 13] as any, textRotationAlignment: "viewport", textPitchAlignment: "viewport", textEmissiveStrength: 1, textAllowOverlap: true, textIgnorePlacement: true }} />
        </ShapeSource>
      )}
    </>
  );
}

function ConvoyMapbox(props: ConvoyMapboxProps) {
  const {
    center, user, peers, hideSelfMarker, selfMarkerType = "car", selfClassPaint, selfVehicleClass = "hatchback", selfArrowPaint, mapView = "heading_up",
    mapMode = "satellite", leaderUserId, show3dBuildings = true,
    followUser = false, onUserPan, navigationActive = false, userSpeedMs,
    routeColor = DEFAULT_ROUTE_COLOR,
    distanceToManeuverM, onMapPress, onMapLongPress, onPeerPress, onMapReady,
    routes = [], selectedRouteIndex = 0, onSelectRoute, destination,
    offerPill, onOfferAccept, onOfferDismiss,
    hazards, speedCameras, roadEvents, places, showPlacePins = true, destWeather,
    onHazardPress, onPlacePress, onHeading, resetNorthSignal,
    zoomOffset = 0,
  } = props;

  const cameraRef = useRef<React.ElementRef<typeof Camera>>(null);
  const readyRef = useRef(false);
  const gesturingRef = useRef(false);
  // Tracks which destination we've already framed (preview fit-to-bounds) so we
  // don't re-fit on every route recompute / GPS tick.
  const fittedDestRef = useRef<string | null>(null);
  // Live traffic-congestion gradient for the route preview (Mapbox Directions).
  // Null unless we have a fetched congestion route to paint (preview-only).
  const [congestionRoute, setCongestionRoute] = useState<{ coordinates: [number, number][]; gradient: any } | null>(null);
  // Last heading reported to onHeading — throttle so a ~constant bearing during
  // nav doesn't spam the parent (same pattern as the car-scale zoom delta).
  const lastHeadingRef = useRef<number>(0);
  // Smoothed, speed-gated map bearing we feed the follow camera (anti-wobble +
  // anti-spin). null until the first GPS heading seeds it.
  const camHeadingRef = useRef<number | null>(null);
  // Hysteresis latch for the route-snap heading gate (see selfSnapped below): holds the
  // last gate decision so the snap locks in at 45° but only releases past 60°, preventing
  // flicker when the travel heading hovers near the boundary.
  const snapHdgOkRef = useRef(true);
  // ── Phase-2 road-snap state ──
  // mapRef → querySourceFeatures on the invisible road source. roadSnap holds the last snap
  // point + the raw fix it was computed for (staleness gate). roadStickyRef = hysteresis
  // (once snapped, stay snapped out to the wider RELEASE distance). roadInputsRef feeds the
  // throttled interval with the latest raw pose without it re-subscribing each render.
  const mapRef = useRef<any>(null);
  // The LOCKED road polyline. The render projects the LIVE raw fix onto it each frame, so the
  // marker slides smoothly along the road; the interval only swaps WHICH road is locked. A ref
  // mirror lets the interval read the current lock without re-subscribing.
  const [roadSnap, setRoadSnap] = useState<{ line: RoadLatLng[] } | null>(null);
  const roadSnapRef = useRef<{ line: RoadLatLng[] } | null>(null);
  const roadStickyRef = useRef(false);
  const roadInputsRef = useRef<{ lat: number; lng: number; hdg: number | null; speed: number; active: boolean }>(
    { lat: 0, lng: 0, hdg: null, speed: 0, active: false },
  );
  useEffect(() => {
    let mounted = true;
    const id = setInterval(async () => {
      const inp = roadInputsRef.current;
      // Only query when the marker is NOT route-snapped (idle / off-route) and the map is up.
      if (!inp.active || !readyRef.current || !mapRef.current?.querySourceFeatures) {
        if (roadStickyRef.current) { roadStickyRef.current = false; roadSnapRef.current = null; setRoadSnap(null); }
        return;
      }
      // Road continuity: if already locked to a road and the car is still on it (within the
      // release band), KEEP it — don't re-query and risk hopping to a closer parallel road /
      // opposite carriageway across a median. The render tracks the car along this line live.
      const cur = roadSnapRef.current;
      if (cur && roadStickyRef.current) {
        const p = projectOntoRoute(inp.lat, inp.lng, cur.line);
        if (p && p.distM <= ROAD_SNAP_RELEASE_M) return;
      }
      try {
        const fc = await mapRef.current.querySourceFeatures(ROAD_SRC_ID, [], ["road"]);
        // Re-check after the await — the marker may have re-locked to the route meanwhile.
        if (!mounted || !roadInputsRef.current.active) return;
        const tol = roadStickyRef.current ? ROAD_SNAP_RELEASE_M : ROAD_SNAP_LOCK_M;
        const nl = nearestRoadLine(inp.lat, inp.lng, fc?.features, tol);
        const p = nl ? projectOntoRoute(inp.lat, inp.lng, nl.line) : null;
        // While moving, reject a road we're only crossing (bearing too perpendicular to travel).
        const moving = inp.speed >= ROAD_SNAP_MOVING_MS;
        const crossOk = !p || !moving || inp.hdg == null || roadHeadingOff(inp.hdg, p.bearing) <= ROAD_SNAP_CROSS_DEG;
        if (nl && crossOk) {
          roadStickyRef.current = true;
          roadSnapRef.current = { line: nl.line };
          setRoadSnap({ line: nl.line });
        } else if (roadStickyRef.current) {
          roadStickyRef.current = false;
          roadSnapRef.current = null;
          setRoadSnap(null);
        }
      } catch {
        // querySourceFeatures can throw mid-style-reload; keep the last lock, retry next tick.
      }
    }, ROAD_SNAP_QUERY_MS);
    return () => { mounted = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Painted-arrow GLB URI (runtime material recolor, cached on disk). null →
  // the stock bundled arrow. Resolved async whenever the arrow paint changes.
  const [paintedArrowUri, setPaintedArrowUri] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (selfMarkerType !== "arrow" || (!selfArrowPaint?.primary && !selfArrowPaint?.secondary)) {
      setPaintedArrowUri(null);
      return;
    }
    getPaintedArrowUri(GREEN_ARROW_MODEL as number, selfArrowPaint?.primary, selfArrowPaint?.secondary)
      .then((uri) => { if (alive) setPaintedArrowUri(uri); })
      .catch(() => { if (alive) setPaintedArrowUri(null); });
    return () => { alive = false; };
  }, [selfMarkerType, selfArrowPaint?.primary, selfArrowPaint?.secondary]);
  // Last-known GPS spot, read ONCE at mount (synchronous; hydrated with settings).
  // Lets the camera's first paint frame the driver's last location instead of
  // flying in from the world view while we wait on the first GPS fix.
  const [coldStartLoc] = useState(() => getLastLocation());
  // Map viewport height in points (set on layout) — drives lower-third chase framing.
  const [mapH, setMapH] = useState(0);
  // Cold-start camera: snap (no animation) for the first beat after the initial
  // location arrives so the map opens ALREADY settled on the driver instead of a
  // zoom-in / fly-in. After ~1.2s we restore the default animated follow (props
  // back to undefined) so the in-drive chase transitions stay smooth.
  const coldLockArmedRef = useRef(false);
  const [coldLockDone, setColdLockDone] = useState(false);
  const [dbgCamHdg, setDbgCamHdg] = useState(0);
  // Live camera zoom, surfaced in the debug strip so the car-size curve can be
  // tuned against actual zoom values (read "too small at zoom X" instead of guessing).
  const [dbgZoom, setDbgZoom] = useState(0);
  const lastZoomRef = useRef<number>(0);
  // True the moment we have ANY GPS fix. Kept as a STABLE boolean so the arm
  // effect below runs EXACTLY ONCE (on the first fix) and is not re-run on every
  // subsequent GPS tick.
  const hasFirstFix = !!(user && typeof user.lat === "number" && typeof user.lng === "number");
  useEffect(() => {
    if (coldLockArmedRef.current || !hasFirstFix) return;
    // Arm ONCE. This effect previously depended on user.lat/user.lng, so every
    // GPS update (~2 Hz) re-ran it and its cleanup CLEARED the 1.2s timer before
    // it could fire — coldLockDone never flipped true, which left the Camera's
    // followUserLocation permanently OFF (dead Recenter + no zoom-in when nav
    // starts + no chase). Keying on the stable hasFirstFix boolean lets the timer
    // run to completion; the cleanup now only fires on unmount.
    coldLockArmedRef.current = true;
    const t = setTimeout(() => setColdLockDone(true), 1200);
    return () => clearTimeout(t);
  }, [hasFirstFix]);
  // Throttle clock for persisting the live location (see the effect below).
  const lastLocPersistRef = useRef(0);

  // North-reset: when the parent bumps resetNorthSignal (Compass FAB tap),
  // animate the camera back to north-up. Skip the initial mount so we don't
  // fight the follow/chase camera at startup.
  const didMountNorthRef = useRef(false);
  useEffect(() => {
    if (!didMountNorthRef.current) { didMountNorthRef.current = true; return; }
    try {
      cameraRef.current?.setCamera({ heading: 0, animationDuration: 300, animationMode: "easeTo" });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetNorthSignal]);

  // Persist the driver's location (throttled) so the NEXT cold start frames the
  // map on them immediately (see coldStartLoc). Uses the dedicated last-location
  // store, which does NOT notify settings listeners, so this frequent write never
  // triggers a settings re-render anywhere in the app. First fix writes at once.
  useEffect(() => {
    if (!user || typeof user.lat !== "number" || typeof user.lng !== "number") return;
    const now = Date.now();
    if (now - lastLocPersistRef.current < 15000) return;
    lastLocPersistRef.current = now;
    setLastLocation(user.lat, user.lng);
  }, [user?.lat, user?.lng]);

  // ----- Base-map style (one code path, driven by mapMode) -----
  // "satellite"              → satellite-with-streets imagery (matches Google sat).
  // dawn / day / dusk / night → Mapbox STANDARD style; the time-of-day lighting is
  //   applied via the <StyleImport> child below (config.lightPreset = mapMode),
  //   which gives the dark/tilted vector basemap with auto 3D buildings.
  const useStandard = mapMode !== "satellite";
  const styleURL = useStandard
    ? "mapbox://styles/mapbox/standard"
    : Mapbox.StyleURL.SatelliteStreet;

  // Map bearing the camera is using right now (heading-up while following /
  // navigating, else north). CarMarker subtracts this so every car rides
  // nose-forward up the rotated road.
  const selfHeadingDeg = typeof user?.heading === "number" && Number.isFinite(user.heading) ? user.heading : 0;
  const mapHeadingDeg = mapView === "heading_up" && (navigationActive || followUser) ? selfHeadingDeg : 0;

  // Initial camera target for first paint. Falls back to the last-known location
  // (persisted) so a cold start opens framed on the driver instead of flying in
  // from the world view; still avoids a flash at null-island if nothing is known.
  const initLat = center?.lat ?? user?.lat ?? coldStartLoc?.lat;
  const initLng = center?.lng ?? user?.lng ?? coldStartLoc?.lng;

  // ===== 3-route kinds + colors (Best / Scenic / AI) =====
  // Best = fastest (the engine's index 0) → the user's route color. Scenic = the first
  // alternate → an auto-contrasting hue. AI = a learned habitual route (tagged
  // kind:"ai" by map.tsx in P3) → BLACK core with the user color on the EDGES. Extra
  // alternates (index >= 2) are NOT drawn — we only ever show these three.
  const routeKindOf = routeKindFor;
  const coreColorOf = (k: RouteKind): string => routeColorsFor(k, routeColor).color;
  const edgeColorOf = (k: RouteKind): string => routeColorsFor(k, routeColor).edge;
  const selKind = routeKindOf(selectedRouteIndex, (routes as any)?.[selectedRouteIndex]);
  const selColor = coreColorOf(selKind);
  const selEdge = edgeColorOf(selKind);

  // ===== Route geometry → GeoJSON =====
  // One LineString feature per DISPLAYED route (Best/Scenic/AI; "alt" routes dropped),
  // tagged with index + kind + its core/edge colors so the LineLayers paint each
  // distinctly via data-driven expressions.
  const routeFC: any = useMemo(() => ({
    type: "FeatureCollection",
    features: (routes || [])
      .map((r, i) => {
        const kind = routeKindOf(i, r);
        if (kind === "alt") return null;          // only ever draw Best / Scenic / AI
        const coords = decodePolyline(r.polyline).map((p) => [p.longitude, p.latitude]);
        return coords.length >= 2
          ? { type: "Feature", properties: { index: i, kind, color: coreColorOf(kind), edge: edgeColorOf(kind) }, geometry: { type: "LineString", coordinates: coords } }
          : null;
      })
      .filter(Boolean),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [routes, routeColor]);

  // Tap an alternate route line → select it (same as tapping its ETA pill).
  const handleRoutePress = (e: any) => {
    const idx = e?.features?.[0]?.properties?.index;
    if (typeof idx === "number") onSelectRoute?.(idx);
  };

  // ===== Native follow / chase camera =====
  // Mapbox's NATIVE course-follow camera — the smooth, interpolated tracking its
  // own navigation uses — driven declaratively by the follow props below. The
  // <LocationPuck> mounted in the map is what ACTIVATES Mapbox's native location
  // layer that this camera tracks; that puck must be VISIBLE to start the layer (a
  // hidden location component does NOT start it — which is exactly why the camera
  // sat on the world at cold start and didn't chase). With the layer live, native
  // follow both centres on cold start and glides during nav.
  //   • followUserLocation = track the driver (followUser; parent drops it on a pan)
  //   • followUserMode     = plain Follow (we supply the bearing ourselves via followHeading)
  //   • followZoomLevel    = speed/corner chase zoom while navigating, fixed follow zoom otherwise
  //   • followPitch        = 45° while navigating heading-up, flat otherwise
  const headingUp = mapView === "heading_up";

  // ── Route-ahead orientation at guidance start ──
  // When a route STARTS from a standstill there's no GPS course (0 mph → heading undefined), so
  // the heading-up camera would default to its last/zero bearing (often north). On the
  // navigationActive rising edge, seed the bearing to the route's INITIAL heading so the map
  // immediately faces the way you're about to drive; once the car is moving, the smoothed-GPS
  // path below takes over. Skipped when we already have a reliable moving course (auto-start at
  // ≥5 km/h keeps real GPS). User pick 2026-07-11: orient to direction-of-travel.
  const navOrientedRef = useRef(false);
  useEffect(() => {
    if (!navigationActive) { navOrientedRef.current = false; return; }
    if (navOrientedRef.current) return; // once per guidance start
    const spd = userSpeedMs;
    const moving = typeof spd === "number" && Number.isFinite(spd) && spd * 3.6 > COURSE_OFF_KMH;
    if (moving) { navOrientedRef.current = true; return; } // reliable GPS course — leave it
    const b = routeInitialBearing(decodePolyline(routes?.[selectedRouteIndex]?.polyline));
    if (b != null) { camHeadingRef.current = b; navOrientedRef.current = true; }
  }, [navigationActive, userSpeedMs, routes, selectedRouteIndex]);

  // Heading-up bearing — driven by US, not Mapbox's native FollowWithCourse.
  // FollowWithCourse rotates to raw GPS course every frame, so its noise made the
  // map WOBBLE while driving and SPIN while stopped. Instead we run plain Follow
  // (native centring / zoom / tilt only; bearing left to us) and feed the bearing
  // as the SAME heading the car uses (selfHeadingDeg = user.heading via the
  // parent's BearingTracker), low-pass smoothed at the GPS rate. Below
  // COURSE_OFF_KMH we FREEZE it (stop updating) so a stopped car holds its last
  // heading instead of spinning on junk course. North-up feeds no bearing → north.
  {
    const spd = userSpeedMs;
    const spdKnown = typeof spd === "number" && Number.isFinite(spd) && spd >= 0;
    const moving = !spdKnown || spd * 3.6 > COURSE_OFF_KMH;
    if (camHeadingRef.current == null && Number.isFinite(selfHeadingDeg)) {
      camHeadingRef.current = selfHeadingDeg; // seed on first heading
    }
    if (moving && camHeadingRef.current != null && Number.isFinite(selfHeadingDeg)) {
      const prev = camHeadingRef.current;
      const arc = ((((selfHeadingDeg - prev) % 360) + 540) % 360) - 180; // shortest-arc
      camHeadingRef.current = (prev + arc * HEADING_SMOOTH_ALPHA + 360) % 360;
    }
  }
  // In NORTH-UP (the ONLY state where native followUserLocation runs — see the Camera
  // below), force the follow engine's bearing to 0 so a Compass tap actually snaps the
  // map to true north. Leaving it undefined let the native engine KEEP the user's
  // gesture-rotated bearing and silently override the imperative heading:0 reset — the
  // "compass recenters but never flips north" bug. Heading-up keeps the smoothed bearing.
  const followHeadingDeg = headingUp ? (camHeadingRef.current ?? undefined) : 0;

  // Android heading-up via the NATIVE engine. Under UserTrackingMode.Follow,
  // Android ignores `followHeading` AND overrides our imperative setCamera bearing
  // on every follow frame, so the map stayed frozen north-up. FollowWithCourse
  // rotates the camera to the GPS course natively (heading-up) and the follow
  // engine can't fight it. iOS honors followHeading under Follow, so it stays on
  // the smoothed path. (Trade-off: FollowWithCourse uses raw course — watch for
  // wobble; fallback is feeding the smoothed heading via CustomLocationProvider.)
  const followMode = (Platform.OS === "android" && headingUp)
    ? UserTrackingMode.FollowWithCourse
    : UserTrackingMode.Follow;

  const followZoom = Math.round(
    Math.max(ZOOM_MIN, Math.min(ZOOM_MAX,
      (navigationActive ? chaseZoom(kmhFromMs(userSpeedMs), distanceToManeuverM) : FOLLOW_ZOOM) + (zoomOffset || 0),
    )) * 10,
  ) / 10;
  const followPitchDeg = navigationActive && headingUp ? chasePitch(kmhFromMs(userSpeedMs)) : 0;

  // Lower-third chase framing — top padding pushes the followed car DOWN the
  // screen so the driver sees more road ahead. Applies ONLY during active
  // navigation (heading-up); otherwise — free drive / north-up — the car sits
  // centred.
  const followPadding = navigationActive && headingUp && mapH > 0
    ? { paddingTop: Math.round(mapH * FOLLOW_LOWER_PAD_FRAC), paddingBottom: 0, paddingLeft: 0, paddingRight: 0 }
    : undefined;

  // While category-search result pins are on the map (preview only), we frame
  // ALL of them and HOLD that overview — native follow is suspended (see the
  // Camera's followUserLocation below) until the pins clear (a result is tapped
  // or the dropdown is closed).
  const placesShown = (places?.length ?? 0) > 0 && !navigationActive;

  // ===== LOCKSTEP camera (heading-up chase only) — the CarPlay smoothness fix, ported =====
  // In heading-up follow, drive the camera imperatively from SelfCarModel's 60fps rAF
  // (cameraRef.setCamera, animationMode:'none') instead of the native follow engine —
  // which moved on its own cadence and desynced from the eased car (the shudder, and the
  // car drifting off-center instead of sticking). The car pins to the padded center and
  // the world rotates/translates around it. Gated to heading-up + actively-following +
  // post-cold-lock + no place pins, so route-preview / places / north-up / free-roam all
  // keep their EXISTING camera paths (the imperative fits + native follow) untouched.
  const lockReadyRef = useRef(false);
  lockReadyRef.current = readyRef.current && coldLockDone && followUser && !placesShown && headingUp;
  const getCam = () => ({
    zoomLevel: followZoom,
    pitch: followPitchDeg,
    // Fallback only — pushCam rides the EASED car heading (render.current.heading) so the
    // map rotates as smoothly as the car turns. Heading-up is the only mode that locksteps.
    heading: followHeadingDeg ?? 0,
    padding: followPadding ?? { paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0 },
  });

  // ===== User zoom buttons (+/-) =====
  // While FOLLOWING, the offset rides on followZoomLevel above — Mapbox ignores
  // imperative zoom under follow, so the offset is the only lever that works
  // there. While NOT following (the driver panned away), apply the same offset
  // imperatively. This effect fires only when the offset CHANGES (a button tap),
  // so it never fights a pinch gesture (a pinch doesn't change zoomOffset).
  const zoomOffsetRef = useRef(zoomOffset);
  useEffect(() => {
    const prev = zoomOffsetRef.current;
    zoomOffsetRef.current = zoomOffset;
    if (zoomOffset === prev) return;            // no-op on unrelated re-renders
    if (followUser || placesShown) return;      // follow path handles it declaratively
    const cam = cameraRef.current;
    if (!cam || !readyRef.current) return;
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, FREE_ZOOM + (zoomOffset || 0)));
    try { cam.setCamera({ zoomLevel: z, animationDuration: 200, animationMode: "easeTo" }); } catch {}
  }, [zoomOffset, followUser, placesShown]);

  // When nav ends while NOT following (the driver had panned away), flatten the
  // tilt / heading back to a calm north-up overview. While following, the native
  // follow props already drop the pitch — no imperative move needed.
  useEffect(() => {
    if (navigationActive) return;
    const cam = cameraRef.current;
    if (!cam || !readyRef.current || followUser) return;
    try { cam.setCamera({ pitch: 0, heading: 0, zoomLevel: FREE_ZOOM, animationDuration: 350, animationMode: "easeTo" }); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationActive]);

  // ===== Preview: fit the camera to ALL route options =====
  // When routes are computed and we're NOT navigating, frame the whole set of
  // options (Google's route-overview behavior). Fires ONCE per destination
  // (fittedDestRef), and only matters when not actively following — the native
  // follow owns the camera during follow/nav, so this won't fight the chase cam.
  useEffect(() => {
    const cam = cameraRef.current;
    if (!destination) { fittedDestRef.current = null; return; }
    if (!cam || !readyRef.current || navigationActive || followUser || (routes?.length ?? 0) === 0) return;
    const key = `${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}`;
    if (fittedDestRef.current === key) return;

    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    const add = (lat: number, lng: number) => {
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
    };
    (routes || []).forEach((r) => decodePolyline(r.polyline).forEach((p) => add(p.latitude, p.longitude)));
    if (user && typeof user.lat === "number" && typeof user.lng === "number") add(user.lat, user.lng);
    add(destination.lat, destination.lng);
    if (!Number.isFinite(minLat)) return;

    fittedDestRef.current = key;
    try {
      cam.setCamera({
        bounds: { ne: [maxLng, maxLat], sw: [minLng, minLat], paddingTop: 140, paddingBottom: 340, paddingLeft: 60, paddingRight: 60 },
        heading: 0,
        pitch: 0,
        animationDuration: 600,
        animationMode: "easeTo",
      });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, destination, navigationActive, followUser]);

  // ===== Preview: fit the camera to ALL category-search result pins =====
  // When pins drop (a pill's results), frame every pin (plus the driver) and
  // hold it — followUserLocation is suspended via `placesShown`, so the overview
  // stays put until the pins clear. Refits whenever the pin set changes.
  useEffect(() => {
    const cam = cameraRef.current;
    if (!cam || !readyRef.current || !placesShown) return;
    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    const add = (lat: number, lng: number) => {
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
    };
    (places || []).forEach((p) => add(p.lat, p.lng));
    if (user && typeof user.lat === "number" && typeof user.lng === "number") add(user.lat, user.lng);
    if (!Number.isFinite(minLat)) return;
    try {
      cam.setCamera({
        // Balanced top/bottom padding centers the pins. (The old 340 top was
        // reserved for the results dropdown, which no longer opens on a tap.)
        bounds: { ne: [maxLng, maxLat], sw: [minLng, minLat], paddingTop: 150, paddingBottom: 150, paddingLeft: 50, paddingRight: 50 },
        heading: 0,
        pitch: 0,
        animationDuration: 500,
        animationMode: "easeTo",
      });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, placesShown]);

  // ===== Route congestion gradient (Mapbox Directions) — PREVIEW only =====
  // On a new destination (and while NOT navigating) fetch the live driving-traffic
  // route from Mapbox and paint it as a congestion-coloured line. Keyed ONLY on
  // the destination so a GPS tick never refetches; the origin is the user's spot
  // at fetch time. Cleared when there's no destination or once navigation starts
  // (during active guidance the chase cam + Google geometry own the screen —
  // unifying that is the later, drive-tested routing swap). Fails soft to null.
  useEffect(() => {
    if (navigationActive || !destination) { setCongestionRoute(null); return; }
    const oLat = center?.lat ?? user?.lat;
    const oLng = center?.lng ?? user?.lng;
    if (typeof oLat !== "number" || typeof oLng !== "number" ||
        typeof destination.lat !== "number" || typeof destination.lng !== "number") {
      setCongestionRoute(null);
      return;
    }
    const ctrl = new AbortController();
    let cancelled = false;
    fetchMapboxCongestion({ lat: oLat, lng: oLng }, { lat: destination.lat, lng: destination.lng }, { signal: ctrl.signal })
      .then((res) => {
        if (cancelled) return;
        if (!res) { setCongestionRoute(null); return; }
        setCongestionRoute({ coordinates: res.coordinates, gradient: buildCongestionGradient(res.coordinates, res.congestion, routeColor) });
      })
      .catch(() => { if (!cancelled) setCongestionRoute(null); });
    return () => { cancelled = true; ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination?.lat, destination?.lng, navigationActive]);

  // ===== Build the car list (self + peers) =====
  const cars: CarPoint[] = [];
  if (!hideSelfMarker && user && typeof user.lat === "number" && typeof user.lng === "number") {
    cars.push({ id: SELF_ID, lat: user.lat, lng: user.lng, color: user.carColor, heading: user.heading });
  }
  const peerList: Peer[] = Array.isArray(peers) ? peers : peers ? Object.values(peers) : [];
  peerList.forEach((p) => {
    if (p && typeof p.lat === "number" && typeof p.lng === "number") {
      cars.push({
        id: "peer_" + p.user_id, lat: p.lat, lng: p.lng,
        color: p.activeColor || p.carColor, heading: p.heading,
        leader: !!leaderUserId && p.user_id === leaderUserId, peer: p,
        status: (p as any).status,
      });
    }
  });
  // The self car is rendered as a 3D GLB model (ModelLayer) instead of the flat
  // PNG; peers stay PNG MarkerViews. Pulled out here so the model layer below has
  // its live coordinate + heading.
  const selfCar = cars.find((c) => c.id === SELF_ID);
  // 'arrow' appearance → the green arrow GLB instead of the car; else the per-color
  // car model. (Both render through the same SelfCarModel ModelLayer below.)
  const selfIsArrow = selfMarkerType === "arrow";
  // "Class" appearance → a registered top-down sprite instead of a GLB.
  //  • photo class, no paint  → the photo AS-SHOT (static registration)
  //  • photo class, painted   → live MBXImage snapshot of <ClassSprite> (photo
  //    + primary/secondary band layers tinted at runtime — any hex works)
  //  • no photo yet           → the tinted silhouette placeholder
  // Image name carries class+paint so changing either re-registers live.
  const selfIsClass = selfMarkerType === "class";
  const selfClassAsShot = CLASS_TOPDOWN[selfVehicleClass];
  const _pri = selfClassPaint?.primary, _sec = selfClassPaint?.secondary;
  const selfClassPainted = !!selfClassAsShot && (!!_pri || !!_sec);
  const _paintKey = `${(_pri || "x").replace("#", "")}_${(_sec || "x").replace("#", "")}`;
  const selfClassImg = selfClassAsShot
    ? (selfClassPainted ? `self_class_paint_${selfVehicleClass}_${_paintKey}` : `self_class_photo_${selfVehicleClass}`)
    : "self_class_" + (_pri || "#2DEC86").replace(/[^0-9a-fA-F]/g, "");
  // Arrow = the BUNDLED asset, or the runtime-recolored copy (file:// URI) when
  // the driver saved arrow paint; car = per-color remote GLB URL. <Models>
  // accepts all three.
  const selfModelUrl: string | number = selfIsArrow
    ? (paintedArrowUri ?? GREEN_ARROW_MODEL)
    : getVehicleModelUrl(selfCar?.color);
  // Paint/color-specific model id so a change swaps the model LIVE (Mapbox
  // caches a model by id — a fixed id won't reload a new .glb until remount).
  const selfModelId = selfIsArrow
    ? (paintedArrowUri ? ARROW_MODEL_ID + "_" + paintedArrowUri.split("arrow_").pop()!.replace(".glb", "") : ARROW_MODEL_ID)
    : "convoyCar_" + getVehicleModelKey(selfCar?.color);
  // Lift the paint out of the dark on the dim light presets (dawn/night). The ARROW
  // is always FULLY self-lit (1): it's a UI marker, not a realistic car — scene
  // lighting at day/dusk (0/0.55) washed its brand green pale.
  const selfEmissive = selfIsArrow ? 1 : (CAR_EMISSIVE_BY_MODE[mapMode] ?? 0);

  // Project the car onto the selected route while navigating. Drives two things:
  // (1) trimming the line behind the car (3D car reads on top), and (2) snapping
  // the drawn car onto the line so it stays glued to the road. null in preview /
  // free-drive → full line + raw GPS position.
  const routeProj = useMemo(() => {
    if (!navigationActive || !selfCar) return null;
    const poly = routes?.[selectedRouteIndex]?.polyline;
    if (!poly) return null;
    return projectOntoRoute(selfCar.lat, selfCar.lng, decodePolyline(poly));
  }, [navigationActive, selfCar?.lat, selfCar?.lng, routes, selectedRouteIndex]);

  // Trim end: a speed-aware lead ahead of the car so the line vanishes just in
  // front of its nose. The drawn car interpolates between fixes, so at speed the
  // trim point (raw fix) can sit behind the moving car; leading it by ~8 m + a
  // touch per m/s keeps the green line clearing the nose. OTA-tunable.
  const _trimSpdMs = typeof userSpeedMs === "number" && userSpeedMs > 0 ? userSpeedMs : 0;
  // Speed-aware buffer ahead of the nose: the drawn car interpolates between 1 Hz
  // fixes, so at speed it travels well past the raw fix the trim is computed from.
  // Testers cruising 80–200 km/h saw the green line trail under the car's tail —
  // the old 1.1×/m/s lead (cap 55 m) couldn't keep the clear-point ahead of the
  // fast tween. Lead harder: ~1.6× a second of travel, cap 90 m.
  //   12 m @ 0 · ~44 m @ 72 km/h · ~65 m @ 120 km/h · 90 m @ 160+ km/h.
  const _trimLeadM = Math.max(12, Math.min(90, 12 + _trimSpdMs * 1.6));
  const routeTrimEndFrac = routeProj
    ? Math.max(0, Math.min(0.999, routeProj.frac + _trimLeadM / routeProj.totalM))
    : null;
  // Soft fade-in just past that buffer: the line ramps transparent → solid over
  // ~20 m instead of hard-starting in front of the nose. Uses the route source's
  // lineMetrics (already enabled). Only while navigating (a trim point exists);
  // preview keeps the solid color. Built as a line-progress gradient anchored at
  // the trim edge.
  const _fadeSpanFrac = routeProj ? Math.max(0.0008, Math.min(0.06, 20 / routeProj.totalM)) : 0;
  const buildLineFade = (solid: string, clear: string): any => {
    if (routeTrimEndFrac == null) return null;
    const s0 = Math.min(0.997, Math.max(0.0001, routeTrimEndFrac));
    const s1 = Math.min(0.999, Math.max(s0 + 0.0006, s0 + _fadeSpanFrac));
    return ["interpolate", ["linear"], ["line-progress"], 0, clear, s0, clear, s1, solid, 1, solid];
  };
  // Selected route renders in ITS kind color (Best = user color, Scenic = contrasting,
  // AI = black core). selColor === routeColor for Best, so the common case is unchanged.
  const selCoreGradient = buildLineFade(routeRgba(selColor, 1), routeRgba(selColor, 0));
  const selGlowGradient = buildLineFade(routeRgba(selEdge, 1), routeRgba(selEdge, 0));

  // ===== Live congestion on the ACTIVE route (DURING navigation) =====
  // The route we're driving already carries per-segment congestion (nav.ts gets
  // it from fetchMapboxRoutes). Build a green→red line-progress gradient from it
  // so the selected route's core shows live traffic WHILE navigating — not just
  // in preview. buildCongestionGradient returns a plain colour string when the
  // whole route is a single level; wrap that as a constant gradient so it's
  // always usable as lineGradient alongside the behind-car trim. null when
  // navigating without congestion data → falls back to the green fade core.
  const navCongestionGradient = useMemo(() => {
    if (!navigationActive) return null;
    const sel: any = routes?.[selectedRouteIndex];
    const coords = sel?.coordinates as [number, number][] | undefined;
    const cong = sel?.congestion as CongestionLevel[] | undefined;
    if (!coords || coords.length < 2 || !cong || cong.length === 0) return null;
    const g = buildCongestionGradient(coords, cong, selColor);
    return Array.isArray(g) ? g : (["interpolate", ["linear"], ["line-progress"], 0, g, 1, g] as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationActive, routes, selectedRouteIndex, selColor]);
  // The selected core paints congestion during nav (preferred), else the soft
  // green fade-in. Both ride the same behind-car trim.
  const selCoreGrad = navCongestionGradient || selCoreGradient;
  // True while we're navigating AND have a real congestion gradient to draw. When set,
  // the congestion is painted on a DEDICATED, NON-TRIMMED core layer (route-sel-cong,
  // a clone of the proven preview cong-core) instead of the trimmed route-sel-core.
  // WHY: combining a multi-colour lineGradient with lineTrimOffset on the SAME layer
  // does not render the colour transitions in @rnmapbox (the trimmed single-colour
  // green fade hid this — alpha-only gradients survive the trim, multi-colour ones get
  // flattened to solid). Decoupling colour from trim makes the transitions show on the
  // route during nav exactly as they do in preview; the glow casing keeps the trim so
  // the behind-car vanish is preserved.
  const navCongActive = navigationActive && !!navCongestionGradient;
  // Gap the congestion core off the car the same way. It's NON-trimmed (a trimmed
  // multi-colour gradient flattens), so it previously ran straight THROUGH the car.
  // Bake the behind-car vanish + soft front fade into the gradient's alpha using the
  // same s0/s1 the plain core uses, so colour transitions still render but the line
  // clears the nose. null routeProj (off-route) → unchanged full gradient.
  const navCongGapped = (navCongestionGradient && routeTrimEndFrac != null)
    ? applyCarGapGradient(
        navCongestionGradient,
        Math.min(0.997, Math.max(0.0001, routeTrimEndFrac)),
        Math.min(0.999, Math.max(routeTrimEndFrac + 0.0006, routeTrimEndFrac + _fadeSpanFrac)),
      )
    : navCongestionGradient;

  // Snapped draw POSITION + heading: glue the car to the line within ~60 m of it —
  // further off (wrong turn / pre-reroute) we show the real GPS so you can see you're
  // off-route. SelfCarModel interpolates, so the snap eases in smoothly. (Widened
  // 45 → 60 m so a car a couple lanes off a parallel street still locks to the line.)
  const SELF_SNAP_M = 60;
  // Heading gate (Phase 1 road-snap): in ADDITION to the ≤60 m distance test, require the
  // route's local bearing to be within tolerance of the driver's travel heading — so turning
  // onto a parallel / frontage / cross street un-snaps the marker to raw GPS instead of
  // staying glued to the route line (which read as "still on route" after a wrong turn).
  // Hysteresis: locks in at ≤45°, only releases past 60°, so it doesn't flicker at the edge.
  // Skipped below ~walking speed (a stopped car keeps the distance-only snap — its held
  // heading may be stale). DISPLAY-ONLY: reroute/off-route detection reads RAW GPS (nav.ts),
  // never this, so un-snapping here cannot mask a deviation — it just stops mis-showing one.
  const SELF_SNAP_HDG_LOCK = 45;
  const SELF_SNAP_HDG_UNLOCK = 60;
  const SELF_SNAP_MOVING_MS = 1.5; // ~5.4 km/h
  const _distSnap = navigationActive && routeProj != null && routeProj.distM <= SELF_SNAP_M;
  const _travelHdg = camHeadingRef.current != null ? camHeadingRef.current : (selfCar?.heading ?? null);
  let _hdgOk = true;
  if (_distSnap && _travelHdg != null && (userSpeedMs ?? 0) >= SELF_SNAP_MOVING_MS) {
    // Absolute shortest-arc angle between travel heading and the route segment bearing.
    const _hd = Math.abs(((((_travelHdg - routeProj!.bearing) % 360) + 540) % 360) - 180);
    _hdgOk = snapHdgOkRef.current ? _hd <= SELF_SNAP_HDG_UNLOCK : _hd <= SELF_SNAP_HDG_LOCK;
  }
  snapHdgOkRef.current = _distSnap ? _hdgOk : true; // reset the latch when not distance-snapped
  const selfSnapped = _distSnap && _hdgOk;
  // Feed the throttled road-snap query with the latest raw pose — only while NOT route-snapped
  // (idle / off-route), so it never runs during normal on-route nav.
  const _roadActive = !selfSnapped && selfCar != null;
  roadInputsRef.current = {
    lat: selfCar?.lat ?? 0, lng: selfCar?.lng ?? 0,
    hdg: _travelHdg, speed: userSpeedMs ?? 0, active: _roadActive,
  };
  // Project the LIVE raw fix onto the locked road line each render (smooth along-road tracking,
  // no ~1.4 s lag); drop back to raw once we've drifted beyond the release band laterally
  // (genuinely left the road / a parking lot).
  let roadDraw: { lat: number; lng: number } | null = null;
  if (_roadActive && roadSnap && selfCar) {
    const _p = projectOntoRoute(selfCar.lat, selfCar.lng, roadSnap.line);
    if (_p && _p.distM <= ROAD_SNAP_RELEASE_M) roadDraw = { lat: _p.lat, lng: _p.lng };
  }
  // DISPLAY-ONLY draw position: route line (snapped) → nearest road (idle/off-route) → raw GPS.
  // Reroute + /location + presence stay on RAW GPS (see nav.ts); NEVER lift this into `coords`.
  const selfDraw = selfSnapped
    ? { lat: routeProj!.lat, lng: routeProj!.lng }
    : roadDraw
    ? roadDraw
    : (selfCar ? { lat: selfCar.lat, lng: selfCar.lng } : null);
  // Heading LOCK — the "car drifting/spinning around" fix. The camera heading is already
  // smoothed + held when stopped (camHeadingRef); the car model was still riding RAW GPS
  // heading, which spins at low speed. When snapped, point the car along the route's
  // bearing at that spot (stable + line-aligned); else fall back to the smoothed camera
  // heading; else raw. So the car sits ON the line pointing down it, never wandering.
  const selfHeadingLocked = selfSnapped
    ? routeProj!.bearing
    : (camHeadingRef.current != null ? camHeadingRef.current : (selfCar?.heading ?? 0));

  // Memoized so the downstream GL FeatureCollection memo can actually cache (a bare
  // .filter() returns a fresh array every render). Number.isFinite also drops NaN coords.
  const visibleHazards = useMemo(
    () => (hazards || []).filter((h) => h && Number.isFinite(h.lat) && Number.isFinite(h.lng)),
    [hazards],
  );
  const showRoutes = !!destination && routeFC.features.length > 0;

  // Speed cameras render ONLY along the SELECTED route (within the corridor), so
  // they don't clutter the rest of the map. No selected route → no camera pins.
  // The OSM fetch is unchanged; this just picks the on-route subset to draw, and
  // the proximity VOICE alert in map.tsx still uses the full set — so no camera
  // warnings are lost, this is purely about decluttering the visual pins.
  const onRouteCameras = useMemo(() => {
    const cams = speedCameras || [];
    if (cams.length === 0) return [];
    const line = decodePolyline(routes?.[selectedRouteIndex]?.polyline);
    if (line.length < 2) return [];
    return cams.filter((c) => {
      let best = Infinity;
      for (let i = 0; i + 1 < line.length; i++) {
        const d = distPointToSegM(c.lat, c.lng, line[i].latitude, line[i].longitude, line[i + 1].latitude, line[i + 1].longitude);
        if (d < best) best = d;
        if (best <= ROUTE_CAMERA_CORRIDOR_M) break;
      }
      return best <= ROUTE_CAMERA_CORRIDOR_M;
    });
  }, [speedCameras, routes, selectedRouteIndex]);

  // Preview congestion gradient is shown whenever we have a fetched congestion
  // route, a destination, and we're not navigating. When on, it REPLACES the
  // solid blue selected ribbon (so there's only one line for the active route).
  const showCongestion = !!congestionRoute && !navigationActive && !!destination;
  const congestionFeature: any = useMemo(
    () => congestionRoute
      ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: congestionRoute.coordinates } }
      : null,
    [congestionRoute],
  );

  return (
    <View
      style={styles.container}
      onLayout={(e: any) => {
        const h = e?.nativeEvent?.layout?.height;
        if (typeof h === "number" && h > 0 && Math.abs(h - mapH) > 1) setMapH(h);
      }}
    >
      <MapView
        ref={mapRef}
        style={styles.map}
        styleURL={styleURL}
        projection="mercator"
        scaleBarEnabled={false}
        compassEnabled={false}
        logoEnabled
        attributionEnabled
        logoPosition={{ bottom: 8, left: 8 }}
        attributionPosition={{ bottom: 8, right: 8 }}
        pitchEnabled
        rotateEnabled
        onDidFinishLoadingMap={() => { readyRef.current = true; onMapReady?.(); }}
        // Double-tap belongs to PIN DROP (map.tsx detects two quick presses), so
        // Mapbox's native double-tap-zoom is off — pinch still zooms as always.
        gestureSettings={{ doubleTapToZoomInEnabled: false }}
        onPress={(f: any) => {
          const c = f?.geometry?.coordinates;
          const p = f?.properties;
          onMapPress?.(Array.isArray(c) && typeof c[0] === "number"
            ? { lat: c[1], lng: c[0], sx: p?.screenPointX, sy: p?.screenPointY }
            : undefined);
        }}
        onLongPress={(f: any) => {
          const c = f?.geometry?.coordinates;
          if (Array.isArray(c) && typeof c[0] === "number") onMapLongPress?.({ lat: c[1], lng: c[0] });
        }}
        onCameraChanged={(state: any) => {
          // gestures.isGestureActive cleanly separates a real finger-pan from our
          // own setCamera moves — no self-moving guard flag needed (unlike the
          // Google engine). Fire onUserPan once per gesture so follow drops and
          // the camera stops chasing until Recenter / auto-recenter.
          const active = !!state?.gestures?.isGestureActive;
          if (active && !gesturingRef.current) { gesturingRef.current = true; onUserPan?.(); }
          else if (!active && gesturingRef.current) { gesturingRef.current = false; }
          // (3D car scale is driven natively by the modelScale zoom expression —
          // CAR_MODEL_SCALE_BY_ZOOM — so it tracks the live zoom every frame with
          // no JS lag; nothing to recompute here.)
          // Report the live bearing for the on-map compass, throttled to ~0.5°.
          const h = state?.properties?.heading;
          if (typeof h === "number" && Math.abs(h - lastHeadingRef.current) > 0.5) {
            lastHeadingRef.current = h;
            onHeading?.(h);
            setDbgCamHdg(h);
          }
          // Live zoom for the debug strip (throttled so it doesn't re-render every frame).
          const z = state?.properties?.zoom;
          if (typeof z === "number" && Math.abs(z - lastZoomRef.current) > 0.05) {
            lastZoomRef.current = z;
            setDbgZoom(z);
          }
        }}
      >
        {/* Mapbox Standard "night" config — turns on the dark 3D-building
            basemap. Only mounted when the Standard style is active (roadmap +
            dark); harmless no-op for the satellite/street styles. 3D buildings
            are on by default in Standard, so only the light preset is set. */}
        {useStandard && (
          <Mapbox.StyleImport id="basemap" existing config={{ lightPreset: mapMode, show3dObjects: show3dBuildings }} />
        )}

        {/* Road-snap source (Phase 2): mapbox-streets-v8 roads. Standard v3 hides its own
            road layers from queries, so we add our own source + an INVISIBLE road LineLayer
            (opacity 0) purely so the road tiles load in the viewport; querySourceFeatures on
            it feeds the nearest-road snap. Zero visual footprint, no network beyond tiles. */}
        <Mapbox.VectorSource id={ROAD_SRC_ID} url="mapbox://mapbox.mapbox-streets-v8">
          <Mapbox.LineLayer id="convoy-road-query" sourceLayerID="road" style={{ lineOpacity: 0, lineWidth: 1 } as any} />
        </Mapbox.VectorSource>

        {/* Register the self-car 3D model once for the map. Referenced by id
            ("convoyCar") from the ModelLayer below. */}
        <Models key={selfModelId} models={{ [selfModelId]: selfModelUrl }} />

        {/* "Class" appearance: register the top-down sprite. Painted → live
            composite snapshot; unpainted photo → static registration; no photo
            yet → tinted silhouette. Keyed by class+paint so changes swap live. */}
        {selfIsClass && (selfClassAsShot ? (
          selfClassPainted ? (
            <Images key={selfClassImg}>
              <MBXImage name={selfClassImg}>
                <ClassSprite vehicleClass={selfVehicleClass} primary={_pri} secondary={_sec} size={66} />
              </MBXImage>
            </Images>
          ) : (
            <Images key={selfClassImg} images={{ [selfClassImg]: selfClassAsShot }} />
          )
        ) : (
          <Images key={selfClassImg}>
            <MBXImage name={selfClassImg}>
              <TopDownClassSnap color={_pri || "#2DEC86"} />
            </MBXImage>
          </Images>
        ))}

        {/* Mapbox's native location layer — REQUIRED to power the Camera's
            followUserLocation (a hidden/unmounted location component doesn't start
            the native engine, which stops the chase cam). So we keep it VISIBLE
            but give it fully TRANSPARENT artwork (top/bearing/shadow image = a 1×1
            clear PNG) and disable the pulse: the engine runs and the camera
            follows, but no blue dot is drawn under the car. `scale` only scales
            the custom images, not the default native dot — which is why scale={0}
            alone never hid it. The GR Corolla MarkerView stays the self-car on top. */}
        <Mapbox.Images images={{ convoyEmptyPuck: EMPTY_PUCK_IMG }} />
        <LocationPuck
          visible
          topImage="convoyEmptyPuck"
          bearingImage="convoyEmptyPuck"
          shadowImage="convoyEmptyPuck"
          pulsing={{ isEnabled: false }}
          puckBearing="course"
          puckBearingEnabled
        />

        <Camera
          ref={cameraRef}
          // COLD-START FIX: keep follow OFF until the cold-lock window elapses.
          // With followUserLocation true from the FIRST render, rnmapbox's native
          // follow engine seizes the camera at frame 0 and IGNORES defaultSettings,
          // flying in from the style's world-default to the user at followZoom —
          // that was the cold-start zoom-in. While follow is off, defaultSettings
          // (centerCoordinate + zoom 17) frames the driver statically; once
          // coldLockDone flips (~1.2s) follow engages from that same pose, so there
          // is no fly-in. (animationMode does NOT govern the follow engine's lock-on,
          // which is why the earlier animationMode="none" attempt had no effect.)
          // HEADING-UP is now driven by the imperative LOCKSTEP camera (SelfCarModel /
          // lockReadyRef) instead of this native engine — so native follow is left ON
          // only for NORTH-UP, where there's no per-frame heading to lockstep.
          followUserLocation={followUser && !placesShown && coldLockDone && !headingUp}
          followUserMode={followMode}
          followZoomLevel={followZoom}
          followHeading={followHeadingDeg}
          followPitch={followPitchDeg}
          followPadding={followPadding}
          // Cold-start: instant (no fly-in / zoom) until the first lock settles, then default animated follow.
          animationMode={coldLockDone ? undefined : "none"}
          animationDuration={coldLockDone ? undefined : 0}
          defaultSettings={
            typeof initLat === "number" && typeof initLng === "number"
              ? { centerCoordinate: [initLng, initLat], zoomLevel: FOLLOW_ZOOM }
              : undefined
          }
        />

        {/* ===== Routes ===== gray alternates first, then the SELECTED glowing
            green ribbon (green glow under, bright green core on top). All in the
            "middle" slot so the Standard style's street labels stay legible on
            top of the line. Tap an alternate to select it (ShapeSource onPress).
            While previewing, the solid blue ribbon is REPLACED by the live
            congestion gradient (the convoy-congestion source just below) — the
            selected casing/core are hidden by filtering them to a non-existent
            index rather than unmounting, since ShapeSource children must always
            be elements (never a boolean). */}
        {showRoutes && (
          <ShapeSource id="convoy-routes" shape={routeFC} onPress={handleRoutePress} lineMetrics>
            {/* Non-selected preview routes (Best / Scenic / AI), dimmed. Each route carries
                its own `edge` + `color` so ONE data-driven casing+core pair renders all
                three kinds — including AI's inverted look (user-color edges, black core).
                Shown ONLY in preview; during active navigation they're filtered to a
                non-existent index so no alternate draws straight through the car. */}
            {/* During NAV, alternates are filtered out — EXCEPT the mid-drive reroute
                OFFER line (kind "offer"): the Google-style inline alternate that draws
                beside the active ribbon so the driver can tap it to switch. */}
            <LineLayer
              id="route-alt-casing"
              slot="middle"
              filter={(navigationActive ? ["==", ["get", "kind"], "offer"] : ["!=", ["get", "index"], selectedRouteIndex]) as any}
              style={{ lineColor: ["get", "edge"] as any, lineWidth: 17, lineBlur: 5, lineOpacity: 0.4, lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1 }}
            />
            <LineLayer
              id="route-alt-core"
              slot="middle"
              filter={(navigationActive ? ["==", ["get", "kind"], "offer"] : ["!=", ["get", "index"], selectedRouteIndex]) as any}
              style={{ lineColor: ["get", "color"] as any, lineWidth: 7, lineOpacity: 0.7, lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1 }}
            />
            {/* Selected route ribbon — casing (edges) + core, in the selected kind's colors
                (Best = user color, Scenic = contrasting, AI = user-color edges + black core). */}
            {/* slot="top" (was "middle") so the 3D self-car ModelLayer (also slot="top",
                +10m lift) renders OVER the active route ribbon — matching the CarPlay
                surface (car-route-sel-* are slot="top" there and the car sits on top,
                which is the desired look). Mapbox's shared model/line depth buffer makes
                a "middle" route paint OVER the top-slot car (rnmapbox #13049/#13428); the
                car only wins when the route shares its "top" slot. Only the ACTIVE route
                (sel casing/core + nav congestion) moves up — the dimmed alternates stay
                at "middle", exactly as CarPlay does. */}
            <LineLayer
              id="route-sel-casing"
              slot="top"
              filter={(showCongestion ? ["==", ["get", "index"], -1] : ["==", ["get", "index"], selectedRouteIndex]) as any}
              style={{ lineWidth: 24, lineBlur: 8, lineOpacity: 0.55, lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1, ...(selGlowGradient ? { lineGradient: selGlowGradient, lineTrimOffset: [0, routeTrimEndFrac ?? 1] } : { lineColor: selEdge }) }}
            />
            <LineLayer
              id="route-sel-core"
              slot="top"
              // Hidden in preview-congestion AND while the dedicated congestion core
              // (below) is active, so we never double-draw or let the trimmed green core
              // paint over the congestion colours.
              filter={((showCongestion || navCongActive) ? ["==", ["get", "index"], -1] : ["==", ["get", "index"], selectedRouteIndex]) as any}
              style={{ lineWidth: 12, lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1, ...(selCoreGrad ? { lineGradient: selCoreGrad, lineTrimOffset: [0, routeTrimEndFrac ?? 1] } : { lineColor: selColor }) }}
            />
            {/* CONGESTION core (DURING NAV) — a dedicated, NON-TRIMMED clone of the proven
                preview cong-core: the live traffic gradient over the full active route, so
                the green→yellow→orange→red transitions render while navigating (the trimmed
                route-sel-core flattened them). The wide glow casing above keeps the trim, so
                the behind-car vanish still reads. Hidden unless navigating with real data. */}
            <LineLayer
              id="route-sel-cong"
              slot="top"
              filter={(navCongActive ? ["==", ["get", "index"], selectedRouteIndex] : ["==", ["get", "index"], -1]) as any}
              style={{ lineWidth: 12, lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1, ...(navCongGapped ? { lineGradient: navCongGapped } : { lineColor: selColor }) }}
            />
          </ShapeSource>
        )}

        {/* ===== Live traffic-congestion gradient (preview) ===== Mapbox
            Directions driving-traffic, painted as a cased ribbon whose CORE is a
            congestion gradient — blue when clear, warming to yellow / orange /
            red where traffic slows. Replaces the solid blue selected ribbon
            while previewing. `lineMetrics` enables the line-progress gradient. */}
        {showCongestion && congestionFeature && (
          <ShapeSource id="convoy-congestion" shape={congestionFeature} lineMetrics>
            <LineLayer
              id="cong-casing"
              slot="top"
              style={{ lineColor: selEdge, lineWidth: 24, lineBlur: 8, lineOpacity: 0.55, lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1 }}
            />
            <LineLayer
              id="cong-core"
              slot="top"
              style={{ lineGradient: congestionRoute!.gradient, lineWidth: 12, lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1 }}
            />
          </ShapeSource>
        )}

        {/* Destination pin — the Hairpin brand pin (cropped straight from the
            wordmark, so map pins and the logo are literally the same art).
            Bottom-anchored: the teardrop tip sits ON the destination. */}
        {destination && (
          <MarkerView coordinate={[destination.lng, destination.lat]} anchor={{ x: 0.5, y: 1 }}>
            <Image source={require("../assets/images/brand-pin.png")} style={styles.brandPin} resizeMode="contain" />
          </MarkerView>
        )}

        {/* Mid-drive reroute OFFER pill (Google-style) — anchored where the blue
            offer line peels off the active route. Tap → switch instantly; ✕ →
            dismiss. Replaces the old RerouteCard modal (Jeff: no popups). */}
        {offerPill && (
          <MarkerView coordinate={[offerPill.lng, offerPill.lat]} anchor={{ x: 0.5, y: 1.15 }} allowOverlap>
            <TouchableOpacity onPress={onOfferAccept} activeOpacity={0.85} style={styles.offerPill}>
              <View style={styles.offerBolt}>
                <Ionicons name="flash" size={14} color="#0A1A10" />
              </View>
              <View style={{ minWidth: 0 }}>
                <Text style={styles.offerTitle}>{`Save ${offerPill.savedMin} min`}</Text>
                <Text style={styles.offerSub} numberOfLines={1}>
                  {offerPill.arrival ? `Tap to switch · ${offerPill.arrival}` : "Tap to switch"}
                </Text>
              </View>
              <TouchableOpacity onPress={onOfferDismiss} hitSlop={10} style={styles.offerClose}>
                <Ionicons name="close" size={15} color="#8E8E93" />
              </TouchableOpacity>
            </TouchableOpacity>
          </MarkerView>
        )}

        {/* Route ETA pills — on each ALTERNATE route's midpoint, preview only.
            The selected route's ETA already shows in the bottom Drive card, so
            it's skipped here. Tap a pill to switch to that route. */}
        {destination && !navigationActive && (routes || []).map((r: any, i: number) => {
          if (i === selectedRouteIndex) return null;
          const pts = decodePolyline(r.polyline);
          if (pts.length === 0) return null;
          const mid = pts[Math.floor(pts.length / 2)];
          const label = r.duration_in_traffic_text || r.duration_text || "";
          if (!label) return null;
          return (
            <MarkerView key={`eta_${i}_${selectedRouteIndex}`} coordinate={[mid.longitude, mid.latitude]} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
              <Pressable onPress={() => onSelectRoute?.(i)} hitSlop={6}>
                <View style={styles.etaPillAlt}>
                  <Text style={styles.etaPillTextAlt}>{label}</Text>
                </View>
              </Pressable>
            </MarkerView>
          );
        })}

        {/* Hazards / cameras / DriveBC incidents / place pins — GL layers. Within a
            Mapbox slot, z-order is ADD-time order, not JSX order: these pin layers
            mount at app open, the route layers only get ADDED when a route first
            exists — so a later route painted OVER the pins (tester photo). The key
            forces a pin-layer REMOUNT whenever route layers appear/disappear,
            re-adding the pins after the route so they stack on top again. */}
        <GLPinLayers
          key={`pins-${routeFC.features.length > 0 ? "r" : "n"}`}
          hazards={visibleHazards}
          cameras={onRouteCameras}
          incidents={roadEvents || []}
          places={places || []}
          onHazardPress={onHazardPress}
          onPlacePress={onPlacePress}
        />

        {/* Arrival-weather chip floating above the destination. */}
        {destination && destWeather && (
          <DestWeatherMarker lat={destination.lat} lng={destination.lng} weather={destWeather} />
        )}

        {/* Self car as a 3D GLB model (ModelLayer). Lives in the map's geo space
            (rotates/tilts with the world), unlike the screen-space PNG MarkerView.
            modelRotation z = world heading + offset. Renders only if ModelLayer is
            present in the running native build — this OTA is the test for that. */}
        {selfCar && (
          <SelfCarModel
            lat={(selfDraw ?? selfCar).lat}
            lng={(selfDraw ?? selfCar).lng}
            heading={selfHeadingLocked}
            emissive={selfEmissive}
            modelId={selfModelId}
            scale={selfIsArrow ? ARROW_MODEL_SCALE : undefined}
            headingOffset={selfIsArrow ? ARROW_MODEL_HEADING_OFFSET : undefined}
            pitchTilt={selfIsArrow ? ARROW_MODEL_PITCH : 0}
            sprite={selfIsClass ? selfClassImg : undefined}
            // Same ~59pt on-screen footprint from each source: painted snapshot
            // is a 66pt view (device-scale dense) → 0.9; the static photo is a
            // 132px @1x asset → 0.45; silhouette snapshot → 1.
            spriteSize={selfClassAsShot ? (selfClassPainted ? 0.9 : 0.45) : 1}
            cameraRef={cameraRef}
            getCam={getCam}
            readyRef={lockReadyRef}
          />
        )}

        {/* Car markers — PEERS only (self is the 3D model above). MarkerViews
            always render above the route LineLayers, and we declare the cars LAST
            so they sit on top of the other pins too. */}
        {cars.filter((c) => c.id !== SELF_ID).map((c) => (
          <CarMarker key={c.id} car={c} mapHeading={mapHeadingDeg} onPress={() => { if (c.peer) onPeerPress?.(c.peer); }} />
        ))}
      </MapView>

      {/* Heading-up diagnostic readout — gated by the Debug toggle in Settings. */}
      {getSettings().debugOverlays && (
      <View pointerEvents="none" style={{ position: 'absolute', top: 120, left: 8, zIndex: 9999, backgroundColor: 'rgba(0,0,0,0.6)', paddingVertical: 3, paddingHorizontal: 6, borderRadius: 6 }}>
        <Text style={{ color: '#00FF88', fontSize: 11, fontWeight: '600' }}>
          {`HDG mode:${mapView} feed:${followHeadingDeg != null ? Math.round(followHeadingDeg) : '-'} cam:${Math.round(dbgCamHdg)} gps:${Math.round(selfHeadingDeg)} foll:${followUser ? 'Y' : 'N'} lock:${coldLockDone ? 'Y' : 'N'} zoom:${dbgZoom.toFixed(1)}`}
        </Text>
        <Text style={{ color: '#00FF88', fontSize: 11, fontWeight: '600' }}>{`CAR store fix:${typeof getCarState().selfLat === 'number' ? 'Y' : 'N'} @${typeof getCarState().selfLat === 'number' ? getCarState().selfLat!.toFixed(3) : '-'},${typeof getCarState().selfLng === 'number' ? getCarState().selfLng!.toFixed(3) : '-'} spd:${(getCarState().speedMs || 0).toFixed(0)}`}</Text>
      </View>
      )}
    </View>
  );
}

export default ConvoyMapbox;

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1, backgroundColor: "#0B0B0C" },
  car: { width: 46, height: 46 },
  // Route ETA pill (alternate routes, preview mode).
  etaPillAlt: {
    backgroundColor: "rgba(28,28,30,0.95)",
    borderColor: "rgba(255,255,255,0.25)",
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 13,
  },
  etaPillTextAlt: { color: "#C9C9CE", fontSize: 12, fontWeight: "700" },
  // Destination pin (red dot with white ring).
  destPin: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: "#FF453A", borderWidth: 3, borderColor: "#FFFFFF",
  },
  // Hairpin brand pin (the wordmark's teardrop) — destination + place results.
  // 73x95 source → 34x44 keeps it crisp; badge centers on the pin's round head.
  brandPin: { width: 34, height: 44 },
  brandPinWrap: { width: 34, height: 44, alignItems: "center" },
  brandPinBadge: {
    position: "absolute", top: 5, left: 7, width: 20, height: 20, borderRadius: 10,
    backgroundColor: "#0A1A10", alignItems: "center", justifyContent: "center",
  },
  // Scale-aware variant: size/position come inline from the marker's `scale`.
  brandPinBadgeDyn: {
    position: "absolute", backgroundColor: "#0A1A10",
    alignItems: "center", justifyContent: "center",
  },
  // Mid-drive reroute offer pill (tap = switch, ✕ = dismiss).
  offerPill: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "rgba(10,12,14,0.94)", borderRadius: 14,
    borderWidth: 1.5, borderColor: "rgba(91,141,239,0.75)",
    paddingVertical: 8, paddingHorizontal: 10,
    shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  offerBolt: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: "#2DEC86",
    alignItems: "center", justifyContent: "center",
  },
  offerTitle: { color: "#2DEC86", fontWeight: "900", fontSize: 14.5 },
  offerSub: { color: "#C9C9CE", fontWeight: "600", fontSize: 11 },
  offerClose: { marginLeft: 2, padding: 2 },
  // Hazard / camera icons.
  hazardIcon: { width: 40, height: 40 },
  cameraIconWrap: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  cameraIcon: { width: 28, height: 28 },
  incidentBadge: {
    width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: "rgba(11,11,12,0.85)",
    shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 4,
  },
  // Transparent wrapper for the incident glyph snapshotted into a GL symbol image
  // (drawn over the severity CircleLayer). Sized to the ionicon so the snapshot is tight.
  incidentGlyphSnap: { width: 18, height: 18, alignItems: "center", justifyContent: "center", backgroundColor: "transparent" },
  // Speed-camera glass badge (snapshotted into a native symbol image): dark
  // translucent floor + brand-green hairline + a top highlight strip — reads as
  // frosted glass on the map without needing a live blur view.
  camGlassSnap: {
    width: 30, height: 30, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(12,17,14,0.82)",
    borderWidth: 1, borderColor: "rgba(45,236,134,0.55)",
    overflow: "hidden",
  },
  camGlassHighlight: {
    position: "absolute", top: 1, left: 3, right: 3, height: 9,
    borderRadius: 7, backgroundColor: "rgba(255,255,255,0.12)",
  },
  // Place pins (gas price chips / fuel badges / named places).
  placePinWrap: { alignItems: "center", maxWidth: 150 },
  placeLabel: {
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 6, marginBottom: 1,
    maxWidth: 150,
    borderWidth: 1, borderColor: "rgba(0,0,0,0.55)",
    shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 2, shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  placeLabelText: { color: "#000000", fontSize: 11, fontWeight: "700" },
  placeTextCenter: { textAlign: "center" },
  // Unified numbered result pin (green bg, thin grey border, Convoy font).
  placeNumPin: {
    minWidth: 30, height: 30, borderRadius: 15,
    paddingHorizontal: 7,
    backgroundColor: "#2DEC86",
    borderWidth: 1, borderColor: "#8E8E93",
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
  // Brand green, NOT near-black: the number sits on the badge's dark #0A1A10
  // circle — dark-on-dark made the CarPlay PlaceMarker numbers invisible.
  placeNumText: { color: "#2DEC86", fontSize: 14, fontWeight: "800" },
  locPin: { alignItems: "center", justifyContent: "center" },
  locPinInner: { position: "absolute" },
  placePriceLabel: { backgroundColor: "#FFD60A", borderWidth: 1, borderColor: "rgba(0,0,0,0.55)" },
  placePriceCheapest: { backgroundColor: "#30D158", borderColor: "rgba(0,0,0,0.55)" },
  placePriceText: { color: "#0A0A0A", fontSize: 13, fontWeight: "800" },
  gasGlyph: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(20,20,22,0.92)",
    borderWidth: 1, borderColor: "rgba(255,214,10,0.6)",
    shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 2,
  },
  // Arrival-weather chip.
  destWxChip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: "rgba(22,22,24,0.92)",
    borderRadius: 13, paddingHorizontal: 9, paddingVertical: 5,
    marginBottom: 8,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
    shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  destWxText: { color: "#fff", fontSize: 14, fontWeight: "700", letterSpacing: -0.2 },
});
