// presenceHub.ts — SINGLE-OWNER supabase Realtime presence, per topic.
//
// Both the phone map (useConvoyPresence) and the CarPlay data service
// (carDataService.joinPresence) need the same community's live-peer presence.
// supabase-js dedupes channels BY TOPIC, so if two owners on ONE device each do
// channel(topic).on('presence').subscribe(), the SECOND .on() throws a FATAL
// ("cannot add `presence` callbacks after `subscribe()`") — the 2026-07-18
// crash wave. This hub is the deterministic root fix: exactly ONE channel per
// topic (one .on, one .subscribe), the raw peer payloads fanned out to every
// local consumer, and OUR presence tracked from the highest-priority provider's
// payload. Two consumers can never double-join → the throw can never happen.
import { supabase, SUPABASE_ENABLED } from "./supabase";
import { getSettings, getAvatarMode } from "./settings";

export type RawPeer = Record<string, any> & { user_id: string };
type Provider = { priority: number; get: () => Record<string, any> | null };
type Entry = {
  topic: string;
  selfId: string;
  channel: any | null;
  status: string;
  peers: RawPeer[];
  /** `peers` came from a presence sync on the channel as it is NOW connected. False from any non-SUBSCRIBED status until
   *  the next sync: supabase keeps the last state through CHANNEL_ERROR / TIMED_OUT, and a member who left during the
   *  outage would otherwise stay "online" (Codex review of 970fbf32). */
  live: boolean;
  subs: Set<(peers: RawPeer[]) => void>;
  providers: Provider[];
  // Budget bookkeeping (see THE PRESENCE BUDGET below).
  /** idKeyOf the last payload that actually REACHED the channel — a different key now is a priority send. */
  lastIdKey: string;
  /** The post-SUBSCRIBE track has not gone out on this channel yet: supabase holds no payload for us until it does. */
  owed: boolean;
  /** A priority send was held for a slot; the flush timer (or the next track()) sends it. */
  pending: boolean;
};

const entries = new Map<string, Entry>();

// ── THE PRESENCE BUDGET (2026-09-25; replaces the 1.5 s TRACK_MIN_MS throttle of 2026-08-15) ──────────────────────────
// Supabase Realtime: "By default, a client can send at most 5 Presence updates within a 30-second window. Both track() and untrack()
// calls count toward this limit. When a client exceeds it, Realtime logs ClientPresenceRateLimitReached and shuts the
// channel down" — a "per-connection limit" (supabase.com/docs/guides/troubleshooting/realtime-client-presence-rate-limit-reached).
// The 1.5 s throttle that stood here let a 1 Hz mover send its 6th update at +10.0 s (the real hub, measured under node),
// and Supabase's realtime logs show exactly that: a presence channel shut every 10.0 s through Jeff's 09:19–10:06 PDT
// CarPlay drive on 2026-09-25 (268 × ClientPresenceRateLimitReached 16:19:39–17:06:19Z, a new channel each time), and on every day back to
// 09-18. Each close cleared `live` below, so the crew pill dropped to grey and the crew saw the driver vanish and come back.
// Jeff, 2026-09-25: "something happened to the green crew pill on phone/carplay top center its not green anymore." Asked,
// he chose "Keep rule + fix drops": green still means another member's presence is live right now, and crew positions
// over presence go out at most every ~7.5 s instead of ~2 s.
//
//  • ONE budget for the whole hub. The limit is per connection and one socket carries every topic, so every topic's
//    tracks and every untrack spend from it, and a channel rebuild does NOT reset it.
//  • POSITION tracks (only lat/lng/heading/topSpeed moved) go out at most every PRESENCE_POSITION_GAP_MS, and only while
//    fewer than PRESENCE_POSITION_SENDS sends sit in the window — the last of Supabase's 5 slots is kept for priority
//    sends. An excess position request is DROPPED, never queued: both callers track on every tick and the payload is
//    read fresh, so the first tick after a slot frees carries the newest position.
//  • PRIORITY sends — an identity change (idKeyOf differs: status, appearance, the provider's field shape, and `src`, the
//    live↔car-spot share source, see shareSrc), the post-SUBSCRIBE track (supabase-js's own auto-rejoin re-SUBSCRIBEs the
//    SAME channel object, so this is keyed to the status callback, not to ensureChannel's rebuild), and leave's untrack —
//    take the reserved slot, then the next free one. One held for a slot does not wait for a position tick (a stationary
//    phone gets none): a single timer flushes it the moment the oldest send leaves the window. Timers can freeze on a
//    locked phone, so that is best effort — the next track() flushes it too.
// The +1 s on Supabase's 30 s window is OUR margin for our clock against the server's; the server's exact windowing is
// not measured. Every stamp below is on the MONOTONIC clock (THE BUDGET'S CLOCK), never the wall clock.
const PRESENCE_WINDOW_MS = 31_000;
const PRESENCE_MAX_SENDS = 5;            // Supabase's cap in that window
const PRESENCE_POSITION_SENDS = 4;       // position tracks stop here — the 5th slot is for priority sends
const PRESENCE_POSITION_GAP_MS = 7_500;  // Jeff's "~7.5 s": the four position slots spread across the window, never a burst

// ── THE BUDGET'S CLOCK (Codex review of 6292ade4, 2026-09-25) ─────────────────────────────────────────────────────
// The first cut stamped sends with Date.now(). A wall clock gets CORRECTED (NTP sync, a manual set) while the
// server's 30 s window keeps running: a 1 s backward step made the newest stamp "future", the filter dropped it, and a
// 6th send went out at once; a forward step expired the window early. So the budget, its spacing, the flush deadline and
// the crumb's period run on an ELAPSED clock: performance.now(), which RN 0.81 installs from NativePerformance.now →
// HighResTimeStamp::now() → std::chrono::steady_clock (react-native Libraries/Core/setUpPerformance.js,
// ReactCommon/react/timing/primitives.h). RN itself falls back to Date.now when no native clock exists, so the reading
// is also held never-backward here. Whether steady_clock advances while the phone sleeps is NOT verified; if it pauses,
// old sends look recent for longer, i.e. the budget sends LESS, never a 6th. Injectable for tools/sim-qc.
type PresenceClock = () => number;
const defaultClock: PresenceClock = () => {
  const perf = (globalThis as any).performance;
  return perf && typeof perf.now === "function" ? perf.now() : Date.now();
};
let presenceClock: PresenceClock = defaultClock;
let clockLast = -Infinity;
function monoNow(): number {
  let t = NaN;
  try { t = presenceClock(); } catch {}
  if (!Number.isFinite(t) || t < clockLast) return Number.isFinite(clockLast) ? clockLast : 0;   // hold — never backward
  clockLast = t;
  return t;
}
/** tools/sim-qc only: swap the budget's elapsed clock (null = performance.now). The budget's stamps are kept. */
export function setPresenceClock(fn: PresenceClock | null): void { presenceClock = fn ?? defaultClock; clockLast = -Infinity; }

/** Every channel send (track or untrack, any topic) still inside the window, oldest first, on monoNow(). Hub-global. */
let sendTimes: number[] = [];
let lastSendAt = -Infinity;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function sendsInWindow(now: number): number {
  sendTimes = sendTimes.filter((t) => now - t < PRESENCE_WINDOW_MS);
  return sendTimes.length;
}
function mayPosition(now: number): boolean {
  return now - lastSendAt >= PRESENCE_POSITION_GAP_MS && sendsInWindow(now) < PRESENCE_POSITION_SENDS;
}
function mayPriority(now: number): boolean { return sendsInWindow(now) < PRESENCE_MAX_SENDS; }
function spend(now: number): void { sendTimes.push(now); lastSendAt = now; stats.sent++; }

/** One timer for every held priority send: it fires when the oldest send leaves the window, i.e. when a slot frees. */
function scheduleFlush(now: number): void {
  if (flushTimer) return;
  const n = sendsInWindow(now);
  const freeAt = n < PRESENCE_MAX_SENDS ? now : sendTimes[n - PRESENCE_MAX_SENDS] + PRESENCE_WINDOW_MS;
  try {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      entries.forEach((e) => { if (e.pending) doTrack(e, true); });
    }, Math.max(0, freeAt - now) + 5);
  } catch { flushTimer = null; }
}

// Identity/appearance signature — the payload MINUS the fields that keep changing on
// their own while driving. lat/lng/heading are the churn being rate-limited (the POSITION budget above). topSpeed
// rides with them because map.tsx broadcasts
// Math.max(user.top_speed_record, sessionMaxSpeed) (map.tsx:3444), which advances on
// every fix while you accelerate past your old record — left in, ordinary acceleration
// would make every fix a priority send and blow the budget. EVERYTHING else is a real event
// that must reach peers promptly, and is a PRIORITY send: status live↔parked (the
// very case convoyPresence.ts:192's own bypass exists for), marker/cls/arrow paint,
// handle, carColor, `src` (shareSrc below) — and the provider's whole field SHAPE, since Object.keys keeps
// explicitly-undefined keys. (Until 2026-09-23 the car service's slim payload never
// carried marker/cls/clsPri/clsSec/arrPri/arrSec, so the two providers' keys could
// never collide; it carries them now — carDataService.buildCarPayload — so a phone
// whose map is closed still broadcasts its car. A collision is then two payloads with
// the SAME appearance and position, and throttling that changes nothing.) Keys are
// sorted so field ORDER alone cannot look like a change.
const idKeyOf = (p: Record<string, any>): string => {
  try {
    return JSON.stringify(
      Object.keys(p)
        .filter((k) => k !== "lat" && k !== "lng" && k !== "heading" && k !== "topSpeed")
        .sort()
        .map((k) => [k, p[k]]),
    );
  } catch { return ""; }   // never equal to a real key ("[]" at minimum) → reads as an identity change
};

// ── THE SHARE SOURCE (2026-09-25) ──────────────────────────────────────────────────────────────────────────────────
// After a head-unit disconnect the privacy gate (locationPrivacy.shareablePosition) swaps the live fix for the parked
// car spot. That swap moves only lat/lng, which idKeyOf leaves out, and `status` stays 'live' through the 90 s
// hysteresis — so under the position budget the swap could wait ~30 s for a slot while the crew kept the live
// position. `src` makes the swap an identity change, i.e. a priority send. Derived by comparing what we publish with
// the live fix, so the gate itself (its decision is a nav-locked region) is untouched. Both payload builders call this.
export function shareSrc(
  shared: { lat: number; lng: number },
  live: { lat: number; lng: number } | null | undefined,
): "live" | "spot" {
  return live && shared.lat === live.lat && shared.lng === live.lng ? "live" : "spot";
}

const fanout = (e: Entry) => { e.subs.forEach((fn) => { try { fn(e.peers); } catch {} }); notifyCrew(); };

// ── WHO IS ONLINE (Jeff, 2026-09-23: "make the 1 crew pill turn green when members are online") ─────────────────────
// Presence is the one live signal: Supabase holds exactly the payloads of the clients connected to a topic right now,
// self excluded (the sync handler below). The pill's NUMBER also counts WS/REST peers that are never pruned, so it cannot
// say who is online; the pill's COLOUR reads this instead. Keyed to the CURRENT community topic (crewPresenceTopic): the
// car service can briefly still hold the club you just left.
const crewSubs = new Set<() => void>();
function notifyCrew(): void { crewSubs.forEach((fn) => { try { fn(); } catch {} }); maybeCrumb(monoNow()); }

/** The presence topic this phone joins for its crew: the active community's — none in ghost mode. The one rule, shared by
 *  the car service (carDataService) and the crew pill. */
export function crewPresenceTopic(): string | null {
  const s = getSettings();
  if (getAvatarMode(s) === "ghost") return null;
  return s.activeCommunityId ? `convoy:community:${s.activeCommunityId}` : null;
}

/** Other members connected to `topic` right now (with a position, as the map draws them), live or parked. */
export function onlineCrewCount(topic: string | null): number {
  if (!topic) return 0;
  const e = entries.get(topic);
  if (!e || !e.live) return 0;
  const ids = new Set<string>();
  for (const p of e.peers) if (p && typeof p.lat === "number" && typeof p.lng === "number") ids.add(p.user_id);
  return ids.size;
}

export function subscribeOnlineCrew(fn: () => void): () => void {
  crewSubs.add(fn);
  return () => { crewSubs.delete(fn); };
}

const NO_PEERS: RawPeer[] = [];
/** The raw payloads connected to `topic` right now (self excluded) — the member icons off the map read each
 *  member's car from these (convoyPresence.useCrewPeers). The entry's own array, replaced only by a sync, so a
 *  useSyncExternalStore snapshot stays stable; NO_PEERS (one shared empty array) when not synced. */
export function crewPeersNow(topic: string | null): RawPeer[] {
  if (!topic) return NO_PEERS;
  const e = entries.get(topic);
  return e && e.live ? e.peers : NO_PEERS;
}

/** `flush` = called by the flush timer: send only if a PRIORITY send is still owed (position requests are never queued). */
function doTrack(e: Entry, flush = false): void {
  const now = monoNow();
  maybeCrumb(now);
  if (!e.channel || e.status !== "SUBSCRIBED") return;
  const sorted = [...e.providers].sort((a, b) => b.priority - a.priority);
  if (!sorted.length) return;
  // Only the HIGHEST-priority tier may broadcast. When the phone map (priority 2,
  // richer marker/paint payload) is registered it owns the broadcast. If it's
  // registered but momentarily NOT ready (null payload — e.g. mounted before its
  // first GPS fix) we SKIP rather than fall through to the CarPlay service
  // (priority 1, slim): a slim track would strip our class-sprite/arrow fields
  // off the retained presence until the map re-tracks. supabase keeps the last
  // tracked payload, so skipping preserves the rich one. A lower tier only ever
  // broadcasts when it's the highest tier REGISTERED (i.e. the map isn't mounted).
  const topPriority = sorted[0].priority;
  let payload: Record<string, any> | null = null;
  for (const p of sorted) {
    if (p.priority !== topPriority) break;   // never fall to a lower tier
    const v = p.get();
    if (v) { payload = v; break; }
  }
  if (!payload) return;
  // ── THE BUDGET (see THE PRESENCE BUDGET above) ──────────────────────────
  // Deliberately AFTER the provider loop above: WHICH tier's payload is broadcast is
  // decided exactly as before, so this cannot resurrect the 2026-07-20 regression
  // where a slim car payload stripped class-sprite paint off retained presence. Nor
  // can it hold back a rich payload that must overwrite a slim one for long — the two
  // providers' field shapes differ, so their identity keys differ and it is a PRIORITY
  // send. `owed` covers the post-SUBSCRIBE broadcast, where supabase holds no retained
  // payload for us at all and a skip would leave us invisible to the convoy.
  const idKey = idKeyOf(payload);
  const priority = e.owed || idKey !== e.lastIdKey;
  if (flush && !priority) { e.pending = false; return; }
  if (!(priority ? mayPriority(now) : mayPosition(now))) {
    stats.dropped++;
    if (priority) { e.pending = true; scheduleFlush(now); }
    return;
  }
  spend(now);
  e.lastIdKey = idKey;
  e.owed = false;
  e.pending = false;
  try { e.channel.track({ ...payload, online_at: new Date().toISOString() }); } catch {}
}

function ensureChannel(e: Entry): void {
  if (e.channel || !SUPABASE_ENABLED || !supabase) return;
  let channel: any;
  try {
    // SWEEP STALE CLIENT CHANNELS FIRST. supabase-js dedupes channel() BY TOPIC
    // (RealtimeClient.channel returns the EXISTING instance if one with this topic
    // is still registered) — and leave()'s removeChannel is async, so a fast
    // leave→rejoin, or the CLOSED-rebuild below (which nulls e.channel without
    // removing it from the client), can hand us back the OLD, possibly
    // joined/joining instance. Calling .on('presence') on that is exactly the
    // "cannot add `presence` callbacks" fatal (which also trips expo-updates
    // ErrorRecovery and rolls testers back to the embedded bundle). Any client
    // channel with our topic at this point is stale by definition — e.channel is
    // null — so remove it before creating a fresh one.
    const realtimeTopic = `realtime:${e.topic}`;
    try {
      (supabase.getChannels?.() ?? []).forEach((c: any) => {
        if (c?.topic === realtimeTopic) { try { supabase!.removeChannel(c); } catch {} }
      });
    } catch {}
    channel = supabase.channel(e.topic, { config: { presence: { key: e.selfId } } });
  } catch { return; }
  e.channel = channel;
  try {
    channel
      .on("presence", { event: "sync" }, () => {
        try {
          const state = channel.presenceState();
          const peers: RawPeer[] = [];
          Object.entries(state).forEach(([uid, presences]: [string, any]) => {
            if (uid === e.selfId) return;
            const p = (presences as any[])[0];
            if (!p) return;
            peers.push({ ...p, user_id: uid });
          });
          e.peers = peers;
          if (e.channel === channel) e.live = true;
          fanout(e);
        } catch {}
      })
      .subscribe((s: string) => {
        e.status = s;
        // Disconnected (or rejoining, not yet synced): nobody counts as online until the next sync says who is there.
        if (s !== "SUBSCRIBED" && e.channel === channel && e.live) {
          e.live = false;
          if (e.topic === crewPresenceTopic()) stats.drops++;
          notifyCrew();
        }
        // A (re)joined channel holds no retained payload for us: the next send is OWED and goes as a priority send —
        // on every SUBSCRIBED, including supabase-js's auto-rejoin of this same channel object after CHANNEL_ERROR /
        // TIMED_OUT, which never passes through the rebuild below.
        if (s === "SUBSCRIBED" && e.channel === channel) { e.owed = true; doTrack(e); }
        else if (s === "CLOSED" && e.channel === channel && e.subs.size > 0) {
          // Defensive rebuild: a hard CLOSE while consumers still need presence
          // would otherwise freeze peers until an app restart. supabase auto-
          // rejoins CHANNEL_ERROR/TIMED_OUT on its own, and the refcount means we
          // only removeChannel at zero subs — so a CLOSE seen here WITH live subs
          // is unexpected and gets exactly one rebuild. `e.channel === channel`
          // guards against a stale prior channel firing after we've moved on, so
          // it can't loop. (This restores the old CarPlay service's closed->rejoin
          // heal, now shared by every consumer.)
          e.channel = null;
          ensureChannel(e);
        }
      });
  } catch {
    // Realtime wiring must never escape as a fatal.
    try { supabase.removeChannel(channel); } catch {}
    e.channel = null;
  }
}

// ── THE crew-presence CRUMB (2026-09-25) ─────────────────────────────────────────────────────────────────────────
// There was no client-side presence telemetry at all, so the pill's grey/green duty cycle on a phone or head unit was
// unmeasurable. One bounded aggregate row, at most once a minute (≤ 60/h), written from hub activity — never a timer:
//   crew-presence live=<crew topic synced now> greyMs=<ms the pill read grey this period> drops=<live→not-live on the
//   crew topic> maxN=<most members online> topic=<a crew topic is set> ghost=<ghost mode> sent=<channel sends, all
//   topics> dropped=<requests the budget refused>
// It writes while a crew topic is set, or when anything changed since the last row. greyMs samples the pill's colour
// at every hub event, so it is approximate between events. The logger is INJECTED (convoyPresence and carDataService
// pass crashBreadcrumb.logEvent) so this file stays importable under plain node for tools/sim-qc.
type PresenceLogger = (message: string) => void;
let presenceLogger: PresenceLogger | null = null;
export function setPresenceLogger(fn: PresenceLogger | null): void { presenceLogger = fn; }

const CRUMB_EVERY_MS = 60_000;
const stats = { sent: 0, dropped: 0, drops: 0, greyMs: 0, maxN: 0 };
let periodStart: number | null = null;   // monoNow() values — performance.now() starts near 0, so 0 is not "unset"
let sampleAt: number | null = null;
let sampleGrey = true;
let lastCrumbKey = "";

function samplePill(now: number): number {
  const n = onlineCrewCount(crewPresenceTopic());
  if (sampleAt !== null && sampleGrey) stats.greyMs += now - sampleAt;
  sampleAt = now;
  sampleGrey = n === 0;
  if (n > stats.maxN) stats.maxN = n;
  return n;
}

function maybeCrumb(now: number): void {
  let n = 0;
  try { n = samplePill(now); } catch { return; }
  if (!presenceLogger) return;
  if (periodStart === null) { periodStart = now; return; }
  if (now - periodStart < CRUMB_EVERY_MS) return;
  try {
    const topic = crewPresenceTopic();
    const e = topic ? entries.get(topic) : undefined;
    const live = e?.live ? 1 : 0;
    const ghost = getAvatarMode(getSettings()) === "ghost" ? 1 : 0;
    const key = `${live}${topic ? 1 : 0}${ghost}`;
    const changed = key !== lastCrumbKey || stats.sent > 0 || stats.dropped > 0 || stats.drops > 0 || stats.maxN > 0;
    if (topic || changed) {
      const period = now - periodStart;
      presenceLogger(`crew-presence live=${live} greyMs=${Math.min(stats.greyMs, period)} drops=${stats.drops} maxN=${stats.maxN} topic=${topic ? 1 : 0} ghost=${ghost} sent=${stats.sent} dropped=${stats.dropped}`);
      lastCrumbKey = key;
    }
  } catch {}
  periodStart = now;
  stats.sent = 0; stats.dropped = 0; stats.drops = 0; stats.greyMs = 0; stats.maxN = n;
}

export type PresenceHandle = { track: () => void; leave: () => void };

// Join a topic's presence. First consumer creates the channel; the rest share
// it. `onPeers` receives the RAW peer payloads (each consumer maps to its own
// shape). `getPayload` provides OUR presence to broadcast (read fresh on each
// track()). `priority`: map=2 (richer), carService=1.
export function joinPresence(opts: {
  topic: string;
  selfId: string;
  priority: number;
  getPayload: () => Record<string, any> | null;
  onPeers: (peers: RawPeer[]) => void;
}): PresenceHandle {
  const { topic, selfId, priority, getPayload, onPeers } = opts;
  if (!SUPABASE_ENABLED || !supabase || !topic || !selfId) {
    return { track: () => {}, leave: () => {} };
  }
  let e = entries.get(topic);
  if (!e) {
    e = { topic, selfId, channel: null, status: "idle", peers: [], live: false, subs: new Set(), providers: [], lastIdKey: "", owed: false, pending: false };
    entries.set(topic, e);
  }
  const provider: Provider = { priority, get: getPayload };
  e.subs.add(onPeers);
  e.providers.push(provider);
  ensureChannel(e);
  try { onPeers(e.peers); } catch {}   // deliver the current snapshot immediately
  return {
    track: () => { const ent = entries.get(topic); if (ent) doTrack(ent); },
    leave: () => {
      const ent = entries.get(topic);
      if (!ent) return;
      ent.subs.delete(onPeers);
      ent.providers = ent.providers.filter((p) => p !== provider);
      if (ent.subs.size === 0) {
        // untrack() counts against Supabase's window like a track: a priority send, but with no "next free slot" for
        // a channel removed on the next line. With the window full it is skipped, and removeChannel's leave is what
        // takes us off the topic (HYPOTHESIS: the server drops a departed channel's presence — Phoenix presence is
        // tied to the channel process; not measured on Supabase).
        const now = monoNow();
        if (ent.channel && ent.status === "SUBSCRIBED") {
          if (mayPriority(now)) { spend(now); try { ent.channel.untrack?.(); } catch {} }
          else stats.dropped++;
        }
        try { if (ent.channel && supabase) supabase.removeChannel(ent.channel); } catch {}
        entries.delete(topic);
        notifyCrew();
      }
    },
  };
}
