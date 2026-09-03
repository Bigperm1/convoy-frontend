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
import { getSettings } from '../settings';
import { fetchRoutes, type NavRoute } from '../nav';
import { startNavBanner, stopNavBanner, CAR_NAV_KEY } from '../navNotification';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import { getCarState, setCarState, setCarHazards, subscribeCarState, emitCarGesture } from './carStore';
import { toggleMapView2D, setMapView2D } from '../mapViewMode';
import { getDepartureBearing, orderRoutesForward, routeInitialBearing } from '../departureBearing';
import { CAR_ICON_MIC, CAR_ICON_CREW, CAR_ICON_COMPASS, CAR_ICON_ZOOM_IN, CAR_ICON_ZOOM_OUT, CAR_ICON_HOME, CAR_ICON_WORK, CAR_ICON_SAVED, CAR_ICON_BLANK, CAR_ICON_VIEW_2D, carIcon } from './carButtonIcons';
import { appSkinNow } from '../appSkin';
import { toggleCarComms } from './carComms';
import { logEvent } from '../crashBreadcrumb';
import { ensureSavedPlacesLoaded, getSavedPlaces, type SavedPlace } from '../savedPlaces';

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
export async function reportPoliceFromCar(): Promise<void> {
  if (_reportInFlight) return; // debounce a double-tap while the POST runs
  const pos = pos5SecAgo();
  if (!pos) { toast('No GPS fix yet'); return; }
  _reportInFlight = true;
  try {
    const { data } = await api.post('/hazards', { kind: 'police', lat: pos.lat, lng: pos.lng, note: '' });
    // Optimistic pin on the car map (same id-dedupe the phone applies). Goes
    // through the 'service' gate — if the phone mirror is live it will echo the
    // same hazard via WS within a beat anyway.
    if (data && data.id) {
      const cur = getCarState().hazards || [];
      if (!cur.some((h) => h.id === data.id)) {
        setCarHazards([{ id: data.id, kind: data.kind || 'police', lat: data.lat, lng: data.lng, confirms: data.confirms, disputes: data.disputes }, ...cur], 'service');
      }
    }
    toast('Police reported ✓');
  } catch {
    toast('Report failed — no connection');
  } finally {
    _reportInFlight = false;
  }
}

// ── destination search (Google Places API v1 — the New API; the legacy
//    place/* endpoints REQUEST_DENIED on this key) ──────────────────────────
type CarSearchResult = { placeId: string; description: string };
let _lastResults: CarSearchResult[] = [];

async function placesAutocomplete(input: string): Promise<CarSearchResult[]> {
  const s = getCarState();
  const body: any = { input };
  if (typeof s.selfLat === 'number' && typeof s.selfLng === 'number') {
    body.locationBias = { circle: { center: { latitude: s.selfLat, longitude: s.selfLng }, radius: 50000.0 } };
  }
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_MAPS_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return (data.suggestions || [])
    .filter((x: any) => x.placePrediction)
    .slice(0, 8)
    .map((x: any) => ({ placeId: x.placePrediction.placeId, description: x.placePrediction.text?.text ?? '' }))
    .filter((x: CarSearchResult) => x.placeId && x.description);
}

async function placeDetails(placeId: string): Promise<{ lat: number; lng: number; label?: string } | null> {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { 'X-Goog-Api-Key': GOOGLE_MAPS_KEY, 'X-Goog-FieldMask': 'location,displayName,formattedAddress' },
  });
  const data = await res.json();
  if (typeof data?.location?.latitude !== 'number') return null;
  return { lat: data.location.latitude, lng: data.location.longitude, label: data.displayName?.text || data.formattedAddress || undefined };
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
  if (_navStartInFlight) return false;
  const s = getCarState();
  if (typeof s.selfLat !== 'number' || typeof s.selfLng !== 'number') { toast('No GPS fix yet'); return false; }
  _navStartInFlight = true;
  try {
    const st = getSettings();
    const routes = await fetchRoutes(
      { lat: s.selfLat, lng: s.selfLng },
      { lat: dest.lat, lng: dest.lng },
      { tolls: st.avoidTolls, highways: st.avoidHighways, ferries: st.avoidFerries },
    );
    if (!routes.length) { toast('No route found'); return false; }
    // FOUR-SURFACE PARITY (2026-07-30). This is the route start for a search made on
    // CarPlay AND on Android Auto, and it used to sort on ETA alone while the phone
    // had already learned to prefer a route that departs the way the car is pointing.
    // Same destination, same car, but a U-turn from the head unit and not from the
    // phone. One shared ranker now, so they cannot drift apart again — see
    // src/departureBearing.ts for why the Directions `bearings` parameter is NOT the
    // fix. Falls back to plain fastest-first when the facing is unknown.
    const facing = await getDepartureBearing();
    const ordered = orderRoutesForward(routes, facing ?? undefined);
    // Same depart-rank crumb as the phone (map.tsx) — src=car marks the CarPlay path.
    try {
      const _b0 = routeInitialBearing(ordered[0] as any);
      const _off = (typeof facing === 'number' && _b0 != null)
        ? Math.round(Math.abs(((_b0 - facing + 540) % 360) - 180)) : -1;
      logEvent(`depart-rank src=car n=${routes.length} facing=${typeof facing === 'number' ? Math.round(facing) : 'null'} chosenBr=${_b0 != null ? Math.round(_b0) : 'null'} off=${_off}`);
    } catch {}
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
    toast(dest.label ? `Routing to ${dest.label}` : 'Route started');
    return true;
  } catch {
    toast('Routing failed');
    return false;
  } finally {
    _navStartInFlight = false;
  }
}

export async function endCarNav(): Promise<void> {
  if (!getCarState().navigating) { toast('No active route'); return; }
  try { await stopNavBanner(); } catch {} // also clears CAR_NAV_KEY (owner: navNotification)
  // Ending a route must also clean the template stack: Jeff's 8/19 drive ended with
  // the stranded search keyboard STILL covering the map because nothing here popped
  // it. iOS-only — Android's dismiss path pops to the AA nav template by id, and on
  // AA endCarNav can run while other templates are legitimately stacked.
  if (Platform.OS !== 'android' && (_searchPushed || _searchPresented)) {
    _searchPushed = false;
    try { getLib()?.CarPlay?.popToRootTemplate?.(true); } catch {}
  }
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
// "Where to?" saved-places list (iOS) — see getWhereToTemplate. Shares _searchPushed.
let _whereTo: any | null = null;
let _whereToShown: SavedPlace[] = [];
let _whereToToSearch = false;

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
type AaList = { rows: AaRow[]; saved: SavedPlace[]; results: CarSearchResult[] };

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
  const q = (query || '').trim();
  if (q.length < 2) {
    try { await ensureSavedPlacesLoaded(); } catch {}
    return aaSavedList();
  }
  let results: CarSearchResult[] = [];
  try {
    results = (await placesAutocomplete(q)).slice(0, AA_SEARCH_MAX_ROWS);
  } catch {
    results = [];
  }
  return {
    saved: [],
    results,
    rows: results.map((r, i) => ({ id: `r:${i}`, text: r.description, browsable: true })),
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
function aaPop(): void {
  if (!_aaSearchOnStack) return;
  _aaSearchOnStack = false;
  try { getCarLib()?.CarPlay?.popTemplate?.(true); } catch {}
}

// One dismiss for both car surfaces.
function dismissCarSearch(): void {
  if (Platform.OS === 'android') { aaPop(); return; }
  try { getLib()?.CarPlay?.popToRootTemplate?.(true); } catch {}
}

async function aaSelect(rowId: string): Promise<void> {
  const kind = rowId.slice(0, 1);
  const idx = Number(rowId.slice(2));
  if (!Number.isFinite(idx)) return;
  if (kind === 's') {
    const p = _aaSaved[idx];
    if (!p) return;
    const ok = await startCarNav({ lat: p.lat, lng: p.lng, label: p.label });
    // SAME OWNERSHIP RULE AS iOS: release only when we actually pop. Releasing on a
    // FAILED start would leave the screen on the stack with nobody owning it, and the
    // re-tap would stack a second one.
    if (ok) { _searchPushed = false; aaPop(); }
    return;
  }
  const picked = _aaResults[idx];
  if (!picked) return;
  const dest = await placeDetails(picked.placeId).catch(() => null);
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
  _searchPushed = false;
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
      _movingTicks = 0;
    });
  } catch {}
  subscribeCarState((st) => {
    // OWNERSHIP or VISIBILITY — either says the template is (or may be) on the stack.
    // Ownership alone was the 8/19 trap: a wrong release left _searchPushed=false while
    // the template sat stacked, and this guard then bailed forever. _searchPresented is
    // native ground truth (didAppear), so "visible right now while moving" always pops
    // even when ownership mis-tracked. Popping when neither flag is set stays forbidden —
    // that would yank whatever else the driver is looking at.
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
}
// Which list the search template is currently showing. onItemSelect gets only an
// INDEX, so without this the driver tapping "Home" would open whatever Places result
// happened to sit at index 0.
let _listMode: 'saved' | 'results' = 'saved';
let _savedShown: SavedPlace[] = [];

// Home first, then Work, then custom places newest-first — the phone's own ordering.
function savedPlaceRows(): { text: string; detailText?: string; image: unknown }[] {
  const rank = (k: SavedPlace['kind']) => (k === 'home' ? 0 : k === 'work' ? 1 : 2);
  _savedShown = getSavedPlaces()
    .slice()
    .sort((a, b) => rank(a.kind) - rank(b.kind) || b.createdAt - a.createdAt);
  return _savedShown.map((p) => ({
    text: p.label,
    detailText: p.address || undefined,
    image: p.kind === 'home' ? CAR_ICON_HOME : p.kind === 'work' ? CAR_ICON_WORK : CAR_ICON_SAVED,
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
        const q = (query || '').trim();
        if (q.length < 2) {
          _listMode = 'saved';
          try { await ensureSavedPlacesLoaded(); } catch {}
          return savedPlaceRows();
        }
        _listMode = 'results';
        try {
          _lastResults = await placesAutocomplete(q);
        } catch {
          _lastResults = [];
        }
        return _lastResults.map((r) => ({ text: r.description }));
      },
      onItemSelect: async ({ index }: { index: number }) => {
        // The list is EITHER saved places or Places results — index means different
        // things in each, so route on the mode the last onSearch left behind.
        if (_listMode === 'saved') {
          const p = _savedShown[index];
          if (!p) return;
          const ok = await startCarNav({ lat: p.lat, lng: p.lng, label: p.label });
          // Release ownership ONLY when we actually pop. Releasing on a FAILED start would
          // leave the template on the stack while we no longer own it — a re-tap would then
          // push a second instance, which is the stack corruption that freezes CarPlay.
          if (ok) popCarSearchDeferred();
          return;
        }
        const picked = _lastResults[index];
        if (!picked) return;
        const dest = await placeDetails(picked.placeId).catch(() => null);
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
        _searchPresented = false;
        _movingTicks = 0;
        // Best-guess release for a genuine stationary back-out — safe to be wrong
        // now, because didAppear self-heals the motion-hide-at-creep case above.
        try {
          if ((getCarState().speedMs || 0) <= _SEARCH_POP_SPEED_MS) _searchPushed = false;
        } catch { _searchPushed = false; }
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
// driver with no saved places goes straight to the keyboard, as before. The list shares
// the search flow's OWNERSHIP flag (_searchPushed): the motion watcher pops it to root
// when the car moves, the Search-button recovery branch clears it, and a genuine
// back-out releases it in onDidDisappear — the same rules that keep the keyboard
// template from ever being double-pushed. Android Auto is untouched (its native search
// template lists the saved rows as `items` already).
// Rodrigo has LOTS of saved places (Jeff, 2026-09-03) — the list scrolls, so the cap only
// guards a runaway store. CPListTemplate.maximumItemCount is 500 on iOS 14+ head units.
const WHERE_TO_MAX = 30;
function pushSearchTemplateIOS(): void {
  const t = getSearchTemplate();
  if (!t) { _whereToToSearch = false; return; }
  armSearchAutoDismiss();                    // idempotent
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
        if (!p) return;
        const ok = await startCarNav({ lat: p.lat, lng: p.lng, label: p.label });
        if (ok) popCarSearchDeferred();     // release + pop to root only when the pop really happens
      },
      onDidAppear: () => { _searchPushed = true; _movingTicks = 0; },
      onDidDisappear: () => {
        if (_whereToToSearch) { _whereToToSearch = false; return; }
        // Genuine back-out, or the motion / recovery pop: release ownership unless the
        // keyboard template is the thing on screen.
        if (!_searchPresented) _searchPushed = false;
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
  armSearchAutoDismiss();                    // idempotent
  _searchPushed = true;
  try { getLib()?.CarPlay?.pushTemplate?.(t, true); } catch { _searchPushed = false; }
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
  mapButtons: [
    { id: 'car-comms', image: CAR_ICON_MIC, focusedImage: CAR_ICON_MIC },
    { id: 'car-view', image: CAR_ICON_VIEW_2D, focusedImage: CAR_ICON_VIEW_2D },
    { id: 'car-crew', image: CAR_ICON_CREW, focusedImage: CAR_ICON_CREW },
    { id: 'car-compass', image: CAR_ICON_COMPASS, focusedImage: CAR_ICON_COMPASS },
  ],
};

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
export function carMapButtonConfig() {
  const s = appSkinNow();
  return {
    ...CAR_MAP_BUTTON_CONFIG,
    mapButtons: [
      { id: 'car-comms', image: CAR_ICON_MIC, focusedImage: CAR_ICON_MIC },
      { id: 'car-view', image: carIcon('view2d', s), focusedImage: carIcon('view2d', s) },
      { id: 'car-crew', image: carIcon('crew', s), focusedImage: carIcon('crew', s) },
      { id: 'car-compass', image: carIcon('compass', s), focusedImage: carIcon('compass', s) },
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
// androidx ACTIONS_CONSTRAINTS_MAP: max 4, ICON ONLY (no titles accepted). Same order
// rationale as CarPlay above. Note the key is `icon` here and `image` on iOS — they are
// NOT interchangeable; parseAction reads map.getMap("icon").
export const AA_MAP_BUTTONS = [
  { id: 'car-zoom-in', icon: CAR_ICON_ZOOM_IN, visibility: AA_PERSISTENT },
  { id: 'car-zoom-out', icon: CAR_ICON_ZOOM_OUT, visibility: AA_PERSISTENT },
  { id: 'car-crew', icon: CAR_ICON_CREW, visibility: AA_PERSISTENT },
  { id: 'car-compass', icon: CAR_ICON_COMPASS, visibility: AA_PERSISTENT },
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
    { id: 'car-crew', icon: carIcon('crew', s), visibility: AA_PERSISTENT },
    { id: 'car-compass', icon: carIcon('compass', s), visibility: AA_PERSISTENT },
  ];
}

// One dispatcher for an Android Auto press. The ids are shared with CarPlay, so this
// just picks whichever existing handler owns each id — no duplicated behaviour.
export function handleAaButton(id?: string): void {
  if (!id) return;
  // ⚠ EXPLICIT ALLOWLIST, not a car-* wildcard. Miss an id here and the AA button
  // renders, taps, logs a receipt — and does nothing, while CarPlay works fine.
  if (id === 'car-crew' || id === 'car-compass' || id === 'car-mic'
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
      carToast: `${TAP_LABEL[id] || id} ✓`,
      carToastUntil: Date.now() + 1600,
    });
  } catch {}
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
  if (id === 'car-view') {
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
  if (id === 'car-crew') { emitCarGesture({ kind: 'crewFit' }); return; }
  if (id === 'car-compass') { emitCarGesture({ kind: 'compass' }); return; }
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
  if (id === 'car-zoom-in') { emitCarGesture({ kind: 'zoomStep', delta: 0.5 }); return; }
  if (id === 'car-zoom-out') { emitCarGesture({ kind: 'zoomStep', delta: -0.5 }); return; }
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
    if (_searchPushed || (Platform.OS !== 'android' && _searchPresented)) {
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
      _searchPresented = false;
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
