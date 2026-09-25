// src/carplay/carActions.ts
//
// CarPlay-standalone Wave 3 — the head unit's own ACTIONS, fully headless
// (module scope, no React, works when the phone app was never opened):
//
//   • Destination SEARCH from the car (CPSearchTemplate → Google Places v1 →
//     fetchRoutes → cold nav start through the Wave-2 banner/voice engine)
//   • ONE-TAP police report at the driver's position (Jeff's call: instant,
//     Waze-style — no confirm sheet) + hazard-style "Reported ✓" toast
//   • End route from the car
//
// SURFACE CHOICE (deep-dive verified): buttons drawn on the app's own map
// WINDOW never receive taps (CarPlay doesn't deliver touches to the app-drawn
// base view), and the round CPMapButtons don't render on this app's head unit
// (covered by the RN surface — native fix queued for the next build). But the
// map template's NAVIGATION-BAR chrome demonstrably renders (the iOS-26 crash
// happened while CarPlay drew its own nav-bar share button), and bar buttons
// are wired end-to-end in the installed react-native-carplay (barButtonPressed
// → onBarButtonPressed). So Wave 3 rides nav-bar buttons + pushed templates —
// native template UI that CarPlay itself renders and taps.
//
// Phone hand-off: when a route is started from the car, we persist
// { dest, startedAt } under CAR_NAV_KEY (navNotification owns the key; its
// stopNavBanner clears it) and emit onCarNavStarted — map.tsx adopts the
// session either live (bus, phone open) or on next open (persisted key).

import { api, GOOGLE_MAPS_KEY } from '../api';
import { newPlacesSession, type PlacesSession } from '../places';
import { CAR_SEARCH_CRUMB_QUIET_MS, CAR_SEARCH_REGIONS, carSearchRestriction, crumbText, matchSavedPlace, normalizeCarQuery, pickCarSearchScope, type CarSearchScope } from '../carSearchQuery';
import { getSettings } from '../settings';
import { getGarage } from '../garageStore';
import { fetchRoutes, type NavRoute } from '../nav';
import { startNavBanner, stopNavBanner, CAR_NAV_KEY } from '../navNotification';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import { getCarState, setCarState, setCarHazards, subscribeCarState, emitCarGesture } from './carStore';
import { toggleMapView2D, setMapView2D, isMapView2DLocked } from '../mapViewMode';
import { getDepartureBearing, departureBearingSource, orderRoutesForward, routeInitialBearing } from '../departureBearing';
import { CAR_ICON_MIC, CAR_ICON_CREW, CAR_ICON_HAZARDS, CAR_ICON_ZOOM_IN, CAR_ICON_ZOOM_OUT, CAR_ICON_HOME, CAR_ICON_WORK, CAR_ICON_SAVED, CAR_ICON_BLANK, CAR_ICON_VIEW_2D, CAR_ICON_VIEW_3D, carIcon } from './carButtonIcons';
import { HAZARD_BUTTON_ID, HAZARD_BUTTON_GLYPH, HAZARD_TEMPLATE_ID, HAZARD_PANEL_TITLE, hazardTile, hazardTapLabel, hazardGridButtons, hazardGridConfigAA, type HazardKind } from './hazardPanel';
import { appSkinNow } from '../appSkin';
import { toggleCarComms } from './carComms';
import { logEvent, logEventReliable } from '../crashBreadcrumb';
import { ensureSavedPlacesLoaded, getSavedPlaces, type SavedPlace } from '../savedPlaces';
import { requestLocationFromCar, refreshCarStatus, canRequestFromCar } from './carStatus';
import { isAskableStatus } from './carStatusRule';
import { CAR_ALLOW_LOCATION_TITLE } from './carStatusCopy';

// ── lazy react-native-carplay access ────────────────────────────────────────
// TWO accessors, deliberately.
//
// getCarLib() is CROSS-PLATFORM and asks only "is the native module present?".
// getLib() keeps the iOS-only gate it has always had, because every one of its
// existing callers is a genuinely iOS-only API: carAlert builds a CPAlertTemplate
// (RNCarPlay.m), and CarPlay.popToRootTemplate is NOT a @ReactMethod in
// CarPlayModule.kt at all — Android exposes setRootTemplate / pushTemplate /
// popTemplate / popToTemplate / createTemplate / updateTemplate and nothing else.
// Ungating getLib() would therefore change carAlert on Android AND call a method
// that does not exist. ONLY the Android-Auto search path uses getCarLib().
function getCarLib(): any | null {
  if (Platform.OS === 'web') return null;
  if (!(NativeModules as any).RNCarPlay) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-carplay');
  } catch {
    return null;
  }
}
function getLib(): any | null {
  if (Platform.OS !== 'ios') return null;
  return getCarLib();
}

// Visible confirmation on the head unit.
//
// WAS: `CarPlay.bridge.toast(msg, 2.5)` — a method that DOES NOT EXIST ON iOS.
// `toast` is declared in the library's TypeScript surface and implemented ONLY
// in the Android CarPlayModule (grep: ZERO occurrences in ios/RNCarPlay.m), and
// the `?.` + try/catch swallowed the miss silently. Every confirmation below was
// therefore dropped on the floor, which made a WORKING nav-bar button
// indistinguishable from a dead one — the actual root of the long-running
// "CarPlay is completely touch-inert" report (deep-dive 2026-07-19). getLib()
// also returns null off-iOS, so this was dead on BOTH platforms.
//
// NOW: CPAlertTemplate — real native template UI that CarPlay itself renders and
// taps (RNCarPlay.m:394 builds it, :603 presentTemplate, :616 dismissTemplate,
// :1333 emits alertActionPressed). This restores feedback for every call site AND
// doubles as an HONEST probe that the interfaceController/template layer is alive
// (the old toast-based probe could never have fired on iOS).
// NOTE: RCTTiming pauses setTimeout while the phone is locked, so the auto-dismiss
// may not fire cold — the OK action is the always-available way out.
let _alertTimer: any = null;
export function carAlert(msg: string): void {
  const lib = getLib();
  if (!lib) return;
  const CarPlay = lib.CarPlay, AlertTemplate = lib.AlertTemplate;
  if (!CarPlay?.presentTemplate || !AlertTemplate) return;
  try {
    // Never stack alerts — dismiss any in-flight one first.
    if (_alertTimer) { clearTimeout(_alertTimer); _alertTimer = null; try { CarPlay.dismissTemplate(false); } catch {} }
    const alert = new AlertTemplate({
      titleVariants: [msg],
      actions: [{ id: 'ok', title: 'OK' }],
      onActionButtonPressed: () => {
        if (_alertTimer) { clearTimeout(_alertTimer); _alertTimer = null; }
        try { CarPlay.dismissTemplate(true); } catch {}
      },
    });
    CarPlay.presentTemplate(alert, true);
    // Dismissal must NOT depend on setTimeout alone. iOS suspends JS timers while
    // the phone is locked — a phone in a mount — so the 2600ms fallback below
    // provably never fires on a drive, and a presented alert then covers the map
    // and kills every CarPlay button for the rest of the trip (root-caused
    // 2026-07-24 in the CarPlay sim: the control run logged "Requesting present
    // template <CPAlertTemplate>" and only dismissed because the sim was
    // foregrounded and unlocked). carStore position ticks keep flowing when locked
    // — that is what the background location feed exists for — so they, not a
    // timer, are the reliable clock here. Nothing calls carAlert today; this makes
    // it safe to call again.
    const deadline = Date.now() + 2600;
    const off = subscribeCarState(() => {
      if (Date.now() < deadline) return;
      try { off(); } catch {}
      if (_alertTimer) { clearTimeout(_alertTimer); _alertTimer = null; }
      try { CarPlay.dismissTemplate(true); } catch {}
    });
    _alertTimer = setTimeout(() => {
      _alertTimer = null;
      try { off(); } catch {}
      try { CarPlay.dismissTemplate(true); } catch {}
    }, 2600);
  } catch {}
}
// ── ROUTINE FEEDBACK IS NON-BLOCKING (2026-07-24) ────────────────────────────
// `toast()` used to be carAlert -> CPAlertTemplate -> CarPlay.presentTemplate, i.e.
// a MODAL over the map. Two consequences, both fatal to a driver:
//   • a presented template makes EVERY map button unreachable by design, and
//   • carAlert's auto-dismiss is a setTimeout — and iOS PAUSES JS TIMERS WHILE THE
//     PHONE IS LOCKED, which is exactly the state a phone is in while driving.
// So one tap that produced any message (e.g. the comms mic returning "Allow the
// microphone on your phone first") left a modal on screen that could not time out,
// and every CarPlay button went dead until the phone was unlocked. That is Jeff's
// "THE CARPLAY BUTTONS WERE NOT WORKING AGAIN" on 2026-07-24 — and it violated the
// rule written into CARPLAY.md the same morning.
// Routine feedback now goes to the car surface's own status pill: never covers a
// button, and it expires by TIMESTAMP COMPARISON at render, so a paused timer
// cannot strand it. carAlert is kept for genuine decisions only (nothing uses it
// today) — never for informational messages.
const TOAST_MS = 3000;
function toast(msg: string): void {
  try { setCarState({ carToast: msg, carToastUntil: Date.now() + TOAST_MS }); } catch {}
}

// ── 5s-ago position ring buffer (parity with the phone's getPos5SecAgo) ─────
// The phone anchors police pins ~5s behind the car (you report what you just
// passed). Headless has no posHistoryRef, so keep a tiny ring off carStore
// position ticks. Falls back to the live fix when history is thin.
const POS_RING_MAX = 12;
const _posRing: { lat: number; lng: number; ts: number }[] = [];
let _ringArmed = false;
function armPosRing(): void {
  if (_ringArmed) return;
  _ringArmed = true;
  let lastLat: number | null = null;
  let lastLng: number | null = null;
  subscribeCarState((s) => {
    if (typeof s.selfLat !== 'number' || typeof s.selfLng !== 'number') return;
    if (s.selfLat === lastLat && s.selfLng === lastLng) return;
    lastLat = s.selfLat; lastLng = s.selfLng;
    _posRing.push({ lat: s.selfLat, lng: s.selfLng, ts: Date.now() });
    if (_posRing.length > POS_RING_MAX) _posRing.shift();
  });
}
function pos5SecAgo(): { lat: number; lng: number } | null {
  const s = getCarState();
  const live = typeof s.selfLat === 'number' && typeof s.selfLng === 'number'
    ? { lat: s.selfLat, lng: s.selfLng } : null;
  if (!_posRing.length) return live;
  const target = Date.now() - 5000;
  return _posRing.reduce((best, p) =>
    Math.abs(p.ts - target) < Math.abs(best.ts - target) ? p : best);
}

// ── one-tap police report ────────────────────────────────────────────────────
// Exactly the phone's reportAlert('police') wire call: POST /hazards with
// kind/lat/lng/note. reporter_handle + expires_at are SERVER-derived from the
// bearer token (api's interceptor reads getToken() headlessly), and the backend
// fans the new hazard out to every driver (WS + Supabase Realtime) — receivers
// can't tell a car report from a phone report. No client-side cooldown (phone
// has none either); id-dedupe on the receive side absorbs our own echo.
let _reportInFlight = false;
export function reportPoliceFromCar(): Promise<void> { return reportHazardFromCar('police', 'Police reported ✓'); }
/** Any of the four kinds POST /hazards accepts — the Report panel's tiles call this (2026-09-24). */
export async function reportHazardFromCar(kind: HazardKind, done: string): Promise<void> {
  if (_reportInFlight) return; // debounce a double-tap while the POST runs
  const pos = pos5SecAgo();
  if (!pos) { toast('No GPS fix yet'); return; }
  _reportInFlight = true;
  try {
    const { data } = await api.post('/hazards', { kind, lat: pos.lat, lng: pos.lng, note: '' });
    // Optimistic pin on the car map (same id-dedupe the phone applies). Goes
    // through the 'service' gate — if the phone mirror is live it will echo the
    // same hazard via WS within a beat anyway.
    if (data && data.id) {
      const cur = getCarState().hazards || [];
      if (!cur.some((h) => h.id === data.id)) {
        setCarHazards([{ id: data.id, kind: data.kind || kind, lat: data.lat, lng: data.lng, confirms: data.confirms, disputes: data.disputes }, ...cur], 'service');
      }
    }
    toast(done);
  } catch {
    toast('Report failed — no connection');
  } finally {
    _reportInFlight = false;
  }
}

// ── THE REPORT PANEL (2026-09-24) ──────────────────────────────────────────────────────────────
// Jeff: "if i was to make the compass button the hazards, when tapping it could it bring up a menu to tap?" → "can we put
// the compass in the hazard pop up on carplay?" → "build the hazard panel with the apple glyphs i mentioned". The fourth
// map button opens ONE grid — Police / Crash / Hazard / Traffic / Compass (src/carplay/hazardPanel.ts) — a tile pops it
// and either reports at the car's position from 5 s ago (reportHazardFromCar, the police path generalised) or fires the
// same `compass` gesture the old button did. CARPLAY.md rule 7: one instance per session (like _whereTo), an
// already-pushed guard, and the way home is the tile itself (plus the native back chevron). Rule 7b: no alert, the
// result is the pill. Android Auto: createTemplate('grid') + pushTemplate, the press arrives as `gridButtonPressed`
// with our template id (androidx RCTTemplate.parseGridItem → EventEmitter.gridButtonPressed; templateId is stamped by
// emit()), `backButtonPressed` for our id pops it — the search screen's exact pattern.
let _hazards: any = null;
let _hazardsPushed = false;
let _aaHazardsArmed = false;
let _hazardsDisconnectArmed = false;
// A disconnect ends the interface-controller stack but this module flag survives it — the same trap
// armSearchAutoDismiss guards for the keyboard: without the reset a panel that was up at unplug reads
// "already pushed" for the rest of the process and the Hazards button is dead until the app restarts.
function armHazardsDisconnectReset(): void {
  if (_hazardsDisconnectArmed) return;
  const cp = (getCarLib() || getLib())?.CarPlay;
  if (!cp?.registerOnDisconnect) return;
  _hazardsDisconnectArmed = true;
  try {
    cp.registerOnDisconnect(() => {
      if (_hazardsPushed) { try { logEventReliable('hazard-panel op=reset why=disconnect'); } catch {} }
      _hazardsPushed = false;
    });
  } catch { _hazardsDisconnectArmed = false; }
}
function hazardIconFor(glyph: Parameters<typeof carIcon>[0]) { return carIcon(glyph, appSkinNow()); }
function getHazardTemplateIOS(): any | null {
  const lib = getLib();
  if (!lib?.GridTemplate) return null;
  if (_hazards) return _hazards;   // ONE instance for the session — a second `new` with the same id fires both
  try {
    _hazards = new lib.GridTemplate({
      id: HAZARD_TEMPLATE_ID,
      title: HAZARD_PANEL_TITLE,
      // Metal resolved at build, like the map buttons: a skin change shows on the next session.
      buttons: hazardGridButtons(hazardIconFor),
      onButtonPressed: (e: { id?: string }) => { onHazardTile(e?.id, 'carplay'); },
      onDidAppear: () => { _hazardsPushed = true; },
      onDidDisappear: () => { _hazardsPushed = false; },
    });
  } catch {
    _hazards = null;
  }
  return _hazards;
}
function popHazardPanel(): void {
  if (!_hazardsPushed) return;
  _hazardsPushed = false;
  try { getCarLib()?.CarPlay?.popTemplate?.(true); } catch {}
  try { logEventReliable(`hazard-panel op=pop surf=${Platform.OS === 'android' ? 'aa' : 'carplay'}`); } catch {}
}
function onHazardTile(id: string | undefined, surf: 'carplay' | 'aa'): void {
  const tile = hazardTile(id);
  try { logEventReliable(`hazard-panel pick surf=${surf} id=${id ?? '?'} kind=${tile?.kind ?? (tile ? 'compass' : '?')}`); } catch {}
  popHazardPanel();
  if (!tile) return;
  if (tile.kind == null) { emitCarGesture({ kind: 'compass' }); return; }
  armPosRing();
  void reportHazardFromCar(tile.kind, tile.done);
}
function armAaHazardBridge(lib: any): void {
  if (_aaHazardsArmed) return;
  const em = lib?.CarPlay?.emitter;
  if (!em?.addListener) return;
  _aaHazardsArmed = true;
  em.addListener('gridButtonPressed', (e: any) => {
    if (!e || e.templateId !== HAZARD_TEMPLATE_ID) return;
    onHazardTile(String(e.id ?? ''), 'aa');
  });
  em.addListener('backButtonPressed', (e: any) => {
    if (!e || e.templateId !== HAZARD_TEMPLATE_ID) return;
    popHazardPanel();
  });
}
export function openHazardPanel(): void {
  if (_hazardsPushed) return;             // already up: a double tap must not double-push (rule 7)
  armHazardsDisconnectReset();            // idempotent
  const lib = getCarLib();
  if (Platform.OS === 'android') {
    const bridge = lib?.CarPlay?.bridge;
    if (!bridge?.createTemplate || !bridge?.pushTemplate) { toast('Report unavailable'); return; }
    armAaHazardBridge(lib);
    _hazardsPushed = true;                 // claim BEFORE the create so a double tap cannot double-push
    try {
      // Always re-create (see openAaSearch): createTemplate rebuilds the CarScreen so the id resolves at push time,
      // and the push lives inside the callback so a createScreen failure is a toast, not a main-thread crash.
      bridge.createTemplate(HAZARD_TEMPLATE_ID, hazardGridConfigAA(hazardIconFor), (res: any) => {
        if (res?.error) { _hazardsPushed = false; try { logEvent(`hazard-panel create-failed:${res.error}`); } catch {} toast('Report unavailable'); return; }
        if (!_hazardsPushed) return;
        try { bridge.pushTemplate(HAZARD_TEMPLATE_ID, true); try { logEventReliable('hazard-panel op=push surf=aa'); } catch {} }
        catch { _hazardsPushed = false; toast('Report unavailable'); }
      });
    } catch { _hazardsPushed = false; toast('Report unavailable'); }
    return;
  }
  const t = getHazardTemplateIOS();
  if (!t) { toast('Report unavailable'); return; }
  _hazardsPushed = true;                   // claim BEFORE the push so a double tap cannot double-push
  try { logEventReliable('hazard-panel op=push surf=carplay'); } catch {}
  try { lib?.CarPlay?.pushTemplate?.(t, true); } catch { _hazardsPushed = false; toast('Report unavailable'); }
}

// ── destination search (Google Places API v1 — the New API; the legacy
//    place/* endpoints REQUEST_DENIED on this key) ──────────────────────────
// `main` = the prediction's primary line ("Tim Hortons") — the pick's label, so Place Details
// never has to ask for the Pro-tier displayName (billing note in src/places.ts).
type CarSearchResult = { placeId: string; description: string; main?: string };
let _lastResults: CarSearchResult[] = [];
// Places (New) billing session for the head-unit search — born on the first keystroke, spent
// by the placeDetails() of the pick, never reused after (src/places.ts has the rules).
let _searchSession: PlacesSession | null = null;

// ── car-search crumbs (2026-09-24) ─────────────────────────────────────────────
// No row carried the search text or the result count, so Say Phin's "voice search failed" was
// diagnosed from a photo of his head unit. One `car-search` row per typed query — written
// CAR_SEARCH_CRUMB_QUIET_MS after the last keystroke that produced a list, or at once when a row
// is picked, so it lands BEFORE that pick's `car-search-pick` row (below). Bounded by the
// driver's own typing; Places is still called per keystroke, the crumb is not.
type CarSearchMeta = { text: string; norm: string; n: number; saved: 0 | 1; ms: number; scope: CarSearchScope | 'nofix' };
let _searchCrumbPending: CarSearchMeta | null = null;
let _searchCrumbTimer: ReturnType<typeof setTimeout> | null = null;
function flushSearchCrumb(): void {
  if (_searchCrumbTimer) { clearTimeout(_searchCrumbTimer); _searchCrumbTimer = null; }
  const m = _searchCrumbPending;
  _searchCrumbPending = null;
  if (!m) return;
  try { logEvent(`car-search text="${crumbText(m.text)}" norm="${crumbText(m.norm)}" n=${m.n} saved=${m.saved} ms=${m.ms} scope=${m.scope}`); } catch {}
}
function scheduleSearchCrumb(m: CarSearchMeta): void {
  _searchCrumbPending = m;
  if (_searchCrumbTimer) clearTimeout(_searchCrumbTimer);
  _searchCrumbTimer = setTimeout(flushSearchCrumb, CAR_SEARCH_CRUMB_QUIET_MS);
}

// TWO SCOPES IN PARALLEL (Say Phin, 2026-09-24 — "navigate home" drew Coralville IA and
// Bentonville AR): a request RESTRICTED to a rectangle CAR_SEARCH_RESTRICT_KM around the car
// (`carSearchRestriction`; Google caps a restriction CIRCLE at 50 km and allows bias OR
// restriction, never both) and the old 50 km-BIASED request, both Canada/US only, both on the
// same session token. `pickCarSearchScope` shows the restricted rows only when Google's own
// first biased row is local too (then the far tail is junk); otherwise the biased list — MEASURED
// live: restricted "Kamloops" is five local streets while the biased list has the city first, so
// a restriction alone would hide a 250 km club destination. Rules + receipts: src/carSearchQuery.ts.
// The Essentials mask and the token rules in src/places.ts are unchanged. No fix → the biased
// request alone, as before. Two autocompletes per keystroke instead of one, in parallel (same
// latency); at the head unit's search volume that is cents a month against the 10k free tier.
async function placesAutocomplete(input: string): Promise<{ rows: CarSearchResult[]; scope: CarSearchScope | 'nofix' }> {
  const s = getCarState();
  const here = typeof s.selfLat === 'number' && typeof s.selfLng === 'number' ? { lat: s.selfLat, lng: s.selfLng } : null;
  _searchSession ??= newPlacesSession();
  const sessionToken = _searchSession.token;
  const ask = async (scope: Record<string, unknown>): Promise<CarSearchResult[]> => {
    const body: any = { input, sessionToken, includedRegionCodes: CAR_SEARCH_REGIONS, ...scope };
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_MAPS_KEY },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return (data.suggestions || [])
      .filter((x: any) => x.placePrediction)
      .slice(0, 8)
      .map((x: any) => ({
        placeId: x.placePrediction.placeId,
        description: x.placePrediction.text?.text ?? '',
        main: x.placePrediction.structuredFormat?.mainText?.text || undefined,
      }))
      .filter((x: CarSearchResult) => x.placeId && x.description);
  };
  if (!here) return { rows: await ask({}), scope: 'nofix' };
  const [near, wide] = await Promise.allSettled([
    ask({ locationRestriction: carSearchRestriction(here.lat, here.lng) }),
    ask({ locationBias: { circle: { center: { latitude: here.lat, longitude: here.lng }, radius: 50000.0 } } }),
  ]);
  if (near.status === 'rejected' && wide.status === 'rejected') throw wide.reason;
  return pickCarSearchScope(near.status === 'fulfilled' ? near.value : [], wide.status === 'fulfilled' ? wide.value : []);
}

// `labelHint` is the picked prediction's main line — the label, so the mask stays
// Essentials-only (location + formattedAddress; displayName would make it Pro).
async function placeDetails(placeId: string, labelHint?: string): Promise<{ lat: number; lng: number; label?: string } | null> {
  const session = _searchSession;
  _searchSession = null;   // spent — the next search starts a fresh one
  const qs = session ? `?sessionToken=${encodeURIComponent(session.token)}` : '';
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${qs}`, {
    headers: { 'X-Goog-Api-Key': GOOGLE_MAPS_KEY, 'X-Goog-FieldMask': 'location,formattedAddress' },
  });
  const data = await res.json();
  if (typeof data?.location?.latitude !== 'number') return null;
  return { lat: data.location.latitude, lng: data.location.longitude, label: labelHint || data.formattedAddress || undefined };
}

// ── start / end navigation from the car ──────────────────────────────────────
// startCarNav drives the ENTIRE Wave-2 cold engine: fetchRoutes headless →
// fastest route → startNavBanner (persists the slim route + polyline, arms the
// bg-location TBT tick → car banner, ETA, Nova voice) → carStore so the ribbon
// draws immediately. The phone adopts via CAR_NAV_KEY / the bus below.
type CarNavListener = (e: { dest: { lat: number; lng: number; label?: string } }) => void;
const _navListeners = new Set<CarNavListener>();
export function onCarNavStarted(fn: CarNavListener): () => void {
  _navListeners.add(fn);
  return () => { _navListeners.delete(fn); };
}

let _navStartInFlight = false;
export async function startCarNav(dest: { lat: number; lng: number; label?: string }): Promise<boolean> {
  // 🔒 NAV-LOCK begin act-carnav-start-guard — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)
  if (_navStartInFlight) return false;
  const s = getCarState();
  if (typeof s.selfLat !== 'number' || typeof s.selfLng !== 'number') { toast('No GPS fix yet'); return false; }
  _navStartInFlight = true;
  // 🔒 NAV-LOCK end act-carnav-start-guard
  try {
    // 🔒 NAV-LOCK begin act-carnav-route-choice — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)
    const st = getSettings();
    const near = { lat: s.selfLat, lng: s.selfLng };
    const avoid = { tolls: st.avoidTolls, highways: st.avoidHighways, ferries: st.avoidFerries };
    // The facing is read CONCURRENTLY with the fetch (no added latency) and passed the origin so the parked
    // heading can apply (src/departureBearing.ts step 0).
    const [routes0, facing] = await Promise.all([
      fetchRoutes(near, { lat: dest.lat, lng: dest.lng }, avoid),
      getDepartureBearing(near),
    ]);
    if (!routes0.length) { toast('No route found'); return false; }
    // DEPART THE WAY THE CAR IS POINTING, FOR REAL — the same constrained re-ask map.tsx does (2026-09-06), which
    // this path never had (2026-09-16): when the fastest unconstrained route turns us around (> 75° off the facing)
    // ask once more with `bearings=facing,45` and take that answer if there is one. Four surfaces, one behaviour.
    let routes = routes0;
    let constrained = 0;
    if (typeof facing === 'number') {
      const _b00 = routeInitialBearing(routes0[0] as any);
      const _off0 = _b00 != null ? Math.abs(((_b00 - facing + 540) % 360) - 180) : null;
      if (_off0 != null && _off0 > 75) {
        const withBearing = await fetchRoutes(near, { lat: dest.lat, lng: dest.lng }, avoid, { bearing: facing });
        if (withBearing.length) { routes = withBearing; constrained = 1; }
      }
    }
    // FOUR-SURFACE PARITY (2026-07-30). This is the route start for a search made on
    // CarPlay AND on Android Auto, and it used to sort on ETA alone while the phone
    // had already learned to prefer a route that departs the way the car is pointing.
    // Same destination, same car, but a U-turn from the head unit and not from the
    // phone. One shared ranker now, so they cannot drift apart again — see
    // src/departureBearing.ts for why the Directions `bearings` parameter is NOT the
    // fix. Falls back to plain fastest-first when the facing is unknown.
    const ordered = orderRoutesForward(routes, facing ?? undefined);
    // 🔒 NAV-LOCK end act-carnav-route-choice
    // Same depart-rank crumb as the phone (map.tsx) — src=car marks the CarPlay path.
    try {
      const _b0 = routeInitialBearing(ordered[0] as any);
      const _off = (typeof facing === 'number' && _b0 != null)
        ? Math.round(Math.abs(((_b0 - facing + 540) % 360) - 180)) : -1;
      const _cands = routes.map((r: any) => {
        const b = routeInitialBearing(r);
        const d = r?.duration_in_traffic_s ?? r?.duration_s;
        return `${b != null ? Math.round(b) : '?'}/${typeof d === 'number' ? Math.round(d) : '?'}s`;
      }).join(',');
      logEvent(`depart-rank src=car constrained=${constrained} fsrc=${departureBearingSource()} n=${routes.length} facing=${typeof facing === 'number' ? Math.round(facing) : 'null'} chosenBr=${_b0 != null ? Math.round(_b0) : 'null'} off=${_off} cands=${_cands}`);
    } catch {}
    // 🔒 NAV-LOCK begin act-carnav-commit — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)
    const best: NavRoute = ordered[0];
    // Persist the hand-off BEFORE starting the banner so a crash between the two
    // can't leave guidance running with no adoptable session.
    try { await AsyncStorage.setItem(CAR_NAV_KEY, JSON.stringify({ dest, startedAt: Date.now() })); } catch {}
    await startNavBanner(best, dest.label);
    // Immediate car-map state (startNavBanner already wrote routePolyline; add
    // the rest so the first frame after the tap is fully dressed).
    setCarState({
      navigating: true,
      destinationLabel: dest.label || '',
      routePolyline: best.polyline || '',
      routeCoordinates: (best as any).coordinates || undefined,
      routeCongestion: (best as any).congestion || undefined,
      routes: [],
    });
    _navListeners.forEach((l) => { try { l({ dest }); } catch {} });
    // 🔒 NAV-LOCK end act-carnav-commit
    toast(dest.label ? `Routing to ${dest.label}` : 'Route started');
    return true;
  } catch {
    toast('Routing failed');
    return false;
  } finally {
    // 🔒 NAV-LOCK begin act-carnav-inflight-release — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)
    _navStartInFlight = false;
    // 🔒 NAV-LOCK end act-carnav-inflight-release
  }
}

export async function endCarNav(): Promise<void> {
  // 🔒 NAV-LOCK begin act-endnav-bank-stop — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)
  if (!getCarState().navigating) { toast('No active route'); return; }
  // BANK THE DRIVE FIRST (Codex review 2026-09-09). On a STANDALONE head-unit drive the phone
  // map is not mounted, so the map's own End recorder never runs and this teardown simply
  // deleted the session — the drive vanished. stopNavBanner() below clears CAR_NAV_KEY and the
  // slim route, so this has to happen before it, not after. Lazy require: carActions is loaded
  // on the CarPlay bootstrap path and must not pull navNotification in at import time.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    await require('../navNotification').recordColdDriveOnEnd();
  } catch {}
  try { await stopNavBanner(); } catch {} // also clears CAR_NAV_KEY (owner: navNotification)
  // 🔒 NAV-LOCK end act-endnav-bank-stop
  // Ending a route must also clean the template stack: Jeff's 8/19 drive ended with
  // the stranded search keyboard STILL covering the map because nothing here popped
  // it. iOS-only — Android's dismiss path pops to the AA nav template by id, and on
  // AA endCarNav can run while other templates are legitimately stacked.
  if (Platform.OS !== 'android' && (_searchPushed || _searchPresented || _whereToPushed)) {
    iosStack('op=root why=end');
    _searchPushed = false;
    _whereToPushed = false;   // one root pop clears the WHOLE stack — keyboard and list
    try { getLib()?.CarPlay?.popToRootTemplate?.(true); } catch {}
  }
  // 🔒 NAV-LOCK begin act-endnav-clear-state — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)
  setCarState({
    navigating: false,
    routePolyline: '',
    instruction: '',
    distanceToTurn: '',
    distanceToTurnM: 0,
    eta: '',
    distanceRemaining: '',
    distanceRemainingM: 0,
    etaSeconds: 0,
    destinationLabel: '',
    maneuverIcon: undefined,
    routeCoordinates: undefined,
    routeCongestion: undefined,
    routes: [],
  });
  // 🔒 NAV-LOCK end act-endnav-clear-state
  toast('Route ended');
}

// ── the CarPlay Search template (pushed from the map's nav-bar button) ──────
let _searchTemplate: any | null = null;
// Is the search template currently on top of the CarPlay stack? Tracked via the
// template's own didAppear/didDisappear so it survives a system-back cancel too.
// Two jobs: (a) refuse a DOUBLE-PUSH — pushing the same memoised template instance
// that is already on the interface-controller stack corrupts CarPlay's navigation
// stack, which is exactly the "keyboard up, nothing touchable, no buttons work"
// freeze Jeff hit; (b) let the motion watcher know when to auto-dismiss.
let _searchPresented = false;
// ── WHY A SECOND FLAG (Jeff, 2026-08-14) ────────────────────────────────────────
// Reported: "when driving and trying to press the carplay/aa search the keyboard doesn't
// work cause your driving (perfect), keyboard disappears. but when coming to a stop the
// keyboard pops out again everytime."
//
// `_searchPresented` tracks VISIBILITY (didAppear/didDisappear). The motion auto-dismiss
// keyed off it and bailed with `if (!_searchPresented) return;` — so the moment iOS hid
// the search UI because the car started moving, didDisappear fired, the flag went false,
// and the pop we actually wanted NEVER RAN. The template stayed on the CarPlay stack for
// the rest of the drive, and iOS re-presented it at every stop. The guard meant to make
// the dismiss safe was the reason it never happened.
//
// This flag tracks OWNERSHIP instead: true from the moment we push until the template is
// genuinely off the stack (we popped it, or the driver picked a destination). Visibility
// can flap as much as iOS likes; ownership does not.
//
// ⚠ HYPOTHESIS, not verified on a head unit: that iOS fires didDisappear when it hides
// the search UI for motion. What IS certain from the code is that the old condition can
// only pop while the template is visible, and a driver who is moving is exactly when it
// is not. Fixing it this way is correct under either mechanism.
let _searchPushed = false;
// "Where to?" saved-places list (iOS) — see getWhereToTemplate.
let _whereTo: any | null = null;
let _whereToShown: SavedPlace[] = [];
let _whereToToSearch = false;
// ── THE LIST OWNS ITSELF (Olaf, 2026-09-20) ────────────────────────────────────
// "Can't select home or work on the CarPlay screen. It just says search and that's it.
// Have to load on the phone." The "Where to?" list SHARED _searchPushed with the keyboard,
// so the motion watcher — written for a keyboard CarPlay itself refuses to serve while
// driving — yanked the keyboard-LESS list away too. His 20 days of receipts: 10 ×
// `op=push id=whereto` each followed by `op=root why=dismiss`, 0 selections, dismiss gaps
// as short as 0.14 s, tapped at ~44 km/h. A list of saved places is NOT a dead modal: it
// takes taps at any speed, which is the whole reason it exists (Rodrigo, 2026-09-03).
// So it owns itself here, and the watcher's `_searchPushed || _searchPresented` guard now
// means the keyboard and nothing else — the keyboard keeps its motion pop untouched.
let _whereToPushed = false;

// ── ANDROID AUTO SEARCH (2026-08-15) ────────────────────────────────────────────
// FILMED: the driver taps Search on the AA action strip, the green "Search ✓" receipt
// appears — so the tap REACHES JS — and nothing opens. TWO defects stacked:
//
//  (1) OURS. getSearchTemplate() went through getLib(), which is iOS-only, so it
//      returned null and the car-search branch hit `if (!t) return;` — a silent dead
//      end AFTER carTap() had already drawn the receipt.
//
//  (2) THE LIBRARY'S. react-native-carplay's JS SearchTemplate computes
//      config.onSearch(query) and then hands the rows to native only
//      `if (Platform.OS === 'ios')` (src/templates/SearchTemplate.ts:47). There is NO
//      Android branch: the results are computed and THROWN AWAY. Android's native
//      template never wanted a callback result — RCTSearchTemplate.kt:29 reads them as
//      a PROP, `props.getArray("items") -> setItemList(parseItemList(it,"row"))`.
//
// So Android does NOT construct a JS SearchTemplate at all. Everything below talks to
// the @ReactMethods that DO exist on Android (CarPlayModule.kt): createTemplate (:100),
// pushTemplate (:168), updateTemplate (:119, real since build 70), popToTemplate (:179).
// Avoiding the JS class also avoids a trap: its constructor registers its own
// 'updatedSearchText' listener that calls config.onSearch, so every keystroke would run
// the Places lookup TWICE, once for a result that is discarded.
//
// iOS is untouched: _searchTemplate / getSearchTemplate() / the CPSearchTemplate
// callbacks are unchanged, and every branch here is behind Platform.OS === 'android'.
// A DIFFERENT template id from iOS's 'convoy-car-search' on purpose.
const AA_SEARCH_ID = 'convoy-aa-search';
// AndroidAutoRoot.tsx:80 — the NavigationTemplate id. It is pushed at session start and
// nothing ever pops it, so it is always on the ScreenManager stack.
const AA_NAV_ID = 'convoy-aa-nav';
// androidx's own default list content limit is 6 (res/values content_limit_list in
// androidx.car.app:app:1.4.0-beta02). Never send more.
const AA_SEARCH_MAX_ROWS = 6;

type AaRow = { id: string; text: string; detailText?: string; browsable: boolean };
// rows + the EXACT lists those rows were built from. Committed together, so the list a
// tap indexes into can never be a different generation from the list on screen.
type AaList = { rows: AaRow[]; saved: SavedPlace[]; results: CarSearchResult[]; meta?: CarSearchMeta };

let _aaSaved: SavedPlace[] = [];
let _aaResults: CarSearchResult[] = [];
let _aaSearchSeq = 0;
let _aaLastRowsKey = '';
let _aaBridgeArmed = false;

// The exact prop shape RCTSearchTemplate.parse consumes — nothing else is read.
// updateTemplate REBUILDS the androidx template from scratch every call, so the whole
// config must be re-sent each time; anything omitted reverts to a builder default.
// `items` is OMITTED when empty (a driver with no saved places) rather than sent as an
// empty array, so the host shows its own empty state instead of a zero-row list.
function aaSearchConfig(items: AaRow[]) {
  return {
    type: 'search',
    id: AA_SEARCH_ID,
    searchHint: 'Where to?',
    // Re-sent on EVERY refresh deliberately: omitting it would fall back to the
    // builder default (false) and drop the keyboard mid-word.
    showKeyboardByDefault: true,
    // Action.BACK is the only header action that can pass androidx's
    // ACTIONS_CONSTRAINTS_HEADER here — maxActions 1, requireActionIcons true,
    // onClickListenerAllowed FALSE (disassembled from the 1.4.0-beta02 aar).
    // validateOrThrow's icon requirement is guarded by Action.isStandard(), and
    // RCTTemplate.parseAction returns the standard Action.BACK for type:'back' with no
    // click listener attached, so it validates; a custom action with an id would not.
    headerAction: { type: 'back' },
    ...(items.length ? { items } : {}),
  };
}

function aaRowsKey(rows: AaRow[]): string {
  return rows.map((r) => r.id + '|' + r.text).join('');
}

// Home, then Work, then custom newest-first — the phone's ordering.
// NO row images on Android, on purpose: RCTTemplate.parseCarIcon does a BLOCKING Fresco
// decode (DataSources.waitForFinalResult) on the car's main thread, once per row, and a
// decode failure would throw inside the parser — and a parser throw here is fatal (see
// openAaSearch). androidx's ROW_CONSTRAINTS_SIMPLE does allow images, so this can be
// revisited once the path has survived one real drive. Empty titles are filtered because
// androidx Row.Builder throws "The title cannot be null or empty".
function aaSavedList(): AaList {
  const rank = (k: SavedPlace['kind']) => (k === 'home' ? 0 : k === 'work' ? 1 : 2);
  const saved = getSavedPlaces()
    .slice()
    .filter((p) => !!p.label)
    .sort((a, b) => rank(a.kind) - rank(b.kind) || b.createdAt - a.createdAt)
    .slice(0, AA_SEARCH_MAX_ROWS);
  return {
    saved,
    results: [],
    rows: saved.map((p, i) => ({
      id: `s:${i}`,
      text: p.label,
      ...(p.address ? { detailText: p.address } : {}),
      // parseRowItem attaches its click listener ONLY when the row carries
      // browsable:true (RCTTemplate.kt:170). Without it the row renders and is dead.
      browsable: true,
    })),
  };
}

// PURE. It must NOT publish anything: two keystrokes can be in flight at once and the
// slower one can land last, so only the winner (seq check at the call site) is allowed
// to commit. Publishing here is how an index-addressed list ends up describing a
// different generation than the rows on screen — i.e. the wrong destination.
async function aaListFor(query: string): Promise<AaList> {
  const text = (query || '').trim();
  // VOICE-TYPED COMMANDS (Say Phin, 2026-09-24): the AA host types the spoken phrase verbatim,
  // so "navigate home" is stripped to "home" before anything else reads it, and a bare verb
  // leaves nothing — the saved list. The saved place the text names goes FIRST (row s:0), the
  // Places rows follow — src/carSearchQuery.ts holds the rules, car_search_test.mts pins them.
  const q = normalizeCarQuery(text);
  if (q.length < 2) {
    try { await ensureSavedPlacesLoaded(); } catch {}
    return aaSavedList();
  }
  const t0 = Date.now();
  try { await ensureSavedPlacesLoaded(); } catch {}
  const match = matchSavedPlace(q, getSavedPlaces());
  const saved = match ? [match] : [];
  let results: CarSearchResult[] = [];
  let scope: CarSearchMeta['scope'] = 'none';
  try {
    const found = await placesAutocomplete(q);
    results = found.rows.slice(0, AA_SEARCH_MAX_ROWS - saved.length);
    scope = found.scope;
  } catch {
    results = [];
  }
  return {
    saved,
    results,
    rows: [
      ...saved.map((p, i) => ({ id: `s:${i}`, text: p.label, ...(p.address ? { detailText: p.address } : {}), browsable: true })),
      ...results.map((r, i) => ({ id: `r:${i}`, text: r.description, browsable: true })),
    ],
    meta: { text, norm: q, n: saved.length + results.length, saved: match ? 1 : 0, ms: Date.now() - t0, scope },
  };
}

function aaCommit(list: AaList): void {
  _aaSaved = list.saved;
  _aaResults = list.results;
}

function aaPushRows(rows: AaRow[]): void {
  const bridge = getCarLib()?.CarPlay?.bridge;
  if (!bridge?.updateTemplate) return;
  const key = aaRowsKey(rows);
  if (key === _aaLastRowsKey) return;   // identical list: do not spend a template refresh
  _aaLastRowsKey = key;
  try { bridge.updateTemplate(AA_SEARCH_ID, aaSearchConfig(rows)); } catch {}
}

// POP TO THE NAV SCREEN BY NAME — never a bare pop.
// popTemplate removes whatever is on top, so a stale ownership claim (see the
// didDisconnect reset below) would have the motion watcher pop the NAVIGATION screen and
// strand the driver on CarPlaySession's "RNCarPlay loading..." placeholder for the rest
// of the drive. ScreenManager.popTo pops `while (size > 1 && !foundMarker)`, and the AA
// nav screen is pushed at session start and never popped, so this is idempotent: if our
// search screen is already gone it does nothing at all.
// (popToRootTemplate is not a @ReactMethod on Android, and "root" there is the session's
// placeholder screen, not our map.)
// ⚠ popToTemplate IS A TRAP ON ANDROID — it threw Say Phin out of the app.
// (Root-caused 8/19 from his video + the library source.) The comment that used
// to live here assumed ScreenManager.popTo finds our nav screen by id. It cannot:
// popTo matches a screen's MARKER, and react-native-carplay NEVER calls
// Screen.setMarker anywhere (the only setMarker in the package is on a Place
// builder). With no marker, androidx's contract is "pop everything except the
// ROOT" — and the root here is CarPlaySession's own placeholder screen, whose
// template renders "RNCarPlay loading...". So every dismiss (motion auto-dismiss,
// back, or after picking a destination) evicted the driver from our map entirely:
//   "I can't back out into the map, have to go to app drawer and select app again."
// A SINGLE pop is correct instead: our stack is only ever
// [session root, nav, search] because openAaSearch pushes exactly one search
// screen and the double-push guard keeps it that way — so popping once lands
// precisely on the nav screen. Guarded to only fire while we believe our search
// screen is on top, so a stale call can never eat the nav screen itself.
// A proper Screen.setMarker is the native fix; queued for build 74.
// TRACKED SEPARATELY FROM _searchPushed on purpose. _searchPushed is an OWNERSHIP
// claim that callers deliberately release BEFORE dismissing (aaSelect does
// `_searchPushed = false; aaPop()`), so it cannot gate the pop. This flag answers
// a narrower question — "is our search screen actually on the stack?" — and it is
// what makes a single pop safe: without it, one stale call would pop the NAV
// screen and drop the driver on the session placeholder, which is the very
// failure being fixed here.
let _aaSearchOnStack = false;
// ── THE ONE THING THE TELEMETRY COULD NOT SEE (2026-09-09) ──────────────────────────────
// Say Phin's head unit shows CarPlaySession's "RNCarPlay loading..." root placeholder for a
// whole drive, and every receipt we HAVE says the Android Auto surface is fine: through his
// 09-09 07:01-07:17 drive the car surface logged 40 cam-probe, 32 ribbon-trim, 30 draw-cmp,
// 15 corner-trace and 16 unbroken 60 s heat-probe windows. The React tree renders happily —
// into a screen nobody can see. What is broken is WHICH SCREEN IS ON TOP of androidx's
// ScreenManager, and nothing in this app ever recorded a push or a pop. So an investigation
// can only guess between "we popped our own map off" (the marker trap documented above) and
// "the system took it". These two rows end that guess: they are rare (a search opens or
// closes), bounded by construction, and they say what WE did.
function aaPop(): void {
  if (!_aaSearchOnStack) return;
  try { logEventReliable('aa-stack op=pop had=1'); } catch {}
  _aaSearchOnStack = false;
  try { getCarLib()?.CarPlay?.popTemplate?.(true); } catch {}
}

// iOS twin of aa-stack (2026-09-10, Rodrigo: "press back while the trip is loading → none of the
// buttons work, only fix was to close the app"). His 10:27 receipts show two Search taps six
// seconds apart, a route auto-started from the list, an End tap two seconds later, a trip started
// from the phone nine seconds after that — and then not one head-unit tap for twelve minutes.
// CARPLAY.md rule 7 says a re-pushed template "renders, takes no touches", and nothing on iOS ever
// recorded a push or a pop, so the next occurrence can only be guessed at. These rows say what WE
// did to the stack: rare (a search opens or closes, a route ends), bounded by construction.
let _iosStackRows = 0;
function iosStack(what: string): void {
  if (Platform.OS === 'android' || _iosStackRows >= 60) return;
  _iosStackRows += 1;
  // `whereto=` is the third state as of 2026-09-20: pushed/presented are the KEYBOARD's
  // (ownership, visibility), whereto is the saved-places list's ownership. A pop row with
  // whereto=1 took the list with it; whereto=0 means only the keyboard was up.
  try { logEventReliable(`ios-stack ${what} pushed=${_searchPushed ? 1 : 0} presented=${_searchPresented ? 1 : 0} whereto=${_whereToPushed ? 1 : 0}`); } catch {}
}

// One dismiss for both car surfaces.
function dismissCarSearch(): void {
  if (Platform.OS === 'android') { aaPop(); return; }
  iosStack('op=root why=dismiss');   // crumb FIRST: it records whereto=1 if the list went too
  // popToRootTemplate empties the stack, so a list sitting UNDER the keyboard is gone
  // whether or not the native call lands. This is the only clear on the motion path —
  // the list's own didDisappear cannot be relied on to fire for a template that was
  // already covered when the pop arrived.
  _whereToPushed = false;
  try { getLib()?.CarPlay?.popToRootTemplate?.(true); } catch {}
}

// ── car-search-pick (2026-09-24) ──────────────────────────────────────────────────────
// John (Ni GR), 09-23: `carplay-tap:car-search` → `depart-rank src=car` → a second
// `carplay-tap:car-search` 2 s later → 19 s on, `depart-rank src=car` to a DIFFERENT
// destination, and "halfway on highway 1 it changed to an address in North Vancouver".
// Nothing recorded which row he tapped or what the row said, so the chain from tap to
// destination could not be read. One row per pick, on every head-unit list (CarPlay
// keyboard template, CarPlay Where-to list, Android Auto search screen), logged BEFORE
// startCarNav so a pick that fails to start still leaves its receipt; a miss (`label="?"`,
// index past the list) is the generation-mismatch signature by itself.
function crumbLabel(s: unknown): string {
  // Quotes and newlines out so the row stays one greppable line; Places descriptions run long.
  return String(s ?? '?').replace(/["\n\r]/g, "'").slice(0, 60);
}

async function aaSelect(rowId: string): Promise<void> {
  const kind = rowId.slice(0, 1);
  const idx = Number(rowId.slice(2));
  if (!Number.isFinite(idx)) return;
  if (kind === 's') {
    const p = _aaSaved[idx];
    flushSearchCrumb();   // the query row lands before its pick, whatever the quiet timer was doing
    try { logEvent(`car-search-pick surf=aa idx=${idx} src=saved label="${crumbLabel(p?.label)}"`); } catch {}
    if (!p) return;
    const ok = await startCarNav({ lat: p.lat, lng: p.lng, label: p.label });
    // SAME OWNERSHIP RULE AS iOS: release only when we actually pop. Releasing on a
    // FAILED start would leave the screen on the stack with nobody owning it, and the
    // re-tap would stack a second one.
    if (ok) { _searchPushed = false; aaPop(); }
    return;
  }
  const picked = _aaResults[idx];
  flushSearchCrumb();
  try { logEvent(`car-search-pick surf=aa idx=${idx} src=places label="${crumbLabel(picked?.description)}"`); } catch {}
  if (!picked) return;
  const dest = await placeDetails(picked.placeId, picked.main || picked.description).catch(() => null);
  if (!dest) { toast('Could not load that place'); return; }
  const ok = await startCarNav({ ...dest, label: dest.label || picked.description });
  if (ok) { _searchPushed = false; aaPop(); }
}

function armAaSearchBridge(lib: any): void {
  if (_aaBridgeArmed) return;
  const em = lib?.CarPlay?.emitter;
  if (!em?.addListener) return;
  _aaBridgeArmed = true;

  // PER KEYSTROKE. EventEmitter.updatedSearchText carries { searchText } and emit()
  // stamps templateId from the SCREEN's own emitter (CarPlayModule.createCarScreenContext),
  // so this can only ever be our search screen.
  em.addListener('updatedSearchText', (e: any) => {
    if (!e || e.templateId !== AA_SEARCH_ID) return;
    const seq = ++_aaSearchSeq;
    void (async () => {
      const list = await aaListFor(String(e.searchText ?? ''));
      if (seq !== _aaSearchSeq) return;   // a newer keystroke already won
      if (!_searchPushed) return;         // never update a template we no longer own
      aaCommit(list);                     // commit and draw the SAME generation
      aaPushRows(list.rows);
      if (list.meta) scheduleSearchCrumb(list.meta);   // the winner only — a lost keystroke is not a query
    })();
  });

  // ROW TAP. parseRowItem emits didSelectListItem — NOT the 'selectedResult' the
  // library's JS SearchTemplate listens for. EventEmitter.selectedResult exists in
  // Kotlin but NOTHING on Android ever calls it (grepped), which is why onItemSelect
  // could never have fired up here.
  em.addListener('didSelectListItem', (e: any) => {
    if (!e || e.templateId !== AA_SEARCH_ID) return;
    void aaSelect(String(e.id ?? ''));
  });

  // BACK — and this one is load-bearing. Verified in androidx.car.app 1.4.0-beta02:
  // CarContext's OnBackPressedDispatcher is constructed with a FALLBACK Runnable, and
  // that lambda (CarContext.lambda$new$10, disassembled) is literally
  // getCarService(ScreenManager.class).pop(). A fallback runs ONLY when no enabled
  // callback consumes the press — and CarPlayModule.setCarContext registers an
  // always-enabled callback that merely emits backButtonPressed. ScreenManager itself
  // registers no callback. So on Android Auto the host's Back NEVER pops a screen: if JS
  // does not pop, the driver is trapped on the search screen for the rest of the drive.
  em.addListener('backButtonPressed', (e: any) => {
    if (!e) return;
    if (e.templateId !== AA_SEARCH_ID) {
      // Back arrived while something else is on top => our search is provably not on
      // the stack. Self-heals a stale claim, so Search can never be permanently dead.
      _searchPushed = false;
      return;
    }
    if (!_searchPushed) return;
    _searchPushed = false;
    aaPop();
  });

  // THE OTHER STALE-CLAIM PATH, and the one that could strand a driver. Android has NO
  // visibility signal at all — CarScreen.kt emits neither didAppear nor didDisappear —
  // and AndroidAutoRoot never unmounts, so a session that ENDS with search open would
  // carry _searchPushed === true into the next session inside the same JS process. The
  // motion watcher would then fire a pop against a stack our search screen is not on.
  // The didDisconnect emit is the build-71 native patch (CarPlaySession.onDestroy); on
  // build 70 this listener is simply inert — which is why _aaSearchOnStack, not the
  // disconnect signal, is what actually keeps aaPop() honest.
  try {
    lib?.CarPlay?.registerOnDisconnect?.(() => {
      _searchPushed = false;
      // The whole screen stack dies with the session, so our screen is provably
      // gone — clearing this stops the next session's first dismiss from popping
      // the fresh nav screen.
      try { logEventReliable('aa-stack op=reset why=disconnect'); } catch {}
      _aaSearchOnStack = false;
      _aaSearchSeq += 1;
      _aaLastRowsKey = '';
    });
  } catch {}
}

function openAaSearch(): void {
  const lib = getCarLib();
  const bridge = lib?.CarPlay?.bridge;
  if (!bridge?.createTemplate || !bridge?.pushTemplate) { toast('Search unavailable'); return; }
  armAaSearchBridge(lib);
  armSearchAutoDismiss();                 // idempotent; shares _searchPushed with iOS
  _searchPushed = true;                   // claim BEFORE the await so a double tap cannot double-push
  _aaSearchSeq += 1;
  void ensureSavedPlacesLoaded().catch(() => []).then(() => {
    if (!_searchPushed) return;           // dismissed while we were loading
    const list = aaSavedList();
    aaCommit(list);
    _aaLastRowsKey = aaRowsKey(list.rows); // the create IS the first draw; do not re-push it
    try {
      // ALWAYS RE-CREATE, never reuse: createTemplate rebuilds carTemplates AND
      // constructs the CarScreen, so the id is guaranteed resolvable at push time even
      // after a previous search screen was torn down.
      //
      // ⚠ THE PUSH LIVES INSIDE THE CALLBACK, DELIBERATELY. CarPlayModule.createTemplate
      // catches an IllegalArgumentException from createScreen and registers NO screen —
      // but pushTemplate would then call getScreen -> createScreen -> the SAME throw,
      // this time inside a bare handler.post with no try/catch: an uncaught exception on
      // the car's MAIN THREAD, i.e. Android Auto dies mid-drive. The callback is invoked
      // on both branches, so gating on it costs nothing and turns a crash into a toast.
      bridge.createTemplate(AA_SEARCH_ID, aaSearchConfig(list.rows), (res: any) => {
        if (res?.error) {
          _searchPushed = false;
          try { logEvent(`aa-search-create-failed:${res.error}`); } catch {}
          toast('Search unavailable');
          return;
        }
        if (!_searchPushed) return;       // dismissed between create and push
        try {
          bridge.pushTemplate(AA_SEARCH_ID, true);
          try { logEventReliable('aa-stack op=push id=search'); } catch {}
          _aaSearchOnStack = true;          // exactly one screen; aaPop() pops exactly it
          try { logEvent('aa-search-open'); } catch {}
        } catch {
          _searchPushed = false;
          toast('Search unavailable');
        }
      });
    } catch {
      _searchPushed = false;
      toast('Search unavailable');
    }
  });
}
// Auto-dismiss search the moment the car is genuinely MOVING. CarPlay gates the
// keyboard by drive-state, so a pushed search template while driving is a dead
// modal that hides the map's own buttons — the driver is trapped and the HUD
// looks frozen (Jeff, 2026-07-24: "when i stopped the keyboard popped up and
// nothing was touchable ... none of the carplay buttons were working"). Popping
// to the map root returns every button to life. You search parked; you drive on
// the map. 2.5 m/s ≈ 9 km/h clears creep/GPS-jitter; require it sustained one tick
// so a single stationary blip can't yank a parked search away.
const _SEARCH_POP_SPEED_MS = 2.5;
let _searchMotionArmed = false;
let _movingTicks = 0;
// Pop the search template AFTER the library finishes its selected-result handshake.
// Our onItemSelect runs INSIDE the lib's handler; the lib calls the native
// reactToSelectedResult completion right after we return. Popping synchronously in
// the handler tears the template out from under that pending completion block —
// deferring one macrotask lets the handshake land on a still-live template first.
function popCarSearchDeferred(): void {
  iosStack('op=root why=selected');
  _searchPushed = false;
  _whereToPushed = false;                  // same root pop: the list is on its way out too
  setTimeout(() => { try { getLib()?.CarPlay?.popToRootTemplate?.(true); } catch {} }, 350);
}
function armSearchAutoDismiss(): void {
  if (_searchMotionArmed) return;
  _searchMotionArmed = true;
  // A disconnect ends the interface-controller stack, but these module flags survive
  // the session. Stranded true, they made the Search button dead for the whole NEXT
  // drive (the AA arm had this reset since build 71; iOS never did — until 8/19).
  try {
    getLib()?.CarPlay?.registerOnDisconnect?.(() => {
      _searchPushed = false;
      _searchPresented = false;
      _whereToPushed = false;
      _movingTicks = 0;
    });
  } catch {}
  // 🔒 NAV-LOCK begin act-search-motion-dismiss — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)
  subscribeCarState((st) => {
    // ANDROID AUTO IS EXEMPT (Jeff, 2026-09-24: "go on the fix" — Say Phin's report the same
    // morning). The AA host enforces driving restrictions itself: keyboard off while moving and
    // its own "voice only while driving" prompt with a mic, so the screen stays USABLE in motion.
    // This rule popped his search screen 0.25–2.1 s after each of three taps at 41–60 km/h
    // (`aa-stack op=pop had=1` ×3 at 14:25 UTC), before the mic could be pressed. BACK stays in
    // the AA header (aaSearchConfig headerAction) and aaPop() still runs on select, so nothing
    // can strand. iOS keeps the rule: CarPlay hides the keyboard and leaves a dead modal (8/19).
    if (Platform.OS === 'android') return;
    // OWNERSHIP or VISIBILITY — either says the template is (or may be) on the stack.
    // Ownership alone was the 8/19 trap: a wrong release left _searchPushed=false while
    // the template sat stacked, and this guard then bailed forever. _searchPresented is
    // native ground truth (didAppear), so "visible right now while moving" always pops
    // even when ownership mis-tracked. Popping when neither flag is set stays forbidden —
    // that would yank whatever else the driver is looking at.
    // BOTH FLAGS ARE THE KEYBOARD'S, and only the keyboard's (2026-09-20). The "Where to?"
    // list borrowed _searchPushed until Olaf's report and was popped by this rule too; it
    // owns _whereToPushed now, which this guard deliberately does not read. A list of saved
    // places is not a dead modal — no code below this line may reach for that flag.
    if (!_searchPushed && !_searchPresented) { _movingTicks = 0; return; }
    if ((st.speedMs || 0) > _SEARCH_POP_SPEED_MS) {
      _movingTicks += 1;
      if (_movingTicks >= 2) {                 // ~2 position ticks of real motion
        _movingTicks = 0;
        _searchPushed = false;                 // we own the pop; release before it lands
        // Platform-correct dismiss. popToRootTemplate is an iOS-only @ReactMethod —
        // CarPlayModule.kt does not expose it at all — and on Android "root" is the
        // session's placeholder screen, not our map. See dismissCarSearch().
        dismissCarSearch();
      }
    } else {
      _movingTicks = 0;
    }
  });
  // 🔒 NAV-LOCK end act-search-motion-dismiss
}
// Which list the search template is currently showing. onItemSelect gets only an
// INDEX, so without this the driver tapping "Home" would open whatever Places result
// happened to sit at index 0.
let _listMode: 'saved' | 'results' = 'saved';
let _savedShown: SavedPlace[] = [];
// Results mode, 2026-09-24: the saved place the typed query NAMED, drawn as row 0 above the
// Places rows (null when it named none) — set together with _lastResults, same generation.
let _resultsSaved: SavedPlace | null = null;

const savedPlaceIcon = (p: SavedPlace) => (p.kind === 'home' ? CAR_ICON_HOME : p.kind === 'work' ? CAR_ICON_WORK : CAR_ICON_SAVED);
// Home first, then Work, then custom places newest-first — the phone's own ordering.
function savedPlaceRows(): { text: string; detailText?: string; image: unknown }[] {
  const rank = (k: SavedPlace['kind']) => (k === 'home' ? 0 : k === 'work' ? 1 : 2);
  _savedShown = getSavedPlaces()
    .slice()
    .sort((a, b) => rank(a.kind) - rank(b.kind) || b.createdAt - a.createdAt);
  return _savedShown.map((p) => ({
    text: p.label,
    detailText: p.address || undefined,
    image: savedPlaceIcon(p),
  }));
}
function getSearchTemplate(): any | null {
  if (_searchTemplate) return _searchTemplate;
  const lib = getLib();
  if (!lib?.SearchTemplate) return null;
  try {
    _searchTemplate = new lib.SearchTemplate({
      id: 'convoy-car-search',
      // Called per keystroke; return ListItem[] to render. (CarPlay only offers
      // the keyboard while parked — an OS rule, same as Waze.)
      // EMPTY QUERY -> the driver's SAVED PLACES, so the search screen is useful the
      // moment it opens instead of an empty list behind a keyboard. Same rows and the
      // same Ionicons the phone's search screen shows (NavSearchScreen.tsx), and
      // savedPlaces is AsyncStorage-backed so this works on a COLD connect too.
      onSearch: async (query: string) => {
        const text = (query || '').trim();
        // Same rules as Android Auto's aaListFor (2026-09-24): command words stripped, the saved
        // place the text names drawn FIRST, Places rows after it (src/carSearchQuery.ts).
        const q = normalizeCarQuery(text);
        if (q.length < 2) {
          try { await ensureSavedPlacesLoaded(); } catch {}
          _listMode = 'saved';        // flipped WITH the rows, never before them (see below)
          return savedPlaceRows();
        }
        const t0 = Date.now();
        try { await ensureSavedPlacesLoaded(); } catch {}
        const match = matchSavedPlace(q, getSavedPlaces());
        let results: CarSearchResult[] = [];
        let scope: CarSearchMeta['scope'] = 'none';
        try {
          const found = await placesAutocomplete(q);
          results = found.rows;
          scope = found.scope;
        } catch {
          results = [];
        }
        // Committed TOGETHER, after the await: the mode, the saved row and the Places rows a tap
        // indexes into are ONE generation. Flipping _listMode before the await (as this did until
        // 2026-09-24, Codex) let a tap on the still-drawn saved list be read as a results-mode pick.
        _listMode = 'results';
        _lastResults = results;
        _resultsSaved = match;
        scheduleSearchCrumb({ text, norm: q, n: results.length + (match ? 1 : 0), saved: match ? 1 : 0, ms: Date.now() - t0, scope });
        return [
          ...(match ? [{ text: match.label, detailText: match.address || undefined, image: savedPlaceIcon(match) }] : []),
          ...results.map((r) => ({ text: r.description })),
        ];
      },
      onItemSelect: async ({ index }: { index: number }) => {
        // The list is EITHER saved places or Places results — index means different
        // things in each, so route on the mode the last onSearch left behind.
        if (_listMode === 'saved') {
          const p = _savedShown[index];
          flushSearchCrumb();
          try { logEvent(`car-search-pick surf=carplay idx=${index} src=saved label="${crumbLabel(p?.label)}"`); } catch {}
          if (!p) return;
          const ok = await startCarNav({ lat: p.lat, lng: p.lng, label: p.label });
          // Release ownership ONLY when we actually pop. Releasing on a FAILED start would
          // leave the template on the stack while we no longer own it — a re-tap would then
          // push a second instance, which is the stack corruption that freezes CarPlay.
          if (ok) popCarSearchDeferred();
          return;
        }
        // Results mode: row 0 is the saved place the query named, when there was one; the
        // Places rows sit below it, so their index is shifted by that one row.
        if (_resultsSaved && index === 0) {
          const p = _resultsSaved;
          flushSearchCrumb();
          try { logEvent(`car-search-pick surf=carplay idx=${index} src=saved label="${crumbLabel(p.label)}"`); } catch {}
          const ok = await startCarNav({ lat: p.lat, lng: p.lng, label: p.label });
          if (ok) popCarSearchDeferred();
          return;
        }
        const picked = _lastResults[_resultsSaved ? index - 1 : index];
        flushSearchCrumb();
        try { logEvent(`car-search-pick surf=carplay idx=${index} src=places label="${crumbLabel(picked?.description)}"`); } catch {}
        if (!picked) return;
        const dest = await placeDetails(picked.placeId, picked.main || picked.description).catch(() => null);
        if (!dest) { toast('Could not load that place'); return; }
        const ok = await startCarNav({ ...dest, label: dest.label || picked.description });
        if (ok) popCarSearchDeferred();   // same rule: release only when the pop really happens
      },
      onSearchButtonPressed: () => {},
      // ── SELF-HEALING OWNERSHIP (2026-08-19, Jeff's drive) ─────────────────────
      // The 8/14 fix released ownership in onDidDisappear whenever speed <= 2.5 m/s,
      // assuming "stationary hide = driver backed out". Jeff's drive proved the hole:
      // iOS hides the keyboard EARLY in acceleration — while still creeping under
      // 9 km/h — so the motion-hide took the release branch, the watcher's
      // `if (!_searchPushed) return` then bailed forever, and the dead template
      // re-presented at every stop for the rest of the drive (and survived ending
      // the route, because endCarNav never touched the stack — also fixed today).
      //
      // The two flags now CONVERGE instead of trapping: if the template APPEARS, it
      // is on the interface-controller stack — no heuristic involved — so didAppear
      // re-arms ownership unconditionally. A wrong release in didDisappear (creep-
      // speed motion-hide mistaken for a back-out) is healed at the very next
      // re-present, and the next motion tick pops it for good. A RIGHT release
      // (genuine back-out) never re-appears, so ownership stays released. Every
      // ordering ends correct within one stop/go cycle.
      onDidAppear: () => { _searchPresented = true; _searchPushed = true; _movingTicks = 0; },
      onDidDisappear: () => {
        // 🔒 NAV-LOCK begin act-search-hide-release — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)
        _searchPresented = false;
        _movingTicks = 0;
        // Best-guess release for a genuine stationary back-out — safe to be wrong
        // now, because didAppear self-heals the motion-hide-at-creep case above.
        try {
          if ((getCarState().speedMs || 0) <= _SEARCH_POP_SPEED_MS) _searchPushed = false;
        } catch { _searchPushed = false; }
        // 🔒 NAV-LOCK end act-search-hide-release
      },
    });
  } catch {
    _searchTemplate = null;
  }
  return _searchTemplate;
}

// ── "WHERE TO?" — saved places WITHOUT the keyboard (iOS, 2026-09-03) ─────────────
// Rodrigo: "the saved locations on CarPlay get blocked by the keyboard." CPSearchTemplate
// always raises its keyboard, and on his head unit it covers the saved rows the empty
// query lists. So the Search button now opens a plain CPListTemplate first — Home, Work,
// custom places — with one last row that pushes the keyboard template for typing. A
// driver with no saved places goes straight to the keyboard, as before. The list carries
// its OWN ownership flag (_whereToPushed, 2026-09-20 — it used to borrow _searchPushed and
// inherit the keyboard's motion pop with it): the Search-button recovery branch clears it,
// a genuine back-out releases it in onDidDisappear, and every pop-to-root clears it — the
// same double-push protection the keyboard template has, WITHOUT the motion dismiss.
// Android Auto is untouched (its native search template lists the saved rows as `items`
// already).
// Rodrigo has LOTS of saved places (Jeff, 2026-09-03) — the list scrolls, so the cap only
// guards a runaway store. CPListTemplate.maximumItemCount is 500 on iOS 14+ head units.
const WHERE_TO_MAX = 30;
function pushSearchTemplateIOS(): void {
  const t = getSearchTemplate();
  if (!t) { _whereToToSearch = false; return; }
  armSearchAutoDismiss();                    // idempotent
  iosStack('op=push id=search');
  _searchPushed = true;
  try { getLib()?.CarPlay?.pushTemplate?.(t, true); } catch { _searchPushed = false; _whereToToSearch = false; }
}
function whereToSections() {
  const rank = (k: SavedPlace['kind']) => (k === 'home' ? 0 : k === 'work' ? 1 : 2);
  _whereToShown = getSavedPlaces()
    .slice()
    .filter((p) => !!p.label)
    .sort((a, b) => rank(a.kind) - rank(b.kind) || b.createdAt - a.createdAt)
    .slice(0, WHERE_TO_MAX);
  const items: { text: string; detailText?: string; image: unknown }[] = _whereToShown.map((p) => ({
    text: p.label,
    detailText: p.address || undefined,
    image: p.kind === 'home' ? CAR_ICON_HOME : p.kind === 'work' ? CAR_ICON_WORK : CAR_ICON_SAVED,
  }));
  // ONE section on purpose: onItemSelect hands back a single index, and one section keeps
  // that index unambiguous. The keyboard row is FIRST (Jeff, 2026-09-03: "the keyboard is
  // hidden when tapping Search and you invoke it to type") — one tap away however long the
  // saved list is, and the saved places read on from row two.
  items.unshift({ text: 'Type a place…', detailText: 'Opens the keyboard (while parked)', image: CAR_ICON_BLANK });
  return [{ items }];
}
function getWhereToTemplate(): any | null {
  const lib = getLib();
  if (!lib?.ListTemplate) return null;
  const sections = whereToSections();
  if (_whereTo) {
    // ONE instance for the session (like _searchTemplate): a second `new ListTemplate` with
    // the same id would leave the first instance's listeners alive and fire both.
    try { _whereTo.updateSections(sections); } catch {}
    return _whereTo;
  }
  try {
    _whereTo = new lib.ListTemplate({
      id: 'convoy-car-whereto',
      title: 'Where to?',
      sections,
      onItemSelect: async ({ index }: { index: number }) => {
        if (index === 0) {
          _whereToToSearch = true;          // about to be COVERED by the keyboard template — not a back-out
          pushSearchTemplateIOS();
          return;
        }
        const p = _whereToShown[index - 1]; // row 0 is the keyboard row
        try { logEvent(`car-search-pick surf=carplay idx=${index - 1} src=saved label="${crumbLabel(p?.label)}"`); } catch {}
        if (!p) return;
        const ok = await startCarNav({ lat: p.lat, lng: p.lng, label: p.label });
        if (ok) popCarSearchDeferred();     // release + pop to root only when the pop really happens
      },
      // didAppear is native ground truth that the list is on the stack — the same
      // self-healing re-arm the keyboard template does, so a wrong release below is
      // healed at the next re-present. It no longer zeroes _movingTicks: that counter
      // belongs to the keyboard's motion rule, and the watcher zeroes it itself on every
      // tick where neither keyboard flag is set (which is exactly list-only).
      onDidAppear: () => { _whereToPushed = true; },
      onDidDisappear: () => {
        if (_whereToToSearch) { _whereToToSearch = false; return; }
        // Genuine back-out, or a pop that took the whole stack: release ownership unless
        // the keyboard template is the thing on screen — then the list is merely COVERED
        // and is still stacked underneath it.
        if (!_searchPresented) _whereToPushed = false;
      },
    });
  } catch {
    _whereTo = null;
  }
  return _whereTo;
}
function openWhereToIOS(): void {
  const t = getWhereToTemplate();
  if (!t || _whereToShown.length === 0) { pushSearchTemplateIOS(); return; }
  // Still armed here even though the list has no motion pop of its own: this is what
  // registers the disconnect reset that clears _whereToPushed between sessions, and the
  // driver's very next tap can be the keyboard row.
  armSearchAutoDismiss();                    // idempotent
  iosStack('op=push id=whereto');
  _whereToPushed = true;                     // claim BEFORE the push so a double tap cannot double-push
  try { getLib()?.CarPlay?.pushTemplate?.(t, true); } catch { _whereToPushed = false; }
}

// ── nav-bar buttons shared by BOTH map roots (cold idle + warm) ─────────────
// automaticallyHidesNavigationBar:false keeps them visible; text buttons need
// no image assets on the head unit.
export const CAR_BAR_BUTTON_CONFIG = {
  automaticallyHidesNavigationBar: false,
  // TOP-LEFT: the ZOOM PAIR (Jeff, 2026-08-15: "zoom -/+ buttons in the top left
  // corner" — minus LEFT, plus RIGHT, his stated order). Leading buttons render in
  // array order left-to-right — unlike the trailing array below, which is reversed.
  // CarPlay allows two leading bar buttons; the pair uses both. The comms mic and the
  // 2D/3D toggle that used to live here moved to the round map-button column (see
  // CAR_MAP_BUTTON_CONFIG). Their presses route through handleCarBarButton's
  // cross-side dispatch, so a stale cached template delivering the OLD layout's ids
  // from either side still lands on the right action.
  // The pill WIDTH around each glyph is CarPlay's own bar-button chrome (iOS 26
  // Liquid Glass) — we control only the artwork, and these zoom glyphs are compact
  // centred bars on the shared 44pt canvas, the narrowest art we have.
  leadingNavigationBarButtons: [
    { id: 'car-zoom-out', type: 'image' as const, image: CAR_ICON_ZOOM_OUT },
    { id: 'car-zoom-in', type: 'image' as const, image: CAR_ICON_ZOOM_IN },
  ],
  // TOP-RIGHT: Search then End at the far corner. NOTE the array is REVERSED vs
  // the visual order — head-unit photo evidence: config [search, end] rendered as
  // "End Search" left-to-right, so array[0] lands RIGHT-most.
  trailingNavigationBarButtons: [
    { id: 'car-end', type: 'text' as const, title: 'End', buttonStyle: 'rounded' as const },
    { id: 'car-search', type: 'text' as const, title: 'Search', buttonStyle: 'rounded' as const },
  ],
};

// ── Round CPMapButtons — POLICE + SCOUT MIC, in OUR artwork ──────────────────
// SHARED BY BOTH ROOTS (cold idle + warm). They used to declare different button
// sets with different ids, which is how "the mic works but the others don't"
// bugs kept appearing — one source of truth now.
//
// 2026-07-20 changes:
//  • Zoom ± REMOVED. They occupied two of the (max 4) map-button slots on the
//    right edge, crowding our own nav stack, and the head unit reported them as
//    doing nothing. Pinch-to-zoom still works via the CPMapTemplate zoom gesture
//    (onDidBegin/Update/EndZoomGesture -> the gesture bus), which is unaffected.
//  • Police PROMOTED from the nav bar to a round map button (one-tap driving
//    action), and both glyphs are now OUR OWN artwork instead of SF Symbols.
//
// The `systemImage` key (our build-65 native patch) is deliberately NOT used
// here: it takes precedence over `image` in RCTConvert+RNCarPlay.m, so leaving it
// in would mask our art. See carButtonIcons.ts for why a data URI is bridge-free
// and OTA-able.
// ORDER (Jeff, 2026-09-24): "On both surfaces let's do this order: Right side Top - mic, Second from top - hazards,
// Second from bottom - 2D/3D, Bottom - crew." CarPlay's panning mode hides map buttons from the END of the array, so
// 2D/3D and crew are the pair that vanishes while panning and the mic + hazards always survive. The phone's FAB stack
// (map.tsx) mirrors this column with the compass in the mic's slot. Same order in carMapButtonConfig() below.
export const CAR_MAP_BUTTON_CONFIG = {
  // SPACERS REMOVED FOR GOOD (2026-07-23, second head-unit confirmation): iOS 26
  // draws its glass circle behind ANY CPMapButton — transparent image AND
  // hidden:true both failed on the real unit (hidden was also a no-op on the 18.6
  // sim). The 4-slot trick is dead on iOS 26. Crew + compass now live in the two
  // bottom-trailing slots CarPlay gives a 2-button array, and the banner stack sits
  // BESIDE the column (CAR_RIGHT_INSET) instead of underneath phantom circles.
  // 2026-08-15 (Jeff): comms mic takes the old zoom-in slot, 2D/3D takes zoom-out's;
  // zoom itself moved to the top-left nav bar. Moving car-view here is also what made
  // the 2D/3D toggle WORK for the first time: as a bar button its presses went to
  // handleCarBarButton, which never had a car-view branch — the tap logged a receipt
  // and did nothing. Map-button presses go to handleCarMapButton, which owns the
  // toggle.
  // ⚠ COMMS + VIEW FIRST, DELIBERATELY. CPMapTemplate.h on the panning interface: "a
  // maximum of two mapButtons will be visible... the system will hide one or more map
  // buttons BEGINNING FROM THE END of the mapButtons array." So crew/compass are the
  // pair that disappear in panning mode; zoom survives regardless, in the nav bar
  // (automaticallyHidesNavigationBar is false above).
  // Max is 4 (CPMapTemplate.h:72). This uses all four.
  // HAZARDS REPLACED THE COMPASS (Jeff, 2026-09-24: "build the hazard panel with the apple glyphs i mentioned"): the
  // fourth slot opens the Report grid (src/carplay/hazardPanel.ts) and the compass rides inside it as a tile.
  mapButtons: [
    { id: 'car-comms', image: CAR_ICON_MIC, focusedImage: CAR_ICON_MIC },
    { id: HAZARD_BUTTON_ID, image: CAR_ICON_HAZARDS, focusedImage: CAR_ICON_HAZARDS },
    { id: 'car-view', image: CAR_ICON_VIEW_2D, focusedImage: CAR_ICON_VIEW_2D },
    { id: 'car-crew', image: CAR_ICON_CREW, focusedImage: CAR_ICON_CREW },
  ],
};

// WHICH GLYPH THE VIEW BUTTON WAS BUILT WITH — one row per distinct answer per JS context, at most 6. It settles an open
// question (review, 2026-09-23 — HYPOTHESIS, not measured): on a car-first cold launch, is the template built before
// settings / the garage hydrate? isMapView2DLocked would then read the defaults (selfMarkerType unset → 'car' →
// unlocked) and a Free / Silver driver would see the 2D glyph for that whole connect: marker=unset on a driver whose
// Garage car is a class or an arrow is exactly that. No personal data: the marker type and the arrow pick.
const _viewGlyphRows = new Set<string>();
function viewGlyphReceipt(surf: 'cp' | 'aa', glyph: 'view3d' | 'view2d'): void {
  try {
    const row = `car-view-glyph surf=${surf} glyph=${glyph} marker=${getSettings().selfMarkerType ?? 'unset'} pick=${getGarage().arrowPick ?? 'unset'}`;
    if (_viewGlyphRows.has(row) || _viewGlyphRows.size >= 6) return;
    _viewGlyphRows.add(row);
    logEvent(row);
  } catch {}
}

// SKIN-AWARE map buttons (2026-08-28). Same array, same order, same ids — only the
// metal changes. The comms mic is deliberately NOT skinned: it is already chrome and
// is a COMMS affordance, not a tier surface.
//
// ⚠ RESOLVED AT TEMPLATE-BUILD TIME, i.e. on CarPlay CONNECT. The MapTemplate is
// constructed inside the connect/disconnect lifecycle effect in ConvoyCarPlay.tsx, so
// changing the skin mid-drive does NOT restyle the buttons — it takes effect on the
// next connect. That is deliberate: rebuilding the root template to recolour a button
// means setRootTemplate/popToTemplate churn while someone is driving, and this repo
// has already had a template pop EVICT the driver to the app drawer (2026-08-19).
// A button that wears last drive's metal for one trip is not worth that risk.
//
// appSkinNow() (not the hook) because this is module-scope, called outside React.
// THE 3D TEASE (Jeff, 2026-09-23): a driver whose car keeps the map 2D (Free's arrow, Silver's class car —
// mapViewMode.isMapView2DLocked) sees the 3D glyph on this button, and the tap answers "Upgrade to Gold for 3D" (handleCarMapButton).
// Resolved here, i.e. at template build like the skin above: a Garage change mid-session shows on the next connect
// (nothing in src calls updateMapButtons; the TAP is read live, so it always does the right thing — only the glyph can
// be a connect old). viewGlyphReceipt records what the button was built with.
export function carMapButtonConfig() {
  const s = appSkinNow();
  const viewGlyph = isMapView2DLocked() ? 'view3d' : 'view2d';
  viewGlyphReceipt('cp', viewGlyph);
  return {
    ...CAR_MAP_BUTTON_CONFIG,
    mapButtons: [
      { id: 'car-comms', image: CAR_ICON_MIC, focusedImage: CAR_ICON_MIC },
      { id: HAZARD_BUTTON_ID, image: carIcon(HAZARD_BUTTON_GLYPH, s), focusedImage: carIcon(HAZARD_BUTTON_GLYPH, s) },
      { id: 'car-view', image: carIcon(viewGlyph, s), focusedImage: carIcon(viewGlyph, s) },
      { id: 'car-crew', image: carIcon('crew', s), focusedImage: carIcon('crew', s) },
    ],
  };
}

// ── ANDROID AUTO BUTTONS (2026-07-30) ────────────────────────────────────────
// Jeff: "next on the list is getting the touch buttons on AA like CarPlay."
//
// AA had NO buttons at all, for two reasons that both had to be fixed:
//
//  1. WE SENT iOS-ONLY KEYS. androidx reads `actions` (-> ActionStrip, the button
//     row) and `mapButtons` (-> MapActionStrip via MapController). We were sending
//     leadingNavigationBarButtons / trailingNavigationBarButtons, which Android
//     never looks at — and our mapButtons entries used the iOS `image` key, while
//     RCTTemplate.parseAction reads `icon`. An Action with neither a title nor an
//     icon is an IllegalStateException in androidx, so sending the iOS shape was
//     at best ignored and at worst fatal to the screen. Android now gets ONLY the
//     Android-shaped keys.
//  2. THE PRESS HAD NOWHERE TO LAND. parseAction wires
//     setOnClickListener { eventEmitter.buttonPressed(id) }, but MapTemplate's JS
//     eventMap had no `buttonPressed` entry, so every press was dropped before it
//     reached a handler. Fixed in the react-native-carplay patch (src/, so OTA-able)
//     — the same omission that once made pinch-to-zoom dead.
//
// SAME IDS as CarPlay on purpose: the existing handlers below take them unchanged,
// so the two car surfaces cannot drift apart in behaviour.
//
// androidx caps each strip at 4 and requires every Action to carry a title or an
// icon. Our glyphs are data URIs (see carButtonIcons.ts), which Fresco decodes
// through ImageSource just as [RCTConvert UIImage:] does on iOS — one artwork set,
// both platforms.
// ── WHY 'persistent' (2026-07-31) ────────────────────────────────────────────
// Jeff, off Say Phin's 07:48 photo: "where is his crew button and compass?" They
// were rendering fine — his OWN tap receipts at 07:36, twelve minutes earlier,
// show car-crew / car-compass / car-search all reaching JS from platform=android.
// By 07:48 the strips had FADED OUT: androidx dims and removes an ActionStrip
// during navigation once the driver stops interacting, and Action.FLAG_IS_PERSISTENT
// is the documented opt-out ("this action will not fade in/out inside an
// ActionStrip"). react-native-carplay exposes it as visibility: 'persistent'
// (RCTTemplate.parseAction).
//
// Verified safe before shipping, because a template that fails to build is the
// androidx "unexpected error" card and there is no way to test that locally:
// FLAG_IS_PERSISTENT appears in exactly ONE class across androidx.car.app 1.4.0
// (Action.class) — no ActionsConstraints validator inspects it, so it cannot throw
// the way an over-long strip or an icon-less action can. A host that ignores the
// flag simply behaves as it does today; there is no downside case.
const AA_PERSISTENT = 'persistent' as const;
// ⚠ ANDROID AUTO RENDERS THIS STRIP RIGHT-ALIGNED, so array order reads RIGHT-TO-LEFT
// on the head unit — the mirror image of CarPlay's leading bar, where array[0] is
// leftmost. Say Phin's video, 2026-08-14: "comms button on right side should be left
// corner." With `car-comms` first it landed at the far RIGHT. Reversed so comms sits at
// the LEFT end of the strip, matching CarPlay, where it has always been the leading
// button. Same ids, same handlers — order only.
export const AA_ACTION_STRIP = [
  { id: 'car-end', title: 'End', visibility: AA_PERSISTENT },
  { id: 'car-search', title: 'Search', visibility: AA_PERSISTENT },
  { id: 'car-view', icon: CAR_ICON_VIEW_2D, visibility: AA_PERSISTENT },
  { id: 'car-comms', icon: CAR_ICON_MIC, visibility: AA_PERSISTENT },
];

// ── "ALLOW LOCATION" FROM THE CAR (build 79, 2026-09-14) ─────────────────────────────────────
// While the car has no location permission and can ask for it (CarContext.requestPermissions via
// the patched CarPlayModule.requestPermissions — build 79), the 2D/3D slot becomes a TITLED
// "Allow location" action. The driver taps it on the car, reads "When safe, check your phone" on
// the car screen (car app quality VI-1), and the system dialog opens on the phone.
//   - An ActionStrip SWAP through AndroidAutoRoot's existing updateTemplate path, never a push or
//     pop (memory aa-poptotemplate-evicts-driver).
//   - androidx ACTIONS_CONSTRAINTS_NAVIGATION allows 4 actions and 4 custom titles (javap of
//     androidx.car.app 1.4.0-beta02, verified by the build-79 review) — End + Search + this = 3.
//   - 'car-view' is the swapped slot because 2D/3D means nothing without a position to draw.
//     A workstream that reorders or renames the strip must keep that id or update this.
//   - INERT on build 78: RNCarPlay.requestPermissions does not exist there, so canRequestFromCar()
//     is false and the stock strip is returned.
export const AA_ALLOW_LOCATION_ID = 'car-allow-location';
// THE 3D TEASE (Jeff, 2026-09-23) on Android Auto too: with a 2D-locked car (isMapView2DLocked) the view slot wears the
// 3D glyph — the same brand-metal art CarPlay's unskinned map button uses (AA_ACTION_STRIP is unskinned) — and the tap
// answers "Upgrade to Gold for 3D". Re-read ONLY where AndroidAutoRoot rebuilds the strip (connect, route start / end, the
// askable flip) — its updateTemplate effect does not yet re-run on a Garage change, so a mid-session car swap shows its
// glyph at the next of those. "Allow location" still wins the slot while it applies.
export function aaActionStrip(): (typeof AA_ACTION_STRIP)[number][] {
  if (!isAskableStatus(getCarState().carStatus) || !canRequestFromCar()) {
    const locked = isMapView2DLocked();
    viewGlyphReceipt('aa', locked ? 'view3d' : 'view2d');
    if (!locked) return AA_ACTION_STRIP;
    return AA_ACTION_STRIP.map((a) => (a.id === 'car-view' ? { id: a.id, icon: CAR_ICON_VIEW_3D, visibility: AA_PERSISTENT } : a));
  }
  return AA_ACTION_STRIP.map((a) => (a.id === 'car-view'
    ? { id: AA_ALLOW_LOCATION_ID, title: CAR_ALLOW_LOCATION_TITLE, visibility: AA_PERSISTENT }
    : a));
}
// androidx ACTIONS_CONSTRAINTS_MAP: max 4, ICON ONLY (no titles accepted). Same order
// rationale as CarPlay above. Note the key is `icon` here and `image` on iOS — they are
// NOT interchangeable; parseAction reads map.getMap("icon").
export const AA_MAP_BUTTONS = [
  { id: 'car-zoom-in', icon: CAR_ICON_ZOOM_IN, visibility: AA_PERSISTENT },
  { id: 'car-zoom-out', icon: CAR_ICON_ZOOM_OUT, visibility: AA_PERSISTENT },
  { id: HAZARD_BUTTON_ID, icon: CAR_ICON_HAZARDS, visibility: AA_PERSISTENT },
  { id: 'car-crew', icon: CAR_ICON_CREW, visibility: AA_PERSISTENT },
];

// The AA twin. ⚠ Currently a NO-OP visually: androidx tints MapActionStrip icons to a
// flat white silhouette, and the CarIcon tint override is a native patch that has never
// landed (grep patches/ — nothing). Wired now so AA inherits the metal the moment that
// patch ships, rather than needing a second pass then.
export function aaMapButtons() {
  const s = appSkinNow();
  return [
    { id: 'car-zoom-in', icon: CAR_ICON_ZOOM_IN, visibility: AA_PERSISTENT },
    { id: 'car-zoom-out', icon: CAR_ICON_ZOOM_OUT, visibility: AA_PERSISTENT },
    { id: HAZARD_BUTTON_ID, icon: carIcon(HAZARD_BUTTON_GLYPH, s), visibility: AA_PERSISTENT },
    { id: 'car-crew', icon: carIcon('crew', s), visibility: AA_PERSISTENT },
  ];
}

// One dispatcher for an Android Auto press. The ids are shared with CarPlay, so this
// just picks whichever existing handler owns each id — no duplicated behaviour.
export function handleAaButton(id?: string): void {
  if (!id) return;
  // ⚠ EXPLICIT ALLOWLIST, not a car-* wildcard. Miss an id here and the AA button
  // renders, taps, logs a receipt — and does nothing, while CarPlay works fine.
  if (id === 'car-crew' || id === 'car-compass' || id === 'car-mic' || id === HAZARD_BUTTON_ID
      || id === 'car-zoom-in' || id === 'car-zoom-out') { handleCarMapButton(id); return; }
  handleCarBarButton(id);
}

// Map-button handler for the COLD root (no phone app in the foreground). The warm
// root intercepts these same ids first and routes them to its live refs; anything
// it does not claim falls through to here, so the two roots behave identically.
// Every CarPlay press logs a receipt (screen + crash_reports). See logEvent's
// comment: this is what splits "the tap never reached JS" from "the tap reached JS
// and the action did nothing" — the fork that three rounds of code-reading could
// not settle for the recurring dead-buttons report.
const TAP_LABEL: Record<string, string> = {
  'car-crew': 'Crew', 'car-compass': 'Compass', 'car-comms': 'Comms', 'car-view': 'View',
  'car-mic': 'Scout', 'car-search': 'Search', 'car-end': 'End',
  'car-zoom-in': 'Zoom in', 'car-zoom-out': 'Zoom out',
  [AA_ALLOW_LOCATION_ID]: CAR_ALLOW_LOCATION_TITLE,
};
export function carTap(id: string): void {
  if (!id) return;
  try { logEvent(`carplay-tap:${id}`); } catch {}
  try {
    setCarState({
      // Visible receipt in the same non-blocking slot. Jeff can now tell the two
      // failure modes apart AT A GLANCE mid-drive, without waiting on a query:
      // pill appears but nothing happens = the action is broken (our JS, OTA-able);
      // pill never appears = the press never reached JS at all (native template
      // layer, needs a build). Any real message from the action overwrites this
      // a moment later, which is the correct ordering.
      carToast: `${TAP_LABEL[id] || hazardTapLabel(id) || id} ✓`,
      carToastUntil: Date.now() + 1600,
    });
  } catch {}
  // Any press is a moment the driver is looking at the car screen — re-check what it should say
  // (build 79; throttled inside carStatus, and a no-op while no car session is live).
  void refreshCarStatus('tap');
}

// ── DOUBLE-DISPATCH DEDUPE (2026-08-26, telemetry-proven) ──────────────────────
// Rodrigo's head unit delivers every map-button press TWICE, 0.5-11 ms apart
// (paired carplay-tap rows for crew, compass, zoom-out, end, search — while other
// testers log singles). A doubled compass toggles north-up ON then OFF within 4 ms
// and reads as a dead button; a doubled crew runs the fit twice. The double is two
// live listeners for one native press (warm root + cold root is the leading
// suspect — the `src` tag on the crumb below settles it from his next drive).
// Whatever the emitter count, one PHYSICAL press cannot arrive twice inside 250 ms
// of itself, so collapse them here at the single funnel both roots call.
let _lastTapId = "";
let _lastTapAt = 0;
// 50 ms, not 250 (review, 2026-08-26): the measured hardware doubles are 0.5-18 ms,
// and 250 ate DELIBERATE rapid same-button presses — three quick zoom taps became
// two, silently (the drop skips the toast receipt too). 50 is ~3x the worst
// measured double and far below any intentional repeat-press cadence.
const TAP_DEDUPE_MS = 50;

/** One press cannot physically arrive twice inside the window. TRUE = duplicate —
 *  callers drop the press. Exported so the warm root's car-end/car-mic intercepts
 *  (which return before these funnels) share the same stamp instead of staying
 *  doubled (review, 2026-08-26 — END and MIC are two of the ids that measured
 *  doubled in the field). */
export function isDupCarPress(id: string, src = "?"): boolean {
  const now = Date.now();
  if (id === _lastTapId && now - _lastTapAt < TAP_DEDUPE_MS) {
    try { logEvent(`carplay-tap-deduped:${id} src=${src} dt=${now - _lastTapAt}`); } catch {}
    return true;
  }
  _lastTapId = id; _lastTapAt = now;
  return false;
}

export function handleCarMapButton(id: string, src = "?"): void {
  if (isDupCarPress(id, src)) return;
  carTap(id);
  // Comms mic moved into the round map-button column (2026-08-15). Same behaviour it
  // had as a bar button — tap-to-toggle transmit — kept inline rather than delegated
  // to handleCarBarButton, which would log a second tap receipt for one press.
  if (id === 'car-comms') {
    armPosRing();
    void toggleCarComms().then((msg) => { if (msg) toast(msg); });
    return;
  }
  // 🔒 NAV-LOCK begin act-view-2d-when-idle — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)
  if (id === 'car-view') {
    // THE 3D TEASE (Jeff, 2026-09-23: "on the free/silver 2d maps can we change the 2d button to 3d to entice the free
    // silver users to see 3d and when they tap it it says upgrade to gold?"). Free's arrow and Silver's class car keep
    // the map 2D (mapViewMode.isMapView2DLocked), so for them this button wears the 3D glyph (carMapButtonConfig /
    // aaActionStrip) and a tap answers with the upgrade instead of a view change — idle or routing alike. The words are
    // Jeff's own ("it says upgrade to gold") and FIT Android Auto's one-line status pill: 'Upgrade to Gold for 3D' is
    // ~144 dp at 14 pt bold (Roboto, unhinted advances) against the ~155 dp of text a 213 dp head unit leaves; the first
    // wording, '3D map is Gold — upgrade in the Garage' (~252 dp), was cut to "3D map is Gold — upgra…" (review).
    if (isMapView2DLocked()) {
      toast('Upgrade to Gold for 3D');
      return;
    }
    // Pure VIEW toggle — routing, the route line and guidance are all untouched.
    // 8/18 rule: 3D exists only while ROUTING. Idle press pins 2D instead of
    // toggling, so the car can never sit in an idle 3D view.
    if (!getCarState().navigating) {
      setMapView2D(true);
      toast('2D view');
      return;
    }
    const twoD = toggleMapView2D();
    toast(twoD ? '2D view' : '3D view');
    return;
  }
  // 🔒 NAV-LOCK end act-view-2d-when-idle
  if (id === 'car-crew') { emitCarGesture({ kind: 'crewFit' }); return; }
  if (id === 'car-compass') { emitCarGesture({ kind: 'compass' }); return; }
  if (id === HAZARD_BUTTON_ID) { openHazardPanel(); return; }
  // One zoom level per tap — CarMapView applies it through the same applyZoomNow the
  // tap-zoom gesture uses, so a PARKED car responds (no camera ease is armed when
  // stationary, which is what made build 65's zoom buttons look dead).
  // ── STEP SIZE (Jeff, 2026-08-14: "i also want to add more zoom increments") ──
  // Was a FULL zoom level per tap — one press roughly halved or doubled the ground
  // covered, which is why it read as coarse rather than premium. 0.5 gives twice as many
  // stops across the same range, so the driver can actually settle on a framing.
  // CAR_USER_ZOOM_BIAS_LIMIT (4 levels) is unchanged, so the range is the same — there
  // are simply more steps inside it, and each one now LANDS immediately (zoomSnapRef)
  // instead of crawling behind the slow automatic-framing filter.
  // 🔒 NAV-LOCK begin act-zoom-step — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)
  if (id === 'car-zoom-in') { emitCarGesture({ kind: 'zoomStep', delta: 0.5 }); return; }
  if (id === 'car-zoom-out') { emitCarGesture({ kind: 'zoomStep', delta: -0.5 }); return; }
  // 🔒 NAV-LOCK end act-zoom-step
  // Stale-template tolerance: an older cached template can still deliver these.
  if (id === 'car-police') { armPosRing(); void reportPoliceFromCar(); return; }
  if (id === 'car-mic') { emitCarGesture({ kind: 'scoutMic' }); return; }
}

export function handleCarBarButton(id: string, src = "?"): void {
  // CROSS-SIDE DISPATCH (2026-08-15 layout swap): zoom is now a nav-bar pair but its
  // action lives in handleCarMapButton; car-view can still arrive from a stale cached
  // template that has it in its OLD bar slot. Route before carTap — the map handler
  // logs its own receipt, and double-logging would corrupt the tap telemetry.
  if (id === 'car-zoom-in' || id === 'car-zoom-out' || id === 'car-view') {
    handleCarMapButton(id, src);
    return;
  }
  // Same physical-press dedupe as the map buttons (his end/search doubled too).
  if (isDupCarPress(id, src)) return;
  carTap(id);
  armPosRing(); // idempotent — make sure the 5s-ago buffer is running
  if (id === AA_ALLOW_LOCATION_ID) { void requestLocationFromCar('tap'); return; }
  if (id === 'car-comms') {
    void toggleCarComms().then((msg) => { if (msg) toast(msg); });
    return;
  }
  // 'car-police' is no longer a NAV-BAR button (it moved to a round map button in
  // CAR_MAP_BUTTON_CONFIG), but keep the branch: an older cached template on a
  // head unit can still deliver it, and dropping it would silently no-op.
  if (id === 'car-police') { void reportPoliceFromCar(); return; }
  if (id === 'car-end') { void endCarNav(); return; }
  if (id === 'car-search') {
    // Already on the stack? NEVER push a second instance (that corrupts the CarPlay
    // stack — the freeze). But a plain `return` made the Search button permanently
    // dead whenever the flag was stranded true. Recovery instead: pop to root (clears
    // a stuck/hidden search template), release ownership, and let the driver's NEXT
    // tap open it fresh. One tap heals, two taps searches — never a double push.
    if (_searchPushed || (Platform.OS !== 'android' && (_searchPresented || _whereToPushed))) {
      // RECOVERY, and it MUST actually dismiss on both platforms.
      // ⚠ REGRESSION I SHIPPED THIS MORNING (found in Say Phin's 6:06 PM
      // telemetry): this branch cleared the ownership flag but only popped on
      // iOS, so on Android Auto the search screen stayed on the stack with
      // nobody owning it — and the NEXT tap sailed past the guard and pushed a
      // SECOND search screen on top of the first. His receipts show
      // aa-search-open three times in six seconds, which is three stacked
      // search screens and exactly why Back could not get him home.
      _searchPushed = false;
      // Clear visibility too (review find F4): if didDisappear was lost and the
      // template is NOT actually stacked, the pop below no-ops and nothing else
      // would ever clear the flag — every future tap would re-enter this branch
      // and Search would be dead for good, the exact bug class this fixes.
      iosStack('op=recover');
      _searchPresented = false;
      // Same F4 rule for the "Where to?" list: dismissCarSearch clears it too, but clear
      // it here as well so a stranded list flag can never survive a pop that no-ops.
      _whereToPushed = false;
      dismissCarSearch();   // iOS: pop to root · Android: single pop to the nav screen
      return;
    }
    // ANDROID AUTO LEAVES HERE. Its native SearchTemplate takes results as an `items`
    // PROP, not from a callback, and the library's JS SearchTemplate only talks to
    // native on iOS — so Android drives createTemplate / pushTemplate / updateTemplate
    // itself. Everything below this line is the untouched iOS path.
    if (Platform.OS === 'android') { openAaSearch(); return; }
    // Prime the cache BEFORE the template appears — the first updatedSearchText can
    // arrive before an await would have resolved.
    void ensureSavedPlacesLoaded().catch(() => {});
    // Saved places FIRST, keyboard second (2026-09-03, Rodrigo) — see getWhereToTemplate.
    openWhereToIOS();
  }
}

// Arm the position ring at module load (cheap; subscription only buffers).
armPosRing();
