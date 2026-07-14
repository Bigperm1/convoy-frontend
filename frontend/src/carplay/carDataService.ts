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
import { getSettings, getAvatarMode } from '../settings';
import { toGRCSlug } from '../vehicleAssets';
import { getCarState, setCarPeers, setCarHazards, subscribeCarState, type CarPeer } from './carStore';

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
let _presenceChannel: any = null;
let _hazardsChannel: any = null;
let _unsubStore: (() => void) | null = null;

// Community moderation backstop — same rule as the phone (map.tsx isHazardVisible):
// a hazard hides once it has 2 "Gone" votes.
const visible = (h: SvcHazard) => (h.disputes || 0) < 2;

function emitPeers() {
  if (!_running) return;
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
    }));
  setCarPeers(out, 'service');
}

function emitHazards() {
  if (!_running) return;
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

function joinPresence(): void {
  if (!_running || _presenceChannel || !SUPABASE_ENABLED || !supabase || !_me?.id) return;
  const channelName = presenceChannelName();
  if (!channelName) return;
  try {
    const channel = supabase.channel(channelName, { config: { presence: { key: _me.id } } });
    _presenceChannel = channel;
    channel
      .on('presence', { event: 'sync' }, () => {
        try {
          const state = channel.presenceState();
          const list: SvcPeer[] = [];
          Object.entries(state).forEach(([uid, presences]) => {
            if (uid === _me?.id) return;
            const p: any = (presences as any[])[0];
            if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
            list.push({
              user_id: uid,
              handle: p.handle,
              lat: p.lat,
              lng: p.lng,
              heading: p.heading,
              status: p.status === 'parked' ? 'parked' : 'live',
            });
          });
          _presencePeers = list;
          emitPeers();
        } catch {}
      })
      .subscribe((s: string) => {
        if (s === 'SUBSCRIBED') void trackPresence(true);
      });
  } catch {
    _presenceChannel = null;
  }
}

// Broadcast our own position so the convoy sees US while the phone stays in a
// pocket ("they see you" — the other half of cold peers). Throttled like the
// phone's hook; payload mirrors useConvoyPresence's track() fields.
async function trackPresence(force = false): Promise<void> {
  if (!_running || !_presenceChannel || !_me?.id) return;
  const st = getCarState();
  if (typeof st.selfLat !== 'number' || typeof st.selfLng !== 'number') return;
  const now = Date.now();
  if (!force && now - _presenceLastTrack < PRESENCE_TRACK_MS) return;
  _presenceLastTrack = now;
  const s = getSettings();
  try {
    await _presenceChannel.track({
      user_id: _me.id,
      handle: _me.handle,
      carType: _me.carType,
      carBody: _me.carBody,
      carColor: s.carColor || _me.carColor,
      activeColor: toGRCSlug(s.carColor || _me.carColor) || undefined,
      topSpeed: _me.topSpeed,
      status: 'live', // this service runs only while CarPlay is connected = driving
      lat: st.selfLat,
      lng: st.selfLng,
      heading: st.heading ?? undefined,
      online_at: new Date().toISOString(),
    });
  } catch {}
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
  // presence joins from ensureMe() once identity is known
}

export function stopCarDataService(): void {
  if (!_running) return;
  _running = false;
  try { _unsubStore?.(); } catch {}
  _unsubStore = null;
  try { _ws?.close(); } catch {}
  _ws = null;
  try { _presenceChannel?.untrack?.().catch?.(() => {}); } catch {}
  try { if (supabase && _presenceChannel) supabase.removeChannel(_presenceChannel); } catch {}
  _presenceChannel = null;
  try { if (supabase && _hazardsChannel) supabase.removeChannel(_hazardsChannel); } catch {}
  _hazardsChannel = null;
  _peers = {};
  _presencePeers = [];
  _hazards = [];
  _me = null;
  _lastTickLat = null;
  _lastTickLng = null;
  // Deliberately NOT clearing carStore.peers/hazards here — the phone mirror (if
  // mounted) keeps owning them, and a momentary [] would blink the car UI during
  // a reconnect. Stale data ages out via the freshness gate on the next writer.
}
