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

export type RawPeer = Record<string, any> & { user_id: string };
type Provider = { priority: number; get: () => Record<string, any> | null };
type Entry = {
  topic: string;
  selfId: string;
  channel: any | null;
  status: string;
  peers: RawPeer[];
  subs: Set<(peers: RawPeer[]) => void>;
  providers: Provider[];
};

const entries = new Map<string, Entry>();

const fanout = (e: Entry) => { e.subs.forEach((fn) => { try { fn(e.peers); } catch {} }); };

function doTrack(e: Entry): void {
  if (!e.channel || e.status !== "SUBSCRIBED") return;
  // Highest-priority provider with a non-null payload wins, so when the phone
  // map (priority 2, richer marker/paint payload) is active it owns the
  // broadcast; the CarPlay service (priority 1, slim) only broadcasts when the
  // map isn't mounted. No alternating/flicker.
  const sorted = [...e.providers].sort((a, b) => b.priority - a.priority);
  let payload: Record<string, any> | null = null;
  for (const p of sorted) { const v = p.get(); if (v) { payload = v; break; } }
  if (!payload) return;
  try { e.channel.track({ ...payload, online_at: new Date().toISOString() }); } catch {}
}

function ensureChannel(e: Entry): void {
  if (e.channel || !SUPABASE_ENABLED || !supabase) return;
  let channel: any;
  try {
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
          fanout(e);
        } catch {}
      })
      .subscribe((s: string) => {
        e.status = s;
        if (s === "SUBSCRIBED") doTrack(e);
      });
  } catch {
    // Realtime wiring must never escape as a fatal.
    try { supabase.removeChannel(channel); } catch {}
    e.channel = null;
  }
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
    e = { topic, selfId, channel: null, status: "idle", peers: [], subs: new Set(), providers: [] };
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
        try { ent.channel?.untrack?.(); } catch {}
        try { if (ent.channel && supabase) supabase.removeChannel(ent.channel); } catch {}
        entries.delete(topic);
      }
    },
  };
}
