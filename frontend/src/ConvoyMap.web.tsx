// Web implementation using @vis.gl/react-google-maps with Directions support
import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { APIProvider, Map, Marker, useMap, useMapsLibrary, useApiIsLoaded } from "@vis.gl/react-google-maps";
import { COLORS } from "./theme";
import { getVehiclePngDataUri, getVehiclePngDataUriOrDefault, isGRCColor } from "./vehicleAssets";
import type { ExternalAlert, ExternalAlertType } from "./externalFeed";
import { BearingTracker } from "./bearing";

const KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY as string;

// MODULE-LEVEL CONSTANT â must NOT be re-created per render.
// The @vis.gl/react-google-maps APIProvider does identity-comparison on its
// `libraries` prop. Passing a fresh array literal each render caused the SDK
// to re-request the same modules, which Google rejects with:
//   "Module 'X' has been provided more than once."
//
// Rules of the road for this list:
//   â¢ Define it ONCE here at module scope (singleton â never inside the component).
//   â¢ Only put a library here if it's used by a component that mounts on every
//     map render. Anything used by an optional/lazy child (e.g. Directions â
//     routes) should be loaded on demand via useMapsLibrary("routes") INSTEAD
//     of being listed here. Having BOTH triggers the "provided more than once"
//     error.
//   â¢ "marker"   â AdvancedMarkerElement (future-proofing for vector renderer).
//   â¢ "geometry" â encoded-polyline decoding (RoutesLayer + Directions).
//   â¢ "places"   â AutocompleteService + PlacesService used by DestinationSearch.
//   â¢ "routes"   â INTENTIONALLY OMITTED. Loaded lazily by useMapsLibrary("routes")
//                  in the Directions component.
const MAPS_LIBRARIES: ("marker" | "geometry" | "places")[] = ["marker", "geometry", "places"];

export type Hazard = { id: string; kind: string; lat: number; lng: number; reporter_handle?: string; confirms?: number };
export type Peer = { user_id: string; handle?: string; lat: number; lng: number; carType?: string; carBody?: string; carColor?: string; activeColor?: string; heading?: number; topSpeed?: number };
export type LatLng = { lat: number; lng: number };

type Props = {
  center: LatLng;
  // Same shape as the native map â carBody/carColor pulled from Garage profile
  // so the user sees their own silhouette + paint, not a generic arrow dot.
  user: { lat: number; lng: number; heading?: number; carBody?: string; carColor?: string };
  // Privacy: when true the "you" marker is hidden â used by the Avatar Live
  // toggle. The caller also disables the presence channel so peers don't see
  // us either.
  hideSelfMarker?: boolean;
  // Map view mode â exclusive radio choice from settings. Defaults to
  // "heading_up" (chase cam, tilt+rotate). "north_up" forces tilt=0 and
  // bearing=0 for a classic flat top-down feel.
  mapView?: "heading_up" | "north_up";
  // Layer controls driven by the Layers FAB bottom sheet.
  mapType?: "hybrid" | "roadmap";
  showTraffic?: boolean;
  showTransit?: boolean;
  showHazards?: boolean;
  peers: Peer[];
  leaderUserId?: string | null;
  hazards: Hazard[];
  externalAlerts?: ExternalAlert[];
  highlightConvoy?: boolean;
  destination?: LatLng | null;
  encodedPolyline?: string | null;
  routes?: { polyline: string }[];
  selectedRouteIndex?: number;
  onSelectRoute?: (index: number) => void;
  followUser?: boolean;
  // Mirrors ConvoyMap.tsx (native): caller's `isFollowing` state. We fire
  // this when the user drags the Google Maps Web JS map by hand, so the
  // parent can disable the follow flag and stop tracking the user.
  onUserPan?: () => void;
  // Mirrors ConvoyMap.tsx (native): when on, web map zooms in tight, sets
  // tilt 45Â° (Vector mode only â no-op on Raster), and rotates to user.heading.
  navigationActive?: boolean;
  userSpeedMs?: number;
  // Empty-map click â bubble up so the parent can dismiss search overlays etc.
  onMapPress?: () => void;
  onHazardPress: (h: Hazard) => void;
  /** Right-click a hazard pin (web equivalent of long-press) to remove it. */
  onHazardLongPress?: (h: Hazard) => void;
  onPeerPress?: (p: Peer) => void;
  onExternalAlertPress?: (a: ExternalAlert) => void;
  onRoute?: (info: { distance_text: string; duration_text: string; steps: { html: string; distance_text: string; maneuver?: string }[] } | null) => void;
};

// Chase-cam tuning â mirrors the native side (ConvoyMap.tsx).
const CHASE_PITCH_DEG = 45;
const CHASE_ZOOM_CITY = 18;
const CHASE_ZOOM_HIGHWAY = 16;
const CHASE_KMH_CITY = 30;
const CHASE_KMH_HIGHWAY = 100;
function lerp(a: number, b: number, t: number) { const k = Math.max(0, Math.min(1, t)); return a + (b - a) * k; }
function kmhFromMs(s: number | undefined | null) { return typeof s === "number" && Number.isFinite(s) && s >= 0 ? s * 3.6 : 0; }
function chaseZoomForSpeed(kmh: number) {
  if (kmh <= CHASE_KMH_CITY) return CHASE_ZOOM_CITY;
  if (kmh >= CHASE_KMH_HIGHWAY) return CHASE_ZOOM_HIGHWAY;
  return lerp(CHASE_ZOOM_CITY, CHASE_ZOOM_HIGHWAY, (kmh - CHASE_KMH_CITY) / (CHASE_KMH_HIGHWAY - CHASE_KMH_CITY));
}

const hazardColor = (k: string) =>
  k === "police" ? "#3478F6" : k === "accident" ? "#FF453A" : k === "traffic" ? "#FF9F0A" : "#FF9F0A";

const extColor = (t: ExternalAlertType) =>
  t === "POLICE" ? "#3478F6"
    : t === "ACCIDENT" ? "#FF453A"
    : t === "JAM" ? "#FF9F0A"
    : t === "HAZARD" ? "#FFD60A"
    : t === "CONSTRUCTION" ? "#FF9500"
    : t === "WEATHER" ? "#5AC8FA"
    : "#8E8E93";
const EXT_GLYPHS: Record<ExternalAlertType, string> = {
  POLICE: "ð¨", ACCIDENT: "â ", JAM: "â¼", HAZARD: "!",
  CONSTRUCTION: "â", WEATHER: "â", OTHER: "â¢",
};

function pinIcon(color: string, glyph: string) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='52' height='62' viewBox='0 0 52 62'>
    <defs><filter id='s' x='-50%' y='-50%' width='200%' height='200%'><feDropShadow dx='0' dy='3' stdDeviation='3' flood-opacity='0.5'/></filter></defs>
    <g filter='url(#s)'>
      <circle cx='26' cy='24' r='22' fill='${color}' stroke='white' stroke-width='3'/>
      <polygon points='20,44 32,44 26,58' fill='${color}' stroke='white' stroke-width='2'/>
      <text x='26' y='32' font-family='Arial,sans-serif' font-size='22' font-weight='bold' text-anchor='middle' fill='white'>${glyph}</text>
    </g></svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}
// Smaller diamond pin for external (Waze-feed) alerts to differentiate from user-reported hazards
function diamondIcon(color: string, glyph: string) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='38' height='44' viewBox='0 0 38 44'>
    <defs><filter id='ds' x='-50%' y='-50%' width='200%' height='200%'><feDropShadow dx='0' dy='2' stdDeviation='2' flood-opacity='0.45'/></filter></defs>
    <g filter='url(#ds)'>
      <polygon points='19,2 36,18 19,34 2,18' fill='${color}' stroke='white' stroke-width='2.5'/>
      <polygon points='15,34 23,34 19,42' fill='${color}' stroke='white' stroke-width='1.5'/>
      <text x='19' y='23' font-family='Arial,sans-serif' font-size='14' font-weight='bold' text-anchor='middle' fill='white'>${glyph}</text>
    </g></svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}
function dotIcon(color: string, glyph: string, size = 32) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'>
    <circle cx='${size / 2}' cy='${size / 2}' r='${size / 2 - 2}' fill='${color}' stroke='white' stroke-width='2'/>
    <text x='${size / 2}' y='${size / 2 + 5}' font-family='Arial' font-size='14' font-weight='bold' text-anchor='middle' fill='white'>${glyph}</text>
  </svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}

// Top-down car icon for peers â colored by their car_color and rotated to match
// the heading from expo-location. Mirrors the path data in `src/CarMarker.tsx`
// so the look is identical on web and native.
const CAR_BODY_PATHS_WEB: Record<string, string> = {
  sedan:      "M50 10 L70 24 L72 78 L66 92 L34 92 L28 78 L30 24 Z",
  coupe:      "M50 10 L70 24 L74 60 L70 84 L58 92 L42 92 L30 84 L26 60 L30 24 Z",
  sports:     "M50 8 L74 26 L78 64 L72 86 L60 92 L40 92 L28 86 L22 64 L26 26 Z",
  suv:        "M50 8 L72 22 L74 78 L70 92 L30 92 L26 78 L28 22 Z",
  truck:      "M50 8 L70 18 L72 44 L74 92 L26 92 L28 44 L30 18 Z",
  // Aggressive hot-hatch: pointed nose, pronounced front + rear fender flares,
  // mid-body waist, squared-off rear deck. Spoiler is layered separately below.
  hatch:      "M50 6 L60 12 L78 24 L80 32 L72 50 L80 68 L82 80 L78 90 L22 90 L18 80 L20 68 L28 50 L20 32 L22 24 L40 12 Z",
  van:        "M50 10 L74 22 L76 90 L70 94 L30 94 L24 90 L26 22 Z",
  motorcycle: "M50 10 L60 30 L62 70 L56 90 L44 90 L38 70 L40 30 Z",
};
// Optional rear-wing/spoiler overlay drawn AFTER the body. Only the hot-hatch
// gets one (per design â wide rear wing + endplates).
const CAR_SPOILER_PATHS_WEB: Record<string, string | undefined> = {
  hatch: "M14 84 L86 84 L88 92 L12 92 Z M12 80 L18 80 L18 92 L12 92 Z M82 80 L88 80 L88 92 L82 92 Z",
};
const CAR_WINDSHIELD_WEB: Record<string, string> = {
  motorcycle: "M44 30 L56 30 L56 42 L44 42 Z",
  truck:      "M36 22 L64 22 L66 38 L34 38 Z",
  van:        "M34 22 L66 22 L66 36 L34 36 Z",
};
const DEFAULT_WINDSHIELD_WEB = "M38 26 L62 26 L65 44 L35 44 Z";

function resolveCarColorWeb(input?: string | null): string {
  if (!input) return "#0A84FF";
  const t = String(input).trim();
  if (!t) return "#0A84FF";
  if (t.startsWith("#") || t.startsWith("rgb")) return t;
  // Tiny inline lookup for the named palette used in Garage. Keep this in sync
  // with CAR_COLORS in src/CarMarker.tsx â duplicated to avoid web/native cross-import issues.
  const named: Record<string, string> = {
    "bayside blue": "#0A84FF", "nardo gray": "#8E8E93", "guards red": "#FF453A",
    "yellow": "#FFD60A", "pearl white": "#F2F2F7", "jet black": "#1A1A1A",
    "forest green": "#30D158", "dawn orange": "#FF9F0A", "plum purple": "#BF5AF2",
    "carbon": "#3A3A3C", "midnight silver": "#AEAEB2", "cyber brown": "#A2845E",
  };
  return named[t.toLowerCase()] || "#0A84FF";
}

function carIconDataUrl(body: string | undefined | null, color: string | undefined | null, heading: number | undefined | null, size = 44): string {
  const fill = resolveCarColorWeb(color);
  const safeBody = body && CAR_BODY_PATHS_WEB[body] ? body : "sedan";
  const path = CAR_BODY_PATHS_WEB[safeBody];
  const wind = CAR_WINDSHIELD_WEB[safeBody] || DEFAULT_WINDSHIELD_WEB;
  const spoiler = CAR_SPOILER_PATHS_WEB[safeBody];
  const angle = Number.isFinite(heading as number) ? Math.round((heading as number) % 360) : 0;
  const spoilerEls = spoiler
    ? `<path d='${spoiler}' fill='rgba(0,0,0,0.55)' transform='translate(0 1)'/>
       <path d='${spoiler}' fill='url(#g)' stroke='white' stroke-width='1.5' stroke-linejoin='round'/>`
    : "";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 100 100'>
    <defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0' stop-color='${fill}' stop-opacity='1'/><stop offset='1' stop-color='${fill}' stop-opacity='0.78'/>
    </linearGradient></defs>
    <g transform='rotate(${angle} 50 50)'>
      <path d='${path}' fill='rgba(0,0,0,0.45)' transform='translate(0 2)'/>
      <path d='${path}' fill='url(#g)' stroke='white' stroke-width='2' stroke-linejoin='round'/>
      ${spoilerEls}
      <path d='${wind}' fill='rgba(255,255,255,0.55)'/>
      <rect x='48' y='50' width='4' height='26' rx='1' fill='rgba(0,0,0,0.18)'/>
    </g></svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}

// ===== GR Corolla PNG marker icon (web) â ALWAYS-ON =====
// Renders the user's chosen GR Corolla paint as a top-down PNG marker. If the
// color doesn't resolve to one of the 5 official paints, falls back to the
// DEFAULT GRC (Heavy Metal) instead of the generic SVG silhouette â so peers
// never appear as a generic blob and we never render a broken image.
// The PNG is embedded as a base64 data URI inside an SVG wrapper so we can
// apply heading rotation around its center (Google Maps doesn't natively
// rotate marker icons).
function grcCarIconDataUrl(color?: string | null, heading?: number | null, size = 48): string {
  const dataUri = getVehiclePngDataUriOrDefault(color);
  const angle = Number.isFinite(heading as number) ? Math.round((heading as number) % 360) : 0;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 100 100'>
    <g transform='rotate(${angle} 50 50)'>
      <image href='${dataUri}' x='0' y='0' width='100' height='100' preserveAspectRatio='xMidYMid meet'/>
    </g>
  </svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}
function peerPinWithLabel(color: string, label: string) {
  // sanitize for SVG embed
  const txt = (label || "").replace(/[<>&"']/g, "").slice(0, 28);
  const charW = 6;     // approx px per char @ 11pt
  const padX = 10;
  const pillW = Math.max(36, txt.length * charW + padX * 2);
  const W = Math.max(40, pillW + 6);
  const H = 60;
  const dotR = 14;
  const pillH = 18;
  const pillY = 36;
  const pillX = (W - pillW) / 2;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}'>
    <defs><filter id='ps' x='-50%' y='-50%' width='200%' height='200%'><feDropShadow dx='0' dy='2' stdDeviation='2' flood-opacity='0.45'/></filter></defs>
    <g filter='url(#ps)'>
      <circle cx='${W / 2}' cy='${dotR + 2}' r='${dotR}' fill='${color}' stroke='white' stroke-width='2'/>
      <text x='${W / 2}' y='${dotR + 6}' font-family='Arial' font-size='14' font-weight='bold' text-anchor='middle' fill='white'>ð</text>
      ${txt ? `<rect x='${pillX}' y='${pillY}' width='${pillW}' height='${pillH}' rx='6' ry='6' fill='rgba(20,20,24,0.85)' stroke='rgba(255,255,255,0.25)' stroke-width='1'/>
      <text x='${W / 2}' y='${pillY + 12}' font-family='Arial' font-size='10' font-weight='600' text-anchor='middle' fill='white'>${txt}</text>` : ''}
    </g></svg>`;
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    size: { width: W, height: H } as any,
    anchorY: dotR + 2, // anchor at the dot center
  };
}
const HAZARD_GLYPHS: Record<string, string> = { police: "ð¡", accident: "â", road: "!", traffic: "â²" };

// Build a community pin with optional gold border (Convoy users)
function communityPin(color: string, glyph: string, gold: boolean) {
  const ringStroke = gold ? `<circle cx='26' cy='24' r='25' fill='none' stroke='#FFD60A' stroke-width='3'/>` : "";
  const innerBorder = gold ? "#FFD60A" : "white";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='56' height='66' viewBox='-2 -2 56 66'>
    <defs><filter id='cs' x='-50%' y='-50%' width='200%' height='200%'><feDropShadow dx='0' dy='3' stdDeviation='3' flood-opacity='0.55'/></filter></defs>
    <g filter='url(#cs)'>
      ${ringStroke}
      <circle cx='26' cy='24' r='22' fill='${color}' stroke='${innerBorder}' stroke-width='3'/>
      <polygon points='20,44 32,44 26,58' fill='${color}' stroke='${innerBorder}' stroke-width='2'/>
      <text x='26' y='32' font-family='Arial,sans-serif' font-size='22' font-weight='bold' text-anchor='middle' fill='white'>${glyph}</text>
    </g></svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}

export default function ConvoyMap(props: Props) {
  // Two-layer mount strategy:
  //   1. The outer wrapper mounts <APIProvider> immediately so the SDK <script>
  //      starts downloading right away â no waiting.
  //   2. The inner <MapBody> only renders once useApiIsLoaded() flips true,
  //      i.e. window.google.maps is fully authenticated AND ready. This
  //      eliminates the entire class of "p.gK / a.pK" minified errors that
  //      happen when child components (Markers, ChaseCam, Recenter) try to
  //      mutate a not-yet-initialized map.
  if (!KEY) return <View style={styles.fb}><Text style={{ color: "#fff" }}>Google Maps key missing</Text></View>;
  return (
    // Explicit dimensions on the container â react-native-web translates
    // `absoluteFill` into `position: absolute; top/left/right/bottom: 0`,
    // which requires a positioned ancestor. Adding explicit width/height
    // guarantees the map div mounts with real pixel dimensions on the very
    // first render, avoiding the "0Ã0 canvas" path that also triggers the
    // SDK's internal projection errors.
    <View style={[StyleSheet.absoluteFill, { width: "100%", height: "100%", minHeight: 300 }]}>
      <APIProvider apiKey={KEY} libraries={MAPS_LIBRARIES}>
        <MapBody {...props} />
      </APIProvider>
    </View>
  );
}

// MapSkeleton â renders while the Google Maps SDK is still authenticating.
// Same dark background as the bird's-eye map so the swap is visually seamless
// (no flash of white), with a subtle spinner + "Loading Mapâ¦" label. Stays
// mounted for ~50-500ms typically; without it the map mounting raced its own
// init code on slow connections and threw `p.gK`.
function MapSkeleton() {
  return (
    <View style={[StyleSheet.absoluteFill, styles.skeleton]}>
      <ActivityIndicator size="large" color={COLORS.warning} />
      <Text style={styles.skeletonText}>Loading Mapâ¦</Text>
    </View>
  );
}

function MapBody({ center, user, hideSelfMarker = false, peers, leaderUserId, hazards, externalAlerts = [], highlightConvoy = true, destination, encodedPolyline, routes = [], selectedRouteIndex = 0, onSelectRoute, followUser = false, onUserPan, navigationActive = false, userSpeedMs, mapView = "heading_up", mapType = "hybrid", showTraffic = true, showTransit = false, showHazards = true, onMapPress, onHazardPress, onHazardLongPress, onPeerPress, onExternalAlertPress, onRoute }: Props) {
  // Bearing tracker â same logic as the native ConvoyMap. See src/bearing.ts.
  // Resolves "all cars face north when stopped" by remembering each peer's
  // last good heading + computing bearing-from-prev-coord when GPS heading
  // is missing/zero.
  const bearingRef = useRef(new BearingTracker());
  // Authoritative "is the SDK ready to touch?" flag â flips to true ONLY after
  // window.google.maps has been imported, authenticated, and exposed on the
  // window. We refuse to mount <Map /> at all until then, which is the
  // architectural fix the user asked for.
  const isLoaded = useApiIsLoaded();
  if (!isLoaded) return <MapSkeleton />;

  return (
    <Map
      style={{ width: "100%", height: "100%", minHeight: 300 }}
      defaultCenter={center}
      defaultZoom={followUser ? 17 : 15}
      // Bug #1 â clamp zoom range. Google's vector basemap stops serving tiles
      // below zoom 3 â black canvas. Clamp to 8 (regional view) to be safe.
      minZoom={8}
      maxZoom={20}
      mapTypeId={mapType}
      // mapId enables the VECTOR renderer â required for setTilt / setHeading
      // (the chase cam's 45Â° lean + heading-up rotation). Without this, the
      // Maps SDK quietly serves a raster basemap where those calls are no-ops
      // and the chase cam appears "stuck" at a flat overhead view.
      //
      // Falls back to a local Map ID literal if EXPO_PUBLIC_GOOGLE_MAP_ID
      // isn't set in the env. In Google Cloud Console â Maps Platform â Map
      // IDs, create a Map ID of type JavaScript with Vector rendering and
      // paste its value into the .env. The literal "convoy_map" works for
      // dev-mode rendering even before the Map ID is registered.
      mapId={(process.env as any).EXPO_PUBLIC_GOOGLE_MAP_ID || "convoy_map"}
      gestureHandling="greedy"
      disableDefaultUI={true}
      zoomControl={true}
      // Empty-map click â bubble up to parent (close search etc).
      // @vis.gl/react-google-maps fires onClick only for the basemap, not POIs.
      onClick={onMapPress ? (() => onMapPress()) : undefined}
      // Manual drag = user wants to inspect the map. Mirror the native
      // ConvoyMap behavior: flip the parent's isFollowing flag to false.
      // We listen for onCameraChanged with the "gesture" change reason
      // because @vis.gl/react-google-maps doesn't expose a raw onDragstart.
      onCameraChanged={(e: any) => {
        // The library's event shape exposes `e.detail.center` etc â pan
        // events are best detected by checking the difference from the
        // tracked user position. Simpler heuristic: if the map is moved
        // while followUser is true, the most likely cause is a user gesture
        // (because our snap-recenter effect doesn't fire onCameraChanged).
        // Use a small distance threshold to avoid false-positives from
        // sub-pixel reflows.
        if (!followUser || !e?.detail?.center) return;
        const dLat = Math.abs(e.detail.center.lat - user.lat);
        const dLng = Math.abs(e.detail.center.lng - user.lng);
        if (dLat > 0.0008 || dLng > 0.0008) onUserPan?.();
      }}
    >
          {/* "You" marker â always renders the GR Corolla PNG (default Heavy
              Metal when no color is picked) at fixed 48Ã48 px. Suppressed when
              Avatar Live privacy toggle is off. */}
          {!hideSelfMarker && (
            <Marker
              position={user}
              icon={grcCarIconDataUrl(user.carColor, bearingRef.current.get("self", user.lat, user.lng, user.heading), 48)}
              zIndex={1000}
            />
          )}
          {peers.map((p) => {
            const isLeader = !!leaderUserId && p.user_id === leaderUserId;
            // Leader marker is slightly larger AND given a high zIndex so it
            // floats above teammates whenever the convoy stacks up at a stop.
            const sz = isLeader ? 56 : 48;
            // Peer marker â always GRC PNG, slug-first then label fallback,
            // then default Heavy Metal. NO generic silhouettes.
            const url = grcCarIconDataUrl(p.activeColor || p.carColor, bearingRef.current.get(p.user_id, p.lat, p.lng, p.heading), sz);
            return (
              <Marker
                key={p.user_id}
                position={p}
                icon={{
                  url,
                  scaledSize: { width: sz, height: sz } as any,
                  size: { width: sz, height: sz } as any,
                  anchor: { x: sz / 2, y: sz / 2 } as any,
                } as any}
                title={`${isLeader ? "â " : ""}${p.handle || "driver"}${p.carType ? " Â· " + p.carType : ""}`}
                zIndex={isLeader ? 1000 : 1}
                onClick={() => onPeerPress?.(p)}
              />
            );
          })}
          {showHazards && hazards.map((h) => (
            <Marker
              key={`u-${h.id}`}
              position={h}
              icon={communityPin(hazardColor(h.kind), HAZARD_GLYPHS[h.kind] || "!", highlightConvoy)}
              onClick={() => onHazardPress(h)}
              /* Web has no long-press; use double-click as the destructive
                 affordance. @vis.gl/react-google-maps exposes onRightClick too
                 but iOS Safari doesn't fire it reliably â dblclick works on
                 every browser + touch device the app supports. */
              onClick={() => onHazardLongPress?.(h)}
              onRightClick={() => onHazardLongPress?.(h)}
              title={`${h.kind} Â· by ${h.reporter_handle || "anon"}${highlightConvoy ? " Â· CONVOY" : ""} Â· double-click to remove`}
            />
          ))}
          {externalAlerts.map((a) => (
            <Marker
              key={`x-${a.id}`}
              position={{ lat: a.lat, lng: a.lng }}
              icon={diamondIcon(extColor(a.type), EXT_GLYPHS[a.type] || "â¢")}
              onClick={() => onExternalAlertPress?.(a)}
              title={`${a.type}${a.subtype ? " Â· " + a.subtype : ""} (live feed)`}
              zIndex={500}
            />
          ))}
          {destination && (
            <Marker position={destination} icon={dotIcon("#FF453A", "â", 34)} title="Destination" />
          )}
          {/* Multi-route layer: gray alternates + blue selected, all from pre-decoded polylines */}
          {destination && routes.length > 0 && (
            <RoutesLayer routes={routes} selectedIndex={selectedRouteIndex} onSelect={onSelectRoute} />
          )}
          {/* Legacy fallback when no routes[] given */}
          {destination && routes.length === 0 && (
            <Directions origin={user} destination={destination} onRoute={onRoute} encodedPolyline={encodedPolyline} />
          )}
          <Recenter target={followUser ? user : center} navigationActive={navigationActive} />
          {/* Live traffic overlay (green/yellow/red flow lines) â togglable via Layers FAB */}
          {showTraffic && <TrafficLayer />}
          {/* Public transit overlay â togglable via Layers FAB */}
          {showTransit && <TransitLayer />}
          {/* Chase-cam: 3D pitch + heading rotation + dynamic zoom while turn-by-turn nav is active.
              When `mapView` is "north_up" the chase cam stays anchored to the
              user but tilt and bearing are forced to 0 for a classic top-down feel. */}
          {navigationActive && (
            <ChaseCam user={user} userSpeedMs={userSpeedMs} mapView={mapView} />
          )}
        </Map>
  );
}

// Renders pre-decoded route polylines as native google.maps.Polyline objects.
// Alternates are rendered first (gray, lower zIndex) so the selected route (blue) sits on top.
function RoutesLayer({ routes, selectedIndex, onSelect }: {
  routes: { polyline: string; color?: string }[];
  selectedIndex: number;
  onSelect?: (index: number) => void;
}) {
  const map = useMap();
  const polysRef = useRef<any[]>([]);

  useEffect(() => {
    if (!map || !(window as any).google?.maps) return;
    const G = (window as any).google.maps;

    // Tear down previous polylines
    polysRef.current.forEach((pl) => pl.setMap(null));
    polysRef.current = [];

    routes.forEach((r, i) => {
      const path = G.geometry.encoding.decodePath(r.polyline);
      const isSelected = i === selectedIndex;
      // Each route carries its rank color from map.tsx (green/orange/red). On
      // web we can use the proper strokeOpacity prop to dim alternates instead
      // of baking alpha into the hex string.
      const color = r.color ?? (i === 0 ? '#34C759' : i === 1 ? '#FF9500' : '#FF3B30');
      const pl = new G.Polyline({
        path,
        map,
        strokeColor: color,
        strokeOpacity: isSelected ? 1.0 : 0.45,
        strokeWeight: isSelected ? 6 : 4,
        zIndex: isSelected ? 2 : 1,
        clickable: !isSelected,        // selected route shouldn't swallow taps
      });
      pl.addListener("click", () => onSelect?.(i));
      polysRef.current.push(pl);
    });

    return () => { polysRef.current.forEach((pl) => pl.setMap(null)); polysRef.current = []; };
  }, [map, routes, selectedIndex, onSelect]);

  return null;
}

function Directions({ origin, destination, onRoute, encodedPolyline }: { origin: LatLng; destination: LatLng; onRoute?: Props["onRoute"]; encodedPolyline?: string | null }) {
  const map = useMap();
  const routesLib = useMapsLibrary("routes");
  const renderer = useRef<any>(null);
  const service = useRef<any>(null);

  useEffect(() => {
    if (!map || !routesLib) return;
    if (!service.current) service.current = new routesLib.DirectionsService();
    if (!renderer.current) {
      renderer.current = new routesLib.DirectionsRenderer({
        map,
        suppressMarkers: true,
        polylineOptions: { strokeColor: "#0A84FF", strokeOpacity: 0.95, strokeWeight: 6 },
      });
    } else {
      renderer.current.setMap(map);
    }
    service.current.route(
      {
        origin,
        destination,
        travelMode: "DRIVING",
        provideRouteAlternatives: false,
      },
      (res: any, status: string) => {
        if (status !== "OK" || !res) {
          if (onRoute) onRoute(null);
          return;
        }
        renderer.current.setDirections(res);
        const leg = res.routes[0]?.legs[0];
        if (leg && onRoute) {
          onRoute({
            distance_text: leg.distance?.text || "",
            duration_text: leg.duration?.text || "",
            steps: (leg.steps || []).map((s: any) => ({
              html: (s.instructions || "").replace(/<[^>]+>/g, ""),
              distance_text: s.distance?.text || "",
              maneuver: s.maneuver,
            })),
          });
        }
      }
    );
    return () => { if (renderer.current) renderer.current.setMap(null); };
  }, [map, routesLib, origin.lat, origin.lng, destination.lat, destination.lng]);

  return null;
}

function Recenter({ target, navigationActive }: { target: LatLng; navigationActive: boolean }) {
  const map = useMap();
  // Records the wall-clock of the most recent USER gesture (drag, pinch,
  // zoom-by-touch). After such a gesture we PAUSE auto-recenter for 5s so the
  // map doesn't snap back the instant the user finishes pinching to zoom in
  // on something specific. Otherwise Recenter wages a constant fight with the
  // user's fingers.
  const lastGestureRef = useRef<number>(0);
  const GESTURE_PAUSE_MS = 5000;

  // Bind drag/zoom listeners once the map is ready. The `zoom_changed` event
  // also fires programmatically when ChaseCam calls setZoom â so during a
  // navigation trip we don't count it as a user gesture (ChaseCam owns the
  // camera in that mode anyway, see the `navigationActive` short-circuit
  // in the second effect).
  useEffect(() => {
    if (!isMapReady(map)) return;
    const onGestureStart = () => { lastGestureRef.current = Date.now(); };
    const d1 = (map as any).addListener?.("dragstart", onGestureStart);
    const d2 = (map as any).addListener?.("zoom_changed", () => {
      if (!navigationActive) lastGestureRef.current = Date.now();
    });
    return () => {
      try {
        (window as any).google?.maps?.event?.removeListener?.(d1);
        (window as any).google?.maps?.event?.removeListener?.(d2);
      } catch {}
    };
  }, [map, navigationActive]);

  useEffect(() => {
    if (!isMapReady(map) || !target) return;
    // While ChaseCam is in charge (navigation active) Recenter is OFF entirely
    // â otherwise the two would fight over panTo each tick.
    if (navigationActive) return;
    // Honor the 5s user-gesture pause so a pinch-to-zoom isn't yanked back.
    if (Date.now() - lastGestureRef.current < GESTURE_PAUSE_MS) return;
    try { (map as any).panTo({ lat: target.lat, lng: target.lng }); } catch {}
  }, [map, target?.lat, target?.lng, navigationActive]);

  return null;
}

// Centralized "is this map safe to mutate?" check. Returns true only when:
//   1. The map instance exists,
//   2. `window.google.maps` has finished loading (the SDK is on the window),
//   3. The map instance exposes the expected mutation entrypoints.
// Used by Recenter, ChaseCam, RoutesLayer to short-circuit on the first tick
// where useMap() returns truthy but the underlying canvas isn't ready yet.
function isMapReady(map: any): boolean {
  if (!map) return false;
  if (typeof window === "undefined") return false;
  if (!(window as any).google?.maps) return false;
  if (typeof map.panTo !== "function") return false;
  if (typeof map.setZoom !== "function") return false;
  return true;
}

/**
 * Always-on Google Live Traffic overlay for the web map.
 *
 * @vis.gl/react-google-maps doesn't ship a <TrafficLayer/> wrapper, so we
 * imperatively instantiate `new google.maps.TrafficLayer()` once and bind it
 * to the map. Cleanup detaches it. This shows real-time green/yellow/red
 * speed-of-flow lines on roads with available traffic data.
 */
function TrafficLayer() {
  const map = useMap();
  useEffect(() => {
    if (!map || !(window as any).google?.maps?.TrafficLayer) return;
    const layer = new (window as any).google.maps.TrafficLayer();
    layer.setMap(map);
    return () => {
      try { layer.setMap(null); } catch {}
    };
  }, [map]);
  return null;
}

// Same imperative pattern as TrafficLayer â Google's TransitLayer overlays
// subway / bus / rail lines on the basemap. Used by the Layers FAB toggle.
function TransitLayer() {
  const map = useMap();
  useEffect(() => {
    if (!map || !(window as any).google?.maps?.TransitLayer) return;
    const layer = new (window as any).google.maps.TransitLayer();
    layer.setMap(map);
    return () => { try { layer.setMap(null); } catch {} };
  }, [map]);
  return null;
}

/**
 * Chase-cam controller for the web Google Maps instance.
 *
 * Drives 4 things every time the user's lat/lng/heading or speed changes:
 *   â¢ zoom    â speed-based interpolation (city = 18, highway = 16)
 *   â¢ center  â pan to user position (smoother than re-anchoring on every render)
 *   â¢ heading â rotate map so the user's direction is "up" (Vector mode only)
 *   â¢ tilt    â 45Â° lean (Vector mode only â silently no-ops on Raster maps)
 *
 * Heading + tilt require a vector map (created with a `mapId`). On a raster
 * Google Map the setHeading/setTilt calls are no-ops, but zoom + pan still
 * work, so the chase-cam still feels closer-in than the bird's-eye baseline.
 */
function ChaseCam({ user, userSpeedMs, mapView = "heading_up" }: { user: LatLng & { heading?: number }; userSpeedMs?: number; mapView?: "heading_up" | "north_up" }) {
  const map = useMap();
  const readyRef = useRef(false);
  // Tracks the last camera commit so we can throttle ticks where the user
  // barely moved (< 3m + < 3Â° heading delta). Cuts panTo/setHeading calls
  // by ~80% in dense GPS streams without visibly hurting smoothness.
  const lastCamRef = useRef<{ lat: number; lng: number; heading: number } | null>(null);
  // Latest user/speed values, captured in a ref so the imperative idle
  // callback can read the freshest values without re-binding.
  const userRef = useRef(user);
  const speedRef = useRef(userSpeedMs);
  const mapViewRef = useRef(mapView);
  userRef.current = user;
  speedRef.current = userSpeedMs;
  mapViewRef.current = mapView;

  // Commit camera position. Uses `moveCamera` when available (atomic, no
  // partial-update flicker mid-tween); otherwise falls back to the three
  // imperative setters which the Maps JS SDK accepts on vector AND raster.
  const fireCam = () => {
    if (!isMapReady(map) || !readyRef.current) return;
    const u = userRef.current;
    const heading = (typeof u.heading === "number" && Number.isFinite(u.heading)) ? u.heading : 0;
    const zoom = chaseZoomForSpeed(kmhFromMs(speedRef.current));
    const isHeadingUp = mapViewRef.current === "heading_up";
    // Distance + heading-delta throttle.
    const last = lastCamRef.current;
    if (last) {
      const R = 6371000;
      const dLat = ((u.lat - last.lat) * Math.PI) / 180;
      const dLng = ((u.lng - last.lng) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((last.lat * Math.PI) / 180) *
          Math.cos((u.lat * Math.PI) / 180) *
          Math.sin(dLng / 2) ** 2;
      const distM = 2 * R * Math.asin(Math.sqrt(a));
      const headingDelta = Math.abs(heading - last.heading);
      if (distM < 3 && headingDelta < 3) return;
    }
    lastCamRef.current = { lat: u.lat, lng: u.lng, heading };
    try {
      if (typeof (map as any).moveCamera === "function") {
        (map as any).moveCamera({
          center: { lat: u.lat, lng: u.lng },
          zoom,
          heading: isHeadingUp ? heading : 0,
          tilt: isHeadingUp ? CHASE_PITCH_DEG : 0,
        });
      } else {
        (map as any).panTo({ lat: u.lat, lng: u.lng });
        (map as any).setZoom(zoom);
        if (typeof (map as any).setHeading === "function") (map as any).setHeading(isHeadingUp ? heading : 0);
        if (typeof (map as any).setTilt === "function") (map as any).setTilt(isHeadingUp ? CHASE_PITCH_DEG : 0);
      }
    } catch {
      // Defensive: never crash the map over a chase-cam tick.
    }
  };

  // Wait for the first `idle` event before allowing camera mutations â the
  // Maps SDK throws minified `a.pK` errors when mutated mid-bootstrap. Once
  // idle fires we ALSO call `fireCam()` immediately so the initial chase-cam
  // commit isn't delayed until the next position change.
  useEffect(() => {
    if (!isMapReady(map) || readyRef.current) return;
    const listener = (map as any).addListener?.("idle", () => {
      readyRef.current = true;
      fireCam();
    });
    return () => { try { (window as any).google?.maps?.event?.removeListener?.(listener); } catch {} };
  }, [map]);

  // Drive the camera on every position / speed / heading / view-mode change.
  // CRITICAL: `readyRef.current` is intentionally NOT in the deps array.
  // Refs don't trigger re-renders so listing it here was a no-op AND made
  // the lint feel correct â but the result was the effect never re-ran the
  // first time readyRef flipped to true, which is why the chase cam often
  // appeared dead. The idle listener above calls fireCam() directly to seed
  // the first frame; this effect handles every subsequent GPS tick.
  useEffect(() => {
    fireCam();
  }, [map, user.lat, user.lng, user.heading, userSpeedMs, mapView]);

  // On unmount (navigation ended) reset tilt+heading so the preview view
  // returns to a flat, north-up orientation. zoom 15 is the free-roam default.
  useEffect(() => {
    return () => {
      if (!isMapReady(map)) return;
      try {
        if (typeof (map as any).moveCamera === "function") {
          (map as any).moveCamera({ tilt: 0, heading: 0, zoom: 15 });
        } else {
          if (typeof (map as any).setTilt === "function") (map as any).setTilt(0);
          if (typeof (map as any).setHeading === "function") (map as any).setHeading(0);
        }
      } catch {}
    };
  }, [map]);

  return null;
}

const styles = StyleSheet.create({
  fb: { flex: 1, backgroundColor: "#0A1410", alignItems: "center", justifyContent: "center" },
  // Skeleton â shown until useApiIsLoaded() flips true. Same dark backdrop as
  // the satellite/hybrid map so the swap is visually seamless when the SDK
  // finishes authenticating.
  skeleton: { backgroundColor: "#0A1410", alignItems: "center", justifyContent: "center" },
  skeletonText: { color: COLORS.textDim, marginTop: 14, fontSize: 13, letterSpacing: 0.5 },
});
