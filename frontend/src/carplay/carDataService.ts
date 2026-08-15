// src/carplay/carDataService.ts
//
// COLD-capable convoy data feeds for the CarPlay surface (CarPlay-standalone
// Wave 1): PEERS (WebSocket + Supabase presence + /users/nearby) and HAZARDS
// (Supabase select + Realtime + WS fan-out), owned at MODULE SCOPE so they run
// when the phone app was never opened (phone locked, CarPlay-only launch —
// map.tsx never mounts, so its pipelines never start).
//
// Started/stopped by carPlayBootstrap on CarPlay connect/disconnect. While the
// phone map IS mounted, its richer warm mirror keeps writing too — the two
// writers meet in carStore behind the setCarPeers/setCarHazards freshness gates
// ('phone' outranks 'service' while fresh; see carStore.ts), so they never fight.
//
// DESIGN CONSTRAINT (verified in the CarPlay-standalone deep-dive): RN's JS
// timers (RCTTiming) can stall while the phone is locked even though the CarPlay
// scene keeps the process foreground-equivalent — so NOTHING here refreshes on
// setInterval. Every periodic refresh is EVENT-driven off carStore position
// ticks (the background location task keeps those flowing when locked — see
// navNotification NAV_TASK), throttled by wall-clock comparison. WebSocket and
// Supabase Realtime callbacks are native-driven and keep firing while locked.
//
// PRIVACY (mirrors map.tsx exactly — verified against map.tsx:2474-2509):
// presence is COMMUNITY-SCOPED ONLY (`convoy:community:<id>`, null without an
// active community — no global fanout, strangers never appear) and fully
// disabled in ghost mode. While CarPlay is connected the phone broadcasts
// status 'live' — this service runs only while CarPlay is connected, so it
// broadcasts 'live' with the same coords the car map draws.

import { api, getToken, wsUrl } from '../api';
import { supabase, SUPABASE_ENABLED } from '../supabase';
import { getSettings, getAvatarMode, ensureSettingsLoaded } from '../settings';
// THE gate (src/locationPrivacy). Every outbound position must ask it — this file was
// the last transport that did not. See buildCarPayload and onStoreTick below.
import { shareablePosition, noteFix, hydrateLocationPrivacy } from '../locationPrivacy';
import { toGRCSlug } from '../vehicleAssets';
import { getCarState, setCarPeers, setCarHazards, subscribeCarState, carFeedWouldAccept, type CarPeer } from './carStore';
import { joinPresence as hubJoinPresence, type PresenceHandle } from '../presenceHub';

// ── throttle cadences (wall-clock, event-driven — NO timers) ────────────────
const NEARBY_REFRESH_MS = 10_000;   // matches the phone's 10s /users/nearby poll
const HAZARDS_REFRESH_MS = 30_000;  // matches the phone's 30s fallback poll
const PRESENCE_TRACK_MS = 1_500;    // matches useConvoyPresence's track throttle
const WS_RECONNECT_MS = 10_000;     // min gap between WS reconnect attempts
const ME_RETRY_MS = 30_000;         // /auth/me retry while it keeps failing

// Internal peer shape (superset of what we emit — mirrors map.tsx's Peer merge
// fields so the WS/REST/presence transports can merge without losing data).
type SvcPeer = {
  user_id: string;
  handle?: string;
  lat?: number;
  lng?: number;
  heading?: number;
  status?: 'live' | 'parked';
  // Appearance, so the COLD feed can draw each peer's real car on the head unit rather
  // than flipping the whole crew to default paint the moment the phone screen backgrounds.
  // ⚠ A pre-ship review caught emitPeers reading these off SvcPeer while NO ingest path
  // kept them — the mirroring was inert and read as working. Declaring them here is what
  // makes the compiler hold the ingest to it.
  marker?: 'class' | 'arrow' | null;
  cls?: string;
  color?: string;
};

type SvcHazard = { id: string; kind: string; lat: number; lng: number; confirms?: number; disputes?: number };

let _running = false;
let _me: { id: string; handle?: string; carType?: string; carBody?: string; carColor?: string; topSpeed?: number } | null = null;
let _meLastTry = 0;
let _ws: WebSocket | null = null;
let _wsLastTry = 0;
let _peers: Record<string, SvcPeer> = {};        // WS + REST transports
let _presencePeers: SvcPeer[] = [];              // Supabase presence transport
let _hazards: SvcHazard[] = [];
let _nearbyLastFetch = 0;
let _hazardsLastFetch = 0;
let _presenceLastTrack = 0;
let _presenceHandle: PresenceHandle | null = null;
// Has the privacy gate been hydrated from disk in THIS context? Presence may not join
// (and therefore may not broadcast) until it has — see startCarDataService.
let _privacyReady = false;
let _hazardsChannel: any = null;
let _unsubStore: (() => void) | null = null;

// Community moderation backstop — same rule as the phone (map.tsx isHazardVisible):
// a hazard hides once it has 2 "Gone" votes.
const visible = (h: SvcHazard) => (h.disputes || 0) < 2;

function emitPeers() {
  if (!_running) return;
  // The carStore freshness gate (carStore.ts:328 feedGateAllows) DROPS a 'service'
  // write outright while the phone mirror has written within FEED_STALE_MS (12 s) —
  // which, with map.tsx mounted and a car connected, is essentially the whole drive:
  // its crew push re-signs on every ~11 m of peer movement (map.tsx:2137). Building
  // `out` first and handing it to a gate that throws it away is pure waste on the
  // hottest path in this file — this runs on EVERY WS location frame and every
  // presence sync. So ask first. Nothing upstream is skipped: _peers/_presencePeers
  // are already updated by the callers, so the moment the phone mirror goes quiet the
  // next event emits the full merged set exactly as it does today.
  if (!carFeedWouldAccept('peers', 'service')) return;
  // Merge WS/REST peers with presence peers — presence wins (live & most recent),
  // same as the phone's peerList merge (map.tsx:2703-2729). Self is excluded at
  // ingest (WS filter + presence key skip).
  const byId: Record<string, SvcPeer> = { ..._peers };
  for (const p of _presencePeers) byId[p.user_id] = { ...byId[p.user_id], ...p };
  const out: CarPeer[] = Object.values(byId)
    .filter((p) => p.user_id && p.handle && p.user_id !== _me?.id)
    .map((p) => ({
      id: p.user_id,
      handle: p.handle as string,
      lat: typeof p.lat === 'number' ? p.lat : undefined,
      lng: typeof p.lng === 'number' ? p.lng : undefined,
      heading: typeof p.heading === 'number' ? p.heading : undefined,
      status: p.status === 'parked' ? 'parked' : 'live',
      // Appearance, same reason as the warm mirror: the head unit must draw each peer's
      // real car whether the phone screen is up or the cold service is driving.
      marker: p.marker ?? undefined,
      cls: p.cls,
      color: p.color,
    }));
  setCarPeers(out, 'service');
}

function emitHazards() {
  if (!_running) return;
  // Same gate, same reason as emitPeers above: while the phone mirror is fresh this
  // filter+map is built only to be dropped by carStore.setCarHazards. _hazards is
  // already updated by the caller, so the service still has the full set the instant
  // the phone goes quiet.
  if (!carFeedWouldAccept('hazards', 'service')) return;
  setCarHazards(
    _hazards.filter(visible).map((h) => ({ id: h.id, kind: h.kind, lat: h.lat, lng: h.lng, confirms: h.confirms, disputes: h.disputes })),
    'service',
  );
}

// ── /auth/me (headless identity: self-echo filter + presence key) ───────────
async function ensureMe(): Promise<void> {
  if (_me || !_running) return;
  const now = Date.now();
  if (now - _meLastTry < ME_RETRY_MS) return;
  _meLastTry = now;
  try {
    const { data: u } = await api.get('/auth/me');
    if (!u?.id) return;
    _me = {
      id: u.id,
      handle: u.handle,
      carType: [u.car_make, u.car_model].filter(Boolean).join(' ').trim() || undefined,
      carBody: u.car_type || 'sedan',
      carColor: getSettings().carColor || u.car_color || undefined,
      topSpeed: typeof u.top_speed_record === 'number' ? u.top_speed_record : undefined,
    };
    // Identity just arrived: presence can now join, and any self-echo already
    // merged into _peers gets filtered on the next emit.
    joinPresence();
    emitPeers();
  } catch {}
}

// ── WebSocket transport (peer positions + hazard fan-out) ────────────────────
// Mirrors map.tsx's ws.onmessage exactly (map.tsx:2082-2146), minus the phone-only
// music_broadcast toast. No self-echo: `location` for our own id is dropped once
// _me is known (until then the backend's own no-echo behavior covers us).
async function connectWs(): Promise<void> {
  if (!_running || _ws) return;
  const now = Date.now();
  if (now - _wsLastTry < WS_RECONNECT_MS) return;
  _wsLastTry = now;
  const token = await getToken();
  if (!token || !_running || _ws) return;
  try {
    const ws = new WebSocket(wsUrl(token));
    _ws = ws;
    ws.onmessage = (ev: any) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'location' && m.user_id && m.user_id !== _me?.id) {
          _peers[m.user_id] = {
            ..._peers[m.user_id],
            user_id: m.user_id,
            handle: m.handle ?? _peers[m.user_id]?.handle,
            lat: m.lat,
            lng: m.lng,
            heading: typeof m.heading === 'number' ? m.heading : _peers[m.user_id]?.heading,
          };
          emitPeers();
        }
        if (m.type === 'hazard' && m.hazard && m.hazard.id) {
          // Dedup by id — Supabase Realtime INSERT and the WS broadcast BOTH fire
          // (same load-bearing guard as map.tsx:2103).
          if (!_hazards.some((h) => h.id === m.hazard.id)) {
            _hazards = [m.hazard, ..._hazards];
            emitHazards();
          }
        }
        if (m.type === 'hazard_update' && m.hazard && m.hazard.id) {
          _hazards = _hazards.map((h) => (h.id === m.hazard.id ? { ...h, ...m.hazard } : h));
          emitHazards();
        }
        if (m.type === 'hazard_removed' && m.id) {
          _hazards = _hazards.filter((h) => h.id !== m.id);
          emitHazards();
        }
      } catch {}
    };
    const drop = () => { if (_ws === ws) _ws = null; }; // reconnect on next position tick
    ws.onclose = drop;
    ws.onerror = drop;
  } catch {
    _ws = null;
  }
}

// ── /users/nearby REST backstop (merge, NEVER wipe — map.tsx:2185 rule) ─────
async function refreshNearby(): Promise<void> {
  if (!_running) return;
  const now = Date.now();
  if (now - _nearbyLastFetch < NEARBY_REFRESH_MS) return;
  _nearbyLastFetch = now;
  try {
    const { data } = await api.get('/users/nearby');
    (Array.isArray(data) ? data : []).forEach((u: any) => {
      if (u.lat && u.lng) {
        _peers[u.id] = {
          ..._peers[u.id],
          user_id: u.id,
          handle: u.handle,
          lat: u.lat,
          lng: u.lng,
          heading: typeof u.heading === 'number' ? u.heading : _peers[u.id]?.heading,
        };
      }
    });
    emitPeers();
  } catch {}
}

// ── Hazards: initial/refresh fetch + Realtime channel ────────────────────────
// Same source order as the phone (map.tsx:2001-2025): Supabase select first,
// FastAPI /hazards as the fallback. The 30s re-fetch is event-driven here (off
// position ticks) instead of setInterval. NOTE: the phone deliberately skips its
// poll while backgrounded-and-not-navigating (battery); for this service
// "CarPlay connected" IS the active-use signal, so it always refreshes.
async function refreshHazards(force = false): Promise<void> {
  if (!_running) return;
  const now = Date.now();
  if (!force && now - _hazardsLastFetch < HAZARDS_REFRESH_MS) return;
  _hazardsLastFetch = now;
  if (SUPABASE_ENABLED && supabase) {
    try {
      const { data, error } = await supabase
        .from('hazards')
        .select('*')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });
      if (!error && data) {
        _hazards = data.map((s: any) => ({ id: s.id, kind: s.kind, lat: s.lat, lng: s.lng, confirms: s.confirms, disputes: s.disputes }));
        emitHazards();
        return;
      }
    } catch {}
  }
  try {
    const { data } = await api.get('/hazards');
    if (Array.isArray(data)) {
      _hazards = data;
      emitHazards();
    }
  } catch {}
}

function joinHazardsRealtime(): void {
  if (!_running || _hazardsChannel || !SUPABASE_ENABLED || !supabase) return;
  try {
    _hazardsChannel = supabase
      .channel('car:public:hazards') // distinct topic from the phone's "public:hazards" — both can be live
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'hazards' }, (payload: any) => {
        const s = payload.new;
        if (!s?.id) return;
        const h = { id: s.id, kind: s.kind, lat: s.lat, lng: s.lng, confirms: s.confirms, disputes: s.disputes };
        _hazards = [h, ..._hazards.filter((x) => x.id !== h.id)];
        emitHazards();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'hazards' }, (payload: any) => {
        const s = payload.new;
        if (!s?.id) return;
        _hazards = _hazards.map((x) => (x.id === s.id ? { id: s.id, kind: s.kind, lat: s.lat, lng: s.lng, confirms: s.confirms, disputes: s.disputes } : x));
        emitHazards();
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'hazards' }, (payload: any) => {
        const id = (payload.old as any)?.id;
        if (id) {
          _hazards = _hazards.filter((x) => x.id !== id);
          emitHazards();
        }
      })
      .subscribe();
  } catch {
    _hazardsChannel = null;
  }
}

// ── Supabase presence (join + broadcast; same gates as the phone) ────────────
function presenceChannelName(): string | null {
  const s = getSettings();
  if (getAvatarMode(s) === 'ghost') return null;           // never broadcast in ghost
  return s.activeCommunityId ? `convoy:community:${s.activeCommunityId}` : null; // community-scoped ONLY
}

// OUR slim presence payload for the shared hub (priority 1). Returns null when
// we have no identity or no self fix yet, so the hub falls through to a higher-
// priority provider (the phone map) or simply doesn't broadcast.
function buildCarPayload(): Record<string, any> | null {
  if (!_me?.id) return null;
  const st = getCarState();
  if (typeof st.selfLat !== 'number' || typeof st.selfLng !== 'number') return null;
  // ── THE PRIVACY GATE, IN THE CAR CONTEXT (2026-08-15) ─────────────────────────
  // This used to publish st.selfLat/st.selfLng RAW with a hardcoded status:'live', on
  // the reasoning in this file's header: "this service runs only while CarPlay is
  // connected = driving". That reasoning does not hold on Android. Nothing unmounts
  // AndroidAutoRoot — CarPlaySession.onDestroy is a no-op and the didDisconnect listener
  // needs build 71 (AndroidAutoRoot.tsx:116-142) — so stopCarDataService is never reached
  // after an AA drive and this provider kept broadcasting the phone's live position while
  // the driver walked away. That is precisely the class src/locationPrivacy exists to kill
  // (its header: the 2026-07-20 house leak). Ask the gate instead.
  const share = shareablePosition({
    lat: st.selfLat,
    lng: st.selfLng,
    heading: st.heading ?? 0,
    speed: st.speedMs ?? 0,
  });
  // Ghost, or parked with no known car spot -> broadcast NOTHING (absent beats exposed).
  // null is already this provider's "not ready" signal and presenceHub.doTrack does
  // `if (!payload) return` (presenceHub.ts:90), so the hub simply does not track for us
  // this tick.
  if (!share.share) return null;
  const s = getSettings();
  return {
    user_id: _me.id,
    handle: _me.handle,
    carType: _me.carType,
    carBody: _me.carBody,
    carColor: s.carColor || _me.carColor,
    activeColor: toGRCSlug(s.carColor || _me.carColor) || undefined,
    topSpeed: _me.topSpeed,
    // Was hardcoded 'live'. The gate's own answer now — and NOTE the deliberate ASYMMETRY
    // with the warm phone map, because the obvious reading is wrong: map.tsx calls
    // noteCarConnected(true) (map.tsx:3409), so isParked() is false there and its peer
    // stays 'live' at any standstill. This context asserts nothing (see the declined
    // noteCarConnected item), so on a COLD drive a driver stopped past the 90 s hysteresis
    // draws 'parked' (0.5 opacity) to the crew. Cosmetic, self-correcting on the next
    // moving fix, and COLD-PATH ONLY — while map.tsx is mounted its provider (priority 2)
    // owns the broadcast outright and this payload is never even read (presenceHub.ts:83-90
    // breaks at the first non-top priority).
    // `status` is NOT one of presenceHub's throttled keys (idKeyOf excludes only
    // lat/lng/heading/topSpeed, presenceHub.ts:58-67), so a live<->parked flip still
    // bypasses the 1.5 s window.
    status: share.status,
    lat: share.lat,
    lng: share.lng,
    // `|| undefined` preserves today's wire SHAPE: the gate returns heading 0 both for
    // "no heading known" and for the car-spot branch, and a literal 0 on the wire is DUE
    // NORTH — the bug d474ed3 just fixed on the AA surface.
    heading: share.heading || undefined,
  };
}

function joinPresence(): void {
  if (!_running || _presenceHandle || !SUPABASE_ENABLED || !supabase || !_me?.id) return;
  // The gate must be hydrated before our first payload can be built — registering the
  // provider IS what exposes buildCarPayload to the hub, and presenceHub force-tracks
  // once immediately on SUBSCRIBE (presenceHub.ts:152). Gating the JOIN, rather than the
  // payload, is what turns "hydrated before the first track" from a race into a fact.
  // Not a retry loop: startCarDataService's hydrate block calls joinPresence() itself
  // when it lands, and ensureMe() calls it when identity arrives — whichever is last
  // drives the join.
  if (!_privacyReady) return;
  const channelName = presenceChannelName();
  if (!channelName) return;
  // The hub owns the single channel per topic — the phone map (priority 2) and
  // this service (priority 1) share it, so the deduped-channel presence throw
  // (the 2026-07-18 crash wave) can't happen. The map's richer payload wins the
  // broadcast whenever it's mounted; we broadcast only when the phone isn't.
  _presenceHandle = hubJoinPresence({
    topic: channelName,
    selfId: _me.id,
    priority: 1,
    getPayload: buildCarPayload,
    onPeers: (raw) => {
      const list: SvcPeer[] = [];
      for (const p of raw) {
        if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
        list.push({
          user_id: p.user_id,
          handle: p.handle,
          lat: p.lat,
          lng: p.lng,
          heading: p.heading,
          status: p.status === 'parked' ? 'parked' : 'live',
          // The presence broadcast carries these (see convoyPresence's payload); this
          // ingest was dropping them, which is why the cold path had nothing to draw with.
          marker: ((p as any).marker === 'class' || (p as any).marker === 'arrow')
            ? (p as any).marker as 'class' | 'arrow' : undefined,
          cls: typeof (p as any).cls === 'string' ? (p as any).cls : undefined,
          color: (p as any).activeColor || (p as any).carColor || undefined,
        });
      }
      _presencePeers = list;
      emitPeers();
    },
  });
}

// Broadcast our own position so the convoy sees US while the phone stays in a
// pocket ("they see you" — the other half of cold peers). Throttled like the
// phone's hook; the actual payload comes from buildCarPayload via the hub.
function trackPresence(force = false): void {
  if (!_running || !_presenceHandle || !_me?.id) return;
  const st = getCarState();
  if (typeof st.selfLat !== 'number' || typeof st.selfLng !== 'number') return;
  const now = Date.now();
  if (!force && now - _presenceLastTrack < PRESENCE_TRACK_MS) return;
  _presenceLastTrack = now;
  _presenceHandle.track();
}

// ── Position-tick driver (the event-driven "clock") ──────────────────────────
let _lastTickLat: number | null = null;
let _lastTickLng: number | null = null;
function onStoreTick(): void {
  if (!_running) return;
  const st = getCarState();
  if (typeof st.selfLat !== 'number' || typeof st.selfLng !== 'number') return;
  // Only act on POSITION changes (any carStore write lands here — peers writes
  // included — so gate on movement of the self fix to avoid self-feedback).
  if (st.selfLat === _lastTickLat && st.selfLng === _lastTickLng) return;
  _lastTickLat = st.selfLat;
  _lastTickLng = st.selfLng;
  // FEED THE PRIVACY GATE (2026-08-15). In a COLD car context map.tsx never mounts, so
  // nothing else calls noteFix: the driving latch never arms, no car spot is ever
  // recorded, and buildCarPayload's shareablePosition would answer "no-car-spot" for the
  // entire drive — i.e. the crew would not see you. This is the car context's own writer,
  // and it is what makes a CarPlay/AA-only drive leave a correct parked pin afterwards
  // (today such a drive records no car spot at all).
  // Deliberately BEFORE trackPresence below, so the payload built on this tick reads a
  // gate that already knows about this fix.
  // Warm double-write is safe: carStore's 'mirror' source is map.tsx's `coords` object
  // (map.tsx:2118 `user: coords` -> ConvoyCarPlay.tsx:1250), RAW GPS — the same value
  // map.tsx feeds noteFix at map.tsx:3410 — and the fg/bg feeds write raw GPS too. Both
  // writers agree; nothing snapped ever reaches the car spot.
  noteFix(st.selfLat, st.selfLng, st.speedMs ?? 0);
  void ensureMe();
  void connectWs();       // reconnect (throttled) if the socket dropped
  void refreshNearby();   // ≤ every 10s
  void refreshHazards();  // ≤ every 30s
  void trackPresence();   // ≤ every 1.5s
}

// ── lifecycle ────────────────────────────────────────────────────────────────
export function startCarDataService(): void {
  if (_running) return;
  _running = true;
  _unsubStore = subscribeCarState(onStoreTick);
  void ensureMe();
  void connectWs();
  void refreshHazards(true);
  void refreshNearby();
  joinHazardsRealtime();
  // ── HYDRATE THE PRIVACY GATE BEFORE THE FIRST BROADCAST ────────────────────────
  // buildCarPayload now asks src/locationPrivacy, and that module answers out of MODULE
  // state which, before this edit, ONLY app/(app)/map.tsx ever populated (verified: the
  // sole importers of locationPrivacy are map.tsx and visitMonitor.ts). In a cold car
  // context map.tsx never mounts, so:
  //   • getSettings() is still DEFAULT_SETTINGS (avatarLive:true, avatarMode undefined ->
  //     getAvatarMode returns "visible") — the gate would fail OPEN for a ghost user;
  //   • _carSpot is null and _lastDrivingAt is 0 — so a stationary cold connect answers
  //     "no-car-spot" and the crew cannot see you at all.
  // Both are AsyncStorage reads. Await them HERE and hold the presence join until they
  // land (joinPresence's _privacyReady guard). settings.ts already starts its load at
  // module import, so this is normally a no-op await.
  void (async () => {
    // ONE try PER AWAIT, deliberately. settings.ts's loadPromise ends with an UNGUARDED
    // `listeners.forEach((l) => l(cached))` (settings.ts:444), so a throwing settings
    // listener REJECTS that promise. Under a single shared catch that rejection would
    // skip hydrateLocationPrivacy() entirely, leaving _carSpot null for the whole drive
    // and withholding our position from the crew — the exact regression this block exists
    // to prevent. (No fail-OPEN risk either way: `loaded = true` is set at settings.ts:443,
    // BEFORE that notify, so `cached` is always populated by the time a rejection is
    // possible — a ghost user can never be read as visible through this path.)
    try { await ensureSettingsLoaded(); } catch {}
    try { await hydrateLocationPrivacy(); } catch {}
    if (!_running) return;   // stopped while we were awaiting
    _privacyReady = true;
    // Identity may have arrived first, in which case ensureMe's joinPresence() bailed on
    // !_privacyReady — and it is never retried, because ensureMe self-disables once _me
    // is set. Re-drive it. (This also closes a PRE-EXISTING hole: joinPresence bails when
    // presenceChannelName() is null, which it always is before settings load because
    // activeCommunityId is unset — so if /auth/me ever resolved before AsyncStorage, this
    // service silently never broadcast for the whole session.)
    joinPresence();
  })();
  // presence joins from ensureMe() once identity is known AND the gate is hydrated
}

export function stopCarDataService(): void {
  if (!_running) return;
  _running = false;
  try { _unsubStore?.(); } catch {}
  _unsubStore = null;
  try { _ws?.close(); } catch {}
  _ws = null;
  try { _presenceHandle?.leave(); } catch {}
  _presenceHandle = null;
  try { if (supabase && _hazardsChannel) supabase.removeChannel(_hazardsChannel); } catch {}
  _hazardsChannel = null;
  _peers = {};
  _presencePeers = [];
  _hazards = [];
  _me = null;
  _lastTickLat = null;
  _lastTickLng = null;
  _privacyReady = false;   // next start re-awaits (both hydrations are idempotent/cheap)
  // Deliberately NOT clearing carStore.peers/hazards here — the phone mirror (if
  // mounted) keeps owning them, and a momentary [] would blink the car UI during
  // a reconnect. Stale data ages out via the freshness gate on the next writer.
}
