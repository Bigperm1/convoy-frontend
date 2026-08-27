// User-toggleable preferences persisted with AsyncStorage.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

const KEY = "convoy.settings.v3";
// Separate key for the last-known GPS location (see getLastLocation). Kept out of
// the Settings object so writing it never broadcasts to settings listeners.
const LAST_LOC_KEY = "convoy.lastlocation.v1";

// Single source of truth for the base-map look (Mapbox light presets + satellite).
// Legacy mapType/mapDark are kept only for migration + the dormant Google engine,
// derived from mapMode via the helpers below.
// "auto" follows the time of day — getMapMode() resolves it to dawn/day/dusk/night.
export type MapMode = "satellite" | "dawn" | "day" | "dusk" | "night" | "auto";

// Avatar privacy mode. TWO modes as of 2026-08-05 (Jeff): "full" and "partial" were
// FUNCTIONALLY IDENTICAL — avatarMode was only ever tested for === "ghost", so nothing
// anywhere distinguished them — while the UI promised they differed ("Full: always
// visible" vs "Partial: only while connected"). Say Phin picked Full on the strength of
// that copy and then asked why his avatar had gone translucent. A three-way control
// where two options do the same thing is worse than a two-way one.
//   visible = your CAR is on the crew map. Live while you are in it (head unit
//             connected, or provably driving); pinned at the car's own spot when you
//             have left it. Never your real location away from the car.
//   ghost   = never visible to the crew, driving or parked.
// NOT in DEFAULT_SETTINGS on purpose, so an existing user who had Avatar Live OFF is
// never silently flipped to visible by the settings-spread.
export type AvatarMode = "visible" | "ghost";
// Accepted on READ only, for installs that stored the retired names. Never written.
type LegacyAvatarMode = AvatarMode | "full" | "partial";

export type Settings = {
highlightConvoy: boolean;
alertSound: boolean;
avoidTolls: boolean;
avoidHighways: boolean;
avoidFerries: boolean;
activeCommunityId?: string | null;
activeThreadId?: string | null;
commsLive: boolean;
avatarLive: boolean;
// Avatar Live privacy mode (source of truth). avatarLive is kept in sync as a
// legacy-compat mirror: full/partial → true, ghost → false. See AvatarMode.
avatarMode?: AvatarMode;
mapView: "heading_up" | "north_up";
mapType: "hybrid" | "roadmap";
mapDark: boolean;
// Base-map mode — the single source of truth. Optional/undefined for users
// stored before it existed; getMapMode() migrates them from mapType/mapDark.
mapMode?: MapMode;
// Route-line color — a user-chosen base hex (e.g. "#2DEC86" green, "#0A84FF" Waze
// blue). The route core, glow + near-car fade are all derived from this one color.
// Optional; getRouteColor() defaults to brand green.
routeColor?: string;
// 3D buildings on the Standard (non-satellite) Mapbox modes. User toggle; when
// false the self-car can never be hidden behind a building. Maps to the Mapbox
// Standard style's show3dObjects config.
show3dBuildings: boolean;
novaGreeting: boolean;
novaSpeeding: boolean;
// Speed-alert mode (settings selector): 'off' | 'nova' (Nova speaks the nudge)
// | 'ding' (chime: single ~21 over, double ~41 over). Optional/undefined for
// installs stored before it existed — getSpeedAlertMode() migrates them from the
// legacy novaSpeeding boolean (true → 'nova', false → 'off'). Deliberately NOT in
// DEFAULT_SETTINGS so the default-spread can't silently override a pre-existing
// novaSpeeding choice on upgrade.
speedAlertMode?: 'off' | 'nova' | 'ding';
novaMidDrive: boolean;
// PITSTOP — when the car sits still at a gas station / food place, a live timer
// appears on the map and CarPlay counting the stop, and the drive banks a running
// total. Purely informational: it deliberately does NOT feed the ETA, because
// `now + eta` already absorbs a stop on its own (see src/pitstop.ts).
pitstop: boolean;
// Master mute for all Nova nav/alert speech — toggled by the speaker button on
// the turn-by-turn banner. Persisted so a muted drive stays muted next time.
novaMuted: boolean;
// Master on/off for ALL Nova voice (settings-screen switch, above the granular
// toggles). When false nothing speaks — greeting, callouts, quips, alerts.
novaVoice: boolean;
// Which OpenAI TTS voice Nova speaks in (passed as `voice` to the backend /tts).
// One of the OpenAI voice ids (alloy / echo / fable / nova / onyx / shimmer …).
// undefined/absent → "nova" (the original default). See src/novaVoices.ts.
novaVoiceName?: string;
// Hands-free voice replies — when on, Scout SPEAKS prompts (e.g. "faster route, want
// to switch?") and listens for a spoken yes/no so you never tap while driving. The
// on-screen card is always the fallback. undefined → on. See src/askScout.ts.
scoutHandsFree?: boolean;
// Convoy alerts — Scout speaks up when the crew is spreading out (a live peer falls
// well behind). Only with 2+ live peers; edge-triggered + hushed. undefined → on.
convoyAlerts?: boolean;
// Adaptive speed alerts — learn the driver's habitual over-the-limit margin and raise
// the FIRST nudge toward it (bounded; the firmer second alert stays fixed) so it stops
// nagging at speeds they always drive. undefined → on. See src/speedProfile.ts.
adaptiveSpeedAlerts?: boolean;
// Departure IQ — when parked at a predictable time, proactively offer a one-tap
// drive to the predicted destination (e.g. "Heading to Work?"). undefined → on.
departureIQ?: boolean;
// Whether Nova SPEAKS the Departure IQ offer (the pill always shows). undefined → on.
departureIQVoice?: boolean;
// One-time migration flag: when absent from stored settings, flip the three
// chatty Nova toggles (speeding / mid-drive / reroute) OFF once so the new
// quieter defaults reach existing installs too, then never repeat.
novaQuietMigrated: boolean;
// One-time flag: when absent, push the Jun-2026 baseline (Auto map mode + Speed
// Cameras off) onto existing installs once, then never repeat.
baselineMigrated: boolean;
speedUnit: 'kmh' | 'mph';
showWeatherLayer: boolean;
weatherOnMigrated: boolean;
widebodyRetiredMigrated?: boolean;
speedCameras: boolean;
// Official BC road events (DriveBC Open511): accidents, construction, closures,
// weather. Map pins + a Scout callout for major/moderate. BC-only; auto-gated by
// location. undefined → on.
roadIncidents: boolean;
// Split visibility for the DriveBC pins: red = major/moderate, grey = minor/info
// ("sometimes the grey is just too much on the screen"). Red undefined → ON;
// grey undefined → OFF (opt-in — Jeff wants a clean map on first launch).
// The master roadIncidents toggle above still gates everything.
roadIncidentsRed?: boolean;
roadIncidentsGrey?: boolean;
showPlacePins: boolean;
showNearby: boolean;
// Power profile (Settings → Driving → Battery Saver). "auto" (default) = premium
// when plugged in, eco when unplugged / iOS Low Power Mode. "eco" = eco ALWAYS —
// the phone-runs-hot escape hatch (plugged-in = premium by design, which is
// exactly when testers reported the most heat). Optional: undefined → "auto".
powerProfile?: "auto" | "eco";
// Gas Jockey — declutter the map's Gas pins by favorite brand + octane.
gasBrands?: Record<string, boolean>;          // brandKey -> shown; undefined = all shown
gasOther: boolean;                            // show unbranded / unrecognized stations
gasOctane?: '94' | '91' | '89' | '87' | null; // selected octane; null = show all
carYear?: string;
carMake?: string;
carModel?: string;
carColor?: string;
// ── Car Scan (Ultra) ──────────────────────────────────────────────────────
// The driver's OWN car, rebuilt from four photos. Since the authored widebody
// was retired there is no stock 3D model, so carScanModelUrl is the ONLY source
// for the Garage hero and the 3D map marker — undefined means "no car yet",
// which is a normal first-run state, not an error.
carScanModelUrl?: string;                        // https URL of the finished GLB (Garage hero)
carScanMapUrl?: string;                          // decimated map twin (wired to the map later)
carScanStatus?: 'none' | 'submitted' | 'ready' | 'failed';
carScanId?: string;                              // the scan folder in the car-scans bucket
carScanSubmittedAt?: string;                     // ISO, when Generate was tapped
carScanConsentAt?: string;                       // ISO, when the disclaimer was accepted
// Renders used, capped at MAX_SCAN_ATTEMPTS (2). The 2nd REPLACES the 1st.
// ⚠️ Local-only today: a reinstall resets it. Real entitlement needs a server counter.
carScanAttemptsUsed?: number;
// How the driver is DRAWN on the convoy map — separate from avatarMode, which is
// privacy/visibility (whether you appear at all). 'car' = the 3D GRC model (default),
// 'arrow' = a 3D green arrow, 'photo' = a circular uploaded profile photo. undefined
// → 'car' via getSelfMarkerType(). Mirrored to the backend profile (avatar_type) +
// presence so peers render you the same way you chose in the Garage.
selfMarkerType?: 'car' | 'arrow' | 'photo' | 'class';
// The app-wide metal (src/appSkin.ts). 'auto' — the default — follows whatever tier the
// account holds, so gold/silver ARRIVES with the purchase without the customer touching
// a setting. An explicit choice is CLAMPED to entitlement at read time, so this can never
// hold a metal they no longer pay for. Deliberately NOT in DEFAULT_SETTINGS: undefined
// already means 'auto', so no migration flag is needed for existing installs.
appSkin?: 'auto' | 'brand' | 'premium' | 'ultra';
// "Class" map appearance (Garage): a top-down sprite of the vehicle class,
// painted with user-picked PRIMARY (accent band) + SECONDARY (second band)
// colors. Stored PER CLASS so switching class remembers each one's paint.
// vehicleClass undefined → 'hatchback'.
// 2026-07-18 rename: coupe → muscle, sports → supercar (legacy strings still
// arrive from old saves/peers — LEGACY_CLASS maps them on read).
vehicleClass?: 'hatchback' | 'muscle' | 'supercar' | 'exotic' | 'sedan' | 'truck' | 'electric' | 'atv' | 'motorcycle' | 'sxs' | 'boat' | 'jeep' | 'coupe' | 'sports';
// LEGACY single-color per class (pre primary/secondary). Read as the primary
// fallback; new saves write classPaint below.
classColors?: Record<string, string>;
classPaint?: Record<string, { primary?: string; secondary?: string }>;
// Arrow appearance paint: primary = the green body materials of the arrow GLB,
// secondary = the white rim. Unset → the stock Hairpin arrow.
arrowPaint?: { primary?: string; secondary?: string };
// Auto-switch the self marker to the BOAT sprite while the GPS position sits on
// a water polygon (lake/ocean), reverting on land. Hysteresis + road-snap
// suppression (bridges stay a car) live in ConvoyMapbox. undefined → ON.
autoBoatOnWater?: boolean;
// Hosted profile-photo URL (Supabase Storage) used when selfMarkerType==='photo'.
// Also shown in rosters and "drive with a friend" search. Mirrored to the backend
// profile (avatar_url) + presence (small URL only — never the image bytes).
avatarUrl?: string;
topSpeed?: number;
callSign?: string;
// ── Audio calibration (TEMP: tester tuning to find good default levels) ───────
// Per-source output volume multipliers, 0..1 (1 = full). Applied where each sound
// actually plays. Music (Apple Music / Spotify) has NO field — iOS gives no volume
// API for external players, so it's shown as a fixed 100% reference only and the
// others are tuned relative to it. Stock via getAudioVol: Scout/Voice starts at MAX
// (1.0, the app's ceiling — no gain past it), the rest at 60% so testers can
// calibrate up OR down; see STOCK_AUDIO_VOL / STOCK_BY_KEY below + settings/audio.tsx.
volVoice?: number;        // Scout / nav / agentic TTS
volDings?: number;        // alerts & dings (speed ding, alert sound)
volComms?: number;        // live push-to-talk voice
volTransmission?: number; // incoming transmission tone / cue
// Which music source the user picked in the Music tab ('apple' | 'spotify').
// null = not chosen yet → show the source-picker connect screen.
musicSource?: 'apple' | 'spotify' | null;
// Developer: show on-screen diagnostic overlays (map HDG/SL + CarPlay DBG strip).
// Off by default so the screen is clean; toggled in Settings.
debugOverlays: boolean;
// Developer: show CarPlay-specific diagnostic readouts (the feed= breadcrumb on
// the head unit). Separate from debugOverlays so the car screen can stay clean
// while phone diagnostics are on. Off by default.
carplayDebug: boolean;
// Keep the phone screen awake while the map is open, so it can't auto-lock and
// freeze the CarPlay marker mid-drive (Waze-style "keep screen on"). Gates the
// map.tsx keep-awake. undefined/legacy → on (matches the prior always-on behavior).
preventAutoLock: boolean;
// Mute Hairpin's OWN audio — Scout voice, comms & alert dings — while a phone
// call is active (external music is paused by iOS automatically). Gates
// callSilence() at each audio play site. undefined/legacy → on.
muteDuringCalls: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
highlightConvoy: true,
alertSound: true,
avoidTolls: false,
avoidHighways: false,
avoidFerries: false,
activeCommunityId: null,
activeThreadId: null,
commsLive: true,
avatarLive: true,
mapView: "heading_up",
mapType: "hybrid",
mapDark: false,
// Default base-map look is AUTO — follows the time of day (dawn/day/dusk/night).
mapMode: "auto",
// Default route color — brand neon green.
routeColor: "#2DEC86",
show3dBuildings: true,
novaGreeting: false,
novaSpeeding: false,
novaMidDrive: true,   // mid-drive callouts ON at first launch (Jeff, 2026-07-25)
pitstop: true,        // Pitstop timer ON at first launch (Jeff, 2026-07-26)
novaMuted: false,
novaVoice: true,
novaVoiceName: "nova",
scoutHandsFree: true,
convoyAlerts: true,
adaptiveSpeedAlerts: true,
departureIQ: true,
novaQuietMigrated: true,
baselineMigrated: true,
speedUnit: 'kmh',
showWeatherLayer: true,
weatherOnMigrated: true,
widebodyRetiredMigrated: undefined,
speedCameras: false,
roadIncidents: false,  // OFF at first launch (Jeff, 2026-07-25)
showPlacePins: true,
showNearby: true,
// Default Gas Jockey: only the four major BC chains shown; the rest (and
// unbranded "Other") hidden until the driver re-enables them. Octane defaults
// to premium (94 / "High Octane Premium").
gasBrands: { shell: true, chevron: true, petrocan: true, esso: true, husky: false, mobil: false, coop: false, costco: false, canadiantire: false, ultramar: false, pioneer: false, circlek: false },
gasOther: false,
gasOctane: '94',
carYear: undefined,
carMake: undefined,
carModel: undefined,
carColor: undefined,
carScanModelUrl: undefined,
carScanMapUrl: undefined,
carScanStatus: undefined,
carScanId: undefined,
carScanSubmittedAt: undefined,
carScanConsentAt: undefined,
carScanAttemptsUsed: undefined,
selfMarkerType: undefined,
avatarUrl: undefined,
topSpeed: undefined,
callSign: undefined,
volVoice: undefined,
volDings: undefined,
volComms: undefined,
volTransmission: undefined,
musicSource: null,
debugOverlays: false,
carplayDebug: false,
preventAutoLock: true,
muteDuringCalls: true,
};

// ---- Map mode helpers (single source of truth = settings.mapMode) ----
// Migrate users stored before mapMode existed: hybrid → satellite, roadmap+dark
// → night, roadmap+light → day.
export function legacyToMapMode(mapType?: string, mapDark?: boolean): MapMode {
  if (mapType === "hybrid") return "satellite";
  return mapDark ? "night" : "day";
}
// "auto" → a Mapbox light preset by LOCAL time of day. Rough sun-phase bands (no
// location/date math): night → dawn → day → dusk → night. Picked on each call so the
// look advances with the clock (the map re-resolves this on its frequent re-renders).
export function autoMapMode(): Exclude<MapMode, "auto"> {
  const d = new Date();
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 5.5 && h < 7.5) return "dawn";
  if (h >= 7.5 && h < 17.5) return "day";
  if (h >= 17.5 && h < 20) return "dusk";
  return "night";
}
// The user's CHOSEN mode (raw — may be "auto"). For the settings UI's selected state.
export function getMapModeChoice(s: Settings): MapMode {
  return s.mapMode ?? legacyToMapMode(s.mapType, s.mapDark);
}
// The user's chosen route-line color (base hex). Defaults to brand neon green.
export function getRouteColor(s: Settings): string {
  return s.routeColor ?? "#2DEC86";
}

// The OpenAI TTS voice Nova speaks in. Falls back to "nova" (original default).
// Reads live settings when no arg is passed, so non-React callers (nav.ts /tts,
// novaGreeting.ts) always pick up the user's latest choice.
export function getNovaVoice(s: Settings = cached): string {
  const v = (s?.novaVoiceName && s.novaVoiceName.trim()) || "nova";
  // Heal a stored selection of a voice we removed for producing no audio on this
  // backend (ballad / verse) so Scout never goes silent — fall back to the default.
  return (v === "ballad" || v === "verse") ? "nova" : v;
}
// The effective RENDER mode: the chosen mode, with "auto" resolved to a concrete light
// preset by time of day. Used by the Mapbox engine (phone) + mirrored to CarPlay.
export function getMapMode(s: Settings): Exclude<MapMode, "auto"> {
  const choice = getMapModeChoice(s);
  return choice === "auto" ? autoMapMode() : choice;
}
// ---- Avatar mode helpers (source of truth = settings.avatarMode) ----
// MIGRATION, and the direction matters. Both retired names map to "visible" because
// both BEHAVED as visible — this changes nobody's actual exposure, it only stops the
// UI claiming a difference that never existed. A user who chose ghost stays ghost, and
// a user with no explicit mode still falls back to the legacy avatarLive boolean, so
// "Avatar Live OFF" is never silently flipped on. Read-only: nothing writes the old
// names, and setAvatarMode's type no longer permits them.
export function getAvatarMode(s: Settings): AvatarMode {
  const stored = s.avatarMode as LegacyAvatarMode | undefined;
  if (stored === "ghost") return "ghost";
  if (stored === "visible" || stored === "full" || stored === "partial") return "visible";
  return s.avatarLive ? "visible" : "ghost";
}
// Persist a new avatar mode and keep the legacy avatarLive boolean in sync
// (visible → true, ghost → false) so any older reader still behaves.
export async function setAvatarMode(mode: AvatarMode): Promise<Settings> {
  return updateSettings({ avatarMode: mode, avatarLive: mode !== "ghost" });
}

// ---- Self-marker appearance (source of truth = settings.selfMarkerType) ----
// How the driver is DRAWN on the map: 'car' (3D GRC model, default), 'arrow' (3D
// green arrow), or 'photo' (circular profile photo). Default-safe accessor — an
// install stored before this field existed reads as 'car'. Separate from
// getAvatarMode() (privacy/visibility). A 'photo' choice with no avatarUrl yet
// still falls back to the car at the render layer.
export function getSelfMarkerType(s: Settings): 'car' | 'arrow' | 'photo' | 'class' {
  return s.selfMarkerType ?? 'car';
}

// ---- "Class" appearance helpers ----
export type VehicleClass = NonNullable<Settings['vehicleClass']>;
// Legacy class names → current (old saves + old-version peers keep working).
export const LEGACY_CLASS: Record<string, VehicleClass> = { coupe: 'muscle', sports: 'supercar' };
export function canonicalClass(cls?: string | null): VehicleClass {
  return (LEGACY_CLASS[cls ?? ''] ?? cls ?? 'hatchback') as VehicleClass;
}
export function getVehicleClass(s: Settings): VehicleClass {
  return canonicalClass(s.vehicleClass);
}
// The chosen paint for the ACTIVE class (per-class map; brand green default).
export function getClassColor(s: Settings): string {
  return s.classColors?.[getVehicleClass(s)] ?? '#2DEC86';
}
// RAW per-class paint — undefined when the user never saved one. Photo classes
// use this to tell "tint it" apart from "show the photo as-shot".
export function getClassColorRaw(s: Settings): string | undefined {
  return s.classColors?.[getVehicleClass(s)];
}
// Primary/secondary paint for the ACTIVE class. Legacy single color (the old
// classColors map) reads as primary when no v2 entry exists.
export function getClassPaint(s: Settings): { primary?: string; secondary?: string } {
  const cls = getVehicleClass(s);
  // Saved paint may live under the legacy key (pre-rename saves) — check the
  // canonical key first, then any legacy alias of it.
  const legacyKey = Object.keys(LEGACY_CLASS).find((k) => LEGACY_CLASS[k] === cls);
  return s.classPaint?.[cls]
    ?? (legacyKey ? s.classPaint?.[legacyKey] : undefined)
    ?? (s.classColors?.[cls] ? { primary: s.classColors[cls] } : {});
}

// ---- Per-source audio volume (0..1), for the tester-calibration Audio screen ----
// STOCK (untuned) levels. Most sources start at 60% — not 100% — so testers can
// calibrate in EITHER direction against their music (the fixed 100% reference)
// rather than only being able to turn things down. Scout / Voice is the exception:
// it's the guidance line, so it stocks at the app's MAX (1.0). NOTE: expo-av volume
// is a 0..1 multiplier with NO gain past 1.0 — 1.0 is the loudest the CLIENT can
// make Scout. To go louder than that, the backend /tts must boost the synth gain
// (e.g. an ffmpeg loudnorm / volume filter on the returned mp3); the app has no
// lever above 1.0. Both the slider position (audio.tsx seeds from getAudioVol) and
// actual playback read these. The Music reference row is hardcoded 100% and unaffected.
export const STOCK_AUDIO_VOL = 0.6; // default stock for the tuned-relative sources
export type AudioVolKey = 'volVoice' | 'volDings' | 'volComms' | 'volTransmission';
// Scout/Voice stocks at MAX (1.0); dings/comms/transmission at STOCK_AUDIO_VOL.
// Calibrated stock levels (Jeff, 2026-07-25): voice 80 / alerts 60 / comms 80 /
// transmissions 80. These are the values an UNTUNED install plays at and what the
// Audio screen's sliders seed from, so they are the "first launch" defaults — a
// tester who has already moved a slider keeps their own number (getAudioVol only
// falls back to these when the key is undefined).
// Voice came down off the 1.0 ceiling so there is headroom to tune UP as well as
// down; comms/transmissions came up so crew speech isn't buried under music.
const STOCK_BY_KEY: Record<AudioVolKey, number> = {
  volVoice: 0.8,
  volDings: 0.6,
  volComms: 0.8,
  volTransmission: 0.8,
};
// Read at each playback site (Scout TTS, dings, comms, transmission) to scale
// volume; falls back to the per-key stock when a source hasn't been tuned. Clamped.
export function getAudioVol(s: Settings = cached, key: AudioVolKey): number {
  const v = s?.[key];
  return typeof v === 'number' ? Math.max(0, Math.min(1, v)) : (STOCK_BY_KEY[key] ?? STOCK_AUDIO_VOL);
}

let cached: Settings = { ...DEFAULT_SETTINGS };
let loaded = false;
// Last-known GPS location (cold-start map framing). Declared HERE — above the
// loadPromise IIFE that hydrates it — so it isn't used before declaration.
// Getter/setter + docs live further below.
let lastLocation: { lat: number; lng: number } | null = null;
const listeners = new Set<(s: Settings) => void>();

const loadPromise: Promise<Settings> = (async () => {
try {
const raw = await AsyncStorage.getItem(KEY);
if (raw) {
const parsed = JSON.parse(raw);
cached = { ...DEFAULT_SETTINGS, ...parsed };
// One-time migration: the weather HUD now defaults ON. Existing installs have
// showWeatherLayer:false persisted from the old default (not from the user
// deliberately turning it off), so flip it on ONCE here. The weatherOnMigrated
// flag is then stored, so anyone who later turns weather OFF stays off —
// "on by default, off only if explicitly turned off."
if (parsed.weatherOnMigrated === undefined) {
cached.showWeatherLayer = true;
cached.weatherOnMigrated = true;
try { await AsyncStorage.setItem(KEY, JSON.stringify(cached)); } catch {}
}
// One-time: adopt the quieter Nova defaults (speed alerts / mid-drive / reroute
// quip OFF) for installs stored before novaQuietMigrated existed.
if (parsed.novaQuietMigrated === undefined) {
cached.novaSpeeding = false;
cached.novaMidDrive = false;
cached.novaQuietMigrated = true;
try { await AsyncStorage.setItem(KEY, JSON.stringify(cached)); } catch {}
}
// One-time: adopt the new baseline on existing installs — Speed Cameras OFF, and Auto
// map mode IF they were still on the old default 'dusk' (a deliberate satellite/day/
// night/dawn pick is preserved). Avatar Live → Partial default is handled in
// getAvatarMode (privacy-safe — a ghost/OFF user stays invisible).
if (parsed.baselineMigrated === undefined) {
cached.speedCameras = false;
cached.novaGreeting = false;
if (parsed.mapMode === undefined || parsed.mapMode === "dusk") cached.mapMode = "auto";
cached.baselineMigrated = true;
try { await AsyncStorage.setItem(KEY, JSON.stringify(cached)); } catch {}
}
// One-time: the "Widebody" colour WAS Jeff's own scanned car and was retired
// 2026-08-23 ("remove the widebody and start fresh. including my car"). Anyone
// still holding it has a dead value — resolveGRCKey returns null for it, so the
// Garage prints a colour name that maps to no model. Clear it so they pick again;
// every other colour a user chose is left exactly as it was.
if (parsed.widebodyRetiredMigrated === undefined) {
if (cached.carColor === "Widebody") cached.carColor = undefined;
cached.widebodyRetiredMigrated = true;
try { await AsyncStorage.setItem(KEY, JSON.stringify(cached)); } catch {}
}
}
} catch {}
// Hydrate the last-known location too (separate key) as part of this early load,
// so the first map paint can frame the driver without waiting on a GPS fix.
try { const lraw = await AsyncStorage.getItem(LAST_LOC_KEY); if (lraw) lastLocation = JSON.parse(lraw); } catch {}
loaded = true;
listeners.forEach((l) => l(cached));
return cached;
})();

export async function ensureSettingsLoaded(): Promise<Settings> {
return loaded ? cached : loadPromise;
}

export function getSettings(): Settings { return cached; }

// Imperative subscription for MODULE-SCOPE consumers (no React) — e.g. the CarPlay /
// Android Auto settings mirror at the bottom of carplay/carStore.ts. useSettings() is
// the React half of this same `listeners` set; this is the non-React half. Returns an
// unsubscribe fn.
//
// ⚠ THE CALLBACK MUST NOT THROW. Both notify sites — the loadPromise hydration above
// and updateSettings below — do a bare `listeners.forEach((l) => l(cached))` with no
// per-listener guard, so one throwing subscriber aborts the loop and every listener
// registered after it silently stops updating. That is exactly the failure mode the
// updateSettings comment describes (a tap that registered but never repainted).
export function subscribeSettings(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ---- Last-known GPS location (cold-start map framing) ----
// Persisted SEPARATELY from Settings and WITHOUT notifying listeners, so the
// frequent position writes from the map never trigger a settings re-render. Read
// synchronously at the first map paint so the map opens framed on the driver's
// last spot instead of flying in from the world view. Hydrated in loadPromise.
// (The `lastLocation` variable is declared up by `cached`/`loaded` so the
// loadPromise hydration above doesn't reference it before declaration.)
export function getLastLocation(): { lat: number; lng: number } | null { return lastLocation; }
export function setLastLocation(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  lastLocation = { lat, lng };
  AsyncStorage.setItem(LAST_LOC_KEY, JSON.stringify(lastLocation)).catch(() => {});
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
cached = { ...cached, ...patch };
// NOTIFY FIRST, PERSIST AFTER (2026-07-24). This used to `await
// AsyncStorage.setItem(...)` BEFORE notifying, so every settings-driven piece of
// UI was gated on a disk write. AsyncStorage on Android is SQLite-backed and far
// slower than the iOS plist path — and if that write stalls, the listeners never
// fire and the screen never re-renders, so a tap that DID register looks completely
// dead. That is Jeff's Android report: "the comms threads they cant use or touch,
// it only stays on crew" — picking a thread calls setSettings({activeThreadId}),
// and the chip only moves when the listener runs.
// State is in-memory (`cached`) and is already updated above, so notifying
// immediately is correct; persistence is durability, not correctness, and has no
// business blocking a render. Fire-and-forget keeps the resolved value identical
// for every `await updateSettings(...)` caller.
listeners.forEach((l) => l(cached));
AsyncStorage.setItem(KEY, JSON.stringify(cached)).catch(() => {});
return cached;
}

// Alias kept for backward-compat — callers that used updateGlobalSettings still compile.
export const updateGlobalSettings = updateSettings;

// Backfill EMPTY local car fields from the backend profile. Local stays the
// source of truth for edits; this only fills blanks, so it restores the car
// after a fresh install / new build (which wipes AsyncStorage) without ever
// clobbering a selection the user just made. Keeps the car "attached to the
// account" instead of living only on the device.
export async function hydrateCarFromProfile(p: {
  car_make?: string | null;
  car_model?: string | null;
  car_color?: string | null;
  car_year?: number | null;
}): Promise<void> {
  await ensureSettingsLoaded();
  const patch: Partial<Settings> = {};
  if (!cached.carMake && p.car_make) patch.carMake = p.car_make;
  if (!cached.carModel && p.car_model) patch.carModel = p.car_model;
  if (!cached.carColor && p.car_color) patch.carColor = p.car_color;
  if (!cached.carYear && p.car_year != null) patch.carYear = String(p.car_year);
  if (Object.keys(patch).length) await updateSettings(patch);
}

export function useSettings(): [Settings, (p: Partial<Settings>) => Promise<Settings>] {
const [s, setS] = useState<Settings>(cached);
useEffect(() => {
let active = true;
if (!loaded) { loadPromise.then((v) => { if (active) setS(v); }); }
listeners.add(setS);
return () => { active = false; listeners.delete(setS); };
}, []);
return [s, updateSettings];
}

export function feedsQuery(_s: Settings): string { return ""; }

export function formatSpeed(speedMs: number, unit: 'kmh' | 'mph'): { value: number; label: string } {
if (unit === 'mph') return { value: Math.round(speedMs * 2.23694), label: 'MPH' };
return { value: Math.round(speedMs * 3.6), label: 'KM/H' };
}

export function kmhToDisplay(kmh: number, unit: 'kmh' | 'mph'): number {
if (unit === 'mph') return Math.round(kmh * 0.621371);
return Math.round(kmh);
}

// Road-speed unit by ISO-3166-1 alpha-2 country code. The world is metric (km/h)
// except a short list that posts mph — the US, the UK, and a handful of mostly
// Caribbean / British-legacy / US territories. Anything not in the set is km/h.
const MPH_COUNTRIES = new Set([
  "US", "GB", "LR",
  "AG", "BS", "BZ", "DM", "GD", "KN", "LC", "VC",
  "AI", "FK", "GG", "IM", "JE", "KY", "MS", "SH", "TC", "VG",
  "AS", "GU", "MP", "PR", "VI",
]);
export function unitForCountry(cc?: string | null): 'kmh' | 'mph' {
  if (!cc) return 'kmh';
  return MPH_COUNTRIES.has(cc.toUpperCase()) ? 'mph' : 'kmh';
}

// Effective speed-alert mode (source of truth = settings.speedAlertMode), with
// migration from the legacy novaSpeeding boolean for installs stored before the
// 3-way selector existed: novaSpeeding true → 'nova', false → 'off'.
export function getSpeedAlertMode(s: Settings): 'off' | 'nova' | 'ding' {
  return s.speedAlertMode ?? (s.novaSpeeding ? 'nova' : 'off');
}